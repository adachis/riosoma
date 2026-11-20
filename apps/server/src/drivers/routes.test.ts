import { connect, type AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import type { SourceDrivers } from '@riosoma/contracts';
import { MAX_DRIVER_BYTES } from './archive.js';

let kit: TestPostgres;
let server: ServerFixture;
let member: SignedIn;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'drivers');
  member = await server.addMember();
}, 60000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const INSTALL = '/api/source-drivers/teradatasql/install';
const UPLOAD = '/api/source-drivers/teradatasql/uploads/teradatasql';

/** A body that counts how often the server asks it for bytes, and never ends unless told to */
function watchedBody(chunk: Buffer, ends = false) {
  const body = { pulls: 0, stream: undefined as unknown as Readable };
  body.stream = new Readable({
    read() {
      body.pulls += 1;
      this.push(chunk);
      if (ends) this.push(null);
    },
  });
  return body;
}

it('refuses a signed-out, unauthorized, or cross-site install or upload before reading any of its body', async () => {
  const { cookie } = server.owner.headers;
  const callers = [{}, member.headers, { cookie }];
  for (const [url, method, type] of [
    [INSTALL, 'POST', 'application/json'],
    [UPLOAD, 'PUT', 'application/octet-stream'],
  ] as const) {
    for (const headers of callers) {
      // Malformed JSON and more bytes than any limit allows, so a body read first would fail another way.
      const body = watchedBody(Buffer.alloc(1024 * 1024, '{'));
      const response = await server.app.inject({
        method,
        url,
        headers: { ...headers, 'content-type': type, 'content-length': String(512 * 1024 * 1024) },
        payload: body.stream,
      });
      body.stream.destroy();
      expect(response.json().error.messageKey).toBe(
        headers === callers[0]
          ? 'errors.signInRequired'
          : headers === member.headers
            ? 'errors.adminOnly'
            : 'errors.csrfMismatch',
      );
      expect(body.pulls).toBe(0);
      expect(response.headers.connection).toBe('close');
    }
  }
  // The same upload from an owner is read, which shows the count above would have seen a read.
  const body = watchedBody(Buffer.from('not an archive'), true);
  const response = await server.app.inject({
    method: 'PUT',
    url: UPLOAD,
    headers: { ...server.owner.headers, 'content-type': 'application/octet-stream' },
    payload: body.stream,
  });
  expect(response.statusCode).toBe(422);
  expect(response.json().error.messageKey).toBe('sources.drivers.integrity');
  expect(body.pulls).toBeGreaterThan(0);
});

it('refuses an upload larger than any pinned archive before reading it', async () => {
  const body = watchedBody(Buffer.alloc(1024));
  const response = await server.app.inject({
    method: 'PUT',
    url: UPLOAD,
    headers: {
      ...server.owner.headers,
      'content-type': 'application/octet-stream',
      'content-length': String(MAX_DRIVER_BYTES + 1),
    },
    payload: body.stream,
  });
  body.stream.destroy();
  expect(response.statusCode).toBe(413);
  expect(response.json().error.messageKey).toBe('sources.drivers.archiveInvalid');
  expect(body.pulls).toBe(0);
});

it('ends the connection with each refusal of its own, before reading any of the body', async () => {
  const refusals = [
    {
      url: UPLOAD,
      method: 'PUT',
      type: 'application/octet-stream',
      length: MAX_DRIVER_BYTES + 1,
      status: 413,
    },
    { url: UPLOAD, method: 'PUT', type: 'text/plain', length: 1024, status: 400 },
    { url: UPLOAD, method: 'PUT', type: 'application/octet-stream', length: 1024, status: 403, off: true },
    { url: INSTALL, method: 'POST', type: 'application/json', length: 1024, status: 403, off: true },
  ] as const;
  for (const refusal of refusals) {
    server.config.driverInstalls = !('off' in refusal);
    try {
      const body = watchedBody(Buffer.alloc(1024, '{'));
      const response = await server.app.inject({
        method: refusal.method,
        url: refusal.url,
        headers: {
          ...server.owner.headers,
          'content-type': refusal.type,
          'content-length': String(refusal.length),
        },
        payload: body.stream,
      });
      body.stream.destroy();
      expect(response.statusCode, response.body).toBe(refusal.status);
      expect(response.headers.connection).toBe('close');
      expect(body.pulls).toBe(0);
    } finally {
      server.config.driverInstalls = true;
    }
  }
});

