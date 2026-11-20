/**
 * API sources through the server: the guarded network they reach an API through, the checks a
 * source's addresses meet before it's saved, the setup preview, and whole syncs from a local API
 * into tables, overrides and all, with the secret nowhere it shouldn't be.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppError,
  newId,
  RestConnection,
  type CommandBatchResult,
  type DatabaseSchema,
  type RowData,
  type SourceMeta,
  type SourceObject,
  type SourcePreview,
  type SourceTestResult,
  type TableMeta,
} from '@riosoma/contracts';
import { ConnectorError, createRestConnector, type ConnectorContext } from '@riosoma/connectors';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { fetchRowsById } from '../data/physical/records.js';
import { fileNetwork } from './files.js';
import { checkApiAddress } from './rest.js';
import { claimSyncs, runSync } from './sync.js';

const TOKEN = 'api-token-value';
let people: Array<Record<string, unknown>> = [];
const seen: Array<{ path: string; method: string; headers: IncomingHttpHeaders }> = [];
let api: Server;
let origin = '';
let kit: TestPostgres;
let server: ServerFixture;
let databaseId: string;

function person(id: number, name: string, amount: number, joined: string) {
  return { id, name, amount, joined, team: { name: id % 2 ? 'North' : 'South' } };
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<[Server, string]> {
  const listener = createServer(handler);
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  return [listener, `http://127.0.0.1:${(listener.address() as AddressInfo).port}`];
}

beforeAll(async () => {
  people = [
    person(1, 'Ada', 10.5, '2026-09-27'),
    person(2, 'Grace', 20, '2026-10-01'),
    person(3, 'Linus', 30, '2026-01-02'),
  ];
  [api, origin] = await listen((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    seen.push({ path: url.pathname, method: req.method ?? 'GET', headers: req.headers });
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const redirects: Record<string, string> = {
      '/v1/to-private': 'https://api.example.test/v1/people',
      '/v1/to-metadata': 'http://169.254.169.254/latest/meta-data',
      '/token-moved': `${origin}/token`,
    };
    if (redirects[url.pathname]) {
      res.writeHead(302, { location: redirects[url.pathname]! });
      return res.end();
    }
    if (url.pathname === '/token') return json(200, { access_token: 'never-used', expires_in: 60 });
    if (req.headers.authorization !== `Bearer ${TOKEN}`)
      return json(401, { message: `the token in ${String(req.headers.authorization)} is wrong` });
    if (url.pathname === '/v1/people') {
      const page = Number(url.searchParams.get('page') ?? 1);
      return json(200, { data: people.slice((page - 1) * 2, page * 2) });
    }
    if (url.pathname === '/v1/endless') {
      const page = Number(url.searchParams.get('page') ?? 1);
      return json(200, { data: [{ id: page }] });
    }
    json(404, { message: 'no such thing' });
  });
  kit = await startTestPostgres();
  // Private hosts are allowed, so the test's own API on this machine can be reached.
  server = await startServer(kit, 'restsrc', { automationsAllowPrivateHosts: true });
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: newId('database'),
      name: 'APIs',
      table: {
        id: newId('table'),
        name: 'Local',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  databaseId = created.json<DatabaseSchema>().database.id;
}, 60_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

const PEOPLE = { name: 'People', path: '/people', records: 'data', paging: { style: 'page', size: 2 } };
const OBJECT = { kind: 'object' as const, object: { schema: null, name: 'People' } };

function connection(baseUrl = `${origin}/v1`, endpoint: Record<string, unknown> = PEOPLE, extra = {}) {
  return RestConnection.parse({
    kind: 'rest',
    baseUrl,
    auth: { method: 'bearer' },
    endpoints: [endpoint],
    requestsPerSecond: 50,
    ...extra,
  });
}

/** A connector on the real guarded network, where names resolve the way a hostile one might. */
function guarded() {
  return createRestConnector({
    network: fileNetwork({
      resolve: async (host) =>
        host === 'api.example.test'
          ? [{ address: '10.0.0.5', family: 4 }]
          : [{ address: '93.184.216.34', family: 4 }],
      // Only this test's own API may be reached on a private address.
      allowPrivate: (url) => url.hostname === '127.0.0.1',
    }),
    sockets: { connect: async () => undefined, handshake: async () => undefined },
  });
}

function context(settings: RestConnection, secrets: ConnectorContext['secrets'] = { token: TOKEN }) {
  return { connection: settings, secrets, timeoutMs: 10_000 } satisfies ConnectorContext;
}

