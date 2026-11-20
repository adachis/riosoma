import { randomBytes } from 'node:crypto';
import { assert, describe, expect, it } from 'vitest';
import type { FileNetwork, FileRequest } from '../files/network.js';
import type { ConnectorContext, SourceRow } from '../types.js';
import { APP_PRESETS } from './index.js';
import { createAppConnector } from './connector.js';

const select = (name: string) => ({ kind: 'object', object: { schema: null, name } }) as const;

function source(app: string, answer: (request: FileRequest) => { body: unknown; status?: number }) {
  const network: FileNetwork = {
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
  const preset = APP_PRESETS.find((entry) => entry.catalog.id === app)!;
  return createAppConnector({ network, sockets: { connect: async () => {}, handshake: async () => {} } }, [
    { ...preset, target: { ...preset.target, requestsPerSecond: 100 } },
  ]);
}

function context(app: string): ConnectorContext {
  const preset = APP_PRESETS.find((entry) => entry.catalog.id === app)!;
  assert(preset.catalog.secret);
  return {
    connection: {
      kind: 'app',
      app,
      settings:
        app === 'okta' ? { organization: 'Sample' } : app === 'freshdesk' ? { helpdesk: 'Sample' } : {},
    },
    secrets: {
      [preset.catalog.secret.name]:
        `${randomBytes(24).toString('hex')}${app === 'mailchimp' ? '-extra-us21' : ''}`,
    },
  };
}

describe('app preset transport and projection rules', () => {
  it.each([
    ['gitlab', 'projects', 'https://gitlab.com/api/v4/projects'],
    ['okta', 'users', 'https://sample.okta.com/api/v1/users'],
    ['freshdesk', 'tickets', 'https://sample.freshdesk.com/api/v2/tickets'],
    ['mailchimp', 'audiences', 'https://us21.api.mailchimp.com/3.0/lists'],
  ])('resolves %s to its vendor and signs in using only the catalog key', async (app, name, address) => {
    const ctx = context(app!);
    const key = Object.values(ctx.secrets)[0]!;
    let requested = false;
    const connector = source(app!, (request) => {
      requested = true;
      expect(`${request.url.origin}${request.url.pathname}`).toBe(address);
      const authorization =
        app === 'okta'
          ? `SSWS ${key}`
          : app === 'freshdesk'
            ? `Basic ${Buffer.from(`${key}:X`).toString('base64')}`
            : `Bearer ${key}`;
      expect(new Headers(request.headers).get('authorization') === authorization).toBe(true);
      expect(request.method).toBe('GET');
      expect(request.url.href.includes(key)).toBe(false);
      return { body: app === 'mailchimp' ? { lists: [], total_items: 0 } : [] };
    });
    expect((await connector.preview(ctx, select(name!), 1)).rows).toEqual([]);
    expect(requested).toBe(true);
    expect(Object.keys(ctx.secrets)).toEqual([app === 'gitlab' ? 'token' : 'apiKey']);
  });

  it.each([false, true])(
    'continues checking after an initial permission refusal and requires a readable object, all refused %s',
    async (allRefused) => {
      const paths: string[] = [];
      const connector = source('okta', (request) => {
        paths.push(request.url.pathname);
        return allRefused || request.url.pathname.endsWith('/users')
          ? { status: 403, body: { errorCode: 'E0000006' } }
          : { body: [] };
      });
      const result = await connector.test(context('okta'));
      expect(result.ok).toBe(!allRefused);
      expect(paths).toEqual(expect.arrayContaining(['/api/v1/groups', '/api/v1/apps', '/api/v1/logs']));
      const skipped = result.steps.filter((step) => step.status === 'skipped' && step.messageKey);
      expect(skipped.map((step) => step.params?.object)).toEqual(
        allRefused ? ['users', 'groups', 'applications', 'system_log'] : ['users'],
      );
      expect(skipped.every((step) => step.messageKey === 'sources.app.okta.objectNotAllowed')).toBe(true);
      expect(result.steps.filter((step) => step.status === 'failed')).toEqual(
        allRefused ? [expect.objectContaining({ messageKey: 'sources.app.okta.deniedToken' })] : [],
      );
    },
  );

  it('keeps an authentication failure fatal even when its body includes a permission code', async () => {
    let calls = 0;
    const connector = source('okta', () => {
      calls++;
      return { status: 401, body: { errorCode: 'E0000006' } };
    });
    const result = await connector.test(context('okta'));
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({
      status: 'failed',
      messageKey: 'sources.app.okta.deniedToken',
    });
    expect(calls).toBe(1);
  });

  it('uses total_items across short and uneven offset pages, stopping without an extra request', async () => {
    const offsets: string[] = [];
    const connector = source('mailchimp', (request) => {
      const offset = request.url.searchParams.get('offset')!;
      offsets.push(offset);
      expect(request.url.searchParams.get('count')).toBe('1000');
      const start = Number(offset);
      const size = offset === '2' ? 1 : 2;
      return {
        body: {
          total_items: 5,
          lists: Array.from({ length: size }, (_, index) => ({ id: `record-${start + index}` })),
        },
      };
    });
    const rows: SourceRow[] = [];
    for await (const batch of connector.read(context('mailchimp'), select('audiences'), {
      columns: ['id'],
      types: { id: 'text' },
      keyColumns: ['id'],
    }))
      rows.push(...batch);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.key)).size).toBe(5);
    expect(offsets).toEqual(['0', '2', '3']);
  });

  it.each([undefined, -1, 1.5, '3', null])(
    'refuses invalid total counts instead of truncating a read, case %#',
    async (total) => {
      let calls = 0;
      const connector = source('mailchimp', () => {
        calls++;
        return { body: { lists: [{ id: 'record' }], total_items: total } };
      });
      await expect(connector.preview(context('mailchimp'), select('audiences'), 2)).rejects.toMatchObject({
        messageKey: 'sources.app.pagingLoop',
      });
      expect(calls).toBe(1);
    },
  );

  it('removes omitted members inside nested objects and lists before sampling and reading', async () => {
    const connector = source('mailchimp', () => ({
      body: {
        total_items: 1,
        lists: [
          {
            id: 'audience',
            _links: [],
            nested: { _links: [], keep: 'visible', items: [{ _links: [], keep: 'visible' }] },
          },
        ],
      },
    }));
    const ctx = context('mailchimp');
    const preview = await connector.preview(ctx, select('audiences'), 3);
    expect(preview.columns.map((column) => column.name)).toEqual(['id', 'nested.keep', 'nested.items']);
    expect(JSON.stringify(preview.rows).includes('_links')).toBe(false);
    const rows: SourceRow[] = [];
    for await (const batch of connector.read(ctx, select('audiences'), {
      columns: ['id', 'nested.items'],
      types: { id: 'text', 'nested.items': 'text' },
      keyColumns: ['id'],
    }))
      rows.push(...batch);
    expect(JSON.stringify(rows).includes('_links')).toBe(false);
    expect(JSON.stringify(rows).includes('visible')).toBe(true);
  });

  it('filters unsafe and secret-bearing scope names from a space-separated scope response', async () => {
    const ctx = context('gitlab');
    const key = ctx.secrets.token!;
    const connector = source('gitlab', () => ({
      status: 403,
      body: { error: 'insufficient_scope', scope: `api read_api <markup> ${key} api` },
    }));
    const error: unknown = await connector
      .preview(ctx, select('groups'), 1)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      messageKey: 'sources.app.objectNotAllowed',
      params: { permission: 'api, read_api', hasPermission: true },
    });
    expect(JSON.stringify(error).includes(key)).toBe(false);
    expect(JSON.stringify(error).includes('markup')).toBe(false);
  });
});
