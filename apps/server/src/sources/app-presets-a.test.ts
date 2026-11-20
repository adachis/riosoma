import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppConnection, SourceCreate, type SourceSelect } from '@riosoma/contracts';
import { APP_PRESETS, createAppConnector, type ConnectorContext, type SourceRow } from '@riosoma/connectors';
import { parse } from '../http/validate.js';
import { restConnectorOptions } from './rest.js';

const credential = randomBytes(24).toString('hex');
const publicKey = randomBytes(16).toString('hex');
const objects = {
  trello: ['boards'],
  intercom: ['contacts', 'companies', 'conversations', 'admins', 'teams', 'tags', 'articles'],
  shopify: ['products', 'custom_collections', 'smart_collections', 'customers', 'orders', 'draft_orders'],
};
type App = keyof typeof objects;
type Request = { path: string; query: URLSearchParams; signed: boolean; method: string; at: number };
const requests: Request[] = [];
let listener: Server;
let origin: string;
let empty = false;
let refused = false;
let denied = '';
let deniedProducts = false;
let unnamedPermission = false;
let retry = false;
let fullLastPage = false;

beforeAll(async () => {
  listener = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const trello = url.pathname.startsWith('/1/');
    const shopify = url.pathname.startsWith('/admin/');
    const name = trello ? 'boards' : url.pathname.split('/').at(-1)!.replace('.json', '');
    const signed = trello
      ? url.searchParams.get('key') === publicKey && url.searchParams.get('token') === credential
      : shopify
        ? req.headers['x-shopify-access-token'] === credential
        : req.headers.authorization === `Bearer ${credential}`;
    const query = new URLSearchParams(url.searchParams);
    query.delete('token');
    query.delete('key');
    requests.push({ path: url.pathname, query, signed, method: req.method ?? '', at: Date.now() });
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (refused || !signed) return json(401, { message: 'Access refused' });
    if (req.method !== 'GET') return json(405, {});
    if (retry) {
      retry = false;
      return json(429, {}, { 'retry-after': '1' });
    }
    const productObject = ['products', 'custom_collections', 'smart_collections'].includes(name);
    if (name === denied || (deniedProducts && productObject)) {
      if (shopify)
        return json(403, {
          errors: `[API] This action requires merchant approval for read_${productObject ? 'products' : name} scope.`,
        });
      if (trello) return json(403, { message: 'Access denied' });
      return json(403, {
        type: 'error.list',
        errors: [
          { code: 'forbidden', message: unnamedPermission ? 'Access denied' : `Requires read_${name}` },
        ],
      });
    }
    if (trello) {
      if (url.pathname !== '/1/members/me/boards' || url.searchParams.get('filter') !== 'open')
        return json(404, {});
      return json(200, empty ? [] : [{ id: 'board-one', name: 'Example board' }]);
    }
    if (shopify) {
      if (url.pathname === '/admin/api/2026-10/shop.json')
        return json(200, { shop: { id: 1, name: 'Example store' } });
      if (!objects.shopify.includes(name) || !url.pathname.startsWith('/admin/api/2026-10/'))
        return json(404, {});
      if (url.searchParams.get('limit') !== '250') return json(400, {});
      const page = Number(url.searchParams.get('page_info') ?? 1);
      if (name === 'orders' && page === 1 && url.searchParams.get('status') !== 'any') return json(400, {});
      const rows = empty
        ? []
        : [
            {
              id: page,
              title: `Example ${page}`,
              ...(name === 'products'
                ? {
                    variants: [{ id: 10 + page, title: 'Standard' }],
                    options: [{ id: 20 + page, name: 'Size', values: ['Medium'] }],
                    images: [{ id: 30 + page, src: 'https://images.example.test/item.png' }],
                  }
                : {}),
            },
          ];
      // Follow-up links carry only the cursor and limit, as Shopify requires.
      const next = `${origin}${url.pathname}?page_info=${page + 1}&limit=250`;
      return json(
        200,
        { [name]: rows },
        empty || page === 3
          ? {}
          : {
              link: `<${origin}${url.pathname}>; rel="previous", <${next}>; rel="next"`,
            },
      );
    }
    if (url.pathname === '/me') return json(200, { type: 'admin', id: 'example-admin' });
    if (!objects.intercom.includes(name)) return json(404, {});
    const onePage = ['admins', 'teams', 'tags'].includes(name);
    const numbered = ['companies', 'articles'].includes(name);
    const size = name === 'companies' ? 60 : name === 'articles' ? 50 : 150;
    if (!onePage && url.searchParams.get('per_page') !== String(size)) return json(400, {});
    const page = Number(url.searchParams.get(numbered ? 'page' : 'starting_after') ?? 1);
    const count = empty || page > 3 ? 0 : numbered && (page < 3 || fullLastPage) ? size : 1;
    const rows = Array.from({ length: count }, (_, i) => ({
      id: String((page - 1) * size + i + 1),
      name: `Example ${page}-${i}`,
      ...(name === 'contacts' ? { custom_attributes: { plan: 'Standard', seats: 7, active: true } } : {}),
    }));
    const member = ['conversations', 'admins', 'teams'].includes(name) ? name : 'data';
    return json(200, {
      [member]: rows,
      ...(onePage
        ? {}
        : {
            pages: {
              page,
              total_pages: empty ? 0 : 3,
              next:
                empty || page >= 3
                  ? null
                  : name === 'companies'
                    ? `${origin}/companies?per_page=${size}&page=${page + 1}`
                    : numbered
                      ? null
                      : { starting_after: String(page + 1) },
            },
          }),
    });
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  origin = `http://localhost:${(listener.address() as AddressInfo).port}`;
});

