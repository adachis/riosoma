import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import {
  UNIT_ADMIN_ROLES,
  newId,
  type Member,
  type OrgUnit,
  type SessionInfo,
  type UnitAdminRole,
  type UnitAuditEntry,
} from '@riosoma/contracts';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { organizationChannel } from '../data/notify.js';
import { startWalk } from './walk.test-support.js';
import { seal } from '../secrets.js';
import {
  administrationRoutes,
  installPolicies,
  policyRoutes,
  undeclaredScope,
  type Policy,
} from '../http/policy.js';

let kit: TestPostgres;
let server: ServerFixture;
let schema: string;
/** Placed in Research and administers it with every role */
let admin: SignedIn;
/** Placed in Materials, below Research */
let inside: SignedIn;
/** Placed in Materials and administers it with the People role */
let lead: SignedIn;
/** Placed in Operations, outside Research */
let outside: SignedIn;
/** Placed in no unit, so directly in the organization */
let unplaced: SignedIn;
let research: OrgUnit;
let materials: OrgUnit;
let operations: OrgUnit;
let outsideFolder: string;
let outsideSource: string;
let before: { session: SessionInfo; members: Array<Record<string, unknown>>; units: unknown };

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function call(who: SignedIn, method: Method, url: string, payload?: unknown) {
  return server.app.inject({
    method,
    url,
    headers: who.headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function status(who: SignedIn, method: Method, url: string, payload?: unknown): Promise<number> {
  return (await call(who, method, url, payload)).statusCode;
}

async function ok<T>(
  who: SignedIn,
  method: Method,
  url: string,
  payload?: unknown,
  expected = 200,
): Promise<T> {
  const response = await call(who, method, url, payload);
  expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(expected);
  return (response.body ? response.json() : undefined) as T;
}

const createUnit = (name: string, parentId: string | null, who = server.owner) =>
  ok<OrgUnit>(who, 'POST', '/api/org/units', { name, parentId }, 201);
const place = (person: SignedIn, unit: OrgUnit | null) =>
  ok(server.owner, 'PUT', `/api/org/members/${person.userId}/unit`, { unitId: unit?.id ?? null });
const grant = (unit: OrgUnit, person: SignedIn, roles: readonly UnitAdminRole[]) =>
  ok(server.owner, 'PUT', `/api/org/units/${unit.id}/admins/${person.userId}`, { roles });

async function createDatabase(owner: SignedIn, name: string): Promise<{ id: string; viewId: string }> {
  const id = newId('database');
  const viewId = newId('view');
  await ok(owner, 'POST', '/api/databases', {
    id,
    name,
    table: {
      id: newId('table'),
      name: 'Records',
      fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
      view: { id: viewId, name: 'All records' },
    },
  });
  return { id, viewId };
}

/** A data source only admins may use, as someone made it */
async function createSource(name: string, maker: SignedIn): Promise<string> {
  const id = newId('source');
  const connection = { kind: 'file-url', url: `https://files.example.test/${id}.csv`, format: 'csv' };
  await server.pool.query(
    `INSERT INTO ${schema}.sources (id, org_id, name, kind, connection, sealed_secrets, access, created_by)
     VALUES ($1, $2, $3, 'file-url', $4::jsonb, $5, 'admins', $6)`,
    [
      id,
      server.owner.info.org.id,
      name,
      JSON.stringify(connection),
      seal(server.config.secretKey, '{}', `source:${id}`),
      maker.userId,
    ],
  );
  return id;
}

async function unitOf(person: SignedIn): Promise<string | null> {
  const result = await server.pool.query<{ org_unit_id: string | null }>(
    `SELECT org_unit_id FROM ${schema}.memberships WHERE user_id = $1`,
    [person.userId],
  );
  return result.rows[0]!.org_unit_id;
}

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'units');
  schema = `"${server.schemas.app}"`;
  admin = await server.addMember({ name: 'Research admin' });
  inside = await server.addMember({ name: 'Materials person' });
  lead = await server.addMember({ name: 'Materials admin' });
  outside = await server.addMember({ name: 'Operations person' });
  unplaced = await server.addMember({ name: 'Organization person' });
  before = {
    session: await ok<SessionInfo>(server.owner, 'GET', '/api/auth/session'),
    members: await ok(server.owner, 'GET', '/api/org/members'),
    units: await ok(server.owner, 'GET', '/api/org/units'),
  };
  research = await createUnit('Research', null);
  materials = await createUnit('Materials', research.id);
  operations = await createUnit('Operations', null);
  await place(admin, research);
  await place(inside, materials);
  await place(lead, materials);
  await place(outside, operations);
  await grant(research, admin, UNIT_ADMIN_ROLES);
  await grant(materials, lead, ['people']);
  await createDatabase(outside, 'Operations records');
  outsideFolder = newId('folder');
  await server.pool.query(`INSERT INTO ${schema}.folders (id, org_id, name) VALUES ($1, $2, 'Operations')`, [
    outsideFolder,
    server.owner.info.org.id,
  ]);
  outsideSource = await createSource('Operations feed', outside);
}, 120_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

describe('Before the first unit', () => {
  it('shows nothing about units anywhere until one exists', async () => {
    expect(before.session.hasUnits).toBe(false);
    expect(before.session.membership).not.toHaveProperty('unitId');
    expect(before.session.membership).not.toHaveProperty('unitAdminGrants');
    expect(before.members.length).toBeGreaterThan(1);
    for (const member of before.members) expect(member).not.toHaveProperty('unitId');
    expect(before.units).toEqual([]);
    const after = await ok<SessionInfo>(server.owner, 'GET', '/api/auth/session');
    expect(after.hasUnits).toBe(true);
    expect(after.membership.unitId).toBeNull();
    const members = await ok<Member[]>(server.owner, 'GET', '/api/org/members');
    expect(members.find((member) => member.id === inside.userId)?.unitId).toBe(materials.id);
  });
});

describe('Route coverage', () => {
  it('refuses to start with an admin route that does not declare its scope', async () => {
    const app = Fastify();
    installPolicies(app, { sessions: () => ({ resolve: async () => null }), verifySetupToken: () => false });
    const undeclared = { kind: 'admin', area: 'people' } as unknown as Policy;
    expect(undeclaredScope(undeclared)).toBe('has no administration scope');
    expect(() =>
      app.get('/api/org/undeclared', { config: { policy: undeclared } }, async () => ({})),
    ).toThrow('has no administration scope');
    const unknown = { kind: 'admin', area: 'people', scope: 'everything' } as unknown as Policy;
    expect(() => app.get('/api/org/unknown', { config: { policy: unknown } }, async () => ({}))).toThrow(
      'has no administration scope',
    );
    // A list of areas can't stand for the one area a person, database, or source check needs.
    const several = { kind: 'admin', area: ['people', 'security'], scope: 'person' } as unknown as Policy;
    expect(() =>
      app.get('/api/org/several/:userId', { config: { policy: several } }, async () => ({})),
    ).toThrow('checks several areas');
    expect(() =>
      app.get('/api/admin/member-only', { config: { policy: { kind: 'session' } } }, async () => ({})),
    ).toThrow('without an admin policy');
    expect(administrationRoutes(app)).toEqual([]);
    await app.close();
  });

  it('has every admin route declare its scope, and every other route under /api/org/ be a known member route', () => {
    const routes = policyRoutes(server.app);
    const admins = administrationRoutes(server.app);
    expect(admins.length).toBeGreaterThan(80);
    for (const route of admins)
      expect(undeclaredScope(route.policy), `${route.method} ${route.url}`).toBeNull();
    for (const route of routes.filter((item) => item.url.startsWith('/api/admin/')))
      expect(route.policy.kind, `${route.method} ${route.url}`).toBe('admin');
    // The routes under /api/org/ any member may call.  A new one has to be added here on purpose.
    const memberRoutes = new Set([
      'GET /api/org/members',
      'GET /api/org/units',
      'GET /api/org/groups',
      'GET /api/org/appearance',
      'GET /api/org/logo/:key',
    ]);
    for (const route of routes.filter((item) => item.url.startsWith('/api/org/') && item.method !== 'HEAD'))
      if (route.policy.kind !== 'admin')
        expect([...memberRoutes], `${route.method} ${route.url} isn't an admin route`).toContain(
          `${route.method} ${route.url}`,
        );
  });

  /**
   * Every admin route, called by an admin of Research who holds every unit role, against targets
   * outside Research that all exist, so only the unit checks can refuse.  Each one is refused, or
   * answers a list with nothing from outside in it.  `walk-mutations.test.ts` switches each
   * reviewed route's own checks off and shows the walk then fails.
   */
  it('refuses a unit admin on every admin route outside their units', async () => {
    const walk = await startWalk(kit, 'unitroutes');
    try {
      expect(await walk.run()).toEqual([]);
      const units = await walk.server.app.inject({
        url: '/api/org/units',
        headers: walk.server.owner.headers,
      });
      expect(
        units
          .json<OrgUnit[]>()
          .map((unit) => unit.name)
          .sort(),
      ).toEqual(['Materials', 'Operations', 'Research']);
    } finally {
      await walk.close();
    }
  }, 120_000);

  it('fails closed for a policy it doesn’t know, wherever the route is, and for an address it can’t read', async () => {
    const app = Fastify();
    installPolicies(app, { sessions: () => ({ resolve: async () => null }), verifySetupToken: () => false });
    // Outside /api/ too, an admin route has to declare a scope the server knows.
    const undeclared = { kind: 'admin', area: 'people' } as unknown as Policy;
    expect(() => app.get('/internal/people', { config: { policy: undeclared } }, async () => ({}))).toThrow(
      'has no administration scope',
    );
    const typo = { kind: 'admin', area: 'people', scope: 'organizaton' } as unknown as Policy;
    expect(() => app.get('/internal/typo', { config: { policy: typo } }, async () => ({}))).toThrow(
      'has no administration scope',
    );
    const kind = { kind: 'admins', area: 'people', scope: 'organization' } as unknown as Policy;
    expect(() => app.get('/internal/kind', { config: { policy: kind } }, async () => ({}))).toThrow(
      'doesn’t know',
    );
    await app.close();
    // An over-long address parameter is refused before the handler, never skipped.
    for (const url of [
      `/api/org/units/${'y'.repeat(150)}/admins`,
      `/api/org/units/${'y'.repeat(101)}/policy`,
      `/api/sources/${'s'.repeat(150)}/webhook-deliveries`,
      `/api/admin/mfa/people/${'u'.repeat(150)}`,
    ]) {
      const method = url.includes('/mfa/') ? 'DELETE' : 'GET';
      expect(await status(admin, method, url), url).toBe(403);
    }
  });
});

describe('Unit boundaries', () => {
  it('keeps people, admins, settings, and audit entries outside the subtree out of reach', async () => {
    expect(await status(admin, 'GET', `/api/org/units/${operations.id}/admins`)).toBe(403);
    expect(await status(admin, 'GET', `/api/org/units/${operations.id}/policy`)).toBe(403);
    expect(await status(admin, 'GET', '/api/admin/unit-policy')).toBe(403);
    expect(
      await status(admin, 'PUT', `/api/org/members/${outside.userId}/unit`, { unitId: research.id }),
    ).toBe(403);
    // Someone placed directly in the organization is outside every unit.
    expect(
      await status(admin, 'PUT', `/api/org/members/${unplaced.userId}/unit`, { unitId: research.id }),
    ).toBe(403);
    // Nobody inside can be sent outside, or up to the organization itself.
    expect(
      await status(admin, 'PUT', `/api/org/members/${inside.userId}/unit`, { unitId: operations.id }),
    ).toBe(403);
    expect(await status(admin, 'PUT', `/api/org/members/${inside.userId}/unit`, { unitId: null })).toBe(403);
    expect(await status(admin, 'DELETE', `/api/admin/mfa/people/${outside.userId}`)).toBe(403);
    expect(await status(admin, 'DELETE', `/api/admin/mfa/people/${server.owner.userId}`)).toBe(403);
    const audit = await ok<UnitAuditEntry[]>(admin, 'GET', '/api/org/unit-audit');
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(operations.id);
    const everything = await ok<UnitAuditEntry[]>(server.owner, 'GET', '/api/org/unit-audit');
    expect(JSON.stringify(everything)).toContain(operations.id);
    expect(everything.length).toBeGreaterThan(audit.length);
    // Someone with no admin role sees none of it.
    expect(await status(inside, 'GET', '/api/org/unit-audit')).toBe(403);
    expect(await status(inside, 'GET', `/api/org/units/${materials.id}/policy`)).toBe(403);
  });

  it('lets a unit admin act inside their subtree', async () => {
    await ok(admin, 'PUT', `/api/org/members/${inside.userId}/unit`, { unitId: research.id });
    expect(await unitOf(inside)).toBe(research.id);
    await ok(admin, 'PUT', `/api/org/members/${inside.userId}/unit`, { unitId: materials.id });
    expect(await unitOf(inside)).toBe(materials.id);
    const sub = await createUnit('Polymers', materials.id, admin);
    expect(sub.parentId).toBe(materials.id);
    await ok(admin, 'PUT', `/api/org/units/${sub.id}`, { name: 'Polymer lab', parentId: materials.id });
    await ok(admin, 'DELETE', `/api/org/units/${sub.id}`, undefined, 204);
    expect(await status(admin, 'DELETE', `/api/admin/mfa/people/${inside.userId}`)).toBe(204);
    const moves = (await ok<UnitAuditEntry[]>(admin, 'GET', '/api/org/unit-audit')).filter(
      (entry) => entry.action === 'org.unit.person_moved' && entry.metadata.userId === inside.userId,
    );
    expect(moves[0]?.metadata).toMatchObject({
      before: { unitId: research.id },
      after: { unitId: materials.id },
    });
    const reset = (await ok<UnitAuditEntry[]>(admin, 'GET', '/api/org/unit-audit')).find(
      (entry) => entry.action === 'org.second_step.reset',
    );
    expect(reset?.metadata).toMatchObject({ unitId: materials.id, userId: inside.userId });
  });

  it('keeps top-level units, each unit itself, and the owner for those above them', async () => {
    expect(await status(admin, 'POST', '/api/org/units', { name: 'Elsewhere', parentId: null })).toBe(403);
    // Renaming, moving, or deleting a unit is for someone above it.
    expect(
      await status(admin, 'PUT', `/api/org/units/${research.id}`, { name: 'Renamed', parentId: null }),
    ).toBe(403);
    expect(await status(admin, 'DELETE', `/api/org/units/${research.id}`)).toBe(403);
    expect(
      await status(admin, 'PUT', `/api/org/units/${materials.id}`, {
        name: 'Materials',
        parentId: operations.id,
      }),
    ).toBe(403);
    const owner = await call(server.owner, 'PUT', `/api/org/members/${server.owner.userId}/unit`, {
      unitId: research.id,
    });
    expect(owner.statusCode).toBe(409);
    expect(owner.body).toContain('orgUnits.ownerPlacement');
  });

  it('refuses self administration, peers, and roles the admin does not hold above the unit', async () => {
    // Nobody changes the admins of their own unit.
    expect(
      await status(admin, 'PUT', `/api/org/units/${research.id}/admins/${admin.userId}`, { roles: [] }),
    ).toBe(403);
    expect(
      await status(lead, 'PUT', `/api/org/units/${materials.id}/admins/${inside.userId}`, {
        roles: ['people'],
      }),
    ).toBe(403);
    // An admin of a unit below can't act on an admin above, even one placed in their unit.
    await place(admin, materials);
    try {
      expect(
        await status(lead, 'PUT', `/api/org/members/${admin.userId}/unit`, { unitId: materials.id }),
      ).toBe(403);
    } finally {
      await place(admin, research);
    }
    // An admin above manages the admins below, with only the roles they hold themselves.
    await grant(research, admin, ['people']);
    try {
      expect(
        await status(admin, 'PUT', `/api/org/units/${materials.id}/admins/${inside.userId}`, {
          roles: ['security'],
        }),
      ).toBe(403);
      // Nor can they take away a role they don't hold.
      await grant(materials, inside, ['security']);
      expect(
        await status(admin, 'PUT', `/api/org/units/${materials.id}/admins/${inside.userId}`, { roles: [] }),
      ).toBe(403);
      await grant(materials, inside, ['people', 'security']);
      await ok(admin, 'PUT', `/api/org/units/${materials.id}/admins/${inside.userId}`, {
        roles: ['security'],
      });
      await grant(materials, inside, []);
      await ok(admin, 'PUT', `/api/org/units/${materials.id}/admins/${inside.userId}`, { roles: ['people'] });
      const admins = await ok<Array<{ userId: string; roles: string[] }>>(
        admin,
        'GET',
        `/api/org/units/${materials.id}/admins`,
      );
      expect(admins).toContainEqual({ userId: inside.userId, roles: ['people'] });
      // A fellow admin of the same unit is out of reach of the other.
      expect(
        await status(lead, 'PUT', `/api/org/members/${inside.userId}/unit`, { unitId: materials.id }),
      ).toBe(403);
      await ok(admin, 'PUT', `/api/org/units/${materials.id}/admins/${inside.userId}`, { roles: [] });
    } finally {
      await grant(research, admin, UNIT_ADMIN_ROLES);
    }
    // Guests administer nothing.
    const guest = await server.addMember({ kind: 'guest', name: 'Visiting researcher' });
    await place(guest, materials);
    expect(
      await status(admin, 'PUT', `/api/org/units/${materials.id}/admins/${guest.userId}`, {
        roles: ['people'],
      }),
    ).toBe(409);
    const changes = (await ok<UnitAuditEntry[]>(server.owner, 'GET', '/api/org/unit-audit')).filter(
      (entry) => entry.action === 'org.unit.admin_changed' && entry.metadata.userId === inside.userId,
    );
    expect(changes[0]?.metadata).toMatchObject({ before: { roles: ['people'] }, after: { roles: [] } });
  });

  it('refuses cycles and a ninth level', async () => {
    const cycle = await call(server.owner, 'PUT', `/api/org/units/${research.id}`, {
      name: 'Research',
      parentId: materials.id,
    });
    expect(cycle.statusCode).toBe(422);
    const made: string[] = [];
    let parentId = materials.id;
    try {
      for (let depth = 3; depth <= 9; depth++) {
        const result = await call(server.owner, 'POST', '/api/org/units', {
          name: `Level ${depth}`,
          parentId,
        });
        expect(result.statusCode, result.body).toBe(depth === 9 ? 422 : 201);
        if (depth < 9) made.unshift((parentId = result.json<OrgUnit>().id));
      }
    } finally {
      for (const id of made) await ok(server.owner, 'DELETE', `/api/org/units/${id}`, undefined, 204);
    }
  });

  it('moves people and child units up to the parent, and ends its admins’ grants, when a unit goes', async () => {
    const lab = await createUnit('Lab', research.id);
    const bench = await createUnit('Bench', lab.id);
    const worker = await server.addMember({ name: 'Lab person' });
    await place(worker, lab);
    await grant(lab, worker, ['people']);
    await ok(admin, 'DELETE', `/api/org/units/${lab.id}`, undefined, 204);
    expect(await unitOf(worker)).toBe(research.id);
    const units = await ok<OrgUnit[]>(server.owner, 'GET', '/api/org/units');
    expect(units.find((unit) => unit.id === bench.id)?.parentId).toBe(research.id);
    expect(units.some((unit) => unit.id === lab.id)).toBe(false);
    const grants = await server.pool.query(`SELECT 1 FROM ${schema}.org_unit_admins WHERE user_id = $1`, [
      worker.userId,
    ]);
    expect(grants.rowCount).toBe(0);
    const deleted = (await ok<UnitAuditEntry[]>(admin, 'GET', '/api/org/unit-audit')).find(
      (entry) =>
        entry.action === 'org.unit.deleted' && (entry.metadata.before as { id: string }).id === lab.id,
    );
    expect(deleted?.metadata).toMatchObject({
      before: { id: lab.id, people: [worker.userId], units: [bench.id], admins: [{ userId: worker.userId }] },
      after: { parentId: research.id },
    });
    await ok(server.owner, 'DELETE', `/api/org/units/${bench.id}`, undefined, 204);
  });

  it('gives no database access, and administers only databases people in the subtree alone own', async () => {
    const owner = await server.addMember({ name: 'Materials database owner' });
    await place(owner, materials);
    const { id } = await createDatabase(owner, 'Materials records');
    // Administering people never opens their work.
    expect([403, 404]).toContain(await status(admin, 'GET', `/api/databases/${id}/schema`));
    const databases = await ok<Array<{ id: string }>>(admin, 'GET', '/api/databases');
    expect(databases.some((database) => database.id === id)).toBe(false);
    await ok(owner, 'PUT', `/api/databases/${id}/grants`, {
      principal: { kind: 'user', id: admin.userId },
      role: 'reader',
    });
    await ok(admin, 'PUT', `/api/databases/${id}/sql/settings`, { roles: ['owner'] });
    // Ownership shared across the unit's boundary gets no unit administration.
    await ok(owner, 'PUT', `/api/databases/${id}/grants`, {
      principal: { kind: 'user', id: outside.userId },
      role: 'owner',
    });
    expect(await status(admin, 'PUT', `/api/databases/${id}/sql/settings`, { roles: ['owner'] })).toBe(403);
    // A reader shares nothing, and a unit admin shares their own work as anyone would, outside too.
    expect(
      await status(admin, 'PUT', `/api/databases/${id}/grants`, {
        principal: { kind: 'user', id: inside.userId },
        role: 'reader',
      }),
    ).toBe(403);
    const own = await createDatabase(admin, 'Research notes');
    await ok(admin, 'PUT', `/api/databases/${own.id}/grants`, {
      principal: { kind: 'user', id: outside.userId },
      role: 'reader',
    });
  });

  it('lets a Data Sources unit admin manage only sources made inside their units', async () => {
    const mine = await createSource('Materials feed', inside);
    const listed = (await ok<Array<{ id: string }>>(admin, 'GET', '/api/sources')).map((source) => source.id);
    expect(listed).toContain(mine);
    expect(listed).not.toContain(outsideSource);
    const others = (await ok<Array<{ id: string }>>(unplaced, 'GET', '/api/sources')).map(
      (source) => source.id,
    );
    expect(others).not.toContain(mine);
    await ok(admin, 'PATCH', `/api/sources/${mine}`, { name: 'Materials feed, renamed' });
    expect(await status(admin, 'PATCH', `/api/sources/${outsideSource}`, { name: 'Taken' })).toBe(403);
    expect(await status(admin, 'DELETE', `/api/sources/${outsideSource}`)).toBe(403);
    await ok(admin, 'DELETE', `/api/sources/${mine}`, undefined, 204);
  });
});

describe('Changes that reach past a unit', () => {
  it('refuses filing a database away from a folder outside the unit', async () => {
    const orgId = server.owner.info.org.id;
    const lead = await server.addMember({ name: 'Folder unit admin' });
    await place(lead, research);
    await grant(research, lead, ['people']);
    const member = await server.addMember({ name: 'Folder unit member' });
    await place(member, research);
    const colleague = await server.addMember({ name: 'Folder outside colleague' });
    await place(colleague, operations);
    const inGroup = newId('group');
    const outGroup = newId('group');
    await server.pool.query(
      `INSERT INTO ${schema}.groups (id, org_id, name) VALUES ($1, $3, 'Research folks'), ($2, $3, 'Operations folks')`,
      [inGroup, outGroup, orgId],
    );
    await server.pool.query(
      `INSERT INTO ${schema}.group_members (org_id, group_id, user_id) VALUES ($1, $2, $3), ($1, $4, $5)`,
      [orgId, inGroup, member.userId, outGroup, colleague.userId],
    );
    const inFolder = newId('folder');
    const outFolder = newId('folder');
    await server.pool.query(
      `INSERT INTO ${schema}.folders (id, org_id, name) VALUES ($1, $3, 'Research folder'), ($2, $3, 'Operations folder')`,
      [inFolder, outFolder, orgId],
    );
    await server.pool.query(
      `INSERT INTO ${schema}.grants (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
       VALUES ($1, 'folder', $2, 'group', $3, 'owner'), ($1, 'folder', $4, 'group', $5, 'owner')`,
      [orgId, inFolder, inGroup, outFolder, outGroup],
    );
    const { id } = await createDatabase(outside, 'Operations filed records');
    await server.pool.query(
      `INSERT INTO ${schema}.folder_databases (org_id, folder_id, database_id) VALUES ($1, $2, $3)`,
      [orgId, outFolder, id],
    );
    await ok(outside, 'PUT', `/api/databases/${id}/grants`, {
      principal: { kind: 'user', id: lead.userId },
      role: 'owner',
    });
    expect(await status(colleague, 'GET', `/api/databases/${id}/schema`)).toBe(200);
    // The folder it would join is theirs, but the one it would leave isn't.
    expect(
      await status(lead, 'PUT', `/api/org/folders/${inFolder}`, { name: 'Research folder', databases: [id] }),
    ).toBe(403);
    const filed = await server.pool.query(
      `SELECT folder_id FROM ${schema}.folder_databases WHERE database_id = $1`,
      [id],
    );
    expect(filed.rows[0]?.folder_id).toBe(outFolder);
    expect(await status(colleague, 'GET', `/api/databases/${id}/schema`)).toBe(200);
  });

  it('takes every role held inside a unit, and whatever set its values, to delete it', async () => {
    const top = await createUnit('Delete top', null);
    const sub = await createUnit('Delete sub', top.id);
    const peopleOnly = await server.addMember({ name: 'Delete people admin' });
    await grant(top, peopleOnly, ['people']);
    const subSecurity = await server.addMember({ name: 'Delete sub security admin' });
    await place(subSecurity, sub);
    await grant(sub, subSecurity, ['security']);
    // A People-only admin above can't take a Security grant away, directly or by deleting the unit.
    expect(
      await status(peopleOnly, 'PUT', `/api/org/units/${sub.id}/admins/${subSecurity.userId}`, { roles: [] }),
    ).toBe(403);
    expect(await status(peopleOnly, 'DELETE', `/api/org/units/${sub.id}`)).toBe(403);
    await grant(sub, subSecurity, []);
    // Nor a security value set on it.
    await ok(server.owner, 'PUT', '/api/admin/unit-policy', { values: {}, overridable: ['publicLinks'] });
    await ok(server.owner, 'PUT', `/api/org/units/${sub.id}/policy`, { publicLinks: false });
    const refused = await call(peopleOnly, 'DELETE', `/api/org/units/${sub.id}`);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain('orgUnits.policy.setAbove');
    // Holding Security above isn't enough for a value the organization set.
    await grant(top, peopleOnly, ['people', 'security']);
    expect(await status(peopleOnly, 'DELETE', `/api/org/units/${sub.id}`)).toBe(403);
    await ok(server.owner, 'PUT', `/api/org/units/${sub.id}/policy`, {});
    await ok(peopleOnly, 'PUT', `/api/org/units/${sub.id}/policy`, { publicLinks: false });
    // Someone the admin couldn't move themselves would move with it.
    const organizationAdmin = await server.addMember({ name: 'Delete organization admin' });
    await server.pool.query(
      `UPDATE ${schema}.memberships SET admin_roles = ARRAY['audit'] WHERE user_id = $1`,
      [organizationAdmin.userId],
    );
    await place(organizationAdmin, sub);
    expect(await status(peopleOnly, 'DELETE', `/api/org/units/${sub.id}`)).toBe(403);
    await place(organizationAdmin, null);
    await ok(peopleOnly, 'DELETE', `/api/org/units/${sub.id}`, undefined, 204);
    await ok(server.owner, 'DELETE', `/api/org/units/${top.id}`, undefined, 204);
  });

  it('takes whatever could remove a value a unit leaves behind, and everyone below it, to move it', async () => {
    const top = await createUnit('Move top', null);
    const strict = await createUnit('Move strict', top.id);
    const loose = await createUnit('Move loose', top.id);
    const team = await createUnit('Move team', strict.id);
    const mover = await server.addMember({ name: 'Move people admin' });
    await grant(top, mover, ['people']);
    await ok(server.owner, 'PUT', '/api/admin/unit-policy', { values: {}, overridable: ['publicLinks'] });
    await ok(server.owner, 'PUT', `/api/org/units/${strict.id}/policy`, { publicLinks: false });
    const move = () =>
      call(mover, 'PUT', `/api/org/units/${team.id}`, { name: 'Move team', parentId: loose.id });
    // Moving the team out from under Strict would drop the organization's value there.
    expect((await move()).statusCode).toBe(403);
    await ok(server.owner, 'PUT', `/api/org/units/${strict.id}/policy`, {});
    const organizationAdmin = await server.addMember({ name: 'Move organization admin' });
    await server.pool.query(
      `UPDATE ${schema}.memberships SET admin_roles = ARRAY['audit'] WHERE user_id = $1`,
      [organizationAdmin.userId],
    );
    await place(organizationAdmin, team);
    expect((await move()).statusCode).toBe(403);
    await place(organizationAdmin, null);
    expect((await move()).statusCode).toBe(200);
    for (const unit of [team, strict, loose, top])
      await ok(server.owner, 'DELETE', `/api/org/units/${unit.id}`, undefined, 204);
  });
});

it('previews a unit parent change and restores it with one guarded undo', async () => {
  const parent = await createUnit('Arrangement parent', null);
  const child = await createUnit('Arrangement child', null);
  const endpoint = `/api/org/units/${child.id}/move`;
  const preview = await call(server.owner, 'POST', endpoint, {
    id: newId('command'),
    parentId: parent.id,
    preview: true,
  });
  expect(preview.statusCode, preview.body).toBe(200);
  const read = () => ok<OrgUnit[]>(server.owner, 'GET', '/api/org/units');
  expect((await read()).find((unit) => unit.id === child.id)?.parentId).toBeNull();
  const id = newId('command');
  await ok(server.owner, 'POST', endpoint, { id, parentId: parent.id });
  expect((await read()).find((unit) => unit.id === child.id)?.parentId).toBe(parent.id);
  await ok(server.owner, 'POST', endpoint, { id: newId('command'), parentId: null, undoOf: id });
  expect((await read()).find((unit) => unit.id === child.id)?.parentId).toBeNull();
  const cycle = await call(server.owner, 'POST', endpoint, {
    id: newId('command'),
    parentId: child.id,
    preview: true,
  });
  expect(cycle.statusCode).toBe(422);
});

it('tells members about a unit move with one notice, and only the guests the move reaches by name', async () => {
  const parent = await createUnit('Notice parent', null);
  const child = await createUnit('Notice child', null);
  const reached = await server.addMember({ kind: 'guest' });
  const elsewhere = await server.addMember({ kind: 'guest' });
  await server.pool.query(`UPDATE ${schema}.memberships SET org_unit_id = $2 WHERE user_id = $1`, [
    reached.userId,
    child.id,
  ]);
  const listener = await server.pool.connect();
  const notices: unknown[] = [];
  const channel = organizationChannel(server.schemas);
  listener.on('notification', (notice) => {
    if (notice.channel === channel && notice.payload) notices.push(JSON.parse(notice.payload));
  });
  try {
    await listener.query(`LISTEN "${channel}"`);
    await ok(server.owner, 'POST', `/api/org/units/${child.id}/move`, {
      id: newId('command'),
      parentId: parent.id,
    });
    // A round trip on the listening connection consumes the committed notifications.
    await listener.query('SELECT 1');
  } finally {
    await listener.query('UNLISTEN *');
    listener.release();
  }
  const orgId = server.owner.info.org.id;
  expect(notices).toHaveLength(2);
  expect(notices).toContainEqual({ orgId, audience: 'members' });
  expect(notices).toContainEqual({ orgId, userId: reached.userId });
  expect(notices).not.toContainEqual(expect.objectContaining({ userId: elsewhere.userId }));
});
