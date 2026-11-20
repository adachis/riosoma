import { randomBytes } from 'node:crypto';
import { RestConnection, type RestAuth, type SourceSecrets } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import type { FileNetwork, FileRequest } from '../files/network.js';
import type { ConnectorContext } from '../types.js';
import { createRestConnector } from './connector.js';

const select = { kind: 'object', object: { schema: null, name: 'items' } } as const;
const fresh = () => randomBytes(24).toString('hex');
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
function context(
  auth: RestAuth,
  secrets: SourceSecrets,
  paging: unknown = { style: 'none' },
): ConnectorContext {
  return {
    secrets,
    connection: RestConnection.parse({
      kind: 'rest',
      baseUrl: 'https://api.example.test',
      auth,
      requestsPerSecond: 100,
      endpoints: [{ name: 'items', path: '/items', records: 'items', paging }],
    }),
  };
}

describe('API source frame extensions', () => {
  it.each([
    { start: 0, pages: [0, 1, 2] },
    { start: 1, pages: [1, 2, 3] },
    { start: 2, pages: [2, 3] },
    { start: 3, pages: [3] },
  ])('stops at the reported page count when starting at page $start', async ({ start, pages }) => {
    const requested: number[] = [];
    const connector = createRestConnector({
      network: networkFor((request) => {
        const page = Number(request.url.searchParams.get('page'));
        requested.push(page);
        if (page > (start === 0 ? 2 : 3)) return { status: 400, body: { code: 'PAGE_OUT_OF_RANGE' } };
        return { body: { items: [{ id: `page-${page}` }], page_count: 3 } };
      }),
    });
    const ctx = context({ method: 'none' }, {}, { style: 'page', start, size: 1, countPath: 'page_count' });
    const records = [];
    for await (const page of connector.records(ctx, select)) records.push(...page);
    expect(requested).toEqual(pages);
    expect(records.map((record) => (record as { id: string }).id)).toEqual(
      pages.map((page) => `page-${page}`),
    );
  });

  it('sends a scheme before a header key and can send the sealed value as the basic user name', async () => {
    const secret = fresh();
    for (const auth of [
      { method: 'header', name: 'Authorization', prefix: 'SSWS ' },
      { method: 'basic', user: 'X', secretAsUsername: true },
    ] as const) {
      let signed = false;
      const connector = createRestConnector({
        network: networkFor((request) => {
          const header = request.headers.Authorization ?? request.headers.authorization;
          signed =
            auth.method === 'header'
              ? header === `SSWS ${secret}`
              : header === `Basic ${Buffer.from(`${secret}:X`).toString('base64')}`;
          return { body: { items: [{ id: 'one' }] } };
        }),
      });
      await connector.preview(context(auth, { apiKey: secret, password: secret }), select, 1);
      expect(signed).toBe(true);
    }
  });

  it.each(['client_credentials', 'account_credentials', 'refresh_token'] as const)(
    'exchanges, caches, and renews the %s grant with its declared form values',
    async (grant) => {
      const secret = fresh();
      const refreshToken = fresh();
      const access = [fresh(), fresh(), fresh()];
      let tokens = 0;
      let signed = true;
      let reject = false;
      let now = 0;
      const connector = createRestConnector({
        now: () => now,
        network: networkFor((request) => {
          if (request.url.pathname === '/token') {
            const form = new URLSearchParams(request.body);
            signed &&=
              request.method === 'POST' &&
              form.get('grant_type') === grant &&
              form.get('account_id') === 'workspace';
            signed &&=
              grant === 'refresh_token'
                ? form.get('refresh_token') === refreshToken
                : !form.has('refresh_token');
            signed &&=
              grant === 'account_credentials'
                ? request.headers.authorization ===
                  `Basic ${Buffer.from(`client:${secret}`).toString('base64')}`
                : form.get('client_id') === 'client' && form.get('client_secret') === secret;
            return { body: { access_token: access[tokens++], expires_in: 120 } };
          }
          signed &&=
            request.method === 'GET' && request.headers.authorization === `Bearer ${access[tokens - 1]}`;
          if (reject) {
            reject = false;
            return { status: 401, body: {} };
          }
          return { body: { items: [{ id: 'one' }] } };
        }),
      });
      const ctx = context(
        {
          method: 'oauth-client',
          tokenUrl: 'https://accounts.example.test/token',
          clientId: 'client',
          clientAuth: grant === 'account_credentials' ? 'basic' : 'body',
          grant,
          tokenParams: { account_id: 'workspace' },
        },
        { clientSecret: secret, refreshToken },
      );
      await connector.preview(ctx, select, 1);
      await connector.preview(ctx, select, 1);
      expect(tokens).toBe(1);
      reject = true;
      await connector.preview(ctx, select, 1);
      expect(tokens).toBe(2);
      now = 121_000;
      await connector.preview(ctx, select, 1);
      expect(tokens).toBe(3);
      expect(signed).toBe(true);
    },
  );

  it('pages from the last record, encodes the cursor, and stops at a short page', async () => {
    const cursors: (string | null)[] = [];
    const connector = createRestConnector({
      network: networkFor((request) => {
        expect(request.url.searchParams.get('page_size')).toBe('2');
        const cursor = request.url.searchParams.get('before');
        cursors.push(cursor);
        return {
          body: {
            items:
              cursor === null
                ? [
                    { id: 'one', token: 'first' },
                    { id: 'two', token: 'a/b?c &d' },
                  ]
                : [{ id: 'three', token: 'last' }],
          },
        };
      }),
    });
    const ctx = context(
      { method: 'none' },
      {},
      { style: 'last-record', cursorPath: 'token', param: 'before', size: 2, sizeParam: 'page_size' },
    );
    const records = [];
    for await (const page of connector.records(ctx, select)) records.push(...page);
    expect(records).toHaveLength(3);
    expect(cursors).toEqual([null, 'a/b?c &d']);
  });

  it.each(['missing', 'repeated'])('refuses a %s last-record cursor without looping', async (kind) => {
    let calls = 0;
    const connector = createRestConnector({
      network: networkFor(() => {
        calls++;
        return { body: { items: [{ id: calls, ...(kind === 'repeated' ? { token: 'same' } : {}) }] } };
      }),
    });
    const ctx = context(
      { method: 'none' },
      {},
      { style: 'last-record', cursorPath: 'token', param: 'before', size: 1 },
    );
    await expect(
      (async () => {
        for await (const page of connector.records(ctx, select)) void page;
      })(),
    ).rejects.toMatchObject({ messageKey: 'sources.rest.pagingLoop' });
    expect(calls).toBe(kind === 'missing' ? 1 : 2);
  });
});
