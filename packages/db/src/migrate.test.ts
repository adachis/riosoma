import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { createPool } from './connection.js';
import { migrate, renderSql, MigrationError, NewerDatabaseError, type Migration } from './migrate.js';

const schemas = { app: 'mig_app', data: 'mig_data', audit: 'mig_audit' };
const first: Migration = { id: '0001_first', sql: 'CREATE TABLE {{app}}.things (id int PRIMARY KEY);' };
const second: Migration = { id: '0002_second', sql: 'ALTER TABLE {{app}}.things ADD COLUMN name text;' };

let kit: TestPostgres;
let db: Awaited<ReturnType<TestPostgres['createDatabase']>>;
let pool: pg.Pool;

beforeAll(async () => {
  kit = await startTestPostgres();
  db = await kit.createDatabase('migrate');
  pool = createPool(db.profile);
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await db?.drop();
  await kit?.stop();
});

describe('migrate', () => {
  it('applies each migration once, in order', async () => {
    const run1 = await migrate(pool, schemas, [second, first]);
    expect(run1.applied).toEqual(['0001_first', '0002_second']);
    const run2 = await migrate(pool, schemas, [first, second]);
    expect(run2).toEqual({ applied: [], alreadyApplied: 2 });
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'mig_app' AND table_name = 'things' ORDER BY 1`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(['id', 'name']);
  });

  it('refuses a migration that changed after it was applied', async () => {
    const edited = { ...first, sql: `${first.sql} -- edited` };
    await expect(migrate(pool, schemas, [edited, second])).rejects.toThrow(/changed after it was applied/);
    await expect(migrate(pool, schemas, [edited, second])).rejects.toMatchObject({
      migrationId: first.id,
      messageKey: 'server.startup.migrationChanged',
    });
  });

  it('applies a migration exactly once when two instances start together', async () => {
    const third: Migration = { id: '0003_third', sql: 'CREATE TABLE {{app}}.more (id int);' };
    const other = createPool(db.profile);
    try {
      const [a, b] = await Promise.all([
        migrate(pool, schemas, [first, second, third]),
        migrate(other, schemas, [first, second, third]),
      ]);
      expect([...a.applied, ...b.applied]).toEqual(['0003_third']);
    } finally {
      await other.end();
    }
  });

  it('rejects duplicate ids and unsafe schema names', async () => {
    await expect(migrate(pool, schemas, [first, first])).rejects.toThrow(/Duplicate/);
    expect(() => renderSql('SELECT 1', { ...schemas, app: 'bad"; DROP' })).toThrow(/Invalid schema name/);
  });
});

it('refuses unknown migrations before applying any older changes', async () => {
  const isolated = { app: 'newer_app', data: 'newer_data', audit: 'newer_audit' };
  const future: Migration = { id: '9999_future', sql: 'SELECT 1' };
  await migrate(pool, isolated, [future]);
  await expect(migrate(pool, isolated, [first, second])).rejects.toBeInstanceOf(NewerDatabaseError);
  await expect(migrate(pool, isolated, [])).rejects.toBeInstanceOf(NewerDatabaseError);
  await expect(migrate(pool, isolated, [])).rejects.toMatchObject({
    migrationId: future.id,
    messageKey: 'server.startup.databaseNewer',
  });
  const result = await pool.query(`SELECT id FROM newer_app.schema_migrations`);
  expect(result.rows).toEqual([{ id: future.id }]);
  expect((await pool.query("SELECT to_regclass('newer_app.things') AS name")).rows[0].name).toBeNull();
  expect(await migrate(pool, isolated, [future])).toEqual({ applied: [], alreadyApplied: 1 });
});

it('names a failed migration statement and rolls back its changes', async () => {
  const isolated = { app: 'failed_app', data: 'failed_data', audit: 'failed_audit' };
  const failed: Migration = {
    id: '0001_failed',
    sql: "CREATE TABLE {{app}}.things (id int); SELECT 'synthetic-secret'::integer;",
  };
  const error = await migrate(pool, isolated, [failed]).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(MigrationError);
  expect(error).toMatchObject({
    migrationId: failed.id,
    messageKey: 'server.startup.migrationStatementFailed',
    cause: { code: '22P02' },
  });
  expect((await pool.query('SELECT id FROM failed_app.schema_migrations')).rows).toEqual([]);
  expect((await pool.query("SELECT to_regclass('failed_app.things') AS name")).rows[0].name).toBeNull();
});
