import { randomBytes } from 'node:crypto';
import { RestEndpoint, type AppCatalogEntry } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import type { FileNetwork, FileRequest } from '../files/network.js';
import type { ConnectorContext } from '../types.js';
import { createAppConnector } from './connector.js';
import type { AppPreset } from './types.js';

const fresh = () => randomBytes(24).toString('hex');
const endpoint = (path = '/items') => RestEndpoint.parse({ name: 'items', path, records: 'data' });
const object = { name: 'items', key: 'id', endpoint: endpoint() };
const catalog: AppCatalogEntry = {
  id: 'frame',
  name: 'Example',
  settings: [],
  secret: { name: 'apiKey', helpMessageId: 'sources.app.key', deniedMessageId: 'sources.app.authenticate' },
  keyUrl: 'https://example.test/keys',
};
const preset: AppPreset = {
  catalog,
  target: {
    address: 'https://api.example.test',
    auth: { method: 'header', name: 'Authorization' },
    requestsPerSecond: 100,
  },
  objects: [object],
  test: object,
};
const select = (name = 'items') => ({ kind: 'object', object: { schema: null, name } }) as const;
const context = (
  secrets: ConnectorContext['secrets'] = { apiKey: fresh() },
  settings = {},
): ConnectorContext => ({
  connection: { kind: 'app', app: 'frame', settings },
  secrets,
});
function networkFor(answer: (request: FileRequest) => { status?: number; body: unknown }): FileNetwork {
  return {
    allowsAddress: () => true,
    check: async () => ({ address: '127.0.0.1', family: 4 }),
    async request(request) {
      const result = answer(request);
      return {
        status: result.status ?? 200,
        headers: {},
        url: request.url,
        body: (async function* () {
          yield Buffer.from(JSON.stringify(result.body));
        })(),
        close() {},
      };
    },
  };
}
const data = { data: [{ id: 'one' }] };

