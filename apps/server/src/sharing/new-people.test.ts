import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import {
  newId,
  type SharingAction,
  type SharingInvitations,
  type UnitPolicy,
  type TokenCreated,
  type AppError,
  type DatabaseRole,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import type { MailMessage } from '../mail/index.js';
import { TOOLS } from '../mcp/tools.js';
import { mcpError } from '../mcp/messages.js';
import { RecordReader } from '../api-v1/reads.js';
import { proposeHome } from '../ai/plans.js';
import { signInClaimed } from '../auth/sso/accounts.js';
import type { ProviderRow } from '../auth/sso/store.js';
import { auditEvent } from '../auth/database.js';

let kit: TestPostgres;
const cleanups: Array<() => Promise<void>> = [];
beforeAll(async () => {
  kit = await startTestPostgres();
}, 60_000);
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
afterAll(async () => {
  await kit?.stop();
});

async function fixture(mail = true) {
  const server = await startServer(kit, 'share_new', { baseUrl: 'https://sharing.example.test' });
  cleanups.push(() => server.close());
  const messages: MailMessage[] = [];
  if (mail)
    server.ctx.mailer = {
      send: async (message) => {
        messages.push(message);
      },
    };
  const id = newId('database');
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id,
      name: 'Shared projects',
      table: {
        id: newId('table'),
        name: 'Tasks',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'All' },
      },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  return { ...server, messages, resource: { kind: 'database' as const, id } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function actor(server: ServerFixture, who = server.owner) {
  return {
    userId: who.userId,
    orgId: who.info.org.id,
    kind: who.info.membership.kind,
    adminRoles: who.info.membership.adminRoles,
    sessionId: '',
    csrfToken: '',
  };
}
function action(
  server: Fixture,
  email = 'invitee@example.test',
  role: DatabaseRole = 'reader',
): SharingAction {
  return { kind: 'share.invite', resource: server.resource, email, role };
}
function command(server: Fixture, change = action(server), who = server.owner) {
  return server.app.inject({
    method: 'POST',
    url: '/api/home/commands',
    headers: who.headers,
    payload: { id: newId('command'), action: change },
  });
}
async function policy(server: Fixture, values: UnitPolicy, overridable: string[] = []) {
  const result = await server.app.inject({
    method: 'PUT',
    url: '/api/admin/unit-policy',
    headers: server.owner.headers,
    payload: { values, overridable },
  });
  expect(result.statusCode, result.body).toBe(200);
}
async function pending(server: Fixture) {
  const result = await server.app.inject({
    url: `/api/databases/${server.resource.id}/invitations`,
    headers: server.owner.headers,
  });
  expect(result.statusCode, result.body).toBe(200);
  return result.json<SharingInvitations>();
}
function tokenOf(message: MailMessage) {
  return message.text.match(/#token=([\w-]+)/)![1]!;
}
function accept(server: Fixture, token: string, email?: string) {
  return server.app.inject({
    method: 'POST',
    url: '/api/auth/invitations/accept',
    payload: { token, name: 'New person', ...(email ? { email } : {}) },
  });
}
async function own(server: Fixture, who: SignedIn) {
  const result = await server.app.inject({
    method: 'PUT',
    url: `/api/databases/${server.resource.id}/grants`,
    headers: server.owner.headers,
    payload: { principal: { kind: 'user', id: who.userId }, role: 'owner' },
  });
  expect(result.statusCode, result.body).toBe(200);
}

it('refuses an invitation when ownership is revoked while the request waits', async () => {
  const server = await fixture();
  const member = await server.addMember();
  await own(server, member);
  const client = await server.pool.connect();
  let inviting: ReturnType<typeof command> | undefined;
  try {
    await client.query('BEGIN');
    const connection = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await query(
      client,
      sql`SELECT id FROM ${ident(server.schemas.app, 'databases')} WHERE id = ${server.resource.id} FOR UPDATE`,
    );
    await query(
      client,
      sql`DELETE FROM ${ident(server.schemas.app, 'grants')} WHERE resource_kind = 'database'
      AND resource_id = ${server.resource.id} AND principal_kind = 'user' AND principal_id = ${member.userId}`,
    );
    inviting = command(server, action(server), member);
    await expect
      .poll(async () => {
        const waiting = await query(
          server.pool,
          sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND ${connection.rows[0]!.pid} = ANY(pg_blocking_pids(pid))`,
        );
        return waiting.rowCount;
      })
      .toBe(1);
    await client.query('COMMIT');
    const refused = await inviting;
    expect(refused.statusCode).toBe(404);
    expect(refused.json().error.messageKey).toBe('errors.notFound');
    expect((await pending(server)).pending).toEqual([]);
    expect(server.messages).toEqual([]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await inviting;
  }
});

it('lets a sharing change audit while invitation acceptance waits for the item', async () => {
  const server = await fixture();
  await command(server);
  const client = await server.pool.connect();
  let joining: ReturnType<typeof accept> | undefined;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '1s'");
    const connection = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await query(
      client,
      sql`SELECT id FROM ${ident(server.schemas.app, 'databases')} WHERE id = ${server.resource.id} FOR UPDATE`,
    );
    joining = accept(server, tokenOf(server.messages[0]!));
    await expect
      .poll(
        async () => {
          const waiting = await query(
            server.pool,
            sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
            AND ${connection.rows[0]!.pid} = ANY(pg_blocking_pids(pid))`,
          );
          return waiting.rowCount;
        },
        { timeout: 10_000 },
      )
      .toBe(1);
    await auditEvent(client, `"${server.schemas.audit}"`, 'data.grant.set', actor(server), {
      databaseId: server.resource.id,
    });
    await client.query('COMMIT');
    const joined = await joining;
    expect(joined.statusCode, joined.body).toBe(200);
    expect((await pending(server)).pending).toEqual([]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await joining;
  }
});

it.each([
  [{ newPeopleSharing: false }, 'share.invite.membersOnly'],
  [{ externalSharing: false }, 'share.invite.membersOnly'],
  [{ guestInvitations: false }, 'share.invite.membersOnly'],
  [{ newPeopleAdministratorsOnly: true }, 'share.invite.administratorsOnly'],
] as const)('refuses new people under %j with a specific reason', async (values, messageKey) => {
  const server = await fixture();
  const member = await server.addMember();
  await own(server, member);
  await policy(server, values);
  const result = await command(server, action(server), member);
  expect(result.statusCode, result.body).toBe(403);
  expect(result.json()).toMatchObject({ error: { messageKey } });
  expect(server.messages).toHaveLength(0);
  expect((await pending(server)).pending).toEqual([]);
});

it.each(['guest', 'member'] as const)(
  'allows a %s invitation, fixes the address, and grants only on acceptance',
  async (kind) => {
    const server = await fixture();
    await policy(server, { newPeopleRole: kind });
    expect((await command(server)).statusCode).toBe(200);
    const invite = (await pending(server)).pending[0]!;
    expect(invite).toMatchObject({ email: 'invitee@example.test', role: 'reader' });
    const granted = await query(
      server.pool,
      sql`SELECT * FROM ${ident(server.schemas.app, 'grants')} WHERE resource_id = ${server.resource.id} AND principal_id <> ${server.owner.userId}`,
    );
    expect(granted.rows).toEqual([]);
    expect(server.messages[0]!.text).toContain('Owner shared Shared projects');
    const token = tokenOf(server.messages[0]!);
    const preview = await server.app.inject({ url: `/api/auth/invitations/${token}` });
    expect(preview.json()).toMatchObject({
      email: invite.email,
      sharedItems: ['Shared projects'],
      destination: `/${server.resource.id}`,
    });
    const joined = await accept(server, token, 'different@example.test');
    expect(joined.statusCode, joined.body).toBe(200);
    expect(joined.json()).toMatchObject({ user: { email: invite.email }, membership: { kind } });
    const rows = await query(
      server.pool,
      sql`SELECT role FROM ${ident(server.schemas.app, 'grants')} WHERE resource_id = ${server.resource.id} AND principal_id = ${joined.json().user.id}`,
    );
    expect(rows.rows).toEqual([{ role: 'reader' }]);
    const events = await query<{ action: string; metadata: Record<string, unknown> }>(
      server.pool,
      sql`SELECT action, metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action IN ('org.invitation.created', 'org.invitation.accepted', 'data.share.accepted') ORDER BY id`,
    );
    expect(events.rows.map((row) => row.action)).toEqual([
      'org.invitation.created',
      'data.share.accepted',
      'org.invitation.accepted',
    ]);
    expect(events.rows[0]!.metadata).toMatchObject({
      email: invite.email,
      resource: server.resource,
      role: 'reader',
    });
    expect(events.rows[1]!.metadata).toMatchObject({
      resourceKind: server.resource.kind,
      resourceId: server.resource.id,
      role: 'reader',
      invitedBy: server.owner.userId,
    });
    expect((await pending(server)).pending).toEqual([]);
  },
);

it.each([
  'NEW@EXAMPLE.TEST',
  'new@sub.example.test',
  'new@example.test.attacker.test',
  'new@lookalike-example.test',
])('matches the whole domain for %s in sharing and People invitations', async (email) => {
  const server = await fixture();
  await policy(server, { allowedEmailDomains: ['EXAMPLE.TEST'] });
  const allowed = email === 'NEW@EXAMPLE.TEST';
  const shared = await command(server, action(server, email));
  const invited = await server.app.inject({
    method: 'POST',
    url: '/api/org/invitations',
    headers: server.owner.headers,
    payload: { emails: [email] },
  });
  expect(shared.statusCode, shared.body).toBe(allowed ? 200 : 403);
  expect(invited.statusCode, invited.body).toBe(allowed ? 200 : 403);
  if (!allowed)
    expect(shared.json()).toMatchObject({
      error: { messageKey: 'share.invite.domains', params: { domains: 'example.test' } },
    });
});

it('allows a separately listed subdomain and an administrator when invitations are restricted', async () => {
  const server = await fixture();
  await policy(server, { newPeopleAdministratorsOnly: true, allowedEmailDomains: ['sub.example.test'] });
  expect((await command(server, action(server, 'new@SUB.EXAMPLE.TEST'))).statusCode).toBe(200);
});

it.each([true, false])(
  'folds manageable database and folder shares into one invitation with email available: %s',
  async (mail) => {
    const server = await fixture(mail);
    const folder = newId('folder');
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/home/commands',
      headers: server.owner.headers,
      payload: {
        id: newId('command'),
        action: { kind: 'folder.create', folderId: folder, name: 'Shared folder', parentId: null },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const first = await command(server);
    const oldToken = mail
      ? tokenOf(server.messages[0]!)
      : (first.json().invitationLink as string).split('#token=')[1]!;
    const second = await command(server, { ...action(server), resource: { kind: 'folder', id: folder } });
    const live = await server.app.inject({ url: '/api/org/invitations', headers: server.owner.headers });
    expect(live.json()).toHaveLength(1);
    expect((await server.app.inject({ url: `/api/auth/invitations/${oldToken}` })).statusCode).toBe(404);
    const token = mail
      ? tokenOf(server.messages[1]!)
      : (second.json().invitationLink as string).split('#token=')[1]!;
    const accepted = await accept(server, token);
    expect(accepted.statusCode, accepted.body).toBe(200);
    const grants = await query(
      server.pool,
      sql`SELECT resource_id, role FROM ${ident(server.schemas.app, 'grants')} WHERE principal_id = ${accepted.json().user.id} ORDER BY resource_id`,
    );
    expect(grants.rows).toHaveLength(2);
    expect(grants.rows.every((row) => row.role === 'reader')).toBe(true);
  },
);

it('resends, revokes, expires, and removes pending grants when People revokes the invitation', async () => {
  const server = await fixture();
  await command(server);
  const person = (await pending(server)).pending[0]!;
  const original = tokenOf(server.messages[0]!);
  await command(server, { kind: 'share.resend', resource: server.resource, invitationId: person.id });
  expect((await accept(server, original)).statusCode).toBe(404);
  const resent = tokenOf(server.messages[1]!);
  await command(server, { kind: 'share.revoke', resource: server.resource, invitationId: person.id });
  expect((await accept(server, resent)).statusCode).toBe(404);
  await command(server);
  const next = (await pending(server)).pending[0]!;
  const deleted = await server.app.inject({
    method: 'DELETE',
    url: `/api/org/invitations/${next.id}`,
    headers: server.owner.headers,
  });
  expect(deleted.statusCode, deleted.body).toBe(204);
  expect(
    (
      await query(
        server.pool,
        sql`SELECT * FROM ${ident(server.schemas.app, 'invitation_grants')} WHERE invitation_id = ${next.id}`,
      )
    ).rows,
  ).toEqual([]);
  await command(server);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'invitations')} SET expires_at = clock_timestamp() - interval '1 second' WHERE accepted_at IS NULL`,
  );
  expect((await accept(server, tokenOf(server.messages.at(-1)!))).statusCode).toBe(404);
  expect((await pending(server)).pending).toEqual([]);
});

it('offers a one-time copyable link without retaining it in command replay state', async () => {
  const server = await fixture(false);
  const id = newId('command');
  const request = {
    method: 'POST' as const,
    url: '/api/home/commands',
    headers: server.owner.headers,
    payload: { id, action: action(server) },
  };
  const created = await server.app.inject(request);
  expect(created.statusCode, created.body).toBe(200);
  const link = created.json().invitationLink as string;
  expect(link).toContain('/join#token=');
  const stored = await query(
    server.pool,
    sql`SELECT result FROM ${ident(server.schemas.app, 'commands')} WHERE id = ${id}`,
  );
  expect(JSON.stringify(stored.rows)).not.toContain(link.split('#token=')[1]);
  expect((await server.app.inject(request)).json()).not.toHaveProperty('invitationLink');
});

it('does not reveal an account in another organization to a non-administrator', async () => {
  const server = await fixture();
  const member = await server.addMember();
  await own(server, member);
  const otherId = newId('user');
  const email = 'elsewhere@example.test';
  const otherOrg = newId('org');
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'orgs')} (id, name) VALUES (${otherOrg}, 'Other organization')`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'users')} (id, email, name) VALUES (${otherId}, ${email}, 'Private name')`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'memberships')} (org_id, user_id, kind) VALUES (${otherOrg}, ${otherId}, 'member')`,
  );
  const addresses = [email, 'unknown@example.test'];
  for (const address of addresses) {
    const response = await command(server, action(server, address), member);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: 'applied' });
    expect(response.body).not.toContain(otherId);
    expect(response.body).not.toContain('Private name');
  }
  // The ownership grant also queues mail to the member independently of these invitations.
  const invitations = server.messages.filter((message) => addresses.includes(message.to));
  expect(invitations.map((message) => message.to)).toEqual(addresses);
  for (const message of invitations) {
    expect(message.text).not.toContain(otherId);
    expect(message.text).not.toContain('Private name');
  }
  expect(invitations[0]!.text.replace(/#token=[\w-]+/, '#token=TOKEN')).toEqual(
    invitations[1]!.text.replace(/#token=[\w-]+/, '#token=TOKEN'),
  );
});

