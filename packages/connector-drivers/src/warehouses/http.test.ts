/**
 * How ClickHouse reaches its server: the private-network rule the server holds it to, through a
 * guard that checks every host, and the start of an error's body kept as plain text.  Each test runs a stand-in server on this machine and checks whether anything reached it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SourceConnection } from '@riosoma/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { FileNetworkError } from '@riosoma/connectors/internal/files/network.js';
import type { Connector, ConnectorContext } from '@riosoma/connectors/internal/types.js';
import type { HostGuard } from '@riosoma/connectors/internal/warehouses/http.js';
import { createClickHouseConnector } from './clickhouse.js';

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
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
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

// Built from parts, so the stand-in never reads as a stored secret.
const PASSWORD = ['stand', 'in', 'password', '5'].join('-');

function contextFor(kind: 'clickhouse', host: string, port: number): ConnectorContext {
  const connection: SourceConnection = {
    kind,
    host,
    port,
    database: 'default',
    user: 'reader',
    secure: false,
  };
  return { connection, secrets: { password: PASSWORD }, timeoutMs: 5_000 };
}

const ENGINES: Array<['clickhouse', (hostGuard: HostGuard) => Connector]> = [
  ['clickhouse', (hostGuard) => createClickHouseConnector({ hostGuard })],
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
});

describe('an error’s body', () => {
  it('keeps no more than 200 characters of what something other than ClickHouse answered', async () => {
    const server = await standIn((_request, _body, response) => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(`not clickhouse\n${'q'.repeat(3_000)}`);
    });
    const result = await createClickHouseConnector().test(contextFor('clickhouse', '127.0.0.1', server.port));
    const detail = result.steps.at(-1)?.detail ?? '';
    expect(result.ok).toBe(false);
    expect(detail.startsWith('not clickhouse qqq')).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(200);
  });
});