beforeEach(() => {
  requests.length = 0;
  empty = false;
  refused = false;
  denied = '';
  deniedProducts = false;
  unnamedPermission = false;
  retry = false;
  fullLastPage = false;
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
    // Only the destination changes, keeping the preset's auth, settings, and request pace.
    APP_PRESETS.filter((preset) => preset.catalog.id in objects).map((preset) => ({
      ...preset,
      target: { ...preset.target, address: origin + (preset.catalog.id === 'trello' ? '/1' : '') },
    })),
  );
}

function context(app: App, settings?: Record<string, unknown>): ConnectorContext {
  return {
    connection: AppConnection.parse({
      kind: 'app',
      app,
      settings:
        settings ??
        (app === 'trello' ? { key: publicKey } : app === 'shopify' ? { store: 'sample-store' } : {}),
    }),
    secrets: app === 'intercom' ? { token: credential } : { apiKey: credential },
    timeoutMs: 30_000,
  };
}
const select = (name: string): SourceSelect => ({ kind: 'object', object: { schema: null, name } });
async function read(app: App, name: string, columns = ['id']) {
  const rows: SourceRow[] = [];
  for await (const batch of connector().read(context(app), select(name), {
    columns,
    types: Object.fromEntries(columns.map((column) => [column, 'text'])),
    keyColumns: ['id'],
    batchSize: 100,
  }))
    rows.push(...batch);
  return rows;
}

