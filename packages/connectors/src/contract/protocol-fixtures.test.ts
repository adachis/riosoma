import { SourceConnection, type HttpEngineKind, type NoSqlKind } from '@riosoma/contracts';
import { expect, it } from 'vitest';
import { createNoSqlConnector } from '../nosql/connector.js';
import { createHttpEngineConnector } from '../http-engines/index.js';
import { createFileConnector } from '../files/connector.js';
import { FileNetworkError, type FileNetwork } from '../files/network.js';
import type { ConnectorContext } from '../types.js';
import { exerciseFixture } from './fixture.js';
import { FixtureBoundary } from './boundary.test-support.js';
import { strictFixture } from './strict.test-support.js';

const json = (value: unknown) => new Response(JSON.stringify(value));
const select = { kind: 'object' as const, object: { schema: null, name: 'items' } };
const rows = [1, 2, 3].map((id) => ({ id: String(id), title: `item-${id}` }));
const secret = ['fixture', 'password', '79438'].join('-');
const context = (kind: NoSqlKind | HttpEngineKind): ConnectorContext => ({
  connection: SourceConnection.parse({
    kind,
    endpoint: 'http://127.0.0.1:18000',
    database: 'fixture',
    projectId: 'fixture',
    region: 'us-east-1',
    emulator: true,
    segments: 1,
    user: 'reader',
    auth: kind === 'cosmosdb' ? 'entra' : 'none',
    query: 'up',
    version: '3',
    start: '2026-01-01T00:00:00Z',
    end: '2026-01-01T00:03:00Z',
  }),
  secrets: { password: secret, token: secret, accessKeyId: secret, secretAccessKey: secret },
  timeoutMs: 1000,
});

