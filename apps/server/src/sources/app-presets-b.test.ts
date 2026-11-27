import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, assert, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppConnection, SourceConnection, type SourceSelect } from '@riosoma/contracts';
import { APP_PRESETS, createAppConnector, type ConnectorContext, type SourceRow } from '@riosoma/connectors';
import { restConnectorOptions } from './rest.js';
import { checkSecrets } from './store.js';

const apps = ['gitlab', 'okta', 'freshdesk', 'mailchimp'] as const;
type App = (typeof apps)[number];
const names = {
  gitlab: [
    'projects',
    'groups',
    ...[1, 2, 3].flatMap((i) => [`project-${i}/issues`, `project-${i}/merge_requests`]),
  ],
  okta: ['users', 'groups', 'applications', 'system_log', ...[1, 2, 3].map((i) => `group-${i}/members`)],
  freshdesk: ['tickets', 'contacts', 'companies', 'agents', 'groups'],
  mailchimp: [
    'audiences',
    'campaigns',
    'templates',
    'automations',
    'reports',
    ...[1, 2, 3].map((i) => `audience-${i}/members`),
  ],
};
const settings = {
  gitlab: {},
  okta: { organization: 'https://sample.okta.com' },
  freshdesk: { helpdesk: 'https://sample.freshdesk.com' },
  mailchimp: {},
};
const select = (name: string): SourceSelect => ({ kind: 'object', object: { schema: null, name } });

/** Made-up answers retain the envelope, field, and paging shapes used by each app. */
function record(app: App, path: string, page: number): Record<string, unknown> {
  if (app === 'gitlab') {
    if (path.endsWith('/projects'))
      return { id: `project-${page}`, path_with_namespace: `sample/project-${page}` };
    if (path.endsWith('/groups')) return { id: `group-${page}`, name: `Group ${page}` };
    return {
      id: `item-${page}`,
      labels: ['triage', 'customer'],
      author: { username: 'writer', id: 7 },
      assignees: [{ username: 'reader', id: 8 }],
    };
  }
  if (app === 'okta') {
    if (path.endsWith('/groups'))
      return { id: `group-${page}`, profile: { name: `Group ${page}`, description: 'Example group' } };
    if (path.endsWith('/apps'))
      return {
        id: `app-${page}`,
        label: 'Example application',
        name: 'example',
        status: 'ACTIVE',
        signOnMode: 'SAML_2_0',
        created: '2026-01-01T00:00:00Z',
        lastUpdated: '2026-02-01T00:00:00Z',
        credentials: { userName: 'omit' },
        settings: { app: { value: 'omit' } },
      };
    if (path.endsWith('/logs'))
      return { uuid: `event-${page}`, displayMessage: 'Example event', published: '2026-10-17T00:00:00Z' };
    return {
      id: `user-${page}`,
      status: 'ACTIVE',
      profile: { login: 'reader@example.test', firstName: 'Example', customAttribute: 'Custom value' },
    };
  }
  if (app === 'freshdesk')
    return {
      id: `item-${page}`,
      name: 'Example record',
      custom_fields: { region: 'West', score: page },
      ...(path.endsWith('/agents')
        ? { contact: { name: 'Example agent', email: 'agent@example.test' } }
        : {}),
    };
  return {
    id: path.endsWith('/lists') ? `audience-${page}` : `item-${page}`,
    name: `Audience ${page}`,
    merge_fields: { FIRSTNAME: 'Example', SCORE: page, _links: [{ href: 'omit' }] },
    _links: [{ href: 'omit' }],
    nested: { _links: [{ href: 'omit' }], keep: 'Kept', items: [{ _links: [], keep: 'Kept' }] },
  };
}

