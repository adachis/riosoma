import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebhookCreated } from '@riosoma/contracts';
import type { ServerFixture, SignedIn } from '../test/fixture.js';
import type { WebhookWorker } from './worker.js';

export function worker(server: ServerFixture): WebhookWorker {
  if (!server.ctx.webhooks) throw new Error('the webhook worker is not installed');
  return server.ctx.webhooks;
}

export async function createWebhook(
  server: ServerFixture,
  databaseId: string,
  body: Record<string, unknown>,
  who: SignedIn = server.owner,
): Promise<WebhookCreated> {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/webhooks`,
    headers: who.headers,
    payload: body,
  });
  if (response.statusCode !== 200) throw new Error(`webhook failed: ${response.statusCode} ${response.body}`);
  return response.json<WebhookCreated>();
}

export interface Hit {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A local receiver that records every call and answers however the test says. */
export interface Receiver {
  hits: Hit[];
  url(path?: string): string;
  respond: (response: http.ServerResponse, hit: Hit) => void;
  close(): Promise<void>;
}

export async function startReceiver(): Promise<Receiver> {
  const receiver: Receiver = {
    hits: [],
    url: () => '',
    respond: (response) => response.end('ok'),
    close: async () => undefined,
  };
  const listener = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const hit = {
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      receiver.hits.push(hit);
      receiver.respond(response, hit);
    });
  });
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as AddressInfo).port;
  receiver.url = (path = '/hook') => `http://127.0.0.1:${port}${path}`;
  receiver.close = async () => {
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
  };
  return receiver;
}

/**
 * Checks a call's signature the way the documentation tells receivers to: every `v1` in the
 * header is an HMAC-SHA256 of `<t>.<body>`, and any one of them matching the secret is enough.
 */
export function signedBy(header: string | string[] | undefined, secret: string, body: string): boolean {
  if (typeof header !== 'string') return false;
  const parts = header.split(',').map((part) => part.split('=') as [string, string]);
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  if (!timestamp) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'));
  return parts.some(
    ([key, value]) =>
      key === 'v1' && value.length === expected.length && timingSafeEqual(Buffer.from(value), expected),
  );
}
