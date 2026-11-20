/**
 * The server's connectors for the kinds the connector service runs: what they say when the
 * service is away or refuses the token, how a failure crosses as the connector's own message key
 * and parameters, how giving up on a read stops it in the service, how a live session's driver
 * values arrive intact, where a source's secrets travel and where they never appear, and the
 * private-network rule the service applies for the server.  Each test runs the real service in
 * this process on a port of this machine.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startConnectorService, type RunningConnectorService } from '@riosoma/connector-service';
import {
  ConnectorError,
  ConnectorServiceClient,
  connectorFor,
  createServiceConnector,
  SERVICE_KINDS,
  type Connector,
  type ConnectorContext,
  type HostGuard,
  type LiveSession,
  type ServiceKind,
  type SourceRow,
  type WireNetwork,
} from '@riosoma/connectors';
import { MongoConnection, type SourceConnection, type SourceSelect } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { fixedLink, storedToken } from './connector-service.js';

const STRICT: WireNetwork = { production: true, allowPrivateHosts: false, demo: false };
// Made up for each run, so no stand-in reads as a stored secret.
const SECRET = `pw-${randomBytes(12).toString('hex')}`;
const SELECT: SourceSelect = { kind: 'object', object: { schema: 'public', name: 'orders' } };

const MYSQL = {
  kind: 'mysql',
  host: 'db.example.com',
  port: 3306,
  database: 'sales',
  user: 'reader',
  tls: { mode: 'disable' },
} as unknown as SourceConnection;

function context(patch: Partial<ConnectorContext> = {}): ConnectorContext {
  return { connection: MYSQL, secrets: { password: SECRET }, timeoutMs: 5_000, ...patch };
}

function token(): string {
  return randomBytes(32).toString('base64url');
}

/** A port on this machine where nothing listens. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function clientFor(url: string, shared: string, network: WireNetwork = STRICT): ConnectorServiceClient {
  return new ConnectorServiceClient({
    endpoint: async () => ({ url, token: shared }),
    network: () => network,
  });
}

/** A stand-in connector the service runs in place of MySQL's, built per test. */
function standIn(parts: Partial<Connector>): (guard: HostGuard) => Connector[] {
  return () => [
    {
      kind: 'mysql',
      test: async () => ({ ok: true, steps: [] }),
      listObjects: async () => [],
      describe: async () => [],
      preview: async () => ({ columns: [], rows: [], rowEstimate: null }),
      keyCandidates: async () => [],
      async *read() {},
      ...parts,
    },
  ];
}

const running: Array<{ close(): Promise<void> | void }> = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((entry) => entry.close()));
});

async function service(
  options: Parameters<typeof startConnectorService>[1] = {},
  shared = token(),
): Promise<RunningConnectorService & { client: ConnectorServiceClient; logs: string[] }> {
  const logs: string[] = [];
  const started = await startConnectorService(shared, {
    logLevel: 'debug',
    logStream: { write: (line: string) => logs.push(line) },
    ...options,
  });
  const client = clientFor(started.url, shared);
  running.push(started, { close: () => client.close() });
  return { ...started, client, logs };
}

