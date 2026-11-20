import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import {
  newId,
  type Member,
  type PersonalProfile,
  type OrganizationCommandResult,
  type OrgUnit,
} from '@riosoma/contracts';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { hashPassword } from '../auth/passwords.js';
import { randomToken, tokenHash } from '../auth/database.js';
import { replaceRecoveryCodes } from '../auth/mfa/codes.js';
import { mfaStore } from '../auth/mfa/store.js';
import { actorFor } from '../automations/run.js';
import { AccessScope } from './access.js';
import { loadTable } from './metadata.js';
import { relationContext } from './format.js';
import { organizationChannel } from './notify.js';
import type { MailMessage } from '../mail/index.js';
import { standIn } from './files/scan-test-support.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
}, 60_000);
beforeEach(async () => {
  server = await startServer(kit, 'peopleprofile');
}, 60_000);
afterEach(async () => {
  await server?.close();
});
afterAll(async () => {
  await kit?.stop();
});
const call = (
  who: SignedIn,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  url: string,
  payload?: object,
) => server.app.inject({ method, url, headers: who.headers, ...(payload ? { payload } : {}) });
const command = (who: SignedIn, payload: object) => call(who, 'POST', '/api/org/admin-commands', payload);
const role = (who: SignedIn, person: SignedIn, value: string) =>
  call(who, 'PATCH', `/api/org/members/${person.userId}/role`, { role: value });
const status = (who: SignedIn, person: SignedIn, value: boolean) =>
  call(who, 'PATCH', `/api/org/members/${person.userId}/status`, { deactivated: value });
