import { expect, it } from 'vitest';
import type { OrgUnit } from '@riosoma/contracts';
import { call, server, setup, user, useScimServer, patch } from '../auth/scim/scim.test-helpers.js';
import { ENTERPRISE_SCHEMA, USER_SCHEMA } from '../auth/scim/patch.js';

useScimServer();

const record = (department: string | undefined, overrides: Record<string, unknown> = {}) =>
  user({
    schemas: [USER_SCHEMA, ENTERPRISE_SCHEMA],
    ...(department === undefined ? {} : { [ENTERPRISE_SCHEMA]: { department } }),
    ...overrides,
  });

async function unit(name: string): Promise<OrgUnit> {
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/org/units',
    headers: server.owner.headers,
    payload: { name, parentId: null },
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json<OrgUnit>();
}

const map = (mappings: Array<{ attribute: string; value: string; unitId: string }>) =>
  server.app.inject({
    method: 'PUT',
    url: '/api/admin/scim/unit-mappings',
    headers: server.owner.headers,
    payload: mappings,
  });

async function placement(userId: string): Promise<string | null> {
  const result = await server.pool.query<{ org_unit_id: string | null }>(
    `SELECT org_unit_id FROM "${server.schemas.app}".memberships WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0]!.org_unit_id;
}

it('places provisioned people by a mapped attribute, and in the organization when nothing matches', async () => {
  const token = (await setup()).token;
  const research = await unit('Research');
  const operations = await unit('Operations');
  expect((await map([{ attribute: 'department', value: 'Research', unitId: research.id }])).statusCode).toBe(
    200,
  );
  const created = await call(token, 'POST', 'Users', record('Research'));
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<{ id: string }>().id;
  expect(await placement(id)).toBe(research.id);
  // Directories aren't consistent about case or spaces, so neither is the match.
  expect(
    (
      await map([
        { attribute: 'department', value: 'Research', unitId: research.id },
        { attribute: 'department', value: 'Operations', unitId: operations.id },
      ])
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await call(
        token,
        'PATCH',
        `Users/${id}`,
        patch([{ op: 'replace', path: `${ENTERPRISE_SCHEMA}:department`, value: ' operations ' }]),
      )
    ).statusCode,
  ).toBe(200);
  expect(await placement(id)).toBe(operations.id);
  // A department nobody mapped places the person in the organization, and never stops provisioning.
  const unmapped = await call(token, 'PUT', `Users/${id}`, record('Facilities'));
  expect(unmapped.statusCode, unmapped.body).toBe(200);
  expect(await placement(id)).toBeNull();
  const suspended = await call(token, 'PUT', `Users/${id}`, record(undefined, { active: false }));
  expect(suspended.statusCode, suspended.body).toBe(200);
  expect(await placement(id)).toBeNull();
  const audit = await server.pool.query<{ metadata: Record<string, unknown> }>(
    `SELECT metadata FROM "${server.schemas.audit}".events WHERE action = 'org.unit.person_moved' ORDER BY id`,
  );
  expect(audit.rows.map((row) => row.metadata.after)).toEqual([
    { unitId: research.id },
    { unitId: operations.id },
    { unitId: null },
  ]);
});

it('places everyone provisioned as soon as a mapping is saved, and keeps admins from moving them', async () => {
  const token = (await setup()).token;
  const research = await unit('Research');
  const created = await call(token, 'POST', 'Users', record('Research'));
  const id = created.json<{ id: string }>().id;
  expect(await placement(id)).toBeNull();
  // Before a mapping exists, admins place provisioned people themselves.
  const manual = await server.app.inject({
    method: 'PUT',
    url: `/api/org/members/${id}/unit`,
    headers: server.owner.headers,
    payload: { unitId: null },
  });
  expect(manual.statusCode, manual.body).toBe(200);
  expect((await map([{ attribute: 'department', value: 'research', unitId: research.id }])).statusCode).toBe(
    200,
  );
  expect(await placement(id)).toBe(research.id);
  const refused = await server.app.inject({
    method: 'PUT',
    url: `/api/org/members/${id}/unit`,
    headers: server.owner.headers,
    payload: { unitId: null },
  });
  expect(refused.statusCode).toBe(409);
  expect(refused.body).toContain('orgUnits.scim.managed');
  // Only the department places people, since every directory sends it with each change.
  const division = await map([{ attribute: 'division', value: 'Science', unitId: research.id }]);
  expect(division.statusCode).toBe(422);
  const twice = await map([
    { attribute: 'department', value: 'Research', unitId: research.id },
    { attribute: 'department', value: 'RESEARCH ', unitId: research.id },
  ]);
  expect(twice.statusCode).toBe(422);
  // Removing every mapping hands placement back to admins, and leaves everyone where they are.
  expect((await map([])).statusCode).toBe(200);
  expect(await placement(id)).toBe(research.id);
});