describe('when the service is away', () => {
  it('fails a test at its first step, and every other call, with a message saying so', async () => {
    const client = clientFor(`http://127.0.0.1:${await closedPort()}`, token());
    running.push({ close: () => client.close() });
    const connector = createServiceConnector('mysql', client);
    await expect(connector.test(context())).resolves.toEqual({
      ok: false,
      steps: [{ step: 'driver', status: 'failed', ms: null, messageKey: 'sources.service.unavailable' }],
    });
    const away = { messageKey: 'sources.service.unavailable' };
    await expect(connector.listObjects(context())).rejects.toMatchObject(away);
    await expect(connector.describe(context(), SELECT)).rejects.toMatchObject(away);
    await expect(connector.preview(context(), SELECT, 5)).rejects.toMatchObject(away);
    await expect(connector.keyCandidates(context(), SELECT.object)).rejects.toMatchObject(away);
    await expect(connector.session!(context())).rejects.toMatchObject(away);
    const read = async () => {
      for await (const batch of connector.read(context(), SELECT, {
        columns: ['id'],
        types: {},
        keyColumns: ['id'],
      }))
        void batch;
    };
    await expect(read()).rejects.toMatchObject(away);
    await expect(read()).rejects.toBeInstanceOf(ConnectorError);
    expect(await client.health(1000)).toBe('unavailable');
  });

  it('treats an address it can’t find, and a token it doesn’t accept, the same way', async () => {
    const lost = createServiceConnector(
      'mysql',
      new ConnectorServiceClient({
        endpoint: async () => {
          throw new Error('no token file');
        },
        network: () => STRICT,
      }),
    );
    await expect(lost.listObjects(context())).rejects.toMatchObject({
      messageKey: 'sources.service.unavailable',
    });
    const { url } = await service();
    const stranger = clientFor(url, token());
    running.push({ close: () => stranger.close() });
    await expect(createServiceConnector('mysql', stranger).listObjects(context())).rejects.toMatchObject({
      messageKey: 'sources.service.unavailable',
    });
    expect(await stranger.health()).toBe('refused');
  });
});

describe('a server whose connector service is away', () => {
  let kit: TestPostgres;
  let server: ServerFixture;

  beforeAll(async () => {
    kit = await startTestPostgres();
    // The service is where the settings say, and nothing answers there.
    server = await startServer(kit, 'svcdown', {
      connectorServiceUrl: `http://127.0.0.1:${await closedPort()}`,
      connectorServiceToken: token(),
    });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await kit?.stop();
  });

  it('says so, in a message people can read, when someone tests such a source', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/sources/test',
      headers: server.owner.headers,
      payload: { name: 'Orders', connection: MYSQL, secrets: { password: SECRET } },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: false,
      steps: [{ step: 'driver', status: 'failed', messageKey: 'sources.service.unavailable' }],
    });
    expect(response.body).not.toContain(SECRET);
    for (const kind of SERVICE_KINDS) expect(connectorFor(kind).kind).toBe(kind);
  });

  it('reports it in health and readiness without taking the server out of service', async () => {
    const health = await server.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok', connectors: 'unavailable' });
    const ready = await server.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready', checks: { database: 'ok', connectors: 'unavailable' } });
  });
});

describe('a server with its connector service', () => {
  let kit: TestPostgres;
  let server: ServerFixture;

  beforeAll(async () => {
    kit = await startTestPostgres();
    server = await startServer(kit, 'svcup');
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    await kit?.stop();
  });

  it('reaches a source the service runs, and reports the service healthy', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/sources/test',
      headers: server.owner.headers,
      payload: {
        name: 'Orders',
        connection: { ...MYSQL, host: 'db.example.com' },
        secrets: { password: SECRET },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<{ ok: boolean; steps: Array<{ step: string; messageKey?: string }> }>();
    // The real MySQL connector ran in the service: this name doesn't resolve in a test.
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.messageKey).not.toBe('sources.service.unavailable');
    expect(response.body).not.toContain(SECRET);
    const health = await server.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.json()).toMatchObject({ connectors: 'ok' });
  });
});

