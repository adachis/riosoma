import { afterAll, beforeAll, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { DatabaseCreate, newId } from '@riosoma/contracts';
import { IngestTableStore } from '../ingest/tables/store.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'setupmigration');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

it('enforces exactly one owner and the organization and table of an original', async () => {
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Files',
    table: {
      id: newId('table'),
      name: 'Rows',
      fields: [
        { id: newId('field'), name: 'Name', type: 'text' },
        { id: newId('field'), name: 'Files', type: 'attachment' },
      ],
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: input,
  });
  expect(response.statusCode, response.body).toBe(200);
  const context = { tableId: input.table.id, orgId: server.owner.info.org.id, userId: server.owner.userId };
  const file = await new IngestTableStore(server.pool, server.schemas).createFile(context, {
    origin: 'drop',
    name: 'input.csv',
    mediaType: 'text/plain',
    sizeBytes: 1,
    sha256: 'a'.repeat(64),
    storedFile: null,
  });
  const insert = (fieldId: string | null, fileId: string | null) => {
    const id = newId('attachment');
    return server.pool.query(
      `INSERT INTO ${server.schemas.app}.files (id, org_id, table_id, field_id, ingest_file_id, name, size, type, sha256, storage, storage_key)
      VALUES ($1, $2, $3, $4, $5, 'input.csv', 1, 'text/plain', $6, 'postgres', $1)`,
      [id, context.orgId, context.tableId, fieldId, fileId, 'a'.repeat(64)],
    );
  };
  await expect(insert(null, null)).rejects.toMatchObject({ code: '23514', constraint: 'files_owner' });
  await expect(insert(input.table.fields[1]!.id, file.id)).rejects.toMatchObject({
    code: '23514',
    constraint: 'files_owner',
  });
  await expect(insert(null, 'wrong-owner')).rejects.toMatchObject({
    code: '23503',
    constraint: 'files_ingest_owner',
  });
  await insert(null, file.id);
  await expect(insert(null, file.id)).rejects.toMatchObject({ code: '23505' });
  await insert(input.table.fields[1]!.id, null);
});