it('returns the same specific refusal through REST and MCP, and requires approval in Rio', async () => {
  const server = await fixture();
  const token = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: server.owner.headers,
    payload: { name: 'Sharing', scopes: ['schema.bases:write'], databases: 'all' },
  });
  expect(token.statusCode, token.body).toBe(200);
  await policy(server, { allowedEmailDomains: ['allowed.test'] });
  const rest = await server.app.inject({
    method: 'POST',
    url: '/api/v1/home/commands',
    headers: { authorization: `Bearer ${token.json<TokenCreated>().token}` },
    payload: { id: newId('command'), action: action(server) },
  });
  expect(rest.statusCode, rest.body).toBe(403);
  expect(rest.json()).toMatchObject({ error: { messageKey: 'share.invite.domains' } });
  const tool = TOOLS.find((tool) => tool.definition.name === 'change_home')!;
  try {
    await tool.call(
      {
        app: server.app,
        actor: actor(server),
        request: {} as FastifyRequest,
        reader: new RecordReader(server.app),
      },
      { id: newId('command'), action: action(server) },
    );
    throw new Error('Expected refusal');
  } catch (error) {
    expect(mcpError(error as AppError)).toMatchObject({
      error: {
        messageKey: 'share.invite.domains',
        message: 'Use an email address at an allowed domain: allowed.test.',
      },
    });
  }
  await policy(server, {});
  const conversation = randomUUID();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'rio_conversations')} (id, org_id, user_id) VALUES (${conversation}, ${server.owner.info.org.id}, ${server.owner.userId})`,
  );
  const plan = await proposeHome(
    server.app,
    actor(server),
    conversation,
    { id: newId('command'), action: action(server) },
    'instant',
    'instant',
    {},
  );
  expect(plan).toMatchObject({ kind: 'plan', needsApproval: true, external: true, status: 'pending' });
  expect(server.messages).toEqual([]);
});

it('bounds invitation bursts with the existing attempt store', async () => {
  const server = await fixture();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'auth_attempts')} (key, at) SELECT ${`sharing:${server.owner.info.org.id}:${server.owner.userId}`}, clock_timestamp() FROM generate_series(1, 50)`,
  );
  const response = await command(server);
  expect(response.statusCode, response.body).toBe(429);
  expect(response.json()).toMatchObject({ error: { messageKey: 'share.invite.tooMany' } });
});

