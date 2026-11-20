import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  newId,
  type AutomationSimulation,
  type DatabaseSchema,
  type RowsPage,
  type SourceMeta,
} from '@riosoma/contracts';
import * as connectors from '@riosoma/connectors';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { apply, automate, grant } from './automations.test-helpers.js';

/**
 * A simulation over a table that reads its source live, a second PostgreSQL database the test kit
 * starts beside the app's own.  Every read the source answers is counted.
 */

const reads = vi.hoisted(() => ({ rows: 0, matching: 0 }));
vi.mock('@riosoma/connectors', async (original) => {
  const actual = await original<typeof connectors>();
  return {
    ...actual,
    liveRows: (...args: Parameters<typeof actual.liveRows>) => {
      reads.rows += 1;
      return actual.liveRows(...args);
    },
    liveMatching: (...args: Parameters<typeof actual.liveMatching>) => {
      reads.matching += 1;
      return actual.liveMatching(...args);
    },
  };
});

let kit: TestPostgres;
let server: ServerFixture;
let databaseId: string;
let sourceDb: Awaited<ReturnType<TestPostgres['createDatabase']>>;
let remote: pg.Client;
let source: SourceMeta;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'simlive', { automationsPollMs: 0 });
  sourceDb = await kit.createDatabase('simsource');
  remote = new pg.Client({ connectionString: sourceDb.url });
  await remote.connect();
  await remote.query('CREATE TABLE items (id integer PRIMARY KEY, name varchar(80), status text)');
  for (let i = 1; i <= 8; i++)
    await remote.query('INSERT INTO items VALUES ($1, $2, $3)', [i, `Item ${i}`, 'open']);
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: newId('database'),
      name: 'Live',
      table: {
        id: newId('table'),
        name: 'Local',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  databaseId = created.json<DatabaseSchema>().database.id;
  const url = new URL(sourceDb.url);
  const added = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: {
      name: 'Remote',
      connection: {
        kind: 'postgres',
        host: url.hostname,
        port: Number(url.port || 5432),
        database: decodeURIComponent(url.pathname.slice(1)),
        user: decodeURIComponent(url.username),
        tls: { mode: 'disable' },
      },
      secrets: { password: decodeURIComponent(url.password) || 'test' },
      access: 'creators',
    },
  });
  expect(added.statusCode, added.body).toBe(200);
  source = added.json<SourceMeta>();
}, 60_000);

afterAll(async () => {
  await connectors.closeLivePools();
  connectors.forgetLiveColumns();
  await remote?.end();
  await sourceDb?.drop();
  await server?.close();
  await kit?.stop();
});

describe('simulating changes to a live table', () => {
  it('reads each record from the source at most once, however many changes touch it', async () => {
    const t = { id: newId('table'), view: newId('view'), key: newId('field'), name: newId('field') };
    const status = newId('field');
    await apply(server, databaseId, [
      {
        kind: 'table.create',
        table: {
          id: t.id,
          name: 'Items',
          source: {
            sourceId: source.id,
            select: { kind: 'object', object: { schema: 'public', name: 'items' } },
            keyColumns: ['id'],
            everyMinutes: null,
            freshness: 'live',
          },
          fields: [
            { id: t.name, name: 'Name', type: 'text', source: { column: 'name', sourceType: '' } },
            { id: t.key, name: 'Key', type: 'number', source: { column: 'id', sourceType: '' } },
            { id: status, name: 'Status', type: 'text', source: { column: 'status', sourceType: '' } },
          ],
          view: { id: t.view, name: 'Grid' },
          records: [],
        },
      },
    ]);
    const page = await server.app.inject({
      method: 'GET',
      url: `/api/views/${t.view}/rows?offset=0&limit=100`,
      headers: server.owner.headers,
    });
    expect(page.statusCode, page.body).toBe(200);
    const ids = page
      .json<RowsPage>()
      .rows.slice(0, 5)
      .map((row) => row!.id);
    // A record rule on the table means the source says which records the person may see, too.
    const member = await server.addMember();
    await grant(server, databaseId, member, 'creator');
    const rule = await server.app.inject({
      method: 'PUT',
      url: `/api/tables/${t.id}/record-rules`,
      headers: server.owner.headers,
      payload: {
        rules: [
          {
            id: newId('recordRule'),
            roles: ['creator'],
            users: [],
            condition: {
              conjunction: 'and',
              conditions: [{ id: 'r1', fieldId: status, operator: 'is', value: 'open' }],
            },
          },
        ],
      },
    });
    expect(rule.statusCode, rule.body).toBe(200);
    const automationId = await automate(
      server,
      databaseId,
      {
        trigger: { kind: 'webhook' },
        steps: [
          {
            id: 'rename01',
            kind: 'script',
            input: {},
            script: [
              `const ids = ${JSON.stringify(ids)}`,
              'for (const round of [1, 2])',
              `  for (const id of ids) await records.update('${t.id}', id, { '${t.name}': 'Round ' + round })`,
            ].join('\n'),
          },
        ],
      },
      { enabled: false },
    );
    reads.rows = 0;
    reads.matching = 0;
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/automations/${automationId}/simulate`,
      headers: member.headers,
      payload: { body: {} },
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<AutomationSimulation>();
    expect(result.state, response.body).toBe('succeeded');
    expect(result.steps[0]!.writes).toHaveLength(10);
    expect(result.steps[0]!.writes.at(-1)!.changes).toContainEqual({
      fieldId: t.name,
      before: 'Round 1',
      after: 'Round 2',
    });
    // Ten changes to five records: each record's values and visibility are read once.
    expect(reads).toEqual({ rows: 5, matching: 5 });
    // Nothing reached the source.
    const names = await remote.query<{ name: string }>('SELECT name FROM items ORDER BY id');
    expect(names.rows.map((row) => row.name)).toEqual(Array.from({ length: 8 }, (_, i) => `Item ${i + 1}`));
  });
});
