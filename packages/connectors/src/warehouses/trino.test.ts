import { FixtureBoundary } from '../contract/boundary.test-support.js';
import { strictFixture } from '../contract/strict.test-support.js';
/**
 * Trino against a stand-in for its HTTP connections that records what the connector asks for and
 * answers the way a coordinator does: a statement is posted, and its rows come in pages, each
 * fetched from the address the last one names, until one names none.  A few tests run a stand-in
 * coordinator on this machine instead.  The live suite is `trino.live.test.ts`.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SourceConnection, SourceSelect } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import type { ConnectorContext, SourceRow } from '../types.js';
import type { Network } from './frame.js';
import type { HttpFetch } from './http.js';
import {
  createTrinoConnector,
  parseTrinoType,
  plainOfTrino,
  trinoColumn,
  trinoConnector,
  trinoEndpoint,
  trinoMissing,
  trinoProjection,
  trinoTypeClass,
  type TrinoPage,
} from './trino.js';

type Pages = TrinoPage[];

/** A statement as the coordinator received it. */
interface TrinoQuery {
  query: string;
  catalog?: string;
  schema?: string;
}

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

const COORDINATOR = 'https://trino.example.com';

/**
 * A coordinator's answers: each statement's pages in turn, every one but the last naming the next
 * one's address.  An answer can instead be an error the request throws, or a refusal as it stands.
 */
function fakeTrino(answer: (query: TrinoQuery) => Pages | Error | Response | undefined = () => undefined) {
  const log = { requests: [] as Sent[], queries: [] as TrinoQuery[], cancels: [] as string[] };
  const statements = new Map<string, Pages>();
  let counter = 0;
  const pageOf = (id: string, pages: Pages, index: number): TrinoPage => ({
    id,
    ...(pages[index] ?? {}),
    ...(index < pages.length - 1
      ? { nextUri: `${COORDINATOR}/v1/statement/executing/${id}/slug/${index + 1}` }
      : {}),
  });
  const json = (page: TrinoPage) => new Response(JSON.stringify(page), { status: 200 });
  const fetcher: HttpFetch = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
    const method = init.method ?? 'GET';
    log.requests.push({
      method,
      url,
      headers,
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
    });
    if (method === 'DELETE') {
      log.cancels.push(url);
      return new Response(null, { status: 204 });
    }
    if (method === 'POST') {
      const query: TrinoQuery = {
        query: typeof init.body === 'string' ? init.body : '',
        ...(headers['x-trino-catalog'] ? { catalog: headers['x-trino-catalog'] } : {}),
        ...(headers['x-trino-schema'] ? { schema: headers['x-trino-schema'] } : {}),
      };
      log.queries.push(query);
      const found = answer(query) ?? defaults(query.query);
      if (found instanceof Error) throw found;
      if (found instanceof Response) return found;
      const id = `q${(counter += 1)}`;
      statements.set(id, found);
      return json(pageOf(id, found, 0));
    }
    const [, id, token] = /\/v1\/statement\/executing\/([^/]+)\/slug\/(\d+)$/.exec(new URL(url).pathname)!;
    return json(pageOf(id!, statements.get(id!)!, Number(token)));
  };
  return { fetcher, log };
}

function defaults(sql: string): Pages {
  if (/signed_in/.test(sql)) return [{ columns: [{ name: 'signed_in', type: 'integer' }], data: [[1]] }];
  if (/version\(\)/.test(sql)) return [{ columns: [{ name: 'version', type: 'varchar' }], data: [['479']] }];
  if (/^SHOW SCHEMAS/.test(sql))
    return [{ columns: [{ name: 'Schema', type: 'varchar' }], data: [['information_schema'], ['sales']] }];
  return [{}];
}

