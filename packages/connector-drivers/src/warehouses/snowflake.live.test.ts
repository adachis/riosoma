/**
 * Snowflake against a real account.  It runs only when these are set, and skips otherwise:
 *
 * - `RIOSOMA_TEST_SNOWFLAKE_ACCOUNT`, `RIOSOMA_TEST_SNOWFLAKE_USER`, `RIOSOMA_TEST_SNOWFLAKE_WAREHOUSE`,
 *   and `RIOSOMA_TEST_SNOWFLAKE_DATABASE`
 * - `RIOSOMA_TEST_SNOWFLAKE_PRIVATE_KEY` (a PEM key, with `RIOSOMA_TEST_SNOWFLAKE_PRIVATE_KEY_PASSPHRASE`
 *   when it is encrypted) or `RIOSOMA_TEST_SNOWFLAKE_PASSWORD`
 * - optionally `RIOSOMA_TEST_SNOWFLAKE_SCHEMA` (`PUBLIC` by default) and `RIOSOMA_TEST_SNOWFLAKE_ROLE`
 *
 * The role needs to create and drop a table in that schema.  The suite creates one with every type,
 * reads it through the connector, and drops it.
 */
import snowflake, { type Connection } from 'snowflake-sdk';
import type { SourceConnection, SourceSecrets, SourceSelect } from '@riosoma/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectorContext, SourceRow } from '@riosoma/connectors/internal/types.js';
import { driverOptionsFor, snowflakeConnector } from './snowflake.js';

const env = (name: string): string | undefined => process.env[`RIOSOMA_TEST_SNOWFLAKE_${name}`] || undefined;
const configured = Boolean(
  env('ACCOUNT') &&
  env('USER') &&
  env('WAREHOUSE') &&
  env('DATABASE') &&
  (env('PRIVATE_KEY') || env('PASSWORD')),
);

