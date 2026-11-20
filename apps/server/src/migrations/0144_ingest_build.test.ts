import { afterAll, beforeAll, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { buildTable, configure } from '../ingest/build/test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'buildmigration');
  await configure(server);
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

it('keeps one active build per format and enforces its organization and table', async () => {
  const table = await buildTable(server);
  const insert = (id: string, tableId = table.tableId, orgId = table.context.orgId) =>
    server.pool.query(
      `INSERT INTO ${server.schemas.app}.ingest_builds (id, org_id, table_id, format_id, user_id, state, status)
      VALUES ($1, $2, $3, $4, $5, 'queued', '{}')`,
      [id, orgId, tableId, table.format.id, server.owner.userId],
    );
  await insert('first');
  await expect(insert('second')).rejects.toMatchObject({ code: '23505', constraint: 'ingest_builds_active' });
  await expect(insert('wrong', 'different-table')).rejects.toMatchObject({ code: '23503' });
  await server.pool.query(
    `UPDATE ${server.schemas.app}.ingest_builds SET state = 'canceled' WHERE id = 'first'`,
  );
  await insert('second');
  const examples = await server.pool.query(
    `SELECT builder_shown FROM ${server.schemas.app}.ingest_examples WHERE format_id = $1`,
    [table.format.id],
  );
  expect(examples.rows).toEqual([
    { builder_shown: false },
    { builder_shown: false },
    { builder_shown: false },
  ]);
});
