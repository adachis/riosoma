import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RestEndpoint, type SourceSelect } from '@riosoma/contracts';
import {
  APP_PRESETS,
  createAppConnector,
  type AppPreset,
  type ConnectorContext,
  type SourceRow,
} from '@riosoma/connectors';
import { restConnectorOptions } from './rest.js';

const token = randomBytes(24).toString('hex');
let listener: Server;
let origin: string;
let empty = false;
let emptyRows = false;
let denied = '';
let refused = false;
let definitionCurrency = false;
const requests: Array<{ path: string; query: URLSearchParams; method: string; signed: boolean }> = [];
const select = (name: string): SourceSelect => ({ kind: 'object', object: { schema: null, name } });

const answerTypes = [
  'text',
  'email',
  'url',
  'file_url',
  'phone_number',
  'number',
  'boolean',
  'date',
  'choice',
  'choices',
  'payment',
];
function definition() {
  const fields = answerTypes.map((type, index) => ({
    id: `q${String(index).padStart(2, '0')}`,
    title: index < 2 ? 'Contact' : type,
    ref: type,
    ...(type === 'payment' ? { properties: { currency: 'USD' } } : {}),
  }));
  return {
    fields: [
      fields[0],
      {
        id: 'group',
        title: 'Group',
        properties: { fields: [fields[1], { id: 'nested', properties: { fields: fields.slice(2) } }] },
      },
      { id: 'q11', title: ' ', ref: 'fallback' },
      { id: 'q12', title: 'response_id' },
      { id: 'q13', title: '__proto__' },
    ],
  };
}
function response(index: number) {
  const values = [
    'Example',
    'person@example.test',
    'https://example.test',
    'https://example.test/file',
    '+12125550100',
    0,
    false,
    '2026-10-01',
    { other: 'Other answer' },
    { labels: ['Red', 'Blue'] },
    definitionCurrency ? { amount: 12 } : { amount: 12, currency: 'USD' },
  ];
  return {
    response_id: `r${index}`,
    token: `cursor${index}`,
    landed_at: '2026-10-01T12:00:00Z',
    submitted_at: '2026-10-01T12:01:00Z',
    hidden: { campaign: 'example', zero: 0 },
    variables: [
      { key: 'total', type: 'number', number: 0 },
      { key: 'label', type: 'text', text: 'Example variable' },
    ],
    calculated: { score: 0 },
    answers: [
      ...answerTypes.map((type, i) => ({
        field: { id: `q${String(i).padStart(2, '0')}` },
        type,
        [type]: values[i],
      })),
      { field: { id: 'q11' }, type: 'text', text: 'Fallback value' },
      { field: { id: 'q12' }, type: 'text', text: 'Question identifier' },
      { field: { id: 'q13' }, type: 'text', text: 'Safe label' },
    ].filter((answer) => index !== 4 || answer.field.id !== 'q00'),
  };
}
function codaRow(index: number) {
  return {
    id: `r${index}`,
    name: `Row ${index}`,
    index,
    createdAt: '2026-10-01T12:00:00Z',
    updatedAt: '2026-10-02T12:00:00Z',
    browserLink: 'https://coda.io/d/example',
    values: {
      Name: 'Example',
      Count: 0,
      Enabled: false,
      'Street.name': '10 Example St',
      id: 'Column identifier',
      ['__proto__']: 'Safe label',
    },
  };
}

