import { FixtureBoundary } from '../contract/boundary.test-support.js';
import { contractAdapter } from '../contract/adapter.js';
import { strictFixture } from '../contract/strict.test-support.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  SourceConnection,
  HTTP_ENGINE_KINDS,
  isHttpEngineConnection,
  requiredSecrets,
} from '@riosoma/contracts';
import { createHttpEngineConnector } from './index.js';
import { EngineHttp, record } from './http.js';
import { csvRows, fluxPreview, GraphMetricsSession, readCypher, readFlux } from './graph-metrics.js';
import { SearchSession, engineColumn, elasticFilter, searchFilter } from './search.js';
import { cellOf, keyPartOf } from '../warehouses/values.js';
import { planLive, translateRule } from '../live/translate.js';
import { liveKeys, liveMatching, liveRows, type LiveTarget } from '../live/reader.js';
import { nativeRows, searchKeys, searchRows } from './reader.js';
import { registerConnector, sourceKey } from '../registry.js';
import { analyticsHost } from '../warehouses/index.js';
import { ConnectorError, type ConnectorContext } from '../types.js';

const endpoint = () => `https://${randomUUID()}.invalid`;
const secret = () => randomBytes(24).toString('base64url');
const connection = (kind: string, extra: object = {}) =>
  SourceConnection.parse({
    kind,
    endpoint: endpoint(),
    auth: 'none',
    database: 'readings',
    query: 'up',
    ...extra,
  });
const object = { kind: 'object' as const, object: { schema: null, name: 'products' } };
const response = (value: unknown) => new Response(JSON.stringify(value));
const network = {
  proxied: () => true,
  resolve: async () => {},
  connect: async () => {},
  handshake: async () => {},
};

it.each(['elasticsearch', 'opensearch', 'meilisearch', 'typesense'] as const)(
  'reports objects and key candidates through the public %s adapter',
  async (kind) => {
    const connector = createHttpEngineConnector(kind, {
      network,
      fetch: async (url) => {
        const path = new URL(url).pathname;
        if (path === '/_alias') return response({ products: { aliases: {} } });
        if (path === '/collections') return response([{ name: 'products', num_documents: 3 }]);
        if (path === '/indexes') return response({ results: [{ uid: 'products' }] });
        return response({ primaryKey: 'id' });
      },
    });
    const ctx = { connection: connection(kind), secrets: {} };
    expect(await connector.listObjects(ctx)).toContainEqual(expect.objectContaining({ name: 'products' }));
    expect((await connector.keyCandidates(ctx, object.object))[0]?.length).toBeGreaterThan(0);
  },
);

describe('HTTP engine contracts and authentication', () => {
  it.each(HTTP_ENGINE_KINDS)('validates %s settings without credentials in the address', (kind) => {
    const parsed = connection(kind);
    expect(parsed.kind).toBe(kind);
    expect(
      SourceConnection.safeParse({
        ...parsed,
        endpoint: `https://reader:${secret()}@${randomUUID()}.invalid`,
      }).success,
    ).toBe(false);
  });

  it.each([
    ['elasticsearch', 'api-key', 'apiKey'],
    ['opensearch', 'basic', 'password'],
    ['meilisearch', 'api-key', 'apiKey'],
    ['typesense', 'api-key', 'apiKey'],
    ['neo4j', 'basic', 'password'],
    ['influxdb', 'token', 'token'],
    ['prometheus', 'token', 'token'],
  ])('sends %s credentials using its protocol', async (kind, auth, key) => {
    const value = secret();
    const settings = connection(kind!, { auth, user: 'reader' });
    expect(requiredSecrets(settings)).toContain(key);
    const fetch = vi.fn(async () => response({}));
    const http = new EngineHttp({ connection: settings, secrets: { [key!]: value } }, { fetch });
    await http.json('/status');
    const init = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init[1].headers);
    expect(headers.get(kind === 'typesense' ? 'x-typesense-api-key' : 'authorization')).toBe(
      kind === 'typesense'
        ? value
        : auth === 'basic'
          ? `Basic ${Buffer.from(`reader:${value}`).toString('base64')}`
          : `${kind === 'influxdb' ? 'Token' : kind === 'elasticsearch' ? 'ApiKey' : 'Bearer'} ${value}`,
    );
    expect(init[1].redirect).toBe('error');
    await http.close();
  });

  it('signs the path, query, payload, and session token for OpenSearch', async () => {
    const secrets = { accessKeyId: secret(), secretAccessKey: secret(), sessionToken: secret() };
    const fetch = vi.fn(async () => response({}));
    const http = new EngineHttp(
      { connection: connection('opensearch', { auth: 'aws-sigv4', region: 'us-west-2' }), secrets },
      { fetch },
    );
    await http.json('/_search?pretty=false', { size: 1 });
    const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(call[1].headers);
    expect(headers.get('authorization')).toContain('/us-west-2/es/aws4_request');
    expect(headers.get('authorization')).toContain('x-amz-security-token');
    expect(headers.get('x-amz-security-token')).toBe(secrets.sessionToken);
    expect(headers.get('x-amz-content-sha256')).toMatch(/^[a-f0-9]{64}$/);
    await http.close();
  });

  it('gives the host its address names, so the private-network rule can check it', () => {
    for (const kind of HTTP_ENGINE_KINDS) {
      const settings = connection(kind);
      if (!isHttpEngineConnection(settings)) throw new Error('An engine connection is expected');
      expect(settings.kind).toBe(kind);
      expect(analyticsHost(settings)).toBe(new URL(settings.endpoint).hostname);
    }
    expect(
      analyticsHost(connection('elasticsearch', { endpoint: 'https://search.internal:9200/base' })),
    ).toBe('search.internal');
  });

  it('stops the diagnostic ladder on rejected credentials without returning the response body', async () => {
    const token = secret();
    const connector = createHttpEngineConnector('elasticsearch', {
      network,
      fetch: async () => new Response(token, { status: 401 }),
    });
    const result = await connector.test({
      connection: connection('elasticsearch'),
      secrets: { apiKey: token },
    });
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      status: 'failed',
      messageKey: 'sources.test.authenticate',
    });
    expect(JSON.stringify(result)).not.toContain(token);
  });
});

