import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttachmentMeta, newId } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { AZURITE_URL, S3_URL, testAzure, testS3 } from '../../test/stores.js';
import { moveFiles, MoveRunning, removeOldCopies } from './move.js';
import { CHUNK_BYTES, outsideStorage, type StorageKind } from './storage.js';

/**
 * Moving attachments out of PostgreSQL: into a local folder always, and into MinIO and Azurite
 * when their test services are named (see test/stores.ts).  One file's stored bytes are damaged,
 * so it fails its checksum and has to stay where it was.
 */

let kit: TestPostgres;
beforeAll(async () => {
  kit = await startTestPostgres();
}, 60_000);
afterAll(async () => {
  await kit?.stop();
});

const targets = [
  'local',
  ...(S3_URL ? (['s3'] as const) : []),
  ...(AZURITE_URL ? (['azure-blob'] as const) : []),
] as const;

describe.each(targets)('moving files from PostgreSQL to %s', (target) => {
  let server: ServerFixture;
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rio-move-test-'));
    const stores =
      target === 's3'
        ? { filesS3: await testS3('move') }
        : target === 'azure-blob'
          ? { filesAzure: await testAzure('move') }
          : {};
    server = await startServer(kit, `move_${target.replace('-', '_')}`, {
      filesStorage: 'postgres',
      filesDir: directory,
      ...stores,
    });
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function upload(tableId: string, fieldId: string, bytes: Buffer, name: string) {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/tables/${tableId}/fields/${fieldId}/files`,
      headers: { ...server.owner.headers, 'content-type': 'application/octet-stream', 'x-file-name': name },
      payload: bytes,
    });
    expect(response.statusCode, response.body).toBe(200);
    return AttachmentMeta.parse(response.json());
  }
  async function download(url: string): Promise<Buffer> {
    const response = await server.app.inject({ url, headers: server.owner.headers });
    expect(response.statusCode, url).toBe(200);
    return response.rawPayload;
  }
  async function storageOf(id: string): Promise<StorageKind> {
    const found = await query<{ storage: StorageKind }>(
      server.pool,
      sql`SELECT storage FROM ${ident(server.schemas.app, 'files')} WHERE id = ${id}`,
    );
    return found.rows[0]!.storage;
  }
  async function chunkCount(keys: string[]): Promise<number> {
    const found = await query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.app, 'file_chunks')} WHERE storage_key = ANY(${keys}::text[])`,
    );
    return found.rowCount ?? 0;
  }

  it('checks each copy before switching, keeps a damaged file where it was, and resumes', async () => {
    const table = {
      id: newId('table'),
      name: 'Files',
      fields: [
        { id: newId('field'), name: 'Name', type: 'text' },
        { id: newId('field'), name: 'Files', type: 'attachment' },
      ],
      view: { id: newId('view'), name: 'Grid' },
      records: [],
    };
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: server.owner.headers,
      payload: { id: newId('database'), name: 'Moving', table },
    });
    expect(created.statusCode, created.body).toBe(200);
    const fieldId = table.fields[1]!.id;
    const text = randomBytes(CHUNK_BYTES * 2 + 300);
    const image = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#336699' } })
      .png()
      .toBuffer();
    const damagedBytes = randomBytes(5000);
    const files = {
      text: await upload(table.id, fieldId, text, 'notes.bin'),
      image: await upload(table.id, fieldId, image, 'picture.png'),
      empty: await upload(table.id, fieldId, Buffer.alloc(0), 'empty.txt'),
      damaged: await upload(table.id, fieldId, damagedBytes, 'damaged.bin'),
    };
    expect(files.image.thumbnails.small).not.toBeNull();
    const smallPreview = await download(files.image.thumbnails.small!);

    // One file's bytes change in the database after upload, so they no longer match its checksum.
    const flipped = Buffer.from(damagedBytes);
    flipped[100] = flipped[100]! ^ 0xff;
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'file_chunks')} SET bytes = ${flipped}
      WHERE storage_key = ${files.damaged.id} AND position = 0`,
    );
    // An earlier run stopped partway through the text file, leaving part of a copy behind.
    const destination = outsideStorage(target, server.config);
    if (target === 'local') await writeFile(join(directory, files.text.id), 'partial');
    else await destination.write(files.text.id, Readable.from([Buffer.from('partial')]));

    const lines: string[] = [];
    const first = await moveFiles(server.pool, server.schemas.app, server.config, target, (line) =>
      lines.push(line),
    );
    expect(first).toMatchObject({ moved: 3, failed: [{ id: files.damaged.id, reason: 'checksum' }] });
    expect(first.bytes).toBeGreaterThan(text.length + image.length);
    expect(lines).toContain(`could not move ${files.damaged.id}: checksum`);
    for (const file of [files.text, files.image, files.empty]) expect(await storageOf(file.id)).toBe(target);
    expect(await storageOf(files.damaged.id)).toBe('postgres');

    // Downloads come from the new store now, byte for byte.
    expect((await download(files.text.url)).equals(text)).toBe(true);
    expect((await download(files.image.url)).equals(image)).toBe(true);
    expect((await download(files.image.thumbnails.small!)).equals(smallPreview)).toBe(true);
    expect((await download(files.empty.url)).length).toBe(0);
    // The damaged file left nothing in the new store, and the old copies are all still there.
    const chunks: Buffer[] = [];
    const leftover = await (async () => {
      try {
        for await (const chunk of destination.read(files.damaged.id)) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks);
      } catch (error) {
        return (error as { code?: string }).code;
      }
    })();
    expect(leftover).toBe('ENOENT');
    expect(await chunkCount([files.text.id, files.image.id, `${files.image.id}_small`])).toBeGreaterThan(3);

    // Only one move runs at a time.
    const [one, two] = await Promise.allSettled([
      moveFiles(server.pool, server.schemas.app, server.config, target),
      moveFiles(server.pool, server.schemas.app, server.config, target),
    ]);
    expect([one.status, two.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(one.status === 'rejected' ? one.reason : (two as PromiseRejectedResult).reason).toBeInstanceOf(
      MoveRunning,
    );

    // Running again moves nothing new, and the damaged file fails the same way.
    const again = await moveFiles(server.pool, server.schemas.app, server.config, target);
    expect(again).toMatchObject({ moved: 0, failed: [{ id: files.damaged.id, reason: 'checksum' }] });

    // Once its bytes are right again, it moves.
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'file_chunks')} SET bytes = ${damagedBytes}
      WHERE storage_key = ${files.damaged.id} AND position = 0`,
    );
    expect(await moveFiles(server.pool, server.schemas.app, server.config, target)).toMatchObject({
      moved: 1,
      failed: [],
    });
    expect((await download(files.damaged.url)).equals(damagedBytes)).toBe(true);

    // Removing the old copies empties PostgreSQL of them and leaves the files readable.
    const removed = await removeOldCopies(server.pool, server.schemas.app, server.config);
    expect(removed).toEqual({ removed: 4, failed: [] });
    expect(
      await chunkCount(
        Object.values(files).flatMap((file) => [file.id, `${file.id}_small`, `${file.id}_large`]),
      ),
    ).toBe(0);
    expect((await download(files.text.url)).equals(text)).toBe(true);
    expect(await removeOldCopies(server.pool, server.schemas.app, server.config)).toEqual({
      removed: 0,
      failed: [],
    });

    // And back again, which makes the new store's copies the old ones.
    const back = await moveFiles(server.pool, server.schemas.app, server.config, 'postgres');
    expect(back).toMatchObject({ moved: 4, failed: [] });
    expect((await download(files.image.url)).equals(image)).toBe(true);
    expect(await removeOldCopies(server.pool, server.schemas.app, server.config)).toEqual({
      removed: 4,
      failed: [],
    });
    if (target === 'local') expect(await readdir(directory)).toEqual([]);
    expect(
      createHash('sha256')
        .update(await download(files.text.url))
        .digest('hex'),
    ).toBe(createHash('sha256').update(text).digest('hex'));
  }, 120_000);

  it.runIf(target === 'local')(
    'runs as a command, with the server’s own settings',
    async () => {
      const table = {
        id: newId('table'),
        name: 'More files',
        fields: [
          { id: newId('field'), name: 'Name', type: 'text' },
          { id: newId('field'), name: 'Files', type: 'attachment' },
        ],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      };
      const created = await server.app.inject({
        method: 'POST',
        url: '/api/databases',
        headers: server.owner.headers,
        payload: { id: newId('database'), name: 'Command', table },
      });
      expect(created.statusCode, created.body).toBe(200);
      const bytes = randomBytes(1000);
      const file = await upload(table.id, table.fields[1]!.id, bytes, 'command.bin');
      const configDir = await mkdtemp(join(tmpdir(), 'rio-move-config-'));
      const run = (args: string[]) =>
        promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/tools/storage-move.ts', ...args], {
          timeout: 45_000,
          env: {
            PATH: process.env.PATH,
            RIOSOMA_CONFIG_DIR: configDir,
            RIOSOMA_SECRET_KEY: randomBytes(32).toString('base64'),
            RIOSOMA_DATABASE_PROFILE: JSON.stringify(server.config.database),
            RIOSOMA_FILES_DIR: directory,
          },
        }).then(
          (result) => ({ code: 0, ...result }),
          (error: { code: number; stdout: string; stderr: string }) => error,
        );
      const waiting = await query<{ count: string }>(
        server.pool,
        sql`SELECT count(*) FROM ${ident(server.schemas.app, 'files')} WHERE storage <> 'local'`,
      );
      const count = Number(waiting.rows[0]!.count);
      try {
        expect(await run(['--to', 's3'])).toMatchObject({
          code: 1,
          stderr: expect.stringContaining('Set RIOSOMA_FILES_S3_BUCKET and the settings that go with it'),
        });
        expect(await run(['--to', 'nowhere'])).toMatchObject({
          code: 1,
          stderr: expect.stringContaining('Usage'),
        });
        const moved = await run(['--to', 'local']);
        expect(moved.code, moved.stderr).toBe(0);
        expect(moved.stdout).toContain('New uploads still go to postgres');
        expect(moved.stdout).toContain(`moved ${count} file${count === 1 ? '' : 's'}`);
        expect(await storageOf(file.id)).toBe('local');
        expect((await download(file.url)).equals(bytes)).toBe(true);
        const removed = await run(['--remove-old']);
        expect(removed.code, removed.stderr).toBe(0);
        expect(removed.stdout).toContain(`removed ${count} old cop${count === 1 ? 'y' : 'ies'}`);
        expect(await chunkCount([file.id])).toBe(0);
      } finally {
        await rm(configDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
