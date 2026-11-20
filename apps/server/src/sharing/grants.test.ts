import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseSummary, Grant, Member, newId, type DatabaseRole, type Principal } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';

let kit: TestPostgres;
const cleanups: Array<() => Promise<void>> = [];
beforeAll(async () => {
  kit = await startTestPostgres();
}, 60_000);
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});
afterAll(async () => {
  await kit?.stop();
});

async function fixture() {
  const server = await startServer(kit, 'sharing');
  cleanups.push(() => server.close());
  return server;
}

async function database(server: ServerFixture, owner = server.owner) {
  const id = newId('database');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: owner.headers,
    payload: {
      id,
      name: 'Shared database',
      table: {
        id: newId('table'),
        name: 'Table',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'All records' },
      },
    },
  });
  expect(response.statusCode).toBe(200);
  return id;
}

function setGrant(
  server: ServerFixture,
  databaseId: string,
  principal: Principal,
  role: DatabaseRole,
  actor = server.owner,
) {
  return server.app.inject({
    method: 'PUT',
    url: `/api/databases/${databaseId}/grants`,
    headers: actor.headers,
    payload: { principal, role },
  });
}

function removeGrant(server: ServerFixture, databaseId: string, principal: Principal, actor = server.owner) {
  return server.app.inject({
    method: 'DELETE',
    url: `/api/databases/${databaseId}/grants`,
    headers: actor.headers,
    payload: { principal },
  });
}

async function databases(server: ServerFixture, member: SignedIn) {
  const result = await server.app.inject({ url: '/api/databases', headers: member.headers });
  expect(result.statusCode).toBe(200);
  return DatabaseSummary.array().parse(result.json());
}

async function members(server: ServerFixture, member: SignedIn) {
  const result = await server.app.inject({ url: '/api/org/members', headers: member.headers });
  expect(result.statusCode).toBe(200);
  expect(result.headers['cache-control']).toBe('no-store');
  return Member.array().parse(result.json());
}

