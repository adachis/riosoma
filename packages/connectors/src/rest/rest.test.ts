import { FixtureBoundary } from '../contract/boundary.test-support.js';
import { strictFixture } from '../contract/strict.test-support.js';
/**
 * API sources end to end against a local web server that pages and signs in every way the
 * connector knows: no paging, page numbers, offsets, cursors, next-page addresses in the body and
 * in the `Link` header, and no sign-in, bearer tokens, API keys in a header or a query parameter,
 * HTTP basic, and OAuth client credentials.  The network here is a plain one, since the
 * private-network rule belongs to the server and its own tests hold it to that rule.
 */
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { RestConnection, type SourceSecrets } from '@riosoma/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FileNetworkError, type FileNetwork, type FileResponse } from '../files/network.js';
import { ConnectorError, type ConnectorContext, type SourceRow } from '../types.js';
import {
  createRestConnector,
  endpointUrl,
  type RestConnector,
  type RestConnectorOptions,
} from './connector.js';
import { nextLink, retryAfterMs } from './http.js';
import { cellsOf, KeyScan, parseJson, Sampler, valueAt } from './records.js';

// ------------------------------------------------------------------ the API

const ORDERS = Array.from({ length: 23 }, (_unused, index) => {
  const n = index + 1;
  return {
    id: n,
    name: `Order ${n}`,
    total: n * 1.5,
    placed: `2026-09-${String(n).padStart(2, '0')}`,
    shipped: n % 2 ? `2026-09-${String(n).padStart(2, '0')}T10:30:00Z` : null,
    rush: n % 3 === 0,
    contact: `buyer${n}@example.com`,
    customer: { name: `Customer ${n}`, address: { city: n % 2 ? 'Lima' : 'Oslo' } },
    tags: n % 4 ? ['new', 'web'] : [],
    lines: [{ sku: `S${n}`, quantity: n }],
  };
});
const TOKENS = { bearer: 'right-bearer-token', key: 'right-api-key', password: 'right-password' };
const CLIENT = { id: 'rio-client', secret: 'right-client-secret' };

let server: Server;
let origin = '';
const requests: Array<{ path: string; search: string; headers: IncomingMessage['headers'] }> = [];
/** Tokens the token address has handed out and not yet revoked. */
const issued = new Set<string>();
let tokenRequests = 0;
let tokenBodies: string[] = [];
let busy = 0;

