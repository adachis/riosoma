import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { AttachmentMeta, newId } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { standIn } from './scan-test-support.js';
import { scanPendingFiles } from './scanning.js';

let kit: TestPostgres;
let server: ServerFixture;
let scanner: Awaited<ReturnType<typeof standIn>>;
let security: SignedIn;
beforeAll(async () => {
  kit = await startTestPostgres();
  scanner = await standIn();
  server = await startServer(kit, 'scannerreview');
  security = await server.addMember();
  const granted = await server.app.inject({
    method: 'POST',
    url: '/api/org/admin-commands',
    headers: server.owner.headers,
    payload: { kind: 'organization.roles', userId: security.userId, roles: ['security'] },
  });
  expect(granted.statusCode, granted.body).toBe(200);
}, 60_000);
beforeEach(async () => {
  Object.assign(server.config, { clamavApprovedUrls: [scanner.url] });
  await server.pool.query(`UPDATE "${server.schemas.app}".orgs SET settings = '{}' WHERE id = $1`, [
    server.owner.info.org.id,
  ]);
});
afterAll(async () => {
  await server?.close();
  await scanner?.close();
  await kit?.stop();
});

const settings = (address = scanner.url, oversizedPolicy = 'quarantine') => ({
  enabled: true,
  address,
  oversizedPolicy,
});
const save = (payload: object) =>
  server.app.inject({ method: 'PUT', url: '/api/org/files/scanner', headers: security.headers, payload });
