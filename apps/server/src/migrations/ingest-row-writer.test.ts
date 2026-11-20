import { afterAll, beforeAll, expect, it } from 'vitest';
import { createPool, migrate } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { MIGRATIONS } from './index.js';

let kit: TestPostgres;
beforeAll(async () => {
  kit = await startTestPostgres();
});
afterAll(async () => {
  await kit?.stop();
});

it('extends legacy row hashes without changing them and retains the file that created each record', async () => {
  const database = await kit.createDatabase('writerupgrade');
  const pool = createPool(database.profile);
  const app = `"${database.profile.schemas.app}"`;
  try {
    await migrate(
      pool,
      database.profile.schemas,
      MIGRATIONS.filter((migration) => migration.id !== '0139_ingest_row_writer'),
    );
    await pool.query(`INSERT INTO ${app}.orgs (id, name) VALUES ('org', 'Incoming');
      INSERT INTO ${app}.databases (id, org_id, name) VALUES ('database', 'org', 'Incoming');
      INSERT INTO ${app}.tables (id, org_id, database_id, name, primary_field_id, position)
        VALUES ('table', 'org', 'database', 'Incoming', 'field', 0);
      INSERT INTO ${app}.ingest_files (org_id, table_id, id, origin, name, media_type, size_bytes, sha256)
        VALUES ('org', 'table', 'file', 'drop', 'Incoming.csv', 'text/csv', 1, repeat('a', 64));
      INSERT INTO ${app}.ingest_row_state (org_id, table_id, record_id, file_id, identity, hashes)
        VALUES ('org', 'table', 'record', 'file', repeat('b', 64), jsonb_build_object('name', repeat('c', 64)))`);
    expect((await migrate(pool, database.profile.schemas, MIGRATIONS)).applied).toEqual([
      '0139_ingest_row_writer',
    ]);
    const state = await pool.query(`SELECT * FROM ${app}.ingest_row_state`);
    expect(state.rows).toMatchObject([
      {
        file_id: 'file',
        created_by_file_id: 'file',
        identity: 'b'.repeat(64),
        hashes: { name: 'c'.repeat(64) },
        values: {},
        at: {},
        reasons: [],
        history: [],
      },
    ]);
  } finally {
    await pool.end();
    await database.drop();
  }
});
