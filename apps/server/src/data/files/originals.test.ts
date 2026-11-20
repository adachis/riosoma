import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DatabaseCreate, newId } from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { IngestTableStore } from '../../ingest/tables/store.js';
import { deleteOriginal, inspectOriginal, loadOriginal, storeOriginal } from './originals.js';
import { fileStorage } from './storage.js';
import { loadFiles } from './metadata.js';
import { cleanupUnattached } from './cleanup.js';
import { purgeTrash } from '../purge.js';
import { loadTable } from '../metadata.js';
import { exportArchive } from '../organization-archives/organization-archives.test-support.js';
import { jsonLines, unpack } from '../organization-archives/container.js';
import { SCHEMA_VERSION } from '../organization-archives/export.js';

let kit: TestPostgres;
let server: ServerFixture;
let tableId: string;
let directory: string;
let store: IngestTableStore;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'originalfiles');
  directory = await mkdtemp(join(tmpdir(), 'originalfiles-'));
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Originals',
    table: {
      id: newId('table'),
      name: 'Rows',
      fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  tableId = input.table.id;
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: input,
  });
  expect(response.statusCode, response.body).toBe(200);
  store = new IngestTableStore(server.pool, server.schemas);
}, 60_000);
afterAll(async () => {
  await server?.close();
  await rm(directory, { recursive: true, force: true });
  await kit?.stop();
});

for (const kind of ['postgres', 'local'] as const)
  it(`stores, verifies, and deletes an original through ${kind}`, async () => {
    const context = { orgId: server.owner.info.org.id, tableId, userId: server.owner.userId };
    const config = { ...server.config, filesStorage: kind, filesDir: directory };
    const input = { name: 'source.csv', bytes: Buffer.from('Incoming,Amount\nA,12\n') };
    const checked = await inspectOriginal(server.pool, server.schemas.app, config, context.orgId, input);
    const file = await store.createFile(context, {
      origin: 'drop',
      name: input.name,
      sizeBytes: input.bytes.length,
      sha256: checked.sha256,
      mediaType: checked.type,
      storedFile: null,
    });
    const original = await withTransaction(server.pool, (db) =>
      storeOriginal(db, server.schemas.app, config, { ...context, fileId: file.id }, input, () => {}),
    );
    const saved = await store.updateFile(context, file.id, { storedFile: original.id });
    expect(await loadOriginal(server.pool, server.schemas.app, config, saved)).toEqual(input.bytes);
    expect(await loadFiles(server.pool, server.schemas.app, [original.id])).toEqual([]);
    const ownership = await server.pool.query(
      `SELECT field_id, ingest_file_id FROM ${server.schemas.app}.files WHERE id = $1`,
      [original.id],
    );
    expect(ownership.rows).toEqual([{ field_id: null, ingest_file_id: file.id }]);
    await server.pool.query(
      `UPDATE ${server.schemas.app}.files SET created_at = now() - interval '2 days' WHERE id = $1`,
      [original.id],
    );
    await cleanupUnattached(server.ctx);
    expect(await loadOriginal(server.pool, server.schemas.app, config, saved)).toEqual(input.bytes);
    await expect(
      withTransaction(server.pool, (db) =>
        deleteOriginal(db, server.schemas.app, { ...saved, isExample: true }),
      ),
    ).rejects.toMatchObject({ messageKey: 'ingest.examples.kept' });
    const removed = await withTransaction(server.pool, (db) => deleteOriginal(db, server.schemas.app, saved));
    expect(removed?.id).toBe(original.id);
    if (removed?.storage !== 'postgres')
      await fileStorage(kind, server.pool, server.schemas.app, config).delete(original.storage_key);
    expect(await loadOriginal(server.pool, server.schemas.app, config, saved)).toBeNull();
    expect((await store.readFile(context, saved.id))!.storedFile).toBeNull();
  });

