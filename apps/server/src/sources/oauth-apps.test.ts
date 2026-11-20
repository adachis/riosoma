import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, assert, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppConnection, type SourceSelect } from '@riosoma/contracts';
import { APP_PRESETS, createAppConnector, type ConnectorContext, type SourceRow } from '@riosoma/connectors';
import { restConnectorOptions } from './rest.js';

const apps = ['salesforce', 'zoom', 'zoho-crm'] as const;
type App = (typeof apps)[number];
const standard = [
  'Account',
  'Contact',
  'Lead',
  'Opportunity',
  'OpportunityLineItem',
  'Case',
  'Campaign',
  'CampaignMember',
  'Task',
  'Event',
  'User',
  'Product2',
  'Pricebook2',
  'PricebookEntry',
  'Contract',
  'Order',
  'Asset',
];
const clientId = `1000.${'a'.repeat(32)}`;
const settings = {
  salesforce: { instance: 'https://sample-dev-ed.develop.my.salesforce.com', clientId },
  zoom: { accountId: 'sample-account', clientId: 'zoom-client' },
  'zoho-crm': { region: 'com', clientId },
};
const expected = {
  salesforce: [...standard, 'Sample__c'],
  zoom: ['users', 'groups', '1', '2', '3', '4', '5', '6'],
  'zoho-crm': ['Leads', 'Contacts', 'Unsupported'],
};
const requests: Array<{ path: string; query: URLSearchParams; method: string; signed: boolean }> = [];
const plans = new Map<string, { object: string; fields: string[] }>();
let listener: Server;
let origin: string;
let secret: string;
let refreshToken: string;
let accessToken: string;
let empty = false;
let refused = false;
let missing = false;
let allMissing = false;
let wide = false;
let changed = false;
let badFields = false;
let elsewhere = false;
let metadataDenied = false;
let fieldsEmpty = false;
let probeDenied = false;
let discoveryDenied = false;
let slow = false;
let scopeDenials: 'metadata' | 'records' | false = false;
let invalidTokens = 0;

function fieldNames(app: App) {
  return [
    'Name',
    ...Array.from(
      { length: app === 'zoho-crm' ? 54 : wide ? 300 : 2 },
      (_, index) => `Field_${index}_${'x'.repeat(app === 'salesforce' && wide ? 65 : 2)}`,
    ),
  ];
}

