/**
 * Databricks against a real SQL warehouse on Unity Catalog.  It runs only when these are set, and
 * skips otherwise:
 *
 * - `RIOSOMA_TEST_DATABRICKS_HOST`, the workspace host
 * - `RIOSOMA_TEST_DATABRICKS_HTTP_PATH`, the SQL warehouse's HTTP path
 * - `RIOSOMA_TEST_DATABRICKS_TOKEN`, an access token
 * - optionally `RIOSOMA_TEST_DATABRICKS_CATALOG` (the warehouse's default catalog otherwise) and
 *   `RIOSOMA_TEST_DATABRICKS_SCHEMA` (`default` otherwise)
 *
 * The token needs to create and drop a table in that schema.  The suite creates one with every
 * type, reads it through the connector, and drops it.
 */
import { DBSQLClient } from '@databricks/sql';
import type { SourceConnection, SourceSelect } from '@riosoma/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectorContext, SourceRow } from '@riosoma/connectors/internal/types.js';
import { databricksConnector, httpPathOf, workspaceOf } from './databricks.js';

const env = (name: string): string | undefined => process.env[`RIOSOMA_TEST_DATABRICKS_${name}`] || undefined;
const configured = Boolean(env('HOST') && env('HTTP_PATH') && env('TOKEN'));