describe('a failure from the service', () => {
  it('arrives as the connector’s own message key, parameters, and words', async () => {
    const { client } = await service({
      connectors: standIn({
        describe: async () => {
          throw new ConnectorError('sources.sync.objectMissing', 'no table orders', {
            object: 'orders',
            count: 2,
          });
        },
        keyCandidates: async () => {
          throw new ConnectorError('sources.test.timeout');
        },
      }),
    });
    const connector = createServiceConnector('mysql', client);
    const error = await connector.describe(context(), SELECT).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({
      messageKey: 'sources.sync.objectMissing',
      detail: 'no table orders',
      params: { object: 'orders', count: 2 },
    });
    await expect(connector.keyCandidates(context(), SELECT.object)).rejects.toMatchObject({
      messageKey: 'sources.test.timeout',
      detail: undefined,
      params: undefined,
    });
  });

  it('never carries a driver’s own words, or a secret a connector repeated', async () => {
    const { client, logs } = await service({
      connectors: standIn({
        listObjects: async () => {
          throw new Error(`login failed for reader with password ${SECRET}`);
        },
        preview: async () => {
          throw new ConnectorError('sources.test.authenticate', `refused ${SECRET}`, { said: `${SECRET}!` });
        },
      }),
    });
    const connector = createServiceConnector('mysql', client);
    const raw = await connector.listObjects(context()).catch((thrown: unknown) => thrown);
    expect(raw).toMatchObject({ messageKey: 'sources.sync.read', detail: undefined });
    const repeated = (await connector
      .preview(context(), SELECT, 1)
      .catch((thrown: unknown) => thrown)) as ConnectorError;
    expect(repeated.messageKey).toBe('sources.test.authenticate');
    expect(repeated.detail).toBe('refused [redacted]');
    expect(repeated.params).toEqual({ said: '[redacted]!' });
    // The service noted the raw failure by its type alone.
    expect(logs.join('')).toContain('connector call failed');
    expect(logs.join('')).not.toContain(SECRET);
    expect(logs.join('')).not.toContain('login failed');
  });
});

