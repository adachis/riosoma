/**
 * ClickHouse against a real server.  It runs only when these are set, and skips otherwise:
 *
 * - `RIOSOMA_TEST_CLICKHOUSE_URL`, the HTTP interface as `http://user:password@host:port/database`,
 *   for a user that may create and drop tables and users in that database
 * - optionally `RIOSOMA_TEST_CLICKHOUSE_TLS_URL`, the same server's HTTPS interface, with
 *   `RIOSOMA_TEST_CLICKHOUSE_CA_FILE`, the authority its certificate comes from
 *
 * A local server does it, started with a `wh_open_` name so it's easy to find and remove:
 *
 *     docker run -d --name wh_open_clickhouse -e CLICKHOUSE_DB=analytics -e CLICKHOUSE_USER=rio \
 *       -e CLICKHOUSE_PASSWORD=… -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 -p 127.0.0.1::8123 \
 *       clickhouse/clickhouse-server
 *
 * The suite creates a table with every type, a larger one whose sorting key repeats, and one that
 * replaces rows as it merges, reads them through the connector, also as a read-only user who may
 * change no settings, and drops them.
 */
import { readFileSync } from 'node:fs';
import { createClient, type ClickHouseClient } from '@clickhouse/client';
import type { SourceConnection, SourceSelect } from '@riosoma/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectorContext, SourceRow } from '@riosoma/connectors/internal/types.js';
import { clickHouseConnector, CLICKHOUSE_PAGE_ROWS, createClickHouseConnector } from './clickhouse.js';

const url = process.env.RIOSOMA_TEST_CLICKHOUSE_URL || undefined;
const tlsUrl = process.env.RIOSOMA_TEST_CLICKHOUSE_TLS_URL || undefined;
const caFile = process.env.RIOSOMA_TEST_CLICKHOUSE_CA_FILE || undefined;

/** A connection and its secrets from an address like `http://user:password@host:port/database`. */
function contextOf(address: string, extra: Partial<Extract<SourceConnection, { kind: 'clickhouse' }>> = {}) {
  const parsed = new URL(address);
  const secure = parsed.protocol === 'https:';
  const ctx: ConnectorContext = {
    connection: {
      kind: 'clickhouse',
      host: parsed.hostname,
      port: Number(parsed.port) || (secure ? 8443 : 8123),
      database: decodeURIComponent(parsed.pathname.slice(1)) || 'default',
      user: decodeURIComponent(parsed.username) || 'default',
      secure,
      ...extra,
    },
    secrets: { password: decodeURIComponent(parsed.password) },
    timeoutMs: 120_000,
  };
  return ctx;
}

async function readAll(
  ctx: ConnectorContext,
  select: SourceSelect,
  columns: string[],
  keys: string[],
  connector = clickHouseConnector,
) {
  const batches: SourceRow[][] = [];
  for await (const batch of connector.read(ctx, select, {
    columns,
    types: Object.fromEntries(columns.map((name) => [name, 'text'])),
    keyColumns: keys,
    batchSize: 5_000,
  }))
    batches.push(batch);
  return batches;
}