describe('search snapshots', () => {
  it('preserves wide integer keys and nested JSON numbers without rounding', async () => {
    const digits = (2n ** 63n - 1n).toString();
    const http = new EngineHttp(
      { connection: connection('elasticsearch'), secrets: {} },
      {
        fetch: async () => new Response(`{"id":${digits},"details":{"wide":${digits}}}`),
      },
    );
    const row = record(await http.json('/sample'));
    const column = engineColumn('id', 'long');
    expect(keyPartOf(row.id, column)).toBe(digits);
    expect(cellOf(row.id, 'text', column)).toBe(digits);
    expect(cellOf(row.id, 'number', column)).toBe(Number(digits));
    expect(cellOf(row.details, 'json', engineColumn('details', 'object'))).toBe(`{"wide":${digits}}`);
    await http.close();
  });

  it.each(['elasticsearch', 'opensearch'] as const)(
    'pages %s with a point in time and releases the newest handle',
    async (kind) => {
      const calls: Array<{ path: string; body: Record<string, unknown>; method: string | undefined }> = [];
      const fetch = vi.fn(async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
        calls.push({ path, body, method: init.method });
        if (init.method === 'DELETE') return response({ succeeded: true });
        if (path !== '/_search')
          return response(kind === 'elasticsearch' ? { id: 'first' } : { pit_id: 'first' });
        const second = Boolean(body.search_after);
        return response({
          pit_id: 'latest',
          hits: {
            hits: second
              ? []
              : [{ _index: 'products', _id: '1', _source: { name: 'One', nested: { a: 2 } }, sort: [1] }],
          },
        });
      });
      const session = new SearchSession(
        new EngineHttp({ connection: connection(kind), secrets: {} }, { fetch }),
      );
      const rows = [];
      for await (const page of session.pages(object, 1)) rows.push(...page);
      expect(rows).toEqual([{ name: 'One', nested: { a: 2 }, _index: 'products', _id: '1' }]);
      expect(calls[2]!.body.search_after).toEqual([1]);
      expect(calls[2]!.body.pit).toMatchObject({ id: 'latest' });
      expect(calls.at(-1)).toMatchObject({
        method: 'DELETE',
        body: kind === 'elasticsearch' ? { id: 'latest' } : { pit_id: ['latest'] },
      });
      await session.close();
    },
  );

  it('closes the point in time when a consumer stops early or a shard fails', async () => {
    for (const failed of [false, true]) {
      const methods: string[] = [];
      const session = new SearchSession(
        new EngineHttp(
          { connection: connection('elasticsearch'), secrets: {} },
          {
            fetch: async (url, init) => {
              methods.push(init.method!);
              if (init.method === 'DELETE') return response({});
              if (new URL(url).pathname !== '/_search') return response({ id: 'handle' });
              return response({
                _shards: { failed: failed ? 1 : 0 },
                hits: { hits: [{ _id: '1', _index: 'products', _source: {}, sort: [1] }] },
              });
            },
          },
        ),
      );
      const read = async () => {
        for await (const _page of session.pages(object, 1)) break;
      };
      if (failed) await expect(read()).rejects.toMatchObject({ messageKey: 'sources.engines.partial' });
      else await read();
      expect(methods.at(-1)).toBe('DELETE');
      await session.close();
    }
  });

  it('ties a page by the point in time’s own position, which needs no document values', async () => {
    const sorts: unknown[] = [];
    const session = new SearchSession(
      new EngineHttp(
        { connection: connection('opensearch'), secrets: {} },
        {
          fetch: async (url, init) => {
            if (init.method === 'DELETE') return response({});
            if (new URL(url).pathname !== '/_search') return response({ pit_id: 'handle' });
            sorts.push((JSON.parse(String(init.body)) as { sort: unknown[] }).sort);
            return response({ hits: { hits: [] } });
          },
        },
      ),
    );
    for await (const _rows of session.pages(object, 10, {
      order: [{ column: 'amount', direction: 'desc' }],
    }))
      continue;
    expect(sorts[0]).toEqual([{ amount: { order: 'desc', missing: '_last' } }, '_shard_doc']);
    await session.close();
  });

  it('lists indexes and aliases and preserves declared object and location fields', async () => {
    const session = new SearchSession(
      new EngineHttp(
        { connection: connection('elasticsearch'), secrets: {} },
        {
          fetch: async (url, init) => {
            const path = new URL(url).pathname;
            if (init.method === 'DELETE') return response({});
            if (path === '/products/_pit') return response({ id: 'sample' });
            if (path === '/_search') return response({ hits: { hits: [] } });
            return response(
              path === '/_alias'
                ? { products: { aliases: { current: {} } } }
                : {
                    products: {
                      mappings: {
                        properties: {
                          title: { type: 'keyword' },
                          count: { type: 'long' },
                          position: { type: 'geo_point' },
                          nested: { type: 'nested' },
                          details: { properties: { child: { type: 'text' } } },
                        },
                      },
                    },
                  },
            );
          },
        },
      ),
    );
    expect((await session.list()).map((o) => o.name)).toEqual(['products', 'current']);
    const columns = await session.describe(object);
    expect(columns.find((c) => c.column.name === 'nested')?.column.suggested?.type).toBe('json');
    expect(columns.find((c) => c.column.name === 'details')?.column.suggested?.type).toBe('json');
    expect(columns.find((c) => c.column.name === 'position')?.column.suggested?.type).toBe('location');
    expect(cellOf([12, 34], 'location', engineColumn('position', 'geo_point'))).toEqual({
      lng: 12,
      lat: 34,
      label: null,
    });
    expect(cellOf({ lat: 34, lon: 12 }, 'location', engineColumn('position', 'geo_point'))).toEqual({
      lng: 12,
      lat: 34,
      label: null,
    });
    expect(cellOf([34, 12], 'location', engineColumn('position', 'geopoint'))).toEqual({
      lng: 12,
      lat: 34,
      label: null,
    });
    await session.close();
  });

  it('reads point text and geohashes as locations and refuses invalid coordinates', () => {
    const column = engineColumn('position', 'geo_point');
    for (const value of ['POINT (12 34)', '34,12', { type: 'Point', coordinates: [12, 34] }])
      expect(cellOf(value, 'location', column)).toEqual({ lat: 34, lng: 12, label: null });
    expect(cellOf('s', 'location', column)).toEqual({ lat: 22.5, lng: 22.5, label: null });
    expect(() => cellOf([181, 34], 'location', column)).toThrow();
  });

  it('pages all Meilisearch documents and pushes its filter to the documents endpoint', async () => {
    const offsets: number[] = [];
    const session = new SearchSession(
      new EngineHttp(
        { connection: connection('meilisearch'), secrets: {} },
        {
          fetch: async (_url, init) => {
            const body = JSON.parse(String(init.body)) as { offset: number; filter: string };
            offsets.push(body.offset);
            expect(body.filter).toContain('count >= 2');
            return response({ results: body.offset ? [] : [{ id: 'a', count: 2 }], total: 1 });
          },
        },
      ),
    );
    const rows = [];
    for await (const page of session.pages({ ...object, nativeFilter: 'count >= 2' }, 1)) rows.push(...page);
    expect(rows).toHaveLength(1);
    expect(offsets).toEqual([0, 1]);
    await session.close();
  });

  it('sends Typesense filters and refuses incomplete search results', async () => {
    const session = new SearchSession(
      new EngineHttp(
        { connection: connection('typesense'), secrets: {} },
        {
          fetch: async (url) => {
            expect(new URL(url).searchParams.get('filter_by')).toContain('count:>=2');
            return response({ found: 3, hits: [{ document: { id: '1', count: 2 } }], search_cutoff: false });
          },
        },
      ),
    );
    await expect(
      (async () => {
        for await (const _rows of session.pages(object, 10, {
          where: { op: 'gte', column: 'count', value: 2 },
        })) {
          /* Consume every page to check completion */
        }
      })(),
    ).rejects.toMatchObject({ messageKey: 'sources.engines.paging' });
    await session.close();
  });
});