function network(fail?: 'resolve' | 'connect' | 'tls'): Network & { calls: string[] } {
  const calls: string[] = [];
  const step = async (name: string, call: string) => {
    calls.push(call);
    if (fail === name) throw Object.assign(new Error(`${name} failed`), { code: 'EFAKE' });
  };
  return {
    calls,
    proxied: () => false,
    resolve: (host) => step('resolve', `resolve ${host}`),
    connect: (endpoint) => step('connect', `connect ${endpoint.host}:${endpoint.port}`),
    handshake: (endpoint) =>
      step('tls', `handshake ${endpoint.host}:${endpoint.port} ${JSON.stringify(endpoint.tls)}`),
  };
}

type TrinoSettings = Extract<SourceConnection, { kind: 'trino' }>;
const SETTINGS: TrinoSettings = {
  kind: 'trino',
  host: 'trino.example.com',
  port: 443,
  catalog: 'hive',
  schema: 'sales',
  user: 'reader',
  auth: 'password',
  secure: true,
};
// Built from parts, so neither stand-in reads as a stored secret.
const PASSWORD = ['stand', 'in', 'password', '17'].join('-');
const TOKEN = ['eyJstand', 'in', 'token'].join('.');

function contextFor(
  connection: Partial<TrinoSettings> = {},
  rest: Partial<ConnectorContext> = {},
): ConnectorContext {
  return {
    connection: { ...SETTINGS, ...connection } as TrinoSettings,
    secrets: { password: PASSWORD, token: TOKEN },
    timeoutMs: 2_000,
    ...rest,
  };
}

const connector = (fake: ReturnType<typeof fakeTrino>, checks: Network = network()) =>
  createTrinoConnector({ fetch: fake.fetcher, network: checks });

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

const ORDERS: SourceSelect = { kind: 'object', object: { schema: 'sales', name: 'orders' } };

const ORDER_COLUMNS = {
  columns: [
    { name: 'column_name', type: 'varchar' },
    { name: 'data_type', type: 'varchar' },
    { name: 'is_nullable', type: 'varchar' },
  ],
  data: [
    ['id', 'bigint', 'NO'],
    ['total', 'decimal(10,2)', 'YES'],
    ['placed', 'timestamp(3) with time zone', 'YES'],
    ['address', 'row(city varchar, zip integer)', 'YES'],
  ],
};