async function refusal(work: Promise<unknown>): Promise<ConnectorError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ConnectorError);
  return error as ConnectorError;
}

async function createSource(settings: RestConnection, secrets: Record<string, string>): Promise<SourceMeta> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: { name: `API ${newId('source')}`, connection: settings, secrets },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<SourceMeta>();
}

async function applied(input: Record<string, unknown>) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<CommandBatchResult>().results[0]!;
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
}

async function sync(tableId: string): Promise<TableMeta> {
  await applied({ kind: 'table.sync', tableId, confirmRemovals: false });
  for (const job of await claimSyncs(server.ctx, 100)) await runSync(server.ctx, job);
  return (await loadTable(server.pool, server.schemas, tableId))!;
}

async function rows(tableId: string): Promise<RowData[]> {
  const ids = await query<{ __id: string }>(
    server.pool,
    sql`SELECT __id FROM ${ident(server.schemas.data, tableId)} WHERE NOT __source_gone ORDER BY __rid`,
  );
  const fields = await loadFields(server.pool, server.schemas, [tableId]);
  return fetchRowsById(
    server.pool,
    server.schemas.data,
    tableId,
    fields,
    ids.rows.map((row) => row.__id),
  );
}

describe('the guarded network for API sources', () => {
  it('refuses private addresses, including one a redirect names, before anything connects', async () => {
    const connector = guarded();
    const direct = await refusal(
      connector.describe(context(connection('https://api.example.test/v1')), OBJECT),
    );
    expect(direct.messageKey).toBe('sources.rest.blocked');
    const before = seen.length;
    for (const path of ['/to-private', '/to-metadata']) {
      const redirected = await refusal(
        connector.describe(context(connection(`${origin}/v1`, { ...PEOPLE, path })), OBJECT),
      );
      expect(redirected.messageKey).toBe('sources.rest.blocked');
    }
    // Only the redirecting answers were ever asked for.
    expect(seen.slice(before).map((entry) => entry.path)).toEqual(['/v1/to-private', '/v1/to-metadata']);
    const insecure = await refusal(
      connector.describe(context(connection('http://api.example.com/v1')), OBJECT),
    );
    expect(insecure.messageKey).toBe('sources.rest.https');
    const test = await connector.test(context(connection('https://api.example.test/v1')));
    expect(test.steps).toEqual([
      expect.objectContaining({ step: 'resolve', status: 'failed', messageKey: 'sources.rest.blocked' }),
    ]);
  });

  it('posts OAuth’s token request without following a redirect', async () => {
    const connector = guarded();
    const settings = connection(`${origin}/v1`, PEOPLE, {
      auth: { method: 'oauth-client', tokenUrl: `${origin}/token-moved`, clientId: 'rio' },
    });
    const before = seen.length;
    const moved = await refusal(
      connector.describe(context(settings, { clientSecret: 'oauth-secret' }), OBJECT),
    );
    expect(moved.messageKey).toBe('sources.rest.oauthFailed');
    expect(seen.slice(before).map((entry) => [entry.method, entry.path])).toEqual([['POST', '/token-moved']]);
  });

  it('refuses addresses before a source is saved', async () => {
    const strict = { production: true, automationsAllowPrivateHosts: false };
    const problem = (baseUrl: string, tokenUrl?: string) => {
      try {
        checkApiAddress(
          connection(
            baseUrl,
            PEOPLE,
            tokenUrl ? { auth: { method: 'oauth-client', tokenUrl, clientId: 'rio' } } : {},
          ),
          strict,
        );
        return null;
      } catch (error) {
        return error instanceof AppError
          ? [error.messageKey, Object.keys(error.fields ?? {})]
          : String(error);
      }
    };
    expect(problem('https://api.example.com/v1')).toBeNull();
    expect(problem('http://api.example.com/v1')).toEqual(['sources.rest.https', ['baseUrl']]);
    expect(problem('http://localhost:8000')).toEqual(['sources.rest.https', ['baseUrl']]);
    expect(problem('https://10.1.2.3/v1')).toEqual(['sources.rest.blocked', ['baseUrl']]);
    expect(problem('https://api.example.com', 'https://[::1]/token')).toEqual([
      'sources.rest.blocked',
      ['tokenUrl'],
    ]);
    const insecure = await server.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: server.owner.headers,
      payload: {
        name: 'Plain',
        connection: connection('http://api.example.com/v1'),
        secrets: { token: TOKEN },
      },
    });
    expect(insecure.json()).toMatchObject({
      error: { messageKey: 'sources.rest.https', fields: { baseUrl: 'sources.rest.https' } },
    });
    expect(insecure.body).not.toContain(TOKEN);
  });
});

