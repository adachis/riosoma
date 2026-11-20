import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AttachmentMeta, newId, type CommandBatchResult } from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { writeArchive } from '../archives/write.js';
import { actorFor } from '../../automations/run.js';
import { AccessScope } from '../access.js';
import * as storageModule from './storage.js';
import { scanPendingFiles } from './scanning.js';
import { eicar, standIn, unreachableScanner } from './scan-test-support.js';

let kit: TestPostgres;
let server: ServerFixture;
let scanner: Awaited<ReturnType<typeof standIn>>;
beforeAll(async () => {
  kit = await startTestPostgres();
  scanner = await standIn();
  server = await startServer(kit, 'scanning');
  // Tests drive the queue explicitly to inspect the quarantine boundary before a scan starts.
  server.config.clamavUrl = scanner.url;
}, 60_000);
afterAll(async () => {
  await server?.close();
  await scanner?.close();
  await kit?.stop();
});

async function upload(bytes: Buffer) {
  const databaseId = newId('database');
  const tableId = newId('table');
  const fieldId = newId('field');
  const recordId = newId('record');
  const viewId = newId('view');
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Scans',
      table: {
        id: tableId,
        name: 'Scans',
        fields: [
          { id: newId('field'), name: 'Name', type: 'text' },
          { id: fieldId, name: 'Files', type: 'attachment' },
        ],
        view: { id: viewId, name: 'Grid' },
        records: [{ id: recordId, values: {} }],
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
      'x-file-name': 'scan-item.bin',
      'x-record-id': recordId,
    },
    payload: bytes,
  });
  expect(uploaded.statusCode, uploaded.body).toBe(200);
  const file = AttachmentMeta.parse(uploaded.json());
  const attached = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'record.update',
          tableId,
          records: [{ id: recordId, values: { [fieldId]: [file.id] } }],
        },
      ],
    },
  });
  expect(attached.json<CommandBatchResult>().results[0]?.status, attached.body).toBe('applied');
  return { file, viewId, databaseId };
}
async function details(id: string) {
  return (await server.app.inject({ url: `/api/files?ids=${id}`, headers: server.owner.headers })).json<
    AttachmentMeta[]
  >()[0]!;
}
async function refused(id: string) {
  for (const suffix of ['scan-item.bin', 'thumbnails/small', 'thumbnails/large']) {
    const response = await server.app.inject({
      url: `/api/files/${id}/${suffix}`,
      headers: server.owner.headers,
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers.location).toBeUndefined();
  }
}

describe('attachment quarantine', () => {
  it('blocks downloads, previews, and exports until a clean scan releases the file', async () => {
    const bytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer();
    const { file, viewId, databaseId } = await upload(bytes);
    expect(file.scanState).toBe('quarantined');
    expect(file.url).toBe('');
    expect(file.thumbnails).toEqual({ small: null, large: null });
    await refused(file.id);
    const exported = await server.app.inject({
      url: `/api/views/${viewId}/export?format=csv&locale=en-US&timeZone=UTC`,
      headers: server.owner.headers,
    });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.body).not.toContain(file.name);
    const actor = (await actorFor(
      server.pool,
      server.schemas,
      server.owner.userId,
      server.owner.info.org.id,
    ))!;
    const archive = await withTransaction(server.pool, (db) =>
      writeArchive(
        db,
        server.schemas,
        databaseId,
        { records: 'all', comments: false },
        new AccessScope(db, server.schemas, actor),
      ),
    );
    expect(archive.attachments).toEqual([]);
    expect(JSON.stringify(archive.tables)).not.toContain(file.id);
    await scanPendingFiles(server.app);
    const clean = await details(file.id);
    expect(clean.scanState).toBe('clean');
    expect(clean.thumbnails.small).toBeTruthy();
    const downloaded = await server.app.inject({ url: clean.url, headers: server.owner.headers });
    expect(downloaded.rawPayload).toEqual(bytes);
  });

  it('deletes infected bytes, retains the signature, notifies the uploader, and audits the result', async () => {
    const { file } = await upload(eicar);
    await scanPendingFiles(server.app);
    expect(await details(file.id)).toMatchObject({
      scanState: 'infected',
      scanSignature: 'Eicar-Test-Signature',
    });
    await refused(file.id);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT 1 FROM ${ident(server.schemas.app, 'file_chunks')} WHERE storage_key = ${file.id}`,
        )
      ).rowCount,
    ).toBe(0);
    const notices = await query<{ target: unknown }>(
      server.pool,
      sql`SELECT target FROM ${ident(server.schemas.app, 'notifications')}
      WHERE subject_id = ${file.id} AND recipient_id = ${server.owner.userId} AND kind = 'fileScan'`,
    );
    expect(notices.rows).toHaveLength(1);
    expect(notices.rows[0]!.target).toMatchObject({ reason: { messageKey: 'files.infected' } });
    expect(
      (
        await query(
          server.pool,
          sql`SELECT 1 FROM ${ident(server.schemas.audit, 'events')}
      WHERE org_id = ${server.owner.info.org.id} AND action = 'data.file.infected' AND metadata ->> 'fileId' = ${file.id}`,
        )
      ).rowCount,
    ).toBe(1);
  });

  it('retains an infected verdict when deletion fails and retries without rescanning', async () => {
    const { file } = await upload(eicar);
    const before = scanner.received.length;
    const original = storageModule.fileStorage;
    const spy = vi.spyOn(storageModule, 'fileStorage').mockImplementation((...args) => {
      const storage = original(...args);
      return {
        ...storage,
        delete: async () => {
          throw new Error('Deletion interrupted');
        },
      };
    });
    try {
      await expect(scanPendingFiles(server.app)).rejects.toThrow('Deletion interrupted');
    } finally {
      spy.mockRestore();
    }
    expect(await details(file.id)).toMatchObject({
      scanState: 'quarantined',
      scanSignature: 'Eicar-Test-Signature',
    });
    await refused(file.id);
    await scanPendingFiles(server.app);
    expect((await details(file.id)).scanState).toBe('infected');
    expect(scanner.received.length).toBe(before + 1);
  });

  it('retries an unavailable scanner, alerts administrators after an hour, and never releases unscanned bytes', async () => {
    // A daemon that is gone answers from no port at all, rather than from one another test may hold.
    server.config.clamavUrl = await unreachableScanner();
    try {
      const { file } = await upload(Buffer.from('safe'));
      await scanPendingFiles(server.app);
      expect((await details(file.id)).scanState).toBe('quarantined');
      const next = await query<{ future: boolean }>(
        server.pool,
        sql`SELECT scan_next_at > now() AS future
        FROM ${ident(server.schemas.app, 'files')} WHERE id = ${file.id}`,
      );
      expect(next.rows[0]!.future).toBe(true);
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'files')}
        SET created_at = now() - interval '61 minutes', scan_next_at = now() WHERE id = ${file.id}`,
      );
      await scanPendingFiles(server.app);
      expect((await details(file.id)).scanState).toBe('unavailable');
      await refused(file.id);
      const notices = await query(
        server.pool,
        sql`SELECT 1 FROM ${ident(server.schemas.app, 'notifications')}
        WHERE subject_id = ${file.id} AND kind = 'fileScan'`,
      );
      expect(notices.rowCount).toBeGreaterThan(0);
      delete server.config.clamavUrl;
      await scanPendingFiles(server.app);
      await refused(file.id);
      server.config.clamavUrl = scanner.url;
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'files')} SET scan_next_at = now() WHERE id = ${file.id}`,
      );
      await scanPendingFiles(server.app);
      expect((await details(file.id)).scanState).toBe('clean');
    } finally {
      server.config.clamavUrl = scanner.url;
    }
  });

  it('keeps oversized files quarantined by default and allows only explicitly labeled unscanned downloads', async () => {
    const limited = await standIn({ maxBytes: 100 });
    server.config.clamavApprovedUrls = [limited.url];
    const configure = async (enabled: boolean, oversizedPolicy: 'allow' | 'quarantine') => {
      const response = await server.app.inject({
        method: 'PUT',
        url: '/api/org/files/scanner',
        headers: server.owner.headers,
        payload: { enabled, address: limited.url, oversizedPolicy },
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    try {
      await configure(true, 'quarantine');
      const bytes = Buffer.alloc(200, 0x61);
      const { file } = await upload(bytes);
      await scanPendingFiles(server.app);
      expect(await details(file.id)).toMatchObject({ scanState: 'too_large', scanSignature: null, url: '' });
      await refused(file.id);
      await configure(true, 'allow');
      const allowed = await details(file.id);
      expect(allowed).toMatchObject({ scanState: 'too_large_allowed', scanSignature: null });
      const download = await server.app.inject({ url: allowed.url, headers: server.owner.headers });
      expect(download.statusCode).toBe(200);
      expect(download.rawPayload).toEqual(bytes);
      expect(download.headers['cache-control']).toContain('no-store');
      await configure(true, 'quarantine');
      await refused(file.id);
      expect((await details(file.id)).scanState).toBe('too_large');

      const pending = await upload(Buffer.from('safe'));
      await configure(false, 'quarantine');
      await scanPendingFiles(server.app);
      expect((await details(pending.file.id)).scanState).toBe('quarantined');
      await refused(pending.file.id);
      expect((await upload(Buffer.from('scanning is off'))).file.scanState).toBe('clean');
      await configure(true, 'quarantine');
      await scanPendingFiles(server.app);
      expect((await details(pending.file.id)).scanState).toBe('clean');
    } finally {
      await server.pool.query(
        `UPDATE "${server.schemas.app}".orgs SET settings = settings - 'fileScanner' - 'fileScannerStatus' WHERE id = $1`,
        [server.owner.info.org.id],
      );
      await limited.close();
      delete server.config.clamavApprovedUrls;
    }
  });

  it('does not call an engine or mark a file clean past its internal size ceiling', async () => {
    const { file } = await upload(Buffer.from('safe'));
    await server.pool.query(`UPDATE "${server.schemas.app}".files SET size = 2147483648 WHERE id = $1`, [
      file.id,
    ]);
    const received = scanner.received.length;
    await scanPendingFiles(server.app);
    expect((await details(file.id)).scanState).toBe('too_large');
    expect(scanner.received).toHaveLength(received);
    await refused(file.id);
  });

  it('starts scanning automatically when the admin enables a saved organization policy', async () => {
    try {
      const enabled = await server.app.inject({
        method: 'PUT',
        url: '/api/org/files/scanner',
        headers: server.owner.headers,
        payload: { enabled: true, address: scanner.url, oversizedPolicy: 'quarantine' },
      });
      expect(enabled.statusCode, enabled.body).toBe(200);
      const { file } = await upload(Buffer.from('scan automatically'));
      await vi.waitFor(async () => expect((await details(file.id)).scanState).toBe('clean'), {
        timeout: 12_000,
        interval: 100,
      });
    } finally {
      await server.pool.query(
        `UPDATE "${server.schemas.app}".orgs SET settings = settings - 'fileScanner' - 'fileScannerStatus' WHERE id = $1`,
        [server.owner.info.org.id],
      );
    }
  });
});
