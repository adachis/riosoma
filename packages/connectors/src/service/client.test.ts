import { randomBytes } from 'node:crypto';
import { createServer, type RequestListener, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceConnection, SourceSelect } from '@riosoma/contracts';
import type { Connector, ConnectorContext, SourceRow } from '../types.js';
import { ConnectorServiceClient, createServiceConnector } from './client.js';

const context = { connection: { kind: 'mysql' } as SourceConnection, secrets: {} };
const select: SourceSelect = { kind: 'object', object: { schema: null, name: 'rows' } };
const network = { production: false, allowPrivateHosts: true, demo: false };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(handle: RequestListener): Promise<Connector & { client: ConnectorServiceClient }> {
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const client = new ConnectorServiceClient({
    endpoint: async () => ({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: randomBytes(32).toString('base64url'),
    }),
    network: () => network,
  });
  cleanup.push(() => client.close());
  return Object.assign(createServiceConnector('mysql', client), { client });
}

async function collect(connector: Connector): Promise<SourceRow[][]> {
  const batches = [];
  for await (const batch of connector.read(context, select, {
    columns: ['text'],
    types: {},
    keyColumns: [],
  }))
    batches.push(batch);
  return batches;
}

describe('service read records', () => {
  it('assembles wide records from many chunks and preserves coalesced lines and an unterminated end', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      key: `[${i}]`,
      values: { text: 'café 漢字 😀'.repeat(300) },
    }));
    const bytes = Buffer.from(`${JSON.stringify({ rows })}\n\n${JSON.stringify({ rows: [] })}\n{"end":true}`);
    const connector = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      void (async () => {
        for (let offset = 0; offset < bytes.length; offset += 4093) {
          if (!response.write(bytes.subarray(offset, offset + 4093)))
            await new Promise<void>((resolve) => response.once('drain', resolve));
          await nextTurn();
        }
        response.end();
      })();
    });
    expect(await collect(connector)).toEqual([rows, []]);
  });

  it('preserves UTF-8 split at every byte boundary', async () => {
    const rows = [{ key: '[1]', values: { text: 'café 漢字 😀' } }];
    const bytes = Buffer.from(`${JSON.stringify({ rows })}\n{"end":true}\n`);
    const connector = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      void (async () => {
        for (const byte of bytes) {
          response.write(Buffer.from([byte]));
          await nextTurn();
        }
        response.end();
      })();
    });
    expect(await collect(connector)).toEqual([rows]);
  });

  it.each([
    '',
    '{"unexpected":true}\n',
    '{"end":false}\n',
    'null\n',
    '[]\n',
    '{"rows":{}}\n',
    '{"incremental":false}\n',
    '{"validators":null}\n',
    '{"error":{}}\n',
    '{"end":true,"unexpected":true}\n',
    '{broken\n',
  ])('rejects a partial snapshot followed by %j', async (tail) => {
    const connector = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(`{"rows":[{"key":"[1]","values":{"text":"partial"}}]}\n${tail}`);
    });
    await expect(collect(connector)).rejects.toMatchObject({ messageKey: 'sources.service.unavailable' });
  });

  it('accepts an exact end record without a trailing newline', async () => {
    const connector = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end('\n{"rows":[]}\n{"end":true}');
    });
    expect(await collect(connector)).toEqual([[]]);
  });

  it('preserves a terminal connector error after a batch', async () => {
    const connector = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(
        '{"rows":[]}\n{"error":{"messageKey":"sources.sync.columnMissing","params":{"column":"text"}}}\n',
      );
    });
    await expect(collect(connector)).rejects.toMatchObject({
      messageKey: 'sources.sync.columnMissing',
      params: { column: 'text' },
    });
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const readOptions = { columns: ['text'], types: {}, keyColumns: [] };
const timeout = { messageKey: 'sources.sync.read', params: { reason: 'timeout' } };