async function grant(person: SignedIn, roles: string[]) {
  const response = await command(server.owner, { kind: 'organization.roles', userId: person.userId, roles });
  expect(response.statusCode, response.body).toBe(200);
}
async function profile(who: SignedIn): Promise<PersonalProfile> {
  const response = await call(who, 'GET', '/api/me/profile');
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}
async function passwordFor(who: SignedIn): Promise<string> {
  const password = randomBytes(24).toString('base64url');
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'users')} SET password_hash = ${await hashPassword(password)} WHERE id = ${who.userId}`,
  );
  return password;
}
const error = (
  response: { statusCode: number; json(): { error: { messageKey: string } } },
  code: number,
  key: string,
) => {
  expect(response.statusCode).toBe(code);
  expect(response.json().error.messageKey).toBe(key);
};

describe('people roles and lifecycle', () => {
  it('keeps the last owner through demotion, deactivation, removal, and command replay', async () => {
    error(await role(server.owner, server.owner, 'member'), 409, 'people.guard.lastOwner');
    error(await role(server.owner, server.owner, 'guest'), 409, 'people.guard.lastOwner');
    error(await status(server.owner, server.owner, true), 409, 'people.guard.lastOwner');
    error(
      await call(server.owner, 'DELETE', `/api/org/members/${server.owner.userId}`),
      409,
      'people.guard.lastOwner',
    );
    error(
      await command(server.owner, { kind: 'people.role', userId: server.owner.userId, role: 'member' }),
      409,
      'people.guard.lastOwner',
    );
    expect((await call(server.owner, 'GET', '/api/auth/session')).json().membership.kind).toBe('owner');
  });

  it('allows self-demotion only while another active owner remains', async () => {
    const other = await server.addMember();
    expect((await role(server.owner, other, 'owner')).statusCode).toBe(200);
    expect((await role(server.owner, server.owner, 'member')).statusCode).toBe(200);
    error(await role(other, other, 'member'), 409, 'people.guard.lastOwner');
    error(await status(other, other, true), 409, 'people.guard.lastOwner');
  });

  it('serializes concurrent owner demotions and leaves one active owner', async () => {
    const other = await server.addMember();
    await role(server.owner, other, 'owner');
    const results = await Promise.all([
      role(server.owner, server.owner, 'member'),
      role(other, other, 'member'),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT user_id FROM ${ident(server.schemas.app, 'memberships')}
      WHERE org_id = ${server.owner.info.org.id} AND kind = 'owner'`,
        )
      ).rows,
    ).toHaveLength(1);
  });

  it('authorizes each new route by the People scope and reserves owner changes for owners', async () => {
    const target = await server.addMember();
    const people = await server.addMember();
    const security = await server.addMember();
    const guest = await server.addMember({ kind: 'guest' });
    await grant(people, ['people']);
    await grant(security, ['security']);
    for (const who of [target, security, guest]) {
      expect((await call(who, 'GET', `/api/org/members/${target.userId}/access`)).statusCode).toBe(403);
      expect((await role(who, target, 'guest')).statusCode).toBe(403);
      expect((await status(who, target, true)).statusCode).toBe(403);
      expect(
        (await call(who, 'POST', `/api/org/members/${target.userId}/undo`, { eventId: '1' })).statusCode,
      ).toBe(403);
      expect(
        (await call(who, 'POST', `/api/org/members/${target.userId}/transfer-ownership`, {})).statusCode,
      ).toBe(403);
      expect(
        (await command(who, { kind: 'people.role', userId: target.userId, role: 'guest' })).statusCode,
      ).toBe(403);
    }
    expect((await call(people, 'GET', `/api/org/members/${target.userId}/access`)).json()).toEqual({
      role: 'member',
      deactivated: false,
    });
    expect((await role(people, target, 'guest')).statusCode).toBe(200);
    expect((await role(people, target, 'member')).statusCode).toBe(200);
    error(await role(people, target, 'owner'), 403, 'people.guard.ownerReach');
    error(await status(people, server.owner, true), 403, 'people.guard.ownerReach');
    expect((await server.app.inject({ url: `/api/org/members/${target.userId}/access` })).statusCode).toBe(
      401,
    );
  });

  it('limits a scoped administrator to people within their reach, including command replay', async () => {
    const admin = await server.addMember();
    const inside = await server.addMember();
    const outside = await server.addMember();
    const rootResponse = await call(server.owner, 'POST', '/api/org/units', {
      name: 'Research',
      parentId: null,
    });
    const root = rootResponse.json<OrgUnit>();
    expect(rootResponse.statusCode, rootResponse.body).toBe(201);
    for (const person of [admin, inside])
      expect(
        (await call(server.owner, 'PUT', `/api/org/members/${person.userId}/unit`, { unitId: root.id }))
          .statusCode,
      ).toBe(200);
    expect(
      (
        await call(server.owner, 'PUT', `/api/org/units/${root.id}/admins/${admin.userId}`, {
          roles: ['people'],
        })
      ).statusCode,
    ).toBe(200);
    const changed = await role(admin, inside, 'guest');
    expect(changed.statusCode).toBe(200);
    expect(
      (
        await call(admin, 'POST', `/api/org/members/${inside.userId}/undo`, {
          eventId: changed.json().eventId,
        })
      ).statusCode,
    ).toBe(200);
    expect((await call(server.owner, 'GET', `/api/org/members/${inside.userId}/access`)).json().role).toBe(
      'member',
    );
    expect((await role(admin, outside, 'guest')).statusCode).toBe(403);
    error(await role(admin, inside, 'owner'), 403, 'people.guard.ownerReach');
    expect(
      (await command(admin, { kind: 'people.status', userId: outside.userId, deactivated: true })).statusCode,
    ).toBe(403);
    expect((await status(admin, inside, true)).statusCode).toBe(200);
    expect((await status(admin, inside, false)).statusCode).toBe(200);
  });

  it('leaves directory-managed roles and lifecycle to the directory', async () => {
    const managed = await server.addMember();
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'scim_users')} (org_id, user_id, document)
      VALUES (${server.owner.info.org.id}, ${managed.userId}, ${JSON.stringify({ userName: managed.email, active: true })}::jsonb)`,
    );
    error(await role(server.owner, managed, 'guest'), 409, 'people.guard.directory');
    error(await status(server.owner, managed, true), 409, 'people.guard.directory');
    error(await status(server.owner, managed, false), 409, 'people.guard.directory');
    error(
      await call(server.owner, 'POST', `/api/org/members/${managed.userId}/transfer-ownership`, {
        password: await passwordFor(server.owner),
      }),
      409,
      'people.guard.directory',
    );
  });

  it('ends sessions, login links, API tokens, and connected apps and never restores ended credentials', async () => {
    const person = await server.addMember();
    const password = await passwordFor(person);
    const link = randomToken();
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'login_tokens')}
      (id, user_id, email, purpose, token_hash, expires_at) VALUES (${newId('token')}, ${person.userId}, ${person.email}, 'magic_link', ${tokenHash(link)}, clock_timestamp() + interval '1 hour')`,
    );
    const made = await call(person, 'POST', '/api/tokens', {
      name: 'API access',
      scopes: ['data.records:read', 'schema.bases:read'],
      databases: 'all',
    });
    expect(made.statusCode, made.body).toBe(200);
    expect((await status(server.owner, person, true)).statusCode).toBe(200);
    expect((await call(person, 'GET', '/api/auth/session')).statusCode).toBe(401);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/auth/sign-in',
          payload: { email: person.email, password },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await server.app.inject({ method: 'POST', url: '/api/auth/link/redeem', payload: { token: link } }))
        .statusCode,
    ).toBe(401);
    const apiToken = made.json<{ token: string }>().token;
    expect(
      (
        await server.app.inject({
          url: '/api/v1/databases',
          headers: { authorization: `Bearer ${apiToken}` },
        })
      ).statusCode,
    ).toBe(401);
    const stored = await query(
      server.pool,
      sql`SELECT revoked_at FROM ${ident(server.schemas.app, 'api_tokens')} WHERE user_id = ${person.userId}`,
    );
    expect(stored.rows[0]?.revoked_at).not.toBeNull();
    expect((await status(server.owner, person, false)).statusCode).toBe(200);
    expect((await call(person, 'GET', '/api/auth/session')).statusCode).toBe(401);
    expect(
      (
        await server.app.inject({
          url: '/api/v1/databases',
          headers: { authorization: `Bearer ${apiToken}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/auth/sign-in',
          payload: { email: person.email, password },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('audits roles and deactivation and allows only one guarded undo', async () => {
    const person = await server.addMember();
    const changed = await role(server.owner, person, 'guest');
    const result = changed.json<OrganizationCommandResult>();
    expect(result.undoable).toBe(true);
    expect(
      (await call(server.owner, 'POST', '/api/me/profile/undo', { eventId: result.eventId })).statusCode,
    ).toBe(404);
    expect(
      (
        await call(server.owner, 'POST', `/api/org/members/${server.owner.userId}/undo`, {
          eventId: result.eventId,
        })
      ).statusCode,
    ).toBe(404);
    const undone = await command(server.owner, { kind: 'organization.undo', eventId: result.eventId });
    expect(undone.statusCode, undone.body).toBe(200);
    error(
      await command(server.owner, { kind: 'organization.undo', eventId: result.eventId }),
      409,
      'errors.conflict',
    );
    const inactive = (await status(server.owner, person, true)).json<OrganizationCommandResult>();
    expect(inactive.undoable).toBe(true);
    expect(
      (await command(server.owner, { kind: 'organization.undo', eventId: inactive.eventId })).statusCode,
    ).toBe(200);
    const events = await query(
      server.pool,
      sql`SELECT action, target, metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE target = ${person.userId} AND action IN ('people.role', 'people.status', 'organization.undo') ORDER BY id`,
    );
    expect(events.rows.map((event) => event.action)).toEqual([
      'people.role',
      'organization.undo',
      'people.status',
      'organization.undo',
    ]);
    expect(events.rows[0]?.metadata).toMatchObject({ before: { kind: 'member' }, after: { kind: 'guest' } });
  });

  it('refuses an undo that would remove the last owner or overwrite a newer change', async () => {
    const person = await server.addMember();
    const promoted = (await role(server.owner, person, 'owner')).json<OrganizationCommandResult>();
    await role(server.owner, server.owner, 'member');
    // The original actor no longer has People administration, so the old command grants nothing.
    expect(
      (await command(server.owner, { kind: 'organization.undo', eventId: promoted.eventId })).statusCode,
    ).toBe(403);
    await role(person, server.owner, 'owner');
    await role(server.owner, person, 'guest');
    error(
      await command(server.owner, { kind: 'organization.undo', eventId: promoted.eventId }),
      409,
      'errors.conflict',
    );
  });

  it('transfers ownership atomically with fresh password proof and has no undo', async () => {
    const person = await server.addMember();
    const url = `/api/org/members/${person.userId}/transfer-ownership`;
    error(await call(server.owner, 'POST', url, {}), 403, 'people.guard.reauthenticate');
    error(
      await call(server.owner, 'POST', url, { password: randomBytes(24).toString('hex') }),
      403,
      'people.guard.reauthenticate',
    );
    error(
      await command(server.owner, { kind: 'people.transfer', userId: person.userId }),
      403,
      'people.guard.reauthenticate',
    );
    const transferred = await call(server.owner, 'POST', url, { password: await passwordFor(server.owner) });
    expect(transferred.statusCode, transferred.body).toBe(200);
    expect(transferred.json().undoable).toBe(false);
    expect((await call(server.owner, 'GET', '/api/auth/session')).json().membership.kind).toBe('member');
    expect((await call(person, 'GET', '/api/auth/session')).json().membership.kind).toBe('owner');
    expect(
      (
        await query(
          server.pool,
          sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'people.transfer'`,
        )
      ).rows[0]?.metadata,
    ).toMatchObject({ from: server.owner.userId, to: person.userId, undoable: false });
  });

  it('accepts a fresh second step for transfer and consumes it only once', async () => {
    const person = await server.addMember();
    const codes = await withTransaction(server.pool, (db) =>
      replaceRecoveryCodes(db, mfaStore(server.ctx).tables, server.owner.userId),
    );
    const response = await call(
      server.owner,
      'POST',
      `/api/org/members/${person.userId}/transfer-ownership`,
      { proof: { method: 'recovery', code: codes[0] } },
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().undoable).toBe(false);
    const remaining = await call(server.owner, 'GET', '/api/me/mfa');
    expect(remaining.json().recoveryCodes.remaining).toBe(codes.length - 1);
  });

  it('retains published automation access after manual deactivation and denies human access', async () => {
    const person = await server.addMember();
    const databaseId = newId('database');
    const response = await call(person, 'POST', '/api/databases', {
      id: databaseId,
      name: 'Owned work',
      table: {
        id: newId('table'),
        name: 'Records',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'All records' },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    await status(server.owner, person, true);
    expect(await actorFor(server.pool, server.schemas, person.userId, person.info.org.id)).toBeNull();
    const acting = await actorFor(server.pool, server.schemas, person.userId, person.info.org.id, {
      id: newId('automation'),
      runId: randomToken(),
      depth: 0,
    });
    expect(acting).not.toBeNull();
    expect(await new AccessScope(server.pool, server.schemas, acting!).databaseRole(databaseId)).toBe(
      'owner',
    );
    expect(await new AccessScope(server.pool, server.schemas, acting!).visiblePeople()).toBeNull();
    expect((await call(person, 'GET', `/api/databases/${databaseId}/schema`)).statusCode).toBe(401);
  });
});

