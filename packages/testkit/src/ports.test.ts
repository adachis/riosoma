import { createServer as createHttpServer } from 'node:http';
import { connect, createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { holdPort, refusedPort } from './ports.js';

/** What the loopback answers with on a port nothing holds, or why it answered at all. */
function attempt(port: number): Promise<unknown> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(new Error('something answered'));
    });
    socket.once('error', (error: unknown) => {
      socket.destroy();
      resolve(error);
    });
  });
}

describe('a port nothing answers on', () => {
  it('refuses a connection, which is what a stopped server looks like', async () => {
    await expect(attempt(await refusedPort())).resolves.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('is a port an HTTP client dials, so a refused request names the network', async () => {
    const failure = await fetch(`http://127.0.0.1:${await refusedPort()}/`).then(
      () => null,
      (error: unknown) => error as { cause?: { code?: string } },
    );
    expect(failure?.cause).toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('stays below the range a test server can bind, so nobody takes it over mid-test', async () => {
    for (let call = 0; call < 3; call += 1) {
      const port = await refusedPort();
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(1024);
      await expect(attempt(port)).resolves.toMatchObject({ code: 'ECONNREFUSED' });
    }
  });
});

/** Whether another listener can bind this loopback port now, or the error it gets. */
function bind(port: number): Promise<unknown> {
  return new Promise((resolve) => {
    const other = createServer();
    other.once('error', (error) => resolve(error));
    other.listen(port, '127.0.0.1', () => other.close(() => resolve('bound')));
  });
}

/** An HTTP server whose listen settles once it listens, as a Fastify app's does */
function httpServer() {
  const server = createHttpServer((_request, response) => response.end('served'));
  return {
    server,
    listen: (options: { host: string; port: number }) =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options, () => resolve());
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('a port held for a server', () => {
  it('can’t be taken by anything else between being chosen and the server taking it over', async () => {
    const held = await holdPort();
    expect(await bind(held.port)).toMatchObject({ code: 'EADDRINUSE' });
    const server = httpServer();
    await held.serve(server);
    expect(await bind(held.port)).toMatchObject({ code: 'EADDRINUSE' });
    const answer = await fetch(`http://127.0.0.1:${held.port}/`);
    expect(await answer.text()).toBe('served');
    expect(server.server.address()).toMatchObject({ address: '127.0.0.1', port: held.port });
    await server.close();
    expect(await bind(held.port)).toBe('bound');
  });

  it('is let go when no server takes it over', async () => {
    const held = await holdPort();
    await held.release();
    expect(await bind(held.port)).toBe('bound');
  });

  it('stays the server’s when released after the server took it over', async () => {
    const held = await holdPort();
    const server = httpServer();
    await held.serve(server);
    await held.release();
    expect(await (await fetch(`http://127.0.0.1:${held.port}/`)).text()).toBe('served');
    await server.close();
  });
});
