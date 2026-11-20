/**
 * Trino against a real coordinator.  It runs only when these are set, and skips otherwise:
 *
 * - `RIOSOMA_TEST_TRINO_URL`, the coordinator as `http://user@host:port/catalog`, where the
 *   catalog can create tables (the built-in `memory` catalog does) and a `tpch` catalog is there
 * - optionally `RIOSOMA_TEST_TRINO_TLS_URL`, the same coordinator over HTTPS with a password, as
 *   `https://user:password@host:port/catalog`, with `RIOSOMA_TEST_TRINO_CA_FILE`, the authority its
 *   certificate comes from
 *
 * A local coordinator does it, started with a `wh_open_` name so it's easy to find and remove:
 *
 *     docker run -d --name wh_open_trino -p 127.0.0.1::8080 trinodb/trino
 *
 * The suite creates a schema with a table of every type and a copy of a TPC-H table big enough
 * to take many pages, reads them through the connector, checks that a query it gives up on ends
 * canceled, and drops them.
 */
import { readFileSync } from 'node:fs';
import type { SourceConnection, SourceSelect } from '@riosoma/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectorContext, SourceRow } from '../types.js';
import { trinoConnector, type TrinoPage } from './trino.js';

const url = process.env.RIOSOMA_TEST_TRINO_URL || undefined;
const tlsUrl = process.env.RIOSOMA_TEST_TRINO_TLS_URL || undefined;
const caFile = process.env.RIOSOMA_TEST_TRINO_CA_FILE || undefined;

type TrinoSettings = Extract<SourceConnection, { kind: 'trino' }>;

/** A connection and its secrets from an address like `https://user:password@host:port/catalog`. */
function contextOf(address: string, extra: Partial<TrinoSettings> = {}): ConnectorContext {
  const parsed = new URL(address);
  const secure = parsed.protocol === 'https:';
  const password = decodeURIComponent(parsed.password);
  return {
    connection: {
      kind: 'trino',
      host: parsed.hostname,
      port: Number(parsed.port) || (secure ? 443 : 8080),
      catalog: decodeURIComponent(parsed.pathname.slice(1)) || 'memory',
      user: decodeURIComponent(parsed.username) || 'rio',
      auth: password ? 'password' : 'none',
      secure,
      ...extra,
    } as TrinoSettings,
    secrets: password ? { password } : {},
    timeoutMs: 120_000,
  };
}

