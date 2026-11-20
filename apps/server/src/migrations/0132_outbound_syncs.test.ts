import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPool, migrate } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { MIGRATIONS } from './index.js';

let kit: TestPostgres;

beforeAll(async () => {
  kit = await startTestPostgres();
}, 120_000);

afterAll(async () => {
  await kit?.stop();
});

/**
 * An outbound sync keeps a map of record to outside row and a history of its runs.  Deleting the
 * view it copies takes the sync, its map, and its runs with it, so a view that is gone for good
 * leaves nothing behind.  The outside table is never touched here.
 */
it('applies the chain and removes a sync, its map, and its runs with its view', async () => {
  const database = await kit.createDatabase('outboundsyncs');
  const schemas = { app: 'osync_app', data: 'osync_data', audit: 'osync_audit' };
  const pool = createPool({ ...database.profile, schemas });
  const app = `"${schemas.app}"`;
  try {
    await migrate(pool, schemas, MIGRATIONS);
    await pool.query(`INSERT INTO ${app}.orgs (id, name) VALUES ('o1', 'One')`);
    await pool.query(`INSERT INTO ${app}.users (id, email) VALUES ('u1', 'dana@example.test')`);
    await pool.query(`INSERT INTO ${app}.databases (id, org_id, name) VALUES ('d1', 'o1', 'Garden')`);
    await pool.query(
      `INSERT INTO ${app}.tables (id, org_id, database_id, name, primary_field_id, position)
       VALUES ('t1', 'o1', 'd1', 'Projects', 'f1', 1)`,
    );
    await pool.query(
      `INSERT INTO ${app}.views (id, org_id, table_id, name, type, position)
       VALUES ('v1', 'o1', 't1', 'Open projects', 'grid', 1)`,
    );
    await pool.query(
      `INSERT INTO ${app}.outbound_syncs
       (id, org_id, database_id, table_id, view_id, created_by, name, kind, destination, settings,
        sealed_credential, status)
       VALUES ('osy00000000000001', 'o1', 'd1', 't1', 'v1', 'u1', 'Projects to Airtable', 'airtable',
        '{"kind":"airtable"}'::jsonb,
        '{"everyMinutes":60,"removeMissing":true,"createColumns":true,"timeZone":"UTC","locale":"en-US"}'::jsonb,
        'sealed', '{"state":"idle"}'::jsonb)`,
    );
    await pool.query(
      `INSERT INTO ${app}.outbound_sync_rows (sync_id, record_id, external_id, sent_hash)
       VALUES ('osy00000000000001', 'rec00000000000001', 'rec_out_1', 'h1')`,
    );
    await pool.query(
      `INSERT INTO ${app}.outbound_sync_runs (id, sync_id, org_id, trigger, outcome)
       VALUES ('job00000000000001', 'osy00000000000001', 'o1', 'setup', 'succeeded')`,
    );

    const count = async (table: string) =>
      Number((await pool.query(`SELECT count(*)::int AS n FROM ${app}.${table}`)).rows[0]!.n);
    expect(await count('outbound_syncs')).toBe(1);
    expect(await count('outbound_sync_rows')).toBe(1);
    expect(await count('outbound_sync_runs')).toBe(1);

    await pool.query(`DELETE FROM ${app}.views WHERE id = 'v1'`);

    expect(await count('outbound_syncs')).toBe(0);
    expect(await count('outbound_sync_rows')).toBe(0);
    expect(await count('outbound_sync_runs')).toBe(0);
  } finally {
    await pool.end();
    await database.drop();
  }
}, 120_000);