beforeAll(async () => {
  listener = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const signed = req.headers.authorization === `Bearer ${token}`;
    requests.push({ path: url.pathname, query: url.searchParams, method: req.method ?? '', signed });
    res.setHeader('content-type', 'application/json');
    const send = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    if (!signed || refused) return send({ message: 'Invalid credential' }, 401);
    if (denied && url.pathname.endsWith(denied)) return send({ message: 'Permission required' }, 403);
    const isCoda = url.pathname.startsWith('/coda/');
    const isColumns = url.pathname.endsWith('/columns');
    const isRows = url.pathname.endsWith('/rows');
    const isResponses = url.pathname.endsWith('/responses');
    if (!isCoda && /^\/typeform\/forms\/[^/]+$/.test(url.pathname)) return send(definition());
    const start = Number(
      isCoda
        ? (url.searchParams.get('pageToken') ?? 0)
        : isResponses
          ? (url.searchParams.get('before') ?? 'cursor-1').slice(6)
          : (Number(url.searchParams.get('page') ?? 1) - 1) * 2,
    );
    const offset = isResponses ? start + 1 : start;
    const columns = ['Name', 'Count', 'Enabled', 'Street.name', 'id', '__proto__'].map((name, i) => ({
      id: `c${i}`,
      name,
    }));
    const total =
      empty || ((isRows || isResponses) && emptyRows)
        ? 0
        : isColumns
          ? columns.length
          : url.pathname.includes('/tables') && !url.pathname.includes('/docs/d0/')
            ? 0
            : 5;
    const items = Array.from({ length: Math.max(0, Math.min(2, total - offset)) }, (_, i) => {
      const index = offset + i;
      if (isColumns) return columns[index];
      if (isRows) return codaRow(index);
      if (isResponses) return response(index);
      if (url.pathname.endsWith('/tables')) return { id: `t${index}`, name: `Table ${index}` };
      if (url.pathname.endsWith('/docs')) return { id: `d${index}`, name: `Doc ${index}` };
      return { id: `f${index}`, title: `Form ${index}`, name: `Workspace ${index}` };
    });
    send({
      items,
      ...(isCoda
        ? offset + items.length < total
          ? { nextPageToken: String(offset + items.length) }
          : {}
        : { page_count: Math.ceil(total / 2), total_items: total }),
    });
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  origin = `http://localhost:${(listener.address() as AddressInfo).port}`;
});
beforeEach(() => {
  requests.length = 0;
  empty = false;
  emptyRows = false;
  denied = '';
  refused = false;
  definitionCurrency = false;
});
afterAll(async () => {
  listener.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
});

function connector(app: string) {
  const preset = APP_PRESETS.find((entry) => entry.catalog.id === app)!;
  const small = (endpoint: RestEndpoint) =>
    RestEndpoint.parse({
      ...endpoint,
      paging:
        endpoint.paging.style === 'page' || endpoint.paging.style === 'last-record'
          ? { ...endpoint.paging, size: 2 }
          : endpoint.paging,
    });
  const discoveries = (
    entries: NonNullable<AppPreset['discoveries']>,
  ): NonNullable<AppPreset['discoveries']> =>
    entries.map((entry) => ({
      ...entry,
      endpoint: small(entry.endpoint),
      ...(entry.object ? { object: { ...entry.object, endpoint: small(entry.object.endpoint) } } : {}),
      ...(entry.discoveries ? { discoveries: discoveries(entry.discoveries) } : {}),
    }));
  return createAppConnector(
    restConnectorOptions({ production: false, automationsAllowPrivateHosts: true }, async () => [
      { address: '127.0.0.1', family: 4 },
    ]),
    [
      {
        ...preset,
        target: { ...preset.target, address: `${origin}/${app}`, requestsPerSecond: 100 },
        objects: preset.objects.map((object) =>
          'endpoint' in object ? { ...object, endpoint: small(object.endpoint) } : object,
        ),
        test:
          'endpoint' in preset.test ? { ...preset.test, endpoint: small(preset.test.endpoint) } : preset.test,
        discoveries: discoveries(preset.discoveries ?? []),
      },
    ],
  );
}
const context = (app: string): ConnectorContext => ({
  connection: { kind: 'app', app, settings: {} },
  secrets: { token },
  timeoutMs: 30_000,
});
const keyFor = (app: string, name: string) =>
  app === 'typeform' && name !== 'forms' && name !== 'workspaces' ? 'response_id' : 'id';