async function upload(bytes = Buffer.from('private attachment contents')) {
  const databaseId = newId('database');
  const tableId = newId('table');
  const fieldId = newId('field');
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Private files',
      table: {
        id: tableId,
        name: 'Files',
        fields: [
          { id: newId('field'), name: 'Name', type: 'text' },
          { id: fieldId, name: 'Files', type: 'attachment' },
        ],
        view: { id: newId('view'), name: 'Grid' },
      },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const uploaded = await server.app.inject({
    method: 'POST',
    url: `/api/tables/${tableId}/fields/${fieldId}/files`,
    headers: {
      ...server.owner.headers,
      'content-type': 'application/octet-stream',
      'x-file-name': 'item.bin',
    },
    payload: bytes,
  });
  expect(uploaded.statusCode, uploaded.body).toBe(200);
  return AttachmentMeta.parse(uploaded.json());
}
async function state(id: string) {
  const result = await server.pool.query(
    `SELECT scan_state, scan_next_at = 'infinity'::timestamptz AS permanent FROM "${server.schemas.app}".files WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}
const download = (id: string) =>
  server.app.inject({ url: `/api/files/${id}/item.bin`, headers: server.owner.headers });

it('rejects unapproved destinations before probes or private attachment transmission', async () => {
  const receiver = await standIn();
  try {
    const file = await upload();
    const lookup = await server.app.inject({ url: `/api/files?ids=${file.id}`, headers: security.headers });
    expect(lookup.json()).toEqual([]);
    for (const action of ['detect', 'test']) {
      const result = await server.app.inject({
        method: 'POST',
        url: `/api/org/files/scanner/${action}`,
        headers: security.headers,
        payload: { address: receiver.url },
      });
      expect(result.statusCode).toBe(403);
    }
    expect((await save(settings(receiver.url))).statusCode).toBe(403);
    // A destination saved before approval was required must also fail closed in the worker.
    await server.pool.query(`UPDATE "${server.schemas.app}".orgs SET settings = $1 WHERE id = $2`, [
      JSON.stringify({ fileScanner: settings(receiver.url) }),
      server.owner.info.org.id,
    ]);
    await server.pool.query(
      `UPDATE "${server.schemas.app}".files SET scan_state = 'quarantined' WHERE id = $1`,
      [file.id],
    );
    await scanPendingFiles(server.app);
    await server.app.inject({ url: '/api/org/files/scanner', headers: security.headers });
    expect(receiver.received).toHaveLength(0);
    expect((await state(file.id)).scan_state).toBe('quarantined');
    expect((await download(file.id)).statusCode).toBe(404);
  } finally {
    await receiver.close();
  }
});

it('keeps metadata-only archive attachments permanently unavailable when the scanner changes', async () => {
  const file = await upload();
  await server.pool.query(`DELETE FROM "${server.schemas.app}".file_chunks WHERE storage_key = $1`, [
    file.id,
  ]);
  await server.pool.query(
    `UPDATE "${server.schemas.app}".files SET scan_state = 'unavailable', scan_next_at = 'infinity' WHERE id = $1`,
    [file.id],
  );
  expect((await save(settings())).statusCode).toBe(200);
  await scanPendingFiles(server.app);
  expect(await state(file.id)).toEqual({ scan_state: 'unavailable', permanent: true });
  expect((await download(file.id)).statusCode).toBe(404);
});

it.each([0, 4, 40])(
  'refuses to release stored contents of %i bytes when metadata requires the complete file',
  async (length) => {
    expect((await save(settings())).statusCode).toBe(200);
    const file = await upload();
    await server.pool.query(`DELETE FROM "${server.schemas.app}".file_chunks WHERE storage_key = $1`, [
      file.id,
    ]);
    if (length) {
      await server.pool.query(
        `INSERT INTO "${server.schemas.app}".file_chunks (storage_key, position, bytes) VALUES ($1, 0, $2)`,
        [file.id, Buffer.alloc(length, 0x61)],
      );
    }
    await scanPendingFiles(server.app);
    expect((await state(file.id)).scan_state).toBe('quarantined');
    expect((await download(file.id)).statusCode).toBe(404);
  },
);

it('revokes unscanned downloads during an outage without disabling scanning', async () => {
  const limited = await standIn({ maxBytes: 100 });
  Object.assign(server.config, { clamavApprovedUrls: [scanner.url, limited.url] });
  let closed = false;
  try {
    expect((await save(settings(limited.url, 'allow'))).statusCode).toBe(200);
    const file = await upload(Buffer.alloc(200, 0x61));
    await scanPendingFiles(server.app);
    expect((await state(file.id)).scan_state).toBe('too_large_allowed');
    expect((await download(file.id)).statusCode).toBe(200);
    await limited.close();
    closed = true;
    const result = await save(settings(limited.url));
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().settings.enabled).toBe(true);
    expect((await state(file.id)).scan_state).toBe('too_large');
    expect((await download(file.id)).statusCode).toBe(404);
  } finally {
    if (!closed) await limited.close();
  }
});

it('keeps scanner settings and diagnostics out of ordinary and effective session settings', async () => {
  expect((await save(settings())).statusCode).toBe(200);
  const guest = await server.addMember({ kind: 'guest' });
  expect(
    (await server.app.inject({ url: '/api/org/files/scanner', headers: guest.headers })).statusCode,
  ).toBe(403);
  for (const unitPolicy of [false, true]) {
    if (unitPolicy) {
      await server.pool.query(
        `UPDATE "${server.schemas.app}".orgs SET settings = settings || '{"unitPolicy":{}}' WHERE id = $1`,
        [server.owner.info.org.id],
      );
    }
    const response = await server.app.inject({ url: '/api/auth/session', headers: guest.headers });
    expect(response.statusCode, response.body).toBe(200);
    const info = response.json();
    expect(info.org.settings).not.toHaveProperty('fileScanner');
    expect(info.org.settings).not.toHaveProperty('fileScannerStatus');
    if (unitPolicy) expect(info.effectiveSettings).toBeDefined();
    expect(info.effectiveSettings ?? {}).not.toHaveProperty('fileScanner');
    expect(info.effectiveSettings ?? {}).not.toHaveProperty('fileScannerStatus');
  }
  const authorized = await server.app.inject({ url: '/api/org/files/scanner', headers: security.headers });
  expect(authorized.json()).toMatchObject({
    settings: settings(),
    status: { address: scanner.url, reachable: true },
  });
});

it('requires a new signature test for an active address change and leaves policy-only saves available', async () => {
  expect((await save(settings())).statusCode).toBe(200);
  const before = scanner.received.length;
  expect((await save(settings(scanner.url, 'allow'))).statusCode).toBe(200);
  expect(scanner.received).toHaveLength(before);
  const failing = await standIn({ result: 'stream: OK\0' });
  server.config.clamavApprovedUrls!.push(failing.url);
  try {
    expect((await save(settings(failing.url))).statusCode).toBe(503);
    const current = await server.app.inject({ url: '/api/org/files/scanner', headers: security.headers });
    expect(current.json().settings).toEqual(settings(scanner.url, 'allow'));
  } finally {
    await failing.close();
  }
});

it('audits scanner commands and guards undo against a later settings change', async () => {
  const command = (payload: object) =>
    server.app.inject({
      method: 'POST',
      url: '/api/org/admin-commands',
      headers: security.headers,
      payload,
    });
  const changed = await command({ kind: 'organization.files.scanner', ...settings() });
  expect(changed.statusCode, changed.body).toBe(200);
  expect(changed.json().undoable).toBe(true);
  const undone = await command({ kind: 'organization.undo', eventId: changed.json().eventId });
  expect(undone.statusCode, undone.body).toBe(200);
  expect(undone.json().fileScanner.settings).toEqual({
    enabled: false,
    address: null,
    oversizedPolicy: 'quarantine',
  });
  const next = await command({ kind: 'organization.files.scanner', ...settings() });
  expect(next.statusCode).toBe(200);
  expect((await save(settings(scanner.url, 'allow'))).statusCode).toBe(200);
  expect((await command({ kind: 'organization.undo', eventId: next.json().eventId })).statusCode).toBe(409);
});
