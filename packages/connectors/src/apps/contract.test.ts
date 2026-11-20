import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { RestEndpoint } from '@riosoma/contracts';
import { createAppConnector } from './connector.js';
import { TEST_PRESETS } from './index.test-support.js';
import type { AppPreset } from './types.js';
import type { ConnectorContext, SourceRow } from '../types.js';
import type { FileNetwork } from '../files/network.js';
import { FixtureBoundary } from '../contract/boundary.test-support.js';
import { strictFixture } from '../contract/strict.test-support.js';

it('runs the app frame through the shared connector contract with paged protocol responses', async () => {
  const fixture = [
    { id: 'one', title: 'First item' },
    { id: 'two', title: 'Second item' },
    { id: 'three', title: 'Third item' },
  ];
  const endpoint = RestEndpoint.parse({
    name: 'items',
    path: '/items',
    records: 'data',
    query: [{ name: 'region', value: '{setting:region}' }],
    paging: { style: 'offset', limit: 1 },
  });
  const original = TEST_PRESETS.find((entry) => entry.catalog.id === 'example')!;
  const object = { name: 'items', key: 'id', endpoint };
  const preset: AppPreset = {
    ...original,
    target: { ...original.target, requestsPerSecond: 100 },
    objects: [object],
    test: object,
  };
  const password = randomBytes(24).toString('hex');
  const ctx: ConnectorContext = {
    connection: {
      kind: 'app',
      app: 'example',
      settings: { account: 'https://customer.example.test', region: 'us' },
    },
    secrets: { password },
    timeoutMs: 1000,
  };
  const offsets: number[] = [];
  const requests: Array<{
    path: string;
    region: string | null;
    authorization: string | null;
    limit: number;
  }> = [];
  const network: FileNetwork = {
    allowsAddress: () => true,
    check: async () => ({ address: '127.0.0.1', family: 4 }),
    async request(request) {
      const offset = Number(request.url.searchParams.get('offset') ?? 0);
      const limit = Number(request.url.searchParams.get('limit'));
      requests.push({
        path: request.url.pathname,
        region: request.url.searchParams.get('region'),
        authorization: new Headers(request.headers).get('authorization'),
        limit,
      });
      offsets.push(offset);
      return {
        status: 200,
        url: request.url,
        headers: {},
        body: (async function* () {
          yield Buffer.from(JSON.stringify({ data: fixture.slice(offset, offset + limit) }));
        })(),
        close() {},
      };
    },
  };
  const boundary = new FixtureBoundary();
  const connector = createAppConnector({ network: boundary.wrap(network) }, [preset]);
  const select = { kind: 'object' as const, object: { schema: null, name: 'items' } };
  const known: SourceRow[] = [];
  for await (const batch of connector.read(ctx, select, {
    columns: ['id', 'title'],
    types: { id: 'text', title: 'text' },
    keyColumns: ['id'],
    batchSize: 1,
  }))
    known.push(...batch);
  expect(requests).toEqual(
    [0, 1, 2, 3].map(() => ({
      path: '/items',
      region: 'us',
      authorization: `Basic ${Buffer.from(`reader:${password}`).toString('base64')}`,
      limit: 1,
    })),
  );
  expect(known).toEqual(fixture.map((row) => ({ key: JSON.stringify([row.id]), values: row })));
  expect(offsets).toEqual([0, 1, 2, 3]);
  expect(await connector.keyCandidates(ctx, select.object)).toEqual([['id']]);
  const result = await strictFixture(connector, ctx, select, ['id'], fixture.length, boundary, (context) =>
    connector.preview(context, select, 1),
  );
  expect(result.connector).toBe('app');
});