it('accepts a Typeform token with readable Workspaces when Forms permission is missing', async () => {
  denied = '/forms';
  const tested = await connector('typeform').test(context('typeform'));
  expect(tested.ok).toBe(true);
  expect(tested.steps).toContainEqual(
    expect.objectContaining({
      status: 'skipped',
      messageKey: 'sources.app.objectNotAllowed',
      params: { object: 'forms', permission: 'forms:read', hasPermission: true },
    }),
  );
  expect(tested.steps.every((step) => step.status !== 'failed')).toBe(true);
  expect((await connector('typeform').listObjects(context('typeform'))).map((object) => object.name)).toEqual(
    ['workspaces'],
  );
  expect(await read('typeform', 'workspaces')).toHaveLength(5);
  expect(requests.some((request) => request.path.endsWith('/workspaces'))).toBe(true);
  expect(JSON.stringify(tested)).not.toContain(token);
});

async function read(app: string, name: string, columns = [keyFor(app, name)]) {
  const rows: SourceRow[] = [];
  for await (const batch of connector(app).read(context(app), select(name), {
    columns,
    types: Object.fromEntries(columns.map((column) => [column, 'text'])),
    keyColumns: [keyFor(app, name)],
    batchSize: 2,
  }))
    rows.push(...batch);
  return rows;
}