function send(res: ServerResponse, status: number, body: unknown, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** Whether a request signs in the way its path's first part asks, and why not when it doesn't. */
function signedIn(way: string, req: IncomingMessage, url: URL): string | null {
  const auth = String(req.headers.authorization ?? '');
  switch (way) {
    case 'none':
      return null;
    case 'bearer':
      return auth === `Bearer ${TOKENS.bearer}` ? null : `token ${auth} is not valid`;
    case 'header':
      return req.headers['x-api-key'] === TOKENS.key
        ? null
        : `key ${String(req.headers['x-api-key'])} is unknown`;
    case 'query':
      return url.searchParams.get('api_key') === TOKENS.key ? null : 'the api_key is unknown';
    case 'basic':
      return auth === `Basic ${Buffer.from(`reader:${TOKENS.password}`).toString('base64')}`
        ? null
        : `credentials ${auth} are wrong`;
    case 'oauth':
      return issued.has(auth.replace(/^Bearer /, '')) ? null : `token ${auth} expired`;
    case 'private':
      return `sign in first, not with ${auth}`;
    default:
      return 'unknown';
  }
}

function orders(res: ServerResponse, style: string, url: URL, base: string) {
  const number = (name: string, fallback: number) => Number(url.searchParams.get(name) ?? fallback);
  switch (style) {
    case 'all':
      return send(res, 200, ORDERS);
    case 'wrapped':
      return send(res, 200, { data: { items: ORDERS }, meta: { count: ORDERS.length } });
    case 'page': {
      const size = number('per_page', 10);
      const page = number('page', 1);
      return send(res, 200, { items: ORDERS.slice((page - 1) * size, page * size) });
    }
    case 'zero-page': {
      // Pages count from zero and there's no size to ask for, so only an empty page ends them.
      const page = number('p', 0);
      return send(res, 200, { items: ORDERS.slice(page * 10, page * 10 + 10) });
    }
    case 'offset': {
      const offset = number('offset', 0);
      const limit = number('limit', 100);
      return send(res, 200, { results: ORDERS.slice(offset, offset + limit) });
    }
    case 'cursor': {
      const after = number('after', 0);
      const slice = ORDERS.slice(after, after + 5);
      const next = after + 5 < ORDERS.length ? String(after + 5) : null;
      return send(res, 200, { data: slice, meta: { next } });
    }
    case 'next': {
      const page = number('p', 0);
      const slice = ORDERS.slice(page * 7, page * 7 + 7);
      const next = (page + 1) * 7 < ORDERS.length ? `${base}/next?p=${page + 1}` : null;
      return send(res, 200, { results: slice, next });
    }
    case 'link': {
      const page = number('p', 0);
      const slice = ORDERS.slice(page * 6, page * 6 + 6);
      const links = [`<${origin}${base}/link?p=0>; rel="first"`];
      if ((page + 1) * 6 < ORDERS.length)
        links.push(`<${origin}${base}/link?p=${page + 1}>; rel="next last"`);
      return send(res, 200, slice, { link: links.join(', ') });
    }
    case 'ignores-page':
      return send(res, 200, { items: ORDERS.slice(0, 5) });
    case 'endless': {
      const after = number('after', 0);
      return send(res, 200, { data: [{ id: after }], meta: { next: String(after + 1) } });
    }
    case 'elsewhere':
      return send(res, 200, {
        results: ORDERS.slice(0, 2),
        next: 'https://elsewhere.example.com/orders?p=2',
      });
    case 'busy':
      busy++;
      if (busy % 2) return send(res, 429, { message: 'slow down' }, { 'retry-after': '1' });
      return send(res, 200, ORDERS.slice(0, 3));
    case 'very-busy':
      return send(res, 503, { message: 'come back later' }, { 'retry-after': '120' });
    case 'html':
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>Sign in</title>');
    case 'broken':
      return send(res, 500, { message: 'database unavailable' });
    case 'quoted-ids':
      return send(
        res,
        200,
        ['6901234000000412001', '6901234000000412002', '6901234000000412003'].map((id) => ({
          id,
          ...(url.searchParams.get('fields') === 'id,total' ? { total: 12 } : { name: 'Order' }),
        })),
      );
    case 'big':
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('[{"id":12345678901234567891,"n":1},{"id":12345678901234567892,"n":2}]');
    default:
      return send(res, 404, { message: 'no such endpoint' });
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push({ path: url.pathname, search: url.search, headers: req.headers });
    if (url.pathname === '/token') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        tokenRequests++;
        tokenBodies.push(body);
        const form = new URLSearchParams(body);
        const basic = String(req.headers.authorization ?? '');
        const [id, secret] = basic.startsWith('Basic ')
          ? Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':')
          : [form.get('client_id'), form.get('client_secret')];
        if (req.method !== 'POST' || form.get('grant_type') !== 'client_credentials')
          return send(res, 400, { error: 'unsupported_grant_type' });
        if (id !== CLIENT.id || secret !== CLIENT.secret) return send(res, 401, { error: 'invalid_client' });
        const token = `issued-token-${tokenRequests}-${Math.random().toString(36).slice(2)}`;
        issued.add(token);
        send(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 60 });
      });
      return;
    }
    const [, way = '', , , style = ''] = url.pathname.split('/');
    const refused = signedIn(way, req, url);
    if (refused) return send(res, 401, { message: refused });
    orders(res, style, url, `/${way}/v1/orders`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
  tokenBodies = [];
});

/** A plain network that reaches only this test's server, following no redirects. */
const plainNetwork: FileNetwork = {
  allowsAddress: (url) => url.protocol === 'https:' || url.hostname === '127.0.0.1',
  check: async () => ({ address: '127.0.0.1', family: 4 }),
  request: ({ url, method, headers, body, maxBytes, signal }) =>
    new Promise<FileResponse>((resolve, reject) => {
      if (url.hostname !== '127.0.0.1') {
        reject(new FileNetworkError('blocked', `nothing may reach ${url.hostname}`));
        return;
      }
      const outgoing = httpRequest(url, { method, headers, signal }, (incoming) => {
        let size = 0;
        resolve({
          status: incoming.statusCode ?? 0,
          headers: Object.fromEntries(
            Object.entries(incoming.headers).map(([name, value]) => [
              name,
              Array.isArray(value) ? value.join(', ') : value,
            ]),
          ),
          url,
          body: (async function* () {
            for await (const chunk of incoming) {
              size += (chunk as Buffer).length;
              if (size > maxBytes) throw new FileNetworkError('tooLarge');
              yield chunk as Buffer;
            }
          })(),
          close: () => incoming.destroy(),
        });
      });
      outgoing.on('error', (error) => reject(new FileNetworkError('failed', error.message)));
      outgoing.end(body);
    }),
};