describe('trino type mapping', () => {
  it.each([
    ['tinyint', 'integer'],
    ['smallint', 'integer'],
    ['integer', 'integer'],
    ['bigint', 'integer'],
    ['decimal(38,10)', 'decimal'],
    ['real', 'float'],
    ['double', 'float'],
    ['boolean', 'boolean'],
    ['date', 'date'],
    ['timestamp(3)', 'timestamp'],
    ['timestamp(6) with time zone', 'timestamp'],
    ['time(3)', 'time'],
    ['time(3) with time zone', 'time'],
    ['varchar', 'text'],
    ['varchar(20)', 'text'],
    ['char(4)', 'text'],
    ['uuid', 'text'],
    ['ipaddress', 'text'],
    ['json', 'json'],
    ['array(varchar)', 'json'],
    ['map(varchar, array(integer))', 'json'],
    ['row(city varchar, zip integer)', 'json'],
    ['varbinary', 'binary'],
    ['interval day to second', 'unknown'],
    ['interval year to month', 'unknown'],
    ['HyperLogLog', 'unknown'],
    ['Geometry', 'unknown'],
  ])('reads %s as %s', (signature, kind) => {
    expect(trinoTypeClass(parseTrinoType(signature))).toBe(kind);
  });

  it('reads nested signatures, row fields and all', () => {
    expect(parseTrinoType('decimal(10,2)')).toEqual({ name: 'decimal', numbers: [10, 2], args: [] });
    expect(parseTrinoType('timestamp(3) with time zone')).toMatchObject({
      name: 'timestamp with time zone',
      numbers: [3],
    });
    const row = parseTrinoType(
      'array(row(n bigint, "odd name" varchar, odd name varchar, at timestamp(3) with time zone))',
    );
    expect(row.args[0]?.type.args.map((arg) => [arg.field, arg.type.name])).toEqual([
      ['n', 'bigint'],
      ['odd name', 'varchar'],
      ['odd name', 'varchar'],
      ['at', 'timestamp with time zone'],
    ]);
    expect(
      parseTrinoType('row(bigint, time with time zone)').args.map((arg) => [arg.field, arg.type.name]),
    ).toEqual([
      [null, 'bigint'],
      [null, 'time with time zone'],
    ]);
    expect(parseTrinoType('map(varchar, row(a integer))').args.map((arg) => arg.type.name)).toEqual([
      'varchar',
      'row',
    ]);
  });

  it('suggests the field types the SQL connectors would', () => {
    const suggested = (signature: string) => trinoColumn('c', signature, true).column.suggested;
    expect(suggested('bigint')).toEqual({ type: 'number', options: { precision: 0 } });
    expect(suggested('decimal(10,2)')).toEqual({ type: 'number', options: { precision: 2 } });
    expect(suggested('double')).toEqual({ type: 'number', options: { precision: null } });
    expect(suggested('boolean')).toEqual({ type: 'checkbox', options: {} });
    expect(suggested('date')).toEqual({ type: 'date', options: {} });
    expect(suggested('timestamp(6) with time zone')).toEqual({
      type: 'date',
      options: { includeTime: true, timeZone: 'UTC' },
    });
    expect(suggested('varchar(20)')).toEqual({ type: 'text', options: {} });
    expect(suggested('varchar(4000)')).toEqual({ type: 'longText', options: {} });
    expect(suggested('varchar')).toEqual({ type: 'text', options: {} });
    expect(suggested('row(a integer)')).toEqual({ type: 'longText', options: {} });
    expect(suggested('varbinary')).toBeNull();
    expect(suggested('interval day to second')).toBeNull();
  });

  it('reads a bigint as its digits and an instant with a zone in UTC', () => {
    const projected = (signature: string) => trinoProjection(trinoColumn('c', signature, true), '"c"');
    expect(projected('bigint')).toBe('CAST("c" AS varchar)');
    expect(projected('timestamp(3) with time zone')).toBe(`("c" AT TIME ZONE 'UTC')`);
    for (const signature of ['integer', 'timestamp(3)', 'decimal(10,2)', 'row(a bigint)'])
      expect(projected(signature)).toBe('"c"');
  });

  it('keeps big integers exact and gives rows their fields’ names', () => {
    const plain = (signature: string, value: unknown) =>
      plainOfTrino(value, trinoColumn('c', signature, true));
    expect(plain('bigint', '42')).toBe(42);
    expect(plain('bigint', '9007199254740993')).toBe('9007199254740993');
    expect(plain('row(city varchar, zip integer)', ['Lisbon', 1000])).toEqual({ city: 'Lisbon', zip: 1000 });
    expect(plain('array(row(n bigint, "odd name" varchar))', [[1, 'x']])).toEqual([
      { n: 1, 'odd name': 'x' },
    ]);
    expect(plain('map(varchar, row(a integer))', { k: [7] })).toEqual({ k: { a: 7 } });
    expect(plain('row(bigint, integer)', [1, 2])).toEqual([1, 2]);
    expect(plain('varchar', 'plain')).toBe('plain');
    expect(plain('bigint', null)).toBeNull();
  });
});

