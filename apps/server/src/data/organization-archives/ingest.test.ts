import { Readable } from 'node:stream';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DatabaseCreate, newId } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { IngestTableStore } from '../../ingest/tables/store.js';
import { exportArchive, importArchive, rebuild } from './organization-archives.test-support.js';
import { CATALOGS, publicRow, type CatalogLine } from './catalog.js';
import { unpack, jsonLines } from './container.js';
import { SCHEMA_VERSION } from './export.js';

let kit: TestPostgres;
let origin: ServerFixture;
let target: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  origin = await startServer(kit, 'ingestexport');
  target = await startServer(kit, 'ingestimport');
}, 60_000);
afterAll(async () => {
  await target?.close();
  await origin?.close();
  await kit?.stop();
});
it('exports no ingest storage and imports table and field metadata without ingest ownership, even if an archive plants it', async () => {
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Incoming',
    table: {
      id: newId('table'),
      name: 'Incoming rows',
      fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  const created = await origin.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: origin.owner.headers,
    payload: input,
  });
  expect(created.statusCode, created.body).toBe(200);
  const context = { orgId: origin.owner.info.org.id, userId: origin.owner.userId, tableId: input.table.id };
  const store = new IngestTableStore(origin.pool, origin.schemas);
  const setting = await store.changeSettings(context, null, {
    state: 'setup',
    ownerId: null,
    rowMeaning: 'One order',
    identity: null,
    fields: [],
    originals: { keepDays: null, readOnlyAccess: false },
    reply: true,
  });
  const mark = { key: 'name', role: 'data' as const };
  await store.markField(context, input.table.fields[0]!.id, mark);
  const exported = await exportArchive(origin, { files: false });
  const { directory } = await unpack(
    Readable.from([exported.bytes]),
    SCHEMA_VERSION,
    origin.config.archiveWorkDir!,
  );
  try {
    for (const name of directory.entries.keys()) {
      if (!name.endsWith('.jsonl') || name === 'manifest.jsonl') continue;
      for await (const item of jsonLines(directory.read(name))) {
        const line = item as CatalogLine;
        if (line.catalog === 'tables' || line.catalog === 'fields') expect(line.row.ingest).toBeNull();
      }
    }
  } finally {
    await directory.close();
  }
  expect(CATALOGS.filter((catalog) => catalog.startsWith('ingest_'))).toEqual([]);
  expect(publicRow('tables', { ingest: setting }, origin.config.secretKey).row.ingest).toBeNull();
  expect(publicRow('fields', { ingest: mark }, origin.config.secretKey).row.ingest).toBeNull();
  const planted = await rebuild(exported.bytes, {
    entry: (_name, items) =>
      items.map((item) => {
        const line = item as CatalogLine;
        if (line.catalog === 'tables') return { ...line, row: { ...line.row, ingest: setting } };
        if (line.catalog === 'fields') return { ...line, row: { ...line.row, ingest: mark } };
        return item;
      }),
  });
  await importArchive(target, planted);
  const tables = await target.pool.query(
    `SELECT ingest FROM ${target.schemas.app}.tables WHERE name = 'Incoming rows'`,
  );
  const fields = await target.pool.query(
    `SELECT ingest FROM ${target.schemas.app}.fields WHERE name = 'Name'`,
  );
  expect(tables.rows).toEqual([{ ingest: null }]);
  expect(fields.rows).toEqual([{ ingest: null }]);
});