function connector(options: RestConnectorOptions = {}): RestConnector {
  return createRestConnector({
    network: plainNetwork,
    sockets: { connect: async () => undefined, handshake: async () => undefined },
    ...options,
  });
}

/** A source with one endpoint named `orders`, reached the way `way` signs in. */
function context(
  way: string,
  endpoint: Record<string, unknown>,
  auth: Record<string, unknown> = { method: 'none' },
  secrets: SourceSecrets = {},
  extra: Record<string, unknown> = {},
): ConnectorContext {
  return {
    connection: RestConnection.parse({
      kind: 'rest',
      baseUrl: `${origin}/${way}/v1`,
      auth,
      requestsPerSecond: 100,
      endpoints: [{ name: 'orders', ...endpoint }],
      ...extra,
    }),
    secrets,
    timeoutMs: 20_000,
  };
}

const ORDERS_OBJECT = { kind: 'object' as const, object: { schema: null, name: 'orders' } };

async function everyRow(api: RestConnector, ctx: ConnectorContext, columns: string[]): Promise<SourceRow[]> {
  const rows: SourceRow[] = [];
  for await (const batch of api.read(ctx, ORDERS_OBJECT, {
    columns,
    keyColumns: ['id'],
    types: {},
    batchSize: 4,
  }))
    rows.push(...batch);
  return rows;
}

async function failureOf(work: Promise<unknown>): Promise<ConnectorError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ConnectorError);
  return error as ConnectorError;
}

const PAGING: Array<[string, Record<string, unknown>]> = [
  ['no paging', { path: '/orders/all' }],
  [
    'page numbers with a size',
    { path: '/orders/page', records: 'items', paging: { style: 'page', sizeParam: 'per_page', size: 10 } },
  ],
  [
    'page numbers from zero that end on an empty page',
    { path: '/orders/zero-page', records: 'items', paging: { style: 'page', param: 'p', start: 0 } },
  ],
  [
    'an offset and a limit',
    { path: 'orders/offset', records: 'results', paging: { style: 'offset', limit: 8 } },
  ],
  [
    'a cursor in the answer',
    {
      path: '/orders/cursor',
      records: 'data',
      paging: { style: 'cursor', cursorPath: 'meta.next', param: 'after' },
    },
  ],
  [
    'a next-page address in the answer',
    { path: '/orders/next', records: 'results', paging: { style: 'next-url', nextPath: 'next' } },
  ],
  ['the Link header', { path: '/orders/link', paging: { style: 'link-header' } }],
];

// --------------------------------------------------------------------- tests