it('inherits invitation restrictions and exact domains from organizational units', async () => {
  const server = await fixture();
  const member = await server.addMember();
  await own(server, member);
  await policy(server, { allowedEmailDomains: ['example.test', 'sub.example.test'] }, [
    'allowedEmailDomains',
    'newPeopleSharing',
  ]);
  const unit = await server.app.inject({
    method: 'POST',
    url: '/api/org/units',
    headers: server.owner.headers,
    payload: { name: 'Research', parentId: null },
  });
  expect(unit.statusCode, unit.body).toBe(201);
  const unitId = unit.json().id as string;
  const placed = await server.app.inject({
    method: 'PUT',
    url: `/api/org/members/${member.userId}/unit`,
    headers: server.owner.headers,
    payload: { unitId },
  });
  expect(placed.statusCode, placed.body).toBe(200);
  const set = (values: UnitPolicy) =>
    server.app.inject({
      method: 'PUT',
      url: `/api/org/units/${unitId}/policy`,
      headers: server.owner.headers,
      payload: values,
    });
  expect((await set({ allowedEmailDomains: ['sub.example.test'] })).statusCode).toBe(200);
  const blocked = await command(server, action(server), member);
  expect(blocked.json()).toMatchObject({
    error: { messageKey: 'share.invite.domains', params: { domains: 'sub.example.test' } },
  });
  expect((await command(server, action(server, 'new@sub.example.test'), member)).statusCode).toBe(200);
  expect((await set({ allowedEmailDomains: ['sub.example.test'], newPeopleSharing: false })).statusCode).toBe(
    200,
  );
  expect((await command(server, action(server, 'other@sub.example.test'), member)).json()).toMatchObject({
    error: { messageKey: 'share.invite.membersOnly' },
  });
});

