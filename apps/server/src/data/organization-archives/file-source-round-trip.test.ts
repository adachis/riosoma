import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AttachmentMeta, newId, type CommandBatchResult } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { storeFile } from '../imports/core/files.js';
import { standIn } from '../files/scan-test-support.js';
import { scanPendingFiles } from '../files/scanning.js';
import { readFixture } from '../snapshots.test-helpers.js';
import { exportArchive, importArchive, rebuild, target } from './organization-archives.test-support.js';

let kit: TestPostgres, origin: ServerFixture, scanner: Awaited<ReturnType<typeof standIn>>;
let restored: ServerFixture | undefined;
let archive: Buffer, withoutBytes: Buffer, png: Buffer;
const sources = [
  {
    url: 'https://photos.example.test/page',
    imageUrl: 'https://photos.example.test/page.png',
    license: 'CC BY 4.0',
  },
  {
    url: 'https://photos.example.test/other',
    imageUrl: 'https://photos.example.test/other.png',
  },
];

beforeAll(async () => {
  kit = await startTestPostgres();
  origin = await startServer(kit, 'file_source_origin');
  scanner = await standIn();
  png = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();
  const read = await readFixture(origin, [{ type: 'attachment' }]);
  const fieldId = read.fields[0]!.id;
  const files = [];
  for (const [index, source] of sources.entries()) {
    files.push(
      await storeFile(
        origin.app,
        { orgId: origin.owner.info.org.id, userId: origin.owner.userId },
        { tableId: read.table.id, fieldId },
        `page-${index}.png`,
        Readable.from([png]),
        source,
      ),
    );
  }
  const attached = await origin.app.inject({
    method: 'POST',
    url: `/api/databases/${read.table.databaseId}/commands`,
    headers: origin.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          kind: 'record.create',
          id: newId('command'),
          groupId: newId('action'),
          tableId: read.table.id,
          records: [{ id: newId('record'), values: { [fieldId]: files.map((file) => file.id) } }],
        },
      ],
    },
  });
  expect(attached.statusCode, attached.body).toBe(200);
  expect(attached.json<CommandBatchResult>().results[0]).toMatchObject({ status: 'applied' });
  archive = (await exportArchive(origin, { files: true })).bytes;
  withoutBytes = (await exportArchive(origin, { files: false })).bytes;
}, 60_000);

afterEach(async () => {
  await restored?.close();
  restored = undefined;
});

afterAll(async () => {
  await scanner?.close();
  await origin?.close();
  await kit?.stop();
});

async function restore(bytes: Buffer, quarantine = false) {
  restored = (await target(kit, 'file_source_restored')).server;
  if (quarantine) restored.config.clamavUrl = scanner.url;
  await importArchive(restored, bytes);
  return restored;
}

async function details(server: ServerFixture) {
  const files = await query<{ id: string; sha256: string }>(
    server.pool,
    sql`SELECT id, sha256 FROM ${ident(server.schemas.app, 'files')} ORDER BY name`,
  );
  expect(files.rows).toHaveLength(2);
  expect(files.rows.every((file) => file.sha256 === createHash('sha256').update(png).digest('hex'))).toBe(
    true,
  );
  const response = await server.app.inject({
    url: `/api/files?ids=${files.rows.map((file) => file.id).join(',')}`,
    headers: server.owner.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  return AttachmentMeta.array()
    .parse(response.json())
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe('organization archive file sources', () => {
  it.each([false, true])(
    'preserves sources and licenses through a round trip with quarantine %s',
    async (quarantine) => {
      const server = await restore(archive, quarantine);
      const files = await details(server);
      expect(files.map((file) => file.source)).toEqual(sources);
      expect(files.map((file) => file.scanState)).toEqual([
        quarantine ? 'quarantined' : 'clean',
        quarantine ? 'quarantined' : 'clean',
      ]);
      if (quarantine) {
        expect(files.every((file) => file.url === '' && file.thumbnails.small === null)).toBe(true);
        await scanPendingFiles(server.app);
      }
      for (const [index, file] of (await details(server)).entries()) {
        expect(file.source).toEqual(sources[index]);
        expect(file.scanState).toBe('clean');
        expect(file.thumbnails.small).not.toBeNull();
        const download = await server.app.inject({ url: file.url, headers: server.owner.headers });
        expect(download.statusCode).toBe(200);
        expect(download.rawPayload).toEqual(png);
      }
    },
  );

  it('preserves sources when file contents were excluded from the archive', async () => {
    const files = await details(await restore(withoutBytes));
    expect(files.map((file) => file.source)).toEqual(sources);
    expect(files.every((file) => file.scanState === 'unavailable' && file.url === '')).toBe(true);
    expect(files.every((file) => file.thumbnails.small === null && file.thumbnails.large === null)).toBe(
      true,
    );
  });

  it.each([
    null,
    'invalid',
    { ...sources[0], url: 'javascript:alert(1)' },
    { ...sources[0], imageUrl: 'file:///page.png' },
    { ...sources[0], url: 'https://user:password@photos.example.test/page' },
    { ...sources[0], imageUrl: 'https://user:password@photos.example.test/page.png' },
    { ...sources[0], url: 'https://photos.example.test/' + 'x'.repeat(4096) },
    { ...sources[0], license: 42 },
    { ...sources[0], license: 'x'.repeat(301) },
    { url: sources[0]!.url },
  ])('discards invalid archived source metadata %j', async (source) => {
    const changed = await rebuild(archive, {
      entry: (_name, items) =>
        items.map((item) => {
          const line = item as { kind: string; catalog?: string; row: Record<string, unknown> };
          return line.kind === 'catalog' && line.catalog === 'files'
            ? {
                ...line,
                row: { ...line.row, thumbnails: { source, small: 'untrusted', large: 'untrusted' } },
              }
            : item;
        }),
    });
    const files = await details(await restore(changed, true));
    expect(files.every((file) => file.source === undefined)).toBe(true);
    expect(files.every((file) => file.thumbnails.small === null && file.thumbnails.large === null)).toBe(
      true,
    );
  });
});
