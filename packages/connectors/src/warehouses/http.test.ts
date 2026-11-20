/**
 * How Trino and Druid reach their servers: the private-network rule the server holds
 * them to, through a guard that checks every host, and the start of an error's body kept as plain
 * text.  Each test runs a stand-in server on this machine and checks whether anything reached it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SourceConnection } from '@riosoma/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { FileNetworkError } from '../files/network.js';
import type { Connector, ConnectorContext } from '../types.js';
import { createDruidConnector } from './druid.js';
import { bodyExcerpt, type HostGuard } from './http.js';
import { createTrinoConnector } from './trino.js';

type Answer = (request: IncomingMessage, body: string, response: ServerResponse) => void;

const servers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()));
});

/** A server on this machine that answers as told and remembers every request that reached it. */
async function standIn(answer: Answer) {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      seen.push(`${request.method} ${request.url}`);
      answer(request, body, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as AddressInfo).port, seen };
}

/** The rule as a server in production keeps it: every name here is on a private network. */
const REFUSING: HostGuard = {
  lookup: async (hostname) => {
    throw new FileNetworkError('blocked', `${hostname} is on a private network`);
  },
  allowsAddress: () => false,
};

/** A rule that lets the name through, to the one address it checked. */
function allowing(looked: string[]): HostGuard {
  return {
    lookup: async (hostname) => {
      looked.push(hostname);
      return [{ address: '127.0.0.1', family: 4 }];
    },
    allowsAddress: () => true,
  };
}

function contextFor(kind: 'trino' | 'druid', host: string, port: number): ConnectorContext {
  const connection: SourceConnection =
    kind === 'trino'
      ? { kind, host, port, catalog: 'memory', user: 'reader', auth: 'none', secure: false }
      : { kind, host, port, secure: false };
  return { connection, secrets: {}, timeoutMs: 5_000 };
}

const ENGINES: Array<['trino' | 'druid', (hostGuard: HostGuard) => Connector]> = [
  ['trino', (hostGuard) => createTrinoConnector({ hostGuard })],
  ['druid', (hostGuard) => createDruidConnector({ hostGuard })],
];

describe('the private-network rule', () => {
  it.each(ENGINES)(
    'fails a %s test on a private name at its first step, before anything connects',
    async (kind, make) => {
      const server = await standIn((_request, _body, response) => response.end());
      const result = await make(REFUSING).test(contextFor(kind, 'localhost', server.port));
      expect(result.ok).toBe(false);
      expect(result.steps).toEqual([
        expect.objectContaining({
          step: 'resolve',
          status: 'failed',
          messageKey: 'sources.analytics.blocked',
          detail: 'localhost is on a private network',
        }),
      ]);
      expect(server.seen).toEqual([]);
    },
  );

  it.each(ENGINES)(
    'refuses a %s read of a private name, and one written as an address',
    async (kind, make) => {
      const server = await standIn((_request, _body, response) => response.end());
      for (const host of ['localhost', '127.0.0.1'])
        await expect(make(REFUSING).listObjects(contextFor(kind, host, server.port))).rejects.toMatchObject({
          messageKey: 'sources.analytics.blocked',
        });
      expect(server.seen).toEqual([]);
    },
  );

  it('connects to the address the rule checked when it allows the name', async () => {
    const server = await standIn((request, body, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          /version/.test(body)
            ? { id: 'q2', columns: [{ name: 'version', type: 'varchar' }], data: [['479']] }
            : /SHOW SCHEMAS/.test(body)
              ? { id: 'q3', columns: [{ name: 'Schema', type: 'varchar' }], data: [['default']] }
              : { id: 'q1', columns: [{ name: 'signed_in', type: 'integer' }], data: [[1]] },
        ),
      );
      void request;
    });
    const looked: string[] = [];
    const result = await createTrinoConnector({ hostGuard: allowing(looked) }).test(
      contextFor('trino', 'trino.example.com', server.port),
    );
    expect(result).toMatchObject({ ok: true, serverVersion: 'Trino 479' });
    expect(looked.every((hostname) => hostname === 'trino.example.com')).toBe(true);
    expect(looked.length).toBeGreaterThan(1);
    expect(server.seen.filter((line) => line === 'POST /v1/statement')).toHaveLength(3);
  });
});

describe('an error’s body', () => {
  it('keeps the start of it as plain text, and none of a page of markup', () => {
    expect(bodyExcerpt('  line one\r\n\tline\u0000two  ')).toBe('line one line two');
    expect(bodyExcerpt('<!DOCTYPE html><html><body>502</body></html>')).toBe('');
    const long = bodyExcerpt('a'.repeat(500));
    expect(long).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
  });
});