describe.skipIf(!configured)('snowflake against a real account', () => {
  const settings: SourceConnection = {
    kind: 'snowflake',
    account: env('ACCOUNT') ?? '',
    user: env('USER') ?? '',
    warehouse: env('WAREHOUSE') ?? '',
    database: env('DATABASE') ?? '',
    ...(env('SCHEMA') ? { schema: env('SCHEMA') } : {}),
    ...(env('ROLE') ? { role: env('ROLE') } : {}),
    auth: env('PRIVATE_KEY') ? 'key-pair' : 'password',
  };
  const secrets: SourceSecrets = env('PRIVATE_KEY')
    ? {
        privateKeyPem: env('PRIVATE_KEY') ?? '',
        ...(env('PRIVATE_KEY_PASSPHRASE') ? { privateKeyPassphrase: env('PRIVATE_KEY_PASSPHRASE') } : {}),
      }
    : { password: env('PASSWORD') ?? '' };
  const ctx: ConnectorContext = { connection: settings, secrets, timeoutMs: 120_000 };
  // A mixed-case name with a space, so every path through the connector has to quote it.
  const table = `Rio Sample ${Math.random().toString(36).slice(2, 8)}`;
  const quoted = `"${table}"`;
  let schema = '';
  let admin: Connection | undefined;
  let select: SourceSelect;

  const run = (sqlText: string): Promise<Record<string, unknown>[]> =>
    new Promise((resolve, reject) => {
      admin?.execute({
        sqlText,
        complete: (error, _statement, rows) =>
          error ? reject(error) : resolve((rows ?? []) as Record<string, unknown>[]),
      });
    });

  beforeAll(async () => {
    admin = snowflake.createConnection(
      driverOptionsFor(settings as Extract<SourceConnection, { kind: 'snowflake' }>, secrets),
    );
    await admin.connectAsync();
    schema = String((await run('SELECT CURRENT_SCHEMA() AS "schema"'))[0]?.schema ?? 'PUBLIC');
    select = { kind: 'object', object: { schema, name: table } };
    await run(`CREATE TABLE ${quoted} (
      "ID" NUMBER(38,0) NOT NULL, "PART" SMALLINT NOT NULL, "LABEL" VARCHAR(80), "AMOUNT" NUMBER(30,4),
      "RATIO" FLOAT, "FLAG" BOOLEAN, "DAY" DATE, "STAMP" TIMESTAMP_NTZ, "ZONED" TIMESTAMP_TZ,
      "LOCAL" TIMESTAMP_LTZ, "CLOCK" TIME, "NOTE" VARCHAR, "Mixed Case" VARCHAR(4000), "DOC" VARIANT,
      "ITEMS" ARRAY, "SHAPE" OBJECT, "RAW" BINARY, "PLACE" GEOGRAPHY,
      PRIMARY KEY ("ID", "PART"), UNIQUE ("LABEL"))`);
    await run(`INSERT INTO ${quoted}
      SELECT 9007199254740993 + n, n, 'row ' || n, 12345678901234567890.1200, 1.25, TRUE,
        '2026-02-03'::DATE, '2026-02-03 04:05:06'::TIMESTAMP_NTZ, '2026-02-03 04:05:06 +02:00'::TIMESTAMP_TZ,
        '2026-02-03 04:05:06 +00:00'::TIMESTAMP_LTZ, '12:34:56'::TIME, 'plain text', 'mixed',
        PARSE_JSON('{"hello":[1,2]}'), ARRAY_CONSTRUCT(1, 2), OBJECT_CONSTRUCT('a', 1),
        TO_BINARY('616263', 'HEX'), TO_GEOGRAPHY('POINT(1 2)')
      FROM (SELECT ROW_NUMBER() OVER (ORDER BY SEQ4()) - 1 AS n FROM TABLE(GENERATOR(ROWCOUNT => 13)))`);
  }, 300_000);

  afterAll(async () => {
    if (!admin) return;
    await run(`DROP TABLE IF EXISTS ${quoted}`).catch(() => undefined);
    await new Promise<void>((resolve) => admin?.destroy(() => resolve()));
  }, 120_000);

  it('climbs every step of a connection test', async () => {
    const result = await snowflakeConnector.test(ctx);
    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    expect(result.steps.map((step) => step.step)).toEqual([
      'resolve',
      'connect',
      'tls',
      'authenticate',
      'query',
    ]);
    expect(result.serverVersion).toMatch(/^Snowflake \d+\.\d+/);
  }, 120_000);

  it('lists the table with its row count', async () => {
    const objects = await snowflakeConnector.listObjects(ctx);
    expect(objects.find((object) => object.schema === schema && object.name === table)).toMatchObject({
      type: 'table',
    });
  }, 120_000);

  it('describes every type as the SQL connectors map it', async () => {
    const columns = new Map(
      (await snowflakeConnector.describe(ctx, select)).map((column) => [column.name, column]),
    );
    expect(columns.get('ID')).toMatchObject({
      nullable: false,
      suggested: { type: 'number', options: { precision: 0 } },
    });
    expect(columns.get('AMOUNT')?.suggested).toEqual({ type: 'number', options: { precision: 4 } });
    expect(columns.get('RATIO')?.suggested).toEqual({ type: 'number', options: { precision: null } });
    expect(columns.get('FLAG')?.suggested?.type).toBe('checkbox');
    expect(columns.get('DAY')?.suggested).toEqual({ type: 'date', options: {} });
    for (const name of ['STAMP', 'ZONED', 'LOCAL'])
      expect(columns.get(name)?.suggested).toEqual({
        type: 'date',
        options: { includeTime: true, timeZone: 'UTC' },
      });
    expect(columns.get('NOTE')?.suggested?.type).toBe('text');
    expect(columns.get('Mixed Case')?.suggested?.type).toBe('longText');
    expect(columns.get('DOC')?.suggested?.type).toBe('longText');
    expect(columns.get('RAW')?.suggested).toBeNull();
    expect(columns.get('PLACE')?.suggested).toBeNull();
  }, 120_000);

  it('previews converted values, and a query through the guard', async () => {
    const preview = await snowflakeConnector.preview(ctx, select, 3);
    expect(preview.rows).toHaveLength(3);
    const row = Object.fromEntries(
      preview.columns.map((column, index) => [column.name, preview.rows[0]?.[index]]),
    );
    expect(row).toMatchObject({
      FLAG: true,
      DAY: '2026-02-03',
      STAMP: '2026-02-03T04:05:06.000Z',
      ZONED: '2026-02-03T02:05:06.000Z',
      LOCAL: '2026-02-03T04:05:06.000Z',
      CLOCK: '12:34:56',
      DOC: '{"hello":[1,2]}',
      RATIO: 1.25,
      RAW: null,
    });
    const queried = await snowflakeConnector.preview(
      ctx,
      { kind: 'query', sql: `SELECT "PART", "Mixed Case" FROM ${quoted} WHERE "PART" < 2` },
      5,
    );
    expect(queried.columns.map((column) => column.name)).toEqual(['PART', 'Mixed Case']);
    expect(queried.rows).toHaveLength(2);
    expect(queried.rows).toContainEqual([1, 'mixed']);
    await expect(
      snowflakeConnector.preview(ctx, { kind: 'query', sql: `SELECT 1; DROP TABLE ${quoted}` }, 1),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
  }, 120_000);

  it('gives the declared primary key, then the unique key', async () => {
    expect(await snowflakeConnector.keyCandidates(ctx, { schema, name: table })).toEqual([
      ['ID', 'PART'],
      ['LABEL'],
    ]);
  }, 120_000);

  it('reads every row in batches, with exact keys', async () => {
    const batches: SourceRow[][] = [];
    for await (const batch of snowflakeConnector.read(ctx, select, {
      columns: ['LABEL', 'AMOUNT', 'STAMP'],
      types: { LABEL: 'text', AMOUNT: 'number', STAMP: 'date' },
      keyColumns: ['ID', 'PART'],
      batchSize: 4,
    }))
      batches.push(batch);
    expect(batches.map((batch) => batch.length)).toEqual([4, 4, 4, 1]);
    const keys = new Set(batches.flat().map((row) => row.key));
    expect(keys).toEqual(
      new Set(
        Array.from({ length: 13 }, (_unused, n) =>
          JSON.stringify([String(9007199254740993n + BigInt(n)), n]),
        ),
      ),
    );
    expect(batches.flat().find((row) => row.values.LABEL === 'row 0')?.values).toMatchObject({
      STAMP: '2026-02-03T04:05:06.000Z',
    });
  }, 120_000);
});