describe('reading the parts of an answer', () => {
  it('finds the next page in a Link header and the wait in a Retry-After', () => {
    expect(
      nextLink(
        '<https://api.example.com/a?page=2>; rel="next", <https://api.example.com/a?page=9>; rel="last"',
      ),
    ).toBe('https://api.example.com/a?page=2');
    expect(nextLink('<https://api.example.com/a?x=1,2>; rel="prev next"')).toBe(
      'https://api.example.com/a?x=1,2',
    );
    expect(nextLink('<https://api.example.com/a>; rel=next')).toBe('https://api.example.com/a');
    expect(nextLink('<https://api.example.com/a>; rel="last"')).toBeNull();
    expect(nextLink(undefined)).toBeNull();
    expect(retryAfterMs('3', 0)).toBe(3_000);
    expect(retryAfterMs('Wed, 21 Oct 2015 07:28:10 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'))).toBe(
      10_000,
    );
    expect(retryAfterMs('soon', 0)).toBeNull();
    expect(retryAfterMs(undefined, 0)).toBeNull();
  });

  it('joins an endpoint to its base address without leaving it', () => {
    const at = (base: string, path: string, query: Array<{ name: string; value: string }> = []) =>
      endpointUrl(base, { path, query }).href;
    expect(at('https://api.example.com/v2', '/orders')).toBe('https://api.example.com/v2/orders');
    expect(at('https://api.example.com/v2/', 'orders')).toBe('https://api.example.com/v2/orders');
    expect(at('https://api.example.com', '')).toBe('https://api.example.com/');
    expect(at('https://api.example.com/v2', '/orders', [{ name: 'status', value: 'open & paid' }])).toBe(
      'https://api.example.com/v2/orders?status=open+%26+paid',
    );
  });

  it('flattens nested objects to dotted columns, as deep as the endpoint says', () => {
    const record = ORDERS[0];
    expect([...cellsOf(record, { flattenDepth: 1, arrays: 'text' })]).toEqual([
      ['id', 1],
      ['name', 'Order 1'],
      ['total', 1.5],
      ['placed', '2026-09-01'],
      ['shipped', '2026-09-01T10:30:00Z'],
      ['rush', false],
      ['contact', 'buyer1@example.com'],
      ['customer.name', 'Customer 1'],
      ['customer.address', '{"city":"Lima"}'],
      ['tags', 'new, web'],
      ['lines', '[{"sku":"S1","quantity":1}]'],
    ]);
    const deep = cellsOf(record, { flattenDepth: 2, arrays: 'json' });
    expect(deep.get('customer.address.city')).toBe('Lima');
    expect(deep.get('tags')).toBe('["new","web"]');
    expect(cellsOf(record, { flattenDepth: 0, arrays: 'text' }).get('customer')).toBe(
      '{"name":"Customer 1","address":{"city":"Lima"}}',
    );
    // A list of plain values, like tags, is one column named `value` per record.
    expect([...cellsOf('solo', { flattenDepth: 1, arrays: 'text' })]).toEqual([['value', 'solo']]);
    expect(valueAt({ data: [{ items: [1] }] }, 'data.0.items')).toEqual([1]);
  });

  it('gives columns the types file sources would, keeps long numbers exact, and suggests id first', () => {
    const sampler = new Sampler({ flattenDepth: 1, arrays: 'text' });
    for (const order of ORDERS) sampler.add({ ...order, code: `A-${order.id}` });
    const columns = sampler.describe();
    expect(
      columns.map((entry) => [entry.column.name, entry.column.sourceType, entry.column.suggested?.type]),
    ).toEqual([
      ['id', 'number', 'number'],
      ['name', 'string', 'text'],
      ['total', 'number', 'number'],
      ['placed', 'string', 'date'],
      ['shipped', 'string', 'date'],
      ['rush', 'boolean', 'checkbox'],
      ['contact', 'string', 'email'],
      ['customer.name', 'string', 'text'],
      ['customer.address', 'json', 'longText'],
      ['tags', 'list', 'text'],
      ['lines', 'json', 'longText'],
      ['code', 'string', 'text'],
    ]);
    expect(columns.find((entry) => entry.column.name === 'shipped')!.column.suggested!.options).toEqual({
      includeTime: true,
      timeZone: 'UTC',
    });
    expect(columns.find((entry) => entry.column.name === 'lines')!.column.alternatives).toEqual(['text']);

    // With a code ahead of it, id still comes first among the columns that could be keys.
    const coded = ORDERS.map((order) => ({ code: `A-${order.id}`, ...order }));
    const codedSample = new Sampler({ flattenDepth: 1, arrays: 'text' });
    for (const order of coded) codedSample.add(order);
    const keys = new KeyScan(codedSample.describe());
    for (const order of coded) keys.add(cellsOf(order, { flattenDepth: 1, arrays: 'text' }));
    expect(keys.candidates()).toEqual([
      ['id'],
      ['code'],
      ['name'],
      ['total'],
      ['placed'],
      ['contact'],
      ['customer.name'],
    ]);

    const big = parseJson('[{"id":12345678901234567891},{"id":12345678901234567892}]') as unknown[];
    const exact = new Sampler({ flattenDepth: 1, arrays: 'text' });
    for (const record of big) exact.add(record);
    const [id] = exact.describe();
    expect(id!.column.suggested?.type).toBe('text');
    expect(id!.value(cellsOf(big[0], { flattenDepth: 1, arrays: 'text' }).get('id'), 'text')).toBe(
      '12345678901234567891',
    );
  });
});