describe('personal profiles', () => {
  it('updates a shared profile in every organization while keeping role notices in their own organization', async () => {
    const person = await server.addMember();
    const otherOrg = newId('org');
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'orgs')} (id, name) VALUES (${otherOrg}, 'Other organization')`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'memberships')} (org_id, user_id, kind)
        VALUES (${otherOrg}, ${person.userId}, 'member')`,
    );
    const notices: Array<{ orgId: string; personChanged: string }> = [];
    const listener = await server.pool.connect();
    const receive = (notice: { channel: string; payload?: string }) => {
      if (notice.channel === organizationChannel(server.schemas) && notice.payload)
        notices.push(JSON.parse(notice.payload) as { orgId: string; personChanged: string });
    };
    listener.on('notification', receive);
    try {
      await query(listener, sql`LISTEN ${ident(organizationChannel(server.schemas))}`);
      const current = await profile(person);
      expect(
        (
          await call(person, 'PATCH', '/api/me/profile', {
            name: 'Shared profile',
            revision: current.revision,
          })
        ).statusCode,
      ).toBe(200);
      await expect
        .poll(() => notices.map((notice) => notice.orgId).sort())
        .toEqual([person.info.org.id, otherOrg].sort());
      expect(notices.every((notice) => notice.personChanged === person.userId)).toBe(true);
      notices.length = 0;
      expect((await role(server.owner, person, 'guest')).statusCode).toBe(200);
      await query(listener, sql`SELECT 1`);
      await expect.poll(() => notices.map((notice) => notice.orgId)).toEqual([person.info.org.id]);
    } finally {
      await query(listener, sql`UNLISTEN ${ident(organizationChannel(server.schemas))}`);
      listener.off('notification', receive);
      listener.release();
    }
  });

  it('refreshes cached person searches after a profile change and hides names from unrelated guests', async () => {
    const person = await server.addMember();
    const guest = await server.addMember({ kind: 'guest' });
    const before = await profile(person);
    await call(person, 'PATCH', '/api/me/profile', {
      revision: before.revision,
      name: 'River Search Before',
    });
    const databaseId = newId('database');
    const tableId = newId('table');
    const fieldId = newId('field');
    const viewId = newId('view');
    const recordId = newId('record');
    expect(
      (
        await call(server.owner, 'POST', '/api/databases', {
          id: databaseId,
          name: 'People search',
          table: {
            id: tableId,
            name: 'Records',
            fields: [
              { id: newId('field'), name: 'Name', type: 'text' },
              { id: fieldId, name: 'Person', type: 'user' },
            ],
            view: { id: viewId, name: 'All records' },
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(server.owner, 'POST', `/api/databases/${databaseId}/commands`, {
          clientId: newId('client'),
          commands: [
            {
              id: newId('command'),
              groupId: newId('action'),
              kind: 'record.create',
              tableId,
              records: [{ id: recordId, values: { [fieldId]: [person.userId] } }],
            },
          ],
        })
      ).json().results[0].status,
    ).toBe('applied');
    await call(server.owner, 'PUT', `/api/databases/${databaseId}/grants`, {
      principal: { kind: 'user', id: guest.userId },
      role: 'reader',
    });
    const search = async (who: SignedIn, name: string) => {
      const response = await call(who, 'POST', `/api/views/${viewId}/search`, { query: name });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().total;
    };
    expect(await search(server.owner, 'River Search Before')).toBe(1);
    expect(await search(guest, 'River Search Before')).toBe(0);
    await call(person, 'PATCH', '/api/me/profile', {
      revision: (await profile(person)).revision,
      name: 'River Search After',
    });
    expect(await search(server.owner, 'River Search Before')).toBe(0);
    expect(await search(server.owner, 'River Search After')).toBe(1);
    expect(await search(guest, 'River Search After')).toBe(0);
    const stored = await call(guest, 'GET', `/api/views/${viewId}/rows`);
    expect(stored.statusCode, stored.body).toBe(200);
    expect(stored.json().rows.find((row: { id: string }) => row.id === recordId).values[fieldId]).toEqual([
      person.userId,
    ]);
  });

  it('uses the same person visibility in API and export formatting as in profile picture reads', async () => {
    const hidden = await server.addMember();
    const guest = await server.addMember({ kind: 'guest' });
    const databaseId = newId('database');
    const tableId = newId('table');
    expect(
      (
        await call(server.owner, 'POST', '/api/databases', {
          id: databaseId,
          name: 'Visible records',
          table: {
            id: tableId,
            name: 'Records',
            fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
            view: { id: newId('view'), name: 'All records' },
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(server.owner, 'PUT', `/api/databases/${databaseId}/grants`, {
          principal: { kind: 'user', id: guest.userId },
          role: 'reader',
        })
      ).statusCode,
    ).toBe(200);
    const actor = (await actorFor(server.pool, server.schemas, guest.userId, guest.info.org.id))!;
    const scope = new AccessScope(server.pool, server.schemas, actor);
    await scope.require(databaseId, 'read');
    const labels = await relationContext({
      db: server.pool,
      schemas: server.schemas,
      table: (await loadTable(server.pool, server.schemas, tableId))!,
      scope,
      fields: [],
      rows: [],
      names: true,
    });
    expect([...labels.people.keys()].sort()).toEqual([server.owner.userId, guest.userId].sort());
    expect(labels.people.has(hidden.userId)).toBe(false);
  });

  it('undoes a name-only profile change once and refuses another person or a stale value', async () => {
    const person = await server.addMember();
    const other = await server.addMember();
    const before = await profile(person);
    const changed = await call(person, 'PATCH', '/api/me/profile', {
      revision: before.revision,
      name: 'New display name',
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().undoable).toBe(true);
    const eventId = changed.json<OrganizationCommandResult>().eventId;
    expect((await call(other, 'POST', '/api/me/profile/undo', { eventId })).statusCode).toBe(404);
    expect(
      (await call(person, 'POST', '/api/me/profile/undo', { eventId })).json<OrganizationCommandResult>()
        .profile?.name,
    ).toBe(before.name);
    expect((await call(person, 'POST', '/api/me/profile/undo', { eventId })).statusCode).toBe(409);
    const next = await call(person, 'PATCH', '/api/me/profile', {
      revision: (await profile(person)).revision,
      name: 'First change',
    });
    await call(person, 'PATCH', '/api/me/profile', {
      revision: (await profile(person)).revision,
      name: 'Later change',
    });
    expect(
      (await call(person, 'POST', '/api/me/profile/undo', { eventId: next.json().eventId })).statusCode,
    ).toBe(409);
    expect((await profile(person)).name).toBe('Later change');
  });

  it('saves a name and a safely served square picture, removes it, and audits both changes', async () => {
    const person = await server.addMember();
    const bytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ff0000' } })
      .png()
      .toBuffer();
    const current = await profile(person);
    const saved = await call(person, 'PATCH', '/api/me/profile', {
      revision: current.revision,
      name: 'New name',
      picture: `data:image/png;base64,${bytes.toString('base64')}`,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const after = saved.json<OrganizationCommandResult>().profile!;
    expect(after.name).toBe('New name');
    expect((await call(person, 'GET', '/api/auth/session')).json().user.name).toBe('New name');
    expect(
      (await call(server.owner, 'GET', '/api/org/members'))
        .json<Member[]>()
        .find((member) => member.id === person.userId)?.name,
    ).toBe('New name');
    const guest = await server.addMember({ kind: 'guest' });
    expect((await call(guest, 'GET', after.pictureUrl!)).statusCode).toBe(404);
    expect(
      (await call(guest, 'GET', '/api/org/members')).json<Member[]>().map((member) => member.id),
    ).toEqual([guest.userId]);
    const image = await call(server.owner, 'GET', after.pictureUrl!);
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(await sharp(image.rawPayload).metadata()).toMatchObject({ width: 256, height: 256 });
    expect(
      (await call(person, 'PATCH', '/api/me/profile', { revision: after.revision, picture: null }))
        .statusCode,
    ).toBe(200);
    expect((await call(server.owner, 'GET', after.pictureUrl!)).statusCode).toBe(404);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT action FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'profile.update'`,
        )
      ).rows,
    ).toHaveLength(2);
  });

  it('refuses a profile picture before sending bytes to a revoked scanner address', async () => {
    const scanner = await standIn();
    try {
      server.config.clamavApprovedUrls = [];
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'orgs')}
        SET settings = jsonb_set(settings, '{fileScanner}', ${JSON.stringify({ enabled: true, address: scanner.url, oversizedPolicy: 'quarantine' })}::jsonb)
        WHERE id = ${server.owner.info.org.id}`,
      );
      const bytes = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#ffffff' } })
        .png()
        .toBuffer();
      const before = await profile(server.owner);
      const response = await call(server.owner, 'PATCH', '/api/me/profile', {
        revision: before.revision,
        picture: `data:image/png;base64,${bytes.toString('base64')}`,
      });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error.messageKey).toBe('files.scanner.addressNotApproved');
      expect(scanner.received).toHaveLength(0);
      expect((await profile(server.owner)).pictureUrl).toBe(before.pictureUrl);
    } finally {
      await scanner.close();
    }
  });

  it('rejects stale saves, malformed pictures, non-square pictures, and changes to managed fields', async () => {
    const person = await server.addMember();
    const current = await profile(person);
    expect(
      (await call(person, 'PATCH', '/api/me/profile', { revision: current.revision, name: 'Updated' }))
        .statusCode,
    ).toBe(200);
    error(
      await call(person, 'PATCH', '/api/me/profile', { revision: current.revision, name: 'Stale' }),
      409,
      'errors.conflict',
    );
    const updated = await profile(person);
    error(
      await call(person, 'PATCH', '/api/me/profile', {
        revision: updated.revision,
        picture: 'data:image/png;base64,AAAA',
      }),
      422,
      'profile.picture.invalid',
    );
    const rectangular = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer();
    error(
      await call(person, 'PATCH', '/api/me/profile', {
        revision: updated.revision,
        picture: `data:image/png;base64,${rectangular.toString('base64')}`,
      }),
      422,
      'profile.picture.invalid',
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'scim_users')} (org_id, user_id, document)
      VALUES (${person.info.org.id}, ${person.userId}, ${JSON.stringify({ userName: person.email, active: true })}::jsonb)`,
    );
    const managed = await profile(person);
    expect(managed.managedFields).toEqual(['name', 'email', 'picture']);
    error(
      await call(person, 'PATCH', '/api/me/profile', { revision: managed.revision, name: 'Local' }),
      403,
      'profile.managed',
    );
  });

  it('confirms a new email through a one-time link before applying it and tells the old address', async () => {
    const person = await server.addMember();
    const mails: MailMessage[] = [];
    server.ctx.mailer = {
      send: async (mail) => {
        mails.push(mail);
      },
    };
    server.ctx.config.baseUrl = 'https://example.test';
    const email = `${randomBytes(8).toString('hex')}@example.test`;
    const sent = await call(person, 'POST', '/api/me/profile/email', { email });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.body).not.toContain('token');
    expect((await profile(person)).email).toBe(person.email);
    expect(mails[0]?.to).toBe(email);
    const token = /emailToken=([\w-]+)/.exec(mails[0]!.text)![1]!;
    const other = await server.addMember();
    error(
      await call(other, 'POST', '/api/me/profile/email/confirm', { token }),
      400,
      'profile.email.expired',
    );
    expect((await call(person, 'POST', '/api/me/profile/email/confirm', { token })).statusCode).toBe(200);
    expect((await profile(person)).email).toBe(email);
    expect(mails[1]?.to).toBe(person.email);
    expect(mails[1]?.text).toContain(email);
    error(
      await call(person, 'POST', '/api/me/profile/email/confirm', { token }),
      400,
      'profile.email.expired',
    );
  });
});

describe('person visibility regressions', () => {
  it('refuses to convert hidden people without exposing names or changing stored values', async () => {
    const hidden = await server.addMember();
    const guest = await server.addMember({ kind: 'guest' });
    const databaseId = newId('database');
    const tableId = newId('table');
    const fieldId = newId('field');
    const viewId = newId('view');
    const recordId = newId('record');
    expect(
      (
        await call(server.owner, 'POST', '/api/databases', {
          id: databaseId,
          name: 'Scoped conversion',
          table: {
            id: tableId,
            name: 'Records',
            fields: [
              { id: newId('field'), name: 'Name', type: 'text' },
              { id: fieldId, name: 'Person', type: 'user' },
            ],
            view: { id: viewId, name: 'All records' },
          },
        })
      ).statusCode,
    ).toBe(200);
    const run = (who: SignedIn, change: object) =>
      call(who, 'POST', `/api/databases/${databaseId}/commands`, {
        clientId: newId('client'),
        commands: [{ id: newId('command'), groupId: newId('action'), ...change }],
      });
    expect(
      (
        await run(server.owner, {
          kind: 'record.create',
          tableId,
          records: [{ id: recordId, values: { [fieldId]: [hidden.userId] } }],
        })
      ).json().results[0].status,
    ).toBe('applied');
    expect(
      (
        await call(server.owner, 'PUT', `/api/databases/${databaseId}/grants`, {
          principal: { kind: 'user', id: guest.userId },
          role: 'creator',
        })
      ).statusCode,
    ).toBe(200);
    const preview = await call(guest, 'POST', `/api/fields/${fieldId}/conversion-preview`, {
      to: { type: 'text' },
      dateOrder: 'mdy',
      timeZone: 'UTC',
    });
    const changed = await run(guest, { kind: 'field.convert', fieldId, to: { type: 'text' } });
    expect(changed.json().results[0]).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.user.unknown' },
    });
    expect(preview.statusCode).toBe(403);
    expect(preview.json().error.messageKey).toBe('data.user.unknown');
    expect(preview.body).not.toContain(hidden.info.user.name);
    expect(changed.body).not.toContain(hidden.info.user.name);
    const schema = (await call(server.owner, 'GET', `/api/databases/${databaseId}/schema`)).json();
    expect(schema.fields.find((field: { id: string }) => field.id === fieldId).type).toBe('user');
    const stored = await call(guest, 'GET', `/api/views/${viewId}/rows`);
    expect(stored.json().rows.find((row: { id: string }) => row.id === recordId).values[fieldId]).toEqual([
      hidden.userId,
    ]);
    expect(
      (await run(server.owner, { kind: 'field.convert', fieldId, to: { type: 'text' } })).json().results[0]
        .status,
    ).toBe('applied');
  });

  it('shows database collaborators reached through ancestor folders and honors classification', async () => {
    const guest = await server.addMember({ kind: 'guest' });
    const hidden = await server.addMember();
    const databaseId = newId('database');
    const tableId = newId('table');
    const parentId = newId('folder');
    const childId = newId('folder');
    const home = async (action: object) => {
      const response = await call(server.owner, 'POST', '/api/home/commands', {
        id: newId('command'),
        action,
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    await home({ kind: 'folder.create', folderId: parentId, name: 'Projects', parentId: null });
    await home({ kind: 'folder.create', folderId: childId, name: 'Records', parentId });
    expect(
      (
        await call(server.owner, 'POST', '/api/databases', {
          id: databaseId,
          name: 'Inherited people',
          table: {
            id: tableId,
            name: 'Records',
            fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
            view: { id: newId('view'), name: 'All records' },
          },
        })
      ).statusCode,
    ).toBe(200);
    await home({ kind: 'database.move', databaseId, parentId: childId, confirmedLosses: [] });
    await home({
      kind: 'folder.share',
      folderId: parentId,
      principal: { kind: 'user', id: guest.userId },
      role: 'reader',
    });
    expect((await call(guest, 'GET', `/api/databases/${databaseId}/schema`)).statusCode).toBe(200);
    const people = (await call(guest, 'GET', '/api/org/members')).json<Member[]>();
    expect(people.map((person) => person.id).sort()).toEqual([guest.userId, server.owner.userId].sort());
    expect(people.some((person) => person.id === hidden.userId)).toBe(false);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'databases')}
      SET classification_label = 'missing-closed-label' WHERE id = ${databaseId}`,
    );
    const actor = (await actorFor(server.pool, server.schemas, guest.userId, guest.info.org.id))!;
    const scope = new AccessScope(server.pool, server.schemas, actor);
    expect(await scope.databaseRole(databaseId)).toBeNull();
    expect(await scope.visiblePeople()).toEqual(new Set([guest.userId]));
  });
});
