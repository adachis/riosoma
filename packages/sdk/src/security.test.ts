import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { RioClient, verifyWebhookSignature, type FetchLike, refreshAccessToken } from './index.js';

const baseUrl = 'https://127.0.0.1';
const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('credential boundaries', () => {
  it.each([
    '//127.0.0.2/records',
    '/\\127.0.0.2/records',
    '\\127.0.0.2/records',
    'https://127.0.0.2/records',
    'https://127.0.0.1/records',
    '/\t/127.0.0.2',
    '/../records',
    '/%2e%2e/records',
    ' /records',
    '/records#fragment',
  ])('rejects unsafe route %j before sending a credential', async (path) => {
    for (const prefix of ['', '/proxy']) {
      const fetch = vi.fn<FetchLike>(async () => reply(200));
      const client = new RioClient({ baseUrl: baseUrl + prefix, token: randomUUID(), fetch });
      await expect(client.request('GET', path)).rejects.toMatchObject({ code: 'invalid_options' });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('keeps valid routes and query parameters on the configured base', async () => {
    const fetch = vi.fn<FetchLike>(async () => reply(200));
    const client = new RioClient({ baseUrl: baseUrl + '/proxy', token: randomUUID(), fetch });
    await client.request('GET', 'api/v1/records', { query: { fields: ['First name', 'Amount'] } });
    const url = new URL(fetch.mock.calls[0]![0] as string);
    expect(url.origin).toBe(baseUrl);
    expect(url.pathname).toBe('/proxy/api/v1/records');
    expect(url.searchParams.getAll('fields')).toEqual(['First name', 'Amount']);
  });

  it('keeps API bodies and refresh tokens away from a redirect target', async () => {
    let received = 0;
    const target = createServer((_request, response) => {
      received += 1;
      response.end('{}');
    });
    const listen = async (server: Server) => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    const destination = await listen(target);
    const source = createServer((_request, response) => {
      response.writeHead(307, { location: destination });
      response.end();
    });
    try {
      const baseUrl = await listen(source);
      const client = new RioClient({ baseUrl, token: randomUUID() });
      await expect(
        client.request('POST', '/records', { body: { value: randomUUID() } }),
      ).rejects.toMatchObject({ code: 'unreachable' });
      await expect(
        refreshAccessToken({ baseUrl, clientId: randomUUID(), refreshToken: randomUUID() }),
      ).rejects.toMatchObject({ code: 'unreachable' });
      expect(received).toBe(0);
    } finally {
      for (const server of [source, target]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
});

describe('shared OAuth refresh', () => {
  it.each([false, true])('refreshes once when a second refusal is delayed: %s', async (delayed) => {
    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const tokens = { access_token: randomUUID(), refresh_token: randomUUID(), expires_in: 3600 };
    const both = deferred<void>();
    const refreshed = deferred<void>();
    let calls = 0;
    let refreshes = 0;
    const fetch: FetchLike = async (url, init) => {
      if (url.endsWith('/oauth/token')) {
        refreshes += 1;
        expect(new URLSearchParams(init.body).get('refresh_token')).toBe(refreshToken);
        return reply(200, tokens);
      }
      if (init.headers.authorization === `Bearer ${accessToken}`) {
        calls += 1;
        if (calls === 2) both.resolve();
        const second = calls === 2;
        await both.promise;
        if (second && delayed) await refreshed.promise;
        return reply(401);
      }
      expect(init.headers.authorization).toBe(`Bearer ${tokens.access_token}`);
      return reply(200, { ok: true });
    };
    const onTokens = vi.fn(() => {
      refreshed.resolve();
    });
    const client = new RioClient({
      baseUrl,
      accessToken,
      refreshToken,
      clientId: randomUUID(),
      fetch,
      onTokens,
    });
    const results = await Promise.all([client.request('GET', '/first'), client.request('GET', '/second')]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(refreshes).toBe(1);
    expect(onTokens).toHaveBeenCalledTimes(1);
  });

  it('keeps rate limit retries available after refreshing', async () => {
    let calls = 0;
    const fetch: FetchLike = async (url) => {
      if (url.endsWith('/oauth/token')) return reply(200, { access_token: randomUUID() });
      calls += 1;
      return calls === 1 ? reply(401) : calls === 2 ? reply(429, {}, { 'retry-after': '0' }) : reply(200);
    };
    const sleep = vi.fn(async () => undefined);
    const client = new RioClient({
      baseUrl,
      accessToken: randomUUID(),
      refreshToken: randomUUID(),
      clientId: randomUUID(),
      retries: 1,
      fetch,
      sleep,
    });
    await expect(client.request('GET', '/records')).resolves.toEqual({});
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe('raw webhook bytes', () => {
  it('authenticates the exact bytes including a byte order mark and invalid UTF-8', async () => {
    const secret = randomUUID();
    const timestamp = Math.floor(Date.now() / 1000);
    const plain = Buffer.from('{"id":"delivery"}');
    const signed = (payload: Uint8Array) =>
      `t=${timestamp},v1=${createHmac('sha256', secret)
        .update(`${timestamp}.`)
        .update(payload)
        .digest('hex')}`;
    const altered = Buffer.concat([Buffer.from([239, 187, 191]), plain]);
    expect(
      await verifyWebhookSignature({ payload: altered, signature: signed(plain), secret }),
    ).toMatchObject({ valid: false });
    for (const payload of [altered, Buffer.from([255, 254, 128])]) {
      expect(await verifyWebhookSignature({ payload, signature: signed(payload), secret })).toMatchObject({
        valid: true,
      });
    }
  });
});
