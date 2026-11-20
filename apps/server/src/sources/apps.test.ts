import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppConnection, type SourceSelect } from '@riosoma/contracts';
import {
  APP_PRESETS,
  ConnectorError,
  connectorFor,
  createAppConnector,
  type AppPreset,
  type ConnectorContext,
  type SourceRow,
} from '@riosoma/connectors';
import type { FastifyInstance } from 'fastify';
import { installRestSources, restConnectorOptions } from './rest.js';

const KEY = randomBytes(24).toString('hex');
const RESPONSE_MARKER = 'permission-response-marker';
const names = ['email', 'firstname', ...Array.from({ length: 80 }, (_, i) => `field_${i}_${'x'.repeat(35)}`)];
let listener: Server;
let origin: string;
let schemaDenied = false;
let empty = false;
let refused = false;
let retry = false;
let retryAt = 0;
let retryWait = 0;
let brokenProperties = false;
let changedBatch = false;
let onPropertyRetry: (() => void) | undefined;
const retryPropertyBatches = new Set<number>();
const deniedPaths = new Map<string, { status: number; body: unknown }>();
const requests: Array<{ path: string; method: string; query: URLSearchParams; signed: boolean }> = [];

beforeAll(async () => {
  listener = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const hubspot = url.pathname.startsWith('/crm/');
    const signed = hubspot
      ? req.headers.authorization === `Bearer ${KEY}`
      : req.headers['x-api-token'] === KEY;
    requests.push({ path: url.pathname, method: req.method ?? '', query: url.searchParams, signed });
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/graphql') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        const query = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
        if (!query.query.startsWith('query ')) return json(400, {});
        const denied = deniedPaths.get(query.query.includes('tickets') ? '/graphql/tickets' : '/graphql');
        if (denied) return json(denied.status, denied.body);
        return json(200, {
          data: { items: [{ id: 'one', name: 'First' }], pageInfo: { hasNextPage: false, endCursor: null } },
        });
      });
      return;
    }
    if (refused || !signed) return json(401, { message: `refused ${KEY}` });
    const denied = deniedPaths.get(url.pathname);
    if (denied) return json(denied.status, denied.body);
    if (url.pathname === '/crm/v3/schemas')
      return schemaDenied
        ? json(403, { message: `scope refused ${KEY}` })
        : json(200, { results: [{ objectTypeId: '2-123', labels: { plural: 'Custom records' } }] });
    if (url.pathname.startsWith('/crm/v3/properties/'))
      return json(
        200,
        brokenProperties
          ? { unexpected: KEY }
          : {
              results: [
                ...names.map((name) => ({ name, hidden: false })),
                { name: 'hidden_value', hidden: true },
              ],
            },
      );
    const propertyBatch =
      hubspot && url.pathname.startsWith('/crm/v3/objects/')
        ? url.searchParams.get('properties')?.startsWith('email,')
          ? 1
          : 2
        : 0;
    if (retry || retryPropertyBatches.delete(propertyBatch)) {
      retry = false;
      retryAt = Date.now();
      json(429, { message: `limited ${KEY}` }, { 'retry-after': '1' });
      onPropertyRetry?.();
      return;
    }
    if (retryAt) {
      retryWait = Date.now() - retryAt;
      retryAt = 0;
    }
    const cursor = url.searchParams.get(hubspot ? 'after' : 'cursor');
    const page = cursor === null ? 1 : cursor === 'second' ? 2 : 3;
    const last = url.searchParams.get('limit') === '1' || page === 3 || empty;
    if (hubspot) {
      const wanted = url.searchParams.get('properties')?.split(',') ?? ['email', 'firstname'];
      const properties = Object.fromEntries(
        wanted.map((name) => [name, `${name === 'email' ? 'person@example.test' : 'value'}-${page}`]),
      );
      return json(200, {
        results: empty
          ? []
          : [
              {
                id: changedBatch && wanted[0] !== 'email' ? 'changed' : String(page),
                properties,
                createdAt: '2026-10-01T00:00:00Z',
                updatedAt: '2026-10-02T00:00:00Z',
                archived: false,
              },
            ],
        ...(last ? {} : { paging: { next: { after: page === 1 ? 'second' : 'third' } } }),
      });
    }
    if (url.pathname.startsWith('/api/v2/'))
      return json(200, {
        success: true,
        data: empty ? [] : [{ id: page, name: `Person ${page}` }],
        additional_data: { next_cursor: last ? null : page === 1 ? 'second' : 'third' },
      });
    json(404, { message: `missing ${KEY}` });
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  origin = `http://localhost:${(listener.address() as AddressInfo).port}`;
});