describe.skipIf(!url)('trino against a real coordinator', () => {
  const ctx = contextOf(url ?? 'http://rio@localhost:8080/memory');
  const suffix = Math.random().toString(36).slice(2, 8);
  const schema = `rio_${suffix}`;
  const settings = { ...(ctx.connection as TrinoSettings), schema };
  const scoped: ConnectorContext = { ...ctx, connection: settings };
  // A name with a space and a quote, so every path through the connector has to quote it.  Trino
  // folds names to lower case, so it starts in lower case.
  const table = `rio "sample" ${suffix}`;
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const qualified = [settings.catalog, schema, table].map(quote).join('.');
  const select: SourceSelect = { kind: 'object', object: { schema, name: table } };
  let run: (sql: string) => Promise<unknown[][]> = async () => [];

  beforeAll(async () => {
    const parsed = new URL(url ?? 'http://rio@localhost:8080/memory');
    const headers = { 'X-Trino-User': settings.user ?? 'rio' };
    // The client protocol, plainly: post the statement, then follow each page to the last.
    run = async (sql) => {
      const rows: unknown[][] = [];
      const answer = await fetch(`${parsed.protocol}//${parsed.host}/v1/statement`, {
        method: 'POST',
        headers,
        body: sql,
      });
      let page = (await answer.json()) as TrinoPage;
      for (;;) {
        if (page.error) throw new Error(page.error.message);
        rows.push(...(page.data ?? []));
        if (!page.nextUri) return rows;
        page = (await (await fetch(page.nextUri, { headers })).json()) as TrinoPage;
      }
    };
    await run(`CREATE SCHEMA ${quote(settings.catalog)}.${quote(schema)}`);
    await run(`CREATE TABLE ${qualified} (
      id bigint, part smallint, tiny tinyint, whole integer, label varchar, code varchar(20), fixed char(4),
      amount decimal(30, 4), ratio double, small_ratio real, flag boolean, day date, stamp timestamp(3),
      zoned timestamp(3) with time zone, precise timestamp(6), clock time(3), doc json, ident uuid,
      ip ipaddress, tags array(varchar), lookup map(varchar, integer),
      address row(city varchar, zip integer), nested array(row(n bigint, "odd name" varchar)), raw varbinary
    )`);
    await run(`INSERT INTO ${qualified}
      SELECT 9007199254740993 + n, CAST(n AS smallint), CAST(1 AS tinyint), 7, 'row ' || CAST(n AS varchar),
        'code', 'ab', CAST('12345678901234567890.1200' AS decimal(30, 4)), 1.25, REAL '0.5', true,
        DATE '2026-02-03', TIMESTAMP '2026-02-03 04:05:06.789',
        TIMESTAMP '2026-02-03 04:05:06.789 Europe/Lisbon', TIMESTAMP '2026-02-03 04:05:06.123456',
        TIME '12:34:56.789', JSON '{"hello": [1, 2]}', UUID '2e2a7a54-2b0e-4a1c-9d7f-0d3f0a2b1c9d',
        IPADDRESS '10.1.2.3', ARRAY['a', 'b'], MAP(ARRAY['k'], ARRAY[7]),
        CAST(ROW('Lisbon', 1000) AS row(city varchar, zip integer)),
        ARRAY[CAST(ROW(1, 'x') AS row(n bigint, "odd name" varchar))], X'616263'
      FROM UNNEST(sequence(0, 12)) AS t(n)`);
    // Big enough that Trino hands the rows over in many pages.
    await run(
      `CREATE TABLE ${quote(settings.catalog)}.${quote(schema)}.lineitem AS SELECT * FROM tpch.tiny.lineitem`,
    );
  }, 300_000);

  afterAll(async () => {
    for (const sql of [
      `DROP TABLE IF EXISTS ${qualified}`,
      `DROP TABLE IF EXISTS ${quote(settings.catalog)}.${quote(schema)}.lineitem`,
      `DROP SCHEMA IF EXISTS ${quote(settings.catalog)}.${quote(schema)}`,
    ])
      await run(sql).catch(() => undefined);
  }, 120_000);

  it('climbs every step of a connection test, and skips TLS on a plain connection', async () => {
    const result = await trinoConnector.test(scoped);
    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'skipped'],
      ['authenticate', 'ok'],
      ['query', 'ok'],
    ]);
    expect(result.serverVersion).toMatch(/^Trino \d+/);
  }, 120_000);

  it.skipIf(!tlsUrl || !caFile)(
    'signs in with a password over HTTPS from a private authority',
    async () => {
      const secure = contextOf(tlsUrl ?? 'https://localhost', {
        schema,
        caPem: readFileSync(caFile ?? '', 'utf8'),
      });
      const result = await trinoConnector.test(secure);
      expect(result.ok, JSON.stringify(result.steps)).toBe(true);
      expect(result.steps.map((step) => step.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
      expect((await trinoConnector.preview(secure, select, 2)).rows).toHaveLength(2);
      const wrong = await trinoConnector.test({ ...secure, secrets: { password: `${suffix}-not-it` } });
      expect(wrong.steps.at(-1)).toMatchObject({
        step: 'authenticate',
        messageKey: 'sources.test.authenticate',
      });
      const untrusted = await trinoConnector.test(contextOf(tlsUrl ?? 'https://localhost', { schema }));
      expect(untrusted.steps.at(-1)).toMatchObject({ step: 'tls', messageKey: 'sources.test.tls' });
    },
    120_000,
  );

  it('fails at the query step for a catalog or schema it can’t read', async () => {
    const noCatalog = await trinoConnector.test({
      ...ctx,
      connection: { ...settings, catalog: `none_${suffix}` },
    });
    expect(noCatalog.steps.at(-1)).toMatchObject({ step: 'query', messageKey: 'sources.test.query' });
    const noSchema = await trinoConnector.test({
      ...ctx,
      connection: { ...settings, schema: `none_${suffix}` },
    });
    expect(noSchema.steps.at(-1)).toMatchObject({ step: 'query', messageKey: 'sources.test.query' });
    expect(noSchema.steps.at(-1)?.detail).toContain(`none_${suffix}`);
  }, 120_000);

  it('lists the catalog’s tables, the connection’s schema first', async () => {
    const objects = await trinoConnector.listObjects(scoped);
    expect(objects[0]?.schema).toBe(schema);
    expect(objects.filter((object) => object.schema === schema).map((object) => object.name)).toEqual(
      [table, 'lineitem'].sort(),
    );
  }, 120_000);

  it('maps every type', async () => {
    const columns = new Map(
      (await trinoConnector.describe(scoped, select)).map((column) => [column.name, column]),
    );
    const suggested = (name: string) => columns.get(name)?.suggested;
    for (const name of ['id', 'part', 'tiny', 'whole'])
      expect(suggested(name)).toEqual({ type: 'number', options: { precision: 0 } });
    expect(suggested('amount')).toEqual({ type: 'number', options: { precision: 4 } });
    for (const name of ['ratio', 'small_ratio'])
      expect(suggested(name)).toEqual({ type: 'number', options: { precision: null } });
    expect(suggested('flag')?.type).toBe('checkbox');
    expect(suggested('day')).toEqual({ type: 'date', options: {} });
    for (const name of ['stamp', 'zoned', 'precise'])
      expect(suggested(name)).toEqual({ type: 'date', options: { includeTime: true, timeZone: 'UTC' } });
    for (const name of ['label', 'code', 'fixed', 'clock', 'ident', 'ip'])
      expect(suggested(name)?.type).toBe('text');
    for (const name of ['doc', 'tags', 'lookup', 'address', 'nested'])
      expect(suggested(name)?.type).toBe('longText');
    expect(suggested('raw')).toBeNull();
    expect(columns.get('zoned')?.sourceType).toBe('timestamp(3) with time zone');
    const queried = await trinoConnector.describe(scoped, {
      kind: 'query',
      sql: `SELECT id, label, INTERVAL '3' DAY AS span FROM ${qualified}`,
    });
    expect(queried.map((column) => column.suggested?.type ?? null)).toEqual(['number', 'text', null]);
  }, 120_000);

  it('previews values in Riosoma’s forms, and a query through the guard', async () => {
    const preview = await trinoConnector.preview(scoped, select, 3);
    expect(preview.rows).toHaveLength(3);
    expect(preview.rowEstimate === null || preview.rowEstimate === 13).toBe(true);
    const row = Object.fromEntries(
      preview.columns.map((column, index) => [column.name, preview.rows[0]?.[index]]),
    );
    expect(row).toMatchObject({
      tiny: 1,
      whole: 7,
      code: 'code',
      fixed: 'ab  ',
      ratio: 1.25,
      small_ratio: 0.5,
      flag: true,
      day: '2026-02-03',
      stamp: '2026-02-03T04:05:06.789Z',
      zoned: '2026-02-03T04:05:06.789Z',
      precise: '2026-02-03T04:05:06.123Z',
      clock: '12:34:56.789',
      doc: '{"hello":[1,2]}',
      ident: '2e2a7a54-2b0e-4a1c-9d7f-0d3f0a2b1c9d',
      ip: '10.1.2.3',
      tags: '["a","b"]',
      lookup: '{"k":7}',
      address: '{"city":"Lisbon","zip":1000}',
      nested: '[{"n":1,"odd name":"x"}]',
      raw: null,
    });
    const queried = await trinoConnector.preview(
      scoped,
      { kind: 'query', sql: `SELECT part FROM ${quote(table)} WHERE part < 2` },
      5,
    );
    expect(queried.rows).toHaveLength(2);
    await expect(
      trinoConnector.preview(scoped, { kind: 'query', sql: `SELECT 1; DROP TABLE ${qualified}` }, 1),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
    await expect(
      trinoConnector.preview(scoped, { kind: 'object', object: { schema, name: `gone_${suffix}` } }, 1),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.objectMissing' });
    await expect(
      trinoConnector.preview(scoped, { kind: 'query', sql: `SELECT nothing_here FROM ${qualified}` }, 1),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.columnMissing', params: { column: 'nothing_here' } });
  }, 120_000);

  it('offers no key, since Trino passes on none', async () => {
    expect(await trinoConnector.keyCandidates(scoped, { schema, name: table })).toEqual([]);
  }, 120_000);

  it('reads every row with exact keys and digits', async () => {
    const batches: SourceRow[][] = [];
    for await (const batch of trinoConnector.read(scoped, select, {
      columns: ['label', 'amount', 'zoned'],
      types: { label: 'text', amount: 'text', zoned: 'date' },
      keyColumns: ['id'],
      batchSize: 5,
    }))
      batches.push(batch);
    expect(batches.map((batch) => batch.length)).toEqual([5, 5, 3]);
    expect(new Set(batches.flat().map((row) => row.key))).toEqual(
      new Set(
        Array.from({ length: 13 }, (_unused, n) => JSON.stringify([String(9007199254740993n + BigInt(n))])),
      ),
    );
    expect(batches.flat().find((row) => row.values.label === 'row 0')?.values).toMatchObject({
      amount: '12345678901234567890.1200',
      zoned: '2026-02-03T04:05:06.789Z',
    });
  }, 120_000);

  it('cancels a query it gives up on before any row arrives', async () => {
    const marker = `rio_cancel_${suffix}`;
    // Counting TPC-H's biggest table takes far longer than the preview waits.
    await expect(
      trinoConnector.preview(
        { ...scoped, timeoutMs: 3_000 },
        { kind: 'query', sql: `SELECT count(*) AS ${marker} FROM tpch.sf100000.lineitem` },
        5,
      ),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
    let states: unknown[][] = [];
    for (let tries = 0; tries < 50; tries++) {
      states = await run(
        `SELECT state, error_code FROM system.runtime.queries
         WHERE query LIKE '%${marker}%' AND query LIKE '%LIMIT 5%' AND query NOT LIKE '%system.runtime%'`,
      );
      if (states.length > 0 && states.every(([state]) => state === 'FAILED')) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(states).toEqual([['FAILED', 'USER_CANCELED']]);
  }, 120_000);

  it('follows Trino’s pages to the end of a large table', async () => {
    let count = 0;
    const keys = new Set<string>();
    for await (const batch of trinoConnector.read(
      scoped,
      { kind: 'object', object: { schema, name: 'lineitem' } },
      {
        columns: ['comment'],
        types: { comment: 'text' },
        keyColumns: ['orderkey', 'linenumber'],
        batchSize: 5_000,
      },
    )) {
      count += batch.length;
      for (const row of batch) keys.add(row.key);
    }
    expect(count).toBe(60_175);
    expect(keys.size).toBe(count);
  }, 300_000);
});
