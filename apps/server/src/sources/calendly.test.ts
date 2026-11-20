import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppConnection, SourceConnection, type SourceSelect } from '@riosoma/contracts';
import { APP_PRESETS, createAppConnector, type ConnectorContext, type SourceRow } from '@riosoma/connectors';
import { restConnectorOptions } from './rest.js';
import { checkSecrets } from './store.js';

const token = randomBytes(24).toString('hex');
const preset = APP_PRESETS.find((entry) => entry.catalog.id === 'calendly')!;
const names = ['scheduled_events', 'event_types', 'organization_memberships'];
const organization = 'https://api.calendly.com/organizations/example';
let listener: Server;
let origin: string;
let empty = false;
let refused = 0;
let account: unknown = organization;
let nextElsewhere = false;
const requests: Array<{ path: string; method: string; query: URLSearchParams; signed: boolean; at: number }> =
  [];

beforeAll(async () => {
  listener = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const signed = req.headers.authorization === `Bearer ${token}`;
    requests.push({
      path: url.pathname,
      method: req.method ?? '',
      query: url.searchParams,
      signed,
      at: Date.now(),
    });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (refused || !signed) return json(refused || 401, { message: `refused ${token}` });
    if (url.pathname === '/users/me')
      return json(200, {
        resource: {
          uri: 'https://api.calendly.com/users/example',
          current_organization: account,
          name: 'Example Person',
        },
      });
    const name = url.pathname.slice(1);
    if (!names.includes(name)) return json(404, {});
    if (url.searchParams.get('organization') !== account || url.searchParams.get('count') !== '100')
      return json(400, {});
    const page = url.searchParams.get('page_token');
    const number = page === 'second' ? 2 : page === 'third' ? 3 : 1;
    const last = empty || number === 3;
    const next = new URL(url.pathname, origin);
    next.searchParams.set('organization', String(account));
    next.searchParams.set('count', '100');
    next.searchParams.set('page_token', number === 1 ? 'second' : 'third');
    const record = {
      uri: `https://api.calendly.com/${name}/example-${number}`,
      ...(name === 'scheduled_events'
        ? { name: `Example event ${number}`, status: number === 2 ? 'canceled' : 'active' }
        : name === 'event_types'
          ? { name: `Example type ${number}`, active: true }
          : { role: 'user', user: { uri: `https://api.calendly.com/users/example-${number}` } }),
    };
    return json(200, {
      collection: empty ? [] : [record],
      pagination: {
        count: empty ? 0 : 1,
        next_page: last ? null : nextElsewhere ? 'https://elsewhere.test/page' : next.href,
        next_page_token: last ? null : number === 1 ? 'second' : 'third',
      },
    });
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  origin = `http://localhost:${(listener.address() as AddressInfo).port}`;
});

beforeEach(() => {
  requests.length = 0;
  empty = false;
  refused = 0;
  account = organization;
  nextElsewhere = false;
});

afterAll(async () => {
  listener.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
});

function connector() {
  return createAppConnector(
    restConnectorOptions({ production: false, automationsAllowPrivateHosts: true }, async () => [
      { address: '127.0.0.1', family: 4 },
    ]),
    // Only the test-owned preset points at the fake API.  Its pacing and sign-in stay intact.
    [{ ...preset, target: { ...preset.target, address: origin } }],
  );
}

function context(): ConnectorContext {
  return {
    connection: AppConnection.parse({ kind: 'app', app: 'calendly' }),
    secrets: { token },
    timeoutMs: 10_000,
  };
}

const select = (name: string): SourceSelect => ({ kind: 'object', object: { schema: null, name } });

async function read(name: string, columns = ['uri']) {
  const rows: SourceRow[] = [];
  for await (const batch of connector().read(context(), select(name), {
    columns,
    types: Object.fromEntries(columns.map((column) => [column, 'text'])),
    keyColumns: ['uri'],
    batchSize: 2,
  }))
    rows.push(...batch);
  return rows;
}

