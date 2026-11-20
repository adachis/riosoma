/**
 * Google Sheets sources through the server: the guarded network they reach Google through, the
 * service account's address copied from its key when a source is saved, the connection test, and
 * whole syncs from a stand-in for the Sheets API into a table, overrides and all, with the key
 * nowhere it shouldn't be.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newId,
  type CommandBatchResult,
  type DatabaseSchema,
  type RowData,
  type SourceMeta,
  type SourceObject,
  type SourcePreview,
  type SourceTestResult,
  type TableMeta,
} from '@riosoma/contracts';
import { createGoogleSheetsConnector, registerConnector } from '@riosoma/connectors';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { startFakeGoogleSheets, type FakeGoogleSheets } from '../test/fake-google-sheets.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { fetchRowsById } from '../data/physical/records.js';
import { fileNetwork } from './files.js';
import { claimSyncs, runSync } from './sync.js';

const PLANTS = 'plantsSpreadsheet0123456789abcdefghijklmnop';
const PRIVATE = 'privateSpreadsheet0123456789abcdefghijklmno';

function plantRows(): unknown[][] {
  return [
    ['SKU', 'Plant', 'Price', 'Planted', 'Organic'],
    ['P-1', 'Basil', 3.5, '4/2/2026', true],
    ['P-2', 'Thyme', 4, '4/9/2026', false],
    [],
    ['P-3', 'Sage', 5.25, '4/16/2026', true],
  ];
}

let kit: TestPostgres;
let server: ServerFixture;
let google: FakeGoogleSheets;
let databaseId: string;

function install() {
  registerConnector(
    createGoogleSheetsConnector({
      network: fileNetwork({
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
        // Only the stand-in on this machine may be reached on a private address.
        allowPrivate: (url) => url.hostname === '127.0.0.1',
      }),
      sockets: { connect: async () => undefined, handshake: async () => undefined },
      sheetsUrl: google.url,
      tokenUrl: google.tokenUrl,
      requestsPerSecond: 100,
    }),
  );
}

beforeAll(async () => {
  google = await startFakeGoogleSheets({
    [PLANTS]: {
      title: 'Garden',
      shared: true,
      sheets: [{ id: 42, title: 'Plants', rows: 100, columns: 5, values: plantRows() }],
    },
    [PRIVATE]: { title: 'Private', shared: false, sheets: [] },
  });
  kit = await startTestPostgres();
  server = await startServer(kit, 'sheetsrc', { automationsAllowPrivateHosts: true });
  install();
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: newId('database'),
      name: 'Sheets',
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
}, 60_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
  await google?.close();
});

async function createSource(spreadsheets: string[], key = google.key) {
  return server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: {
      name: `Sheets ${newId('source')}`,
      connection: { kind: 'google-sheets', spreadsheets },
      secrets: { serviceAccountJson: key },
    },
  });
}

async function applied(input: Record<string, unknown>) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<CommandBatchResult>().results[0]!;
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
}

async function sync(tableId: string): Promise<TableMeta> {
  await applied({ kind: 'table.sync', tableId, confirmRemovals: false });
  for (const job of await claimSyncs(server.ctx, 100)) await runSync(server.ctx, job);
  return (await loadTable(server.pool, server.schemas, tableId))!;
}

async function rows(tableId: string): Promise<RowData[]> {
  const ids = await query<{ __id: string }>(
    server.pool,
    sql`SELECT __id FROM ${ident(server.schemas.data, tableId)} WHERE NOT __source_gone ORDER BY __rid`,
  );
  const fields = await loadFields(server.pool, server.schemas, [tableId]);
  return fetchRowsById(
    server.pool,
    server.schemas.data,
    tableId,
    fields,
    ids.rows.map((row) => row.__id),
  );
}

/** The parts of the key that must never leave the server. */
function keyParts(): string[] {
  const key = JSON.parse(google.key) as { private_key: string };
  return [
    key.private_key,
    ...key.private_key.split('\n').filter((line) => line.length > 20),
    ...google.tokens,
  ];
}