describe.each(['trello', 'intercom', 'shopify'] as const)('%s preset through the server network', (app) => {
  it(
    'tests, lists all objects, and stops each read and preview on its final page',
    { timeout: 60_000 },
    async () => {
      const source = connector();
      expect((await source.test(context(app))).ok).toBe(true);
      expect((await source.listObjects(context(app))).map((object) => object.name)).toEqual(objects[app]);
      for (const name of objects[app]) {
        const onePage = app === 'trello' || ['admins', 'teams', 'tags'].includes(name);
        requests.length = 0;
        const rows = await read(app, name);
        expect(rows).toHaveLength(onePage ? 1 : name === 'companies' ? 121 : name === 'articles' ? 101 : 3);
        expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
        expect(rows.every((row) => typeof row.key === 'string' && row.values.id !== null)).toBe(true);
        expect(requests).toHaveLength(onePage ? 1 : 3);
        if (!onePage) {
          const param =
            app === 'shopify'
              ? 'page_info'
              : ['companies', 'articles'].includes(name)
                ? 'page'
                : 'starting_after';
          expect(requests.map((request) => request.query.get(param))).toEqual(
            name === 'articles' ? ['1', '2', '3'] : [null, '2', '3'],
          );
        }
        expect(requests.every((request) => request.method === 'GET' && request.signed)).toBe(true);
        const preview = await source.preview(context(app), select(name), 200);
        expect(preview.rows).toHaveLength(rows.length);
        expect(preview.rows.every((row) => row.length === preview.columns.length)).toBe(true);
        expect(await source.keyCandidates(context(app), { schema: null, name })).toEqual([['id']]);
      }
    },
  );

  it('accepts empty objects and returns zero rows without errors', { timeout: 30_000 }, async () => {
    empty = true;
    const source = connector();
    expect((await source.test(context(app))).ok).toBe(true);
    expect((await source.listObjects(context(app))).map((object) => object.name)).toEqual(objects[app]);
    for (const name of objects[app]) {
      requests.length = 0;
      expect(await read(app, name)).toEqual([]);
      expect(requests).toHaveLength(1);
      expect((await source.preview(context(app), select(name), 3)).rows).toEqual([]);
    }
  });

  it('names the refused credential and its creation page without external response text', async () => {
    refused = true;
    const preset = APP_PRESETS.find((preset) => preset.catalog.id === app)!;
    const result = await connector().test(context(app));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.messageKey).toBe(`sources.app.${app}.deniedToken`);
    expect(JSON.stringify(result).includes(credential)).toBe(false);
    const failure: unknown = await read(app, objects[app][0]!).catch((error: unknown) => error);
    if (!preset.catalog.secret) throw new Error('Expected a keyed app');
    expect(failure).toMatchObject({ messageKey: preset.catalog.secret.deniedMessageId });
    expect(JSON.stringify(failure).includes(credential)).toBe(false);
    expect(preset.catalog.keyUrl).toBe(
      {
        trello: 'https://trello.com/power-ups/admin',
        intercom: 'https://app.intercom.com/a/apps/_/developer-hub',
        shopify: 'https://help.shopify.com/en/manual/apps/app-types/custom-apps',
      }[app],
    );
  });

  it(
    'leaves inaccessible objects out and names only permissions supplied by the app',
    { timeout: 15_000 },
    async () => {
      denied = app === 'trello' ? 'boards' : app === 'intercom' ? 'articles' : 'customers';
      const source = connector();
      expect((await source.listObjects(context(app))).map((object) => object.name)).toEqual(
        objects[app].filter((name) => name !== denied),
      );
      const failure: unknown = await read(app, denied).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        messageKey: 'sources.app.objectNotAllowed',
        params: {
          object: denied,
          permission: app === 'trello' ? '' : `read_${denied}`,
          hasPermission: app !== 'trello',
        },
      });
      const result = await source.test(context(app));
      expect(result.ok).toBe(app !== 'trello');
      if (app !== 'trello')
        expect(result.steps).toContainEqual(
          expect.objectContaining({
            status: 'skipped',
            messageKey: 'sources.app.objectNotAllowed',
            params: { object: denied, permission: `read_${denied}`, hasPermission: true },
          }),
        );
    },
  );
});

it.each(['intercom', 'shopify'] as const)(
  'accepts a valid %s key when the former credential test object is inaccessible',
  { timeout: 15_000 },
  async (app) => {
    denied = app === 'intercom' ? 'admins' : 'products';
    deniedProducts = app === 'shopify';
    const deniedObjects =
      app === 'intercom' ? ['admins'] : ['products', 'custom_collections', 'smart_collections'];
    const permission = app === 'intercom' ? 'read_admins' : 'read_products';
    const source = connector();
    const result = await source.test(context(app));
    expect(result.ok).toBe(true);
    expect(requests[0]?.path).toBe(app === 'intercom' ? '/me' : '/admin/api/2026-10/shop.json');
    for (const name of deniedObjects)
      expect(result.steps).toContainEqual(
        expect.objectContaining({
          status: 'skipped',
          messageKey: 'sources.app.objectNotAllowed',
          params: { object: name, permission, hasPermission: true },
        }),
      );
    expect((await source.listObjects(context(app))).map((object) => object.name)).toEqual(
      objects[app].filter((name) => !deniedObjects.includes(name)),
    );
    await expect(read(app, denied)).rejects.toMatchObject({
      messageKey: 'sources.app.objectNotAllowed',
      params: { object: denied, permission, hasPermission: true },
    });
    expect(await read(app, app === 'intercom' ? 'contacts' : 'customers')).toHaveLength(3);
    expect(requests.every((request) => request.method === 'GET' && request.signed)).toBe(true);
  },
);

it.each(['companies', 'articles'])(
  'reads three full Intercom %s pages without losing the final page',
  async (name) => {
    fullLastPage = true;
    const rows = await read('intercom', name);
    expect(rows).toHaveLength(name === 'companies' ? 180 : 150);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    expect(requests.map((request) => request.query.get('page'))).toEqual(
      name === 'companies' ? [null, '2', '3'] : ['1', '2', '3', '4'],
    );
    expect(requests.every((request) => request.method === 'GET' && request.signed)).toBe(true);
  },
);

