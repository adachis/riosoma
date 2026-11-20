import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { APP_CATALOG, LIMITS, requiredSecrets, RestEndpoint, SourceConnection } from '@riosoma/contracts';
import { createAppConnector } from './connector.js';
import { TEST_PRESETS } from './index.test-support.js';
import { mergePropertyPages, propertyRequests } from './properties.js';
import type { ConnectorContext } from '../types.js';
import type { FileNetwork } from '../files/network.js';
import { ConnectorError } from '../types.js';
import type { AppPreset } from './types.js';

describe('app source frame', () => {
  const connection = {
    kind: 'app' as const,
    app: 'example',
    settings: { account: 'https://customer.example.test', region: 'us' },
  };

  it('validates an indexed preset through the public source contract and catalog', () => {
    expect(SourceConnection.safeParse(connection).success).toBe(true);
    expect(APP_CATALOG.find((entry) => entry.id === 'example')).toEqual(TEST_PRESETS.at(-1)!.catalog);
    expect(SourceConnection.safeParse({ ...connection, settings: {} }).success).toBe(false);
    expect(
      SourceConnection.safeParse({ ...connection, settings: { ...connection.settings, extra: 'value' } })
        .success,
    ).toBe(false);
  });

  it('uses the indexed preset secret through the public contract', () => {
    expect(requiredSecrets(connection)).toEqual(['password']);
  });

  it('adds a third declarative preset through its file and the test index', async () => {
    let requestedRegion: string | null = null;
    const network: FileNetwork = {
      allowsAddress: () => true,
      check: async () => ({ address: '127.0.0.1', family: 4 }),
      async request(request) {
        requestedRegion = request.url.searchParams.get('region');
        return {
          status: 200,
          headers: {},
          url: request.url,
          body: (async function* () {
            yield Buffer.from(JSON.stringify({ data: [{ id: 'one' }] }));
          })(),
          close() {},
        };
      },
    };
    const connector = createAppConnector({ network }, TEST_PRESETS);
    const context: ConnectorContext = {
      connection: {
        kind: 'app',
        app: 'example',
        settings: { account: 'https://customer.example.test', region: 'us' },
      },
      secrets: { password: randomBytes(24).toString('hex') },
    };
    expect(await connector.listObjects(context)).toEqual([
      { schema: null, name: 'items', type: 'endpoint', rowEstimate: null },
    ]);
    expect(await connector.keyCandidates(context, { schema: null, name: 'items' })).toEqual([['id']]);
    expect(
      (await connector.preview(context, { kind: 'object', object: { schema: null, name: 'items' } }, 1)).rows,
    ).toHaveLength(1);
    expect(requestedRegion).toBe('us');
    const refused = await connector.test({
      ...context,
      connection: {
        ...context.connection,
        kind: 'app',
        app: 'example',
        settings: { account: 'https://elsewhere.test', region: 'us' },
      },
    });
    expect(refused.steps[0]?.messageKey).toBe('sources.app.address');
  });

  it.each([
    {
      body: { error: { code: 'NO_ACCESS', scopes: ['items.read', 'items:access'] } },
      permission: 'items.read, items:access',
    },
    {
      body: { error: { code: 'NO_ACCESS', scopes: ['invalid permission', '<markup>', 42] } },
      permission: '',
    },
    { body: { error: { code: 'NO_ACCESS' }, message: 'requires one of [undeclared-read]' }, permission: '' },
  ])(
    'uses only a preset’s declared permission fields for object refusals, case %#',
    async ({ body, permission }) => {
      const preset: AppPreset = {
        ...TEST_PRESETS.at(-1)!,
        permissionDenied: {
          code: { path: 'error.code', values: ['NO_ACCESS'] },
          names: { path: 'error.scopes' },
        },
      };
      const secret = randomBytes(24).toString('hex');
      const marker = 'external-response-marker';
      const network: FileNetwork = {
        allowsAddress: () => true,
        check: async () => ({ address: '127.0.0.1', family: 4 }),
        async request(request) {
          return {
            status: 400,
            headers: {},
            url: request.url,
            body: (async function* () {
              yield Buffer.from(JSON.stringify({ ...body, detail: `${marker} ${secret}` }));
            })(),
            close() {},
          };
        },
      };
      const source = createAppConnector({ network }, [preset]);
      const ctx: ConnectorContext = { connection, secrets: { password: secret } };
      expect(await source.listObjects(ctx)).toEqual([]);
      const error: unknown = await source
        .preview(ctx, { kind: 'object', object: { schema: null, name: 'items' } }, 1)
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ConnectorError);
      expect(error).toMatchObject({
        messageKey: 'sources.app.objectNotAllowed',
        params: { object: 'items', permission, hasPermission: permission.length > 0 },
      });
      expect(String(error)).not.toContain(marker);
      expect(JSON.stringify(error)).not.toContain(marker);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain('undeclared-read');
    },
  );

  it('withholds secrets embedded in a declared permission list', async () => {
    const secret = `key-${randomBytes(24).toString('hex')}`;
    const preset: AppPreset = {
      ...TEST_PRESETS.at(-1)!,
      permissionDenied: { names: { path: 'scopes' } },
    };
    const network: FileNetwork = {
      allowsAddress: () => true,
      check: async () => ({ address: '127.0.0.1', family: 4 }),
      async request(request) {
        return {
          status: 403,
          headers: {},
          url: request.url,
          body: (async function* () {
            yield Buffer.from(JSON.stringify({ scopes: [`items.${secret}`, 'items.read'] }));
          })(),
          close() {},
        };
      },
    };
    const source = createAppConnector({ network }, [preset]);
    const error: unknown = await source
      .describe(
        { connection, secrets: { password: secret } },
        { kind: 'object', object: { schema: null, name: 'items' } },
      )
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      messageKey: 'sources.app.objectNotAllowed',
      params: { object: 'items', permission: 'items.read', hasPermission: true },
    });
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it('withholds encoded Basic credentials reflected into declared permission names', async () => {
    const secret = randomBytes(24).toString('hex');
    const serverSecret = randomBytes(24).toString('hex');
    const preset: AppPreset = {
      ...TEST_PRESETS.at(-1)!,
      target: { ...TEST_PRESETS.at(-1)!.target, auth: { method: 'basic', user: 'reader01' } },
      permissionDenied: { names: { path: 'scopes' } },
    };
    let encoded = '';
    const network: FileNetwork = {
      allowsAddress: () => true,
      check: async () => ({ address: '127.0.0.1', family: 4 }),
      async request(request) {
        encoded = request.headers.authorization!.slice('Basic '.length);
        return {
          status: 403,
          headers: {},
          url: request.url,
          body: (async function* () {
            yield Buffer.from(
              JSON.stringify({
                scopes: [
                  encoded,
                  `items.${encoded}`,
                  `items.${secret}`,
                  `items.${serverSecret}`,
                  'items.read',
                ],
              }),
            );
          })(),
          close() {},
        };
      },
    };
    const source = createAppConnector({ network }, [preset]);
    const ctx: ConnectorContext = {
      connection,
      secrets: { password: secret },
      serverSecrets: [serverSecret],
    };
    const error: unknown = await source
      .describe(ctx, { kind: 'object', object: { schema: null, name: 'items' } })
      .catch((error: unknown) => error);
    expect(encoded).toMatch(/^[A-Za-z][A-Za-z0-9]+$/);
    expect(JSON.stringify(error).includes(encoded)).toBe(false);
    expect(error).toMatchObject({
      messageKey: 'sources.app.objectNotAllowed',
      params: { object: 'items', permission: 'items.read', hasPermission: true },
    });
    expect(JSON.stringify(error).includes(secret)).toBe(false);
    expect(JSON.stringify(error).includes(serverSecret)).toBe(false);
  });

  it('keeps unrelated app failures fatal without exposing their response text', async () => {
    const marker = 'external-response-marker';
    const network: FileNetwork = {
      allowsAddress: () => true,
      check: async () => ({ address: '127.0.0.1', family: 4 }),
      async request(request) {
        return {
          status: 400,
          headers: {},
          url: request.url,
          body: (async function* () {
            yield Buffer.from(JSON.stringify({ message: marker }));
          })(),
          close() {},
        };
      },
    };
    const source = createAppConnector({ network }, TEST_PRESETS);
    const error: unknown = await source
      .listObjects({ connection, secrets: { password: randomBytes(24).toString('hex') } })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ messageKey: 'sources.app.status', params: { status: 400 } });
    expect(String(error)).not.toContain(marker);
    expect(JSON.stringify(error)).not.toContain(marker);
  });

  it.each([429, 503])('classifies declared permission errors before retrying HTTP %s', async (status) => {
    const preset: AppPreset = {
      ...TEST_PRESETS.at(-1)!,
      permissionDenied: { code: { path: 'error.code', values: ['NO_ACCESS'] } },
    };
    let requests = 0;
    const network: FileNetwork = {
      allowsAddress: () => true,
      check: async () => ({ address: '127.0.0.1', family: 4 }),
      async request(request) {
        requests++;
        return {
          status,
          headers: { 'retry-after': '0' },
          url: request.url,
          body: (async function* () {
            yield Buffer.from(JSON.stringify({ error: { code: 'NO_ACCESS' } }));
          })(),
          close() {},
        };
      },
    };
    const source = createAppConnector({ network, retries: 1 }, [preset]);
    expect(
      await source.listObjects({ connection, secrets: { password: randomBytes(24).toString('hex') } }),
    ).toEqual([]);
    expect(requests).toBe(1);
  });

  it('keeps every encoded property request within the address limit, including its cursor', () => {
    const url = new URL('https://api.hubapi.com/crm/v3/objects/contacts?limit=100');
    url.searchParams.set('after', 'cursor'.repeat(50));
    const names = Array.from({ length: 100 }, (_, i) => `property_${i}_${'x'.repeat(50)}`);
    const requests = propertyRequests(url, 'properties', names);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((request) => request.href.length <= LIMITS.urlLength)).toBe(true);
    expect(requests.flatMap((request) => request.searchParams.get('properties')!.split(','))).toEqual(names);
    expect(
      requests.every((request) => request.searchParams.get('after') === url.searchParams.get('after')),
    ).toBe(true);
    expect(() => propertyRequests(url, 'properties', ['x'.repeat(3_000)])).toThrow(
      'sources.app.propertyTooLong',
    );
  });

  it('joins property batches by key and rejects missing, duplicated, or shifted records', () => {
    const endpoint = RestEndpoint.parse({
      name: 'items',
      records: 'results',
      paging: { style: 'cursor', cursorPath: 'paging.next.after', param: 'after' },
    });
    const first = () => ({
      results: [
        { id: 'one', properties: { email: 'one@example.test' } },
        { id: 'two', properties: { email: 'two@example.test' } },
      ],
      paging: { next: { after: 'next' } },
    });
    const second = {
      results: [
        { id: 'two', properties: { name: 'Two' } },
        { id: 'one', properties: { name: 'One' } },
      ],
      paging: { next: { after: 'next' } },
    };
    expect(
      mergePropertyPages([first(), second], endpoint, 'id', 'properties', ['email', 'name']),
    ).toMatchObject({
      results: [
        { id: 'one', properties: { email: 'one@example.test', name: 'One' } },
        { id: 'two', properties: { email: 'two@example.test', name: 'Two' } },
      ],
    });
    for (const changed of [
      { ...second, results: second.results.slice(1) },
      { ...second, results: [second.results[0], second.results[0]] },
      { ...second, paging: { next: { after: 'different' } } },
    ])
      expect(() =>
        mergePropertyPages([first(), changed], endpoint, 'id', 'properties', ['email', 'name']),
      ).toThrow('sources.app.batchChanged');
  });
});