describe('trino connections', () => {
  it('climbs every step, signs in with the password, and checks the catalog and schema', async () => {
    const fake = fakeTrino();
    const checks = network();
    const result = await connector(fake, checks).test(contextFor({ caPem: '-----BEGIN CERTIFICATE-----' }));
    expect(result).toMatchObject({ ok: true, serverVersion: 'Trino 479' });
    expect(result.steps.map((step) => step.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(checks.calls.at(-1)).toBe('handshake trino.example.com:443 {"ca":"-----BEGIN CERTIFICATE-----"}');
    expect(fake.log.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://trino.example.com:443/v1/statement',
      headers: {
        authorization: basic('reader', PASSWORD),
        'x-trino-user': 'reader',
        'x-trino-source': 'riosoma',
      },
    });
    // Signing in touches no catalog, so a catalog that's gone fails later, at the query step.
    expect(fake.log.queries[0]).toEqual({ query: 'SELECT 1 AS signed_in' });
    expect(fake.log.queries.map((query) => query.query)).toContain('SHOW SCHEMAS FROM "hive"');
  });

  it('sends a token instead, and nothing secret on a plain connection that signs in with neither', async () => {
    const fake = fakeTrino();
    await connector(fake).test(contextFor({ auth: 'token', user: undefined }));
    expect(fake.log.requests[0]?.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      'x-trino-source': 'riosoma',
      'content-type': 'text/plain; charset=utf-8',
    });
    const plain = fakeTrino();
    const checks = network();
    const result = await connector(plain, checks).test(
      contextFor({ auth: 'none', secure: false, port: 8080, caPem: 'unused' }),
    );
    expect(result.steps.map((step) => [step.step, step.status])).toContainEqual(['tls', 'skipped']);
    expect(plain.log.requests[0]?.url).toBe('http://trino.example.com:8080/v1/statement');
    expect(plain.log.requests[0]?.headers).toEqual({
      'x-trino-user': 'reader',
      'x-trino-source': 'riosoma',
      'content-type': 'text/plain; charset=utf-8',
    });
    expect(checks.calls).toEqual(['resolve trino.example.com', 'connect trino.example.com:8080']);
  });

  it('refuses to send a password over plain HTTP, even when the settings skip the contract', async () => {
    const fake = fakeTrino();
    const result = await connector(fake).test(contextFor({ secure: false }));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.detail).toMatch(/only over HTTPS/);
    expect(fake.log.requests).toEqual([]);
  });

  it.each([
    ['resolve', Object.assign(new Error('getaddrinfo ENOTFOUND trino.example.com'), { code: 'ENOTFOUND' })],
    ['connect', Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' })],
    [
      'tls',
      Object.assign(new Error('unable to verify the first certificate'), {
        code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      }),
    ],
    ['authenticate', new Response(`Unauthorized: Basic cmVhZGVyOg== ${PASSWORD}`, { status: 401 })],
  ])('reports a failure to sign in at %s, without the secret', async (step, error) => {
    const fake = fakeTrino((query) => (/signed_in/.test(query.query) ? error : undefined));
    const result = await connector(fake).test(contextFor());
    expect(result.steps.at(-1)).toMatchObject({ step, status: 'failed', messageKey: `sources.test.${step}` });
    expect(result.steps.at(-1)?.detail).not.toContain(PASSWORD);
  });

  it('says a catalog or schema it can’t read at the query step, since the sign-in worked', async () => {
    const noCatalog = fakeTrino((query) =>
      /^SHOW SCHEMAS/.test(query.query)
        ? [{ error: { errorName: 'CATALOG_NOT_FOUND', message: "line 1:1: Catalog 'hive' not found" } }]
        : undefined,
    );
    const failed = await connector(noCatalog).test(contextFor());
    expect(failed.steps.map((step) => [step.step, step.status]).slice(-2)).toEqual([
      ['authenticate', 'ok'],
      ['query', 'failed'],
    ]);
    expect(failed.steps.at(-1)).toMatchObject({
      messageKey: 'sources.test.query',
      detail: "CATALOG_NOT_FOUND: line 1:1: Catalog 'hive' not found",
    });
    const noSchema = await connector(fakeTrino()).test(contextFor({ schema: 'elsewhere' }));
    expect(noSchema.steps.at(-1)).toMatchObject({
      step: 'query',
      detail: "the catalog hive has no schema named elsewhere, or this user can't see it",
    });
  });

  it('takes the coordinator from a pasted address', () => {
    expect(trinoEndpoint({ ...SETTINGS, host: 'https://trino.example.com:8443/ui/' })).toEqual({
      host: 'trino.example.com',
      port: 8443,
      tls: {},
    });
  });

  it('says which table or column is missing from Trino’s own words', () => {
    expect(trinoMissing("TABLE_NOT_FOUND: line 1:15: Table 'hive.sales.gone' does not exist")).toEqual({
      kind: 'object',
    });
    expect(trinoMissing("SCHEMA_NOT_FOUND: line 1:15: Schema 'gone' does not exist")).toEqual({
      kind: 'object',
    });
    expect(trinoMissing("COLUMN_NOT_FOUND: line 1:8: Column 'nope' cannot be resolved")).toEqual({
      kind: 'column',
      column: 'nope',
    });
    expect(trinoMissing('PERMISSION_DENIED: Access Denied: Cannot select from table')).toBeNull();
  });
});