describe('where a source’s secrets travel', () => {
  it('only in the body of a request, never in its address or a log line', async () => {
    const seen: Array<{ url: string; headers: IncomingMessage['headers']; body: string }> = [];
    const stand = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => (body += chunk));
      request.on('end', () => {
        seen.push({ url: request.url ?? '', headers: request.headers, body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ result: [] }));
      });
    });
    await new Promise<void>((resolve) => stand.listen(0, '127.0.0.1', resolve));
    running.push({ close: () => new Promise<void>((resolve) => stand.close(() => resolve())) });
    const shared = token();
    const client = clientFor(`http://127.0.0.1:${(stand.address() as AddressInfo).port}`, shared);
    running.push({ close: () => client.close() });
    await createServiceConnector('mysql', client).listObjects(context({ sourceId: 'src1' }));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('/v1/mysql/objects');
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${shared}`);
    expect(JSON.stringify(seen[0]!.headers)).not.toContain(SECRET);
    expect(JSON.parse(seen[0]!.body)).toMatchObject({
      context: { connection: { kind: 'mysql' }, secrets: { password: SECRET }, sourceId: 'src1' },
      network: STRICT,
    });

    // The real service logs a whole run of calls without naming a secret.
    const { client: real, logs } = await service({
      connectors: standIn({
        test: async (ctx) => ({
          ok: false,
          steps: [
            {
              step: 'authenticate',
              status: 'failed',
              ms: 1,
              messageKey: 'sources.test.authenticate',
              detail: `bad ${ctx.secrets.password}`,
            },
          ],
        }),
      }),
    });
    const connector = createServiceConnector('mysql', real);
    const tested = await connector.test(context());
    expect(tested.steps[0]!.detail).toBe('bad [redacted]');
    await connector.listObjects(context());
    expect(logs.join('')).not.toContain(SECRET);
  });
});

describe('a read through the service', () => {
  it('streams its batches in order, with the validators the source gave', async () => {
    const { client } = await service({
      connectors: standIn({
        async *read(_ctx, _select, options) {
          options.onValidators?.({ etag: 'v1' });
          for (let batch = 0; batch < 3; batch += 1)
            yield [{ key: `[${batch}]`, values: { id: batch, at: '2026-01-02', note: null } }];
        },
      }),
    });
    const batches: SourceRow[][] = [];
    const validators: unknown[] = [];
    for await (const batch of createServiceConnector('mysql', client).read(context(), SELECT, {
      columns: ['id', 'at', 'note'],
      types: { id: 'number', at: 'date', note: 'text' },
      keyColumns: ['id'],
      onValidators: (value) => validators.push(value),
    }))
      batches.push(batch);
    expect(batches.map((batch) => batch[0]!.values.id)).toEqual([0, 1, 2]);
    expect(batches[0]).toEqual([{ key: '[0]', values: { id: 0, at: '2026-01-02', note: null } }]);
    expect(validators).toEqual([{ etag: 'v1' }]);
  });

  it('ends with the failure the connector gave partway through', async () => {
    const { client } = await service({
      connectors: standIn({
        async *read() {
          yield [{ key: '[1]', values: { id: 1 } }];
          throw new ConnectorError('sources.sync.keyEmpty');
        },
      }),
    });
    const seen: number[] = [];
    const read = async () => {
      for await (const batch of createServiceConnector('mysql', client).read(context(), SELECT, {
        columns: ['id'],
        types: {},
        keyColumns: ['id'],
      }))
        seen.push(batch.length);
    };
    await expect(read()).rejects.toMatchObject({ messageKey: 'sources.sync.keyEmpty' });
    expect(seen).toEqual([1]);
  });

  it('stops in the service when the server gives up on it, or stops early', async () => {
    let stopped: (reason: string) => void = () => undefined;
    const stops: string[] = [];
    const { client } = await service({
      connectors: standIn({
        async *read(ctx) {
          const signalled = new Promise<void>((resolve) =>
            ctx.signal?.addEventListener('abort', () => resolve()),
          );
          try {
            for (let batch = 0; ; batch += 1) {
              yield [{ key: `[${batch}]`, values: { id: batch } }];
              await Promise.race([signalled, new Promise((resolve) => setTimeout(resolve, 20))]);
            }
          } finally {
            stopped(ctx.signal?.aborted ? 'aborted' : 'returned');
          }
        },
      }),
    });
    const connector = createServiceConnector('mysql', client);
    const options = { columns: ['id'], types: {}, keyColumns: ['id'] };
    const next = () => new Promise<string>((resolve) => (stopped = resolve));

    // The caller's signal fires partway through.
    const controller = new AbortController();
    const first = next();
    const reading = (async () => {
      let count = 0;
      for await (const batch of connector.read(context({ signal: controller.signal }), SELECT, options)) {
        count += batch.length;
        if (count === 2) controller.abort();
      }
    })();
    await expect(reading).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
    stops.push(await first);

    // The caller stops taking batches.
    const second = next();
    for await (const batch of connector.read(context(), SELECT, options))
      if (batch[0]!.values.id === 1) break;
    stops.push(await second);
    expect(stops).toEqual(['aborted', 'aborted']);
  });
});

describe('a live table’s session through the service', () => {
  it('keeps the driver’s own values, and closes in the service when the server closes it', async () => {
    const closed: string[] = [];
    const statements: Array<[string, readonly string[]]> = [];
    const session: LiveSession = {
      describe: async () => [],
      async select(text, params) {
        statements.push([text, params]);
        return [
          {
            id: 9007199254740993n,
            at: new Date('2026-02-03T04:05:06.007Z'),
            blob: Buffer.from([0, 1, 254, 255]),
            ratio: Number.NaN,
            missing: undefined,
            $rio: 'a column with the tag’s name',
          },
        ];
      },
      async close() {
        closed.push('closed');
      },
    };
    const { client } = await service({ connectors: standIn({ session: async () => session }) });
    const connector = createServiceConnector('mysql', client);
    const live = await connector.session!(context());
    const rows = await live.select('SELECT * FROM t WHERE id = ?', ['7']);
    expect(statements).toEqual([['SELECT * FROM t WHERE id = ?', ['7']]]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(9007199254740993n);
    expect(row.at).toEqual(new Date('2026-02-03T04:05:06.007Z'));
    expect(Buffer.isBuffer(row.blob) && [...(row.blob as Buffer)]).toEqual([0, 1, 254, 255]);
    expect(row.ratio).toBeNaN();
    expect('missing' in row && row.missing === undefined).toBe(true);
    expect(row.$rio).toBe('a column with the tag’s name');
    await live.close();
    await expect.poll(() => closed).toEqual(['closed']);
    // A session the service no longer has fails as unreachable, so the pool opens another.
    await expect(live.select('SELECT 1', [])).rejects.toBeInstanceOf(ConnectorError);
  });

  it('only for the kinds that keep one', () => {
    const client = clientFor('http://127.0.0.1:1', token());
    for (const kind of SERVICE_KINDS) {
      const connector = createServiceConnector(kind as ServiceKind, client);
      expect(typeof connector.session, kind).toBe(
        ['mysql', 'sqlserver', 'oracle', 'firebird'].includes(kind) ? 'function' : 'undefined',
      );
    }
    client.close();
  });
});

describe('the private-network rule in the service', () => {
  it('holds ClickHouse and MongoDB to it for a name that resolves somewhere private', async () => {
    const looked: string[] = [];
    const { client } = await service({
      resolve: async (host) => {
        looked.push(host);
        return [{ address: '10.1.2.3', family: 4 }];
      },
    });
    const clickhouse = await createServiceConnector('clickhouse', client).test({
      connection: {
        kind: 'clickhouse',
        host: 'inside.example.test',
        port: 8443,
        database: 'default',
        user: 'reader',
        secure: true,
      } as SourceConnection,
      secrets: { password: SECRET },
      timeoutMs: 2_000,
    });
    expect(clickhouse.steps).toEqual([
      expect.objectContaining({ step: 'resolve', status: 'failed', messageKey: 'sources.analytics.blocked' }),
    ]);
    expect(looked).toEqual(['inside.example.test']);
    looked.length = 0;
    const mongo = await createServiceConnector('mongodb', client).test({
      connection: MongoConnection.parse({ kind: 'mongodb', host: 'inside.example.test', database: 'sales' }),
      secrets: {},
      timeoutMs: 2_000,
    });
    expect(mongo.ok).toBe(false);
    expect(mongo.steps.find((step) => step.status === 'failed')).toMatchObject({
      messageKey: 'sources.mongodb.blocked',
    });
    expect(looked).toEqual(['inside.example.test']);
  });

  it('lets a private host through when the server’s rule does', async () => {
    const shared = token();
    const started = await startConnectorService(shared, {
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    const client = clientFor(started.url, shared, { production: true, allowPrivateHosts: true, demo: false });
    running.push(started, { close: () => client.close() });
    const port = await closedPort();
    const result = await createServiceConnector('clickhouse', client).test({
      connection: {
        kind: 'clickhouse',
        host: 'inside.example.test',
        port,
        database: 'default',
        user: 'reader',
        secure: false,
      } as SourceConnection,
      secrets: { password: SECRET },
      timeoutMs: 2_000,
    });
    // Past the rule, nothing answers on the port.
    expect(result.steps.find((step) => step.status === 'failed')).not.toMatchObject({
      messageKey: 'sources.analytics.blocked',
    });
  });
});

describe('the shared token', () => {
  it('is generated once into its file, readable only by this account, and kept after that', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rio-token-'));
    try {
      const path = join(directory, 'nested', 'connector-service.token');
      const first = storedToken(path);
      expect(first.length).toBeGreaterThanOrEqual(32);
      expect(readFileSync(path, 'utf8').trim()).toBe(first);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(storedToken(path)).toBe(first);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('comes from the settings when the operator sets one', async () => {
    const shared = token();
    const link = fixedLink({
      connectorServiceUrl: 'http://connectors:8091',
      connectorServiceToken: shared,
      connectorServiceTokenFile: '/nonexistent/connector-service.token',
      configDir: '/nonexistent',
    });
    await expect(link.endpoint()).resolves.toEqual({ url: 'http://connectors:8091', token: shared });
  });
});