describe('setting up a Google Sheets source', () => {
  it('keeps the service account’s address from the key, and refuses what isn’t a key', async () => {
    const created = await createSource([PLANTS]);
    expect(created.statusCode, created.body).toBe(200);
    const source = created.json<SourceMeta>();
    expect(source.connection).toEqual({
      kind: 'google-sheets',
      spreadsheets: [PLANTS],
      headerRow: 1,
      serviceAccountEmail: google.email,
    });
    expect(source.secrets).toEqual(['serviceAccountJson']);
    for (const part of keyParts()) expect(created.body).not.toContain(part);

    // Another spreadsheet reads with the same key, which stays stored.
    const more = await server.app.inject({
      method: 'PATCH',
      url: `/api/sources/${source.id}`,
      headers: server.owner.headers,
      payload: { connection: { kind: 'google-sheets', spreadsheets: [PLANTS, PRIVATE], headerRow: 2 } },
    });
    expect(more.statusCode, more.body).toBe(200);
    expect(more.json<SourceMeta>()).toMatchObject({
      secrets: ['serviceAccountJson'],
      connection: { spreadsheets: [PLANTS, PRIVATE], headerRow: 2, serviceAccountEmail: google.email },
    });

    const wrong = await createSource([PLANTS], '{"type": "authorized_user", "client_secret": "not-a-key"}');
    expect(wrong.json()).toMatchObject({
      error: { messageKey: 'sources.google.key', fields: { serviceAccountJson: 'sources.google.key' } },
    });
    expect(wrong.body).not.toContain('not-a-key');
  });

  it('tests a source step by step, and says when a spreadsheet isn’t shared', async () => {
    const source = (await createSource([PLANTS])).json<SourceMeta>();
    const tested = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/test`,
      headers: server.owner.headers,
    });
    expect(tested.json<SourceTestResult>().steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'skipped'],
      ['authenticate', 'ok'],
      ['sheets', 'ok'],
      ['rows', 'ok'],
    ]);
    const hidden = (await createSource([PLANTS, PRIVATE])).json<SourceMeta>();
    const refused = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${hidden.id}/test`,
      headers: server.owner.headers,
    });
    expect(refused.json<SourceTestResult>().steps.at(-1)).toMatchObject({
      step: 'sheets',
      status: 'failed',
      messageKey: 'sources.google.notShared',
    });
    for (const part of keyParts()) expect(refused.body).not.toContain(part);
  });

  it('reaches Google only on public addresses', async () => {
    // Google's address resolving somewhere private is refused before anything connects.
    const blocked = createGoogleSheetsConnector({
      network: fileNetwork({
        resolve: async () => [{ address: '10.0.0.5', family: 4 }],
        allowPrivate: () => false,
      }),
      sockets: { connect: async () => undefined, handshake: async () => undefined },
    });
    const result = await blocked.test({
      connection: { kind: 'google-sheets', spreadsheets: [PLANTS], headerRow: 1 },
      secrets: { serviceAccountJson: google.key },
      timeoutMs: 5_000,
    });
    expect(result.steps).toEqual([
      expect.objectContaining({
        step: 'resolve',
        status: 'failed',
        messageKey: 'sources.google.unreachable',
      }),
    ]);
  });
});

