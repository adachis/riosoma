import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FeedKey, UpdateRelease } from '@riosoma/contracts';

/** Stand-ins for the hub and the updater sidecar, on 127.0.0.1, for the update and usage count tests. */

export interface SigningKey extends FeedKey {
  privateKey: KeyObject;
}

/** A stand-in signing key, made fresh for each test run and never written anywhere */
export function signingKey(id: string): SigningKey {
  const pair = generateKeyPairSync('ed25519');
  return { id, publicKey: pair.publicKey.export({ format: 'jwk' }).x!, privateKey: pair.privateKey };
}

export const DAY = 24 * 60 * 60_000;

export function release(version: string, extra: Partial<UpdateRelease> = {}): UpdateRelease {
  return {
    version,
    date: '2026-09-28',
    notes: `What’s new in ${version}`,
    security: false,
    minimumVersion: '0.0.1',
    images: {
      'linux/amd64': `sha256:${'a'.repeat(64)}`,
      'linux/arm64': `sha256:${'b'.repeat(64)}`,
    },
    ...extra,
  };
}

/** A feed as the hub will serve it: the payload's exact text, and a signature over its bytes */
export function signFeed(key: SigningKey, releases: UpdateRelease[], issuedAt = new Date()): string {
  const payload = JSON.stringify({ schema: 1, issuedAt: issuedAt.toISOString(), releases });
  const signature = sign(null, Buffer.from(payload, 'utf8'), key.privateKey).toString('base64');
  return JSON.stringify({ keyId: key.id, signature, payload });
}

type Answer = { status: number; body: unknown } | null;

/**
 * A server on 127.0.0.1 answering with `handle`, and the address it listens on.  An answer of null
 * drops the connection without a word, the way a request that times out looks to its sender.
 */
export async function standIn(
  handle: (request: IncomingMessage, body: string) => Answer | Promise<Answer>,
): Promise<{
  url: string;
  requests: Array<{ method: string; path: string; headers: IncomingMessage['headers']; body: string }>;
  close(): Promise<void>;
}> {
  const requests: Array<{ method: string; path: string; headers: IncomingMessage['headers']; body: string }> =
    [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        headers: request.headers,
        body,
      });
      void Promise.resolve(handle(request, body)).then((answer) => {
        if (!answer) return response.destroy();
        const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(text);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