describe.skipIf(!configured)('databricks against a real warehouse', () => {
  const schema = env('SCHEMA') ?? 'default';
  const catalog = env('CATALOG');
  const settings: SourceConnection = {
    kind: 'databricks',
    host: env('HOST') ?? '',
    httpPath: env('HTTP_PATH') ?? '',
    ...(catalog ? { catalog } : {}),
    schema,
  };
  const ctx: ConnectorContext = {
    connection: settings,
    secrets: { token: env('TOKEN') ?? '' },
    timeoutMs: 120_000,
  };
  const table = `rio_sample_${Math.random().toString(36).slice(2, 8)}`;
  const select: SourceSelect = { kind: 'object', object: { schema, name: table } };
  let client: DBSQLClient | undefined;
  let qualified = '';
  let run: (sql: string) => Promise<Record<string, unknown>[]> = async () => [];

  beforeAll(async () => {
    const workspace = workspaceOf(settings.host);
    client = new DBSQLClient({ logger: { log: () => undefined } });
    await client.connect({
      host: workspace.host,
      port: workspace.port,
      path: httpPathOf(settings.httpPath),
      token: env('TOKEN') ?? '',
      telemetryEnabled: false,
    });
    const session = await client.openSession(catalog ? { initialCatalog: catalog } : {});
    run = async (sql) => {
      const operation = await session.executeStatement(sql);
      try {
        return (await operation.fetchAll()) as Record<string, unknown>[];
      } finally {
        await operation.close();
      }
    };
    const current = String((await run('SELECT current_catalog() AS catalog'))[0]?.catalog ?? '');
    qualified = `\`${current}\`.\`${schema}\`.\`${table}\``;
    await run(`CREATE TABLE ${qualified} (
      id BIGINT NOT NULL, part SMALLINT NOT NULL, label STRING, amount DECIMAL(30,4), ratio DOUBLE,
      flag BOOLEAN, day DATE, stamp TIMESTAMP, local_time TIMESTAMP_NTZ, note STRING, code VARCHAR(20),
      tags ARRAY<STRING>, address STRUCT<city: STRING, zip: INT>, lookup MAP<STRING, INT>, raw BINARY,
      CONSTRAINT ${table}_pk PRIMARY KEY (id, part))`);
    await run(`INSERT INTO ${qualified}
      SELECT 9007199254740993 + id, CAST(id AS SMALLINT), concat('row ', id),
        CAST('12345678901234567890.1200' AS DECIMAL(30,4)), 1.25, true, DATE'2026-02-03',
        TIMESTAMP'2026-02-03 04:05:06+02:00', TIMESTAMP_NTZ'2026-02-03 04:05:06', 'plain text', 'code',
        array('a', 'b'), named_struct('city', 'Lisbon', 'zip', 1000), map('k', 7), X'616263'
      FROM range(13)`);
  }, 300_000);

  afterAll(async () => {
    if (qualified) await run(`DROP TABLE IF EXISTS ${qualified}`).catch(() => undefined);
    await client?.close().catch(() => undefined);
  }, 120_000);

  it('climbs every step of a connection test', async () => {
    const result = await databricksConnector.test(ctx);
    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    expect(result.steps.map((step) => step.step)).toEqual([
      'resolve',
      'connect',
      'tls',
      'authenticate',
      'query',
    ]);
    expect(result.serverVersion).toMatch(/^Databricks/);
  }, 120_000);

  it('lists the table', async () => {
    const objects = await databricksConnector.listObjects(ctx);
    expect(objects.find((object) => object.schema === schema && object.name === table)).toMatchObject({
      type: 'table',
      rowEstimate: null,
    });
  }, 120_000);

  it('describes every type as the SQL connectors map it', async () => {
    const columns = new Map(
      (await databricksConnector.describe(ctx, select)).map((column) => [column.name, column]),
    );
    expect(columns.get('id')).toMatchObject({
      nullable: false,
      suggested: { type: 'number', options: { precision: 0 } },
    });
    expect(columns.get('amount')?.suggested).toEqual({ type: 'number', options: { precision: 4 } });
    expect(columns.get('ratio')?.suggested).toEqual({ type: 'number', options: { precision: null } });
    expect(columns.get('flag')?.suggested?.type).toBe('checkbox');
    expect(columns.get('day')?.suggested).toEqual({ type: 'date', options: {} });
    for (const name of ['stamp', 'local_time'])
      expect(columns.get(name)?.suggested).toEqual({
        type: 'date',
        options: { includeTime: true, timeZone: 'UTC' },
      });
    for (const name of ['tags', 'address', 'lookup'])
      expect(columns.get(name)?.suggested?.type).toBe('longText');
    expect(columns.get('raw')?.suggested).toBeNull();
    const queried = await databricksConnector.describe(ctx, {
      kind: 'query',
      sql: `SELECT id, note FROM ${qualified}`,
    });
    expect(queried.map((column) => column.suggested?.type)).toEqual(['number', 'text']);
  }, 120_000);

  it('previews converted values, and a query through the guard', async () => {
    const preview = await databricksConnector.preview(ctx, select, 3);
    expect(preview.rows).toHaveLength(3);
    const row = Object.fromEntries(
      preview.columns.map((column, index) => [column.name, preview.rows[0]?.[index]]),
    );
    expect(row).toMatchObject({
      flag: true,
      day: '2026-02-03',
      stamp: '2026-02-03T02:05:06.000Z',
      local_time: '2026-02-03T04:05:06.000Z',
      tags: '["a","b"]',
      address: '{"city":"Lisbon","zip":1000}',
      lookup: '{"k":7}',
      ratio: 1.25,
      raw: null,
    });
    const queried = await databricksConnector.preview(
      ctx,
      { kind: 'query', sql: `SELECT part FROM ${qualified} WHERE part < 2` },
      5,
    );
    expect(queried.rows).toHaveLength(2);
    await expect(
      databricksConnector.preview(ctx, { kind: 'query', sql: `SELECT 1; DROP TABLE ${qualified}` }, 1),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
  }, 120_000);

  it('gives the declared primary key', async () => {
    expect(await databricksConnector.keyCandidates(ctx, { schema, name: table })).toEqual([['id', 'part']]);
  }, 120_000);

  it('reads every row in batches, with exact keys', async () => {
    const batches: SourceRow[][] = [];
    for await (const batch of databricksConnector.read(ctx, select, {
      columns: ['label', 'amount'],
      types: { label: 'text', amount: 'text' },
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
      amount: '12345678901234567890.1200',
    });
  }, 120_000);
});