describe('graph and metrics responses', () => {
  it.each([
    'MATCH (n) DELETE n',
    'CALL db.labels()',
    'RETURN 1; CREATE (n)',
    'MATCH (n) SET n.x=1',
    'LOAD CSV FROM "x" AS row RETURN row',
  ])('refuses mutating or procedural Cypher %s', (query) => {
    expect(() => readCypher(query)).toThrow();
  });
  it('allows quoted property values and pure Flux while refusing writes and imported requests', () => {
    expect(readCypher('MATCH (n) WHERE n.name = "CREATE" RETURN n')).toContain('RETURN n');
    expect(
      readFlux('from(bucket: "metrics") |> range(start: -1h) |> filter(fn: (r) => r.x == "to")'),
    ).toContain('from');
    expect(() => readFlux('from(bucket: "metrics") |> to(bucket: "other")')).toThrow();
    expect(() => readFlux('import "http"\nhttp.get(url: "x")')).toThrow();
    expect(() => readFlux('from(bucket: "${to(bucket: \\"other\\")}")')).toThrow();
  });
  it('reads typed annotated CSV with repeated headers, defaults, commas, and embedded newlines', () => {
    const csv =
      '#datatype,string,long,dateTime:RFC3339,double,string\n#default,_result,,,,\n,result,table,_time,_value,room\n,,0,2026-01-01T00:00:00Z,2.5,"a,b\nc"\n\n#datatype,string,long,dateTime:RFC3339,double,string\n,result,table,_time,_value,room\n,,1,2026-01-01T00:01:00Z,3,second\n';
    expect(csvRows(csv)).toEqual([
      { _time: '2026-01-01T00:00:00Z', _value: 2.5, room: 'a,b\nc' },
      { _time: '2026-01-01T00:01:00Z', _value: 3, room: 'second' },
    ]);
    expect(() => csvRows(',error,reference\n,failed,123\n')).toThrow();
  });
  it('runs a person’s Flux query as written, with no second window over an aggregate', () => {
    expect(fluxPreview('from(bucket: "readings") |> range(start: -30d) |> mean()', 5)).toBe(
      'from(bucket: "readings") |> range(start: -30d) |> mean() |> limit(n: 5)',
    );
    expect(fluxPreview('from(bucket: "readings") |> range(start: -30d) |> yield()', 5)).toBe(
      'from(bucket: "readings") |> range(start: -30d) |> yield()',
    );
    expect(fluxPreview('from(bucket: "readings") |> range(start: -30d)')).toBe(
      'from(bucket: "readings") |> range(start: -30d)',
    );
  });
  it('reads a person’s Flux query with its own range and lists tables from the queried database', async () => {
    const statements: string[] = [];
    const session = new GraphMetricsSession(
      new EngineHttp(
        {
          connection: connection('influxdb', {
            organization: 'readers',
            start: '2026-01-01T00:00:00Z',
            end: '2026-01-02T00:00:00Z',
          }),
          secrets: {},
        },
        {
          fetch: async (_url, init) => {
            const { query } = JSON.parse(String(init.body)) as { query: string };
            statements.push(query);
            return new Response(
              '#datatype,string,long,dateTime:RFC3339,double\n,result,table,_time,_value\n,,0,2026-01-01T00:00:00Z,2.5\n',
            );
          },
        },
      ),
    );
    const written = 'from(bucket: "readings") |> range(start: -30d) |> mean()';
    for await (const rows of session.rows({ kind: 'query', sql: written }, [], 10, 5))
      expect(rows[0]!._value).toBe(2.5);
    expect(statements[0]).toBe(`${written} |> limit(n: 5)`);
    await session.close();
    const sql = new GraphMetricsSession(
      new EngineHttp(
        { connection: connection('influxdb', { version: '3' }), secrets: {} },
        {
          fetch: async (_url, init) => {
            const body = JSON.parse(String(init.body)) as { db: string; q: string };
            statements.push(body.q);
            expect(body.db).toBe('readings');
            return response([{ table_name: 'products' }]);
          },
        },
      ),
    );
    expect(await sql.list()).toEqual([{ schema: null, name: 'products', type: 'table', rowEstimate: null }]);
    // The request names the database, so a schema name in the statement would only risk missing
    // the tables the engine lists under another one.
    expect(statements.at(-1)).toBe('SELECT table_name FROM information_schema.tables');
    await sql.close();
  });
  it('quotes a catalog node label safely and reads its outgoing relationships', async () => {
    const session = new GraphMetricsSession(
      new EngineHttp(
        { connection: connection('neo4j'), secrets: {} },
        {
          fetch: async (_url, init) => {
            const body = JSON.parse(String(init.body)) as {
              accessMode: string;
              statement: string;
              parameters: Record<string, unknown>;
            };
            expect(body.accessMode).toBe('Read');
            if (body.statement.startsWith('CALL db.labels'))
              return response({ data: { fields: ['label'], values: [['We`ird\\name']] } });
            expect(body.statement).toContain('MATCH (n:`We``ird\\u005cname`)');
            expect(body.statement).toContain('elementId(n) > $after');
            return response({
              data: {
                fields: ['properties', '_id', '_relationships'],
                values: [[{ name: 'A' }, 'node-a', [{ type: 'OWNS', labels: ['Asset'], id: 'node-b' }]]],
              },
            });
          },
        },
      ),
    );
    const rows = [];
    for await (const page of session.rows(
      { kind: 'object', object: { schema: null, name: 'We`ird\\name' } },
      [],
      10,
      1,
    ))
      rows.push(...page);
    expect(rows).toEqual([{ name: 'A', _id: 'node-a', '_links.OWNS.Asset': ['node-b'] }]);
    await session.close();
  });
  it('bounds InfluxDB 3 SQL queries to the time range without duplicating aliases', async () => {
    const queries: string[] = [];
    const session = new GraphMetricsSession(
      new EngineHttp(
        {
          connection: connection('influxdb', {
            version: '3',
            start: '2026-01-01T00:00:00Z',
            end: '2026-01-02T00:00:00Z',
          }),
          secrets: {},
        },
        {
          fetch: async (_url, init) => {
            const body = JSON.parse(String(init.body)) as { q: string };
            queries.push(body.q);
            return response([{ time: '2026-01-01T01:00:00Z', amount: 25 }]);
          },
        },
      ),
    );
    for await (const _rows of session.rows(
      { kind: 'query', sql: 'SELECT * FROM "readings" ORDER BY "amount" DESC' },
      [],
      10,
      5,
    ))
      continue;
    expect(queries[0]).not.toContain(') AS q) AS rio_source');
    expect(queries[0]).toContain("WHERE time >= '2026-01-01T00:00:00Z' AND time < '2026-01-02T00:00:00Z'");
    expect(queries[0]).toContain('ORDER BY "amount" DESC LIMIT 5');
    await session.close();
  });
  it('bounds InfluxDB 3 SQL to the configured time range', async () => {
    const session = new GraphMetricsSession(
      new EngineHttp(
        {
          connection: connection('influxdb', {
            version: '3',
            start: '2026-01-01T00:00:00Z',
            end: '2026-01-02T00:00:00Z',
          }),
          secrets: {},
        },
        {
          fetch: async (url, init) => {
            expect(new URL(url).pathname).toBe('/api/v3/query_sql');
            const body = JSON.parse(String(init.body)) as { q: string; format: string };
            if (body.q === 'SELECT table_name FROM information_schema.tables')
              return response([{ table_name: 'products' }]);
            expect(body.q).toContain("time >= '2026-01-01T00:00:00Z'");
            expect(body.q).toContain("time < '2026-01-02T00:00:00Z'");
            expect(body.format).toBe('json');
            return response([{ time: '2026-01-01T01:00:00.000000001Z', value: 3 }]);
          },
        },
      ),
    );
    const columns = await session.describe(object);
    expect(columns.find((c) => c.column.name === 'time')?.column.suggested?.type).toBe('date');
    expect(columns.find((c) => c.column.name === '_timeKey')?.column.suggested?.type).toBe('text');
    for await (const rows of session.rows(object, columns, 10, 1))
      expect(rows[0]!._timeKey).toBe('2026-01-01T01:00:00.000000001Z');
    await session.close();
  });
  it('reads InfluxDB 2 measurements with the configured time bounds and exact timestamp keys', async () => {
    const statements: string[] = [];
    const session = new GraphMetricsSession(
      new EngineHttp(
        {
          connection: connection('influxdb', {
            version: '2',
            organization: 'readers',
            start: '2026-01-01T00:00:00Z',
            end: '2026-01-02T00:00:00Z',
          }),
          secrets: {},
        },
        {
          fetch: async (url, init) => {
            expect(new URL(url).pathname).toBe('/api/v2/query');
            expect(new URL(url).searchParams.get('org')).toBe('readers');
            expect(new Headers(init.headers).get('accept')).toBe('application/csv');
            const { query } = JSON.parse(String(init.body)) as { query: string };
            statements.push(query);
            return new Response(
              query.includes('schema.measurements')
                ? '#datatype,string,long,string\n,result,table,_value\n,,0,products\n'
                : '#datatype,string,long,dateTime:RFC3339,double,string\n,result,table,_time,value,room\n,,0,2026-01-01T00:00:00.000000001Z,2.5,office\n',
            );
          },
        },
      ),
    );
    expect(await session.list()).toEqual([
      { schema: null, name: 'products', type: 'table', rowEstimate: null },
    ]);
    const columns = await session.describe(object);
    expect(columns.find((c) => c.column.name === '_time')?.column.suggested?.type).toBe('date');
    expect(columns.find((c) => c.column.name === '_timeKey')?.column.suggested?.type).toBe('text');
    expect(statements[1]).toContain('schema.measurements');
    expect(statements[2]).toContain('pivot(');
    // The read is bounded by the window.  The catalog question that names a measurement is not: a
    // measurement with no points in the window still exists, and reads as nothing.
    expect(statements[1]).toContain('start: time(v: 0)');
    expect(statements.filter((query) => query.includes('from(bucket:'))).toEqual([statements[2]]);
    expect(statements[2]).toContain(
      'range(start: time(v: "2026-01-01T00:00:00Z"), stop: time(v: "2026-01-02T00:00:00Z"))',
    );
    expect(statements[2]).toContain('r._measurement == "products"');
    await session.close();
  });
  it('flattens Prometheus series labels and keeps a stable series key', async () => {
    const session = new GraphMetricsSession(
      new EngineHttp(
        {
          connection: connection('prometheus', {
            start: '2026-01-01T00:00:00Z',
            end: '2026-01-01T00:01:00Z',
          }),
          secrets: {},
        },
        {
          fetch: async (url) => {
            expect(new URL(url).searchParams.get('step')).toBe('60');
            return response({
              status: 'success',
              data: {
                resultType: 'matrix',
                result: [
                  {
                    metric: { job: 'service', time: 'label' },
                    values: [
                      [1767225600, '2'],
                      [1767225660, 'NaN'],
                    ],
                  },
                ],
              },
            });
          },
        },
      ),
    );
    const rows = [];
    for await (const page of session.rows(object, [], 10)) rows.push(...page);
    expect(rows[0]).toMatchObject({
      'label.job': 'service',
      'label.time': 'label',
      time: '2026-01-01T00:00:00.000Z',
      value: 2,
    });
    expect(rows[1]!.value).toBeNull();
    expect(rows[0]!._series).toBe(rows[1]!._series);
    await session.close();
  });
});