describe.each(apps)('%s through the server’s guarded network', (app) => {
  const preset = APP_PRESETS.find((entry) => entry.catalog.id === app)!;
  const appSecret = preset.catalog.secret;
  assert(appSecret);
  const secret = `${randomBytes(24).toString('hex')}${app === 'mailchimp' ? '-us21' : ''}`;
  const prefix = app === 'gitlab' ? '/api/v4' : '';
  const refusedObject =
    app === 'gitlab'
      ? 'groups'
      : app === 'okta'
        ? 'applications'
        : app === 'freshdesk'
          ? 'groups'
          : 'reports';
  const refusedPath = `${prefix}${app === 'okta' ? '/api/v1/apps' : app === 'freshdesk' ? '/api/v2/groups' : app === 'mailchimp' ? '/3.0/reports' : '/groups'}`;
  let listener: Server;
  let origin: string;
  let empty = false;
  let emptyChildren = false;
  let refused = 0;
  let limited = false;
  let limitedPath = refusedPath;
  let elsewhere = false;
  const requests: { path: string; query: URLSearchParams; method: string; signed: boolean }[] = [];
  /**
   * When the connector let each request go, which is where its pace is kept.  When the test server
   * saw each one also depends on how long delivery took, which a busy machine stretches and
   * squeezes.
   */
  const sent: number[] = [];

  beforeAll(async () => {
    listener = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const signed =
        req.headers.authorization ===
        (app === 'okta'
          ? `SSWS ${secret}`
          : app === 'freshdesk'
            ? `Basic ${Buffer.from(`${secret}:X`).toString('base64')}`
            : `Bearer ${secret}`);
      requests.push({
        path: url.pathname,
        query: url.searchParams,
        method: req.method ?? '',
        signed,
      });
      const json = (status: number, body: unknown, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      if (refused || !signed) return json(refused || 401, { message: secret });
      if (limited && url.pathname === limitedPath)
        return json(
          403,
          app === 'gitlab'
            ? { error: 'insufficient_scope', error_description: secret, scope: 'api read_api' }
            : app === 'okta'
              ? {
                  errorCode: 'E0000006',
                  errorSummary: 'You do not have permission to perform the requested action',
                }
              : { message: secret },
        );
      const allowedPaths =
        app === 'gitlab'
          ? /^\/api\/v4\/(projects|groups|projects\/project-[123]\/(issues|merge_requests))$/
          : app === 'okta'
            ? /^\/api\/v1\/(users|groups|apps|logs|groups\/group-[123]\/users)$/
            : app === 'freshdesk'
              ? /^\/api\/v2\/(tickets|contacts|companies|agents|groups)$/
              : /^\/3\.0\/(lists|campaigns|templates|automations|reports|lists\/audience-[123]\/members)$/;
      if (!allowedPaths.test(url.pathname)) return json(404, {});
      const page =
        app === 'mailchimp'
          ? Number(url.searchParams.get('offset') ?? 0) + 1
          : Number(url.searchParams.get('page') ?? 1);
      if (page > 3) return json(400, {});
      const noRows = empty || (emptyChildren && /\/(projects|groups|lists)\/[^/]+\//.test(url.pathname));
      const rows = noRows ? [] : [record(app, url.pathname, page)];
      if (app === 'mailchimp') {
        const member = url.pathname.split('/').pop()!;
        return json(200, { [member]: rows, total_items: noRows ? 0 : 3, _links: [] });
      }
      const next = new URL(`${url.pathname}${url.search}`, origin);
      next.searchParams.set('page', String(page + 1));
      return json(
        200,
        rows,
        noRows || page === 3
          ? {}
          : {
              link: `<${url.pathname}>; rel="prev", <${elsewhere ? 'https://elsewhere.test/page' : next.href}>; rel="next"`,
            },
      );
    });
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    origin = `http://localhost:${(listener.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    requests.length = 0;
    sent.length = 0;
    empty = false;
    emptyChildren = false;
    refused = 0;
    limited = false;
    limitedPath = refusedPath;
    elsewhere = false;
  });

  afterAll(async () => {
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
  });

  function connector(local = true) {
    const options = restConnectorOptions(
      { production: false, automationsAllowPrivateHosts: true },
      async () => [{ address: '127.0.0.1', family: 4 }],
    );
    const network = options.network!;
    return createAppConnector(
      {
        ...options,
        network: {
          ...network,
          request: (request) => {
            sent.push(Date.now());
            return network.request(request);
          },
        },
      },
      // Substitute only the destination, preserving the preset's sign-in, paging, and pacing.
      [
        {
          ...preset,
          target: { ...preset.target, address: local ? `${origin}${prefix}` : preset.target.address },
        },
      ],
    );
  }

  function context(): ConnectorContext {
    assert(appSecret);
    return {
      connection: AppConnection.parse({ kind: 'app', app, settings: settings[app] }),
      secrets: { [appSecret.name]: secret },
      timeoutMs: 30_000,
    };
  }

  async function read(name: string, columns = [name === 'system_log' ? 'uuid' : 'id']) {
    const rows: SourceRow[] = [];
    for await (const batch of connector().read(context(), select(name), {
      columns,
      types: Object.fromEntries(columns.map((column) => [column, 'text'])),
      keyColumns: [name === 'system_log' ? 'uuid' : 'id'],
      batchSize: 2,
    }))
      rows.push(...batch);
    return rows;
  }

  function assertRequests() {
    expect(requests.every((request) => request.method === 'GET' && request.signed)).toBe(true);
    expect(requests.every((request) => !request.query.toString().includes(secret))).toBe(true);
    for (const request of requests) {
      expect(request.query.get(app === 'okta' ? 'limit' : app === 'mailchimp' ? 'count' : 'per_page')).toBe(
        app === 'okta'
          ? request.path.endsWith('/logs')
            ? '1000'
            : '200'
          : app === 'mailchimp'
            ? '1000'
            : '100',
      );
      if (app === 'gitlab' && request.path.endsWith('/projects'))
        expect(request.query.get('membership')).toBe('true');
      if (app === 'gitlab' && /\/(issues|merge_requests)$/.test(request.path))
        expect(request.query.get('scope')).toBe('all');
      if (app === 'freshdesk' && request.path.endsWith('/tickets'))
        expect(request.query.get('updated_since')).toBe('2000-01-01T00:00:00Z');
    }
  }

  it('tests sign-in and lists all static and discovered objects using paced, signed GETs', async () => {
    expect(preset.target.requestsPerSecond).toBe(app === 'gitlab' ? 5 : app === 'mailchimp' ? 3 : 0.5);
    const source = connector();
    expect((await source.test(context())).ok).toBe(true);
    const objects = await source.listObjects(context());
    expect(objects.map((object) => object.name)).toEqual(names[app]);
    expect(objects.every((object) => object.labelMessageId?.startsWith(`sources.app.${app}.`))).toBe(true);
    if (app !== 'freshdesk')
      expect(objects.at(-1)?.labelParams).toEqual({
        parent: app === 'gitlab' ? 'sample/project-3' : app === 'okta' ? 'Group 3' : 'Audience 3',
      });
    assertRequests();
    expect(sent).toHaveLength(requests.length);
    for (let index = 1; index < sent.length; index++)
      expect(sent[index]! - sent[index - 1]!).toBeGreaterThanOrEqual(
        1_000 / preset.target.requestsPerSecond - 30,
      );
  });

  it.each(names[app])('reads and previews %s across three pages and stops on the last', async (name) => {
    const rows = await read(name);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
    const path = requests.at(-1)!.path;
    const pages = requests.filter((request) => request.path === path);
    // A discovered object's parent list is a different path from the object being read.
    expect(pages.map((request) => request.query.get(app === 'mailchimp' ? 'offset' : 'page'))).toEqual(
      app === 'mailchimp' ? ['0', '1', '2'] : [null, '2', '3'],
    );
    assertRequests();
    const preview = await connector().preview(context(), select(name), 3);
    expect(preview.rows).toHaveLength(3);
    expect(preview.rows.every((row) => row.length === preview.columns.length)).toBe(true);
    const columns = preview.columns.map((column) => column.name);
    if (app === 'gitlab' && name.includes('/')) {
      const value = (column: string) => preview.rows[0]![columns.indexOf(column)];
      expect(value('labels')).toBe('triage, customer');
      expect(value('author')).toBe('writer');
      expect(value('assignees')).toBe('reader');
      expect(columns).not.toContain('author.id');
      expect((await read(name, ['id', 'labels', 'author', 'assignees']))[0]!.values).toMatchObject({
        labels: 'triage, customer',
        author: 'writer',
        assignees: 'reader',
      });
    }
    if (app === 'okta' && (name === 'users' || name.endsWith('/members')))
      expect(columns).toEqual(
        expect.arrayContaining(['profile.login', 'profile.firstName', 'profile.customAttribute']),
      );
    if (app === 'okta' && name === 'groups')
      expect(columns).toEqual(expect.arrayContaining(['profile.name', 'profile.description']));
    if (app === 'okta' && name === 'applications')
      expect(columns.sort()).toEqual(
        ['id', 'label', 'name', 'status', 'signOnMode', 'created', 'lastUpdated'].sort(),
      );
    if (app === 'freshdesk') {
      expect(columns).toEqual(expect.arrayContaining(['custom_fields.region', 'custom_fields.score']));
      if (name === 'agents')
        expect(columns).toEqual(expect.arrayContaining(['contact.name', 'contact.email']));
    }
    if (app === 'mailchimp') {
      expect(columns.some((column) => column.includes('_links'))).toBe(false);
      expect(JSON.stringify(preview.rows).includes('_links')).toBe(false);
      if (name.endsWith('/members'))
        expect(columns).toEqual(expect.arrayContaining(['merge_fields.FIRSTNAME', 'merge_fields.SCORE']));
    }
  });

  it('accepts an empty account with zero rows and no error for every static object', async () => {
    empty = true;
    expect((await connector().test(context())).ok).toBe(true);
    expect((await connector().listObjects(context())).map((object) => object.name)).toEqual(
      preset.objects.map((object) => object.name),
    );
    for (const object of preset.objects) {
      expect(await read(object.name)).toEqual([]);
      expect((await connector().preview(context(), select(object.name), 3)).rows).toEqual([]);
    }
    assertRequests();
  }, 90_000);

  if (app !== 'freshdesk')
    it.each(names[app].filter((name) => name.includes('/')))(
      'accepts empty discovered %s records while its parent still exists',
      async (name) => {
        emptyChildren = true;
        expect(await read(name)).toEqual([]);
        expect((await connector().preview(context(), select(name), 3)).rows).toEqual([]);
        const path = requests.at(-1)!.path;
        expect(requests.filter((request) => request.path === path)).toHaveLength(2);
        assertRequests();
      },
    );

  it.each([401, 403])(
    'identifies a refused key and its key page at HTTP %s without exposing it',
    async (status) => {
      refused = status;
      const result = await connector().test(context());
      expect(result.ok).toBe(false);
      expect(result.steps.at(-1)).toMatchObject({
        messageKey: appSecret.deniedMessageId,
        params: { keyUrl: preset.catalog.keyUrl },
      });
      expect(JSON.stringify(result).includes(secret)).toBe(false);
      if (status === 401) {
        const error: unknown = await connector()
          .listObjects(context())
          .catch((caught: unknown) => caught);
        expect(error).toMatchObject({
          messageKey: appSecret.deniedMessageId,
          params: { keyUrl: preset.catalog.keyUrl },
        });
        expect(JSON.stringify(error).includes(secret)).toBe(false);
      }
    },
  );

  it('leaves out an unreadable object and reports only permission information the app provides', async () => {
    limited = true;
    const result = await connector().test(context());
    expect(result.ok).toBe(true);
    expect(result.steps.filter((step) => step.step === 'rows' && step.status === 'skipped')).toEqual([
      expect.objectContaining({
        messageKey: app === 'okta' ? 'sources.app.okta.objectNotAllowed' : 'sources.app.objectNotAllowed',
        params: expect.objectContaining({
          object: refusedObject,
          permission: app === 'gitlab' ? 'api, read_api' : '',
          hasPermission: app === 'gitlab',
        }),
      }),
    ]);
    expect((await connector().listObjects(context())).map((object) => object.name)).toEqual(
      names[app].filter((name) => name !== refusedObject),
    );
    const error: unknown = await read(refusedObject).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      messageKey: app === 'okta' ? 'sources.app.okta.objectNotAllowed' : 'sources.app.objectNotAllowed',
    });
    expect(JSON.stringify(result).includes(secret)).toBe(false);
    expect(JSON.stringify(error).includes(secret)).toBe(false);
  });

  if (app === 'okta')
    it('accepts a token whose admin cannot read Users and keeps its other objects available', async () => {
      limited = true;
      limitedPath = '/api/v1/users';
      const source = connector();
      const result = await source.test(context());
      expect(result.ok).toBe(true);
      expect(result.steps.filter((step) => step.status === 'failed')).toEqual([]);
      expect(result.steps.filter((step) => step.status === 'skipped' && step.messageKey)).toEqual([
        expect.objectContaining({
          messageKey: 'sources.app.okta.objectNotAllowed',
          params: {
            object: 'users',
            objectMessageId: 'sources.app.okta.users',
            parent: '',
            permission: '',
            hasPermission: false,
          },
        }),
      ]);
      expect((await source.listObjects(context())).map((object) => object.name)).toEqual(
        names.okta.filter((name) => name !== 'users'),
      );
      expect((await source.preview(context(), select('applications'), 1)).rows).toHaveLength(1);
      expect(JSON.stringify(result).includes(secret)).toBe(false);
      assertRequests();
    });

  it('refuses undeclared settings, connection overrides, and missing keys before any request', async () => {
    for (const [overrides, messageKey] of [
      [{ settings: { ...settings[app], unexpected: 'value' } }, 'sources.app.undeclaredSetting'],
      [{ baseUrl: 'https://elsewhere.test' }, 'sources.app.address'],
      [{ requestsPerSecond: 100 }, 'sources.app.settingInvalid'],
      [{ auth: { method: 'none' } }, 'sources.app.settingInvalid'],
      [{ endpoints: [] }, 'sources.app.settingInvalid'],
      [{ settings: [] }, 'sources.app.settingInvalid'],
    ] as const) {
      const ctx = context();
      ctx.connection = { ...ctx.connection, ...overrides } as ConnectorContext['connection'];
      expect((await connector().test(ctx)).steps[0]?.messageKey).toBe(messageKey);
      await expect(connector().listObjects(ctx)).rejects.toMatchObject({ messageKey });
    }
    const ctx = { ...context(), secrets: {} };
    await expect(connector().listObjects(ctx)).rejects.toMatchObject({
      messageKey: 'sources.app.secretMissing',
    });
    expect(() => checkSecrets(SourceConnection.parse(ctx.connection), {})).toThrowError(
      expect.objectContaining({ messageKey: 'sources.app.secretMissing' }),
    );
    expect(requests).toEqual([]);
  });

  if (app === 'okta' || app === 'freshdesk') {
    const field = app === 'okta' ? 'organization' : 'helpdesk';
    const domain = app === 'okta' ? 'okta.com' : 'freshdesk.com';
    it('accepts bare tenant names and HTTPS addresses on its declared vendor domain', () => {
      for (const [value, address] of [
        ['Sample', `https://sample.${domain}`],
        [`https://sample.${domain}/`, `https://sample.${domain}/`],
      ]) {
        expect(AppConnection.parse({ kind: 'app', app, settings: { [field]: value } }).settings[field]).toBe(
          address,
        );
      }
      expect(preset.target.address).toEqual({ setting: field, domain });
    });

    it.each<[unknown, string]>([
      [undefined, 'Required'],
      ['', 'Required'],
      [42, 'Invalid'],
      ['bad name', 'Invalid'],
      [`http://sample.${domain}`, 'Https'],
      ['https://elsewhere.test', 'Host'],
      [`https://${domain}`, 'Host'],
      [`https://user@sample.${domain}`, 'Credentials'],
      [`https://sample.${domain}:443`, 'Port'],
      [`https://sample.${domain}/api`, 'Path'],
      [`https://sample.${domain}?page=1`, 'Query'],
      [`https://sample.${domain}#part`, 'Fragment'],
      ...(app === 'okta'
        ? ([
            ['https://sample.oktapreview.com', 'Host'],
            ['https://sample.okta-emea.com', 'Host'],
          ] as [string, string][])
        : []),
    ])('refuses an invalid tenant setting with its own message, case %#', async (value, suffix) => {
      const ctx = context();
      ctx.connection = { kind: 'app', app, settings: { [field]: value } };
      const messageKey = `sources.app.${app}.${field}${suffix}`;
      expect((await connector().test(ctx)).steps[0]?.messageKey).toBe(messageKey);
      await expect(connector().listObjects(ctx)).rejects.toMatchObject({ messageKey });
      expect(requests).toEqual([]);
    });
  }

  if (app === 'mailchimp') {
    it.each(['missing', 'trailing-', 'key-us/21', 'key-us21.example'])(
      'refuses a malformed data center suffix before any request, case %#',
      async (value) => {
        const ctx = { ...context(), secrets: { apiKey: value } };
        await expect(connector(false).listObjects(ctx)).rejects.toMatchObject({
          messageKey: 'sources.app.keyInvalid',
          params: { keyUrl: preset.catalog.keyUrl },
        });
        expect(requests).toEqual([]);
      },
    );
    it('takes the data center from the final dash in the sealed key', () => {
      expect(preset.target.address).toEqual({
        secret: 'apiKey',
        separator: '-',
        domain: 'api.mailchimp.com',
      });
    });
  } else {
    it('refuses a next page on another host before sending the key', async () => {
      elsewhere = true;
      await expect(read(preset.objects[0]!.name)).rejects.toMatchObject({
        messageKey: 'sources.app.nextElsewhere',
      });
      expect(requests).toHaveLength(1);
    });
  }
});
