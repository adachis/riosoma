import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, query, sql, withTransaction } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { relatedDatabaseIds } from './metadata.js';

let kit: TestPostgres;
let database: Awaited<ReturnType<TestPostgres['createDatabase']>>;
let pool: Pool;
const schemas = { app: 'metadata_graph', data: 'metadata_graph_data', audit: 'metadata_graph_audit' };

beforeAll(async () => {
  kit = await startTestPostgres();
  database = await kit.createDatabase('metadata_graph');
  pool = createPool(database.profile);
  await pool.query(`CREATE SCHEMA metadata_graph;
    CREATE TABLE metadata_graph.databases (id text PRIMARY KEY, org_id text, trashed_at timestamptz);
    CREATE TABLE metadata_graph.tables (id text PRIMARY KEY, database_id text, org_id text, trashed_at timestamptz);
    CREATE INDEX tables_database ON metadata_graph.tables (database_id);
    CREATE TABLE metadata_graph.fields (id text PRIMARY KEY, trashed_at timestamptz);
    CREATE TABLE metadata_graph.links (id text PRIMARY KEY, org_id text, left_table_id text,
      right_table_id text, left_field_id text, right_field_id text);
    CREATE INDEX links_left_field ON metadata_graph.links (left_field_id);
    CREATE INDEX links_right_field ON metadata_graph.links (right_field_id);`);
});
afterEach(async () => {
  await pool.query(
    'TRUNCATE metadata_graph.links, metadata_graph.fields, metadata_graph.tables, metadata_graph.databases',
  );
});
afterAll(async () => {
  await pool?.end();
  await database?.drop();
  await kit?.stop();
});

it('follows live relations in both directions without crossing organizations or deleted fields', async () => {
  await pool.query(`INSERT INTO metadata_graph.databases VALUES
    ('a','org',NULL),('b','org',NULL),('c','org',NULL),('d','org',NULL),
    ('foreign','other',NULL),('dead','org',now());
    INSERT INTO metadata_graph.tables VALUES
    ('a1','a','org',NULL),('a2','a','org',NULL),('b1','b','org',NULL),('c1','c','org',NULL),
    ('d1','d','org',NULL),('foreign1','foreign','other',NULL),('dead1','dead','org',NULL);
    INSERT INTO metadata_graph.fields SELECT 'f'||n,NULL FROM generate_series(1,10) n;
    INSERT INTO metadata_graph.fields VALUES ('deleted',now());
    INSERT INTO metadata_graph.links VALUES
    ('ab','org','a2','b1','f1','f2'),('bc','org','b1','c1','f3',NULL),
    ('ca','org','c1','a1','f4','f5'),('outside','org','b1','foreign1','f6','f7'),
    ('deleted','org','c1','d1','deleted','f8'),('dead','org','a1','dead1','f9','f10');`);
  expect(await relatedDatabaseIds(pool, schemas, ['a1'])).toEqual(['a', 'b', 'c']);
  expect(await relatedDatabaseIds(pool, schemas, ['c1'])).toEqual(['a', 'b', 'c']);
  expect(await relatedDatabaseIds(pool, schemas, ['foreign1'])).toEqual(['foreign']);
  expect(await relatedDatabaseIds(pool, schemas, [])).toEqual([]);
});

it('resolves an isolated database without multiplying unrelated relation metadata', async () => {
  await pool.query(`INSERT INTO metadata_graph.databases SELECT 'd'||n,'org',NULL FROM generate_series(0,1000) n;
    INSERT INTO metadata_graph.tables SELECT 't'||n,'d'||n,'org',NULL FROM generate_series(0,1000) n;
    INSERT INTO metadata_graph.fields SELECT 'f'||n,NULL FROM generate_series(1,2000) n;
    INSERT INTO metadata_graph.links SELECT 'l'||n,'org','t'||n,'t'||(n%1000+1),
      'f'||n,'f'||(n+1000) FROM generate_series(1,1000) n;`);
  await withTransaction(pool, async (db) => {
    await query(db, sql`SET LOCAL statement_timeout = '500ms'`);
    expect(await relatedDatabaseIds(db, schemas, ['t0'])).toEqual(['d0']);
  });
});

it('still resolves trashed starting tables and databases', async () => {
  await pool.query(`INSERT INTO metadata_graph.databases VALUES
    ('live','org',NULL),('dead','org',now());
    INSERT INTO metadata_graph.tables VALUES
    ('live1','live','org',NULL),('trashed','live','org',now()),('dead1','dead','org',NULL);`);
  expect(await relatedDatabaseIds(pool, schemas, ['trashed'])).toEqual(['live']);
  expect(await relatedDatabaseIds(pool, schemas, ['dead1'])).toEqual(['dead']);
  expect(await relatedDatabaseIds(pool, schemas, ['live1', 'trashed', 'dead1'])).toEqual(['dead', 'live']);
});

it('follows a one-way relation backwards and rejects dead endpoints in either direction', async () => {
  await pool.query(`INSERT INTO metadata_graph.databases VALUES
    ('a','org',NULL),('b','org',NULL),('c','org',NULL),('d','org',NULL),('e','org',NULL);
    INSERT INTO metadata_graph.tables VALUES
    ('a1','a','org',NULL),('b1','b','org',NULL),('c1','c','org',now()),
    ('d1','d','org',NULL),('e1','e','org',NULL);
    INSERT INTO metadata_graph.fields VALUES ('live',NULL),('dead',now());
    INSERT INTO metadata_graph.links VALUES
    ('ab','org','a1','b1','live',NULL),('bc','org','b1','c1','live',NULL),
    ('cb','org','c1','b1','live',NULL),('bd','org','b1','d1','live','dead'),
    ('eb','org','e1','b1','dead',NULL);`);
  expect(await relatedDatabaseIds(pool, schemas, ['b1'])).toEqual(['a', 'b']);
  expect(await relatedDatabaseIds(pool, schemas, ['d1'])).toEqual(['d']);
  expect(await relatedDatabaseIds(pool, schemas, ['e1'])).toEqual(['e']);
});
