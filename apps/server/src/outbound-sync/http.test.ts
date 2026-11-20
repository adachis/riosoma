import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RateLimiter, type Clock } from '../data/imports/core/clock.js';
import { systemResolve } from '../automations/outbound.js';
import { createOutboundHttp } from './http.js';
import { DestinationError, type DestinationAdapter, type OutboundRequest } from './destination.js';

/**
 * The guarded HTTP layer: a 429 pauses and tries again for any method, a 5xx tries an idempotent
 * request again and fails another as unconfirmed, a dropped connection is unconfirmed only when the
 * request wasn't idempotent, and a credential never reaches a thrown problem.
 */

const TOKEN = 'pat-secret-value-123';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let base: string;
let handler: Handler;
let hits: number;

beforeEach(async () => {
  hits = 0;
  handler = (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  server = createServer((req, res) => {
    hits += 1;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
});

function fakeClock(): Clock {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const adapter = {
  kind: 'airtable',
  pacing: { perSecond: 100, waitMs: 1000, key: () => 'k' },
  address: () => base,
  headers: (credential: { token: string }) => ({ authorization: `Bearer ${credential.token}` }),
  secrets: (credential: { token: string }) => [credential.token],
  problem: (status: number, body: unknown) => {
    const quota = (body as { error?: { type?: string } } | null)?.error?.type === 'QUOTA';
    if (status === 429)
      return quota
        ? { messageKey: 'quota', scope: 'sync' as const }
        : { messageKey: 'rate', scope: 'run' as const };
    return { messageKey: `echoed ${JSON.stringify(body)}`, scope: 'sync' as const };
  },
} as unknown as DestinationAdapter;

function http(clock: Clock = fakeClock()) {
  return createOutboundHttp({
    adapter,
    where: { kind: 'airtable' } as never,
    credential: { token: TOKEN },
    address: base,
    limiter: new RateLimiter(clock, adapter.pacing.perSecond),
    clock,
    resolve: systemResolve,
    allowPrivate: () => true,
    signal: new AbortController().signal,
  });
}

const req = (over: Partial<OutboundRequest<unknown>> = {}): OutboundRequest<unknown> => ({
  method: 'GET',
  path: '/thing',
  schema: z.object({}).passthrough(),
  idempotent: true,
  ...over,
});

describe('outbound http', () => {
  it('retries a 429 for any method, then succeeds', async () => {
    let seen = 0;
    handler = (_req, res) => {
      seen += 1;
      if (seen < 3)
        return res.writeHead(429, { 'retry-after': '1' }).end(JSON.stringify({ error: { type: 'RATE' } }));
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    };
    const result = await http().send(req({ method: 'PATCH', idempotent: true }));
    expect(result).toEqual({ ok: true });
    expect(seen).toBe(3);
  });

  it('throws a quota 429 at once, without retrying', async () => {
    handler = (_req, res) => res.writeHead(429).end(JSON.stringify({ error: { type: 'QUOTA' } }));
    await expect(http().send(req())).rejects.toMatchObject({
      problem: { messageKey: 'quota', scope: 'sync' },
    });
    expect(hits).toBe(1);
  });

  it('retries a 5xx for an idempotent request and fails another as unconfirmed', async () => {
    handler = (_req, res) => res.writeHead(500).end('{}');
    await expect(http().send(req({ idempotent: true }))).rejects.toMatchObject({
      problem: { messageKey: 'syncOut.destination.unavailable' },
      unconfirmed: false,
    });
    const before = hits;
    expect(before).toBe(6);
    await expect(http().send(req({ method: 'POST', idempotent: false }))).rejects.toMatchObject({
      problem: { messageKey: 'syncOut.destination.unconfirmed' },
      unconfirmed: true,
    });
    // A non-idempotent 5xx isn't tried again.
    expect(hits - before).toBe(1);
  });

  it('marks a dropped connection unconfirmed only when the request wasn’t idempotent', async () => {
    handler = (_req, res) => {
      res.socket?.destroy();
    };
    await expect(http().send(req({ method: 'POST', idempotent: false }))).rejects.toMatchObject({
      problem: { messageKey: 'syncOut.destination.unconfirmed' },
      unconfirmed: true,
    });
  });

  it('never marks a connection that could not be made unconfirmed', async () => {
    const dead = createOutboundHttp({
      adapter,
      where: { kind: 'airtable' } as never,
      credential: { token: TOKEN },
      // Nothing listens here, so the connection is refused before anything is sent.
      address: 'http://127.0.0.1:1',
      limiter: new RateLimiter(fakeClock(), 100),
      clock: fakeClock(),
      resolve: systemResolve,
      allowPrivate: () => true,
      signal: new AbortController().signal,
    });
    await expect(dead.send(req({ method: 'POST', idempotent: false }))).rejects.toMatchObject({
      problem: { messageKey: 'syncOut.destination.unreachable' },
      unconfirmed: false,
    });
  });

  it('answers an unreadable body with unreadable', async () => {
    handler = (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"wrong":1}');
    await expect(http().send(req({ schema: z.object({ needed: z.string() }) }))).rejects.toMatchObject({
      problem: { messageKey: 'syncOut.destination.unreadable' },
    });
  });

  it('keeps the credential out of a thrown problem', async () => {
    // The service echoes the token in its error, as some do; it must never reach the problem.
    handler = (_req, res) =>
      res.writeHead(400).end(JSON.stringify({ error: { type: 'BAD', message: `token ${TOKEN} refused` } }));
    let error: DestinationError | undefined;
    try {
      await http().send(req());
    } catch (thrown) {
      error = thrown as DestinationError;
    }
    expect(error).toBeInstanceOf(DestinationError);
    expect(JSON.stringify(error!.problem)).not.toContain(TOKEN);
  });
});