describe('search live access rules', () => {
  it('uses the reader’s local day boundaries for date filters across daylight saving time', () => {
    const field = {
      id: 'when',
      type: 'date',
      options: { includeTime: true, timeZone: 'America/New_York' },
      source: { column: 'when', sourceType: 'date' },
    };
    const plan = planLive({
      dialect: 'elasticsearch',
      fields: new Map([[field.id, field]]),
      filter: {
        conjunction: 'and',
        conditions: [
          { id: 'day', fieldId: field.id, operator: 'is', value: { mode: 'exactDate', date: '2026-03-08' } },
        ],
      },
      sorts: [],
      rules: null,
      context: { now: new Date('2026-03-08T12:00:00Z'), timeZone: 'UTC' },
    });
    expect(plan.where?.native).toEqual({
      op: 'and',
      args: [
        { op: 'gte', column: 'when', value: '2026-03-08T05:00:00.000Z', format: 'strict_date_optional_time' },
        { op: 'lt', column: 'when', value: '2026-03-09T04:00:00.000Z', format: 'strict_date_optional_time' },
      ],
    });
  });
  it('names a few dozen keys at most in one request, so an engine’s filter stays inside its limits', async () => {
    const widths: number[] = [];
    registerConnector({
      ...createHttpEngineConnector('typesense'),
      describe: async () => [engineColumn('id', 'string').column],
      search: async function* (_ctx, _select, request) {
        widths.push(request.where?.op === 'or' ? request.where.args.length : 1);
        yield [];
      },
    });
    try {
      const context: ConnectorContext = { connection: connection('typesense'), secrets: {} };
      const keys = Array.from({ length: 60 }, (_unused, at) => JSON.stringify([`id-${at}`]));
      await searchRows(
        { id: 'source', version: '1', kind: 'typesense', context, select: object, keyColumns: ['id'] },
        keys,
        [],
      );
      expect(widths.length).toBe(3);
      expect(Math.max(...widths)).toBeLessThanOrEqual(25);
    } finally {
      registerConnector(createHttpEngineConnector('typesense'));
    }
  });
  it('describes an engine once a minute, however many live reads ask for its columns', async () => {
    let describes = 0;
    registerConnector({
      ...createHttpEngineConnector('meilisearch'),
      describe: async () => {
        describes++;
        return [engineColumn('id', 'string').column, engineColumn('amount', 'double').column];
      },
      search: async function* () {
        yield [{ id: '1', amount: 2 }];
      },
    });
    try {
      const context: ConnectorContext = { connection: connection('meilisearch'), secrets: {} };
      const target = {
        id: 'cached-source',
        version: '1',
        kind: 'meilisearch' as const,
        context,
        select: object,
        keyColumns: ['id'],
      };
      const keys = await searchKeys(target, { where: null, order: [], limit: 10 });
      expect(keys.keys).toEqual([sourceKey(['1'])]);
      const rows = await searchRows(target, keys.keys, [{ id: 'fld', column: 'amount', type: 'number' }]);
      expect(rows.get(sourceKey(['1']))).toEqual({ fld: 2 });
      // An engine samples its documents to describe them, so one read may not sample three times.
      expect(describes).toBe(1);
    } finally {
      registerConnector(createHttpEngineConnector('meilisearch'));
    }
  });
  it('refuses a SQL predicate passed to a native search read', async () => {
    const context: ConnectorContext = { connection: connection('elasticsearch'), secrets: {} };
    await expect(
      searchKeys(
        { id: 'source', version: '1', kind: 'elasticsearch', context, select: object, keyColumns: ['_id'] },
        { where: { parts: ['FALSE'] }, order: [], limit: 10 },
      ),
    ).rejects.toMatchObject({ messageKey: 'sources.live.unsupported' });
  });

  it('answers a live read of keys, rows, and matches through the reader every kind shares', async () => {
    // A live table reads through one reader, which sends a search engine to its own native calls
    // instead of writing SQL for it.
    const widths: number[] = [];
    registerConnector({
      ...createHttpEngineConnector('typesense'),
      describe: async () => [engineColumn('id', 'string').column, engineColumn('amount', 'double').column],
      search: async function* (_ctx, _select, request) {
        widths.push(request.where?.op === 'or' ? request.where.args.length : 1);
        yield [{ id: '1', amount: 2 }];
      },
    });
    try {
      const context: ConnectorContext = { connection: connection('typesense'), secrets: {} };
      const target: LiveTarget = {
        id: 'shared-reader',
        version: '1',
        kind: 'typesense',
        context,
        select: object,
        keyColumns: ['id'],
      };
      const field = {
        id: 'amount',
        type: 'number',
        options: {},
        source: { column: 'amount', sourceType: 'double' },
      };
      const plan = planLive({
        dialect: 'typesense',
        fields: new Map([[field.id, field]]),
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'at-least', fieldId: field.id, operator: 'gte', value: 2 }],
        },
        sorts: [{ fieldId: field.id, direction: 'desc' }],
        rules: null,
        context: { now: new Date(), timeZone: 'UTC' },
      });
      const { keys } = await liveKeys(target, { where: plan.where, order: plan.order, limit: 10 });
      expect(keys).toEqual([sourceKey(['1'])]);
      const rows = await liveRows(target, keys, [{ id: 'fld', column: 'amount', type: 'number' }]);
      expect(rows.get(sourceKey(['1']))).toEqual({ fld: 2 });
      expect([...(await liveMatching(target, keys, plan.where!))]).toEqual([sourceKey(['1'])]);
      expect(widths).toEqual([1, 1, 1]);
    } finally {
      registerConnector(createHttpEngineConnector('typesense'));
    }
  });

  const field = {
    id: 'amount',
    type: 'number',
    options: {},
    source: { column: 'amount', sourceType: 'double' },
  };
  const fields = new Map([[field.id, field]]);
  const rule = {
    conjunction: 'and' as const,
    conditions: [{ id: 'amount-rule', fieldId: 'amount', operator: 'gte' as const, value: 5 }],
  };
  it.each(['elasticsearch', 'opensearch', 'meilisearch', 'typesense'] as const)(
    'pushes supported %s filters and sorts through the live plan',
    (kind) => {
      const plan = planLive({
        dialect: kind,
        fields,
        filter: rule,
        sorts: [{ fieldId: 'amount', direction: 'desc' }],
        rules: null,
        context: { now: new Date(), timeZone: 'UTC' },
      });
      expect(plan.where?.native).toEqual({ op: 'gte', column: 'amount', value: 5 });
      expect(plan.order[0]?.nativeOrder).toEqual({ column: 'amount', direction: 'desc' });
      expect(elasticFilter(plan.where!.native!)).toEqual({ range: { amount: { gte: 5 } } });
      if (kind === 'meilisearch' || kind === 'typesense')
        expect(searchFilter(plan.where!.native!, kind)).toContain(
          kind === 'typesense' ? 'amount:>=5' : 'amount >= 5',
        );
    },
  );
  it('matches no records for an unsupported rule and never contacts the source', async () => {
    const local = new Map([['amount', { ...field, source: undefined }]]);
    const where = translateRule(rule, local, 'elasticsearch', { now: new Date(), timeZone: 'UTC' });
    expect(where.native).toEqual({ op: 'false' });
    const search = vi.fn();
    registerConnector({ ...createHttpEngineConnector('elasticsearch'), search });
    const context: ConnectorContext = { connection: connection('elasticsearch'), secrets: {} };
    expect(
      await nativeRows(
        { id: 'source', version: '1', kind: 'elasticsearch', context, select: object, keyColumns: ['_id'] },
        where.native!,
      ),
    ).toEqual([]);
    expect(search).not.toHaveBeenCalled();
    registerConnector(createHttpEngineConnector('elasticsearch'));
  });
});

