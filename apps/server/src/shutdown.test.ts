import { expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { closeServer, installHttpShutdown } from './shutdown.js';

it('keeps the database available until requests and workers have stopped', async () => {
  let finish: () => void = () => undefined;
  const closing = new Promise<undefined>((resolve) => {
    finish = () => resolve(undefined);
  });
  const closeDatabase = vi.fn(async () => undefined);
  const app = { close: vi.fn(() => closing) };
  const result = closeServer(app, closeDatabase);
  expect(app.close).toHaveBeenCalledOnce();
  expect(closeDatabase).not.toHaveBeenCalled();
  finish();
  await result;
  expect(closeDatabase).toHaveBeenCalledOnce();
});

it('flushes and closes an upgrade refused while a shutdown hook is draining', async () => {
  const app = Fastify();
  installHttpShutdown(app);
  let entered: () => void = () => undefined;
  let release: () => void = () => undefined;
  const draining = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const drained = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.addHook('preClose', async () => {
    entered();
    await drained;
  });
  await app.register(websocket);
  app.get('/socket', { websocket: true }, (socket) => socket.close());
  const accepted = new Set<Socket>();
  app.server.on('connection', (socket) => {
    accepted.add(socket);
    socket.once('close', () => accepted.delete(socket));
  });
  const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
  const closing = app.close();
  await draining;
  const client = createConnection({ host: address.hostname, port: Number(address.port) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await once(client, 'connect');
    let body = '';
    client.setEncoding('utf8');
    const ended = new Promise<string>((resolve, reject) => {
      client.on('data', (chunk) => {
        body += chunk;
      });
      client.once('end', () => resolve(body));
      client.once('error', reject);
    });
    client.write(
      `GET /socket HTTP/1.1\r\nHost: ${address.host}\r\nConnection: Upgrade\r\n` +
        'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
        `Sec-WebSocket-Key: ${Buffer.alloc(16, 7).toString('base64')}\r\n\r\n`,
    );
    const response = await Promise.race([
      ended,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('Connection stayed open'), 2_000);
      }),
    ]);
    expect(response).toContain('HTTP/1.1 503 Service Unavailable');
    expect(response).toContain('"statusCode":503');
  } finally {
    clearTimeout(timer);
    release();
    client.destroy();
    for (const socket of accepted) socket.destroy();
    await closing;
  }
});

it('finishes an active response and closes its keep-alive socket before ending the pool', async () => {
  const app = Fastify();
  installHttpShutdown(app);
  let entered: () => void = () => undefined;
  let release: () => void = () => undefined;
  let closingStarted: () => void = () => undefined;
  const incoming = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    closingStarted = resolve;
  });
  app.addHook('preClose', async () => {
    closingStarted();
  });
  app.get('/pending', async () => {
    entered();
    await proceed;
    return { ok: true };
  });
  const accepted = new Set<Socket>();
  app.server.on('connection', (socket) => {
    accepted.add(socket);
    socket.once('close', () => accepted.delete(socket));
  });
  const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
  const client = createConnection({ host: address.hostname, port: Number(address.port) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closeDatabase = vi.fn(async () => undefined);
  let closing: Promise<void> | undefined;
  try {
    await once(client, 'connect');
    let body = '';
    client.setEncoding('utf8');
    const ended = new Promise<string>((resolve, reject) => {
      client.on('data', (chunk) => {
        body += chunk;
      });
      client.once('end', () => resolve(body));
      client.once('error', reject);
    });
    client.write(`GET /pending HTTP/1.1\r\nHost: ${address.host}\r\nConnection: keep-alive\r\n\r\n`);
    await incoming;
    closing = closeServer(app, closeDatabase);
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(app.server.listening).toBe(false);
    expect(closeDatabase).not.toHaveBeenCalled();
    release();
    const response = await Promise.race([
      ended,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('Connection stayed open'), 2_000);
      }),
    ]);
    expect(response).toContain('HTTP/1.1 200 OK');
    expect(response.split('\r\n\r\n')[1]).toBe('{"ok":true}');
    await closing;
    expect(closeDatabase).toHaveBeenCalledOnce();
  } finally {
    clearTimeout(timer);
    release();
    client.destroy();
    for (const socket of accepted) socket.destroy();
    await (closing ?? app.close());
  }
});

it('ends a streaming response that outlasts the shutdown grace period', async () => {
  const app = Fastify();
  installHttpShutdown(app, { streamGraceMs: 50 });
  app.get('/stream', (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.raw.write(': open\n\n');
  });
  const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
  const response = await fetch(new URL('/stream', address));
  const reader = response.body!.getReader();
  await reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The client never leaves, so only the grace period can end the stream.
    const outcome = await Promise.race([
      app.close().then(() => 'closed'),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('Shutdown waited on the stream'), 2_000);
      }),
    ]);
    expect(outcome).toBe('closed');
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
});
