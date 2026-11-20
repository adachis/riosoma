import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AttachmentMeta,
  FILE_LIMITS,
  newId,
  type CommandBatchResult,
  type RowData,
  type RowsPage,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { AZURITE_URL, S3_URL, azureRequest, s3Request, testAzure, testS3 } from '../../test/stores.js';
import { cleanupUnattached } from './cleanup.js';
import { CHUNK_BYTES } from './storage.js';
import * as storageModule from './storage.js';

const TEST_UPLOAD_BYTES = 3 * 1024 * 1024;

let kit: TestPostgres;
beforeAll(async () => {
  kit = await startTestPostgres();
}, 60_000);
afterAll(async () => {
  await kit?.stop();
});

function newTable(name: string) {
  return {
    id: newId('table'),
    name,
    fields: [
      { id: newId('field'), name: 'Name', type: 'text' },
      { id: newId('field'), name: 'Files', type: 'attachment' },
      { id: newId('field'), name: 'Other files', type: 'attachment' },
    ],
    view: { id: newId('view'), name: 'Grid' },
    records: [],
  };
}

function checkHeaders(headers: Record<string, unknown>) {
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['content-security-policy']).toBe(
    "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
  );
  expect(headers['cache-control']).toBe('private, max-age=31536000, immutable');
  expect(headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
}

// Buckets and containers join in when their test services are named (see test/stores.ts).
const kinds = [
  'postgres',
  'local',
  ...(S3_URL ? (['s3'] as const) : []),
  ...(AZURITE_URL ? (['azure-blob'] as const) : []),
] as const;