describe('setting up an API source', () => {
  it('previews an endpoint’s first page before and after saving, with the secret it was given', async () => {
    const draft = await server.app.inject({
      method: 'POST',
      url: '/api/sources/endpoint-preview',
      headers: server.owner.headers,
      payload: {
        connection: { kind: 'rest', baseUrl: `${origin}/v1`, auth: { method: 'bearer' } },
        secrets: { token: TOKEN },
        endpoint: PEOPLE,
      },
    });
    expect(draft.statusCode, draft.body).toBe(200);
    const shown = draft.json<SourcePreview>();
    expect(shown.columns.map((column) => [column.name, column.suggested?.type])).toEqual([
      ['id', 'number'],
      ['name', 'text'],
      ['amount', 'number'],
      ['joined', 'date'],
      ['team.name', 'text'],
    ]);
    // Only the first page, however many there are.
    expect(shown.rows).toEqual([
      [1, 'Ada', 10.5, '2026-09-27', 'North'],
      [2, 'Grace', 20, '2026-10-01', 'South'],
    ]);
    expect(shown.keyCandidates).toEqual([]);

    const wrong = await server.app.inject({
      method: 'POST',
      url: '/api/sources/endpoint-preview',
      headers: server.owner.headers,
      payload: {
        connection: { kind: 'rest', baseUrl: `${origin}/v1`, auth: { method: 'bearer' } },
        secrets: { token: 'wrong-token-value' },
        endpoint: PEOPLE,
      },
    });
    expect(wrong.json()).toMatchObject({ error: { messageKey: 'sources.rest.deniedToken' } });
    expect(wrong.body).not.toContain('wrong-token-value');

    const source = await createSource(connection(), { token: TOKEN });
    const saved = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/endpoint-preview`,
      headers: server.owner.headers,
      payload: { endpoint: { ...PEOPLE, name: 'Everyone', path: '/people', paging: { style: 'none' } } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<SourcePreview>().rows).toHaveLength(2);
  });

  it('asks for the secret again when the base address moves, but not when endpoints change', async () => {
    const source = await createSource(connection(), { token: TOKEN });
    const tested = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/test`,
      headers: server.owner.headers,
    });
    expect(tested.json<SourceTestResult>().steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'skipped'],
      ['authenticate', 'ok'],
      ['read', 'ok'],
      ['records', 'ok'],
      ['paging', 'ok'],
    ]);
    const more = await server.app.inject({
      method: 'PATCH',
      url: `/api/sources/${source.id}`,
      headers: server.owner.headers,
      payload: {
        connection: connection(`${origin}/v1`, PEOPLE, {
          endpoints: [
            PEOPLE,
            { name: 'Endless', path: '/endless', records: 'data', paging: { style: 'page' } },
          ],
          requestsPerSecond: 10,
        }),
      },
    });
    expect(more.statusCode, more.body).toBe(200);
    expect(more.json<SourceMeta>().secrets).toEqual(['token']);
    const objects = await server.app.inject({
      url: `/api/sources/${source.id}/objects`,
      headers: server.owner.headers,
    });
    expect(objects.json<SourceObject[]>().map((object) => [object.name, object.type])).toEqual([
      ['People', 'endpoint'],
      ['Endless', 'endpoint'],
    ]);
    const moved = await server.app.inject({
      method: 'PATCH',
      url: `/api/sources/${source.id}`,
      headers: server.owner.headers,
      payload: { connection: connection('https://api.example.com/v1') },
    });
    expect(moved.json()).toMatchObject({ error: { messageKey: 'sources.secretsReenter' } });
  });

  it('says a secret was refused without repeating it', async () => {
    const source = await createSource(connection(), { token: 'wrong-token-value' });
    const tested = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/test`,
      headers: server.owner.headers,
    });
    expect(tested.json<SourceTestResult>().steps.at(-1)).toMatchObject({
      step: 'authenticate',
      status: 'failed',
      messageKey: 'sources.rest.deniedToken',
    });
    expect(tested.body).not.toContain('wrong-token-value');
  });
});

describe('syncing an API into a table', () => {
  it('syncs every page, keeps an override through the next sync, and never records the secret', async () => {
    const source = await createSource(connection(), { token: TOKEN });
    expect(JSON.stringify(source)).not.toContain(TOKEN);
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/preview`,
      headers: server.owner.headers,
      payload: { select: OBJECT },
    });
    expect(response.statusCode, response.body).toBe(200);
    const shown = response.json<SourcePreview>();
    expect(shown.keyCandidates[0]).toEqual(['id']);
    expect(shown.rowEstimate).toBe(3);

    const tableId = newId('table');
    const field = Object.fromEntries(shown.columns.map((column) => [column.name, newId('field')]));
    await applied({
      kind: 'table.create',
      table: {
        id: tableId,
        name: 'People',
        source: { sourceId: source.id, select: OBJECT, keyColumns: ['id'], everyMinutes: null },
        fields: ['name', 'id', 'amount', 'joined', 'team.name'].map((name) => {
          const column = shown.columns.find((entry) => entry.name === name)!;
          return {
            id: field[name],
            name,
            type: column.suggested!.type,
            options: column.suggested!.options,
            source: { column: name, sourceType: column.sourceType },
          };
        }),
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    });
    const first = await sync(tableId);
    expect(first.source!.status, JSON.stringify(first.source!.status)).toMatchObject({
      state: 'idle',
      stats: { added: 3 },
    });
    const grace = (await rows(tableId)).find((row) => row.values[field.id!] === 2)!;
    expect(grace.values).toMatchObject({
      [field.name!]: 'Grace',
      [field.amount!]: 20,
      [field.joined!]: '2026-10-01',
      [field['team.name']!]: 'South',
    });
    await applied({
      kind: 'record.update',
      tableId,
      records: [{ id: grace.id, values: { [field.name!]: 'Grace Hopper' } }],
    });

    // The API changes: Grace's name and amount move, Linus leaves, and Katherine arrives.
    people = [
      person(1, 'Ada', 10.5, '2026-09-27'),
      person(2, 'G. Hopper', 25, '2026-10-01'),
      person(4, 'Katherine', 40, '2026-02-03'),
    ];
    const second = await sync(tableId);
    expect(second.source!.status.stats).toMatchObject({ added: 1, changed: 1, removed: 1 });
    const after = await rows(tableId);
    expect(after.map((row) => row.values[field.id!])).toEqual([1, 2, 4]);
    const kept = after.find((row) => row.id === grace.id)!;
    expect(kept.values).toMatchObject({ [field.name!]: 'Grace Hopper', [field.amount!]: 25 });
    expect(kept.overrides![field.name!]).toMatchObject({ source: 'G. Hopper' });

    // The token is nowhere: not in the change history, the audit log, the sync status, or the list.
    const changes = await query<{ body: unknown }>(
      server.pool,
      sql`SELECT body FROM ${ident(server.schemas.app, 'changes')} WHERE table_id = ${tableId}`,
    );
    const events = await query<{ detail: unknown }>(
      server.pool,
      sql`SELECT * FROM ${ident(server.schemas.audit, 'events')}`,
    );
    const listed = await server.app.inject({ url: '/api/sources', headers: server.owner.headers });
    for (const text of [
      JSON.stringify(changes.rows),
      JSON.stringify(events.rows),
      JSON.stringify(second.source),
      listed.body,
    ])
      expect(text).not.toContain(TOKEN);
  });

  it('fails a sync that pages past its limit, saying which limit, and removes nothing', async () => {
    const source = await createSource(
      connection(`${origin}/v1`, {
        name: 'Endless',
        path: '/endless',
        records: 'data',
        paging: { style: 'page' },
        maxPages: 3,
      }),
      { token: TOKEN },
    );
    const select = { kind: 'object' as const, object: { schema: null, name: 'Endless' } };
    const tableId = newId('table');
    await applied({
      kind: 'table.create',
      table: {
        id: tableId,
        name: 'Endless',
        source: { sourceId: source.id, select, keyColumns: ['id'], everyMinutes: null },
        fields: [
          {
            id: newId('field'),
            name: 'id',
            type: 'number',
            options: { precision: 0 },
            source: { column: 'id', sourceType: 'number' },
          },
        ],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    });
    const failed = await sync(tableId);
    expect(failed.source!.status).toMatchObject({
      state: 'failed',
      error: { messageKey: 'sources.rest.pageLimit' },
    });
    expect(JSON.stringify(failed.source!.status)).toContain('"pages":3');
    expect(await rows(tableId)).toEqual([]);
  });
});
