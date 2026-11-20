import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPool, migrate } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { MIGRATIONS } from '../migrations/index.js';

let kit: TestPostgres;

beforeAll(async () => {
  kit = await startTestPostgres();
}, 120_000);

afterAll(async () => {
  await kit?.stop();
});

it('keeps units, placements, and sessions, and clears references into another organization, on upgrade', async () => {
  const database = await kit.createDatabase('unitmigration');
  const schemas = { app: 'unitmig_app', data: 'unitmig_data', audit: 'unitmig_audit' };
  const pool = createPool({ ...database.profile, schemas });
  const app = `"${schemas.app}"`;
  try {
    await migrate(
      pool,
      schemas,
      MIGRATIONS.filter((migration) => migration.id < '0057'),
    );
    await pool.query(`INSERT INTO ${app}.orgs (id, name) VALUES ('o1', 'One'), ('o2', 'Two')`);
    await pool.query(
      `INSERT INTO ${app}.users (id, email) VALUES ('u1', 'u1@example.test'), ('u2', 'u2@example.test')`,
    );
    // Nothing before this migration made these, but an upgrade mustn't stop on one that did.
    await pool.query(`INSERT INTO ${app}.org_units (id, org_id, parent_id, name) VALUES
      ('a', 'o1', NULL, 'A'), ('b', 'o1', 'a', 'B'), ('c', 'o2', 'a', 'C')`);
    await pool.query(`INSERT INTO ${app}.memberships (org_id, user_id, org_unit_id, kind) VALUES
      ('o1', 'u1', 'b', 'member'), ('o2', 'u2', 'a', 'member')`);
    await pool.query(
      `INSERT INTO ${app}.sessions (id, user_id, token_hash, csrf_token, expires_at)
       VALUES ('s1', 'u1', 'h1', 'c1', clock_timestamp() + interval '1 day')`,
    );
    await migrate(pool, schemas, MIGRATIONS);
    const units = await pool.query(`SELECT id, parent_id, policy_levels FROM ${app}.org_units ORDER BY id`);
    expect(units.rows).toEqual([
      { id: 'a', parent_id: null, policy_levels: {} },
      { id: 'b', parent_id: 'a', policy_levels: {} },
      { id: 'c', parent_id: null, policy_levels: {} },
    ]);
    const placements = await pool.query(
      `SELECT user_id, org_unit_id FROM ${app}.memberships ORDER BY user_id`,
    );
    expect(placements.rows).toEqual([
      { user_id: 'u1', org_unit_id: 'b' },
      { user_id: 'u2', org_unit_id: null },
    ]);
    const session = await pool.query(
      `SELECT second_step_verified, sso_verified, sso_provider_id FROM ${app}.sessions WHERE id = 's1'`,
    );
    expect(session.rows[0]).toEqual({
      second_step_verified: false,
      sso_verified: false,
      sso_provider_id: null,
    });
  } finally {
    await pool.end();
    await database.drop();
  }
}, 120_000);