it.each(['elasticsearch', 'opensearch', 'meilisearch', 'typesense'] as const)(
  'runs every declared capability against the %s protocol fixture',
  async (kind) => {
    const boundary = new FixtureBoundary();
    const rows = [1, 2, 3].map((id) => ({ id: `item-${id}`, amount: id }));
    const fetcher = async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      const path = parsed.pathname;
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      if (init.method === 'DELETE') return response({ succeeded: true });
      if (path === '/_alias') return response({ products: { aliases: {} } });
      if (path.endsWith('/_mapping'))
        return response({
          products: { mappings: { properties: { id: { type: 'keyword' }, amount: { type: 'integer' } } } },
        });
      if (path.includes('_pit') || path.endsWith('/point_in_time'))
        return response({ id: 'fixture', pit_id: 'fixture' });
      if (path === '/collections') return response([{ name: 'products', num_documents: 3 }]);
      if (path === '/collections/products') return response({ fields: [{ name: 'amount', type: 'int32' }] });
      if (path === '/indexes') return response({ results: [{ uid: 'products' }] });
      if (path === '/indexes/products') return response({ primaryKey: 'id' });
      if (path.endsWith('/settings/pagination')) return response({ maxTotalHits: 1000 });
      const filter = JSON.stringify(body.query ?? body.filter ?? parsed.searchParams.get('filter_by') ?? '');
      const order = JSON.stringify(body.sort ?? parsed.searchParams.get('sort_by') ?? '');
      const filtered = filter.includes('2') ? rows.slice(1, 2) : rows;
      const selected = order.includes('desc') ? [...filtered].reverse() : filtered;
      const offset = Number(
        (body.search_after as number[] | undefined)?.[0] ??
          body.offset ??
          parsed.searchParams.get('offset') ??
          0,
      );
      const count = Number(body.size ?? body.limit ?? parsed.searchParams.get('per_page') ?? 1000);
      const page = selected.slice(offset, offset + count);
      if (path === '/_search')
        return response({
          hits: {
            hits: page.map((row, index) => ({
              _source: row,
              _id: row.id,
              _index: 'products',
              sort: [offset + index + 1],
            })),
          },
        });
      if (kind === 'meilisearch')
        return response({
          results: page,
          hits: page,
          total: selected.length,
          estimatedTotalHits: selected.length,
        });
      return response({ hits: page.map((document) => ({ document })), found: selected.length });
    };
    const connector = createHttpEngineConnector(kind, { network, fetch: boundary.wrap(fetcher, 'fetch') });
    await strictFixture(
      connector,
      { connection: connection(kind), secrets: { apiKey: secret() } },
      object,
      kind === 'elasticsearch' || kind === 'opensearch' ? ['_index', '_id'] : ['id'],
      3,
      boundary,
    );
  },
);