describe.each(kinds)('%s file storage', (kind) => {
  let server: ServerFixture;
  let directory: string;
  let origin: string;
  const clientId = newId('client');
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rio-files-test-'));
    const stores =
      kind === 's3'
        ? { filesS3: await testS3('files') }
        : kind === 'azure-blob'
          ? { filesAzure: await testAzure('files') }
          : {};
    server = await startServer(kit, `files_${kind.replace('-', '_')}`, {
      filesStorage: kind,
      filesDir: directory,
      ...stores,
    });
    const configured = await server.app.inject({
      method: 'POST',
      url: '/api/org/admin-commands',
      headers: server.owner.headers,
      payload: {
        kind: 'organization.files',
        maxUploadBytes: TEST_UPLOAD_BYTES,
        revision: (await server.app.inject({ url: '/api/org/files', headers: server.owner.headers })).json()
          .revision,
      },
    });
    expect(configured.statusCode, configured.body).toBe(200);
    origin = await server.app.listen({ port: 0, host: '127.0.0.1' });
  }, 60_000);

  /** What's stored: the folder's files, or the objects under the bucket's or container's prefix. */
  async function stored(): Promise<string[]> {
    if (kind === 'local' || kind === 'postgres') return readdir(directory);
    const s3 = server.config.filesS3;
    const azure = server.config.filesAzure;
    const response = s3
      ? await s3Request(s3, 'GET', `?list-type=2&prefix=${encodeURIComponent(s3.prefix)}`)
      : await azureRequest(
          azure!,
          'GET',
          `/${azure!.container}?restype=container&comp=list&include=uncommittedblobs&prefix=${encodeURIComponent(azure!.prefix)}`,
        );
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const prefix = s3?.prefix ?? azure!.prefix;
    return [...text.matchAll(s3 ? /<Key>([^<]+)<\/Key>/g : /<Name>([^<]+)<\/Name>/g)].map((match) =>
      match[1]!.slice(prefix.length),
    );
  }
  afterAll(async () => {
    await server?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function send(databaseId: string, input: Record<string, unknown>, error?: string) {
    const groupId = newId('action');
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/commands`,
      headers: server.owner.headers,
      payload: { clientId, commands: [{ id: newId('command'), groupId, ...input }] },
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<CommandBatchResult>().results[0]!;
    if (error) expect(result.error?.messageKey, response.body).toBe(error);
    else expect(result.status, response.body).toBe('applied');
    return groupId;
  }
  async function get<T>(url: string): Promise<T> {
    const response = await server.app.inject({ url, headers: server.owner.headers });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<T>();
  }
  async function setup() {
    const databaseId = newId('database');
    const table = newTable('Documents');
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: server.owner.headers,
      payload: { id: databaseId, name: 'Attachments', table },
    });
    expect(response.statusCode, response.body).toBe(200);
    const fieldId = table.fields[1]!.id;
    const uploadUrl = `/api/tables/${table.id}/fields/${fieldId}/files`;
    const upload = async (bytes: Buffer, name = 'file.txt', type = 'application/octet-stream') => {
      const response = await server.app.inject({
        method: 'POST',
        url: uploadUrl,
        headers: { ...server.owner.headers, 'content-type': type, 'x-file-name': encodeURIComponent(name) },
        payload: bytes,
      });
      expect(response.statusCode, response.body).toBe(200);
      return AttachmentMeta.parse(response.json());
    };
    const create = async (values: Record<string, unknown>[] = [{}]) => {
      const ids = values.map(() => newId('record'));
      await send(databaseId, {
        kind: 'record.create',
        tableId: table.id,
        records: ids.map((id, i) => ({ id, values: values[i] })),
      });
      return ids;
    };
    const edit = (id: string, value: unknown, error?: string, target = fieldId) =>
      send(
        databaseId,
        { kind: 'record.update', tableId: table.id, records: [{ id, values: { [target]: value } }] },
        error,
      );
    const read = (id: string) =>
      get<RowData & { attachments: Record<string, AttachmentMeta> }>(`/api/tables/${table.id}/records/${id}`);
    const page = () => get<RowsPage>(`/api/views/${table.view.id}/rows?refresh=1`);
    const undo = async (groupId: string, direction = 'undo') => {
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/databases/${databaseId}/${direction}`,
        headers: server.owner.headers,
        payload: { commandId: newId('command'), clientId, groupId },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ status: 'applied', skipped: 0 });
    };
    return { databaseId, table, fieldId, uploadUrl, upload, create, edit, read, page, undo };
  }

  it('streams exact bytes across chunk boundaries and keeps safe names, hashes, and headers', async () => {
    const f = await setup();
    const bytes = Buffer.alloc(CHUNK_BYTES * 2 + 71, 0x61);
    bytes[CHUNK_BYTES - 1] = 0x62;
    const file = await f.upload(bytes, '../folder\\résumé\n.txt', 'text/html');
    expect(file).toMatchObject({
      name: '..folderrésumé.txt',
      size: bytes.length,
      type: 'text/plain',
      width: null,
      height: null,
      thumbnails: { small: null, large: null },
    });
    const download = await server.app.inject({ url: file.url, headers: server.owner.headers });
    expect(download.statusCode).toBe(200);
    // Compare bytes directly so a large buffer does not spend the test's time enumerating properties.
    expect(download.rawPayload.equals(bytes)).toBe(true);
    expect(Number(download.headers['content-length'])).toBe(bytes.length);
    expect(download.headers.etag).toBe(`"${createHash('sha256').update(bytes).digest('hex')}"`);
    expect(download.headers['content-disposition']).toContain(
      "filename*=UTF-8''..folderr%C3%A9sum%C3%A9.txt",
    );
    checkHeaders(download.headers);
    const conditional = await server.app.inject({
      url: file.url,
      headers: { ...server.owner.headers, 'if-none-match': String(download.headers.etag) },
    });
    expect(conditional.statusCode).toBe(304);
    checkHeaders(conditional.headers);
    const chunks = await query<{ length: number }>(
      server.pool,
      sql`SELECT octet_length(bytes) AS length
      FROM ${ident(server.schemas.app, 'file_chunks')} WHERE storage_key = ${file.id} ORDER BY position`,
    );
    expect(chunks.rows.map((row) => row.length)).toEqual(
      kind === 'postgres' ? [CHUNK_BYTES, CHUNK_BYTES, 71] : [],
    );
    if (kind !== 'postgres') expect(await stored()).toContain(file.id);
    expect((await f.upload(Buffer.alloc(0))).size).toBe(0);
    for (const name of ['a'.repeat(300), 'é'.repeat(300), '😀'.repeat(150)]) {
      const long = await f.upload(Buffer.from('x'), name);
      expect(long.name.length).toBeLessThanOrEqual(255);
      expect(long.name.length).toBeGreaterThanOrEqual(254);
      const downloaded = await server.app.inject({ url: long.url, headers: server.owner.headers });
      expect(downloaded.statusCode).toBe(200);
      expect(downloaded.body).toBe('x');
    }
  }, 30_000);

  it('rejects declared and chunked oversize uploads with 413 and removes partial data', async () => {
    const f = await setup();
    const before = await query<{ count: string }>(
      server.pool,
      sql`SELECT count(*) FROM ${ident(server.schemas.app, 'file_chunks')}`,
    );
    const storedBefore = await stored();
    const declared = await server.app.inject({
      method: 'POST',
      url: f.uploadUrl,
      headers: {
        ...server.owner.headers,
        'x-file-name': 'large.bin',
        'content-type': 'application/octet-stream',
        'content-length': String(TEST_UPLOAD_BYTES + 1),
      },
      payload: Buffer.from('x'),
    });
    expect(declared.statusCode, declared.body).toBe(413);
    expect(declared.json().error.messageKey).toBe('data.file.tooLarge');
    const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(
        new URL(f.uploadUrl, origin),
        {
          method: 'POST',
          headers: {
            ...server.owner.headers,
            'x-file-name': 'large.bin',
            'content-type': 'application/octet-stream',
          },
        },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (part: string) => {
            body += part;
          });
          response.on('end', () => resolve({ status: response.statusCode!, body }));
        },
      );
      request.on('error', reject);
      void (async () => {
        for (let sent = 0; sent <= TEST_UPLOAD_BYTES; sent += 65536) {
          if (!request.write(Buffer.alloc(65536))) await once(request, 'drain');
        }
        request.end();
      })().catch(reject);
    });
    const streamed = await result;
    expect(streamed.status, streamed.body).toBe(413);
    expect(JSON.parse(streamed.body).error.messageKey).toBe('data.file.tooLarge');
    expect(
      (
        await query<{ count: string }>(
          server.pool,
          sql`SELECT count(*) FROM ${ident(server.schemas.app, 'file_chunks')}`,
        )
      ).rows,
    ).toEqual(before.rows);
    expect(await stored()).toEqual(storedBefore);
    expect(await get(`/api/files?ids=${newId('attachment')}`)).toEqual([]);
  });

  it('detects content signatures and downloads active or unknown content', async () => {
    const f = await setup();
    const box = (brand: string) => {
      const bytes = Buffer.alloc(24);
      bytes.writeUInt32BE(24);
      bytes.write(`ftyp${brand}`, 4);
      return bytes;
    };
    const zip = (name: string) => {
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50);
      header.writeUInt16LE(name.length, 26);
      return Buffer.concat([header, Buffer.from(name)]);
    };
    const cases: Array<[Buffer, string, boolean]> = [
      [Buffer.from('<!doctype html><script>alert(1)</script>'), 'application/octet-stream', false],
      [
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="9"><script/></svg>'),
        'image/svg+xml',
        false,
      ],
      [Buffer.from('%PDF-1.7\n'), 'application/pdf', true],
      [Buffer.from('GIF89a'), 'image/gif', true],
      [Buffer.from('RIFF0000WEBP'), 'image/webp', true],
      [Buffer.from('BM'), 'image/bmp', true],
      [Buffer.from('49492a00', 'hex'), 'image/tiff', true],
      [box('avif'), 'image/avif', true],
      [box('heic'), 'image/heic', true],
      [box('isom'), 'video/mp4', true],
      [box('qt  '), 'video/quicktime', true],
      [Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.from('webm')]), 'video/webm', true],
      [Buffer.from('ID3'), 'audio/mpeg', true],
      [Buffer.from('RIFF0000WAVE'), 'audio/wav', true],
      [Buffer.from('OggS'), 'audio/ogg', true],
      [Buffer.from('plain text'), 'text/plain', true],
      [
        zip('word/document.xml'),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        false,
      ],
      [zip('xl/workbook.xml'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', false],
      [
        zip('ppt/presentation.xml'),
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        false,
      ],
      [zip('other'), 'application/zip', false],
    ];
    for (const [bytes, type, inline] of cases) {
      const file = await f.upload(bytes, 'fake.png', 'text/html');
      expect(file.type).toBe(type);
      const response = await server.app.inject({ url: file.url, headers: server.owner.headers });
      expect(response.headers['content-type']).toContain(type);
      expect(response.headers['content-disposition']).toMatch(inline ? /^inline;/ : /^attachment;/);
      expect(response.rawPayload).toEqual(bytes);
      checkHeaders(response.headers);
    }
  });

  it('creates oriented, metadata-free WebP previews and tolerates broken and oversized images', async () => {
    const f = await setup();
    for (const rotation of [1, 6]) {
      const bytes = await sharp({ create: { width: 2000, height: 500, channels: 3, background: '#336699' } })
        .jpeg()
        .withMetadata({ orientation: rotation })
        .toBuffer();
      const file = await f.upload(bytes, 'photo.jpg');
      expect(file.type).toBe('image/jpeg');
      expect([file.width, file.height]).toEqual(rotation === 6 ? [500, 2000] : [2000, 500]);
      for (const [size, edge] of [
        ['small', 256],
        ['large', 1600],
      ] as const) {
        expect(file.thumbnails[size]).toBeTruthy();
        const response = await server.app.inject({
          url: file.thumbnails[size]!,
          headers: server.owner.headers,
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toBe('image/webp');
        expect(response.headers['content-disposition']).toMatch(/^inline;/);
        checkHeaders(response.headers);
        const metadata = await sharp(response.rawPayload).metadata();
        expect(metadata.format).toBe('webp');
        expect([metadata.width, metadata.height]).toEqual(
          rotation === 6 ? [edge / 4, edge] : [edge, edge / 4],
        );
        expect(metadata.exif).toBeUndefined();
        expect(metadata.orientation).toBeUndefined();
        expect(Number(response.headers['content-length'])).toBe(response.rawPayload.length);
        checkHeaders(response.headers);
      }
    }
    const png = await sharp({ create: { width: 30, height: 20, channels: 4, background: '#ffffff' } })
      .png()
      .toBuffer();
    expect(await f.upload(png, 'wrong.txt')).toMatchObject({ type: 'image/png', width: 30, height: 20 });
    const broken = await f.upload(Buffer.from('89504e470d0a1a0a', 'hex'));
    expect(broken.thumbnails).toEqual({ small: null, large: null });
    // A drawing behind a comment that reads as a file type box stays a drawing, with no preview.
    const disguised = await f.upload(
      Buffer.from(
        '<!--ftypabcd0000avif--><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 30"><rect width="40" height="30"/></svg>',
      ),
      'picture.avif',
    );
    expect(disguised).toMatchObject({
      type: 'image/svg+xml',
      width: null,
      height: null,
      thumbnails: { small: null, large: null },
    });
    const large = await sharp({ create: { width: 7100, height: 7100, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer();
    const huge = await f.upload(large);
    expect(huge).toMatchObject({ width: 7100, height: 7100, thumbnails: { small: null, large: null } });
  }, 30_000);

  it('keeps the original and removes partial previews when preview storage fails', async () => {
    const f = await setup();
    const original = storageModule.fileStorage;
    const failure = vi.spyOn(storageModule, 'fileStorage').mockImplementation((...args) => {
      const storage = original(...args);
      return {
        ...storage,
        async write(key, source) {
          if (key.endsWith('_large')) throw new Error('Preview write failed');
          return storage.write(key, source);
        },
      };
    });
    let file: AttachmentMeta;
    const bytes = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer();
    try {
      file = await f.upload(bytes);
    } finally {
      failure.mockRestore();
    }
    expect(file.thumbnails).toEqual({ small: null, large: null });
    expect(file.width).toBe(30);
    expect((await server.app.inject({ url: file.url, headers: server.owner.headers })).rawPayload).toEqual(
      bytes,
    );
    expect(
      (
        await query(
          server.pool,
          sql`SELECT 1 FROM ${ident(server.schemas.app, 'file_chunks')}
      WHERE storage_key = ANY(${[`${file.id}_small`, `${file.id}_large`]}::text[])`,
        )
      ).rowCount,
    ).toBe(0);
    if (kind !== 'postgres') expect(await stored()).not.toContain(`${file.id}_small`);
    const enormous = await f.upload(Buffer.from('<svg width="999999999999999" height="999999999999999"/>'));
    expect(enormous).toMatchObject({ width: null, height: null });
  });

  it('serves media ranges, suffixes, and complete responses when If-Range no longer matches', async () => {
    const f = await setup();
    const bytes = Buffer.alloc(CHUNK_BYTES + 50, 0x61);
    bytes.write('ID3');
    const file = await f.upload(bytes, 'sound.mp3');
    for (const [range, start, end] of [
      [`bytes=${CHUNK_BYTES - 3}-${CHUNK_BYTES + 3}`, CHUNK_BYTES - 3, CHUNK_BYTES + 3],
      ['bytes=-7', bytes.length - 7, bytes.length - 1],
      ['bytes=10-', 10, bytes.length - 1],
    ] as const) {
      const response = await server.app.inject({
        url: file.url,
        headers: { ...server.owner.headers, range },
      });
      expect(response.statusCode).toBe(206);
      expect(response.rawPayload.equals(bytes.subarray(start, end + 1))).toBe(true);
      expect(response.headers['content-range']).toBe(`bytes ${start}-${end}/${bytes.length}`);
      expect(Number(response.headers['content-length'])).toBe(end - start + 1);
      checkHeaders(response.headers);
    }
    for (const range of ['bytes=999999999-', 'bytes=9-1', 'bytes=-0', 'bytes=0-1,3-4']) {
      const response = await server.app.inject({
        url: file.url,
        headers: { ...server.owner.headers, range },
      });
      expect(response.statusCode, response.body).toBe(416);
      expect(response.json().error.messageKey).toBe('data.file.range');
      checkHeaders(response.headers);
    }
    const full = await server.app.inject({
      url: file.url,
      headers: { ...server.owner.headers, range: 'bytes=0-2', 'if-range': '"old"' },
    });
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.equals(bytes)).toBe(true);
  });

  it('authorizes uploads, downloads, previews, and details without revealing inaccessible files', async () => {
    const f = await setup();
    const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer();
    const file = await f.upload(image);
    const stranger = await server.addMember();
    for (const url of [file.url, file.thumbnails.small!]) {
      expect((await server.app.inject({ url })).statusCode).toBe(401);
      expect((await server.app.inject({ url, headers: stranger.headers })).statusCode).toBe(404);
    }
    const hidden = await server.app.inject({ url: `/api/files?ids=${file.id}`, headers: stranger.headers });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json()).toEqual([]);
    const other = await setup();
    for (const url of [
      `/api/tables/${other.table.id}/fields/${f.fieldId}/files`,
      `/api/tables/${f.table.id}/fields/${f.table.fields[0]!.id}/files`,
    ]) {
      const response = await server.app.inject({
        method: 'POST',
        url,
        headers: {
          ...server.owner.headers,
          'content-type': 'application/octet-stream',
          'x-file-name': 'test',
        },
        payload: Buffer.from('x'),
      });
      expect(response.statusCode).toBe(404);
    }
    const foreignUpload = await server.app.inject({
      method: 'POST',
      url: f.uploadUrl,
      headers: { ...stranger.headers, 'content-type': 'application/octet-stream', 'x-file-name': 'test' },
      payload: Buffer.from('x'),
    });
    expect(foreignUpload.statusCode).toBe(404);
    const grant = await server.app.inject({
      method: 'PUT',
      url: `/api/databases/${f.databaseId}/grants`,
      headers: server.owner.headers,
      payload: { principal: { kind: 'user', id: stranger.userId }, role: 'reader' },
    });
    expect(grant.statusCode).toBe(200);
    for (const url of [file.url, file.thumbnails.small!]) {
      expect((await server.app.inject({ url, headers: stranger.headers })).statusCode).toBe(200);
    }
    const readerUpload = await server.app.inject({
      method: 'POST',
      url: f.uploadUrl,
      headers: {
        ...stranger.headers,
        'content-type': 'application/octet-stream',
        'x-file-name': 'test',
      },
      payload: Buffer.from('x'),
    });
    expect(readerUpload.statusCode).toBe(403);
    const noSession = await server.app.inject({
      method: 'POST',
      url: f.uploadUrl,
      headers: { 'content-type': 'application/octet-stream', 'x-file-name': 'test' },
      payload: Buffer.from('x'),
    });
    expect(noSession.statusCode).toBe(401);
    const noCsrf = await server.app.inject({
      method: 'POST',
      url: f.uploadUrl,
      headers: {
        cookie: server.owner.headers.cookie,
        'content-type': 'application/octet-stream',
        'x-file-name': 'test',
      },
      payload: Buffer.from('x'),
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(await get(`/api/files?ids=${file.id},${newId('attachment')}`)).toEqual([file]);
    const tooMany = await server.app.inject({
      url: `/api/files?ids=${Array.from({ length: FILE_LIMITS.detailsPerRequest + 1 }, () => file.id).join(',')}`,
      headers: server.owner.headers,
    });
    expect(tooMany.statusCode).toBe(422);
    for (const name of ['%ZZ', '%00%2F', '...']) {
      const response = await server.app.inject({
        method: 'POST',
        url: f.uploadUrl,
        headers: { ...server.owner.headers, 'x-file-name': name, 'content-type': 'application/octet-stream' },
        payload: Buffer.from('x'),
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().error.messageKey).toBe('data.file.name');
    }
  });

  it('keeps files in their own field, lets records share them, carries details, and supports undo and redo', async () => {
    const f = await setup();
    const first = await f.upload(Buffer.from('one'), 'First.txt');
    const second = await f.upload(Buffer.from('two'), 'Second.txt');
    const [a, b] = await f.create([{ [f.fieldId]: [first.id] }, {}]);
    // Copying a file to another record of the same field works, which is what pasting attachments needs.
    await f.edit(b!, [first.id]);
    await f.edit(b!, []);
    await f.edit(a!, [second.id], 'data.file.unknown', f.table.fields[2]!.id);
    await f.edit(a!, [newId('attachment')], 'data.file.unknown');
    await f.edit(a!, [second.id, first.id]);
    expect((await f.read(a!)).values[f.fieldId]).toEqual([second.id, first.id]);
    expect((await f.read(a!)).attachments).toEqual({ [first.id]: first, [second.id]: second });
    expect((await f.page()).attachments).toEqual({ [first.id]: first, [second.id]: second });
    const group = await f.edit(a!, []);
    await f.undo(group);
    expect((await f.read(a!)).values[f.fieldId]).toEqual([second.id, first.id]);
    await f.undo(group, 'redo');
    expect((await f.read(a!)).values[f.fieldId]).toBeNull();
    await f.undo(group);
    expect((await f.read(a!)).values[f.fieldId]).toEqual([second.id, first.id]);
    const fresh = await f.upload(Buffer.from('fresh'));
    await send(f.databaseId, {
      kind: 'record.create',
      tableId: f.table.id,
      records: [
        { id: newId('record'), values: { [f.fieldId]: [fresh.id] } },
        { id: newId('record'), values: { [f.fieldId]: [fresh.id] } },
      ],
    });
    expect((await f.page()).total).toBe(4);
    const [state] = (
      await query<{ attached_at: Date | null }>(
        server.pool,
        sql`SELECT attached_at FROM ${ident(server.schemas.app, 'files')} WHERE id = ${fresh.id}`,
      )
    ).rows;
    expect(state?.attached_at).not.toBeNull();
    await f.edit(b!, [fresh.id]);
  });

  it('lets concurrent writes share a file and ignores superseded cell writes', async () => {
    const f = await setup();
    const file = await f.upload(Buffer.from('shared'));
    const [a, b] = await f.create([{}, {}]);
    const write = (id: string) =>
      server.app.inject({
        method: 'POST',
        url: `/api/databases/${f.databaseId}/commands`,
        headers: server.owner.headers,
        payload: {
          clientId,
          commands: [
            {
              id: newId('command'),
              groupId: newId('action'),
              kind: 'record.update',
              tableId: f.table.id,
              records: [{ id, values: { [f.fieldId]: [file.id] } }],
            },
          ],
        },
      });
    const responses = await Promise.all([write(a!), write(b!)]);
    const results = responses.map((response) => response.json<CommandBatchResult>().results[0]!);
    expect(results.map((result) => result.status)).toEqual(['applied', 'applied']);
    const unused = await f.upload(Buffer.from('unused'));
    const [empty] = await f.create();
    await send(f.databaseId, {
      kind: 'record.update',
      tableId: f.table.id,
      records: [
        { id: empty, values: { [f.fieldId]: [unused.id] } },
        { id: empty, values: { [f.fieldId]: [] } },
      ],
    });
    expect((await f.read(empty!)).values[f.fieldId]).toBeNull();
    expect(
      (
        await query<{ attached_at: Date | null }>(
          server.pool,
          sql`SELECT attached_at
      FROM ${ident(server.schemas.app, 'files')} WHERE id = ${unused.id}`,
        )
      ).rows[0]?.attached_at,
    ).toBeNull();
    const other = await setup();
    const [foreign] = await other.create();
    await other.edit(foreign!, [unused.id], 'data.file.unknown');
  });

  it('matches file names and empty lists, sorts by the first filename, and converts both ways', async () => {
    const f = await setup();
    const ten = await f.upload(Buffer.from('ten'), 'File 10.txt');
    const two = await f.upload(Buffer.from('two'), 'File 2.txt');
    const other = await f.upload(Buffer.from('other'), 'Another.txt');
    const [a, b, empty] = await f.create([
      { [f.fieldId]: [ten.id, other.id] },
      { [f.fieldId]: [two.id] },
      {},
    ]);
    for (const [operator, value, ids] of [
      ['contains', 'ANOTHER', [a]],
      ['doesNotContain', 'file 2', [a, empty]],
      ['contains', 'txt, Another', []],
      ['contains', '%', []],
      ['isEmpty', undefined, [empty]],
      ['isNotEmpty', undefined, [a, b]],
    ] as const) {
      await send(f.databaseId, {
        kind: 'view.update',
        viewId: f.table.view.id,
        config: {
          filter: { conjunction: 'and', conditions: [{ id: 'f', fieldId: f.fieldId, operator, value }] },
        },
      });
      expect((await f.page()).rows.map((row) => row?.id)).toEqual(ids);
    }
    for (const direction of ['asc', 'desc']) {
      await send(f.databaseId, {
        kind: 'view.update',
        viewId: f.table.view.id,
        config: { filter: null, sorts: [{ fieldId: f.fieldId, direction }] },
      });
      expect((await f.page()).rows.map((row) => row?.id)).toEqual(
        direction === 'asc' ? [b, a, empty] : [a, b, empty],
      );
    }
    const convert = (type: string) => ({
      kind: 'field.convert',
      fieldId: f.fieldId,
      to: { type },
      dateOrder: 'mdy',
      timeZone: 'UTC',
    });
    const text = await send(f.databaseId, convert('text'));
    expect((await f.read(a!)).values[f.fieldId]).toBe('File 10.txt, Another.txt');
    const preview = await server.app.inject({
      method: 'POST',
      url: `/api/fields/${f.fieldId}/conversion-preview`,
      headers: server.owner.headers,
      payload: { to: { type: 'attachment' }, dateOrder: 'mdy', timeZone: 'UTC' },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ total: 2, emptied: 2, converted: 0 });
    await f.undo(text);
    expect((await f.read(a!)).values[f.fieldId]).toEqual([ten.id, other.id]);
    await f.undo(text, 'redo');
    const cleared = await send(f.databaseId, convert('attachment'));
    expect((await f.read(a!)).values[f.fieldId]).toBeNull();
    await f.undo(cleared);
    expect((await f.read(a!)).values[f.fieldId]).toBe('File 10.txt, Another.txt');
  });

  it('cleans up old unattached bytes and previews while keeping recent uploads and history', async () => {
    const f = await setup();
    const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer();
    const unused = await f.upload(image);
    const recent = await f.upload(image);
    const attached = await f.upload(image);
    const [id] = await f.create([{ [f.fieldId]: [attached.id] }]);
    const removed = await f.edit(id!, []);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'files')} SET created_at = now() - interval '25 hours'
      WHERE id = ANY(${[unused.id, attached.id]}::text[])`,
    );
    await cleanupUnattached(server.ctx);
    expect((await server.app.inject({ url: unused.url, headers: server.owner.headers })).statusCode).toBe(
      404,
    );
    expect(
      (await server.app.inject({ url: unused.thumbnails.small!, headers: server.owner.headers })).statusCode,
    ).toBe(404);
    expect((await server.app.inject({ url: recent.url, headers: server.owner.headers })).statusCode).toBe(
      200,
    );
    expect((await server.app.inject({ url: attached.url, headers: server.owner.headers })).statusCode).toBe(
      200,
    );
    await f.undo(removed);
    expect((await f.read(id!)).values[f.fieldId]).toEqual([attached.id]);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT 1 FROM ${ident(server.schemas.app, 'file_chunks')}
      WHERE storage_key = ANY(${[unused.id, `${unused.id}_small`, `${unused.id}_large`]}::text[])`,
        )
      ).rowCount,
    ).toBe(0);
    if (kind !== 'postgres') {
      const remaining = await stored();
      for (const key of [unused.id, `${unused.id}_small`, `${unused.id}_large`])
        expect(remaining).not.toContain(key);
      expect(remaining).toContain(attached.id);
    }
  });
});
