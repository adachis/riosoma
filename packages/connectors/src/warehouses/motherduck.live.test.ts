/**
 * MotherDuck against a real database.  It runs only when these are set, and skips otherwise:
 *
 * - `RIOSOMA_TEST_MOTHERDUCK_TOKEN`, an access token
 * - `RIOSOMA_TEST_MOTHERDUCK_DATABASE`, a database that token may create and drop tables in
 *
 * The suite creates a table with every type, reads it through the connector (in SaaS mode, as
 * Riosoma always connects), and drops it.
 */
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { SourceSelect } from '@riosoma/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectorContext, SourceRow } from '../types.js';
import { motherDuckConnector } from './motherduck.js';

const token = process.env.RIOSOMA_TEST_MOTHERDUCK_TOKEN || undefined;
const database = process.env.RIOSOMA_TEST_MOTHERDUCK_DATABASE || undefined;

describe.skipIf(!token || !database)('motherduck against a real database', () => {
  const ctx: ConnectorContext = {
    connection: { kind: 'motherduck', database: database ?? '' },
    secrets: { token: token ?? '' },
    timeoutMs: 120_000,
  };
  // A mixed-case name with a space and a quote, so every path through the connector has to quote it.
  const table = `Rio "Sample" ${Math.random().toString(36).slice(2, 8)}`;
  const quoted = `main."${table.replaceAll('"', '""')}"`;
  const select: SourceSelect = { kind: 'object', object: { schema: 'main', name: table } };
  let instance: DuckDBInstance | undefined;
  let admin: DuckDBConnection | undefined;

  beforeAll(async () => {
    instance = await DuckDBInstance.create(
      `md:${database ?? ''}?motherduck_token=${encodeURIComponent(token ?? '')}`,
    );
    admin = await instance.connect();
    await admin.run(`CREATE TABLE ${quoted}(
      id BIGINT NOT NULL, part SMALLINT NOT NULL, label VARCHAR, amount DECIMAL(30,4), huge HUGEINT,
      ratio DOUBLE, flag BOOLEAN, day DATE, stamp TIMESTAMP, zoned TIMESTAMPTZ, clock TIME, note VARCHAR,
      doc JSON, ident UUID, items INTEGER[], shape STRUCT(x INTEGER, y VARCHAR), lookup MAP(VARCHAR, INTEGER),
      raw BLOB, span INTERVAL, PRIMARY KEY (id, part), UNIQUE (label))`);
    await admin.run(`INSERT INTO ${quoted}
      SELECT 9007199254740993 + i, i, 'row ' || i, 12345678901234567890.1200::DECIMAL(30,4),
        170141183460469231731687303715884105727, 1.25, true, DATE '2026-02-03', TIMESTAMP '2026-02-03 04:05:06',
        TIMESTAMPTZ '2026-02-03 04:05:06+02', TIME '12:34:56', 'plain text', '{"hello":[1,2]}'::JSON,
        '2e2a7a54-2b0e-4a1c-9d7f-0d3f0a2b1c9d'::UUID, [1, 2], {'x': 1, 'y': 'z'}, map{'k': 7}, 'abc'::BLOB,
        INTERVAL 3 DAY
      FROM range(13) AS t(i)`);
  }, 300_000);

  afterAll(async () => {
    await admin?.run(`DROP TABLE IF EXISTS ${quoted}`).catch(() => undefined);
    admin?.disconnectSync();
    instance?.closeSync();
  }, 120_000);

  it('signs in and queries, with MotherDuck choosing its own endpoint', async () => {
    const result = await motherDuckConnector.test(ctx);
    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'skipped'],
      ['connect', 'skipped'],
      ['tls', 'skipped'],
      ['authenticate', 'ok'],
      ['query', 'ok'],
    ]);
    expect(result.serverVersion).toMatch(/^DuckDB /);
  }, 120_000);

  it('lists the table with its estimate', async () => {
    const objects = await motherDuckConnector.listObjects(ctx);
    expect(objects.find((object) => object.schema === 'main' && object.name === table)).toMatchObject({
      type: 'table',
    });
  }, 120_000);

  it('describes every type as the SQL connectors map it', async () => {
    const columns = new Map(
      (await motherDuckConnector.describe(ctx, select)).map((column) => [column.name, column]),
    );
    expect(columns.get('id')).toMatchObject({
      nullable: false,
      suggested: { type: 'number', options: { precision: 0 } },
    });
    expect(columns.get('amount')?.suggested).toEqual({ type: 'number', options: { precision: 4 } });
    expect(columns.get('ratio')?.suggested).toEqual({ type: 'number', options: { precision: null } });
    expect(columns.get('flag')?.suggested?.type).toBe('checkbox');
    expect(columns.get('day')?.suggested).toEqual({ type: 'date', options: {} });
    for (const name of ['stamp', 'zoned'])
      expect(columns.get(name)?.suggested).toEqual({
        type: 'date',
        options: { includeTime: true, timeZone: 'UTC' },
      });
    for (const name of ['doc', 'items', 'shape', 'lookup'])
      expect(columns.get(name)?.suggested?.type).toBe('longText');
    expect(columns.get('ident')?.suggested?.type).toBe('text');
    expect(columns.get('raw')?.suggested).toBeNull();
    expect(columns.get('span')?.suggested).toBeNull();
  }, 120_000);

  it('previews converted values, and a query through the guard', async () => {
    const preview = await motherDuckConnector.preview(ctx, select, 3);
    expect(preview.rows).toHaveLength(3);
    const row = Object.fromEntries(
      preview.columns.map((column, index) => [column.name, preview.rows[0]?.[index]]),
    );
    expect(row).toMatchObject({
      flag: true,
      day: '2026-02-03',
      stamp: '2026-02-03T04:05:06.000Z',
      zoned: '2026-02-03T02:05:06.000Z',
      clock: '12:34:56',
      doc: '{"hello":[1,2]}',
      items: '[1,2]',
      shape: '{"x":1,"y":"z"}',
      lookup: '{"k":7}',
      raw: null,
      span: null,
    });
    const queried = await motherDuckConnector.preview(
      ctx,
      { kind: 'query', sql: `SELECT part FROM ${quoted} WHERE part < 2` },
      5,
    );
    expect(queried.rows).toHaveLength(2);
    await expect(
      motherDuckConnector.preview(ctx, { kind: 'query', sql: `SELECT 1; DROP TABLE ${quoted}` }, 1),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
  }, 120_000);

  it('gives the primary key, then the unique key', async () => {
    expect(await motherDuckConnector.keyCandidates(ctx, { schema: 'main', name: table })).toEqual([
      ['id', 'part'],
      ['label'],
    ]);
  }, 120_000);

  it('reads every row in batches, with exact keys', async () => {
    const batches: SourceRow[][] = [];
    for await (const batch of motherDuckConnector.read(ctx, select, {
      columns: ['label', 'amount', 'huge'],
      types: { label: 'text', amount: 'text', huge: 'text' },
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
      huge: '170141183460469231731687303715884105727',
    });
  }, 120_000);
});