describe('client deadlines', () => {
  it.each(['objects', 'describe', 'preview', 'keys', 'session', 'test', 'read'])(
    'aborts a stalled %s request with the driver timeout result',
    async (operation) => {
      const arrived = deferred();
      const closed = deferred();
      const connector = await fixture((_request, response) => {
        response.once('close', () => closed.resolve());
        arrived.resolve();
      });
      vi.useFakeTimers();
      const ctx: ConnectorContext = { ...context, timeoutMs: 25 };
      const pending =
        operation === 'objects'
          ? connector.listObjects(ctx)
          : operation === 'describe'
            ? connector.describe(ctx, select)
            : operation === 'preview'
              ? connector.preview(ctx, select, 1)
              : operation === 'keys'
                ? connector.keyCandidates(ctx, select.object!)
                : operation === 'session'
                  ? connector.session!(ctx)
                  : operation === 'test'
                    ? connector.test(ctx)
                    : connector.read(ctx, select, readOptions)[Symbol.asyncIterator]().next();
      const result =
        operation === 'test'
          ? expect(pending).resolves.toMatchObject({
              ok: false,
              steps: [{ status: 'failed', messageKey: 'sources.test.timeout' }],
            })
          : expect(pending).rejects.toMatchObject(
              operation === 'session' ? { messageKey: 'sources.live.timeout' } : timeout,
            );
      await arrived.promise;
      vi.advanceTimersByTime(25);
      await result;
      await closed.promise;
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('bounds a response body that stalls after the headers arrive', async () => {
    const arrived = deferred();
    const connector = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"result":');
      arrived.resolve();
    });
    vi.useFakeTimers();
    const pending = connector.listObjects({ ...context, timeoutMs: 25 });
    const result = expect(pending).rejects.toMatchObject(timeout);
    await arrived.promise;
    vi.advanceTimersByTime(25);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renews reads after each delivered batch and allows a slow consumer', async () => {
    let response!: ServerResponse;
    const connector = await fixture((_request, reply) => {
      response = reply;
      reply.writeHead(200, { 'content-type': 'application/x-ndjson' });
      reply.write('{"rows":[]}\n');
    });
    vi.useFakeTimers();
    const stream = connector.read({ ...context, timeoutMs: 25 }, select, readOptions);
    const iterator = stream[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ value: [], done: false });
    vi.advanceTimersByTime(1000);
    const second = iterator.next();
    vi.advanceTimersByTime(24);
    response.write('{"rows":[]}\n');
    expect(await second).toMatchObject({ value: [], done: false });
    const end = iterator.next();
    vi.advanceTimersByTime(24);
    response.end('{"end":true}\n');
    expect(await end).toMatchObject({ done: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not renew a stalled read for validators, incremental markers, or keepalives', async () => {
    const validators = deferred();
    const incremental = deferred();
    let response!: ServerResponse;
    const connector = await fixture((_request, reply) => {
      response = reply;
      reply.writeHead(200, { 'content-type': 'application/x-ndjson' });
      reply.write('{"validators":{"cursor":"first"}}\n');
    });
    vi.useFakeTimers();
    const stream = connector.read({ ...context, timeoutMs: 25 }, select, {
      ...readOptions,
      onValidators: () => validators.resolve(),
      onIncremental: () => incremental.resolve(),
    });
    const iterator = stream[Symbol.asyncIterator]();
    const result = expect(iterator.next()).rejects.toMatchObject(timeout);
    await validators.promise;
    vi.advanceTimersByTime(15);
    response.write('{"incremental":true}\n\n');
    await incremental.promise;
    vi.advanceTimersByTime(10);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the statement timeout for session reads independently of the opening signal', async () => {
    const arrived = deferred();
    const connector = await fixture((request, response) => {
      if (request.url === '/v1/sessions') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"result":{"id":"session"}}');
      } else if (request.method === 'DELETE') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"result":null}');
      } else arrived.resolve();
    });
    vi.useFakeTimers();
    const controller = new AbortController();
    const session = await connector.session!({
      ...context,
      timeoutMs: 10,
      statementTimeoutMs: 25,
      signal: controller.signal,
    });
    controller.abort();
    const result = expect(session.select('SELECT 1', [])).rejects.toMatchObject({
      messageKey: 'sources.live.timeout',
    });
    await arrived.promise;
    vi.advanceTimersByTime(25);
    await result;
    await session.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not add a deadline to session descriptions', async () => {
    const arrived = deferred();
    let response!: ServerResponse;
    const connector = await fixture((request, reply) => {
      reply.writeHead(200, { 'content-type': 'application/json' });
      if (request.url === '/v1/sessions') reply.end('{"result":{"id":"session"}}');
      else if (request.method === 'DELETE') reply.end('{"result":null}');
      else {
        response = reply;
        arrived.resolve();
      }
    });
    vi.useFakeTimers();
    const session = await connector.session!({ ...context, timeoutMs: 25 });
    const pending = session.describe(select);
    await arrived.promise;
    vi.advanceTimersByTime(1000);
    response.end('{"result":[]}');
    expect(await pending).toEqual([]);
    await session.close();
  });
});

describe('endpoint discovery', () => {
  function discovering(endpoint: () => Promise<never>) {
    const client = new ConnectorServiceClient({ endpoint, network: () => network });
    cleanup.push(() => client.close());
    return client;
  }

  it('settles cancellation before discovery finishes and handles a late failure', async () => {
    let reject!: (error: Error) => void;
    const client = discovering(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const controller = new AbortController();
    const pending = client.call('/v1/mysql/objects', {}, controller.signal);
    const result = expect(pending).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
    await nextTurn();
    controller.abort();
    await result;
    reject(new Error('late discovery failure'));
    await nextTurn();
  });

  it('expires a connector deadline while discovery is pending', async () => {
    const client = discovering(() => new Promise(() => {}));
    const connector = createServiceConnector('mysql', client);
    vi.useFakeTimers();
    const result = expect(connector.listObjects({ ...context, timeoutMs: 25 })).rejects.toMatchObject(
      timeout,
    );
    vi.advanceTimersByTime(25);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start an HTTP request when discovery completes after cancellation', async () => {
    const endpoint = deferred<{ url: string; token: string }>();
    let requests = 0;
    const server = createServer(() => {
      requests++;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const client = new ConnectorServiceClient({ endpoint: () => endpoint.promise, network: () => network });
    cleanup.push(() => client.close());
    const controller = new AbortController();
    const result = expect(client.call('/v1/mysql/objects', {}, controller.signal)).rejects.toMatchObject({
      messageKey: 'sources.sync.read',
    });
    controller.abort();
    await result;
    endpoint.resolve({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: randomBytes(32).toString('base64url'),
    });
    await nextTurn();
    expect(requests).toBe(0);
  });

  it('reports a stalled health response as unavailable even after successful headers', async () => {
    const connector = await fixture((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.flushHeaders();
    });
    expect(await connector.client.health(10)).toBe('unavailable');
  });

  it('expires a health probe while discovery is pending', async () => {
    const client = discovering(() => new Promise(() => {}));
    expect(await client.health(10)).toBe('unavailable');
  });
});