describe('exact API keys', () => {
  it.each([false, true])('preserves quoted long IDs through field groups %s', async (grouped) => {
    const ctx = context('none', { path: '/orders/quoted-ids' });
    const endpoint = (ctx.connection as RestConnection).endpoints[0]!;
    const api = connector(
      grouped
        ? {
            recordGroups: {
              endpoints: [endpoint, { ...endpoint, query: [{ name: 'fields', value: 'id,total' }] }],
              key: 'id',
              changedMessageKey: 'sources.app.batchChanged',
            },
          }
        : {},
    );
    const ids = ['6901234000000412001', '6901234000000412002', '6901234000000412003'];
    const rows = await everyRow(api, ctx, grouped ? ['id', 'name', 'total'] : ['id']);
    if (grouped)
      expect(rows.map((row) => row.values)).toEqual(ids.map((id) => ({ id, name: 'Order', total: 12 })));
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
    expect(rows.map((row) => row.key)).toEqual(ids.map((id) => JSON.stringify([id])));
    expect(rows.map((row) => row.values.id)).toEqual(ids);
    expect((await api.describe(ctx, ORDERS_OBJECT))[0]!.suggested?.type).toBe('text');
  });

  it.each([false, true])('preserves unquoted long IDs through field groups %s', async (grouped) => {
    const ctx = context('none', { path: '/orders/big' });
    const endpoint = (ctx.connection as RestConnection).endpoints[0]!;
    const api = connector(
      grouped
        ? {
            recordGroups: {
              endpoints: [endpoint, endpoint],
              key: 'id',
              changedMessageKey: 'sources.app.batchChanged',
            },
          }
        : {},
    );
    const ids = ['12345678901234567891', '12345678901234567892'];
    const rows = await everyRow(api, ctx, ['id']);
    expect(rows.map((row) => row.values.id)).toEqual(ids);
    expect(rows.map((row) => row.key)).toEqual(ids.map((id) => JSON.stringify([id])));
  });

  it.each([
    '0000000000000001',
    '9007199254740991',
    '-9007199254740992',
    '9.007199254740992e15',
    9007199254740992,
  ])('keeps values that require exact text out of numeric suggestions, case %#', (id) => {
    const sampler = new Sampler({ flattenDepth: 1, arrays: 'text' });
    sampler.add({ id });
    expect(sampler.describe()[0]!.column.suggested?.type).toBe('text');
  });

  it('builds keys from source text even when the sample or requested type is numeric', () => {
    const sampler = new Sampler({ flattenDepth: 1, arrays: 'text' });
    sampler.add({ id: '12' });
    const column = sampler.describe()[0]!;
    expect(column.column.suggested?.type).toBe('number');
    expect(column.key('0012')).toBe('0012');
    expect(column.key('6901234000000412001')).toBe('6901234000000412001');
    expect(column.key('6901234000000412002')).toBe('6901234000000412002');
  });
});

describe('paging', () => {
  it.each(PAGING)('reads every record with %s, in order', async (_name, endpoint) => {
    const api = connector();
    const ctx = context('none', endpoint);
    const rows = await everyRow(api, ctx, ['id', 'name', 'customer.address.city']);
    expect(rows.map((row) => row.values.id)).toEqual(ORDERS.map((order) => order.id));
    expect(rows[1]).toEqual({
      key: '[2]',
      values: { id: 2, name: 'Order 2', 'customer.address.city': null },
    });
    const preview = await api.preview(ctx, ORDERS_OBJECT, 3);
    expect(preview.rows).toHaveLength(3);
    expect(preview.rowEstimate).toBe(23);
    expect(await api.keyCandidates(ctx, ORDERS_OBJECT.object)).toContainEqual(['id']);
  });

  it('finds records at a path and says where lists are when the path is wrong', async () => {
    const api = connector();
    const wrapped = context('none', { path: '/orders/wrapped', records: 'data.items' });
    expect((await everyRow(api, wrapped, ['id'])).length).toBe(23);
    const wrong = await failureOf(api.describe(context('none', { path: '/orders/wrapped' }), ORDERS_OBJECT));
    expect(wrong.messageKey).toBe('sources.rest.records');
    expect(wrong.detail).toBe('lists in the answer: data.items');
  });

  it('stops endless paging at the page and record limits, and when the API ignores the page', async () => {
    const api = connector();
    const endless = {
      path: '/orders/endless',
      records: 'data',
      paging: { style: 'cursor', cursorPath: 'meta.next', param: 'after' },
    };
    const pages = await failureOf(everyRow(api, context('none', { ...endless, maxPages: 5 }), ['id']));
    expect(pages).toMatchObject({ messageKey: 'sources.rest.pageLimit', params: { pages: 5 } });
    expect(requests.filter((entry) => entry.path.endsWith('/endless'))).toHaveLength(5);
    const records = await failureOf(
      everyRow(api, context('none', { path: '/orders/all', maxRecords: 10 }), ['id']),
    );
    expect(records).toMatchObject({ messageKey: 'sources.rest.recordLimit', params: { records: 10 } });
    // A preview reads a sample and stops, whatever the limits.
    expect(
      (await api.preview(context('none', { ...endless, maxPages: 5 }), ORDERS_OBJECT, 50)).rows,
    ).toHaveLength(5);
    const ignored = await failureOf(
      everyRow(
        api,
        context('none', {
          path: '/orders/ignores-page',
          records: 'items',
          paging: { style: 'page', size: 5 },
        }),
        ['id'],
      ),
    );
    expect(ignored.messageKey).toBe('sources.rest.pagingLoop');
  });

  it('never follows a next page to another site', async () => {
    const api = connector();
    const elsewhere = await failureOf(
      everyRow(
        api,
        context('none', {
          path: '/orders/elsewhere',
          records: 'results',
          paging: { style: 'next-url', nextPath: 'next' },
        }),
        ['id'],
      ),
    );
    expect(elsewhere.messageKey).toBe('sources.rest.nextElsewhere');
    expect(requests.every((entry) => !entry.path.includes('elsewhere.example.com'))).toBe(true);
  });
});

