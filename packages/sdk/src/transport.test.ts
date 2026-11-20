import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { RioApiError, RioClient, RioClientError, type FetchInit } from './index.js';
import { startApiServer, type TestApiServer } from './test/server.js';

/**
 * How the transport behaves when a server is slow, busy, or wrong.  A rate limit is the API's own
 * answer to a caller that went too fast, and a client that ignores it makes the problem worse, so
 * these tests stand a proxy in front of the real server and make it refuse a few requests the way
 * the server does: with a 429 and a `Retry-After`.
 */

let api: TestApiServer;

beforeAll(async () => {
  api = await startApiServer({ prefix: 'sdkhttp' });
}, 120_000);

afterAll(async () => {
  await api?.close();
});

/** A proxy in front of the real server, which refuses as many requests as a test tells it to. */
interface StandIn {
  baseUrl: string;
  /** How many more requests it answers with a rate limit instead of forwarding */
  refuse: number;
  /** The `Retry-After` it sends with a refusal, or none */
  retryAfter: string | null;
  /** What it answered instead of forwarding, for a test of an answer nothing can read */
  answer: { status: number; body: string; type: string } | null;
  requests: Array<{ method: string; url: string; authorization: string | null }>;
  close(): Promise<void>;
}

async function startStandIn(target: string): Promise<StandIn> {
  const standIn: StandIn = {
    baseUrl: '',
    refuse: 0,
    retryAfter: '0',
    answer: null,
    requests: [],
    close: async () => undefined,
  };
  const listener: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = request.url ?? '/';
      const authorization = (request.headers.authorization as string | undefined) ?? null;
      standIn.requests.push({ method: request.method ?? 'GET', url, authorization });
      const body = Buffer.concat(chunks);
      const answer = async () => {
        if (standIn.refuse > 0) {
          standIn.refuse -= 1;
          response.writeHead(
            429,
            standIn.retryAfter === null
              ? { 'content-type': 'application/json' }
              : { 'retry-after': standIn.retryAfter, 'content-type': 'application/json' },
          );
          response.end(
            JSON.stringify({
              error: { code: 'rate_limited', messageKey: 'errors.rateLimited', message: 'Slow down.' },
            }),
          );
          return;
        }
        if (standIn.answer) {
          response.writeHead(standIn.answer.status, { 'content-type': standIn.answer.type });
          response.end(standIn.answer.body);
          return;
        }
        const forwarded = await fetch(`${target}${url}`, {
          method: request.method,
          headers: {
            ...(authorization ? { authorization } : {}),
            ...(request.headers['content-type'] ? { 'content-type': request.headers['content-type'] } : {}),
          },
          ...(body.length ? { body } : {}),
        });
        const headers: Record<string, string> = {};
        for (const name of ['content-type', 'retry-after', 'x-undo-group-id', 'www-authenticate']) {
          const value = forwarded.headers.get(name);
          if (value) headers[name] = value;
        }
        response.writeHead(forwarded.status, headers);
        response.end(await forwarded.text());
      };
      void answer().catch(() => response.destroy());
    });
  });
  await new Promise<void>((settle) => listener.listen(0, '127.0.0.1', settle));
  const port = (listener.address() as AddressInfo).port;
  standIn.baseUrl = `http://127.0.0.1:${port}`;
  standIn.close = async () => {
    listener.closeAllConnections();
    await new Promise<void>((settle) => listener.close(() => settle()));
  };
  return standIn;
}

let standIn: StandIn | null = null;
afterEach(async () => {
  await standIn?.close();
  standIn = null;
});

/** A wait that records what it was asked for and costs the test nothing. */
function recordedSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

const path = () => `/api/v1/tables/${api.tableId}/records`;

describe('a rate limit', () => {
  it('waits as long as the answer asks, then gets the records', async () => {
    standIn = await startStandIn(api.baseUrl);
    standIn.refuse = 2;
    const { waits, sleep } = recordedSleep();
    const client = new RioClient({ baseUrl: standIn.baseUrl, token: api.token, sleep });
    const page = await client.records.list(api.tableId, { pageSize: 1 });
    expect(page.records).toBeDefined();
    expect(waits).toEqual([0, 0]);
    expect(standIn.requests.filter((request) => request.url.startsWith(path()))).toHaveLength(3);
  });

  it('reads a `Retry-After` in seconds and in the date form', async () => {
    standIn = await startStandIn(api.baseUrl);
    standIn.refuse = 1;
    standIn.retryAfter = '3';
    const { waits, sleep } = recordedSleep();
    const client = new RioClient({ baseUrl: standIn.baseUrl, token: api.token, sleep });
    await client.databases.list();
    expect(waits).toEqual([3_000]);

    standIn.refuse = 1;
    standIn.retryAfter = new Date(Date.now() + 2_000).toUTCString();
    waits.length = 0;
    await client.databases.list();
    // A date is read to the second it names, which a slow test machine makes a little shorter.
    expect(waits[0]).toBeGreaterThan(0);
    expect(waits[0]).toBeLessThanOrEqual(2_000);
  });

  it('waits longer each time when the answer says nothing about how long', async () => {
    standIn = await startStandIn(api.baseUrl);
    standIn.refuse = 2;
    standIn.retryAfter = null;
    const { waits, sleep } = recordedSleep();
    const client = new RioClient({ baseUrl: standIn.baseUrl, token: api.token, sleep });
    await client.databases.list();
    expect(waits).toEqual([500, 1_000]);
  });

  it('gives up after the tries it was given, and says the call was rate limited', async () => {
    standIn = await startStandIn(api.baseUrl);
    standIn.refuse = 100;
    const { waits, sleep } = recordedSleep();
    const client = new RioClient({ baseUrl: standIn.baseUrl, token: api.token, sleep, retries: 2 });
    const failure = await client.databases.list().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RioApiError);
    expect((failure as RioApiError).status).toBe(429);
    expect((failure as RioApiError).code).toBe('rate_limited');
    expect((failure as RioApiError).retryAfterSeconds).toBe(0);
    expect((failure as RioApiError).retryable).toBe(true);
    expect(waits).toEqual([0, 0]);
    expect(standIn.requests).toHaveLength(3);
  });

  it('hands a caller a wait longer than it will sit through, rather than sitting through it', async () => {
    standIn = await startStandIn(api.baseUrl);
    standIn.refuse = 1;
    standIn.retryAfter = '3600';
    const { waits, sleep } = recordedSleep();
    const client = new RioClient({
      baseUrl: standIn.baseUrl,
      token: api.token,
      sleep,
      maxRetryDelayMs: 1_000,
    });
    const failure = await client.databases.list().catch((error: unknown) => error);
    expect((failure as RioApiError).status).toBe(429);
    expect((failure as RioApiError).retryAfterSeconds).toBe(3_600);
    expect(waits).toEqual([]);
  });
});

