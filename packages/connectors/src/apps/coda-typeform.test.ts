import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppConnection } from '@riosoma/contracts';
import type { FileNetwork } from '../files/network.js';
import type { ConnectorContext } from '../types.js';
import { createAppConnector } from './connector.js';
import { coda } from './coda.js';
import { typeform } from './typeform.js';
import { recordProjection } from './records.js';

const select = (name: string) => ({ kind: 'object', object: { schema: null, name } }) as const;

describe('Coda and Typeform presets', () => {
  it('keeps regional hosts fixed, signs GET requests, and declares conservative rates', async () => {
    const token = randomBytes(24).toString('hex');
    const requests: Array<{ url: URL; method: string; signed: boolean }> = [];
    const network: FileNetwork = {
      allowsAddress: () => true,
      check: async () => ({ address: '127.0.0.1', family: 4 }),
      async request(request) {
        requests.push({
          url: request.url,
          method: request.method,
          signed: request.headers.authorization === `Bearer ${token}`,
        });
        return {
          status: 200,
          headers: {},
          url: request.url,
          body: (async function* () {
            yield Buffer.from(JSON.stringify({ items: [], page_count: 0 }));
          })(),
          close() {},
        };
      },
    };
    const connector = createAppConnector({ network }, [coda, typeform]);
    for (const [app, settings, name] of [
      ['coda', {}, 'docs'],
      ['typeform', {}, 'forms'],
      ['typeform', { region: 'default' }, 'forms'],
      ['typeform', { region: 'eu' }, 'workspaces'],
      ['typeform', { region: 'eu-new' }, 'workspaces'],
    ] as const) {
      const ctx: ConnectorContext = {
        connection: AppConnection.parse({ kind: 'app', app, settings }),
        secrets: { token },
      };
      expect((await connector.preview(ctx, select(name), 3)).rows).toEqual([]);
    }
    expect(requests.map((request) => request.url.origin)).toEqual([
      'https://coda.io',
      'https://api.typeform.com',
      'https://api.typeform.com',
      'https://api.eu.typeform.com',
      'https://api.typeform.eu',
    ]);
    expect(requests[0]!.url.pathname).toBe('/apis/v1/docs');
    expect(requests[0]!.url.searchParams.get('limit')).toBe('100');
    expect(
      requests
        .slice(1)
        .every(
          (request) =>
            request.url.searchParams.get('page_size') === '200' &&
            request.url.searchParams.get('page') === '1',
        ),
    ).toBe(true);
    expect(
      requests.every(
        (request) => request.method === 'GET' && request.signed && !request.url.href.includes(token),
      ),
    ).toBe(true);
    expect(coda.target.requestsPerSecond).toBe(0.5);
    expect(typeform.target.requestsPerSecond).toBe(1);
    expect(typeform.discoveries![0]!.object!.endpoint.paging).toEqual({
      style: 'last-record',
      cursorPath: 'token',
      param: 'before',
      size: 1_000,
      sizeParam: 'page_size',
    });
  });

  it('stops a full last page at the declared page count', async () => {
    const pages: string[] = [];
    const network: FileNetwork = {
      allowsAddress: () => true,
      check: async () => ({ address: '127.0.0.1', family: 4 }),
      async request(request) {
        const page = request.url.searchParams.get('page')!;
        pages.push(page);
        return {
          status: 200,
          headers: {},
          url: request.url,
          body: (async function* () {
            yield Buffer.from(
              JSON.stringify({
                items: Array.from({ length: 200 }, (_, i) => ({ id: `${page}-${i}` })),
                page_count: 3,
              }),
            );
          })(),
          close() {},
        };
      },
    };
    const connector = createAppConnector({ network }, [
      { ...typeform, target: { ...typeform.target, requestsPerSecond: 100 } },
    ]);
    const ctx: ConnectorContext = {
      connection: { kind: 'app', app: 'typeform', settings: {} },
      secrets: { token: randomBytes(24).toString('hex') },
    };
    let count = 0;
    for await (const batch of connector.read(ctx, select('workspaces'), {
      columns: ['id'],
      types: { id: 'text' },
      keyColumns: ['id'],
      batchSize: 100,
    }))
      count += batch.length;
    expect(count).toBe(600);
    expect(pages).toEqual(['1', '2', '3']);
  });

  it('keeps long duplicate question labels unique and rejects unknown or duplicate question IDs', () => {
    const object = typeform.discoveries![0]!.object!;
    const projection = object.projection!;
    const long = 'x'.repeat(300);
    const definitions = {
      fields: [
        { id: 'one', title: long },
        { id: 'two', title: long },
        { id: 'three', title: 'response_id' },
      ],
    };
    const project = recordProjection(projection, object.endpoint, definitions);
    expect(project.columns).toEqual([
      'response_id',
      'token',
      'landed_at',
      'submitted_at',
      'calculated.score',
      long.slice(0, 255),
      'response_id (2)',
      `${long.slice(0, 251)} (2)`,
    ]);
    for (const answers of [
      [{ field: { id: 'missing' }, type: 'text', text: 'Example' }],
      [{ field: { id: 'one' }, type: 'unknown', unknown: 'Example' }],
      [
        { field: { id: 'one' }, type: 'text' },
        { field: { id: 'one' }, type: 'text' },
      ],
      {},
    ])
      expect(() => project({ items: [{ response_id: 'r1', answers }] })).toThrowError(
        expect.objectContaining({ messageKey: 'sources.app.records' }),
      );
    expect(() =>
      recordProjection(projection, object.endpoint, { fields: [{ id: 'one' }, { id: 'one' }] }),
    ).toThrowError(expect.objectContaining({ messageKey: 'sources.app.records' }));
  });

  it('validates Typeform region choices with their own message and rejects undeclared Coda settings', () => {
    for (const settings of [
      {},
      { region: '' },
      { region: 'default' },
      { region: 'eu' },
      { region: 'eu-new' },
    ])
      expect(AppConnection.safeParse({ kind: 'app', app: 'typeform', settings }).success).toBe(true);
    for (const region of ['EU', 'other', 'https://api.eu.typeform.com', 1, null, {}, ['eu']])
      expect(
        AppConnection.safeParse({ kind: 'app', app: 'typeform', settings: { region } }).error?.issues[0]
          ?.message,
      ).toBe('sources.app.typeform.regionInvalid');
    expect(
      AppConnection.safeParse({ kind: 'app', app: 'coda', settings: { region: 'eu' } }).error?.issues[0]
        ?.message,
    ).toBe('sources.app.undeclaredSetting');
  });

  it('uses each payment question’s currency when an answer omits it and keeps explicit currencies', () => {
    const object = typeform.discoveries![0]!.object!;
    const project = recordProjection(object.projection!, object.endpoint, {
      fields: [
        { id: 'b', title: 'Payment', properties: { currency: 'EUR' } },
        {
          id: 'group',
          properties: {
            fields: [{ id: 'a', title: 'Payment', properties: { currency: 'USD' } }],
          },
        },
        { id: 'c', title: 'No currency' },
      ],
    });
    const projected = project({
      items: [
        {
          response_id: 'r1',
          answers: [
            { field: { id: 'b' }, type: 'payment', payment: { amount: 0 } },
            { field: { id: 'a' }, type: 'payment', payment: { amount: 12 } },
            { field: { id: 'c' }, type: 'payment', payment: { amount: 5 } },
          ],
        },
        {
          response_id: 'r2',
          answers: [{ field: { id: 'a' }, type: 'payment', payment: { amount: 20, currency: 'CAD' } }],
        },
      ],
    }) as { items: Array<Record<string, unknown>> };
    expect(projected.items[0]).toMatchObject({
      Payment: '12 USD',
      'Payment (2)': '0 EUR',
      'No currency': '5',
    });
    expect(projected.items[1]).toMatchObject({ Payment: '20 CAD', 'Payment (2)': null });
  });

  it('prefers a choice label and preserves direct column values for the shared type rules', () => {
    const object = typeform.discoveries![0]!.object!;
    const projected = recordProjection(object.projection!, object.endpoint, {
      fields: [{ id: 'choice', title: 'Choice' }],
    })({
      items: [
        {
          response_id: 'r1',
          answers: [
            { field: { id: 'choice' }, type: 'choice', choice: { label: 'Selected', other: 'Other' } },
          ],
        },
      ],
    }) as { items: Array<Record<string, unknown>> };
    expect(projected.items[0]!.Choice).toBe('Selected');
    const table = coda.discoveries![0]!.discoveries![0]!.object!;
    const value = { nested: 'value' };
    const rows = recordProjection(table.projection!, table.endpoint, {
      items: [{ id: 'column', name: 'Column' }],
    })({ items: [{ id: 'r1', values: { Column: value } }] }) as { items: Array<Record<string, unknown>> };
    expect(rows.items[0]!.Column).toEqual(value);
  });
});
