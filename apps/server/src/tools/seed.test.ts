import { afterAll, beforeAll, expect, it } from 'vitest';
import type { DatabaseSchema, RowsPage } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { seedDatabase } from './seed.js';

let kit: TestPostgres;
let server: ServerFixture;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'seed');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

it('seeds a database people can open and page through', async () => {
  const owner = server.owner;
  const ids = await seedDatabase(
    server.pool,
    server.schemas,
    {
      userId: owner.userId,
      orgId: owner.info.org.id,
      sessionId: 'seed',
      kind: 'owner',
      adminRoles: [],
      csrfToken: '',
    },
    { rows: 20_000, name: 'Sample' },
  );

  const schema = await server.app.inject({
    url: `/api/databases/${ids.databaseId}/schema`,
    headers: owner.headers,
  });
  expect(schema.statusCode).toBe(200);
  const body = schema.json<DatabaseSchema>();
  expect(body.fields).toHaveLength(20);
  expect(body.database.role).toBe('owner');

  const page = await server.app.inject({
    url: `/api/views/${ids.viewId}/rows?offset=19990&limit=50`,
    headers: owner.headers,
  });
  expect(page.statusCode).toBe(200);
  const rows = page.json<RowsPage>();
  expect(rows.total).toBe(20_000);
  expect(rows.rows).toHaveLength(10);
  const name = body.fields.find((f) => f.name === 'Name')!;
  expect(rows.rows.at(-1)?.values[name.id]).toBe('Item 20000');
  const tags = body.fields.find((f) => f.name === 'Tags')!;
  for (const row of rows.rows) {
    const value = row?.values[tags.id];
    if (Array.isArray(value)) expect(new Set(value).size).toBe(value.length);
  }
}, 60_000);