it('keeps Intercom custom attributes as separate columns in previews and reads', async () => {
  const preview = await connector().preview(context('intercom'), select('contacts'), 3);
  const columns = ['id', 'custom_attributes.plan', 'custom_attributes.seats', 'custom_attributes.active'];
  expect(preview.columns.map((column) => column.name)).toEqual(expect.arrayContaining(columns));
  const rows = await read('intercom', 'contacts', columns);
  expect(rows.map((row) => row.values['custom_attributes.plan'])).toEqual([
    'Standard',
    'Standard',
    'Standard',
  ]);
  expect(rows.map((row) => row.values['custom_attributes.seats'])).toEqual(['7', '7', '7']);
});

it('keeps Shopify product lists in the shared API representation', async () => {
  const columns = ['id', 'variants', 'options', 'images'];
  const rows = await read('shopify', 'products', columns);
  for (const column of columns.slice(1)) {
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => Array.isArray(JSON.parse(String(row.values[column]))))).toBe(true);
  }
});

it('omits Intercom objects even when their refusal supplies no permission name', async () => {
  denied = 'articles';
  unnamedPermission = true;
  expect((await connector().listObjects(context('intercom'))).map((object) => object.name)).not.toContain(
    'articles',
  );
  await expect(read('intercom', denied)).rejects.toMatchObject({
    messageKey: 'sources.app.objectNotAllowed',
    params: { permission: '', hasPermission: false },
  });
});

it('paces Shopify calls at two per second and honors Retry-After', async () => {
  retry = true;
  expect(await read('shopify', 'products')).toHaveLength(3);
  expect(requests).toHaveLength(4);
  expect(requests[1]!.at - requests[0]!.at).toBeGreaterThanOrEqual(950);
  expect(requests[2]!.at - requests[1]!.at).toBeGreaterThanOrEqual(450);
  expect(requests[3]!.at - requests[2]!.at).toBeGreaterThanOrEqual(450);
});

const invalidSettings: Array<[App, Record<string, unknown>, string, string]> = [
  ...[
    undefined,
    '',
    1,
    'A'.repeat(32),
    'a'.repeat(31),
    'a'.repeat(33),
    'g'.repeat(32),
    `${'a'.repeat(31)}\n`,
  ].map((key): [App, Record<string, unknown>, string, string] => [
    'trello',
    { key },
    'key',
    key === undefined || key === '' ? 'keyRequired' : 'keyInvalid',
  ]),
  ...['other', 'US', 1, null, {}, ['eu']].map((region): [App, Record<string, unknown>, string, string] => [
    'intercom',
    { region },
    'region',
    'regionInvalid',
  ]),
  ...[
    ['', 'storeRequired'],
    [1, 'storeInvalid'],
    ['bad name', 'storeInvalid'],
    ['http://sample.myshopify.com', 'storeHttps'],
    ['https://myshopify.com', 'storeHost'],
    ['https://sample.myshopify.com.attacker.test', 'storeHost'],
    ['https://samplemyshopify.com', 'storeHost'],
    ['https://bad_name.myshopify.com', 'storeHost'],
    ['https://reader@sample.myshopify.com', 'storeCredentials'],
    ['https://sample.myshopify.com:443', 'storePort'],
    ['https://sample.myshopify.com:444', 'storePort'],
    ['https://sample.myshopify.com/admin', 'storePath'],
    ['https://sample.myshopify.com/.', 'storePath'],
    ['https://sample.myshopify.com?x=1', 'storeQuery'],
    ['https://sample.myshopify.com?', 'storeQuery'],
    ['https://sample.myshopify.com#part', 'storeFragment'],
    ['https://sample.myshopify.com#', 'storeFragment'],
    ['x'.repeat(2_001), 'storeInvalid'],
  ].map(([store, suffix]): [App, Record<string, unknown>, string, string] => [
    'shopify',
    { store },
    'store',
    String(suffix),
  ]),
  ['shopify', {}, 'store', 'storeRequired'],
];

it.each(invalidSettings)(
  'refuses %s setting rule %# before making a request',
  async (app, settings, field, suffix) => {
    const messageKey = `sources.app.${app}.${suffix}`;
    const ctx: ConnectorContext = { ...context(app), connection: { kind: 'app', app, settings } };
    await expect(connector().listObjects(ctx)).rejects.toMatchObject({ messageKey });
    expect((await connector().test(ctx)).steps.at(-1)?.messageKey).toBe(messageKey);
    expect(() =>
      parse(SourceCreate, { name: 'Example', connection: ctx.connection, secrets: {} }),
    ).toThrowError(
      expect.objectContaining({ messageKey, fields: { [`connection.settings.${field}`]: messageKey } }),
    );
    expect(requests).toEqual([]);
  },
);