for (const app of ['coda', 'typeform'])
  describe(`${app} on the server’s guarded network`, () => {
    it(
      'lists every object and reads each across three pages, stopping at the final page',
      { timeout: 30_000 },
      async () => {
        expect((await connector(app).test(context(app))).ok).toBe(true);
        const objects = await connector(app).listObjects(context(app));
        expect(objects.map((object) => object.name)).toEqual(
          app === 'coda'
            ? ['docs', ...Array.from({ length: 5 }, (_, i) => `d0/t${i}`)]
            : ['forms', 'workspaces', ...Array.from({ length: 5 }, (_, i) => `f${i}`)],
        );
        expect(objects.at(-1)?.label).toBe(app === 'coda' ? 'Doc 0: Table 4' : 'Form 4');
        for (const object of objects) {
          requests.length = 0;
          const rows = await read(app, object.name);
          expect(rows).toHaveLength(5);
          expect(new Set(rows.map((row) => row.key)).size).toBe(5);
          const path =
            app === 'coda'
              ? object.name === 'docs'
                ? '/coda/docs'
                : `/coda/docs/d0/tables/${object.name.split('/')[1]}/rows`
              : object.name === 'forms' || object.name === 'workspaces'
                ? `/typeform/${object.name}`
                : `/typeform/forms/${object.name}/responses`;
          const pages = requests.filter((request) => request.path === path);
          // Form and doc discovery may read the same path before the selected object's own read.
          expect(
            pages
              .slice(-3)
              .map((request) =>
                request.query.get(
                  app === 'coda' ? 'pageToken' : path.endsWith('/responses') ? 'before' : 'page',
                ),
              ),
          ).toEqual(
            app === 'coda'
              ? [null, '2', '4']
              : path.endsWith('/responses')
                ? [null, 'cursor1', 'cursor3']
                : ['1', '2', '3'],
          );
          expect(pages).toHaveLength(3);
          const preview = await connector(app).preview(context(app), select(object.name), 3);
          expect(preview.rows).toHaveLength(3);
          expect(preview.rows.every((row) => row.length === preview.columns.length)).toBe(true);
        }
        expect(requests.every((request) => request.method === 'GET' && request.signed)).toBe(true);
        expect(requests.every((request) => !request.query.toString().includes(token))).toBe(true);
        if (app === 'coda') {
          expect(
            requests
              .filter((request) => request.path.endsWith('/tables'))
              .every((request) => request.query.get('tableTypes') === 'table'),
          ).toBe(true);
          expect(
            requests
              .filter((request) => request.path.endsWith('/rows'))
              .every(
                (request) =>
                  request.query.get('useColumnNames') === 'true' &&
                  request.query.get('valueFormat') === 'simple',
              ),
          ).toBe(true);
        }
      },
    );

    it('accepts an empty account with zero rows and no discovered objects', async () => {
      empty = true;
      expect((await connector(app).test(context(app))).ok).toBe(true);
      const objects = await connector(app).listObjects(context(app));
      expect(objects.map((object) => object.name)).toEqual(
        app === 'coda' ? ['docs'] : ['forms', 'workspaces'],
      );
      for (const object of objects) {
        expect((await connector(app).preview(context(app), select(object.name), 3)).rows).toEqual([]);
        expect(await read(app, object.name)).toEqual([]);
      }
    });

    it('names a refused token and its creation page without exposing the credential', async () => {
      refused = true;
      const tested = await connector(app).test(context(app));
      expect(tested.ok).toBe(false);
      expect(tested.steps.at(-1)).toMatchObject({
        messageKey: `sources.app.${app}.deniedToken`,
        params: {
          keyUrl: app === 'coda' ? 'https://coda.io/account' : 'https://admin.typeform.com/user/tokens',
        },
      });
      await expect(connector(app).listObjects(context(app))).rejects.toMatchObject({
        messageKey: `sources.app.${app}.deniedToken`,
      });
      expect(JSON.stringify(tested)).not.toContain(token);
    });

    it('omits a refused object and names the permission it needs', async () => {
      denied = app === 'coda' ? '/tables/t0/rows' : '/forms/f0/responses';
      const tested = await connector(app).test(context(app));
      expect(tested.ok).toBe(true);
      expect(tested.steps).toContainEqual(
        expect.objectContaining({
          status: 'skipped',
          messageKey: 'sources.app.objectNotAllowed',
          params: {
            object: app === 'coda' ? 'd0/t0' : 'f0',
            permission: app === 'coda' ? 'read' : 'responses:read',
            hasPermission: true,
          },
        }),
      );
      expect((await connector(app).listObjects(context(app))).map((object) => object.name)).not.toContain(
        app === 'coda' ? 'd0/t0' : 'f0',
      );
    });

    it('names the permission for denied child discovery or a fixed object', async () => {
      denied = app === 'coda' ? '/tables' : '/workspaces';
      const tested = await connector(app).test(context(app));
      expect(tested.ok).toBe(true);
      expect(tested.steps).toContainEqual(
        expect.objectContaining({
          status: 'skipped',
          messageKey: 'sources.app.objectNotAllowed',
          params: {
            object: app === 'coda' ? 'tables' : 'workspaces',
            permission: app === 'coda' ? 'read' : 'workspaces:read',
            hasPermission: true,
          },
        }),
      );
      const objects = await connector(app).listObjects(context(app));
      if (app === 'coda') expect(objects.map((object) => object.name)).toEqual(['docs']);
      else expect(objects.map((object) => object.name)).not.toContain('workspaces');
    });

    it('refuses undeclared settings, address overrides, missing tokens, and invalid regions before requesting', async () => {
      const cases: Array<[ConnectorContext, string]> = [
        [{ ...context(app), secrets: {} }, 'sources.app.secretMissing'],
        [
          {
            ...context(app),
            connection: {
              ...context(app).connection,
              baseUrl: 'https://elsewhere.test',
            } as ConnectorContext['connection'],
          },
          'sources.app.address',
        ],
        ...['token', 'baseUrl', 'headers', 'page_size', ...(app === 'coda' ? ['region'] : [])].map(
          (key): [ConnectorContext, string] => [
            { ...context(app), connection: { kind: 'app', app, settings: { [key]: 'value' } } },
            'sources.app.undeclaredSetting',
          ],
        ),
        ...(app === 'typeform'
          ? ['other', 'EU', 'https://api.typeform.com', 1, null, {}, ['eu']].map(
              (region): [ConnectorContext, string] => [
                { ...context(app), connection: { kind: 'app', app, settings: { region } } },
                'sources.app.typeform.regionInvalid',
              ],
            )
          : []),
      ];
      for (const [ctx, messageKey] of cases) {
        await expect(connector(app).listObjects(ctx)).rejects.toMatchObject({ messageKey });
        expect((await connector(app).test(ctx)).steps.at(-1)?.messageKey).toBe(messageKey);
      }
      expect(requests).toEqual([]);
    });

    it('keeps columns for an empty table or form without inventing rows', async () => {
      emptyRows = true;
      const name = app === 'coda' ? 'd0/t0' : 'f0';
      const preview = await connector(app).preview(context(app), select(name), 3);
      expect(preview.rows).toEqual([]);
      expect(preview.rowEstimate).toBe(0);
      expect(preview.columns.map((column) => column.name)).toContain(app === 'coda' ? 'Count' : 'Contact');
      expect(await read(app, name)).toEqual([]);
      const definitionIndex = requests.findIndex((request) =>
        request.path.endsWith(app === 'coda' ? '/columns' : '/forms/f0'),
      );
      const rowsIndex = requests.findIndex((request) =>
        request.path.endsWith(app === 'coda' ? '/rows' : '/responses'),
      );
      expect(definitionIndex).toBeGreaterThanOrEqual(0);
      expect(definitionIndex).toBeLessThan(rowsIndex);
    });
  });