it.each(['dynamodb', 'couchdb', 'couchbase', 'firestore', 'cosmosdb'] as const)(
  'runs the shared fixture operations against %s protocol responses',
  async (kind) => {
    const fetcher = async (url: string, init: RequestInit) => {
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (kind === 'dynamodb') {
        const operation = new Headers(init.headers).get('x-amz-target')!.split('.').at(-1);
        if (operation === 'ListTables') return json({ TableNames: ['items'] });
        if (operation === 'DescribeTable')
          return json({
            Table: {
              KeySchema: [
                { AttributeName: 'tenant', KeyType: 'HASH' },
                { AttributeName: 'id', KeyType: 'RANGE' },
              ],
            },
          });
        const offset = body.ExclusiveStartKey
          ? Number((body.ExclusiveStartKey as { id: { S: string } }).id.S)
          : 0;
        const limit = Number(body.Limit ?? 1000);
        const values = Object.values(
          (body.ExpressionAttributeValues ?? {}) as Record<string, { S?: string }>,
        );
        const selected = values.some((value) => value.S === '2')
          ? rows.filter((row) => row.id === '2')
          : [...rows];
        if (body.ScanIndexForward === false) selected.reverse();
        const page = selected.slice(offset, offset + limit);
        return json({
          Items: page.map((row) => ({
            id: { S: row.id },
            title: { S: row.title },
            tenant: { S: 'fixture' },
          })),
          ...(offset + page.length < selected.length
            ? { LastEvaluatedKey: { id: { S: String(offset + page.length) } } }
            : {}),
        });
      }
      if (kind === 'couchdb') {
        if (url.endsWith('/_all_dbs')) return json(['items']);
        if (url.endsWith('/_find')) {
          const selector = JSON.stringify(body.selector);
          const selected = selector.includes('2') ? rows.filter((row) => row.id === '2') : [...rows];
          if (String(JSON.stringify(body.sort)).includes('desc')) selected.reverse();
          return json({ docs: selected.map((row) => ({ ...row, _id: row.id, _rev: '1' })) });
        }
        const offset = Number(new URL(url).searchParams.get('skip') ?? 0);
        const limit = Number(new URL(url).searchParams.get('limit') ?? 1000);
        return json({
          rows: rows
            .slice(offset, offset + limit)
            .map((row) => ({ id: row.id, doc: { ...row, _id: row.id, _rev: '1' } })),
        });
      }
      if (kind === 'couchbase') {
        const statement = String(body.statement);
        if (statement.includes('system:keyspaces'))
          return json({ status: 'success', results: [{ bucket: 'fixture', scope: 'main', name: 'items' }] });
        const offset = Number(statement.match(/OFFSET (\d+)/)?.[1] ?? 0);
        const limit = Number(statement.match(/LIMIT (\d+)/)?.[1] ?? 1000);
        return json({
          status: 'success',
          results: (JSON.stringify(body.args).includes('2')
            ? rows.filter((row) => row.id === '2')
            : statement.includes('`id` DESC')
              ? [...rows].reverse()
              : rows
          )
            .slice(offset, offset + limit)
            .map((row) => ({ ...row, _id: row.id })),
        });
      }
      if (kind === 'firestore') {
        if (url.endsWith(':listCollectionIds')) return json({ collectionIds: ['items'] });
        if (url.endsWith(':runQuery')) {
          const query = JSON.stringify(body.structuredQuery);
          const selected = query.includes('item-2')
            ? rows.filter((row) => row.id === '2')
            : query.includes('DESCENDING')
              ? [...rows].reverse()
              : rows;
          return json(
            selected.map((row) => ({
              document: {
                name: `projects/fixture/databases/fixture/documents/items/${row.id}`,
                fields: { title: { stringValue: row.title } },
              },
            })),
          );
        }
        const parsed = new URL(url);
        const offset = Number(parsed.searchParams.get('pageToken') ?? 0);
        const limit = Number(parsed.searchParams.get('pageSize') ?? 1000);
        const documents = rows.slice(offset, offset + limit).map((row) => ({
          name: `projects/fixture/databases/fixture/documents/items/${row.id}`,
          fields: { title: { stringValue: row.title } },
        }));
        return json({
          documents,
          ...(offset + documents.length < rows.length
            ? { nextPageToken: String(offset + documents.length) }
            : {}),
        });
      }
      if (url.endsWith('/colls')) return json({ DocumentCollections: [{ id: 'items' }] });
      if (url.endsWith('/pkranges')) return json({ PartitionKeyRanges: [{ id: '0' }] });
      if (!url.endsWith('/docs')) return json({ partitionKey: { paths: ['/tenant'] } });
      const headers = new Headers(init.headers);
      if (
        String(body.query).includes('ORDER BY') &&
        !headers.get('x-ms-documentdb-partitionkey') &&
        !headers.get('x-ms-documentdb-partitionkeyrangeid')
      )
        return new Response(
          JSON.stringify({
            code: 'BadRequest',
            message: 'The provided cross partition query can not be directly served by the gateway.',
          }),
          { status: 400, headers: { 'x-ms-substatus': '1004' } },
        );
      const offset = Number(headers.get('x-ms-continuation') ?? 0);
      const limit = Number(headers.get('x-ms-max-item-count') ?? 1000);
      const selected = JSON.stringify(body.parameters).includes('2')
        ? rows.filter((row) => row.id === '2')
        : String(body.query).includes('DESC')
          ? [...rows].reverse()
          : rows;
      const page = selected.slice(offset, offset + limit).map((row) => ({ ...row, tenant: 'fixture' }));
      return new Response(JSON.stringify({ Documents: page }), {
        headers:
          offset + page.length < selected.length ? { 'x-ms-continuation': String(offset + page.length) } : {},
      });
    };
    const connector = createNoSqlConnector(kind, { fetch: fetcher });
    const selected =
      kind === 'couchbase' ? { ...select, object: { schema: '["fixture","main"]', name: 'items' } } : select;
    const keys =
      kind === 'firestore'
        ? ['__name__']
        : kind === 'cosmosdb'
          ? ['tenant', 'id']
          : kind === 'dynamodb'
            ? ['id']
            : ['_id'];
    await exerciseFixture(connector, context(kind), selected, keys, rows.length);
    const boundary = new FixtureBoundary();
    await strictFixture(
      createNoSqlConnector(kind, { fetch: boundary.wrap(fetcher, 'fetch') }),
      context(kind),
      selected,
      kind === 'dynamodb' ? ['tenant', 'id'] : keys,
      3,
      boundary,
    );
  },
);