describe('an answer nothing can use', () => {
  it('says a server that never answered could not be reached, and keeps the token out of it', async () => {
    const client = new RioClient({ baseUrl: 'http://127.0.0.1:1', token: api.token, retries: 0 });
    const failure = await client.databases.list().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RioClientError);
    expect((failure as RioClientError).code).toBe('unreachable');
    expect((failure as RioClientError).message).not.toContain(api.token);
    expect((failure as RioClientError).message).toContain('127.0.0.1');
  });

  it('says an answer that isn’t JSON can’t be read', async () => {
    standIn = await startStandIn(api.baseUrl);
    standIn.answer = { status: 200, body: '<html>a proxy answered</html>', type: 'text/html' };
    const client = new RioClient({ baseUrl: standIn.baseUrl, token: api.token });
    const failure = await client.databases.list().catch((error: unknown) => error);
    expect((failure as RioClientError).code).toBe('unreadable');
  });

  it('takes a secret the server echoed back out of the error a caller reads', async () => {
    standIn = await startStandIn(api.baseUrl);
    standIn.answer = {
      status: 400,
      body: JSON.stringify({ error: { message: `the token ${api.token} was refused` } }),
      type: 'application/json',
    };
    const client = new RioClient({ baseUrl: standIn.baseUrl, token: api.token });
    const failure = await client.databases.list().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RioApiError);
    expect((failure as RioApiError).message).toContain('[redacted]');
    expect((failure as RioApiError).message).not.toContain(api.token);
  });

  it('sends the credential it was given, and nothing else a caller wouldn’t expect', async () => {
    standIn = await startStandIn(api.baseUrl);
    const client = new RioClient({
      baseUrl: standIn.baseUrl,
      token: api.token,
      headers: { 'x-proxy-key': 'forwarded' },
    });
    await client.databases.list();
    const request = standIn.requests[0]!;
    expect(request.authorization).toBe(`Bearer ${api.token}`);
    expect(request.url).toBe('/api/v1/databases');
  });

  it('keeps a path a proxy needs in front of every route', async () => {
    standIn = await startStandIn(api.baseUrl);
    const client = new RioClient({ baseUrl: `${standIn.baseUrl}/riosoma`, token: api.token });
    // The stand-in forwards whatever path it was given, and the real server has no such prefix, so
    // the answer is a refusal: what matters is the address the request was sent to.
    await client.databases.list().catch(() => undefined);
    expect(standIn.requests[0]!.url).toBe('/riosoma/api/v1/databases');
  });
});

describe('a call a caller stops', () => {
  it('stops waiting when the signal it was given gives up', async () => {
    standIn = await startStandIn(api.baseUrl);
    standIn.refuse = 5;
    // A wait long enough that the cancellation arrives in the middle of it.
    standIn.retryAfter = '30';
    const controller = new AbortController();
    const waits: number[] = [];
    const client = new RioClient({
      baseUrl: standIn.baseUrl,
      token: api.token,
      sleep: async (ms: number, signal?: AbortSignal) => {
        waits.push(ms);
        await new Promise<void>((settle, fail) => {
          const timer = setTimeout(settle, ms);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              fail(new DOMException('cancelled', 'AbortError'));
            },
            { once: true },
          );
        });
      },
    });
    setTimeout(() => controller.abort(), 20);
    const failure = await client.records
      .list(api.tableId, { signal: controller.signal, pageSize: 1 })
      .catch((error: unknown) => error);
    expect((failure as Error).name).toBe('AbortError');
    expect(waits.length).toBeGreaterThan(0);
  });

  it('takes a fetch of its own, which is how a host proxies or measures calls', async () => {
    const seen: Array<{ url: string; init: FetchInit }> = [];
    const client = api.client({
      fetch: (url, init) => {
        seen.push({ url, init });
        return fetch(url, init);
      },
    });
    await client.records.create(api.tableId, [{ fields: { Name: 'Through a caller’s fetch' } }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.init.method).toBe('POST');
    expect(seen[0]!.url).toContain(`/api/v1/tables/${api.tableId}/records`);
  });
});