it('allows the member joining role when guest invitations are disabled', async () => {
  const server = await fixture();
  await policy(server, { newPeopleRole: 'member', guestInvitations: false });
  expect((await command(server)).statusCode).toBe(200);
});

it.each(['invite', 'resend'] as const)(
  'keeps a copyable %s link within the item owner’s managed resources',
  async (operation) => {
    const server = await fixture(operation === 'resend');
    const member = await server.addMember();
    const databaseId = newId('database');
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: member.headers,
      payload: {
        id: databaseId,
        name: 'Owner workspace',
        table: {
          id: newId('table'),
          name: 'Tasks',
          fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
          view: { id: newId('view'), name: 'All' },
        },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const ownResource = { kind: 'database' as const, id: databaseId };
    const inaccessible = await server.app.inject({
      url: `/api/databases/${server.resource.id}/schema`,
      headers: member.headers,
    });
    expect(inaccessible.statusCode).toBe(404);
    const first = await command(server);
    expect(first.statusCode, first.body).toBe(200);
    const originalToken =
      operation === 'resend'
        ? tokenOf(server.messages[0]!)
        : (first.json().invitationLink as string).split('#token=')[1]!;
    if (operation === 'resend') {
      expect((await command(server, { ...action(server), resource: ownResource }, member)).statusCode).toBe(
        200,
      );
      server.ctx.mailer = null;
    }
    const invitation = await server.app.inject({
      url: `/api/databases/${databaseId}/invitations`,
      headers: member.headers,
    });
    const shared = await command(
      server,
      operation === 'invite'
        ? { ...action(server), resource: ownResource }
        : {
            kind: 'share.resend',
            resource: ownResource,
            invitationId: invitation.json<SharingInvitations>().pending[0]!.id,
          },
      member,
    );
    expect(shared.statusCode, shared.body).toBe(200);
    const token = (shared.json().invitationLink as string).split('#token=')[1]!;
    const preview = await server.app.inject({ url: `/api/auth/invitations/${token}` });
    expect(preview.json().sharedItems).toEqual(['Owner workspace']);
    const joined = await accept(server, token);
    expect(joined.statusCode, joined.body).toBe(200);
    const session = joined.json();
    const cookies = joined.headers['set-cookie'];
    const cookie = (Array.isArray(cookies) ? cookies : [cookies])
      .map((value) => value!.split(';')[0])
      .join('; ');
    const headers = { cookie, 'x-csrf-token': session.csrfToken };
    expect(
      (await server.app.inject({ url: `/api/databases/${server.resource.id}/schema`, headers })).statusCode,
    ).toBe(404);
    expect(
      (await server.app.inject({ url: `/api/databases/${databaseId}/schema`, headers })).statusCode,
    ).toBe(200);
    expect((await pending(server)).pending).toHaveLength(1);
    if (operation === 'invite')
      expect((await server.app.inject({ url: `/api/auth/invitations/${originalToken}` })).statusCode).toBe(
        200,
      );
  },
);

/** Two sharers each hold a link for the same new address, and the person joins with one of them. */
async function joinLeavingSpare(server: Fixture) {
  const member = await server.addMember();
  const databaseId = newId('database');
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: member.headers,
    payload: {
      id: databaseId,
      name: 'Member workspace',
      table: {
        id: newId('table'),
        name: 'Tasks',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'All' },
      },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const spare = ((await command(server)).json().invitationLink as string).split('#token=')[1]!;
  const used = (
    (
      await command(server, { ...action(server), resource: { kind: 'database', id: databaseId } }, member)
    ).json().invitationLink as string
  ).split('#token=')[1]!;
  const joined = await accept(server, used);
  expect(joined.statusCode, joined.body).toBe(200);
  return { member, spare, joined };
}

it('opens no session from a copied link once its address has an account', async () => {
  const server = await fixture(false);
  const { member, spare, joined } = await joinLeavingSpare(server);
  const session = joined.json();
  const cookies = joined.headers['set-cookie'];
  const cookie = (Array.isArray(cookies) ? cookies : [cookies])
    .map((value) => value!.split(';')[0])
    .join('; ');
  const sessions = async () =>
    (
      await query(
        server.pool,
        sql`SELECT id FROM ${ident(server.schemas.app, 'sessions')} WHERE user_id = ${session.user.id}`,
      )
    ).rowCount;
  const redeem = (headers: Record<string, string>) =>
    server.app.inject({
      method: 'POST',
      url: '/api/auth/invitations/accept',
      headers,
      payload: { token: spare, name: 'Someone else' },
    });
  // Nobody signed in, another person, and a forged request from the person's browser all get nothing.
  for (const headers of [{}, member.headers, { cookie }] as Record<string, string>[]) {
    const refused = await redeem(headers);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ error: { messageKey: 'share.invite.signInFirst' } });
    expect(refused.headers['set-cookie']).toBeUndefined();
  }
  expect(await sessions()).toBe(1);
  expect((await pending(server)).pending).toHaveLength(1);
  const headers = { cookie, 'x-csrf-token': session.csrfToken };
  expect(
    (await server.app.inject({ url: `/api/databases/${server.resource.id}/schema`, headers })).statusCode,
  ).toBe(404);
  // The person's own session accepts the share and stays the only session.
  const own = await redeem(headers);
  expect(own.statusCode, own.body).toBe(200);
  expect(own.json()).toMatchObject({
    user: { id: session.user.id, name: 'New person' },
    csrfToken: session.csrfToken,
  });
  expect(own.headers['set-cookie']).toBeUndefined();
  expect(await sessions()).toBe(1);
  expect(
    (await server.app.inject({ url: `/api/databases/${server.resource.id}/schema`, headers })).statusCode,
  ).toBe(200);
  expect((await pending(server)).pending).toEqual([]);
});