beforeAll(async () => {
  listener = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const app = url.pathname.split('/')[1] as App;
    const path = url.pathname.slice(app.length + 1);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (path === '/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const signed =
        app === 'zoom'
          ? req.headers.authorization ===
              `Basic ${Buffer.from(`${settings.zoom.clientId}:${secret}`).toString('base64')}` &&
            form.get('account_id') === settings.zoom.accountId
          : form.get('client_id') === clientId && form.get('client_secret') === secret;
      const grant =
        app === 'salesforce'
          ? 'client_credentials'
          : app === 'zoom'
            ? 'account_credentials'
            : 'refresh_token';
      requests.push({
        path: url.pathname,
        query: url.searchParams,
        method: req.method ?? '',
        signed:
          signed &&
          form.get('grant_type') === grant &&
          (app !== 'zoho-crm' || form.get('refresh_token') === refreshToken),
      });
      if (refused || !signed)
        return json(400, { error: 'invalid_client', message: 'external-response-marker' });
      return json(200, {
        access_token: accessToken,
        expires_in: 3_600,
        instance_url: settings.salesforce.instance,
      });
    }
    const signed = req.headers.authorization === `Bearer ${accessToken}`;
    requests.push({ path: url.pathname, query: url.searchParams, method: req.method ?? '', signed });
    if (!signed) return json(401, {});
    if (invalidTokens > 0) {
      invalidTokens--;
      return json(401, { code: 'INVALID_TOKEN' });
    }
    if (req.method !== 'GET') return json(405, {});
    if (slow) await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const denied = (permission: string) =>
      json(
        app === 'zoho-crm' ? 401 : 400,
        app === 'salesforce'
          ? [{ errorCode: 'INVALID_TYPE', message: 'external-response-marker' }]
          : app === 'zoom'
            ? { code: 4711, message: `Invalid access token, does not contain scopes:[${permission}].` }
            : { code: 'OAUTH_SCOPE_MISMATCH', message: 'external-response-marker' },
      );
    if (app === 'salesforce') {
      if (path === '/services/data/v68.0/sobjects')
        return json(200, {
          sobjects: [
            ...standard.map((name) => ({
              name,
              labelPlural: `${name} labels`,
              custom: false,
              queryable: true,
            })),
            { name: 'Sample__c', labelPlural: 'Samples', custom: true, queryable: true },
            { name: 'Noise', labelPlural: 'Noise', custom: false, queryable: true },
            { name: 'Unqueryable__c', labelPlural: 'Hidden', custom: true, queryable: false },
          ],
        });
      const describeObject = /^\/services\/data\/v68\.0\/sobjects\/([^/]+)\/describe$/.exec(path);
      if (describeObject)
        return missing && describeObject[1] === 'Contact'
          ? denied('')
          : json(200, {
              fields: badFields
                ? [{ name: 'Name FROM Secret' }]
                : [{ name: 'Id' }, ...fieldNames(app).map((name) => ({ name }))],
            });
      let object: string;
      let fields: string[];
      let page = 1;
      let plan: string;
      if (path === '/services/data/v68.0/query') {
        const query = /^SELECT ([A-Za-z0-9_,]+) FROM ([A-Za-z0-9_]+) ORDER BY Id$/.exec(
          url.searchParams.get('q') ?? '',
        );
        if (!query || req.url!.length >= 16_000) return json(400, {});
        fields = query[1]!.split(',');
        object = query[2]!;
        plan = `${object}/${fields[1] ?? 'Id'}`;
        plans.set(plan, { object, fields });
      } else {
        const match = /^\/services\/data\/v68\.0\/query\/([^/]+)\/([^/]+)\/(\d+)$/.exec(path);
        if (!match) return json(404, {});
        plan = `${match[1]}/${match[2]}`;
        ({ object, fields } = plans.get(plan)!);
        page = Number(match[3]);
      }
      const primary = fields.includes('Name');
      const ids = empty
        ? []
        : ((primary
            ? [
                [1, 2],
                [3, 4],
                [5, 6],
              ]
            : [[1], [2, 3, 4], [5, 6]])[page - 1] ?? []);
      const records: Array<Record<string, unknown>> = ids.map((id) => ({
        ...Object.fromEntries(fields.map((field) => [field, field === 'Id' ? String(id) : `${field} ${id}`])),
        attributes: { type: object },
      }));
      if (changed && !primary && records[0]) records[0].Id = 'missing';
      return json(200, {
        records,
        done: empty || page === 3,
        nextRecordsUrl: elsewhere
          ? 'https://elsewhere.example.test/query'
          : `/salesforce/services/data/v68.0/query/${plan}/${page === 3 ? 999 : page + 1}`,
      });
    }
    if (app === 'zoom') {
      if (path === '/v2/users/me')
        return probeDenied ? denied('user:read:user:admin') : json(200, { id: 'me' });
      const meetings = /^\/v2\/users\/([^/]+)\/meetings$/.test(path);
      if ((allMissing || missing) && path === '/v2/groups') return denied('group:read:list_groups:admin');
      if (allMissing && path === '/v2/users') return denied('user:read:list_users:admin');
      if (missing && meetings) return denied('meeting:read:list_meetings:admin, meeting:read:meeting:admin');
      const name = meetings ? 'meetings' : path.slice('/v2/'.length);
      const page = Number(url.searchParams.get('next_page_token') ?? 1);
      return json(200, {
        [name]: empty
          ? []
          : [1, 2].map((offset) => ({
              id: String((page - 1) * 2 + offset),
              first_name: 'Sample',
              last_name: String((page - 1) * 2 + offset),
            })),
        next_page_token: empty || page === 3 ? '' : String(page + 1),
      });
    }
    if (app === 'zoho-crm') {
      if (path === '/crm/v8/org') return probeDenied ? denied('') : json(200, { org: [{ id: 'org' }] });
      if (path === '/crm/v8/settings/modules' && discoveryDenied) return denied('');
      if (path === '/crm/v8/settings/modules')
        return json(200, {
          modules: [
            ...(scopeDenials
              ? ['Leads', ...Array.from({ length: 12 }, (_, index) => `Denied_${index}`)]
              : expected[app]
            ).map((api_name) => ({
              api_name,
              plural_label: `${api_name} labels`,
              api_supported: true,
            })),
            { api_name: 'Hidden', plural_label: 'Hidden', api_supported: false },
          ],
        });
      if (path === '/crm/v8/settings/fields') {
        if (fieldsEmpty && url.searchParams.get('module') === 'Contacts') {
          res.writeHead(204);
          return res.end();
        }
        if (
          (metadataDenied && url.searchParams.get('module') === 'Contacts') ||
          (scopeDenials === 'metadata' && url.searchParams.get('module')?.startsWith('Denied_'))
        )
          return denied('');
        return json(200, {
          fields: [{ api_name: 'id' }, ...fieldNames(app).map((api_name) => ({ api_name }))],
        });
      }
      const object = path.slice('/crm/v8/'.length);
      if (object === 'Unsupported')
        return json(400, { code: 'NOT_SUPPORTED', message: 'external-response-marker' });
      if ((missing && object === 'Contacts') || (scopeDenials === 'records' && object.startsWith('Denied_')))
        return denied('');
      const fields = url.searchParams.get('fields')?.split(',');
      if (!fields || fields.length > 50 || url.searchParams.get('per_page') !== '200')
        return json(400, { code: 'REQUIRED_PARAM_MISSING' });
      if (empty) {
        res.writeHead(204);
        return res.end();
      }
      const primary = fields.includes('Name');
      const token = url.searchParams.get('page_token');
      const page = token ? Number(token.split('-')[1]) : 1;
      if (token && !token.startsWith(primary ? 'primary-' : 'extra-')) return json(400, {});
      const ids =
        (primary
          ? [
              [1, 2],
              [3, 4],
              [5, 6],
            ]
          : [[1], [2, 3, 4], [5, 6]])[page - 1] ?? [];
      return json(200, {
        data: ids.map((id) =>
          Object.fromEntries(fields.map((field) => [field, field === 'id' ? String(id) : `${field} ${id}`])),
        ),
        info: {
          more_records: page !== 3,
          next_page_token: `${primary ? 'primary' : 'extra'}-${page === 3 ? 999 : page + 1}`,
        },
      });
    }
    return json(404, {});
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  origin = `http://localhost:${(listener.address() as AddressInfo).port}`;
});