it('rejects an owner from another table and refuses originals whose content no longer has the arrival hash', async () => {
  const context = { orgId: server.owner.info.org.id, tableId, userId: server.owner.userId };
  const input = { name: 'source.csv', bytes: Buffer.from('Incoming,Amount\nB,24\n') };
  const checked = await inspectOriginal(server.pool, server.schemas.app, server.config, context.orgId, input);
  const file = await store.createFile(context, {
    origin: 'drop',
    name: input.name,
    sizeBytes: input.bytes.length,
    sha256: checked.sha256,
    mediaType: checked.type,
    storedFile: null,
  });
  await expect(
    withTransaction(server.pool, (db) =>
      storeOriginal(
        db,
        server.schemas.app,
        server.config,
        { ...context, fileId: 'wrong-owner' },
        input,
        () => {},
      ),
    ),
  ).rejects.toMatchObject({ code: '23503' });
  const original = await withTransaction(server.pool, (db) =>
    storeOriginal(db, server.schemas.app, server.config, { ...context, fileId: file.id }, input, () => {}),
  );
  const saved = await store.updateFile(context, file.id, { storedFile: original.id });
  await server.pool.query(`UPDATE ${server.schemas.app}.file_chunks SET bytes = $1 WHERE storage_key = $2`, [
    Buffer.from('altered'),
    original.storage_key,
  ]);
  expect(await loadOriginal(server.pool, server.schemas.app, server.config, saved)).toBeNull();
});

it('protects confirmed example originals even when the caller has an older file snapshot', async () => {
  const context = { orgId: server.owner.info.org.id, tableId, userId: server.owner.userId };
  const input = { name: 'kept.csv', bytes: Buffer.from('Incoming,Amount\nC,36\n') };
  const checked = await inspectOriginal(server.pool, server.schemas.app, server.config, context.orgId, input);
  const file = await store.createFile(context, {
    origin: 'drop',
    name: input.name,
    sizeBytes: input.bytes.length,
    sha256: checked.sha256,
    mediaType: checked.type,
    storedFile: null,
  });
  const original = await withTransaction(server.pool, (db) =>
    storeOriginal(db, server.schemas.app, server.config, { ...context, fileId: file.id }, input, () => {}),
  );
  const beforeConfirmation = await store.updateFile(context, file.id, { storedFile: original.id });
  const format = await store.createFormat(context, {
    name: 'Rows',
    state: 'draft',
    signature: { id: 'signature', kind: 'text', headerGroups: [], markers: [] },
    reading: 'ai',
    rules: null,
    probationPassed: 0,
  });
  await store.createExample(context, {
    formatId: format.id,
    fileId: file.id,
    expected: [{ values: {} }],
    own: true,
  });
  await expect(
    withTransaction(server.pool, (db) => deleteOriginal(db, server.schemas.app, beforeConfirmation)),
  ).rejects.toMatchObject({ messageKey: 'ingest.examples.kept' });
  expect(await loadOriginal(server.pool, server.schemas.app, server.config, beforeConfirmation)).toEqual(
    input.bytes,
  );
});

it('exports neither original metadata nor original bytes in an organization archive', async () => {
  const exported = await exportArchive(server, { files: true });
  const { directory: archive } = await unpack(
    Readable.from([exported.bytes]),
    SCHEMA_VERSION,
    server.config.archiveWorkDir!,
  );
  try {
    expect([...archive.entries.keys()].filter((name) => name.startsWith('files/'))).toEqual([]);
    for (const name of archive.entries.keys()) {
      if (!name.endsWith('.jsonl') || name === 'manifest.jsonl') continue;
      for await (const line of jsonLines(archive.read(name)))
        expect((line as { catalog?: string }).catalog).not.toBe('files');
    }
  } finally {
    await archive.close();
  }
});