it('refuses a burst of spare copied links with one connection for each request', async () => {
  const server = await fixture(false);
  const { member, spare } = await joinLeavingSpare(server);
  // Each request holds a connection while it waits its turn on the organization's invitations, so
  // a session check that took a second one would leave the whole pool waiting on itself.
  const burst = await Promise.all(
    Array.from({ length: server.pool.options.max! }, (_, index) =>
      server.app.inject({
        method: 'POST',
        url: '/api/auth/invitations/accept',
        remoteAddress: `192.0.2.${index + 1}`,
        headers: member.headers,
        payload: { token: spare, name: 'Someone else' },
      }),
    ),
  );
  expect(burst.map((response) => response.json().error?.messageKey)).toEqual(
    burst.map(() => 'share.invite.signInFirst'),
  );
  expect(burst.map((response) => response.statusCode)).toEqual(burst.map(() => 403));
  expect((await pending(server)).pending).toHaveLength(1);
});

it('counts a link as emailed again once it is resent by email', async () => {
  const server = await fixture(false);
  expect((await command(server)).statusCode).toBe(200);
  const copied = async () =>
    (
      await query<{ copied: boolean }>(
        server.pool,
        sql`SELECT copied FROM ${ident(server.schemas.app, 'invitations')} WHERE accepted_at IS NULL AND expires_at > clock_timestamp()`,
      )
    ).rows;
  expect(await copied()).toEqual([{ copied: true }]);
  server.ctx.mailer = {
    send: async (message) => {
      server.messages.push(message);
    },
  };
  const invitation = (await pending(server)).pending[0]!;
  const resent = await command(server, {
    kind: 'share.resend',
    resource: server.resource,
    invitationId: invitation.id,
  });
  expect(resent.statusCode, resent.body).toBe(200);
  expect(resent.json()).not.toHaveProperty('invitationLink');
  expect(await copied()).toEqual([{ copied: false }]);
  // The address has an account by the time its emailed link arrives, which signs it in as before.
  const userId = newId('user');
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'users')} (id, email, name) VALUES (${userId}, 'invitee@example.test', 'Joining member')`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'memberships')} (org_id, user_id, kind) VALUES (${server.owner.info.org.id}, ${userId}, 'member')`,
  );
  const joined = await accept(server, tokenOf(server.messages[0]!));
  expect(joined.statusCode, joined.body).toBe(200);
  expect(joined.json()).toMatchObject({ user: { id: userId } });
});