beforeEach(() => {
  requests.length = 0;
  plans.clear();
  scopeDenials = false;
  invalidTokens = 0;
  secret = randomBytes(24).toString('hex');
  refreshToken = randomBytes(24).toString('hex');
  accessToken = randomBytes(24).toString('hex');
  empty =
    refused =
    missing =
    allMissing =
    wide =
    changed =
    badFields =
    elsewhere =
    metadataDenied =
    fieldsEmpty =
    probeDenied =
    discoveryDenied =
    slow =
      false;
});
afterAll(async () => {
  listener.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
});

function connector(app: App, accelerated = true) {
  const preset = APP_PRESETS.find((entry) => entry.catalog.id === app)!;
  if (preset.target.auth.method !== 'oauth-client') throw new Error('Expected OAuth');
  return createAppConnector(
    {
      ...restConnectorOptions({ production: false, automationsAllowPrivateHosts: true }, async () => [
        { address: '127.0.0.1', family: 4 },
      ]),
    },
    [
      {
        ...preset,
        target: {
          ...preset.target,
          address: `${origin}/${app}`,
          // Accelerate this local fixture, with production pacing checked separately below.
          requestsPerSecond: accelerated ? 100 : preset.target.requestsPerSecond,
          auth: { ...preset.target.auth, tokenUrl: `${origin}/${app}/token` },
        },
      },
    ],
  );
}
const context = (app: App): ConnectorContext => ({
  connection: AppConnection.parse({ kind: 'app', app, settings: settings[app] }),
  secrets: { clientSecret: secret, refreshToken },
  timeoutMs: 30_000,
});
const select = (name: string): SourceSelect => ({ kind: 'object', object: { schema: null, name } });
async function read(app: App, name: string, columns = [app === 'salesforce' ? 'Id' : 'id', 'Name']) {
  const rows: SourceRow[] = [];
  for await (const batch of connector(app).read(context(app), select(name), {
    columns,
    types: Object.fromEntries(columns.map((column) => [column, 'text'])),
    keyColumns: [app === 'salesforce' ? 'Id' : 'id'],
    batchSize: 2,
  }))
    rows.push(...batch);
  return rows;
}