it('closes a real connection with its refusal rather than waiting to read the declared body', async () => {
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = server.app.server.address() as AddressInfo;
  const socket = connect(port, '127.0.0.1');
  let answer = '';
  socket.setEncoding('utf8');
  socket.on('data', (text: string) => (answer += text));
  const closed = new Promise<'closed'>((resolve) => socket.once('close', () => resolve('closed')));
  // Headers that declare 100 MB of body, and not a byte of it sent
  socket.write(
    [
      `PUT ${UPLOAD} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Cookie: ${server.owner.headers.cookie}`,
      `X-CSRF-Token: ${server.owner.headers['x-csrf-token']}`,
      'Content-Type: text/plain',
      `Content-Length: ${100 * 1024 * 1024}`,
      '',
      '',
    ].join('\r\n'),
  );
  const outcome = await Promise.race([
    closed,
    new Promise<'open'>((resolve) => setTimeout(() => resolve('open'), 5_000)),
  ]);
  socket.destroy();
  expect(answer).toMatch(/^HTTP\/1\.1 400 /);
  expect(answer.toLowerCase()).toContain('connection: close');
  expect(outcome).toBe('closed');
});

it('keeps the normal body limit on the install route', async () => {
  const response = await server.app.inject({
    method: 'POST',
    url: INSTALL,
    headers: { ...server.owner.headers, 'content-type': 'application/json' },
    payload: JSON.stringify({ padding: 'x'.repeat(11 * 1024 * 1024) }),
  });
  expect(response.statusCode).toBe(413);
});

it('allows only owners and Data Sources administrators to install or remove', async () => {
  for (const headers of [undefined, member.headers]) {
    for (const [method, url] of [
      ['POST', INSTALL],
      ['PUT', UPLOAD],
      ['DELETE', '/api/source-drivers/teradatasql'],
    ] as const) {
      const response = await server.app.inject({
        method,
        url,
        headers: { ...headers, ...(method === 'PUT' ? { 'content-type': 'application/octet-stream' } : {}) },
        ...(method === 'POST' ? { payload: {} } : method === 'PUT' ? { payload: 'bytes' } : {}),
      });
      expect([401, 403]).toContain(response.statusCode);
    }
  }
  const listing = await server.app.inject({
    method: 'GET',
    url: '/api/source-drivers',
    headers: server.owner.headers,
  });
  expect(listing.statusCode).toBe(200);
  const driver = listing.json<SourceDrivers>().drivers[0]!;
  // The registry answers with bytes that aren't the pinned archive.
  const network = vi.fn(async () => new Response(new Uint8Array(Buffer.from('changed archive'))));
  vi.stubGlobal('fetch', network);
  for (const identity of [server.owner, member]) {
    if (identity === member)
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET admin_roles=ARRAY['data_sources'] WHERE user_id=${member.userId}`,
      );
    const upload = await server.app.inject({
      method: 'PUT',
      url: UPLOAD,
      headers: { ...identity.headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('invalid archive'),
    });
    expect(upload.statusCode).toBe(422);
    expect(upload.json().error.messageKey).toBe('sources.drivers.integrity');
    const offline = await server.app.inject({
      method: 'POST',
      url: INSTALL,
      headers: identity.headers,
      payload: { licenseHash: driver.licenseHash, catalogHash: driver.catalogHash, offline: true },
    });
    expect(offline.statusCode).toBe(422);
    expect(offline.json().error.messageKey).toBe('sources.drivers.uploadsRequired');
    const install = await server.app.inject({
      method: 'POST',
      url: INSTALL,
      headers: identity.headers,
      payload: { licenseHash: driver.licenseHash, catalogHash: driver.catalogHash },
    });
    expect(install.statusCode).toBe(422);
    expect(install.json().error.messageKey).toBe('sources.drivers.integrity');
    const remove = await server.app.inject({
      method: 'DELETE',
      url: '/api/source-drivers/teradatasql',
      headers: identity.headers,
    });
    expect(remove.statusCode).toBe(204);
    const events = await query<{ action: string; metadata: Record<string, unknown> }>(
      server.pool,
      sql`SELECT action,metadata FROM ${ident(server.schemas.audit, 'events')} WHERE actor_id=${identity.userId} AND action LIKE 'sources.drivers.%' ORDER BY at`,
    );
    expect(events.rows.map((event) => event.action)).toEqual([
      'sources.drivers.licenseAccepted',
      'sources.drivers.removing',
      'sources.drivers.removed',
    ]);
    expect(events.rows[0]!.metadata).toMatchObject({
      driverId: 'teradatasql',
      licenseHash: driver.licenseHash,
    });
  }
  expect(network).toHaveBeenCalledTimes(2);
});

it('refuses installs and uploads at the route when the operator turns them off', async () => {
  server.config.driverInstalls = false;
  try {
    for (const [method, url, type] of [
      ['POST', INSTALL, 'application/json'],
      ['PUT', UPLOAD, 'application/octet-stream'],
    ] as const) {
      const response = await server.app.inject({
        method,
        url,
        headers: { ...server.owner.headers, 'content-type': type },
        payload: method === 'POST' ? '{}' : 'bytes',
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.messageKey).toBe('sources.drivers.disabled');
    }
  } finally {
    server.config.driverInstalls = true;
  }
});