describe('declarative app frame extensions', () => {
  it('requires further secrets before any request and names the missing field in test advice', async () => {
    let calls = 0;
    const app: AppPreset = {
      ...preset,
      catalog: {
        ...catalog,
        additionalSecrets: [
          {
            name: 'refreshToken' as const,
            labelMessageId: 'sources.app.refreshToken',
            helpMessageId: 'sources.app.key',
          },
        ],
      },
    };
    const connector = createAppConnector(
      {
        network: networkFor(() => {
          calls++;
          return { body: data };
        }),
      },
      [app],
    );
    const ctx = context();
    await expect(connector.preview(ctx, select(), 1)).rejects.toMatchObject({
      messageKey: 'sources.app.secretMissing',
      params: { fieldMessageId: 'sources.app.refreshToken' },
    });
    expect((await connector.test(ctx)).steps[0]).toMatchObject({
      messageKey: 'sources.app.secretMissing',
      params: { fieldMessageId: 'sources.app.refreshToken' },
    });
    expect(calls).toBe(0);
    await connector.preview({ ...ctx, secrets: { ...ctx.secrets, refreshToken: fresh() } }, select(), 1);
    expect(calls).toBe(1);
  });

  it.each(['header', 'basic'] as const)(
    'passes the preset’s %s sign-in options to the API transport',
    async (method) => {
      const secret = fresh();
      let signed = false;
      const app: AppPreset = {
        ...preset,
        catalog: {
          ...catalog,
          secret: { ...catalog.secret, name: method === 'basic' ? 'password' : 'apiKey' },
        },
        target: {
          ...preset.target,
          auth:
            method === 'header'
              ? { method, name: 'Authorization', prefix: 'SSWS ' }
              : { method, user: 'X', secretAsUsername: true },
        },
      };
      const connector = createAppConnector(
        {
          network: networkFor((request) => {
            const auth = request.headers.Authorization ?? request.headers.authorization;
            signed =
              request.method === 'GET' &&
              auth ===
                (method === 'header'
                  ? `SSWS ${secret}`
                  : `Basic ${Buffer.from(`${secret}:X`).toString('base64')}`);
            return { body: data };
          }),
        },
        [app],
      );
      await connector.preview(context({ apiKey: secret, password: secret }), select(), 1);
      expect(signed).toBe(true);
    },
  );

  it('derives the API address from the last separator in a key', async () => {
    let host = '';
    const app: AppPreset = {
      ...preset,
      target: { ...preset.target, address: { secret: 'apiKey', separator: '-', domain: 'api.example.test' } },
    };
    const connector = createAppConnector(
      {
        network: networkFor((request) => {
          host = request.url.hostname;
          return { body: data };
        }),
      },
      [app],
    );
    await connector.preview(context({ apiKey: `${fresh()}-middle-US21` }), select(), 1);
    expect(host).toBe('us21.api.example.test');
  });

  it('refuses malformed key suffixes with the key page before reaching the network', async () => {
    let calls = 0;
    const app: AppPreset = {
      ...preset,
      target: { ...preset.target, address: { secret: 'apiKey', separator: '-', domain: 'api.example.test' } },
    };
    const connector = createAppConnector(
      {
        network: networkFor(() => {
          calls++;
          return { body: data };
        }),
      },
      [app],
    );
    for (const suffix of [null, '', 'us.21', 'us/21', 'us?x=1', 'us_21', 'a'.repeat(64)]) {
      const key = suffix === null ? fresh() : `${fresh()}-${suffix}`;
      const error: unknown = await connector
        .preview(context({ apiKey: key }), select(), 1)
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        messageKey: 'sources.app.keyInvalid',
        params: { keyUrl: catalog.keyUrl },
      });
      expect(JSON.stringify(error).includes(key)).toBe(false);
    }
    expect(calls).toBe(0);
  });

  const oauthApp = (grant: 'client_credentials' | 'account_credentials' | 'refresh_token'): AppPreset => ({
    ...preset,
    catalog: {
      ...catalog,
      secret: { ...catalog.secret, name: 'clientSecret' },
      additionalSecrets:
        grant === 'refresh_token'
          ? [
              {
                name: 'refreshToken' as const,
                labelMessageId: 'sources.app.refreshToken',
                helpMessageId: 'sources.app.key',
              },
            ]
          : [],
      settings: [
        {
          key: 'instance',
          type: 'address',
          domain: 'example.test',
          required: true,
          labelMessageId: 'sources.app.key',
          helpMessageId: 'sources.app.key',
        },
        {
          key: 'region',
          type: 'choice',
          values: ['us', 'eu'],
          required: false,
          labelMessageId: 'sources.app.key',
          helpMessageId: 'sources.app.key',
        },
        {
          key: 'client',
          type: 'text',
          maxLength: 30,
          pattern: '^[A-Za-z]+$',
          required: true,
          labelMessageId: 'sources.app.key',
          helpMessageId: 'sources.app.key',
        },
      ],
    },
    target: {
      ...preset.target,
      address:
        grant === 'client_credentials'
          ? { setting: 'instance', domain: 'example.test' }
          : {
              setting: 'region',
              default: 'us',
              choices: { us: 'https://api.example.test', eu: 'https://api.example.eu' },
            },
      auth: {
        method: 'oauth-client',
        grant,
        tokenUrl:
          grant === 'client_credentials'
            ? '{setting:instance}/services/token'
            : grant === 'account_credentials'
              ? 'https://accounts.example.test/token'
              : {
                  setting: 'region',
                  default: 'us',
                  choices: {
                    us: 'https://accounts.example.test/token',
                    eu: 'https://accounts.example.eu/token',
                  },
                },
        clientId: '{setting:client}',
        clientAuth: grant === 'account_credentials' ? 'basic' : 'body',
        tokenParams: { account_id: '{setting:client}' },
      },
    },
  });

  it.each(['client_credentials', 'account_credentials', 'refresh_token'] as const)(
    'resolves validated settings for the %s exchange and reuses the access token',
    async (grant) => {
      const app = oauthApp(grant);
      const secret = fresh();
      const refreshToken = fresh();
      const accessToken = fresh();
      let signed = true;
      let exchanges = 0;
      const connector = createAppConnector(
        {
          network: networkFor((request) => {
            if (request.method === 'POST') {
              exchanges++;
              const form = new URLSearchParams(request.body);
              signed &&= form.get('grant_type') === grant && form.get('account_id') === 'Client';
              signed &&=
                grant === 'account_credentials'
                  ? request.headers.authorization ===
                    `Basic ${Buffer.from(`Client:${secret}`).toString('base64')}`
                  : form.get('client_id') === 'Client' && form.get('client_secret') === secret;
              signed &&=
                grant === 'refresh_token'
                  ? form.get('refresh_token') === refreshToken
                  : !form.has('refresh_token');
              expect(request.url.href).toBe(
                grant === 'client_credentials'
                  ? 'https://customer.example.test/services/token'
                  : grant === 'account_credentials'
                    ? 'https://accounts.example.test/token'
                    : 'https://accounts.example.eu/token',
              );
              return { body: { access_token: accessToken, expires_in: 3_600 } };
            }
            signed &&= request.method === 'GET' && request.headers.authorization === `Bearer ${accessToken}`;
            expect(request.url.hostname).toBe(
              grant === 'client_credentials' ? 'customer.example.test' : 'api.example.eu',
            );
            return { body: data };
          }),
        },
        [app],
      );
      const ctx = context(
        { clientSecret: secret, refreshToken },
        { instance: 'https://customer.example.test', region: 'eu', client: 'Client' },
      );
      await connector.preview(ctx, select(), 1);
      await connector.preview(ctx, select(), 1);
      expect(exchanges).toBe(1);
      expect(signed).toBe(true);
    },
  );

  it.each(['', '/'])('joins the OAuth token path for an instance address ending in "%s"', async (suffix) => {
    const accessToken = fresh();
    const requests: string[] = [];
    const connector = createAppConnector(
      {
        network: networkFor((request) => {
          requests.push(`${request.method} ${request.url.pathname}`);
          if (request.method === 'POST')
            return request.url.pathname === '/services/token'
              ? { body: { access_token: accessToken, expires_in: 3_600 } }
              : { status: 404, body: {} };
          expect(request.headers.authorization === `Bearer ${accessToken}`).toBe(true);
          return { body: data };
        }),
      },
      [oauthApp('client_credentials')],
    );
    const ctx = context(
      { clientSecret: fresh() },
      { instance: `https://customer.example.test${suffix}`, client: 'Client' },
    );
    expect((await connector.preview(ctx, select(), 1)).rows).toHaveLength(1);
    expect(requests).toEqual(['POST /services/token', 'GET /items']);
  });

  it('refuses invalid settings and a token host supplied by a setting before making a request', async () => {
    let calls = 0;
    const app = oauthApp('account_credentials');
    const dynamic: AppPreset = {
      ...app,
      target: {
        ...app.target,
        auth: {
          method: 'oauth-client',
          clientId: '{setting:client}',
          clientAuth: 'body',
          tokenUrl: '{setting:instance}/token',
        },
      },
    };
    const connector = createAppConnector(
      {
        network: networkFor(() => {
          calls++;
          return { body: data };
        }),
      },
      [dynamic],
    );
    for (const [settings, messageKey] of [
      [{ instance: 'https://elsewhere.example.test', client: 'Client' }, 'sources.app.address'],
      [{ instance: 'https://api.example.test', client: 'bad/value' }, 'sources.app.settingInvalid'],
      [
        { instance: 'https://api.example.test', client: 'Client', region: 'unknown' },
        'sources.app.settingInvalid',
      ],
    ] as const)
      await expect(
        connector.preview(context({ clientSecret: fresh() }, settings), select(), 1),
      ).rejects.toMatchObject({ messageKey });
    expect(calls).toBe(0);
  });

  it.each([400, 401, 403, 500])(
    'classifies token response HTTP %s without exposing credentials or external words',
    async (status) => {
      const secret = fresh();
      const marker = 'external-response-marker';
      let calls = 0;
      const connector = createAppConnector(
        {
          retries: 1,
          sockets: { connect: async () => {}, handshake: async () => {} },
          network: networkFor(() => {
            calls++;
            return { status, body: { error: `${marker} ${secret}` } };
          }),
        },
        [oauthApp('account_credentials')],
      );
      const expected = {
        messageKey: status === 500 ? 'sources.app.status' : catalog.secret.deniedMessageId,
        params: { status, ...(status === 500 ? {} : { keyUrl: catalog.keyUrl }) },
      };
      const error: unknown = await connector
        .preview(
          context({ clientSecret: secret }, { instance: 'https://api.example.test', client: 'Client' }),
          select(),
          1,
        )
        .catch((error: unknown) => error);
      expect(error).toMatchObject(expected);
      expect(calls).toBe(status === 500 ? 2 : 1);
      expect(JSON.stringify(error).includes(secret)).toBe(false);
      expect(JSON.stringify(error).includes(marker)).toBe(false);
      const result = await connector.test(
        context({ clientSecret: secret }, { instance: 'https://api.example.test', client: 'Client' }),
      );
      expect(result.steps.at(-1)).toMatchObject(expected);
      expect(calls).toBe(status === 500 ? 4 : 2);
      expect(JSON.stringify(result).includes(secret)).toBe(false);
      expect(JSON.stringify(result).includes(marker)).toBe(false);
    },
  );

  it('continues to refuse an external write body before requesting a token or an object', async () => {
    let calls = 0;
    const connector = createAppConnector(
      {
        queryBody: () => '{}',
        network: networkFor(() => {
          calls++;
          return { body: data };
        }),
      },
      [oauthApp('account_credentials')],
    );
    await expect(
      connector.preview(
        context({ clientSecret: fresh() }, { instance: 'https://api.example.test', client: 'Client' }),
        select(),
        1,
      ),
    ).rejects.toMatchObject({ messageKey: 'sources.app.queryOnly' });
    expect(calls).toBe(0);
  });

  it('offers several kinds per parent and encodes every ancestor ID in nested discovery', async () => {
    const docId = 'doc/one?x=1';
    const tableId = 'table/two &more';
    const paths: string[] = [];
    const app: AppPreset = {
      ...preset,
      objects: [],
      discoveries: [
        {
          endpoint: endpoint('/projects'),
          id: 'id',
          label: 'name',
          parameter: 'project',
          optional: false,
          objects: ['issues', 'merge-requests'].map((name) => ({
            name,
            path: `/projects/{discovery:project}/${name}`,
            key: 'id',
            endpoint: endpoint(),
          })),
        },
        {
          endpoint: endpoint('/docs'),
          id: 'id',
          label: 'name',
          parameter: 'doc',
          optional: false,
          discoveries: [
            {
              endpoint: endpoint('/docs/{discovery:doc}/tables'),
              id: 'id',
              label: 'name',
              parameter: 'table',
              optional: false,
              objects: [
                {
                  name: 'rows',
                  path: '/docs/{discovery:doc}/tables/{discovery:table}/rows',
                  key: 'id',
                  endpoint: endpoint(),
                },
              ],
            },
          ],
        },
      ],
    };
    const connector = createAppConnector(
      {
        network: networkFor((request) => {
          expect(request.method).toBe('GET');
          const path = request.url.pathname;
          paths.push(path);
          return {
            body: {
              data:
                path === '/projects'
                  ? [{ id: 42, name: 'Project' }]
                  : path === '/docs'
                    ? [
                        { id: docId, name: 'Document' },
                        { id: 'another', name: 'Document' },
                      ]
                    : path.endsWith('/tables')
                      ? [{ id: tableId, name: 'Table' }]
                      : [{ id: 'row' }],
            },
          };
        }),
      },
      [app],
    );
    const objects = await connector.listObjects(context());
    expect(objects.map((object) => object.name)).toEqual([
      '42/issues',
      '42/merge-requests',
      `${encodeURIComponent(docId)}/${encodeURIComponent(tableId)}/rows`,
      `another/${encodeURIComponent(tableId)}/rows`,
    ]);
    expect(objects.at(-1)?.label).toBe('Document / Table / rows');
    const rowPath = `/docs/${encodeURIComponent(docId)}/tables/${encodeURIComponent(tableId)}/rows`;
    expect(paths).toContain(rowPath);
    expect((await connector.preview(context(), select(objects[2]!.name), 1)).rows).toHaveLength(1);
    expect(paths.at(-1)).toBe(rowPath);
  });

  it('keeps discovered names unique across roots and rejects path traversal IDs', async () => {
    const discovery = {
      endpoint: endpoint('/parents'),
      id: 'id',
      optional: false,
      objects: [{ name: 'rows', path: '/parents/{object}/rows', key: 'id', endpoint: endpoint() }],
    };
    const app: AppPreset = { ...preset, objects: [], discoveries: [discovery, discovery] };
    const connector = createAppConnector(
      {
        network: networkFor((request) => ({
          body: { data: request.url.pathname === '/parents' ? [{ id: 'same' }] : [{ id: 'row' }] },
        })),
      },
      [app],
    );
    expect((await connector.listObjects(context())).map((object) => object.name)).toEqual([
      'same/rows',
      'same/rows/2',
    ]);
    const refused = createAppConnector({ network: networkFor(() => ({ body: { data: [{ id: '..' }] } })) }, [
      app,
    ]);
    await expect(refused.listObjects(context())).rejects.toMatchObject({
      messageKey: 'sources.app.discovery',
    });
  });

  it('reads every page using the last response’s cursor and stops on a short page', async () => {
    const cursors: (string | null)[] = [];
    const paged = {
      ...object,
      endpoint: RestEndpoint.parse({
        ...object.endpoint,
        paging: {
          style: 'last-record',
          cursorPath: 'token',
          param: 'before',
          size: 2,
          sizeParam: 'page_size',
        },
      }),
    };
    const app: AppPreset = { ...preset, objects: [paged] };
    const connector = createAppConnector(
      {
        network: networkFor((request) => {
          const cursor = request.url.searchParams.get('before');
          cursors.push(cursor);
          expect(request.url.searchParams.get('page_size')).toBe('2');
          return {
            body: {
              data:
                cursor === null
                  ? [
                      { id: 'one', token: 'a' },
                      { id: 'two', token: 'b/?' },
                    ]
                  : [{ id: 'three', token: 'c' }],
            },
          };
        }),
      },
      [app],
    );
    const rows = [];
    for await (const batch of connector.read(context(), select(), {
      columns: ['id'],
      types: { id: 'text' },
      keyColumns: ['id'],
    }))
      rows.push(...batch);
    expect(rows).toHaveLength(3);
    expect(cursors).toEqual([null, 'b/?']);
  });
});