describe.each(apps)('%s OAuth app through the server network', (app) => {
  it('tests, lists every supported object, previews, and reads three pages to completion', async () => {
    const source = connector(app);
    expect((await source.test(context(app))).ok).toBe(true);
    const objects = await source.listObjects(context(app));
    expect(objects.map((object) => object.name)).toEqual(
      expected[app].filter((name) => name !== 'Unsupported'),
    );
    for (const object of objects) {
      requests.length = 0;
      const key = app === 'salesforce' ? 'Id' : 'id';
      const rows = await read(app, object.name, [
        key,
        ...(app === 'zoom' ? [] : ['Name', fieldNames(app).at(-1)!]),
      ]);
      expect(rows).toHaveLength(6);
      expect(new Set(rows.map((row) => row.key)).size).toBe(6);
      expect(rows.every((row) => typeof row.key === 'string')).toBe(true);
      if (app !== 'zoom')
        expect(rows.map((row) => row.values[fieldNames(app).at(-1)!])).toEqual(
          Array.from({ length: 6 }, (_, index) => `${fieldNames(app).at(-1)!} ${index + 1}`),
        );
      const dataRequests = requests.filter(
        (request) =>
          !/token|sobjects$|describe|settings|\/users$/.test(request.path) ||
          (app === 'zoom' && object.name === 'users' && request.path.endsWith('/users')),
      );
      expect(
        dataRequests.some((request) => [...request.query.values()].some((value) => value.includes('999'))),
      ).toBe(false);
      if (app === 'salesforce' || app === 'zoom') expect(dataRequests).toHaveLength(3);
      if (app === 'zoho-crm') expect(dataRequests).toHaveLength(6);
      const preview = await source.preview(context(app), select(object.name), 10);
      expect(preview.rows).toHaveLength(6);
      expect(preview.rows.every((row) => row.length === preview.columns.length)).toBe(true);
      expect(preview.columns.some((column) => column.name.startsWith('attributes'))).toBe(false);
    }
    expect(requests.every((request) => request.signed)).toBe(true);
    expect(
      requests.every((request) => request.method === (request.path.endsWith('/token') ? 'POST' : 'GET')),
    ).toBe(true);
  });

  it('accepts empty objects and reads zero rows without an error', async () => {
    empty = true;
    const source = connector(app);
    expect((await source.test(context(app))).ok).toBe(true);
    for (const object of await source.listObjects(context(app))) {
      expect((await source.preview(context(app), select(object.name), 3)).rows).toEqual([]);
      expect(await read(app, object.name)).toEqual([]);
    }
  });

  it('names refused credentials and the app key page without external response text', async () => {
    refused = true;
    const source = connector(app);
    const result = await source.test(context(app));
    const preset = APP_PRESETS.find((entry) => entry.catalog.id === app)!;
    assert(preset.catalog.secret);
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({
      messageKey: preset.catalog.secret.deniedMessageId,
      params: { keyUrl: preset.catalog.keyUrl },
    });
    const serialized = JSON.stringify(result);
    expect(
      [secret, refreshToken, accessToken, 'external-response-marker'].some((value) =>
        serialized.includes(value),
      ),
    ).toBe(false);
  });

  it('omits unreadable objects and names the object and any missing permissions', async () => {
    missing = true;
    const source = connector(app);
    const result = await source.test(context(app));
    expect(result.ok).toBe(true);
    const skipped = result.steps.filter((step) => step.messageKey === 'sources.app.objectNotAllowed');
    const object = app === 'salesforce' ? 'Contact' : app === 'zoom' ? 'groups' : 'Contacts';
    expect(skipped).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({
          object,
          ...(app === 'salesforce'
            ? { hasPermission: false }
            : {
                permission: app === 'zoom' ? 'group:read:list_groups:admin' : 'ZohoCRM.modules.READ',
                hasPermission: true,
              }),
        }),
      }),
    );
    expect((await source.listObjects(context(app))).some((entry) => entry.name === object)).toBe(false);
    expect(JSON.stringify(result).includes('external-response-marker')).toBe(false);
    if (app === 'zoom')
      expect(
        skipped.some(
          (step) =>
            step.params?.permission === 'meeting:read:list_meetings:admin, meeting:read:meeting:admin',
        ),
      ).toBe(true);
  });
});

it('keeps the minimal Zoom key valid while reporting every unavailable scope', async () => {
  allMissing = true;
  const source = connector('zoom');
  const result = await source.test(context('zoom'));
  expect(result.ok).toBe(true);
  expect(await source.listObjects(context('zoom'))).toEqual([]);
  expect(
    result.steps
      .filter((step) => step.messageKey === 'sources.app.objectNotAllowed')
      .map((step) => step.params?.object)
      .sort(),
  ).toEqual(['groups', 'meetings', 'users']);
});

