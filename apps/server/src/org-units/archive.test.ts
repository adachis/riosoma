import { afterAll, beforeAll, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { OrgUnit, SessionInfo, UnitPolicyView } from '@riosoma/contracts';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import {
  exportArchive,
  importArchive,
  reviewList,
  target,
} from '../data/organization-archives/organization-archives.test-support.js';

let kit: TestPostgres;
let server: ServerFixture;
let research: OrgUnit;
let materials: OrgUnit;
let lead: SignedIn;

async function ok<T>(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
  expected = 200,
): Promise<T> {
  const response = await server.app.inject({
    method,
    url,
    headers: server.owner.headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(expected);
  return response.json<T>();
}

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'unitarchive');
  research = await ok('POST', '/api/org/units', { name: 'Research', parentId: null }, 201);
  materials = await ok('POST', '/api/org/units', { name: 'Materials', parentId: research.id }, 201);
  lead = await server.addMember({ name: 'Research admin' });
  await ok('PUT', `/api/org/members/${lead.userId}/unit`, { unitId: materials.id });
  await ok('PUT', `/api/org/units/${research.id}/admins/${lead.userId}`, { roles: ['people', 'audit'] });
  await ok('PUT', '/api/admin/unit-policy', {
    values: { publicLinks: false },
    overridable: ['passwordMinLength', 'defaultLocale'],
  });
  await ok('PUT', `/api/org/units/${research.id}/policy`, { passwordMinLength: 16 });
  // A value Research's admin sets below it records Research as the level that set it.
  const set = await server.app.inject({
    method: 'PUT',
    url: `/api/org/units/${materials.id}/policy`,
    headers: lead.headers,
    payload: { defaultLocale: 'fr' },
  });
  expect(set.statusCode, set.body).toBe(200);
}, 120_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

it('carries units, their policies, each person’s unit, and unit admins through an organization archive', async () => {
  const exported = await exportArchive(server, { files: false, audit: false });
  const destination = await target(kit, 'unitrestore');
  try {
    await importArchive(destination.server, exported.bytes);
    const schema = `"${destination.server.schemas.app}"`;
    const restored = await destination.server.pool.query<{
      id: string;
      name: string;
      parent_id: string | null;
      policy_levels: Record<string, string | null>;
    }>(`SELECT id, name, parent_id, policy_levels FROM ${schema}.org_units ORDER BY name`);
    const [restoredMaterials, restoredResearch] = restored.rows;
    expect(restored.rows.map((row) => row.name)).toEqual(['Materials', 'Research']);
    expect(restoredResearch!.id).not.toBe(research.id);
    expect(restoredMaterials!.parent_id).toBe(restoredResearch!.id);
    expect(restoredMaterials!.policy_levels).toEqual({ defaultLocale: restoredResearch!.id });
    const headers = destination.server.owner.headers;
    const policy = await destination.server.app.inject({
      url: `/api/org/units/${restoredMaterials!.id}/policy`,
      headers,
    });
    expect(policy.statusCode, policy.body).toBe(200);
    expect(policy.json<UnitPolicyView>().values).toMatchObject({ passwordMinLength: 16, publicLinks: false });
    expect(policy.json<UnitPolicyView>().origins.passwordMinLength.id).toBe(restoredResearch!.id);
    // The owner who imports stays in the organization itself.
    const owner = await destination.server.app.inject({ url: '/api/auth/session', headers });
    expect(owner.json<SessionInfo>().membership.unitId).toBeNull();
    const pending = (await reviewList(destination.server)).find(
      (item) => item.kind === 'person' && JSON.stringify(item).includes(lead.email),
    );
    expect(pending).toBeDefined();
    const invite = await destination.server.app.inject({
      method: 'POST',
      url: '/api/organization-archives/review/invite',
      headers,
      payload: { ids: [pending!.id] },
    });
    expect(invite.statusCode, invite.body).toBe(200);
    const message = destination.mail.find((mail) => mail.to === lead.email)!;
    const token = /join#token=([A-Za-z0-9_-]+)/.exec(message.text)![1]!;
    const joined = await destination.server.app.inject({
      method: 'POST',
      url: '/api/auth/invitations/accept',
      payload: { token, name: 'Research admin' },
    });
    expect(joined.statusCode, joined.body).toBe(200);
    const person = joined.json<SessionInfo>();
    expect(person.membership.unitId).toBe(restoredMaterials!.id);
    expect(person.membership.unitAdminGrants).toEqual([
      { unitId: restoredResearch!.id, roles: ['audit', 'people'] },
    ]);
    // Organization admin roles never come back through an archive.
    expect(person.membership.adminRoles).toEqual([]);
  } finally {
    await destination.server.close();
  }
}, 120_000);