describe.skipIf(!url)('clickhouse against a real server', () => {
  const ctx = contextOf(url ?? 'http://localhost');
  const settings = ctx.connection as Extract<SourceConnection, { kind: 'clickhouse' }>;
  const suffix = Math.random().toString(36).slice(2, 8);
  // A mixed-case name with a space and a backtick, so every path through the connector has to quote it.
  const table = `Rio \`Sample\` ${suffix}`;
  const large = `rio_pages_${suffix}`;
  const versions = `rio_versions_${suffix}`;
  const reader = `rio_reader_${suffix}`;
  // Built here from parts, so no stand-in reads as a stored secret.
  const readerPassword = ['stand', 'in', suffix, 'Reader9'].join('-');
  const select: SourceSelect = { kind: 'object', object: { schema: settings.database, name: table } };
  const quote = (name: string) => `\`${name.replaceAll('`', '``')}\``;
  const qualified = `${quote(settings.database)}.${quote(table)}`;
  let admin: ClickHouseClient | undefined;
  const run = async (sql: string) => {
    await admin!.command({ query: sql });
  };

  beforeAll(async () => {
    const parsed = new URL(url ?? 'http://localhost');
    admin = createClient({
      url: `${parsed.protocol}//${parsed.host}`,
      username: settings.user,
      password: ctx.secrets.password ?? '',
      database: settings.database,
    });
    await run(`CREATE TABLE ${qualified} (
      id UInt64, part Int16, label String, amount Decimal(30, 4), huge Int128, ratio Float64, flag Bool,
      day Date, day32 Date32, stamp DateTime('Europe/Lisbon'), precise DateTime64(3, 'America/New_York'),
      fine DateTime64(6), note Nullable(String), code FixedString(4), tag LowCardinality(String),
      maybe LowCardinality(Nullable(String)), ident UUID, ip4 IPv4, ip6 IPv6,
      mood Enum8('happy' = 1, 'it''s fine' = 2), tags Array(String), attrs Map(String, Int32),
      pair Tuple(city String, zip Int32), small UInt8, odd Nullable(Float32), spot Point
    ) ENGINE = MergeTree ORDER BY (part, id)`);
    await run(`INSERT INTO ${qualified}
      SELECT 9007199254740993 + number, toInt16(number), concat('row ', toString(number)),
        toDecimal128('12345678901234567890.1200', 4), toInt128('170141183460469231731687303715884105727'),
        1.25, true, toDate('2026-02-03'), toDate32('1901-02-03'), toDateTime('2026-02-03 04:05:06', 'Europe/Lisbon'),
        toDateTime64('2026-02-03 04:05:06.789', 3, 'America/New_York'), toDateTime64('2026-02-03 04:05:06.123456', 6, 'UTC'),
        if(number = 0, NULL, 'a note'), 'ab', 'green', if(number = 1, NULL, 'blue'),
        toUUID('2e2a7a54-2b0e-4a1c-9d7f-0d3f0a2b1c9d'), toIPv4('10.1.2.3'), toIPv6('2001:db8::1'),
        if(number = 2, 'it''s fine', 'happy'), ['a', 'b'], map('k', 7), tuple('Lisbon', 1000), 200,
        if(number = 3, nan, 0.5), (1.5, 2.5)
      FROM numbers(13)`);
    // More rows than a page, whose sorting key repeats, so paging has to keep ties in one order.
    await run(`CREATE TABLE ${quote(settings.database)}.${quote(large)} (bucket UInt8, id UInt32, word String)
      ENGINE = MergeTree ORDER BY bucket`);
    await run(`INSERT INTO ${quote(settings.database)}.${quote(large)}
      SELECT number % 3, number, concat('w', toString(number), if(number % 997 = 0, '\\t''\\\\ \\n', ''))
      FROM numbers(${CLICKHOUSE_PAGE_ROWS * 2 + 7})`);
    // A read-only user may change no settings at all, which is how many analytics logins are set up.
    await run(
      `CREATE USER ${quote(reader)} IDENTIFIED WITH sha256_password BY '${readerPassword}' SETTINGS readonly = 1`,
    );
    await run(`GRANT SELECT, SHOW ON ${quote(settings.database)}.* TO ${quote(reader)}`);
  }, 300_000);

  afterAll(async () => {
    for (const sql of [
      `DROP TABLE IF EXISTS ${qualified}`,
      `DROP TABLE IF EXISTS ${quote(settings.database)}.${quote(large)}`,
      `DROP TABLE IF EXISTS ${quote(settings.database)}.${quote(versions)}`,
      `DROP USER IF EXISTS ${quote(reader)}`,
    ])
      await run(sql).catch(() => undefined);
    await admin?.close();
  }, 120_000);

  it('climbs every step of a connection test, and skips TLS on a plain connection', async () => {
    const result = await clickHouseConnector.test(ctx);
    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'skipped'],
      ['authenticate', 'ok'],
      ['query', 'ok'],
    ]);
    expect(result.serverVersion).toMatch(/^ClickHouse \d+\./);
  }, 120_000);

  it.skipIf(!tlsUrl || !caFile)(
    'trusts a private authority over HTTPS, and only when told to',
    async () => {
      const secure = contextOf(tlsUrl ?? 'https://localhost', { caPem: readFileSync(caFile ?? '', 'utf8') });
      const result = await clickHouseConnector.test(secure);
      expect(result.ok, JSON.stringify(result.steps)).toBe(true);
      expect(result.steps.map((step) => step.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
      const preview = await clickHouseConnector.preview(secure, select, 1);
      expect(preview.rows).toHaveLength(1);
      const untrusted = contextOf(tlsUrl ?? 'https://localhost');
      const refused = await clickHouseConnector.test(untrusted);
      expect(refused.steps.at(-1)).toMatchObject({
        step: 'tls',
        status: 'failed',
        messageKey: 'sources.test.tls',
      });
    },
    120_000,
  );

  it('says which step failed for a wrong password, a closed port, and a database it can’t use', async () => {
    const wrong = await clickHouseConnector.test({
      ...ctx,
      secrets: { password: `${readerPassword}-wrong` },
    });
    expect(wrong.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      status: 'failed',
      messageKey: 'sources.test.authenticate',
    });
    expect(wrong.steps.at(-1)?.detail).not.toContain(readerPassword);
    const closed = await clickHouseConnector.test({ ...ctx, connection: { ...settings, port: 1 } });
    expect(closed.steps.at(-1)).toMatchObject({ step: 'connect', messageKey: 'sources.test.connect' });
    const elsewhere = await clickHouseConnector.test({
      ...ctx,
      connection: { ...settings, database: `missing_${suffix}` },
    });
    expect(elsewhere.steps.at(-1)).toMatchObject({ step: 'query', messageKey: 'sources.test.query' });
    expect(elsewhere.steps.map((step) => step.step)).toContain('authenticate');
  }, 120_000);

  it('lists the tables with their row counts, the connection’s database first', async () => {
    const objects = await clickHouseConnector.listObjects(ctx);
    expect(objects[0]?.schema).toBe(settings.database);
    expect(objects.find((object) => object.name === table)).toMatchObject({
      schema: settings.database,
      type: 'table',
      rowEstimate: 13,
    });
    expect(objects.some((object) => object.schema === 'system')).toBe(false);
  }, 120_000);

  it('maps every type', async () => {
    const columns = new Map(
      (await clickHouseConnector.describe(ctx, select)).map((column) => [column.name, column]),
    );
    const suggested = (name: string) => columns.get(name)?.suggested;
    expect(columns.get('id')).toMatchObject({
      nullable: false,
      suggested: { type: 'number', options: { precision: 0 } },
    });
    expect(suggested('amount')).toEqual({ type: 'number', options: { precision: 4 } });
    expect(suggested('ratio')).toEqual({ type: 'number', options: { precision: null } });
    expect(suggested('flag')?.type).toBe('checkbox');
    for (const name of ['day', 'day32']) expect(suggested(name)).toEqual({ type: 'date', options: {} });
    for (const name of ['stamp', 'precise', 'fine'])
      expect(suggested(name)).toEqual({ type: 'date', options: { includeTime: true, timeZone: 'UTC' } });
    expect(columns.get('note')).toMatchObject({ nullable: true, suggested: { type: 'text' } });
    expect(columns.get('maybe')).toMatchObject({
      nullable: true,
      sourceType: 'LowCardinality(Nullable(String))',
    });
    for (const name of ['code', 'tag', 'ident', 'ip4', 'ip6']) expect(suggested(name)?.type).toBe('text');
    expect(suggested('mood')?.type).toBe('singleSelect');
    expect(JSON.stringify(suggested('mood')?.options)).toContain("it's fine");
    for (const name of ['tags', 'attrs', 'pair', 'spot']) expect(suggested(name)?.type).toBe('longText');
    const queried = await clickHouseConnector.describe(ctx, {
      kind: 'query',
      sql: `SELECT id, label FROM ${qualified}`,
    });
    expect(queried.map((column) => column.suggested?.type)).toEqual(['number', 'text']);
  }, 120_000);

  it('previews values in Riosoma’s forms, and a query through the guard', async () => {
    const preview = await clickHouseConnector.preview(
      ctx,
      { kind: 'query', sql: `SELECT * FROM ${qualified} ORDER BY id` },
      4,
    );
    expect(preview.rows).toHaveLength(4);
    const rows = preview.rows.map((values) =>
      Object.fromEntries(preview.columns.map((column, index) => [column.name, values[index]])),
    );
    expect(rows[0]).toMatchObject({
      // A number field holds a double, so these are as close as one comes.
      id: Number('9007199254740993'),
      amount: Number('12345678901234567890.12'),
      huge: Number('170141183460469231731687303715884105727'),
      flag: true,
      day: '2026-02-03',
      day32: '1901-02-03',
      stamp: '2026-02-03T04:05:06.000Z',
      precise: '2026-02-03T09:05:06.789Z',
      fine: '2026-02-03T04:05:06.123Z',
      note: null,
      code: 'ab',
      maybe: 'blue',
      ident: '2e2a7a54-2b0e-4a1c-9d7f-0d3f0a2b1c9d',
      ip4: '10.1.2.3',
      ip6: '2001:db8::1',
      mood: expect.any(String),
      tags: '["a","b"]',
      attrs: '{"k":7}',
      pair: '{"city":"Lisbon","zip":1000}',
      spot: '[1.5,2.5]',
    });
    expect(rows[1]?.maybe).toBeNull();
    expect(rows[3]?.odd).toBeNull();
    await expect(
      clickHouseConnector.preview(ctx, { kind: 'query', sql: `SELECT 1; DROP TABLE ${qualified}` }, 1),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
    await expect(
      clickHouseConnector.preview(
        ctx,
        { kind: 'object', object: { schema: settings.database, name: `gone_${suffix}` } },
        1,
      ),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.objectMissing' });
  }, 120_000);

  it('offers no key, since a sorting key allows repeats', async () => {
    expect(await clickHouseConnector.keyCandidates(ctx, { schema: settings.database, name: table })).toEqual(
      [],
    );
  }, 120_000);

  it('reads every row with exact keys and digits', async () => {
    const batches = await readAll(ctx, select, ['label', 'amount', 'huge', 'stamp'], ['id']);
    const rows = batches.flat();
    expect(new Set(rows.map((row) => row.key))).toEqual(
      new Set(
        Array.from({ length: 13 }, (_unused, n) => JSON.stringify([String(9007199254740993n + BigInt(n))])),
      ),
    );
    expect(rows.find((row) => row.values.label === 'row 0')?.values).toMatchObject({
      amount: '12345678901234567890.1200',
      huge: '170141183460469231731687303715884105727',
      stamp: '2026-02-03T04:05:06.000Z',
    });
  }, 120_000);

  it('pages through more rows than a page holds, every row once, though the sorting key repeats', async () => {
    const pages = { kind: 'object' as const, object: { schema: settings.database, name: large } };
    for (const keys of [['id'], ['word']]) {
      const batches = await readAll(ctx, pages, ['word'], keys);
      const found = batches.flat().map((row) => row.key);
      expect(found, keys.join()).toHaveLength(CLICKHOUSE_PAGE_ROWS * 2 + 7);
      expect(new Set(found).size, keys.join()).toBe(found.length);
    }
    // Text with a tab, a quote, a backslash, and a line break carries over from one page to the next.
    const odd = (await readAll(ctx, pages, ['word'], ['word']))
      .flat()
      .find((row) => row.values.word === "w997\t'\\ \n");
    expect(odd).toBeDefined();
  }, 300_000);

  it('picks up after the last row by a date-time and a number, and keeps ties on one page', async () => {
    const small = createClickHouseConnector({ pageRows: 4 });
    const byTime = await readAll(ctx, select, ['label'], ['precise', 'id'], small);
    expect(byTime.flat()).toHaveLength(13);
    expect(new Set(byTime.flat().map((row) => row.key)).size).toBe(13);
    // Every row has the same code, so the first page takes them all and the next one finds none.
    const tied = await readAll(ctx, select, ['label'], ['code'], small);
    expect(tied.flat()).toHaveLength(13);
    // A key that can be empty has no cursor, so pages count their way through instead.
    const counted = await readAll(ctx, select, ['label'], ['maybe', 'id'], small);
    expect(new Set(counted.flat().map((row) => row.values.label)).size).toBe(13);
  }, 120_000);

  it('reads a table that replaces rows as they were after a merge, before ClickHouse merges them', async () => {
    const path = `${quote(settings.database)}.${quote(versions)}`;
    await run(`CREATE TABLE ${path} (id UInt64, word String) ENGINE = ReplacingMergeTree ORDER BY id`);
    // With merges stopped, each insert stays its own part, so the table holds both versions of row 1.
    await run(`SYSTEM STOP MERGES ${path}`);
    await run(`INSERT INTO ${path} VALUES (1, 'first'), (2, 'only')`);
    await run(`INSERT INTO ${path} VALUES (1, 'second')`);
    const counted = await admin!.query({ query: `SELECT count() AS n FROM ${path}`, format: 'JSONEachRow' });
    // Servers differ in whether a 64-bit count comes quoted.
    expect((await counted.json<{ n: string | number }>()).map((row) => Number(row.n))).toEqual([3]);
    const readOnly: ConnectorContext = {
      ...ctx,
      connection: { ...settings, user: reader },
      secrets: { password: readerPassword },
    };
    const object: SourceSelect = { kind: 'object', object: { schema: settings.database, name: versions } };
    for (const connector of [clickHouseConnector, createClickHouseConnector({ pageRows: 1 })]) {
      const rows = (await readAll(readOnly, object, ['word'], ['id'], connector)).flat();
      expect(rows.map((row) => [row.key, row.values.word])).toEqual([
        ['[1]', 'second'],
        ['[2]', 'only'],
      ]);
    }
    expect((await clickHouseConnector.preview(readOnly, object, 5)).rows).toHaveLength(2);
  }, 120_000);

  it('works for a read-only user who may change no settings', async () => {
    const readOnly: ConnectorContext = {
      ...ctx,
      connection: { ...settings, user: reader },
      secrets: { password: readerPassword },
    };
    expect((await clickHouseConnector.test(readOnly)).ok).toBe(true);
    const preview = await clickHouseConnector.preview(readOnly, select, 2);
    expect(preview.rows).toHaveLength(2);
    const batches = await readAll(readOnly, select, ['label', 'stamp', 'amount'], ['id']);
    expect(batches.flat()).toHaveLength(13);
    // A cursor's values travel as query parameters, which a read-only user may send.
    const paged = await readAll(
      readOnly,
      select,
      ['label'],
      ['id'],
      createClickHouseConnector({ pageRows: 4 }),
    );
    expect(paged.flat()).toHaveLength(13);
  }, 120_000);
});