describe('database grants', () => {
  it('shares with a member, updates their role, and removes their access immediately', async () => {
    const server = await fixture();
    const id = await database(server);
    const member = await server.addMember();
    const principal = { kind: 'user' as const, id: member.userId };
    expect(await databases(server, member)).toEqual([]);
    expect(
      (await server.app.inject({ url: `/api/databases/${id}/grants`, headers: member.headers })).statusCode,
    ).toBe(404);
    const shared = await setGrant(server, id, principal, 'reader');
    expect(shared.statusCode).toBe(200);
    expect(Grant.array().parse(shared.json())).toContainEqual({
      principal: { ...principal, name: member.info.user.name, email: member.email },
      role: 'reader',
    });
    expect(await databases(server, member)).toMatchObject([{ id, role: 'reader' }]);
    expect(
      (await server.app.inject({ url: `/api/databases/${id}/schema`, headers: member.headers })).statusCode,
    ).toBe(200);
    expect(
      (await server.app.inject({ url: `/api/databases/${id}/grants`, headers: member.headers })).json(),
    ).toEqual(shared.json());
    expect((await setGrant(server, id, principal, 'editor')).statusCode).toBe(200);
    expect(await databases(server, member)).toMatchObject([{ id, role: 'editor' }]);
    const removed = await removeGrant(server, id, principal);
    expect(removed.statusCode).toBe(200);
    expect(Grant.array().parse(removed.json())).toHaveLength(1);
    expect(await databases(server, member)).toEqual([]);
    expect(
      (await server.app.inject({ url: `/api/databases/${id}/schema`, headers: member.headers })).statusCode,
    ).toBe(404);
    expect((await removeGrant(server, id, principal)).json()).toEqual(removed.json());
  });

  it('gives organization grants to members, never guests, and uses the strongest role', async () => {
    const server = await fixture();
    const id = await database(server);
    const member = await server.addMember();
    const guest = await server.addMember({ kind: 'guest' });
    expect((await setGrant(server, id, { kind: 'org' }, 'editor')).statusCode).toBe(200);
    expect(await databases(server, member)).toMatchObject([{ id, role: 'editor' }]);
    expect(await databases(server, guest)).toEqual([]);
    expect(
      (await server.app.inject({ url: `/api/databases/${id}/grants`, headers: guest.headers })).statusCode,
    ).toBe(404);
    expect((await setGrant(server, id, { kind: 'user', id: guest.userId }, 'reader')).statusCode).toBe(200);
    expect(await databases(server, guest)).toMatchObject([{ id, role: 'reader' }]);
    await setGrant(server, id, { kind: 'user', id: member.userId }, 'reader');
    expect(await databases(server, member)).toMatchObject([{ id, role: 'editor' }]);
    await removeGrant(server, id, { kind: 'org' });
    expect(await databases(server, member)).toMatchObject([{ id, role: 'reader' }]);
    expect(await databases(server, guest)).toMatchObject([{ id, role: 'reader' }]);
  });

  it('lists people by name before the organization and excludes unrelated members', async () => {
    const server = await fixture();
    const id = await database(server);
    const zoe = await server.addMember({ name: 'Zoe' });
    const amy = await server.addMember({ name: 'Amy' });
    await server.addMember({ name: 'Unshared' });
    await setGrant(server, id, { kind: 'user', id: zoe.userId }, 'reader');
    await setGrant(server, id, { kind: 'user', id: amy.userId }, 'editor');
    const updated = await setGrant(server, id, { kind: 'org' }, 'commenter');
    expect(
      Grant.array()
        .parse(updated.json())
        .map((grant) => grant.principal.name),
    ).toEqual(['Amy', 'Owner', 'Zoe', 'Test organization']);
    const listed = await server.app.inject({ url: `/api/databases/${id}/grants`, headers: zoe.headers });
    expect(listed.json()).toEqual(updated.json());
  });

  it('allows only database owners to share, including when an organization owner has no grant', async () => {
    const server = await fixture();
    const id = await database(server);
    const member = await server.addMember();
    const principal = { kind: 'user' as const, id: member.userId };
    for (const role of ['reader', 'commenter', 'editor', 'creator'] as const) {
      await setGrant(server, id, principal, role);
      expect((await setGrant(server, id, { kind: 'org' }, 'reader', member)).statusCode).toBe(403);
      expect(
        (await removeGrant(server, id, { kind: 'user', id: server.owner.userId }, member)).statusCode,
      ).toBe(403);
    }
    await setGrant(server, id, principal, 'owner');
    expect((await setGrant(server, id, { kind: 'org' }, 'reader', member)).statusCode).toBe(200);
    await removeGrant(server, id, { kind: 'user', id: server.owner.userId }, member);
    expect((await setGrant(server, id, principal, 'reader')).statusCode).toBe(403);
    await removeGrant(server, id, { kind: 'org' }, member);
    expect((await setGrant(server, id, principal, 'reader')).statusCode).toBe(404);
  });

  it('rejects organization ownership, last-owner removal, and last-owner demotion', async () => {
    const server = await fixture();
    const id = await database(server);
    const owner = { kind: 'user' as const, id: server.owner.userId };
    const orgOwner = await setGrant(server, id, { kind: 'org' }, 'owner');
    expect(orgOwner.statusCode).toBe(422);
    expect(orgOwner.json()).toMatchObject({
      error: { code: 'validation_failed', messageKey: 'data.share.orgOwner' },
    });
    for (const response of [
      await removeGrant(server, id, owner),
      await setGrant(server, id, owner, 'reader'),
    ]) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: 'conflict', messageKey: 'data.share.lastOwner' },
      });
    }
    expect((await setGrant(server, id, owner, 'owner')).statusCode).toBe(200);
    const next = await server.addMember();
    await setGrant(server, id, { kind: 'user', id: next.userId }, 'owner');
    expect((await setGrant(server, id, owner, 'reader')).statusCode).toBe(200);
    expect((await removeGrant(server, id, { kind: 'user', id: next.userId }, next)).statusCode).toBe(409);
  });

  it.each(['remove', 'demote'] as const)(
    'keeps an owner when two owners concurrently %s themselves',
    async (action) => {
      const server = await fixture();
      const id = await database(server);
      const second = await server.addMember();
      await setGrant(server, id, { kind: 'user', id: second.userId }, 'owner');
      const responses = await Promise.all(
        [server.owner, second].map((person) =>
          action === 'remove'
            ? removeGrant(server, id, { kind: 'user', id: person.userId }, person)
            : setGrant(server, id, { kind: 'user', id: person.userId }, 'reader', person),
        ),
      );
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      const owners = await query(
        server.pool,
        sql`SELECT principal_id FROM ${ident(server.schemas.app, 'grants')}
      WHERE resource_id = ${id} AND principal_kind = 'user' AND role = 'owner'`,
      );
      expect(owners.rowCount).toBe(1);
    },
  );

  it('rechecks ownership after waiting on another sharing request', async () => {
    const server = await fixture();
    const id = await database(server);
    const second = await server.addMember();
    await setGrant(server, id, { kind: 'user', id: second.userId }, 'owner');
    const responses = await Promise.all([
      removeGrant(server, id, { kind: 'user', id: second.userId }),
      removeGrant(server, id, { kind: 'user', id: server.owner.userId }, second),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 404]);
  });

  it('hides unknown principals, foreign principals, and inaccessible databases', async () => {
    const server = await fixture();
    const id = await database(server);
    const foreignOrg = newId('org');
    const foreignUser = newId('user');
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'orgs')} (id, name) VALUES (${foreignOrg}, 'Foreign')`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'users')} (id, email) VALUES (${foreignUser}, 'foreign@example.test')`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'memberships')} (org_id, user_id) VALUES (${foreignOrg}, ${foreignUser})`,
    );
    for (const userId of [newId('user'), foreignUser]) {
      expect((await setGrant(server, id, { kind: 'user', id: userId }, 'reader')).statusCode).toBe(404);
      expect((await removeGrant(server, id, { kind: 'user', id: userId })).statusCode).toBe(404);
    }
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'databases')} SET org_id = ${foreignOrg} WHERE id = ${id}`,
    );
    expect((await setGrant(server, id, { kind: 'org' }, 'reader')).statusCode).toBe(404);
    expect(
      (await server.app.inject({ url: `/api/databases/${id}/grants`, headers: server.owner.headers }))
        .statusCode,
    ).toBe(404);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'databases')} SET org_id = ${server.owner.info.org.id}, trashed_at = clock_timestamp() WHERE id = ${id}`,
    );
    expect((await removeGrant(server, id, { kind: 'org' })).statusCode).toBe(404);
  });

  it('requires a session, CSRF, valid IDs, and valid grant bodies', async () => {
    const server = await fixture();
    const id = await database(server);
    expect((await server.app.inject({ url: `/api/databases/${id}/grants` })).statusCode).toBe(401);
    expect(
      (
        await server.app.inject({
          method: 'PUT',
          url: `/api/databases/${id}/grants`,
          headers: { cookie: server.owner.headers.cookie },
          payload: { principal: { kind: 'org' }, role: 'reader' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.app.inject({
          method: 'PUT',
          url: `/api/databases/${id}/grants`,
          headers: server.owner.headers,
          payload: { principal: { kind: 'org' }, role: 'invalid' },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await server.app.inject({
          method: 'DELETE',
          url: `/api/databases/${id}/grants`,
          headers: server.owner.headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await server.app.inject({ url: '/api/databases/invalid/grants', headers: server.owner.headers }))
        .statusCode,
    ).toBe(422);
  });

  it('audits grant changes with principal and role, omitting rejected changes and no-op removal', async () => {
    const server = await fixture();
    const id = await database(server);
    const member = await server.addMember();
    const principal = { kind: 'user' as const, id: member.userId };
    await setGrant(server, id, principal, 'reader');
    await setGrant(server, id, principal, 'editor');
    await removeGrant(server, id, principal);
    await removeGrant(server, id, principal);
    await setGrant(server, id, { kind: 'org' }, 'owner');
    await removeGrant(server, id, { kind: 'user', id: server.owner.userId });
    const events = await query<{ action: string; org_id: string; actor_id: string; metadata: unknown }>(
      server.pool,
      sql`
      SELECT action, org_id, actor_id, metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE action LIKE 'data.grant.%' ORDER BY id`,
    );
    expect(events.rows).toEqual([
      {
        action: 'data.grant.set',
        org_id: server.owner.info.org.id,
        actor_id: server.owner.userId,
        metadata: { databaseId: id, principal, role: 'reader' },
      },
      {
        action: 'data.grant.set',
        org_id: server.owner.info.org.id,
        actor_id: server.owner.userId,
        metadata: { databaseId: id, principal, role: 'editor' },
      },
      {
        action: 'data.grant.removed',
        org_id: server.owner.info.org.id,
        actor_id: server.owner.userId,
        metadata: { databaseId: id, principal, role: 'editor' },
      },
    ]);
    expect(JSON.stringify(events.rows)).not.toContain(member.email);
    expect(JSON.stringify(events.rows)).not.toContain(server.owner.email);
  });
});

describe('organization member visibility', () => {
  it('shows owners and members everyone, including membership roles and deactivation', async () => {
    const server = await fixture();
    const member = await server.addMember({ name: 'Amy' });
    const guest = await server.addMember({ name: 'Zoe', kind: 'guest' });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'users')} SET deactivated_at = clock_timestamp() WHERE id = ${guest.userId}`,
    );
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET admin_roles = ARRAY['people'] WHERE user_id = ${member.userId}`,
    );
    const expected = [
      {
        id: member.userId,
        name: 'Amy',
        email: member.email,
        kind: 'member',
        adminRoles: ['people'],
        deactivated: false,
        pictureUrl: null,
        canManage: true,
        guestRoleBlocked: false,
        lastOwner: false,
      },
      {
        id: server.owner.userId,
        name: 'Owner',
        email: server.owner.email,
        kind: 'owner',
        adminRoles: [],
        deactivated: false,
        pictureUrl: null,
        canManage: true,
        guestRoleBlocked: false,
        lastOwner: true,
      },
      {
        id: guest.userId,
        name: 'Zoe',
        email: guest.email,
        kind: 'guest',
        adminRoles: [],
        deactivated: true,
        pictureUrl: null,
        canManage: true,
        guestRoleBlocked: false,
        lastOwner: false,
      },
    ];
    expect(await members(server, server.owner)).toEqual(expected);
    expect(await members(server, member)).toEqual(expected);
    expect((await server.app.inject({ url: '/api/org/members' })).statusCode).toBe(401);
  });

  it('limits guests to themselves and direct collaborators on databases they can open', async () => {
    const server = await fixture();
    const guest = await server.addMember({ kind: 'guest' });
    const collaborator = await server.addMember({ name: 'Collaborator' });
    const hidden = await server.addMember({ name: 'Hidden' });
    const shared = await database(server);
    const privateDatabase = await database(server, hidden);
    await setGrant(server, shared, { kind: 'org' }, 'reader');
    await setGrant(server, shared, { kind: 'user', id: collaborator.userId }, 'reader');
    expect((await members(server, guest)).map((member) => member.id)).toEqual([guest.userId]);
    await setGrant(server, shared, { kind: 'user', id: guest.userId }, 'reader');
    expect((await members(server, guest)).map((member) => member.id).sort()).toEqual(
      [guest.userId, collaborator.userId, server.owner.userId].sort(),
    );
    await setGrant(server, privateDatabase, { kind: 'user', id: guest.userId }, 'reader', hidden);
    expect((await members(server, guest)).map((member) => member.id)).toContain(hidden.userId);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'databases')} SET trashed_at = clock_timestamp() WHERE id = ${privateDatabase}`,
    );
    expect((await members(server, guest)).map((member) => member.id)).not.toContain(hidden.userId);
    await removeGrant(server, shared, { kind: 'user', id: guest.userId });
    expect((await members(server, guest)).map((member) => member.id)).toEqual([guest.userId]);
  });
});