describe('trino catalog and reads', () => {
  it('lists the catalog’s tables and views, the connection’s schema first', async () => {
    const fake = fakeTrino((query) =>
      query.query.includes('information_schema"."tables"')
        ? [
            {
              columns: [
                { name: 'table_schema', type: 'varchar' },
                { name: 'table_name', type: 'varchar' },
                { name: 'table_type', type: 'varchar' },
              ],
              data: [['archive', 'old', 'BASE TABLE']],
            },
            {
              data: [
                ['sales', 'orders', 'BASE TABLE'],
                ['sales', 'recent', 'VIEW'],
              ],
            },
          ]
        : undefined,
    );
    expect(await connector(fake).listObjects(contextFor())).toEqual([
      { schema: 'sales', name: 'orders', type: 'table', rowEstimate: null },
      { schema: 'sales', name: 'recent', type: 'view', rowEstimate: null },
      { schema: 'archive', name: 'old', type: 'table', rowEstimate: null },
    ]);
    const listing = fake.log.queries.find((query) => query.query.includes('information_schema"."tables"'))!;
    expect(listing.query).toContain('FROM "hive"."information_schema"."tables"');
  });

  it('describes a table, with names as literals that can’t end early', async () => {
    const fake = fakeTrino((query) => (query.query.includes('"columns"') ? [ORDER_COLUMNS] : undefined));
    const columns = await connector(fake).describe(contextFor(), {
      kind: 'object',
      object: { schema: "o'brien", name: 'orders' },
    });
    expect(columns.map((column) => [column.name, column.nullable, column.suggested?.type])).toEqual([
      ['id', false, 'number'],
      ['total', true, 'number'],
      ['placed', true, 'date'],
      ['address', true, 'longText'],
    ]);
    expect(fake.log.queries.at(-1)?.query).toContain("table_schema = 'o''brien'");
  });

  it('describes a query from its first page with columns, in the catalog and schema', async () => {
    const fake = fakeTrino((query) =>
      query.query.includes('LIMIT 0') ? [{}, { columns: [{ name: 'n', type: 'bigint' }] }, {}] : undefined,
    );
    const columns = await connector(fake).describe(contextFor(), { kind: 'query', sql: 'SELECT n FROM t' });
    expect(columns.map((column) => [column.name, column.sourceType, column.nullable])).toEqual([
      ['n', 'bigint', true],
    ]);
    expect(fake.log.queries.at(-1)).toEqual({
      query: 'SELECT * FROM (\nSELECT n FROM t\n) AS q LIMIT 0',
      catalog: 'hive',
      schema: 'sales',
    });
  });

  it('turns a missing table into the sync’s own message, and offers no key', async () => {
    const fake = fakeTrino((query) =>
      query.query.includes('information_schema') ? [{ data: [] }] : undefined,
    );
    await expect(connector(fake).describe(contextFor(), ORDERS)).rejects.toMatchObject({
      messageKey: 'sources.sync.objectMissing',
      params: { object: 'orders' },
    });
    await expect(
      connector(fake).keyCandidates(contextFor(), { schema: 'sales', name: 'orders' }),
    ).rejects.toMatchObject({
      messageKey: 'sources.sync.objectMissing',
    });
    const found = fakeTrino((query) =>
      query.query.includes('"tables"')
        ? [{ columns: [{ name: 'table_type', type: 'varchar' }], data: [['BASE TABLE']] }]
        : undefined,
    );
    expect(await connector(found).keyCandidates(contextFor(), { schema: 'sales', name: 'orders' })).toEqual(
      [],
    );
  });

  it('follows every page of a read, with exact keys and rows named', async () => {
    const fake = fakeTrino((query) => {
      if (query.query.includes('"columns"')) return [ORDER_COLUMNS];
      // In the order the read asks for them: the chosen columns, then the key.
      if (query.query.includes('FROM "hive"."sales"."orders"'))
        return [
          { columns: [] },
          { data: [['12.50', '2026-02-03 02:05:06.789 UTC', ['Lisbon', 1000], '9007199254740993']] },
          { data: [] },
          { data: [[null, null, null, '2']] },
        ];
      return undefined;
    });
    const batches: SourceRow[][] = [];
    for await (const batch of connector(fake).read(contextFor(), ORDERS, {
      columns: ['total', 'placed', 'address'],
      types: { total: 'text', placed: 'date', address: 'longText' },
      keyColumns: ['id'],
    }))
      batches.push(batch);
    expect(batches.flat()).toEqual([
      {
        key: '["9007199254740993"]',
        values: {
          total: '12.50',
          placed: '2026-02-03T02:05:06.789Z',
          address: '{"city":"Lisbon","zip":1000}',
        },
      },
      { key: '[2]', values: { total: null, placed: null, address: null } },
    ]);
    expect(fake.log.queries.find((query) => query.query.includes('FROM "hive"."sales"."orders"'))).toEqual({
      query:
        'SELECT "total" AS "total", ("placed" AT TIME ZONE \'UTC\') AS "placed", "address" AS "address", ' +
        'CAST("id" AS varchar) AS "id" FROM "hive"."sales"."orders"',
      catalog: 'hive',
      schema: 'sales',
    });
    // A query read to its end needs no canceling.
    expect(fake.log.cancels).toEqual([]);
  });

  it('says why a query failed, and has nothing to cancel once Trino ended it', async () => {
    const fake = fakeTrino((query) => {
      if (query.query.includes('"columns"')) return [ORDER_COLUMNS];
      if (query.query.includes('"hive"."sales"."orders"'))
        return [
          { data: [['1', '1', null, null]] },
          { error: { errorName: 'EXCEEDED_TIME_LIMIT', message: 'too slow' } },
        ];
      return undefined;
    });
    const read = connector(fake).read(contextFor(), ORDERS, {
      columns: ['total'],
      types: { total: 'text' },
      keyColumns: ['id'],
    });
    await expect(
      (async () => {
        for await (const batch of read) void batch;
      })(),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.read', detail: 'EXCEEDED_TIME_LIMIT: too slow' });
    expect(fake.log.cancels).toEqual([]);
  });

  it('cancels a query it stops reading, at the address it would have asked next', async () => {
    const fake = fakeTrino((query) =>
      query.query.includes('LIMIT 1')
        ? [{ columns: [{ name: 'n', type: 'integer' }], data: [[1]] }, { data: [] }, { data: [] }]
        : query.query.includes('LIMIT 0')
          ? [{ columns: [{ name: 'n', type: 'integer' }] }]
          : undefined,
    );
    const preview = await connector(fake).preview(contextFor(), { kind: 'query', sql: 'SELECT n FROM t' }, 1);
    expect(preview.rows).toEqual([[1]]);
    const statement = fake.log.requests.find((request) => request.body?.includes('LIMIT 1'));
    expect(statement).toBeDefined();
    expect(fake.log.cancels).toEqual([`${COORDINATOR}/v1/statement/executing/q3/slug/1`]);
  });

  it('asks again while the coordinator is briefly busy', async () => {
    let busy = 1;
    const fake = fakeTrino((query) =>
      /version\(\)/.test(query.query) && busy-- > 0
        ? new Response('Trino server is still initializing', { status: 503 })
        : undefined,
    );
    const result = await connector(fake).test(contextFor());
    expect(result).toMatchObject({ ok: true, serverVersion: 'Trino 479' });
    expect(fake.log.queries.filter((query) => /version\(\)/.test(query.query))).toHaveLength(2);
  });

  it('keeps no more than 200 characters of a refusal’s body, as plain text', async () => {
    const fake = fakeTrino(() => new Response(`gateway\u0000 says ${'z'.repeat(2_000)}`, { status: 500 }));
    const detail = (await connector(fake).test(contextFor())).steps.at(-1)?.detail ?? '';
    expect(detail.startsWith('Trino answered 500: gateway says z')).toBe(true);
    expect(detail.length).toBeLessThanOrEqual('Trino answered 500: '.length + 200);
  });

  it('never follows a next page to another address, where the sign-in would go too', async () => {
    const requests: string[] = [];
    const fetcher: HttpFetch = async (url, init) => {
      requests.push(`${init.method ?? 'GET'} ${url}`);
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      const body = typeof init.body === 'string' ? init.body : '';
      if (/signed_in/.test(body))
        return new Response(
          JSON.stringify({ id: 'q1', columns: [{ name: 'signed_in', type: 'integer' }], data: [[1]] }),
        );
      return new Response(
        JSON.stringify({
          id: 'q2',
          nextUri: 'https://elsewhere.example.net/v1/statement/executing/q2/slug/1',
        }),
      );
    };
    await expect(
      createTrinoConnector({ fetch: fetcher, network: network() }).describe(contextFor(), {
        kind: 'query',
        sql: 'SELECT n FROM t',
      }),
    ).rejects.toMatchObject({
      messageKey: 'sources.sync.read',
      detail: expect.stringContaining(
        "Trino named its next page on elsewhere.example.net over HTTPS, not at the coordinator's own address",
      ),
    });
    expect(requests.some((request) => request.includes('elsewhere'))).toBe(false);
  });

  it('previews the first rows, through the guard for a query', async () => {
    const fake = fakeTrino((query) =>
      query.query.includes('LIMIT 0')
        ? [{ columns: [{ name: 'n', type: 'integer' }] }]
        : query.query.includes('LIMIT 2')
          ? [{ columns: [{ name: 'n', type: 'integer' }], data: [[1], [2]] }]
          : undefined,
    );
    const preview = await connector(fake).preview(contextFor(), { kind: 'query', sql: 'SELECT n FROM t' }, 2);
    expect(preview).toEqual({
      columns: [expect.objectContaining({ name: 'n' })],
      rows: [[1], [2]],
      rowEstimate: null,
    });
    await expect(
      connector(fake).preview(contextFor(), { kind: 'query', sql: 'SELECT 1; DROP TABLE t' }, 1),
    ).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
  });

  it('registers itself on import', () => {
    expect(trinoConnector.kind).toBe('trino');
  });
});

/**
 * A coordinator on this machine that signs anyone in, answers `signed_in` at once, and keeps any
 * query that names `slow` queued and then planning for good.  Each poll is held a moment, the way
 * Trino holds one open, and names the next address to ask.
 */
async function standInCoordinator() {
  const log: Array<{ method: string; path: string }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const path = request.url ?? '';
      log.push({ method: request.method ?? '', path });
      const json = (value: unknown) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.method === 'DELETE') {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === 'POST' && !body.includes('slow'))
        return json({
          id: 'q_fast',
          columns: [{ name: 'signed_in', type: 'integer' }],
          data: [[1]],
          stats: { state: 'FINISHED' },
        });
      const token = request.method === 'POST' ? 0 : Number(path.split('/').at(-1));
      const next = `http://127.0.0.1:${port}/v1/statement/${token === 0 ? 'queued' : 'executing'}/q_slow/slug/${token + 1}`;
      const answer = () =>
        json({ id: 'q_slow', nextUri: next, stats: { state: token === 0 ? 'QUEUED' : 'PLANNING' } });
      if (request.method === 'POST') answer();
      else setTimeout(answer, 25);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    log,
    polls: () => log.filter((entry) => entry.method === 'GET').length,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('waited too long');
    await pause(10);
  }
}

