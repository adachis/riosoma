import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import type { TestPostgres } from '@riosoma/testkit';
import { UNIT_ADMIN_ROLES, newId, type OrgUnit, type UnitAuditEntry } from '@riosoma/contracts';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { seal } from '../secrets.js';
import { administrationRoutes, type AdministrationRoute } from '../http/policy.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * The walk over every admin route, as an admin of Research who holds every unit role, against
 * targets outside Research that all exist: another unit, a person there, their database, their
 * source, an app connection they made, a group of theirs, and a folder they own together with the
 * admin, so the admin passes every check but the unit's own.  A missing unit check then shows as
 * a leak, never as a 404 for something that isn't there.
 */
export interface Walk {
  server: ServerFixture;
  admin: SignedIn;
  outside: SignedIn;
  research: OrgUnit;
  materials: OrgUnit;
  operations: OrgUnit;
  /** Every route the walk found wrong, as `METHOD url -> status`, or an empty list */
  run(): Promise<string[]>;
  close(): Promise<void>;
}

export async function startWalk(kit: TestPostgres, prefix: string): Promise<Walk> {
  const server = await startServer(kit, prefix);
  const schema = `"${server.schemas.app}"`;
  const orgId = server.owner.info.org.id;
  const call = (who: SignedIn, method: Method, url: string, payload?: unknown) =>
    server.app.inject({
      method,
      url,
      headers: who.headers,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const ok = async <T>(who: SignedIn, method: Method, url: string, payload?: unknown, status = 200) => {
    const response = await call(who, method, url, payload);
    expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(status);
    return (response.body ? response.json() : undefined) as T;
  };
  const unit = (name: string, parentId: string | null) =>
    ok<OrgUnit>(server.owner, 'POST', '/api/org/units', { name, parentId }, 201);
  const place = (person: SignedIn, target: OrgUnit) =>
    ok(server.owner, 'PUT', `/api/org/members/${person.userId}/unit`, { unitId: target.id });

  const admin = await server.addMember({ name: 'Research admin' });
  const inside = await server.addMember({ name: 'Materials person' });
  const outside = await server.addMember({ name: 'Operations person' });
  const research = await unit('Research', null);
  const materials = await unit('Materials', research.id);
  const operations = await unit('Operations', null);
  await place(admin, research);
  await place(inside, materials);
  await place(outside, operations);
  await ok(server.owner, 'PUT', `/api/org/units/${research.id}/admins/${admin.userId}`, {
    roles: UNIT_ADMIN_ROLES,
  });

  const database = newId('database');
  await ok(outside, 'POST', '/api/databases', {
    id: database,
    name: 'Operations records',
    table: {
      id: newId('table'),
      name: 'Records',
      fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'All records' },
    },
  });
  const source = newId('source');
  await server.pool.query(
    `INSERT INTO ${schema}.sources (id, org_id, name, kind, connection, sealed_secrets, access, created_by)
     VALUES ($1, $2, 'Operations feed', 'file-url', $3::jsonb, $4, 'admins', $5)`,
    [
      source,
      orgId,
      JSON.stringify({ kind: 'file-url', url: `https://files.example.test/${source}.csv`, format: 'csv' }),
      seal(server.config.secretKey, '{}', `source:${source}`),
      outside.userId,
    ],
  );
  // A group of outside people, and a folder the admin owns together with someone outside.
  const group = newId('group');
  const owners = newId('group');
  const folder = newId('folder');
  await server.pool.query(
    `INSERT INTO ${schema}.groups (id, org_id, name) VALUES ($1, $3, 'Operations team'), ($2, $3, 'Shared owners')`,
    [group, owners, orgId],
  );
  await server.pool.query(
    `INSERT INTO ${schema}.group_members (org_id, group_id, user_id) VALUES ($1, $2, $3), ($1, $4, $3), ($1, $4, $5)`,
    [orgId, group, outside.userId, owners, admin.userId],
  );
  await server.pool.query(`INSERT INTO ${schema}.folders (id, org_id, name) VALUES ($1, $2, 'Operations')`, [
    folder,
    orgId,
  ]);
  await server.pool.query(
    `INSERT INTO ${schema}.grants (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
     VALUES ($1, 'folder', $2, 'group', $3, 'owner')`,
    [orgId, folder, owners],
  );
  // An app connection the outside person made.
  const client = randomBytes(16).toString('hex');
  const consent = randomBytes(16).toString('hex');
  await server.pool.query(
    `INSERT INTO ${schema}.oauth_clients (id, org_id, name, icon, homepage, redirect_uris, scopes, verified)
     VALUES ($1, $2, 'Walk app', '', 'https://app.example.test', ARRAY['https://app.example.test/back'],
       ARRAY['data.records:read'], true)`,
    [client, orgId],
  );
  await server.pool.query(
    `INSERT INTO ${schema}.oauth_consents (id, client_id, org_id, user_id, scopes)
     VALUES ($1, $2, $3, $4, ARRAY['data.records:read'])`,
    [consent, client, orgId, outside.userId],
  );

  const targets: Record<string, string> = {
    unitId: operations.id,
    userId: outside.userId,
    databaseId: database,
    folderId: folder,
    sourceId: source,
    groupId: group,
    id: consent,
  };
  const lists: Record<string, (body: unknown) => boolean> = {
    'GET /api/org/folders': (body) => !(body as Array<{ id: string }>).some((item) => item.id === folder),
    'GET /api/admin/oauth/grants': (body) =>
      !JSON.stringify(body).includes(outside.userId) && !JSON.stringify(body).includes(consent),
    'GET /api/org/unit-audit': (body) =>
      (body as UnitAuditEntry[]).length > 0 &&
      (body as UnitAuditEntry[]).every((entry) => {
        const named = [entry.metadata.unitId, ...((entry.metadata.unitIds as string[] | undefined) ?? [])];
        return (
          named.some((id) => id === research.id || id === materials.id) &&
          !JSON.stringify(entry).includes(operations.id)
        );
      }),
  };
  const payload = (route: AdministrationRoute): Record<string, unknown> | undefined => {
    if (route.method === 'GET' || route.method === 'DELETE') return undefined;
    if (route.url === '/api/org/units') return { name: 'Outside', parentId: operations.id };
    if (route.url === '/api/org/units/:unitId') return { name: 'Outside', parentId: research.id };
    if (route.url === '/api/org/folders/:folderId/grants') return { groupId: group, role: 'reader' };
    if (route.url.startsWith('/api/org/folders')) return { name: 'Outside', databases: [] };
    if (route.url.endsWith('/preview')) return { preset: 'strict' };
    if (route.url.endsWith('/unit')) return { unitId: research.id };
    if (route.url.includes('/admins/')) return { roles: ['people'] };
    if (route.url.endsWith('/policy')) return { publicLinks: false };
    return {};
  };

  async function run(): Promise<string[]> {
    const wrong: string[] = [];
    const walked = new Set<string>();
    // A new source belongs to whoever makes it, so the admin tries to make one from outside.
    await server.pool.query(`UPDATE ${schema}.memberships SET org_unit_id = $1 WHERE user_id = $2`, [
      operations.id,
      admin.userId,
    ]);
    try {
      for (const route of administrationRoutes(server.app)) {
        if (route.method === 'HEAD') continue;
        const key = `${route.method} ${route.url}`;
        walked.add(key);
        const url = route.url.replace(/:([A-Za-z]+)/g, (_match, name: string) => targets[name] ?? 'outside');
        const response = await call(admin, route.method as Method, url, payload(route));
        const check = lists[key];
        if (check) {
          if (response.statusCode !== 200 || !check(response.json()))
            wrong.push(`${key} -> ${response.statusCode} (list)`);
        } else if (response.statusCode !== 403)
          wrong.push(`${key} -> ${response.statusCode} ${response.body.slice(0, 120)}`);
      }
    } finally {
      await server.pool.query(`UPDATE ${schema}.memberships SET org_unit_id = $1 WHERE user_id = $2`, [
        research.id,
        admin.userId,
      ]);
    }
    for (const list of Object.keys(lists)) if (!walked.has(list)) wrong.push(`${list} was never walked`);
    return wrong;
  }

  return {
    server,
    admin,
    outside,
    research,
    materials,
    operations,
    run,
    close: () => server.close(),
  };
}