beforeEach(() => {
  requests.length = 0;
  schemaDenied = false;
  empty = false;
  refused = false;
  retry = false;
  retryAt = 0;
  retryWait = 0;
  brokenProperties = false;
  changedBatch = false;
  retryPropertyBatches.clear();
  deniedPaths.clear();
  onPropertyRetry = undefined;
});

afterAll(async () => {
  listener.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
});

function connector(presets: readonly AppPreset[] = APP_PRESETS, deadlineMs?: number) {
  return createAppConnector(
    {
      ...restConnectorOptions({ production: false, automationsAllowPrivateHosts: true }, async () => [
        { address: '127.0.0.1', family: 4 },
      ]),
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
    },
    // Only the test-owned presets change the fixed host to this test's local API.
    presets.map((preset) => ({ ...preset, target: { ...preset.target, address: origin } })),
  );
}

function context(app: string): ConnectorContext {
  return {
    connection: AppConnection.parse({ kind: 'app', app }),
    secrets: app === 'hubspot' ? { token: KEY } : { apiKey: KEY },
    timeoutMs: 10_000,
  };
}

const select = (name: string): SourceSelect => ({ kind: 'object', object: { schema: null, name } });

async function read(app: string, name: string, columns = ['id'], source = connector()) {
  const rows: SourceRow[] = [];
  for await (const batch of source.read(context(app), select(name), {
    columns,
    types: Object.fromEntries(columns.map((name) => [name, 'text'])),
    keyColumns: ['id'],
    batchSize: 2,
  }))
    rows.push(...batch);
  return rows;
}

