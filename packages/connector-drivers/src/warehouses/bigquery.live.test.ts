/**
 * BigQuery against a real project.  It runs only when these are set, and skips otherwise:
 *
 * - `RIOSOMA_TEST_BIGQUERY_PROJECT`, the project that runs the queries
 * - `RIOSOMA_TEST_BIGQUERY_CREDENTIALS`, a service account key as JSON
 * - `RIOSOMA_TEST_BIGQUERY_DATASET`, an existing dataset the account may create and drop tables in
 * - optionally `RIOSOMA_TEST_BIGQUERY_LOCATION`, the dataset's location
 *
 * The suite creates a table with every type, reads it through the connector, and drops it.
 */
import { BigQuery } from '@google-cloud/bigquery';
import type { SourceConnection, SourceSelect } from '@riosoma/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectorContext, SourceRow } from '@riosoma/connectors/internal/types.js';
import { bigQueryConnector, credentialsOf } from './bigquery.js';

const env = (name: string): string | undefined => process.env[`RIOSOMA_TEST_BIGQUERY_${name}`] || undefined;
const configured = Boolean(env('PROJECT') && env('CREDENTIALS') && env('DATASET'));

describe.skipIf(!configured)('bigquery against a real project', () => {
  const projectId = env('PROJECT') ?? '';
  const dataset = env('DATASET') ?? '';
  const location = env('LOCATION');
  const settings: SourceConnection = {
    kind: 'bigquery',
    projectId,
    dataset,
    ...(location ? { location } : {}),
  };
  const ctx: ConnectorContext = {
    connection: settings,
    secrets: { serviceAccountJson: env('CREDENTIALS') ?? '' },
    timeoutMs: 120_000,
  };
  const table = `rio_sample_${Math.random().toString(36).slice(2, 8)}`;
  const qualified = `\`${projectId}\`.\`${dataset}\`.\`${table}\``;
  const select: SourceSelect = { kind: 'object', object: { schema: dataset, name: table } };
  let admin: BigQuery | undefined;

  beforeAll(async () => {
    admin = new BigQuery({
      projectId,
      credentials: credentialsOf(env('CREDENTIALS') ?? ''),
      ...(location ? { location } : {}),
    });
    await admin.query(`CREATE TABLE ${qualified} (
      id INT64 NOT NULL, part INT64 NOT NULL, label STRING(80), amount NUMERIC(30,4), huge BIGNUMERIC,
      ratio FLOAT64, flag BOOL, day DATE, local_time DATETIME, stamp TIMESTAMP, clock TIME, note STRING,
      doc JSON, tags ARRAY<STRING>, address STRUCT<city STRING, zip INT64>, raw BYTES, place GEOGRAPHY,
      PRIMARY KEY (id, part) NOT ENFORCED)`);
    await admin.query(`INSERT INTO ${qualified}
      SELECT 9007199254740993 + i, i, CONCAT('row ', CAST(i AS STRING)), NUMERIC '12345678901234567890.12',
        BIGNUMERIC '123456789012345678901234567890.123456789', 1.25, TRUE, DATE '2026-02-03',
        DATETIME '2026-02-03 04:05:06', TIMESTAMP '2026-02-03 04:05:06+02', TIME '12:34:56', 'plain text',
        JSON '{"hello":[1,2]}', ['a', 'b'], STRUCT('Lisbon' AS city, 1000 AS zip), b'abc', ST_GEOGPOINT(1, 2)
      FROM UNNEST(GENERATE_ARRAY(0, 12)) AS i`);
  }, 300_000);

  afterAll(async () => {
    await admin?.query(`DROP TABLE IF EXISTS ${qualified}`).catch(() => undefined);
  }, 120_000);

  it('climbs every step of a connection test', async () => {
    const result = await bigQueryConnector.test(ctx);
    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    expect(result.steps.map((step) => step.step)).toEqual([
      'resolve',
      'connect',
      'tls',
      'authenticate',
      'query',
    ]);
    expect(result.serverVersion).toBe('BigQuery');
  }, 120_000);

  it('lists the table, its dataset first', async () => {
    const objects = await bigQueryConnector.listObjects(ctx);
    expect(objects[0]?.schema).toBe(dataset);
    expect(objects.find((object) => object.schema === dataset && object.name === table)).toMatchObject({
      type: 'table',
    });
  }, 120_000);

  it('describes every type as the SQL connectors map it', async () => {
    const columns = new Map(
      (await bigQueryConnector.describe(ctx, select)).map((column) => [column.name, column]),
    );
    expect(columns.get('id')).toMatchObject({
      nullable: false,
      suggested: { type: 'number', options: { precision: 0 } },
    });
    expect(columns.get('amount')?.suggested).toEqual({ type: 'number', options: { precision: 4 } });
    expect(columns.get('huge')?.suggested).toEqual({ type: 'number', options: { precision: null } });
    expect(columns.get('flag')?.suggested?.type).toBe('checkbox');
    expect(columns.get('day')?.suggested).toEqual({ type: 'date', options: {} });
    for (const name of ['local_time', 'stamp'])
      expect(columns.get(name)?.suggested).toEqual({
        type: 'date',
        options: { includeTime: true, timeZone: 'UTC' },
      });
    for (const name of ['doc', 'tags', 'address'])
      expect(columns.get(name)?.suggested?.type).toBe('longText');
    expect(columns.get('raw')?.suggested).toBeNull();
    expect(columns.get('place')?.suggested).toBeNull();
    const queried = await bigQueryConnector.describe(ctx, {
      kind: 'query',
      sql: `SELECT id, note FROM ${qualified}`,
    });
    expect(queried.map((column) => column.suggested?.type)).toEqual(['number', 'text']);
  }, 120_000);

  it('previews converted values, and a query through the guard', async () => {
    const preview = await bigQueryConnector.preview(ctx, select, 3);
    expect(preview.rows).toHaveLength(3);
    expect(preview.rowEstimate).toBe(13);
    const row = Object.fromEntries(
      preview.columns.map((column, index) => [column.name, preview.rows[0]?.[index]]),
    );
    expect(row).toMatchObject({
      flag: true,
      day: '2026-02-03',
      local_time: '2026-02-03T04:05:06.000Z',
      stamp: '2026-02-03T02:05:06.000Z',
      clock: '12:34:56',
      doc: '{"hello":[1,2]}',
      tags: '["a","b"]',
      address: '{"city":"Lisbon","zip":1000}',
      ratio: 1.25,
      raw: null,
    });
    const queried = await bigQueryConnector.preview(
      ctx,
      { kind: 'query', sql: `SELECT part FROM ${qualified} WHERE part < 2` },
      5,
    );
    expect(queried.rows).toHaveLength(2);
    await expect(
      bigQueryConnector.preview(ctx, { kind: 'query', sql: `SELECT 1; DROP TABLE ${qualified}` }, 1),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
  }, 120_000);

  it('gives the declared primary key', async () => {
    expect(await bigQueryConnector.keyCandidates(ctx, { schema: dataset, name: table })).toEqual([
      ['id', 'part'],
    ]);
  }, 120_000);

  it('reads every row in batches, with exact keys', async () => {
    const batches: SourceRow[][] = [];
    for await (const batch of bigQueryConnector.read(ctx, select, {
      columns: ['label', 'amount', 'huge'],
      types: { label: 'text', amount: 'number', huge: 'text' },
      keyColumns: ['id', 'part'],
      batchSize: 4,
    }))
      batches.push(batch);
    expect(batches.map((batch) => batch.length)).toEqual([4, 4, 4, 1]);
    expect(new Set(batches.flat().map((row) => row.key))).toEqual(
      new Set(
        Array.from({ length: 13 }, (_unused, n) =>
          JSON.stringify([String(9007199254740993n + BigInt(n)), n]),
        ),
      ),
    );
    expect(batches.flat().find((row) => row.values.label === 'row 0')?.values).toMatchObject({
      huge: '123456789012345678901234567890.123456789',
    });
  }, 120_000);
});