it.each([
  ['editor', 'reader', 'editor'],
  ['reader', 'owner', 'owner'],
] as const)(
  'merges promised %s access with existing %s access and audits %s',
  async (promised, existing, applied) => {
    const server = await fixture();
    expect((await command(server, action(server, 'invitee@example.test', promised))).statusCode).toBe(200);
    const userId = newId('user');
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'users')} (id, email, name) VALUES (${userId}, 'invitee@example.test', 'Joining member')`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'memberships')} (org_id, user_id, kind) VALUES (${server.owner.info.org.id}, ${userId}, 'member')`,
    );
    const granted = await server.app.inject({
      method: 'PUT',
      url: `/api/databases/${server.resource.id}/grants`,
      headers: server.owner.headers,
      payload: { principal: { kind: 'user', id: userId }, role: existing },
    });
    expect(granted.statusCode, granted.body).toBe(200);
    const joined = await accept(server, tokenOf(server.messages[0]!));
    expect(joined.statusCode, joined.body).toBe(200);
    const grants = await query(
      server.pool,
      sql`SELECT role FROM ${ident(server.schemas.app, 'grants')} WHERE resource_id = ${server.resource.id} AND principal_id = ${userId}`,
    );
    expect(grants.rows).toEqual([{ role: applied }]);
    const events = await query(
      server.pool,
      sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'data.share.accepted'`,
    );
    expect(events.rows).toEqual([{ metadata: expect.objectContaining({ role: applied }) }]);
    expect((await pending(server)).pending).toEqual([]);
  },
);

it.each(['database', 'folder'] as const)(
  'checks classification for the joining membership kind on a %s',
  async (kind) => {
    const server = await fixture();
    const labelId = randomUUID();
    for (const change of [
      {
        kind: 'classification.labels',
        labels: [
          {
            id: labelId,
            name: 'Internal',
            color: 'red',
            description: '',
            rules: { noExternalSharing: true },
          },
        ],
      },
      {
        kind: 'classification.assign',
        target: { kind: 'database', databaseId: server.resource.id },
        labelId,
      },
    ]) {
      const result = await server.app.inject({
        method: 'POST',
        url: '/api/admin/governance/commands',
        headers: server.owner.headers,
        payload: { kind: 'governance.apply', id: newId('command'), action: change },
      });
      expect(result.statusCode, result.body).toBe(200);
    }
    let resource = server.resource as SharingAction['resource'];
    if (kind === 'folder') {
      resource = { kind, id: newId('folder') };
      for (const change of [
        { kind: 'folder.create', folderId: resource.id, name: 'Internal folder', parentId: null },
        { kind: 'database.move', databaseId: server.resource.id, parentId: resource.id },
      ]) {
        const result = await server.app.inject({
          method: 'POST',
          url: '/api/home/commands',
          headers: server.owner.headers,
          payload: { id: newId('command'), action: change },
        });
        expect(result.statusCode, result.body).toBe(200);
      }
    }
    await policy(server, { newPeopleRole: 'member' });
    const member = await command(server, { ...action(server), resource });
    expect(member.statusCode, member.body).toBe(200);
    await policy(server, { newPeopleRole: 'guest' });
    const guest = await command(server, { ...action(server, 'guest@example.test'), resource });
    expect(guest.statusCode, guest.body).toBe(403);
    expect(guest.json().error.messageKey).toBe('governance.classificationDenied');
  },
);

it.each([true, false])(
  'restores imported relationships before checking single sign-on policy with a new account: %s',
  async (newAccount) => {
    const server = await fixture();
    await policy(server, { newPeopleRole: 'member' }, ['requireMfa']);
    const unit = await server.app.inject({
      method: 'POST',
      url: '/api/org/units',
      headers: server.owner.headers,
      payload: { name: 'Protected unit', parentId: null },
    });
    expect(unit.statusCode, unit.body).toBe(201);
    const unitId = unit.json().id as string;
    const required = await server.app.inject({
      method: 'PUT',
      url: `/api/org/units/${unitId}/policy`,
      headers: server.owner.headers,
      payload: { requireMfa: true },
    });
    expect(required.statusCode, required.body).toBe(200);
    expect((await command(server)).statusCode).toBe(200);
    const invitation = (await pending(server)).pending[0]!;
    const reservedId = newId('user');
    const userId = newAccount ? reservedId : newId('user');
    if (!newAccount)
      await query(
        server.pool,
        sql`INSERT INTO ${ident(server.schemas.app, 'users')} (id, email, name) VALUES (${userId}, 'invitee@example.test', 'Existing person')`,
      );
    const groupId = newId('group');
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'groups')} (id, org_id, name) VALUES (${groupId}, ${server.owner.info.org.id}, 'Imported group')`,
    );
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'invitations')} SET reserved_user_id = ${reservedId} WHERE id = ${invitation.id}`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'organization_import_review')} (id, org_id, kind, target_id, name, detail, done_at) VALUES (${randomUUID()}, ${server.owner.info.org.id}, 'person', ${reservedId}, 'Imported person', ${JSON.stringify({ unitId, unitAdmins: [{ unitId, roles: ['people'] }], groups: [groupId] })}::jsonb, clock_timestamp())`,
    );
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'databases')} SET created_by = NULL WHERE id = ${server.resource.id}`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'organization_import_authors')} (org_id, user_id, catalog, row_id, key_column, author_column) VALUES (${server.owner.info.org.id}, ${reservedId}, 'databases', ${server.resource.id}, 'id', 'created_by')`,
    );
    const providerId = randomBytes(8).toString('hex');
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'sso_providers')} (id, org_id, kind, name, issuer, client_id, sealed_secret, allowed_domains) VALUES (${providerId}, ${server.owner.info.org.id}, 'oidc', 'Directory', 'https://directory.example.test', ${randomBytes(8).toString('hex')}, ${randomBytes(24).toString('hex')}, ARRAY['example.test'])`,
    );
    const provider = (
      await query<ProviderRow>(
        server.pool,
        sql`SELECT * FROM ${ident(server.schemas.app, 'sso_providers')} WHERE id = ${providerId}`,
      )
    ).rows[0]!;
    const outcome = await signInClaimed(
      server.ctx,
      { headers: {}, ip: '127.0.0.1' } as FastifyRequest,
      provider,
      {
        issuer: provider.issuer!,
        subject: randomUUID(),
        email: 'invitee@example.test',
        emailVerified: true,
        name: 'Imported person',
        invitationToken: tokenOf(server.messages[0]!),
      },
    );
    const membership = await query(
      server.pool,
      sql`SELECT org_unit_id FROM ${ident(server.schemas.app, 'memberships')} WHERE user_id = ${userId}`,
    );
    expect(membership.rows).toEqual([{ org_unit_id: unitId }]);
    expect(outcome).toMatchObject({
      secondStep: { stage: 'setup' },
      pending: { userId, method: 'sso' },
    });
    expect(outcome).not.toHaveProperty('session');
    expect(
      (
        await query(
          server.pool,
          sql`SELECT user_id FROM ${ident(server.schemas.app, 'group_members')} WHERE group_id = ${groupId}`,
        )
      ).rows,
    ).toEqual([{ user_id: userId }]);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT roles FROM ${ident(server.schemas.app, 'org_unit_admins')} WHERE user_id = ${userId}`,
        )
      ).rows,
    ).toEqual([{ roles: ['people'] }]);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT created_by FROM ${ident(server.schemas.app, 'databases')} WHERE id = ${server.resource.id}`,
        )
      ).rows,
    ).toEqual([{ created_by: userId }]);
  },
);

it.each([{ domains: null }, { domains: ['allowed.test'] }])(
  'reports disabled sharing before administrator and domain restrictions: %j',
  async ({ domains }) => {
    const server = await fixture();
    await policy(server, {
      newPeopleSharing: false,
      newPeopleAdministratorsOnly: true,
      allowedEmailDomains: domains,
    });
    expect(await pending(server)).toMatchObject({ allowed: false, refusal: 'membersOnly' });
    const refused = await command(server);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error.messageKey).toBe('share.invite.membersOnly');
  },
);

it('undoes an invitation and restores the previous access when a pending role changes', async () => {
  const server = await fixture();
  const id = newId('command');
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/home/commands',
    headers: server.owner.headers,
    payload: { id, action: action(server) },
  });
  expect(created.statusCode, created.body).toBe(200);
  const changedId = newId('command');
  await server.app.inject({
    method: 'POST',
    url: '/api/home/commands',
    headers: server.owner.headers,
    payload: { id: changedId, action: action(server, 'invitee@example.test', 'editor') },
  });
  expect((await pending(server)).pending[0]!.role).toBe('editor');
  const undone = await server.app.inject({
    method: 'POST',
    url: `/api/home/undo/${changedId}`,
    headers: server.owner.headers,
    payload: { id: newId('command') },
  });
  expect(undone.statusCode, undone.body).toBe(200);
  expect((await pending(server)).pending[0]!.role).toBe('reader');
  const person = (await pending(server)).pending[0]!;
  await command(server, { kind: 'share.revoke', resource: server.resource, invitationId: person.id });
  expect((await pending(server)).pending).toEqual([]);
  const nextId = newId('command');
  await server.app.inject({
    method: 'POST',
    url: '/api/home/commands',
    headers: server.owner.headers,
    payload: { id: nextId, action: action(server, 'another@example.test') },
  });
  const revoked = await server.app.inject({
    method: 'POST',
    url: `/api/home/undo/${nextId}`,
    headers: server.owner.headers,
    payload: { id: newId('command') },
  });
  expect(revoked.statusCode, revoked.body).toBe(200);
  expect((await pending(server)).pending).toEqual([]);
});

it.each([true, false])(
  'accepts through matching single sign-on only with the fixed verified address: %s',
  async (matches) => {
    const server = await fixture();
    await command(server);
    const providerId = randomBytes(8).toString('hex');
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'sso_providers')} (id, org_id, kind, name, issuer, client_id, sealed_secret, allowed_domains)
    VALUES (${providerId}, ${server.owner.info.org.id}, 'oidc', 'Directory', 'https://directory.example.test', ${randomBytes(8).toString('hex')}, ${randomBytes(24).toString('hex')}, ARRAY['example.test'])`,
    );
    const provider = (
      await query<ProviderRow>(
        server.pool,
        sql`SELECT * FROM ${ident(server.schemas.app, 'sso_providers')} WHERE id = ${providerId}`,
      )
    ).rows[0]!;
    const token = tokenOf(server.messages[0]!);
    const preview = await server.app.inject({ url: `/api/auth/invitations/${token}` });
    expect(preview.json()).toMatchObject({ sso: { id: providerId, name: 'Directory' } });
    expect((await accept(server, token)).json()).toMatchObject({
      error: { messageKey: 'share.invite.useSso' },
    });
    const outcome = await signInClaimed(
      server.ctx,
      { headers: {}, ip: '127.0.0.1' } as FastifyRequest,
      provider,
      {
        issuer: provider.issuer!,
        subject: randomUUID(),
        name: 'New person',
        email: matches ? 'INVITEE@EXAMPLE.TEST' : 'different@example.test',
        emailVerified: true,
        invitationToken: token,
      },
    );
    if (matches) {
      expect(outcome).toHaveProperty('session');
      expect((await pending(server)).pending).toEqual([]);
    } else {
      expect(outcome).toEqual({ failure: 'sso.noAccount' });
      expect((await pending(server)).pending).toHaveLength(1);
    }
  },
);