it('never picks _id for Elasticsearch sort pushdown and rejects explicit _id sorts cleanly', async () => {
  const boundary = new FixtureBoundary();
  const rows = [
    { id: 1, name: 'Alpha', amount: 10 },
    { id: 2, name: 'Bravo', amount: 30 },
    { id: 3, name: 'Charlie', amount: 20 },
  ];
  const requests: string[] = [];
  const esConnector = createHttpEngineConnector('elasticsearch', {
    fetch: boundary.wrap(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const bodyText = String(init.body ?? '');
      requests.push(`${init.method ?? 'GET'} ${path} ${bodyText}`);
      const body = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
      if (init.method === 'DELETE') return response({ succeeded: true });
      if (path === '/_alias') return response({ products: { aliases: {} } });
      if (path.endsWith('/_mapping'))
        return response({
          products: {
            mappings: {
              properties: {
                id: { type: 'integer' },
                name: { type: 'keyword' },
                amount: { type: 'double' },
              },
            },
          },
        });
      if (path.includes('_pit')) return response({ id: 'fixture' });
      if (path === '/_search') {
        const sort = (body.sort ?? []) as Array<Record<string, { order?: 'asc' | 'desc' }> | string>;
        const primary = sort.find(
          (item): item is Record<string, { order?: 'asc' | 'desc' }> => typeof item === 'object',
        );
        if (primary && ('_id' in primary || '_index' in primary)) {
          return new Response(
            JSON.stringify({
              error: { type: 'illegal_argument_exception', reason: 'Fielddata is disabled on [_id]' },
            }),
            { status: 400 },
          );
        }
        const sorted = [...rows];
        if (primary) {
          const [col, spec] = Object.entries(primary)[0]!;
          sorted.sort((a, b) => {
            const av = a[col as keyof typeof a];
            const bv = b[col as keyof typeof b];
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return spec.order === 'desc' ? -cmp : cmp;
          });
        }
        const offset = Number((body.search_after as number[] | undefined)?.[0] ?? 0);
        const count = Number(body.size ?? 1000);
        const page = sorted.slice(offset, offset + count);
        return response({
          hits: {
            hits: page.map((row, index) => ({
              _source: row,
              _id: String(row.id),
              _index: 'products',
              sort: [offset + index + 1],
            })),
          },
        });
      }
      return response({});
    }, 'fetch'),
  });
  const ctx: ConnectorContext = { connection: connection('elasticsearch'), secrets: {} };
  const preview = await esConnector.preview(ctx, object, 10);
  const columns = preview.columns.filter((col) => col.suggested);
  const index = (name: string) => preview.columns.findIndex((col) => col.name === name);
  const adapter = contractAdapter({
    connector: esConnector,
    context: ctx,
    select: object,
    columns,
    keys: [['_index', '_id']],
    read: {
      columns: columns.map((col) => col.name),
      keyColumns: ['_index', '_id'],
      batchSize: 1,
      types: Object.fromEntries(columns.map((col) => [col.name, col.suggested!.type])),
    },
    expectedRows: preview.rows.map((row) => ({
      key: JSON.stringify([row[index('_index')], row[index('_id')]]),
      values: Object.fromEntries(columns.map((col) => [col.name, row[index(col.name)] ?? null])),
    })),
    requests: () => requests,
    failure: async () => {
      throw new ConnectorError('sources.engines.request', undefined, { status: 500 });
    },
  });
  expect(adapter.sort?.requestIncludes).not.toContain('_id');
  expect(adapter.sort?.requestIncludes).not.toContain('_index');
  const sortResult = await adapter.sort!.run(ctx);
  expect(sortResult.rows).toEqual(adapter.sort!.expectedRows);
  for (const col of ['_id', '_index']) {
    const plan = planLive({
      dialect: 'elasticsearch',
      fields: new Map([
        ['meta', { id: 'meta', type: 'text', options: {}, source: { column: col, sourceType: 'keyword' } }],
      ]),
      filter: null,
      sorts: [{ fieldId: 'meta', direction: 'desc' }],
      rules: null,
      context: { now: new Date(), timeZone: 'UTC' },
    });
    expect(plan.order).toEqual([]);
    expect(plan.skipped).toEqual([{ part: 'sort', fieldId: 'meta', reason: 'unsupported' }]);
  }
  const osPlan = planLive({
    dialect: 'opensearch',
    fields: new Map([
      ['meta', { id: 'meta', type: 'text', options: {}, source: { column: '_id', sourceType: 'keyword' } }],
    ]),
    filter: null,
    sorts: [{ fieldId: 'meta', direction: 'desc' }],
    rules: null,
    context: { now: new Date(), timeZone: 'UTC' },
  });
  expect(osPlan.order[0]?.nativeOrder).toEqual({ column: '_id', direction: 'desc' });
  await expect(
    (async () => {
      for await (const _batch of esConnector.search!(ctx, object, {
        where: { op: 'true' },
        order: [{ column: '_id', direction: 'desc' }],
        limit: 10,
      }))
        continue;
    })(),
  ).rejects.toMatchObject({ messageKey: 'sources.live.unsupported' });
});

