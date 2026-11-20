/**
 * Microsoft 365 sources through the server: the guarded network they reach Microsoft through, the
 * connection test, and whole syncs from a stand-in for Graph into tables, a SharePoint list with an
 * override that survives a change, and an Excel workbook read by the upload reader, with the app's
 * secret nowhere it shouldn't be.
 */
import ExcelJS from 'exceljs';
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
import {
  createExcelOnlineConnector,
  createSharePointListConnector,
  registerConnector,
  type MicrosoftOptions,
} from '@riosoma/connectors';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { startFakeMicrosoft, type FakeMicrosoft } from '../test/fake-microsoft.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { fetchRowsById } from '../data/physical/records.js';
import { fileNetwork, spreadsheetReader } from './files.js';
import { microsoftConnectorOptions } from './microsoft.js';
import { claimSyncs, runSync } from './sync.js';

let kit: TestPostgres;
let server: ServerFixture;
let microsoft: FakeMicrosoft;
let databaseId: string;

function install() {
  const options: MicrosoftOptions = {
    network: fileNetwork({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      // Only the stand-in on this machine may be reached on a private address.
      allowPrivate: (url) => url.hostname === '127.0.0.1',
    }),
    sockets: { connect: async () => undefined, handshake: async () => undefined },
    loginUrl: microsoft.url,
    requestsPerSecond: 200,
  };
  registerConnector(createSharePointListConnector({ ...options, graphUrl: microsoft.url }));
  registerConnector(
    createExcelOnlineConnector({ ...options, graphUrl: microsoft.url, spreadsheet: spreadsheetReader }),
  );
}

async function workbook(rows: unknown[][]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Beds').addRows(rows);
  book.addWorksheet('Notes').addRows([['Note'], ['Mulch in May']]);
  return Buffer.from(await book.xlsx.writeBuffer());
}

beforeAll(async () => {
  microsoft = await startFakeMicrosoft();
  microsoft.items = [
    { id: '1', fields: { Title: 'Basil', Price: 3.5, Planted: '2026-04-02T07:00:00Z', Organic: true } },
    { id: '2', fields: { Title: 'Thyme', Price: 4, Planted: '2026-04-09T07:00:00Z', Organic: false } },
    { id: '3', fields: { Title: 'Sage', Price: 5.25, Organic: true } },
  ];
  microsoft.workbookBytes = await workbook([
    ['Bed', 'Plant', 'Area'],
    ['N-1', 'Basil', 2.5],
    ['N-2', 'Thyme', 3],
  ]);
  kit = await startTestPostgres();
  server = await startServer(kit, 'mssrc', { automationsAllowPrivateHosts: true });
  install();
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: newId('database'),
      name: 'Microsoft',
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
  await microsoft?.close();
});