describe('syncing a sheet into a table', () => {
  it('syncs every row, keeps an override when a cell changes, and never records the key', async () => {
    const source = (await createSource([PLANTS])).json<SourceMeta>();
    const objects = await server.app.inject({
      url: `/api/sources/${source.id}/objects`,
      headers: server.owner.headers,
    });
    expect(objects.json<SourceObject[]>()).toEqual([
      {
        schema: PLANTS,
        schemaLabel: 'Garden',
        name: '42',
        label: 'Plants',
        type: 'sheet',
        rowEstimate: null,
      },
    ]);
    const select = { kind: 'object' as const, object: { schema: PLANTS, name: '42' } };
    const previewed = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/preview`,
      headers: server.owner.headers,
      payload: { select },
    });
    expect(previewed.statusCode, previewed.body).toBe(200);
    const shown = previewed.json<SourcePreview>();
    expect(shown.columns.map((column) => [column.name, column.suggested?.type])).toEqual([
      ['SKU', 'text'],
      ['Plant', 'text'],
      ['Price', 'number'],
      ['Planted', 'date'],
      ['Organic', 'checkbox'],
      ['Row number', 'number'],
    ]);
    expect(shown.keyCandidates).toEqual([['SKU'], ['Plant'], ['Price'], ['Planted'], ['Row number']]);
    expect(shown.rowEstimate).toBe(3);

    const tableId = newId('table');
    const field = Object.fromEntries(shown.columns.map((column) => [column.name, newId('field')]));
    await applied({
      kind: 'table.create',
      table: {
        id: tableId,
        name: 'Plants',
        source: { sourceId: source.id, select, keyColumns: ['SKU'], everyMinutes: null },
        fields: ['Plant', 'SKU', 'Price', 'Planted', 'Organic'].map((name) => {
          const column = shown.columns.find((entry) => entry.name === name)!;
          return {
            id: field[name],
            name,
            type: column.suggested!.type,
            options: column.suggested!.options,
            source: { column: name, sourceType: column.sourceType },
          };
        }),
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    });
    const first = await sync(tableId);
    expect(first.source!.status, JSON.stringify(first.source!.status)).toMatchObject({
      state: 'idle',
      stats: { added: 3 },
    });
    const thyme = (await rows(tableId)).find((row) => row.values[field.SKU!] === 'P-2')!;
    expect(thyme.values).toMatchObject({
      [field.Plant!]: 'Thyme',
      [field.Price!]: 4,
      [field.Planted!]: '2026-04-09',
      [field.Organic!]: false,
    });
    await applied({
      kind: 'record.update',
      tableId,
      records: [{ id: thyme.id, values: { [field.Plant!]: 'Lemon thyme' } }],
    });

    // Someone edits the sheet: Thyme is renamed and repriced, Sage leaves, and Mint arrives.
    const sheet = google.spreadsheets.get(PLANTS)!.sheets[0]!;
    sheet.values = [
      plantRows()[0]!,
      ['P-1', 'Basil', 3.5, '4/2/2026', true],
      ['P-2', 'Common thyme', 4.5, '4/9/2026', false],
      ['P-4', 'Mint', 2, '5/1/2026', true],
    ];
    const second = await sync(tableId);
    expect(second.source!.status.stats).toMatchObject({ added: 1, changed: 1, removed: 1 });
    const after = await rows(tableId);
    expect(after.map((row) => row.values[field.SKU!])).toEqual(['P-1', 'P-2', 'P-4']);
    const kept = after.find((row) => row.id === thyme.id)!;
    expect(kept.values).toMatchObject({ [field.Plant!]: 'Lemon thyme', [field.Price!]: 4.5 });
    expect(kept.overrides![field.Plant!]).toMatchObject({ source: 'Common thyme' });

    // A request to slow down is waited out, and the sync still finishes.
    google.throttle(1, 1);
    const third = await sync(tableId);
    expect(third.source!.status.state).toBe('idle');

    const changes = await query<{ body: unknown }>(
      server.pool,
      sql`SELECT body FROM ${ident(server.schemas.app, 'changes')} WHERE table_id = ${tableId}`,
    );
    const events = await query<{ detail: unknown }>(
      server.pool,
      sql`SELECT * FROM ${ident(server.schemas.audit, 'events')}`,
    );
    const listed = await server.app.inject({ url: '/api/sources', headers: server.owner.headers });
    for (const text of [
      JSON.stringify(changes.rows),
      JSON.stringify(events.rows),
      JSON.stringify(third.source),
      listed.body,
    ])
      for (const part of keyParts()) expect(text).not.toContain(part);
    // Only reads: the token requests are the one POST.
    expect(google.requests.filter((entry) => entry.method !== 'GET').map((entry) => entry.path)).toEqual(
      google.requests.filter((entry) => entry.path === '/token').map((entry) => entry.path),
    );
  });

  it('fails a sync whose header lost a column, and changes nothing', async () => {
    const source = (await createSource([PLANTS])).json<SourceMeta>();
    const sheet = google.spreadsheets.get(PLANTS)!.sheets[0]!;
    sheet.values = plantRows();
    const select = { kind: 'object' as const, object: { schema: PLANTS, name: '42' } };
    const tableId = newId('table');
    const sku = newId('field');
    const plant = newId('field');
    await applied({
      kind: 'table.create',
      table: {
        id: tableId,
        name: 'Plants by name',
        source: { sourceId: source.id, select, keyColumns: ['SKU'], everyMinutes: null },
        fields: [
          {
            id: plant,
            name: 'Plant',
            type: 'text',
            options: {},
            source: { column: 'Plant', sourceType: 'text' },
          },
          { id: sku, name: 'SKU', type: 'text', options: {}, source: { column: 'SKU', sourceType: 'text' } },
        ],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    });
    expect((await sync(tableId)).source!.status.stats).toMatchObject({ added: 3 });
    sheet.values = [['SKU', 'Name', 'Price'], ...plantRows().slice(1)];
    const failed = await sync(tableId);
    expect(failed.source!.status).toMatchObject({
      state: 'failed',
      error: { messageKey: 'sources.sync.columnMissing' },
    });
    expect((await rows(tableId)).map((row) => row.values[plant])).toEqual(['Basil', 'Thyme', 'Sage']);
  });
});