describe('signing in', () => {
  const ways: Array<[string, Record<string, unknown>, SourceSecrets, SourceSecrets, string]> = [
    [
      'bearer',
      { method: 'bearer' },
      { token: TOKENS.bearer },
      { token: 'wrong-bearer-token' },
      'sources.rest.deniedToken',
    ],
    [
      'header',
      { method: 'header', name: 'X-Api-Key' },
      { apiKey: TOKENS.key },
      { apiKey: 'wrong-api-key' },
      'sources.rest.deniedKey',
    ],
    [
      'query',
      { method: 'query', name: 'api_key' },
      { apiKey: TOKENS.key },
      { apiKey: 'wrong-api-key' },
      'sources.rest.deniedKey',
    ],
    [
      'basic',
      { method: 'basic', user: 'reader' },
      { password: TOKENS.password },
      { password: 'wrong-password' },
      'sources.rest.deniedPassword',
    ],
  ];

  it.each(ways)(
    'signs in with %s, and names a wrong secret without repeating it',
    async (way, auth, right, wrong, key) => {
      const api = connector();
      const endpoint = {
        path: '/orders/page',
        records: 'items',
        paging: { style: 'page', sizeParam: 'per_page', size: 10 },
      };
      expect(await everyRow(api, context(way, endpoint, auth, right), ['id'])).toHaveLength(23);
      const refused = await failureOf(api.describe(context(way, endpoint, auth, wrong), ORDERS_OBJECT));
      expect(refused.messageKey).toBe(key);
      expect(refused.detail).toMatch(/^HTTP 401/);
      const secret = Object.values(wrong)[0]!;
      expect(refused.detail).not.toContain(secret);
      expect(refused.detail).not.toContain(Buffer.from(`reader:${secret}`).toString('base64'));
      const tested = await api.test(context(way, endpoint, auth, wrong));
      expect(tested.steps.at(-1)).toMatchObject({ step: 'authenticate', status: 'failed', messageKey: key });
      expect(JSON.stringify(tested)).not.toContain(secret);
    },
  );

  it('asks for a sign-in when the API wants one and the source has none', async () => {
    const refused = await failureOf(
      connector().describe(context('private', { path: '/orders/all' }), ORDERS_OBJECT),
    );
    expect(refused.messageKey).toBe('sources.rest.signIn');
  });

  it.each(['basic', 'body'] as const)(
    'gets an OAuth token with the secret in the %s, and keeps it until it expires',
    async (clientAuth) => {
      let clock = Date.now();
      const api = connector({ now: () => clock });
      const auth = {
        method: 'oauth-client',
        tokenUrl: `${origin}/token`,
        clientId: CLIENT.id,
        scope: `orders.read ${clientAuth}`,
        clientAuth,
      };
      const ctx = context('oauth', { path: '/orders/all' }, auth, { clientSecret: CLIENT.secret });
      const before = tokenRequests;
      expect(await everyRow(api, ctx, ['id'])).toHaveLength(23);
      expect(await everyRow(api, ctx, ['id'])).toHaveLength(23);
      expect(tokenRequests - before).toBe(1);
      const form = new URLSearchParams(tokenBodies[0]);
      expect(form.get('scope')).toBe(`orders.read ${clientAuth}`);
      expect(form.get('client_secret')).toBe(clientAuth === 'body' ? CLIENT.secret : null);
      // A minute later the token has expired, so the next read asks for another.
      clock += 61_000;
      expect(await everyRow(api, ctx, ['id'])).toHaveLength(23);
      expect(tokenRequests - before).toBe(2);
    },
  );

  it('renews a refused OAuth token once, and says so when the new one is refused too', async () => {
    const api = connector();
    const auth = { method: 'oauth-client', tokenUrl: `${origin}/token`, clientId: CLIENT.id, scope: 'renew' };
    const ctx = context('oauth', { path: '/orders/all' }, auth, { clientSecret: CLIENT.secret });
    expect(await everyRow(api, ctx, ['id'])).toHaveLength(23);
    const before = tokenRequests;
    // The API forgets every token it knew, as it would after rotating its keys.
    issued.clear();
    expect(await everyRow(api, ctx, ['id'])).toHaveLength(23);
    expect(tokenRequests - before).toBe(1);
    const refusing = await failureOf(
      api.describe(
        context('private', { path: '/orders/all' }, auth, { clientSecret: CLIENT.secret }),
        ORDERS_OBJECT,
      ),
    );
    expect(refusing.messageKey).toBe('sources.rest.deniedOauth');
    // The token got for this call is in no message, even when the API quotes it back.
    for (const token of issued) expect(refusing.detail).not.toContain(token);
    const wrong = await failureOf(
      api.describe(
        context(
          'oauth',
          { path: '/orders/all' },
          { ...auth, scope: 'wrong' },
          { clientSecret: 'wrong-client-secret' },
        ),
        ORDERS_OBJECT,
      ),
    );
    expect(wrong.messageKey).toBe('sources.rest.oauthDenied');
    expect(wrong.detail).toBe('the token address answered HTTP 401 invalid_client');
  });
});