describe('trino against a stand-in coordinator', () => {
  const contextOn = (port: number, rest: Partial<ConnectorContext> = {}): ConnectorContext => ({
    connection: {
      kind: 'trino',
      host: '127.0.0.1',
      port,
      catalog: 'memory',
      user: 'reader',
      auth: 'none',
      secure: false,
    },
    secrets: {},
    timeoutMs: 500,
    ...rest,
  });
  const SLOW: SourceSelect = { kind: 'query', sql: 'SELECT n FROM slow' };

  it('cancels a query still planning when a preview runs out of time, and stops asking for its pages', async () => {
    const coordinator = await standInCoordinator();
    try {
      await expect(
        createTrinoConnector({ network: network() }).preview(contextOn(coordinator.port), SLOW, 5),
      ).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
      await waitFor(() => coordinator.log.some((entry) => entry.method === 'DELETE'));
      const cancel = coordinator.log.find((entry) => entry.method === 'DELETE')!;
      expect(cancel.path).toMatch(/^\/v1\/statement\/(?:queued|executing)\/q_slow\/slug\/\d+$/);
      const polls = coordinator.polls();
      await pause(300);
      expect(coordinator.polls()).toBe(polls);
    } finally {
      await coordinator.close();
    }
  });

  it('cancels a query still planning when the caller stops a read', async () => {
    const coordinator = await standInCoordinator();
    const controller = new AbortController();
    try {
      const read = createTrinoConnector({ network: network() }).read(
        contextOn(coordinator.port, { signal: controller.signal, timeoutMs: 30_000 }),
        SLOW,
        { columns: ['n'], types: { n: 'number' }, keyColumns: ['n'] },
      );
      setTimeout(() => controller.abort(), 200);
      await expect(
        (async () => {
          for await (const batch of read) void batch;
        })(),
      ).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
      await waitFor(() => coordinator.log.some((entry) => entry.method === 'DELETE'));
      const polls = coordinator.polls();
      await pause(300);
      expect(coordinator.polls()).toBe(polls);
    } finally {
      await coordinator.close();
    }
  });
});

it('runs every declared contract against the native protocol fixture', async () => {
  const boundary = new FixtureBoundary();
  const fake = fakeTrino(({ query }) => {
    if (/information_schema"\."tables/.test(query))
      return [
        {
          columns: [
            { name: 'table_schema', type: 'varchar' },
            { name: 'table_name', type: 'varchar' },
            { name: 'table_type', type: 'varchar' },
          ],
          data: [['sales', 'orders', 'BASE TABLE']],
        },
      ];
    if (/information_schema"\."columns/.test(query))
      return [{ ...ORDER_COLUMNS, data: [ORDER_COLUMNS.data[0]!] }];
    if (!query.includes('"orders"')) return undefined;
    const ids = /"id" = 2/.test(query) ? ['2'] : /"id" DESC/.test(query) ? ['3', '2', '1'] : ['1', '2', '3'];
    return [{ columns: [{ name: 'id', type: 'bigint' }], data: ids.map((id) => [id]) }];
  });
  await strictFixture(
    createTrinoConnector({ fetch: boundary.wrap(fake.fetcher, 'fetch'), network: boundary.wrap(network()) }),
    contextFor(),
    { kind: 'object', object: { schema: 'sales', name: 'orders' } },
    ['id'],
    3,
    boundary,
  );
});