it('batches wide Salesforce queries below the address limit and joins independent cursors by Id', async () => {
  wide = true;
  const fields = fieldNames('salesforce');
  const rows = await read('salesforce', 'Account', ['Id', ...fields]);
  expect(rows).toHaveLength(6);
  expect(Object.values(rows[0]!.values).every((value) => value !== null)).toBe(true);
  expect(requests.filter((request) => request.query.has('q')).length).toBeGreaterThan(1);
  for (const request of requests) {
    expect(`${origin}${request.path}?${request.query}`.length).toBeLessThan(16_000);
    expect(request.query.get('q')?.includes('FIELDS(ALL)') ?? false).toBe(false);
  }
});

it('refuses changed field groups instead of returning incomplete records', async () => {
  wide = changed = true;
  await expect(read('salesforce', 'Account')).rejects.toMatchObject({
    messageKey: 'sources.app.batchChanged',
  });
});

it('refuses field names containing query syntax before requesting any records', async () => {
  badFields = true;
  await expect(read('salesforce', 'Account')).rejects.toMatchObject({ messageKey: 'sources.app.discovery' });
  expect(requests.some((request) => request.query.has('q'))).toBe(false);
});

it('keeps Salesforce next-page addresses on the configured host', async () => {
  elsewhere = true;
  await expect(read('salesforce', 'Account')).rejects.toMatchObject({
    messageKey: 'sources.app.nextElsewhere',
  });
});

it('names the Zoho settings scope when field metadata is refused', async () => {
  metadataDenied = true;
  const result = await connector('zoho-crm').test(context('zoho-crm'));
  expect(result.ok).toBe(true);
  expect(result.steps).toContainEqual(
    expect.objectContaining({
      messageKey: 'sources.app.objectNotAllowed',
      params: expect.objectContaining({ object: 'Contacts', permission: 'ZohoCRM.settings.READ' }),
    }),
  );
});

it('leaves out a Zoho module whose field list is empty and reads the rest', async () => {
  fieldsEmpty = true;
  const result = await connector('zoho-crm').test(context('zoho-crm'));
  expect(result.ok).toBe(true);
  expect(result.steps).toContainEqual(
    expect.objectContaining({
      messageKey: 'sources.app.objectNoFields',
      params: expect.objectContaining({ object: expect.stringContaining('Contacts') }),
    }),
  );
  const objects = await connector('zoho-crm').listObjects(context('zoho-crm'));
  expect(objects.length).toBeGreaterThan(0);
  expect(objects.some((object) => object.name.includes('Contacts'))).toBe(false);
});

const invalidSettings: Array<[App, Record<string, unknown>, string]> = [
  ['salesforce', { instance: '' }, 'instanceRequired'],
  ...[
    ['http://sample.my.salesforce.com', 'Https'],
    ['https://elsewhere.test', 'Host'],
    ['https://my.salesforce.com', 'Host'],
    ['https://name:pass@sample.my.salesforce.com', 'Credentials'],
    ['https://sample.my.salesforce.com:443', 'Port'],
    ['https://sample.my.salesforce.com/path', 'Path'],
    ['https://sample.my.salesforce.com?q=x', 'Query'],
    ['https://sample.my.salesforce.com#x', 'Fragment'],
    ['invalid address', 'Invalid'],
  ].map(
    ([instance, suffix]) =>
      ['salesforce', { instance }, `instance${suffix}`] as [App, Record<string, unknown>, string],
  ),
  ['salesforce', { clientId: '' }, 'clientIdRequired'],
  ['salesforce', { clientId: 'x'.repeat(513) }, 'clientIdInvalid'],
  ['salesforce', { clientId: 'bad/value' }, 'clientIdInvalid'],
  ['salesforce', { instance: 1 }, 'instanceInvalid'],
  ...(['accountId', 'clientId'] as const).flatMap(
    (key) =>
      [
        ['zoom', { [key]: '' }, `${key}Required`],
        ['zoom', { [key]: 'bad/value' }, `${key}Invalid`],
        ['zoom', { [key]: 'x'.repeat(257) }, `${key}Invalid`],
        ['zoom', { [key]: 1 }, `${key}Invalid`],
      ] as Array<[App, Record<string, unknown>, string]>,
  ),
  ['zoho-crm', { region: 'other' }, 'regionInvalid'],
  ['zoho-crm', { clientId: '' }, 'clientIdRequired'],
  ['zoho-crm', { clientId: '1000.short' }, 'clientIdInvalid'],
  ['zoho-crm', { clientId: `1000.${'a'.repeat(8)}` }, 'clientIdInvalid'],
  ['zoho-crm', { clientId: `1000.${'a'.repeat(30)}!` }, 'clientIdInvalid'],
  ['zoho-crm', { clientId: `1000.${'/'.repeat(32)}` }, 'clientIdInvalid'],
];
it.each(invalidSettings)('refuses %s setting rule %j with %s', async (app, invalid, suffix) => {
  const ctx = context(app);
  ctx.connection = {
    kind: 'app',
    app,
    settings: { ...settings[app], ...invalid },
  } as ConnectorContext['connection'];
  const result = await connector(app).test(ctx);
  expect(result.ok).toBe(false);
  expect(result.steps[0]?.messageKey).toBe(`sources.app.${app === 'zoho-crm' ? 'zoho' : app}.${suffix}`);
  expect(requests).toEqual([]);
});