it('excludes unsortable Typesense columns from sorting and rejects explicit unsortable sorts cleanly', async () => {
  const boundary = new FixtureBoundary();
  const rows = [
    { id: 'item-1', title: 'Zeta', count: 3, tags: ['x'], amount: 10 },
    { id: 'item-2', title: 'Alpha', count: 1, tags: ['y'], amount: 30 },
    { id: 'item-3', title: 'Mu', count: 2, tags: ['z'], amount: 20 },
  ];
  const requests: string[] = [];
  const tsConnector = createHttpEngineConnector('typesense', {
    fetch: boundary.wrap(async (url: string) => {
      const parsed = new URL(url);
      const path = parsed.pathname;
      requests.push(`${path}${parsed.search}`);
      if (path === '/collections') return response([{ name: 'products', num_documents: rows.length }]);
      if (path === '/collections/products')
        return response({
          fields: [
            // `string` without `sort: true`, `int32` with `sort: false`, and `string[]` are all unsortable.
            { name: 'title', type: 'string' },
            { name: 'count', type: 'int32', sort: false },
            { name: 'tags', type: 'string[]' },
            { name: 'amount', type: 'float', sort: true },
          ],
        });
      if (path === '/collections/products/documents/search') {
        const sortBy = parsed.searchParams.get('sort_by') ?? '';
        if (sortBy) {
          const [col, dir] = sortBy.split(':');
          if (col !== 'amount')
            return new Response(
              JSON.stringify({
                message: `Could not find a field named \`${col}\` in the schema for sorting.`,
              }),
              { status: 400 },
            );
          const sorted = [...rows].sort((a, b) =>
            dir === 'desc' ? b.amount - a.amount : a.amount - b.amount,
          );
          return response({ hits: sorted.map((document) => ({ document })), found: sorted.length });
        }
        return response({ hits: rows.map((document) => ({ document })), found: rows.length });
      }
      return response({});
    }, 'fetch'),
  });
  const ctx: ConnectorContext = { connection: connection('typesense'), secrets: {} };
  const preview = await tsConnector.preview(ctx, object, 10);
  expect(preview.columns.map((col) => col.name)).toEqual(['amount', 'title', 'count', 'tags', 'id']);
  const columns = preview.columns.filter((col) => col.suggested);
  const index = (name: string) => preview.columns.findIndex((col) => col.name === name);
  const adapter = contractAdapter({
    connector: tsConnector,
    context: ctx,
    select: object,
    columns,
    keys: [['id']],
    read: {
      columns: columns.map((col) => col.name),
      keyColumns: ['id'],
      batchSize: 1,
      types: Object.fromEntries(columns.map((col) => [col.name, col.suggested!.type])),
    },
    expectedRows: preview.rows.map((row) => ({
      key: JSON.stringify([row[index('id')]]),
      values: Object.fromEntries(columns.map((col) => [col.name, row[index(col.name)] ?? null])),
    })),
    requests: () => requests,
    failure: async () => {
      throw new ConnectorError('sources.engines.request', undefined, { status: 500 });
    },
  });
  expect(adapter.sort?.requestIncludes).toContain('amount');
  expect(adapter.sort?.requestIncludes).not.toContain('id');
  expect(adapter.sort?.requestIncludes).not.toContain('title');
  const sortResult = await adapter.sort!.run(ctx);
  expect(sortResult.rows).toEqual(adapter.sort!.expectedRows);
  for (const [col, sourceType, fieldType] of [
    ['id', 'string', 'text'],
    ['tags', 'string[]', 'text'],
    ['wild', 'string*', 'text'],
    ['dyn', 'auto', 'text'],
    ['loc', 'geopoint', 'location'],
  ] as const) {
    const plan = planLive({
      dialect: 'typesense',
      fields: new Map([
        ['f', { id: 'f', type: fieldType, options: {}, source: { column: col, sourceType } }],
      ]),
      filter: null,
      sorts: [{ fieldId: 'f', direction: 'desc' }],
      rules: null,
      context: { now: new Date(), timeZone: 'UTC' },
    });
    expect(plan.order).toEqual([]);
    expect(plan.skipped).toEqual([{ part: 'sort', fieldId: 'f', reason: 'unsupported' }]);
  }
  const beforeSearch = requests.length;
  for (const col of ['id', 'title', 'count', 'tags', 'missing']) {
    await expect(
      (async () => {
        for await (const _batch of tsConnector.search!(ctx, object, {
          where: { op: 'true' },
          order: [{ column: col, direction: 'desc' }],
          limit: 10,
        }))
          continue;
      })(),
    ).rejects.toMatchObject({ messageKey: 'sources.live.unsupported' });
  }
  expect(requests.slice(beforeSearch).some((req) => req.includes('/documents/search'))).toBe(false);
});