async function createSource(connection: Record<string, unknown>, secret = microsoft.secret) {
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: {
      name: `Microsoft ${newId('source')}`,
      connection: { tenantId: microsoft.tenant, clientId: microsoft.clientId, ...connection },
      secrets: { clientSecret: secret },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  return created.json<SourceMeta>();
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

async function preview(sourceId: string, select: unknown): Promise<SourcePreview> {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/sources/${sourceId}/preview`,
    headers: server.owner.headers,
    payload: { select },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<SourcePreview>();
}

/** Creates a synced table of `columns` from a preview, keyed by `key`. */
async function syncedTable(
  sourceId: string,
  select: unknown,
  shown: SourcePreview,
  columns: string[],
  key: string,
): Promise<{ tableId: string; field: Record<string, string> }> {
  const tableId = newId('table');
  const field = Object.fromEntries(shown.columns.map((column) => [column.name, newId('field')]));
  await applied({
    kind: 'table.create',
    table: {
      id: tableId,
      name: `Synced ${tableId.slice(-4)}`,
      source: { sourceId, select, keyColumns: [key], everyMinutes: null },
      fields: columns.map((name) => {
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
  return { tableId, field };
}

/** The secret and every token, which must never leave the server. */
function secretParts(): string[] {
  return [microsoft.secret, ...microsoft.tokens];
}

describe('Microsoft 365 sources on the server', () => {
  it('reaches Microsoft only on public addresses', async () => {
    const blocked = createSharePointListConnector({
      ...microsoftConnectorOptions({ production: true, automationsAllowPrivateHosts: false }, async () => [
        { address: '10.0.0.5', family: 4 },
      ]),
      sockets: { connect: async () => undefined, handshake: async () => undefined },
    });
    const result = await blocked.test({
      connection: {
        kind: 'sharepoint-list',
        tenantId: microsoft.tenant,
        clientId: microsoft.clientId,
        sites: [microsoft.site],
      },
      secrets: { clientSecret: microsoft.secret },
      timeoutMs: 5_000,
    });
    expect(result.steps).toEqual([
      expect.objectContaining({
        step: 'resolve',
        status: 'failed',
        messageKey: 'sources.microsoft.unreachable',
      }),
    ]);
  });

  it('keeps the secret when only the sites change, and asks for it again for another app', async () => {
    const source = await createSource({ kind: 'sharepoint-list', sites: [microsoft.site] });
    expect(source.secrets).toEqual(['clientSecret']);
    const more = await server.app.inject({
      method: 'PATCH',
      url: `/api/sources/${source.id}`,
      headers: server.owner.headers,
      payload: {
        connection: {
          kind: 'sharepoint-list',
          tenantId: microsoft.tenant,
          clientId: microsoft.clientId,
          sites: [microsoft.site, 'https://garden.sharepoint.com/sites/Orchard'],
        },
      },
    });
    expect(more.statusCode, more.body).toBe(200);
    expect(more.json<SourceMeta>().secrets).toEqual(['clientSecret']);
    const other = await server.app.inject({
      method: 'PATCH',
      url: `/api/sources/${source.id}`,
      headers: server.owner.headers,
      payload: {
        connection: {
          kind: 'sharepoint-list',
          tenantId: microsoft.tenant,
          clientId: '99999999-2222-4333-8444-555555555555',
          sites: [microsoft.site],
        },
      },
    });
    expect(other.json()).toMatchObject({ error: { messageKey: 'sources.secretsReenter' } });
  });

  it('syncs a SharePoint list, keeps an override when an item changes, and never records the secret', async () => {
    const source = await createSource({ kind: 'sharepoint-list', sites: [microsoft.site] });
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
      ['lists', 'ok'],
      ['rows', 'ok'],
    ]);
    const objects = await server.app.inject({
      url: `/api/sources/${source.id}/objects`,
      headers: server.owner.headers,
    });
    expect(objects.json<SourceObject[]>()).toEqual([
      {
        schema: microsoft.siteId,
        schemaLabel: 'Nursery',
        name: 'list-plants',
        label: 'Plants',
        type: 'list',
        rowEstimate: null,
      },
    ]);
    const select = { kind: 'object' as const, object: { schema: microsoft.siteId, name: 'list-plants' } };
    const shown = await preview(source.id, select);
    expect(shown.columns.map((column) => [column.name, column.suggested?.type])).toEqual([
      ['Plant', 'text'],
      ['Price', 'number'],
      ['Planted', 'date'],
      ['Organic', 'checkbox'],
      ['Item ID', 'number'],
    ]);
    expect(shown.keyCandidates).toEqual([['Item ID']]);
    const { tableId, field } = await syncedTable(
      source.id,
      select,
      shown,
      ['Plant', 'Price', 'Planted', 'Organic'],
      'Item ID',
    );
    const first = await sync(tableId);
    expect(first.source!.status, JSON.stringify(first.source!.status)).toMatchObject({
      state: 'idle',
      stats: { added: 3 },
    });
    const thyme = (await rows(tableId)).find((row) => row.values[field.Plant!] === 'Thyme')!;
    expect(thyme.values).toMatchObject({
      [field.Price!]: 4,
      [field.Planted!]: '2026-04-09',
      [field.Organic!]: false,
    });
    await applied({
      kind: 'record.update',
      tableId,
      records: [{ id: thyme.id, values: { [field.Plant!]: 'Lemon thyme' } }],
    });

    // Someone edits the list: Thyme is renamed and repriced, Sage leaves, and Mint arrives.
    microsoft.items = [
      microsoft.items[0]!,
      {
        id: '2',
        fields: { Title: 'Common thyme', Price: 4.5, Planted: '2026-04-09T07:00:00Z', Organic: false },
      },
      { id: '4', fields: { Title: 'Mint', Price: 2, Organic: true } },
    ];
    const second = await sync(tableId);
    expect(second.source!.status.stats).toMatchObject({ added: 1, changed: 1, removed: 1 });
    const kept = (await rows(tableId)).find((row) => row.id === thyme.id)!;
    expect(kept.values).toMatchObject({ [field.Plant!]: 'Lemon thyme', [field.Price!]: 4.5 });
    expect(kept.overrides![field.Plant!]).toMatchObject({ source: 'Common thyme' });

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
      JSON.stringify(second.source),
      listed.body,
      tested.body,
    ])
      for (const part of secretParts()) expect(text).not.toContain(part);
    // Only reads: the token requests are the one POST.
    expect(
      microsoft.requests
        .filter((entry) => entry.method !== 'GET')
        .every((entry) => entry.path.endsWith('/token')),
    ).toBe(true);
  });

  it('syncs a sheet of an Excel workbook read the way uploads are', async () => {
    const source = await createSource({ kind: 'excel-online', workbooks: [microsoft.workbook] });
    const objects = await server.app.inject({
      url: `/api/sources/${source.id}/objects`,
      headers: server.owner.headers,
    });
    expect(objects.json<SourceObject[]>().map((object) => [object.schema, object.name, object.type])).toEqual(
      [
        ['item-beds', 'Beds', 'sheet'],
        ['item-beds', 'Notes', 'sheet'],
      ],
    );
    const select = { kind: 'object' as const, object: { schema: 'item-beds', name: 'Beds' } };
    const shown = await preview(source.id, select);
    expect(shown.columns.map((column) => [column.name, column.suggested?.type])).toEqual([
      ['Bed', 'text'],
      ['Plant', 'text'],
      ['Area', 'number'],
    ]);
    expect(shown.keyCandidates).toEqual([['Bed'], ['Plant'], ['Area']]);
    const { tableId, field } = await syncedTable(source.id, select, shown, ['Bed', 'Plant', 'Area'], 'Bed');
    expect((await sync(tableId)).source!.status).toMatchObject({ state: 'idle', stats: { added: 2 } });
    microsoft.workbookBytes = await workbook([
      ['Bed', 'Plant', 'Area'],
      ['N-1', 'Basil', 2.5],
      ['N-2', 'Thyme', 3.5],
      ['S-1', 'Sage', 1],
    ]);
    expect((await sync(tableId)).source!.status.stats).toMatchObject({ added: 1, changed: 1, removed: 0 });
    expect((await rows(tableId)).map((row) => [row.values[field.Bed!], row.values[field.Area!]])).toEqual([
      ['N-1', 2.5],
      ['N-2', 3.5],
      ['S-1', 1],
    ]);
  });
});