it('keeps conservative production rates and paces Zoom requests at two per second', async () => {
  expect(
    apps.map((app) => APP_PRESETS.find((preset) => preset.catalog.id === app)!.target.requestsPerSecond),
  ).toEqual([2, 2, 0.5]);
  const start = Date.now();
  const preview = await connector('zoom', false).preview(context('zoom'), select('groups'), 10);
  expect(preview.rows).toHaveLength(6);
  expect(Date.now() - start).toBeGreaterThanOrEqual(900);
});

it.each(['zoom', 'zoho-crm'] as const)(
  'names the missing %s key probe scope after a successful token exchange',
  async (app) => {
    probeDenied = true;
    const result = await connector(app).test(context(app));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({
      messageKey: 'sources.app.objectNotAllowed',
      params: {
        permission: app === 'zoom' ? 'user:read:user:admin' : 'ZohoCRM.org.READ',
        hasPermission: true,
      },
    });
  },
);

it('names the Zoho settings scope when module discovery is refused', async () => {
  discoveryDenied = true;
  const source = connector('zoho-crm');
  const result = await source.test(context('zoho-crm'));
  expect(result.ok).toBe(false);
  expect(result.steps.at(-1)).toMatchObject({
    messageKey: 'sources.app.objectNotAllowed',
    params: { object: 'modules', permission: 'ZohoCRM.settings.READ', hasPermission: true },
  });
  await expect(source.listObjects(context('zoho-crm'))).rejects.toMatchObject({
    messageKey: 'sources.app.objectNotAllowed',
    params: { permission: 'ZohoCRM.settings.READ' },
  });
});

it('gives grouped previews a bounded operation deadline while keeping each request timeout', async () => {
  slow = true;
  const ctx = { ...context('zoho-crm'), timeoutMs: 200 };
  const preview = await connector('zoho-crm').preview(ctx, select('Leads'), 10);
  expect(preview.rows).toHaveLength(6);
});

it.each(['metadata', 'records'] as const)(
  'keeps valid Zoho tokens while skipping twelve modules denied at %s',
  async (phase) => {
    scopeDenials = phase;
    const source = connector('zoho-crm');
    const result = await source.test(context('zoho-crm'));
    expect(result.ok).toBe(true);
    const skipped = result.steps.filter((step) => step.messageKey === 'sources.app.objectNotAllowed');
    expect(skipped).toHaveLength(12);
    expect(skipped.map((step) => step.params)).toEqual(
      Array.from({ length: 12 }, (_, index) => ({
        object: `Denied_${index}`,
        permission: phase === 'metadata' ? 'ZohoCRM.settings.READ' : 'ZohoCRM.modules.READ',
        hasPermission: true,
      })),
    );
    expect((await source.listObjects(context('zoho-crm'))).map((object) => object.name)).toEqual(['Leads']);
    expect(requests.filter((request) => request.path.endsWith('/token'))).toHaveLength(1);
  },
);

it.each([1, 2])('renews a Zoho invalid token once when %i requests refuse it', async (refusals) => {
  invalidTokens = refusals;
  const result = await connector('zoho-crm').test(context('zoho-crm'));
  expect(result.ok).toBe(refusals === 1);
  expect(requests.filter((request) => request.path.endsWith('/token'))).toHaveLength(2);
  if (refusals === 2)
    expect(result.steps.at(-1)).toMatchObject({
      messageKey: 'sources.app.zoho.deniedKey',
      params: { keyUrl: 'https://api-console.zoho.com/' },
    });
});