describe('Calendly on the server’s guarded network', () => {
  it('finds the organization during the test and before listing, using only paced, signed GETs', async () => {
    expect(preset.target.address).toBe('https://api.calendly.com');
    expect(preset.target.requestsPerSecond).toBe(0.5);
    expect(preset.catalog.settings).toEqual([]);
    expect(preset.catalog.keyUrl).toBe('https://calendly.com/integrations/api_webhooks');
    expect((await connector().test(context())).ok).toBe(true);
    const inspection = ['/scheduled_events', '/event_types', '/organization_memberships'];
    expect(requests.map((request) => request.path)).toEqual([
      '/users/me',
      '/scheduled_events',
      ...inspection,
    ]);
    expect(requests[1]!.query.get('organization')).toBe(organization);
    expect(requests[1]!.query.get('count')).toBe('100');
    expect(requests[1]!.at - requests[0]!.at).toBeGreaterThanOrEqual(1_900);
    const objects = await connector().listObjects(context());
    expect(objects).toEqual(
      names.map((name) => ({ schema: null, name, type: 'endpoint', rowEstimate: null })),
    );
    expect(requests.map((request) => request.path)).toEqual([
      '/users/me',
      '/scheduled_events',
      ...inspection,
      '/users/me',
      ...inspection,
    ]);
    expect(
      requests
        .filter((request) => request.path !== '/users/me')
        .every(
          (request) =>
            request.query.get('organization') === organization && request.query.get('count') === '100',
        ),
    ).toBe(true);
    for (let index = 1; index < requests.length; index++)
      expect(requests[index]!.at - requests[index - 1]!.at).toBeGreaterThanOrEqual(1_900);
    expect(requests.every((request) => request.method === 'GET' && request.signed)).toBe(true);
    expect(requests.every((request) => !request.query.toString().includes(token))).toBe(true);
  });

  it.each(names)('reads three pages of %s, stops at null, and retains URI keys and status', async (name) => {
    const columns = name === 'scheduled_events' ? ['uri', 'status'] : ['uri'];
    const rows = await read(name, columns);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
    expect(rows.every((row) => typeof row.values.uri === 'string')).toBe(true);
    expect(rows.map((row) => row.key)).toEqual(rows.map((row) => JSON.stringify([row.values.uri])));
    if (name === 'scheduled_events')
      expect(rows.map((row) => row.values.status)).toEqual(['active', 'canceled', 'active']);
    expect(requests.map((request) => request.path)).toEqual(['/users/me', ...Array(3).fill(`/${name}`)]);
    const pages = requests.filter((request) => request.path === `/${name}`);
    expect(pages.map((request) => request.query.get('page_token'))).toEqual([null, 'second', 'third']);
    expect(pages.every((request) => request.query.get('organization') === organization)).toBe(true);
    expect(
      pages.every((request) => request.query.get('count') === '100' && !request.query.has('status')),
    ).toBe(true);
    expect(requests.every((request) => request.method === 'GET' && request.signed)).toBe(true);
    const source = connector();
    const preview = await source.preview(context(), select(name), 3);
    expect(preview.rows).toHaveLength(3);
    expect(preview.columns.map((column) => column.name)).toContain('uri');
    expect(preview.rows.every((row) => row.length === preview.columns.length)).toBe(true);
    expect((await source.describe(context(), select(name))).map((column) => column.name)).toContain('uri');
    expect(await source.keyCandidates(context(), { schema: null, name })).toEqual([['uri']]);
  });

  it.each(names)('accepts an empty %s list with zero preview and read rows', async (name) => {
    empty = true;
    expect(await read(name)).toEqual([]);
    const source = connector();
    expect((await source.preview(context(), select(name), 3)).rows).toEqual([]);
    expect(await source.describe(context(), select(name))).toEqual([]);
    expect(await source.keyCandidates(context(), { schema: null, name })).toEqual([['uri']]);
    expect(requests.filter((request) => request.path === `/${name}`)).toHaveLength(3);
    expect((await source.test(context())).ok).toBe(true);
  });

  it.each([401, 403])(
    'names a refused personal access token at HTTP %s without exposing it',
    async (status) => {
      refused = status;
      const result = await connector().test(context());
      expect(result.ok).toBe(false);
      expect(result.steps.at(-1)?.messageKey).toBe('sources.app.calendly.deniedToken');
      expect(JSON.stringify(result).includes(token)).toBe(false);
      const error = await connector()
        .listObjects(context())
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ messageKey: 'sources.app.calendly.deniedToken' });
      expect(JSON.stringify(error).includes(token)).toBe(false);
      expect(requests.every((request) => request.path === '/users/me')).toBe(true);
    },
  );

  it.each([undefined, null, 42, '', ' ', 'x'.repeat(2_049), 'invalid\nvalue'])(
    'refuses invalid organization information without listing or requesting an object',
    async (value) => {
      account = value;
      await expect(connector().listObjects(context())).rejects.toMatchObject({
        messageKey: 'sources.app.accountValues',
      });
      expect(requests.map((request) => request.path)).toEqual(['/users/me']);
    },
  );

  it('finds fresh organization information for each operation', async () => {
    const source = connector();
    await source.listObjects(context());
    account = 'https://api.calendly.com/organizations/other';
    await source.preview(context(), select('event_types'), 1);
    expect(requests.filter((request) => request.path === '/users/me')).toHaveLength(2);
    expect(requests.filter((request) => request.path === '/event_types')[0]!.query.get('organization')).toBe(
      organization,
    );
    expect(requests.filter((request) => request.path === '/event_types')[1]!.query.get('organization')).toBe(
      account,
    );
  });

  it('refuses a next page on another host before sending the key', async () => {
    nextElsewhere = true;
    await expect(read('scheduled_events')).rejects.toMatchObject({ messageKey: 'sources.app.nextElsewhere' });
    expect(requests.map((request) => request.path)).toEqual(['/users/me', '/scheduled_events']);
  });

  it.each([
    ['organization setting', { settings: { organization } }, 'sources.app.undeclaredSetting'],
    ['count setting', { settings: { count: '1' } }, 'sources.app.undeclaredSetting'],
    ['status setting', { settings: { status: 'active' } }, 'sources.app.undeclaredSetting'],
    ['token setting', { settings: { token: 'value' } }, 'sources.app.undeclaredSetting'],
    ['base address', { baseUrl: 'https://elsewhere.test' }, 'sources.app.address'],
    ['pacing override', { requestsPerSecond: 100 }, 'sources.app.settingInvalid'],
    ['sign-in override', { auth: { method: 'none' } }, 'sources.app.settingInvalid'],
    ['endpoint override', { endpoints: [] }, 'sources.app.settingInvalid'],
    ['invalid settings', { settings: [] }, 'sources.app.settingInvalid'],
    ['unknown app', { app: 'missing' }, 'sources.app.unknown'],
  ])('refuses %s before reaching the app with its own message', async (_rule, overrides, messageKey) => {
    const ctx = context();
    ctx.connection = { ...ctx.connection, ...overrides } as ConnectorContext['connection'];
    expect((await connector().test(ctx)).steps[0]?.messageKey).toBe(messageKey);
    await expect(connector().listObjects(ctx)).rejects.toMatchObject({ messageKey });
    expect(requests).toEqual([]);
  });

  it('refuses a missing token through both the connector and server validation before making requests', async () => {
    const ctx = { ...context(), secrets: {} };
    expect((await connector().test(ctx)).steps[0]?.messageKey).toBe('sources.app.secretMissing');
    await expect(connector().listObjects(ctx)).rejects.toMatchObject({
      messageKey: 'sources.app.secretMissing',
    });
    expect(() => checkSecrets(SourceConnection.parse(ctx.connection), {})).toThrowError(
      expect.objectContaining({ messageKey: 'sources.app.secretMissing' }),
    );
    expect(requests).toEqual([]);
  });
});