describe('app sources on the server’s guarded network', () => {
  it('registers the app connector alongside the API connectors', () => {
    installRestSources({
      ctx: { config: { production: false, automationsAllowPrivateHosts: true } },
    } as FastifyInstance);
    expect(connectorFor('app').kind).toBe('app');
  });

  it('tests each key with one inexpensive authentication GET and names a refused key without exposing it', async () => {
    for (const app of ['hubspot', 'pipedrive']) {
      requests.length = 0;
      expect((await connector().test(context(app))).ok).toBe(true);
      expect(requests[0]?.query.get('limit')).toBe('1');
      expect(requests.filter((request) => request.query.get('limit') === '1')).toHaveLength(1);
      expect(requests.every((request) => request.method === 'GET' && request.signed)).toBe(true);
      expect(
        requests.filter(
          (request) => request.path === (app === 'hubspot' ? '/crm/v3/objects/contacts' : '/api/v2/persons'),
        ).length,
      ).toBeGreaterThan(1);
      refused = true;
      requests.length = 0;
      const result = await connector().test(context(app));
      expect(result.ok).toBe(false);
      expect(result.steps.at(-1)?.messageKey).toBe(`sources.app.${app}.deniedToken`);
      expect(JSON.stringify(result).includes(KEY)).toBe(false);
      expect(requests).toHaveLength(1);
      refused = false;
    }
  });

  it.each(['/crm/v3/properties/tickets', '/crm/v3/objects/tickets'])(
    'leaves out an object refused at %s while testing, previewing, and reading the allowed objects',
    async (path) => {
      schemaDenied = true;
      deniedPaths.set(path, {
        status: 403,
        body: {
          message: `${RESPONSE_MARKER} ${KEY} requires one of [tickets-read, tickets-access]`,
        },
      });
      const source = connector();
      const result = await source.test(context('hubspot'));
      expect(result.ok).toBe(true);
      expect(result.steps.filter((step) => step.messageKey === 'sources.app.objectNotAllowed')).toEqual([
        expect.objectContaining({
          status: 'skipped',
          params: { object: 'tickets', permission: 'tickets-read, tickets-access', hasPermission: true },
        }),
      ]);
      expect(result.steps.some((step) => step.status === 'failed')).toBe(false);
      expect(JSON.stringify(result)).not.toContain(RESPONSE_MARKER);
      expect(JSON.stringify(result)).not.toContain(KEY);
      expect((await source.listObjects(context('hubspot'))).map((object) => object.name)).toEqual([
        'contacts',
        'companies',
        'deals',
      ]);
      for (const name of ['contacts', 'companies', 'deals']) {
        expect((await source.preview(context('hubspot'), select(name), 1)).rows).toHaveLength(1);
        expect(await read('hubspot', name, ['id'], source)).toHaveLength(3);
      }
    },
  );

  it('fails a key refused for every object without exposing the response', async () => {
    for (const preset of APP_PRESETS.filter((preset) =>
      ['hubspot', 'pipedrive'].includes(preset.catalog.id),
    )) {
      schemaDenied = true;
      for (const object of preset.objects) {
        if (!('endpoint' in object)) throw new Error('Unexpected fixture shape');
        deniedPaths.set(object.endpoint.path, {
          status: 403,
          body: { message: `${RESPONSE_MARKER} ${KEY}` },
        });
      }
      const source = connector();
      const result = await source.test(context(preset.catalog.id));
      expect(result.ok).toBe(false);
      expect(result.steps.at(-1)?.messageKey).toBe(preset.catalog.secret!.deniedMessageId);
      expect(await source.listObjects(context(preset.catalog.id))).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(RESPONSE_MARKER);
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
  });

  it('fails the test when every object loses access to its properties after authentication succeeds', async () => {
    schemaDenied = true;
    for (const object of APP_PRESETS[0]!.objects)
      deniedPaths.set(`/crm/v3/properties/${object.name}`, {
        status: 403,
        body: { message: RESPONSE_MARKER },
      });
    const result = await connector().test(context('hubspot'));
    expect(result.ok).toBe(false);
    expect(result.steps.filter((step) => step.messageKey === 'sources.app.objectNotAllowed')).toHaveLength(4);
    expect(result.steps.at(-1)?.messageKey).toBe('sources.app.hubspot.deniedToken');
    expect(JSON.stringify(result)).not.toContain(RESPONSE_MARKER);
  });

  it.each(['/crm/v3/properties/tickets', '/crm/v3/objects/tickets'])(
    'keeps another saved object reading when access is revoked at %s',
    async (path) => {
      const source = connector();
      expect(await read('hubspot', 'tickets', ['id'], source)).toHaveLength(3);
      deniedPaths.set(path, {
        status: 403,
        body: { message: `${RESPONSE_MARKER} ${KEY} requires one of [tickets-read]` },
      });
      const error: unknown = await read('hubspot', 'tickets', ['id'], source).catch(
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(ConnectorError);
      expect(error).toMatchObject({
        messageKey: 'sources.app.objectNotAllowed',
        params: { object: 'tickets', permission: 'tickets-read', hasPermission: true },
      });
      expect(String(error)).not.toContain(RESPONSE_MARKER);
      expect(JSON.stringify(error)).not.toContain(RESPONSE_MARKER);
      expect(String(error)).not.toContain(KEY);
      expect(JSON.stringify(error)).not.toContain(KEY);
      expect(await read('hubspot', 'contacts', ['id'], source)).toHaveLength(3);
    },
  );

  it('leaves out Pipedrive objects without guessing permission names from undeclared responses', async () => {
    deniedPaths.set('/api/v2/products', {
      status: 403,
      body: { message: `${RESPONSE_MARKER} requires one of [products-read]` },
    });
    const source = connector();
    const result = await source.test(context('pipedrive'));
    expect(result.ok).toBe(true);
    expect(result.steps.at(-1)).toMatchObject({
      status: 'skipped',
      messageKey: 'sources.app.objectNotAllowed',
      params: { object: 'products', permission: '', hasPermission: false },
    });
    expect((await source.listObjects(context('pipedrive'))).map((object) => object.name)).toEqual([
      'persons',
      'organizations',
      'deals',
      'activities',
    ]);
    await expect(read('pipedrive', 'products', ['id'], source)).rejects.toMatchObject({
      messageKey: 'sources.app.objectNotAllowed',
      params: { object: 'products', permission: '', hasPermission: false },
    });
    expect(JSON.stringify(result)).not.toContain(RESPONSE_MARKER);
    expect(JSON.stringify(result)).not.toContain('products-read');
  });

  it('recognizes a preset’s permission code on another HTTP status', async () => {
    schemaDenied = true;
    deniedPaths.set('/crm/v3/properties/tickets', {
      status: 400,
      body: {
        category: 'MISSING_SCOPES',
        message: `${RESPONSE_MARKER} requires one of [tickets-read]`,
      },
    });
    const result = await connector().test(context('hubspot'));
    expect(result.ok).toBe(true);
    expect(result.steps.at(-1)).toMatchObject({
      messageKey: 'sources.app.objectNotAllowed',
      status: 'skipped',
      params: { object: 'tickets', permission: 'tickets-read', hasPermission: true },
    });
    expect(JSON.stringify(result)).not.toContain(RESPONSE_MARKER);
  });

  it.each(['/crm/v3/properties/tickets', '/crm/v3/objects/tickets'])(
    'leaves out declared permission errors on HTTP 200 at %s',
    async (path) => {
      schemaDenied = true;
      deniedPaths.set(path, {
        status: 200,
        body: {
          category: 'MISSING_SCOPES',
          message: `${RESPONSE_MARKER} ${KEY} requires one of [tickets-read]`,
        },
      });
      const source = connector();
      const result = await source.test(context('hubspot'));
      expect(result.ok).toBe(true);
      expect(result.steps.at(-1)).toMatchObject({
        status: 'skipped',
        messageKey: 'sources.app.objectNotAllowed',
        params: { object: 'tickets', permission: 'tickets-read', hasPermission: true },
      });
      expect((await source.listObjects(context('hubspot'))).map((object) => object.name)).toEqual([
        'contacts',
        'companies',
        'deals',
      ]);
      const error: unknown = await read('hubspot', 'tickets', ['id'], source).catch(
        (error: unknown) => error,
      );
      expect(error).toMatchObject({
        messageKey: 'sources.app.objectNotAllowed',
        params: { object: 'tickets', permission: 'tickets-read', hasPermission: true },
      });
      for (const name of ['contacts', 'companies', 'deals']) {
        expect((await source.preview(context('hubspot'), select(name), 1)).rows).toHaveLength(1);
        expect(await read('hubspot', name, ['id'], source)).toHaveLength(3);
      }
      expect(JSON.stringify({ result, error })).not.toContain(RESPONSE_MARKER);
      expect(JSON.stringify({ result, error })).not.toContain(KEY);
    },
  );

  it.each([200, 400])('falls back from optional discovery permission codes on HTTP %s', async (status) => {
    const body = { category: 'MISSING_SCOPES', message: `${RESPONSE_MARKER} ${KEY}` };
    deniedPaths.set('/crm/v3/schemas', { status, body });
    const source = connector();
    const result = await source.test(context('hubspot'));
    expect(result.ok).toBe(true);
    expect((await source.listObjects(context('hubspot'))).map((object) => object.name)).toEqual([
      'contacts',
      'companies',
      'deals',
      'tickets',
    ]);
    deniedPaths.set('/crm/v3/schemas', { status: 401, body });
    expect((await source.test(context('hubspot'))).ok).toBe(false);
    await expect(source.listObjects(context('hubspot'))).rejects.toMatchObject({
      messageKey: 'sources.app.hubspot.deniedToken',
    });
    expect(JSON.stringify(result)).not.toContain(RESPONSE_MARKER);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('leaves out declared GraphQL permission errors before parsing HTTP 200 responses', async () => {
    const allowed: AppPreset['test'] = {
      name: 'persons',
      key: 'id',
      graphql: {
        query: 'query { items { id } }',
        variables: {},
        records: 'data.items',
        paging: { style: 'none' },
        maxPages: 10,
      },
    };
    const preset: AppPreset = {
      ...APP_PRESETS[1]!,
      target: { ...APP_PRESETS[1]!.target, address: `${origin}/graphql` },
      test: allowed,
      objects: [
        allowed,
        {
          ...allowed,
          name: 'tickets',
          graphql: { ...allowed.graphql, query: 'query { tickets { id } }' },
        },
      ],
      permissionDenied: {
        code: { path: 'errors.0.extensions.code', values: ['NO_ACCESS'] },
        names: { path: 'errors.0.extensions.scopes' },
      },
    };
    const source = createAppConnector(
      restConnectorOptions({ production: false, automationsAllowPrivateHosts: true }, async () => [
        { address: '127.0.0.1', family: 4 },
      ]),
      [preset],
    );
    expect((await source.test(context('pipedrive'))).ok).toBe(true);
    expect(await read('pipedrive', 'tickets', ['id'], source)).toHaveLength(1);
    deniedPaths.set('/graphql/tickets', {
      status: 200,
      body: {
        errors: [
          {
            message: `${RESPONSE_MARKER} ${KEY}`,
            extensions: { code: 'NO_ACCESS', scopes: ['tickets.read'] },
          },
        ],
      },
    });
    const result = await source.test(context('pipedrive'));
    expect(result.ok).toBe(true);
    expect(result.steps.at(-1)).toMatchObject({
      status: 'skipped',
      messageKey: 'sources.app.objectNotAllowed',
      params: { object: 'tickets', permission: 'tickets.read', hasPermission: true },
    });
    expect((await source.listObjects(context('pipedrive'))).map((object) => object.name)).toEqual([
      'persons',
    ]);
    const error: unknown = await read('pipedrive', 'tickets', ['id'], source).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({
      messageKey: 'sources.app.objectNotAllowed',
      params: { object: 'tickets', permission: 'tickets.read', hasPermission: true },
    });
    expect(await read('pipedrive', 'persons', ['id'], source)).toHaveLength(1);
    expect(JSON.stringify({ result, error })).not.toContain(RESPONSE_MARKER);
    expect(JSON.stringify({ result, error })).not.toContain(KEY);
    deniedPaths.set('/graphql/tickets', {
      status: 200,
      body: { errors: [{ message: RESPONSE_MARKER, extensions: { code: 'INVALID_QUERY' } }] },
    });
    const unrelated = await source.test(context('pipedrive'));
    expect(unrelated.ok).toBe(false);
    expect(unrelated.steps.at(-1)?.messageKey).toBe('sources.app.graphqlErrors');
    expect(JSON.stringify(unrelated)).not.toContain(RESPONSE_MARKER);
  });

  it('keeps a refusal on the designated test object as a refused-key failure', async () => {
    deniedPaths.set('/crm/v3/objects/contacts', {
      status: 403,
      body: { message: `${RESPONSE_MARKER} requires one of [contacts-read]` },
    });
    const result = await connector().test(context('hubspot'));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.messageKey).toBe('sources.app.hubspot.deniedToken');
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(RESPONSE_MARKER);
  });

  it('keeps a later 401 as a refused-key failure and never hides it during discovery', async () => {
    schemaDenied = true;
    deniedPaths.set('/crm/v3/objects/tickets', { status: 401, body: { message: RESPONSE_MARKER } });
    const source = connector();
    const result = await source.test(context('hubspot'));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.messageKey).toBe('sources.app.hubspot.deniedToken');
    await expect(source.listObjects(context('hubspot'))).rejects.toMatchObject({
      messageKey: 'sources.app.hubspot.deniedToken',
    });
    deniedPaths.clear();
    deniedPaths.set('/crm/v3/schemas', { status: 401, body: { message: RESPONSE_MARKER } });
    await expect(source.listObjects(context('hubspot'))).rejects.toMatchObject({
      messageKey: 'sources.app.hubspot.deniedToken',
    });
    expect(JSON.stringify(result)).not.toContain(RESPONSE_MARKER);
  });

  it('offers the four HubSpot objects and custom schemas, hiding only refused custom access', async () => {
    expect((await connector().listObjects(context('hubspot'))).map((object) => object.name)).toEqual([
      'contacts',
      'companies',
      'deals',
      'tickets',
      '2-123',
    ]);
    schemaDenied = true;
    expect((await connector().listObjects(context('hubspot'))).map((object) => object.name)).toEqual([
      'contacts',
      'companies',
      'deals',
      'tickets',
    ]);
    expect((await connector().test(context('hubspot'))).ok).toBe(true);
  });

  it('follows three HubSpot cursor pages and batches visible properties into dotted columns', async () => {
    const rows = await read('hubspot', 'contacts', ['id', 'properties.email', `properties.${names.at(-1)!}`]);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.key)).toEqual(['["1"]', '["2"]', '["3"]']);
    expect(rows.map((row) => row.values.id)).toEqual(['1', '2', '3']);
    expect(rows.every((row) => row.values[`properties.${names.at(-1)!}`] !== null)).toBe(true);
    const pages = requests.filter((request) => request.path === '/crm/v3/objects/contacts');
    expect(
      pages
        .filter((request) => request.query.get('properties')?.startsWith('email,'))
        .map((request) => request.query.get('after')),
    ).toEqual([null, 'second', 'third']);
    expect(pages.length).toBeGreaterThan(3);
    for (const page of pages) {
      expect(page.query.get('limit')).toBe('100');
      expect(page.query.get('properties')?.includes('hidden_value')).toBe(false);
      expect(`${origin}${page.path}?${page.query.toString()}`.length).toBeLessThanOrEqual(2_048);
    }
    const described = await connector().describe(context('hubspot'), select('contacts'));
    expect(described.map((column) => column.name)).toContain('properties.email');
    expect(described.map((column) => column.name)).toContain(`properties.${names.at(-1)!}`);
    expect(described.map((column) => column.name)).not.toContain('properties.hidden_value');
    expect(await connector().keyCandidates(context('hubspot'), { schema: null, name: 'contacts' })).toEqual([
      ['id'],
    ]);
    expect(requests.every((request) => request.method === 'GET' && request.signed)).toBe(true);
  });

  it('previews and reads discovered custom objects with their requested properties', async () => {
    const preview = await connector().preview(context('hubspot'), select('2-123'), 1);
    expect(preview.rows).toHaveLength(1);
    expect(preview.columns.map((column) => column.name)).toContain('properties.email');
    expect(await read('hubspot', '2-123')).toHaveLength(3);
  });

  it('lists Pipedrive v2 objects, follows next_cursor to null, and sends its key only in the header', async () => {
    expect((await connector().listObjects(context('pipedrive'))).map((object) => object.name)).toEqual([
      'persons',
      'organizations',
      'deals',
      'activities',
      'products',
    ]);
    requests.length = 0;
    const rows = await read('pipedrive', 'persons');
    expect(rows).toHaveLength(3);
    expect(requests.map((request) => request.query.get('cursor'))).toEqual([null, 'second', 'third']);
    expect(
      requests.every(
        (request) => request.path.startsWith('/api/v2/') && request.method === 'GET' && request.signed,
      ),
    ).toBe(true);
    expect(requests.every((request) => request.query.get('limit') === '500')).toBe(true);
    expect(
      requests.every((request) => !request.query.toString().includes(KEY) && !request.query.has('api_token')),
    ).toBe(true);
  });

  it('accepts empty accounts in previews and full reads', async () => {
    empty = true;
    for (const [app, name] of [
      ['hubspot', 'contacts'],
      ['pipedrive', 'persons'],
    ] as const) {
      expect(await read(app, name)).toEqual([]);
      expect((await connector().preview(context(app), select(name), 5)).rows).toEqual([]);
      expect((await connector().test(context(app))).ok).toBe(true);
      expect(await connector().keyCandidates(context(app), { schema: null, name })).toEqual([['id']]);
    }
  });

  it('waits out Retry-After through the API source’s retry rules', async () => {
    retry = true;
    expect(await read('pipedrive', 'persons')).toHaveLength(3);
    expect(retryWait).toBeGreaterThanOrEqual(950);
    expect(requests).toHaveLength(4);
  });

  it('keeps the full read deadline for retries on the first and later property batches', async () => {
    retryPropertyBatches.add(1);
    retryPropertyBatches.add(2);
    const source = connector(APP_PRESETS, 5_000);
    const rows: SourceRow[] = [];
    for await (const batch of source.read({ ...context('hubspot'), timeoutMs: 250 }, select('contacts'), {
      columns: ['id'],
      types: { id: 'text' },
      keyColumns: ['id'],
      batchSize: 2,
    }))
      rows.push(...batch);
    expect(rows).toHaveLength(3);
    expect(retryPropertyBatches.size).toBe(0);
    expect(retryWait).toBeGreaterThanOrEqual(950);
    const firstPage = requests.filter(
      (request) => request.path === '/crm/v3/objects/contacts' && !request.query.has('after'),
    );
    expect(firstPage.filter((request) => request.query.get('properties')?.startsWith('email,'))).toHaveLength(
      2,
    );
    expect(
      firstPage.filter((request) => !request.query.get('properties')?.startsWith('email,')),
    ).toHaveLength(2);
  });

  it('stops a later property batch when the caller cancels the read', async () => {
    retryPropertyBatches.add(2);
    const controller = new AbortController();
    onPropertyRetry = () => controller.abort();
    const source = connector(APP_PRESETS, 5_000);
    const consume = async () => {
      for await (const batch of source.read(
        { ...context('hubspot'), signal: controller.signal },
        select('contacts'),
        { columns: ['id'], types: { id: 'text' }, keyColumns: ['id'], batchSize: 2 },
      ))
        expect(batch).toEqual([]);
    };
    await expect(consume()).rejects.toMatchObject({ messageKey: 'sources.app.read' });
    expect(controller.signal.aborted).toBe(true);
    expect(requests.filter((request) => request.path === '/crm/v3/objects/contacts')).toHaveLength(2);
    expect(retryAt).toBeGreaterThan(0);
  });

  it('refuses a later property retry that exceeds the remaining read deadline', async () => {
    retryPropertyBatches.add(2);
    const source = connector(APP_PRESETS, 800);
    const consume = async () => {
      for await (const batch of source.read(context('hubspot'), select('contacts'), {
        columns: ['id'],
        types: { id: 'text' },
        keyColumns: ['id'],
        batchSize: 2,
      }))
        expect(batch).toEqual([]);
    };
    await expect(consume()).rejects.toMatchObject({ messageKey: 'sources.app.rateLimited' });
    expect(requests.filter((request) => request.path === '/crm/v3/objects/contacts')).toHaveLength(2);
    expect(retryWait).toBe(0);
  });

  it('refuses unknown apps, undeclared settings, and missing keys with distinct messages', async () => {
    const base = context('hubspot');
    for (const [ctx, messageKey] of [
      [{ ...base, connection: { kind: 'app', app: 'missing', settings: {} } }, 'sources.app.unknown'],
      [
        {
          ...base,
          connection: { kind: 'app', app: 'hubspot', settings: { baseUrl: 'https://elsewhere.test' } },
        },
        'sources.app.undeclaredSetting',
      ],
      [
        {
          ...base,
          connection: {
            kind: 'app',
            app: 'hubspot',
            settings: {},
            baseUrl: 'https://elsewhere.test',
          } as ConnectorContext['connection'],
        },
        'sources.app.address',
      ],
      [{ ...base, secrets: {} }, 'sources.app.secretMissing'],
    ] as const) {
      await expect(connector().listObjects(ctx)).rejects.toMatchObject({ messageKey });
      expect((await connector().test(ctx)).steps.at(-1)?.messageKey).toBe(messageKey);
    }
    expect(requests).toEqual([]);
  });

  it('refuses a customer address on another domain before the guarded network is called', async () => {
    const preset: AppPreset = {
      ...APP_PRESETS[1]!,
      catalog: {
        ...APP_PRESETS[1]!.catalog,
        settings: [
          {
            key: 'account',
            type: 'address',
            domain: 'pipedrive.com',
            required: true,
            labelMessageId: 'sources.app.settingRequired',
            helpMessageId: 'sources.app.address',
          },
        ],
      },
      target: { ...APP_PRESETS[1]!.target, address: { setting: 'account', domain: 'pipedrive.com' } },
    };
    const options = restConnectorOptions(
      { production: false, automationsAllowPrivateHosts: true },
      async () => [{ address: '127.0.0.1', family: 4 }],
    );
    const source = createAppConnector(options, [preset]);
    const base = context('pipedrive');
    const ctx: ConnectorContext = {
      ...base,
      connection: { kind: 'app', app: 'pipedrive', settings: { account: 'https://other.example.test' } },
    };
    await expect(source.listObjects(ctx)).rejects.toMatchObject({ messageKey: 'sources.app.address' });
    expect((await source.test(ctx)).steps.at(-1)?.messageKey).toBe('sources.app.address');
    expect(requests).toEqual([]);
  });

  it('scrubs API error answers and refuses malformed discovery or changed property batches', async () => {
    refused = true;
    const error: unknown = await read('pipedrive', 'persons').catch((error: unknown) => error);
    expect(error instanceof ConnectorError).toBe(true);
    expect(String(error).includes(KEY)).toBe(false);
    expect((error as ConnectorError).messageKey).toBe('sources.app.pipedrive.deniedToken');
    refused = false;
    brokenProperties = true;
    await expect(read('hubspot', 'contacts')).rejects.toMatchObject({ messageKey: 'sources.app.discovery' });
    brokenProperties = false;
    changedBatch = true;
    await expect(read('hubspot', 'contacts')).rejects.toMatchObject({
      messageKey: 'sources.app.batchChanged',
    });
  });

  it('uses the server’s private-network guard even for a preset’s fixed address', async () => {
    const guarded = createAppConnector(
      restConnectorOptions({ production: true, automationsAllowPrivateHosts: false }, async () => [
        { address: '127.0.0.1', family: 4 },
      ]),
    );
    await expect(guarded.preview(context('pipedrive'), select('persons'), 1)).rejects.toMatchObject({
      messageKey: 'sources.app.blocked',
    });
    expect(requests).toEqual([]);
  });

  it('delegates a preset’s GraphQL query and refuses a mutation before any request', async () => {
    const preset: AppPreset = {
      ...APP_PRESETS[1]!,
      objects: [
        {
          name: 'items',
          key: 'id',
          graphql: {
            query: 'query { items { id name } pageInfo { hasNextPage endCursor } }',
            variables: {},
            records: 'data.items',
            paging: { style: 'cursor', pageInfo: 'data.pageInfo', variable: 'after' },
            maxPages: 10,
          },
        },
      ],
      target: { ...APP_PRESETS[1]!.target, address: `${origin}/graphql` },
    };
    const options = restConnectorOptions(
      { production: false, automationsAllowPrivateHosts: true },
      async () => [{ address: '127.0.0.1', family: 4 }],
    );
    const graphql = createAppConnector(options, [preset]);
    expect((await graphql.preview(context('pipedrive'), select('items'), 1)).rows).toHaveLength(1);
    expect(requests.map((request) => request.method)).toEqual(['POST']);
    const object = preset.objects[0]!;
    if (!('graphql' in object)) throw new Error('Unexpected fixture shape');
    const mutation = createAppConnector(options, [
      {
        ...preset,
        objects: [{ ...object, graphql: { ...object.graphql, query: 'mutation { deleteItem }' } }],
      },
    ]);
    const before = requests.length;
    await expect(mutation.preview(context('pipedrive'), select('items'), 1)).rejects.toMatchObject({
      messageKey: 'sources.app.queryOnly',
    });
    expect(requests).toHaveLength(before);
  });
});