const network = {
  proxied: () => true,
  resolve: async () => {},
  connect: async () => {},
  handshake: async () => {},
};
it.each(['neo4j', 'influxdb', 'prometheus'] as const)(
  'runs the shared fixture operations against %s',
  async (kind) => {
    const boundary = new FixtureBoundary();
    const connector = createHttpEngineConnector(kind, {
      network,
      fetch: boundary.wrap(async (url: string, init: RequestInit) => {
        const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        if (kind === 'neo4j') {
          if (String(body.statement).startsWith('CALL db.labels'))
            return json({ data: { fields: ['label'], values: [['items']] } });
          const parameters = (body.parameters ?? {}) as { after?: string; limit?: number };
          const statement = String(body.statement);
          if (statement.includes('RETURN n.')) {
            const selected = / = '?2'?/.test(statement)
              ? rows.slice(1, 2)
              : statement.includes(' DESC')
                ? [...rows].reverse()
                : rows;
            return json({
              data: {
                fields: ['_id', 'id', 'title', '_relationships'],
                values: selected.map((row) => [row.id, row.id, row.title, '[]']),
              },
            });
          }
          const result = rows
            .filter((row) => row.id > (parameters.after ?? ''))
            .slice(0, parameters.limit ?? 1000);
          return json({
            data: {
              fields: ['properties', '_id', '_relationships'],
              values: result.map((row) => [row, row.id, []]),
            },
          });
        }
        if (kind === 'influxdb') {
          if (body.q === 'SELECT table_name FROM information_schema.tables')
            return json([{ table_name: 'items' }]);
          const query = String(body.q);
          const offset = Number(query.match(/OFFSET (\d+)/)?.[1] ?? 0);
          const limit = Number(query.match(/LIMIT (\d+)/)?.[1] ?? 1000);
          return json(
            (/ = '?2'?/.test(query) ? rows.slice(1, 2) : query.includes(' DESC') ? [...rows].reverse() : rows)
              .slice(offset, offset + limit)
              .map((row) => ({ ...row, time: `2026-01-01T00:0${row.id}:00Z` })),
          );
        }
        if (url.endsWith('/api/v1/status/buildinfo'))
          return json({ status: 'success', data: { version: '3.0' } });
        return json({
          status: 'success',
          data: {
            resultType: 'matrix',
            result: [
              {
                metric: { job: 'fixture' },
                values: rows.map((row) => [1767225600 + Number(row.id) * 60, row.id]),
              },
            ],
          },
        });
      }, 'fetch'),
    });
    await strictFixture(
      connector,
      context(kind),
      kind === 'prometheus' ? { ...select, object: { schema: null, name: 'query' } } : select,
      kind === 'neo4j' ? ['_id'] : kind === 'influxdb' ? ['_timeKey'] : ['_series', 'time'],
      3,
      boundary,
    );
    await exerciseFixture(
      connector,
      context(kind),
      kind === 'prometheus' ? { ...select, object: { schema: null, name: 'query' } } : select,
      kind === 'neo4j' ? ['_id'] : kind === 'influxdb' ? ['_timeKey'] : ['_series', 'time'],
      3,
    );
  },
);

it.each(['file-url', 'sftp', 'ftp', 'ftps', 'webdav'] as const)(
  'runs the shared fixture operations against the %s file adapter',
  async (kind) => {
    const url = new URL('https://files.invalid/items.csv');
    const bytes = Buffer.from('id,title\n1,item-1\n2,item-2\n3,item-3\n');
    const response = (method: string) => ({
      status: 200,
      url,
      headers: { 'content-length': String(bytes.length) },
      body: (async function* () {
        if (method !== 'HEAD') yield bytes;
      })(),
      close() {},
    });
    const network: FileNetwork = {
      allowsAddress: () => true,
      check: async () => ({ address: '127.0.0.1', family: 4 }),
      request: async ({ method }) => response(method),
    };
    const connector = createFileConnector(kind, {
      network,
      transport: {
        address: () => url,
        list: async () => [{ name: 'items.csv', url, format: 'csv', bytes: bytes.length }],
        request: async (_ctx, _url, method) => response(method),
      },
    });
    const ctx = {
      connection: SourceConnection.parse({
        kind,
        url: url.href,
        host: 'files.invalid',
        user: 'reader',
        path: '*.csv',
        format: 'csv',
        hostKey: `SHA256:${Buffer.alloc(32, 1).toString('base64').replace(/=+$/, '')}`,
      }),
      secrets: { password: secret },
      timeoutMs: 1000,
    };
    const [object] = await connector.listObjects(ctx);
    expect(object).toBeDefined();
    await exerciseFixture(connector, ctx, { kind: 'object', object: object! }, ['id'], 3);
    const boundary = new FixtureBoundary();
    const strict = createFileConnector(
      kind,
      boundary.wrap({
        network,
        sockets: { connect: async () => {}, handshake: async () => {} },
        transport: {
          address: () => url,
          list: async () => [{ name: 'items.csv', url, format: 'csv' as const, bytes: bytes.length }],
          request: async (_ctx: ConnectorContext, _url: URL, method: 'GET' | 'HEAD') => response(method),
        },
      }),
    );
    await strictFixture(strict, ctx, { kind: 'object', object: object! }, ['id'], 3, boundary);
  },
);

it('checks a fixture network refusal without exposing a credential', async () => {
  const connector = createFileConnector('file-url', {
    network: {
      allowsAddress: () => true,
      check: async () => {
        throw new FileNetworkError('blocked');
      },
      request: async () => {
        throw new FileNetworkError('blocked');
      },
    },
  });
  const result = await connector.test({
    connection: SourceConnection.parse({ kind: 'file-url', url: 'https://files.invalid/items.csv' }),
    secrets: { password: secret },
  });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain(secret);
});
