import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RestEndpoint } from '@riosoma/contracts';
import type { FileNetwork } from '../files/network.js';
import { ConnectorError, type ConnectorContext } from '../types.js';
import { createAppConnector } from './connector.js';
import { fake } from './fake.test-support.js';
import type { AppPreset } from './types.js';

describe('app account values', () => {
  it('combines settings and discovered values while encoding each path segment and query value', async () => {
    const paths: URL[] = [];
    const account = 'north/branch?extra=value&other=one';
    const endpoint = RestEndpoint.parse({
      name: 'items',
      path: '/items/{value:account}',
      query: [
        { name: 'region', value: '{setting:region}' },
        { name: 'account', value: '{value:account}' },
      ],
      records: 'data',
    });
    const preset: AppPreset = {
      ...fake,
      target: { ...fake.target, requestsPerSecond: 100 },
      bootstrap: {
        endpoint: RestEndpoint.parse({ name: 'account', path: '/account/{setting:region}' }),
        values: { account: 'resource.account' },
      },
      objects: [{ name: 'items', key: 'id', endpoint }],
      test: { name: 'items', key: 'id', endpoint },
    };
    const network: FileNetwork = {
      allowsAddress: () => true,
      check: async () => ({ address: '127.0.0.1', family: 4 }),
      async request(request) {
        paths.push(request.url);
        expect(request.method).toBe('GET');
        const body = request.url.pathname.startsWith('/account/')
          ? { resource: { account } }
          : { data: [{ id: 'one' }] };
        return {
          status: 200,
          headers: {},
          url: request.url,
          body: (async function* () {
            yield Buffer.from(JSON.stringify(body));
          })(),
          close() {},
        };
      },
    };
    const connector = createAppConnector({ network }, [preset]);
    const context: ConnectorContext = {
      connection: {
        kind: 'app',
        app: 'example',
        settings: { account: 'https://customer.example.test', region: 'us' },
      },
      secrets: { password: randomBytes(24).toString('hex') },
    };
    expect((await connector.listObjects(context)).map((object) => object.name)).toEqual(['items']);
    expect(paths.map((url) => url.pathname)).toEqual([
      '/account/us',
      `/items/${encodeURIComponent(account)}`,
    ]);
    expect(
      (await connector.preview(context, { kind: 'object', object: { schema: null, name: 'items' } }, 1)).rows,
    ).toHaveLength(1);
    expect(paths.map((url) => url.pathname)).toEqual([
      '/account/us',
      `/items/${encodeURIComponent(account)}`,
      '/account/us',
      `/items/${encodeURIComponent(account)}`,
    ]);
    expect([...paths.at(-1)!.searchParams]).toEqual([
      ['region', 'us'],
      ['account', account],
    ]);
    expect([...paths[1]!.searchParams]).toEqual([
      ['region', 'us'],
      ['account', account],
    ]);
  });

  it.each(['deadline', 'caller'] as const)(
    'stops permission inspection between paced requests when the %s ends it',
    async (reason) => {
      const controller = new AbortController();
      let requests = 0;
      const network: FileNetwork = {
        allowsAddress: () => true,
        check: async () => ({ address: '127.0.0.1', family: 4 }),
        async request(request) {
          requests++;
          if (reason === 'caller') controller.abort();
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
      const preset: AppPreset = {
        ...fake,
        objects: ['first', 'second', 'third'].map((name) => ({
          ...fake.objects[0]!,
          name,
          endpoint: RestEndpoint.parse({ name, path: `/${name}`, records: 'data' }),
        })),
      };
      const source = createAppConnector({ network, deadlineMs: 50 }, [preset]);
      await expect(
        source.listObjects({
          connection: {
            kind: 'app',
            app: 'example',
            settings: { account: `https://${randomBytes(8).toString('hex')}.example.test`, region: 'us' },
          },
          secrets: { password: randomBytes(24).toString('hex') },
          signal: controller.signal,
          timeoutMs: 1_000,
        }),
      ).rejects.toBeInstanceOf(ConnectorError);
      expect(requests).toBe(1);
    },
  );
});