describe('manners and failures', () => {
  it('waits out a 429’s Retry-After, and gives up on one that asks too much', async () => {
    const api = connector();
    const started = Date.now();
    expect(await everyRow(api, context('none', { path: '/orders/busy' }), ['id'])).toHaveLength(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    const long = await failureOf(api.describe(context('none', { path: '/orders/very-busy' }), ORDERS_OBJECT));
    expect(long.messageKey).toBe('sources.rest.rateLimited');
    expect(long.detail).toContain('asked to wait 120 seconds');
    expect(requests.filter((entry) => entry.path.endsWith('/very-busy'))).toHaveLength(1);
  });

  it('keeps to the source’s pace across calls', async () => {
    const api = connector();
    const ctx = context(
      'none',
      {
        path: '/orders/cursor',
        records: 'data',
        paging: { style: 'cursor', cursorPath: 'meta.next', param: 'after' },
      },
      { method: 'none' },
      {},
      { requestsPerSecond: 5 },
    );
    const started = Date.now();
    await everyRow(api, ctx, ['id']);
    // Five pages at five a second: the last leaves at least 800 ms after the first.
    expect(Date.now() - started).toBeGreaterThanOrEqual(750);
  });

  it('says when an answer isn’t JSON, an endpoint isn’t there, or the API fails', async () => {
    const api = connector();
    const described = (path: string, select: Parameters<RestConnector['describe']>[1] = ORDERS_OBJECT) =>
      failureOf(api.describe(context('none', { path }), select));
    expect(await described('/orders/html')).toMatchObject({
      messageKey: 'sources.rest.notJson',
      detail: 'the answer (text/html) doesn’t read as JSON',
    });
    expect(await described('/orders/gone')).toMatchObject({
      messageKey: 'sources.rest.notFound',
      params: { endpoint: 'orders' },
    });
    expect(await described('/orders/broken')).toMatchObject({
      messageKey: 'sources.rest.status',
      detail: 'HTTP 500: database unavailable',
    });
    expect((await described('/orders/all', { kind: 'query', sql: 'SELECT 1' })).messageKey).toBe(
      'sources.rest.noQueries',
    );
    expect(
      (await described('/orders/all', { kind: 'object', object: { schema: null, name: 'gone' } })).messageKey,
    ).toBe('sources.sync.objectMissing');
    const large = await failureOf(
      connector({ maxPageBytes: 1_000 }).describe(context('none', { path: '/orders/all' }), ORDERS_OBJECT),
    );
    expect(large).toMatchObject({ messageKey: 'sources.rest.tooLarge', params: { megabytes: 0 } });
  });

  it('lists each endpoint as something to sync', async () => {
    const ctx = context(
      'none',
      { path: '/orders/all' },
      { method: 'none' },
      {},
      {
        endpoints: [
          { name: 'Orders', path: '/orders/all' },
          { name: 'Open orders', path: '/orders/page' },
        ],
      },
    );
    expect(await connector().listObjects(ctx)).toEqual([
      { schema: null, name: 'Orders', type: 'endpoint', rowEstimate: null },
      { schema: null, name: 'Open orders', type: 'endpoint', rowEstimate: null },
    ]);
  });

  it('shows only the first page while an endpoint is set up', async () => {
    const api = connector();
    const ctx = context('none', {
      path: '/orders/cursor',
      records: 'data',
      paging: { style: 'cursor', cursorPath: 'meta.next', param: 'after' },
    });
    const first = await api.firstPage(ctx, ORDERS_OBJECT, 100);
    expect(first.rows).toHaveLength(5);
    expect(first.rowEstimate).toBeNull();
    expect(requests).toHaveLength(1);
  });
});

describe('testing a connection', () => {
  it('climbs every step, paging to a second page', async () => {
    const api = connector();
    const result = await api.test(
      context(
        'bearer',
        {
          path: '/orders/page',
          records: 'items',
          paging: { style: 'page', sizeParam: 'per_page', size: 10 },
        },
        { method: 'bearer' },
        { token: TOKENS.bearer },
      ),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'skipped'],
      ['authenticate', 'ok'],
      ['read', 'ok'],
      ['records', 'ok'],
      ['paging', 'ok'],
    ]);
    expect(requests.map((entry) => entry.search)).toEqual(['?page=1&per_page=10', '?page=2&per_page=10']);
  });

  it('skips paging when an endpoint doesn’t page, and asks OAuth for a new token', async () => {
    const api = connector();
    const auth = { method: 'oauth-client', tokenUrl: `${origin}/token`, clientId: CLIENT.id, scope: 'test' };
    const ctx = context('oauth', { path: '/orders/all' }, auth, { clientSecret: CLIENT.secret });
    await api.describe(ctx, ORDERS_OBJECT);
    const before = tokenRequests;
    const result = await api.test(ctx);
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'skipped'],
      ['authenticate', 'ok'],
      ['read', 'ok'],
      ['records', 'ok'],
      ['paging', 'skipped'],
    ]);
    expect(tokenRequests - before).toBe(1);
    const wrong = await api.test(
      context(
        'oauth',
        { path: '/orders/all' },
        { ...auth, scope: 'test wrong' },
        { clientSecret: 'wrong-client-secret' },
      ),
    );
    expect(wrong.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      status: 'failed',
      messageKey: 'sources.rest.oauthDenied',
    });
    expect(JSON.stringify(wrong)).not.toContain('wrong-client-secret');
  });

  it('stops at the step that failed, with advice for it', async () => {
    const api = connector();
    const last = async (endpoint: Record<string, unknown>) =>
      (await api.test(context('none', endpoint))).steps.at(-1);
    expect(await last({ path: '/orders/gone' })).toMatchObject({
      step: 'read',
      status: 'failed',
      messageKey: 'sources.rest.notFound',
    });
    expect(await last({ path: '/orders/html' })).toMatchObject({
      step: 'read',
      status: 'failed',
      messageKey: 'sources.rest.notJson',
    });
    expect(await last({ path: '/orders/wrapped', records: 'items' })).toMatchObject({
      step: 'records',
      status: 'failed',
      messageKey: 'sources.rest.records',
      detail: 'lists in the answer: data.items',
    });
    expect(
      await last({ path: '/orders/ignores-page', records: 'items', paging: { style: 'page' } }),
    ).toMatchObject({
      step: 'paging',
      status: 'failed',
      messageKey: 'sources.rest.pagingLoop',
    });
    const insecure = await api.test({
      ...context('none', { path: '/orders/all' }),
      connection: {
        ...(context('none', { path: '/orders/all' }).connection as RestConnection),
        baseUrl: 'http://api.example.com',
      },
    });
    expect(insecure.steps).toEqual([
      expect.objectContaining({ step: 'resolve', status: 'failed', messageKey: 'sources.rest.https' }),
    ]);
  });
});

it('runs every declared REST contract against its paged fixture', async () => {
  const boundary = new FixtureBoundary();
  const api = connector(
    boundary.wrap({ network: plainNetwork, sockets: { connect: async () => {}, handshake: async () => {} } }),
  );
  await strictFixture(
    api,
    context(
      'basic',
      { path: '/orders/page', records: 'items', paging: { style: 'page', pageSize: 5 } },
      { method: 'basic', user: 'reader' },
      { password: TOKENS.password },
    ),
    ORDERS_OBJECT,
    ['id'],
    ORDERS.length,
    boundary,
  );
});