it('projects Coda values as columns while retaining row metadata', async () => {
  const preview = await connector('coda').preview(context('coda'), select('d0/t0'), 5);
  const columns = preview.columns.map((column) => column.name);
  expect(columns).toEqual(
    expect.arrayContaining([
      'id',
      'name',
      'index',
      'createdAt',
      'updatedAt',
      'browserLink',
      'Name',
      'Count',
      'Enabled',
      'Street.name',
      'id (2)',
      '__proto__',
    ]),
  );
  const rows = await read('coda', 'd0/t0', columns);
  expect(rows[0]!.values).toMatchObject({
    id: 'r0',
    Count: '0',
    Enabled: 'FALSE',
    'Street.name': '10 Example St',
    'id (2)': 'Column identifier',
    ['__proto__']: 'Safe label',
  });
  expect(
    requests
      .filter((request) => request.path.endsWith('/columns'))
      .slice(-3)
      .map((request) => request.query.get('pageToken')),
  ).toEqual([null, '2', '4']);
});

it('projects nested Typeform questions, all answer types, hidden fields, variables, and scores', async () => {
  const preview = await connector('typeform').preview(context('typeform'), select('f0'), 5);
  const columns = preview.columns.map((column) => column.name);
  expect(new Set(columns).size).toBe(columns.length);
  const rows = await read('typeform', 'f0', columns);
  expect(rows[0]!.values).toEqual({
    response_id: 'r0',
    token: 'cursor0',
    landed_at: '2026-10-01T12:00:00Z',
    submitted_at: '2026-10-01T12:01:00Z',
    'calculated.score': '0',
    Contact: 'Example',
    'Contact (2)': 'person@example.test',
    url: 'https://example.test',
    file_url: 'https://example.test/file',
    phone_number: '+12125550100',
    number: '0',
    boolean: 'FALSE',
    date: '2026-10-01',
    choice: 'Other answer',
    choices: 'Red, Blue',
    payment: '12 USD',
    fallback: 'Fallback value',
    'response_id (2)': 'Question identifier',
    ['__proto__']: 'Safe label',
    'hidden.campaign': 'example',
    'hidden.zero': '0',
    'variables.label': 'Example variable',
    'variables.total': '0',
  });
  expect(rows[4]!.values.Contact).toBeNull();
  expect(preview.rows[0]![columns.indexOf('Contact')]).toBe('Example');
});

it('keeps payment currency from the Typeform definition in previews and every response page', async () => {
  definitionCurrency = true;
  const preview = await connector('typeform').preview(context('typeform'), select('f0'), 5);
  const payment = preview.columns.findIndex((column) => column.name === 'payment');
  expect(payment).toBeGreaterThanOrEqual(0);
  expect(preview.rows.map((row) => row[payment])).toEqual(Array(5).fill('12 USD'));
  const rows = await read('typeform', 'f0', ['response_id', 'payment']);
  expect(rows).toHaveLength(5);
  expect(rows.map((row) => row.values.payment)).toEqual(Array(5).fill('12 USD'));
});