for (const kind of ['postgres', 'local'] as const)
  it(`purges confirmed originals through ${kind} only after the table transaction commits and its hold ends`, async () => {
    const input = DatabaseCreate.parse({
      id: newId('database'),
      name: 'Expired originals',
      table: {
        id: newId('table'),
        name: 'Rows',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    });
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: server.owner.headers,
      payload: input,
    });
    expect(created.statusCode, created.body).toBe(200);
    const context = { orgId: server.owner.info.org.id, tableId: input.table.id, userId: server.owner.userId };
    const config = { ...server.config, filesStorage: kind, filesDir: directory };
    const source = { name: 'source.csv', bytes: Buffer.from('Incoming,Amount\nA,12\n') };
    const checked = await inspectOriginal(server.pool, server.schemas.app, config, context.orgId, source);
    const file = await store.createFile(context, {
      origin: 'drop',
      name: source.name,
      sizeBytes: source.bytes.length,
      sha256: checked.sha256,
      mediaType: checked.type,
      storedFile: null,
    });
    const original = await withTransaction(server.pool, (db) =>
      storeOriginal(db, server.schemas.app, config, { ...context, fileId: file.id }, source, () => {}),
    );
    const saved = await store.updateFile(context, file.id, { storedFile: original.id });
    const format = await store.createFormat(context, {
      name: 'Rows',
      state: 'draft',
      signature: { id: 'signature', kind: 'text', headerGroups: [], markers: [] },
      reading: 'ai',
      rules: null,
      probationPassed: 0,
    });
    await store.createExample(context, {
      formatId: format.id,
      fileId: file.id,
      expected: [{ values: {} }],
      own: true,
    });
    const extra = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${input.id}/commands`,
      headers: server.owner.headers,
      payload: {
        clientId: newId('client'),
        commands: [
          {
            id: newId('command'),
            groupId: newId('action'),
            kind: 'table.create',
            table: {
              id: newId('table'),
              name: 'Kept rows',
              fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
              view: { id: newId('view'), name: 'Grid' },
            },
          },
        ],
      },
    });
    expect(extra.json().results[0].status, extra.body).toBe('applied');
    const trashed = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${input.id}/commands`,
      headers: server.owner.headers,
      payload: {
        clientId: newId('client'),
        commands: [
          { id: newId('command'), groupId: newId('action'), kind: 'table.trash', tableId: input.table.id },
        ],
      },
    });
    expect(trashed.json().results[0].status, trashed.body).toBe('applied');
    await server.pool.query(
      `UPDATE ${server.schemas.app}.tables SET trashed_at = now() - interval '31 days' WHERE id = $1`,
      [input.table.id],
    );
    await server.pool.query(`UPDATE ${server.schemas.app}.databases SET legal_hold = true WHERE id = $1`, [
      input.id,
    ]);
    const ctx = { ...server.ctx, config };
    await purgeTrash(ctx);
    expect(await loadOriginal(server.pool, server.schemas.app, config, saved)).toEqual(source.bytes);
    expect(await loadTable(server.pool, server.schemas, input.table.id)).not.toBeNull();
    await server.pool.query(`UPDATE ${server.schemas.app}.databases SET legal_hold = false WHERE id = $1`, [
      input.id,
    ]);
    await server.pool
      .query(`CREATE FUNCTION ${server.schemas.app}.refuse_original_purge() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Purge rollback probe'; END $$`);
    await server.pool
      .query(`CREATE TRIGGER refuse_original_purge BEFORE DELETE ON ${server.schemas.app}.tables
      FOR EACH ROW EXECUTE FUNCTION ${server.schemas.app}.refuse_original_purge()`);
    try {
      await expect(purgeTrash(ctx)).rejects.toThrow();
      expect(await loadOriginal(server.pool, server.schemas.app, config, saved)).toEqual(source.bytes);
      expect(await store.readExample(context, (await store.listExamples(context))[0]!.id)).not.toBeNull();
    } finally {
      await server.pool.query(`DROP TRIGGER refuse_original_purge ON ${server.schemas.app}.tables`);
      await server.pool.query(`DROP FUNCTION ${server.schemas.app}.refuse_original_purge()`);
    }
    await purgeTrash(ctx);
    expect(await loadTable(server.pool, server.schemas, input.table.id)).toBeNull();
    for (const catalog of ['ingest_files', 'ingest_examples'])
      expect(
        (
          await server.pool.query(`SELECT id FROM ${server.schemas.app}.${catalog} WHERE table_id = $1`, [
            input.table.id,
          ])
        ).rowCount,
      ).toBe(0);
    expect(
      (await server.pool.query(`SELECT id FROM ${server.schemas.app}.files WHERE id = $1`, [original.id]))
        .rowCount,
    ).toBe(0);
    const bytes: Buffer[] = [];
    const readBytes = async () => {
      for await (const chunk of fileStorage(kind, server.pool, server.schemas.app, config).read(
        original.storage_key,
      ))
        bytes.push(chunk as Buffer);
      return Buffer.concat(bytes);
    };
    if (kind === 'postgres') expect(await readBytes()).toEqual(Buffer.alloc(0));
    else await expect(readBytes()).rejects.toMatchObject({ code: 'ENOENT' });
  });
