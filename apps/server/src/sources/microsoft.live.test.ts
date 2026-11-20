/**
 * Microsoft 365 sources against the real Microsoft Graph and Dataverse.  Each suite runs only when
 * the test app's settings and its own are set (see `test/microsoft-live.ts`), and skips otherwise:
 *
 * - SharePoint lists and Excel workbooks need `RIOSOMA_TEST_SHAREPOINT_SITE`, a site the app was
 *   given with `Sites.Selected` and the manage role, so the suites can make their own list and
 *   upload their own workbook there.  A source itself only ever reads.
 * - Dataverse needs `RIOSOMA_TEST_DATAVERSE_URL`, an environment the app is an application user of,
 *   with a role that may create, read, and delete its own accounts, like Basic User.
 *
 * Each suite makes its own objects, named with `rio_test_`, syncs them into a throwaway database,
 * overrides a value, changes the source, syncs again, and checks the override survived and the
 * app's secret never reached the logs, the change history, the audit log, or any answer.  It
 * deletes what it made at the end.
 */
import { randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  dataverseEnvironmentOf,
  newId,
  sharePointSiteOf,
  workbookAddressOf,
  type CommandBatchResult,
  type DatabaseSchema,
  type RowData,
  type SourceMeta,
  type SourceObject,
  type SourcePreview,
  type SourceTestResult,
  type TableMeta,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type * as Logger from '../logger.js';
import { startServer, type ServerFixture } from '../test/fixture.js';
import {
  liveApp,
  liveDataverse,
  liveRequest,
  liveSite,
  liveToken,
  pause,
  TEST_PREFIX,
  type MicrosoftLive,
} from '../test/microsoft-live.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { fetchRowsById } from '../data/physical/records.js';
import { claimSyncs, runSync } from './sync.js';

const logs = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../logger.js', async (original) => {
  const actual = await original<typeof Logger>();
  return {
    ...actual,
    loggerOptions: (level: string, production: boolean) => ({
      ...actual.loggerOptions(level, production),
      stream: {
        write(line: string) {
          logs.lines.push(line);
        },
      },
    }),
  };
});

const app = liveApp();
const site = liveSite() ? sharePointSiteOf(liveSite()!) : null;
const environment = liveDataverse() ? dataverseEnvironmentOf(liveDataverse()!) : null;
const GRAPH = 'https://graph.microsoft.com/v1.0';
const suffix = randomBytes(3).toString('hex');

let kit: TestPostgres | undefined;
let server: ServerFixture;
let databaseId: string;

/** A server and a database to sync into, started once for whichever suites run. */
async function started(name: string): Promise<void> {
  if (kit) return;
  kit = await startTestPostgres();
  server = await startServer(kit, name, { logLevel: 'info' });
  const database = await request<DatabaseSchema>('POST', '/api/databases', {
    id: newId('database'),
    name: 'Microsoft live',
    table: {
      id: newId('table'),
      name: 'Local',
      fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  databaseId = database.json.database.id;
}

afterAll(async () => {
  await server?.close();
  await kit?.stop();
}, 60_000);

async function request<T>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  const response = await server.app.inject({
    method,
    url,
    headers: server.owner.headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  expect(response.statusCode, response.body).toBe(200);
  return { json: response.json<T>(), body: response.body };
}

async function applied(input: Record<string, unknown>) {
  const { json } = await request<CommandBatchResult>('POST', `/api/databases/${databaseId}/commands`, {
    clientId: newId('client'),
    commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
  });
  expect(json.results[0], JSON.stringify(json.results[0])).toMatchObject({ status: 'applied' });
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
  return fetchRowsById(
    server.pool,
    server.schemas.data,
    tableId,
    await loadFields(server.pool, server.schemas, [tableId]),
    ids.rows.map((row) => row.__id),
  );
}

/** A source for the test app, tested, with the steps its test climbed. */
async function source(connection: Record<string, unknown>) {
  const live = app as MicrosoftLive;
  const created = await request<SourceMeta>('POST', '/api/sources', {
    name: `${TEST_PREFIX}${connection.kind as string} ${suffix}`,
    connection: { tenantId: live.tenantId, clientId: live.clientId, ...connection },
    secrets: { clientSecret: live.clientSecret },
  });
  const tested = await request<SourceTestResult>('POST', `/api/sources/${created.json.id}/test`);
  return { id: created.json.id, tested };
}

/** A synced table of `columns` from a preview, keyed by `key`, and each column's field. */
async function syncedTable(
  sourceId: string,
  select: unknown,
  shown: SourcePreview,
  columns: string[],
  key: string,
) {
  const tableId = newId('table');
  const field = Object.fromEntries(shown.columns.map((column) => [column.name, newId('field')]));
  await applied({
    kind: 'table.create',
    table: {
      id: tableId,
      name: `Synced ${suffix} ${tableId.slice(-4)}`,
      source: { sourceId, select, keyColumns: [key], everyMinutes: null },
      fields: columns.map((name) => {
        const column = shown.columns.find((entry) => entry.name === name);
        expect(column, `the preview has no column named ${name}`).toBeDefined();
        return {
          id: field[name],
          name,
          type: column!.suggested!.type,
          options: column!.suggested!.options,
          source: { column: name, sourceType: column!.sourceType },
        };
      }),
      view: { id: newId('view'), name: 'Grid' },
      records: [],
    },
  });
  return { tableId, field };
}

/** Checks the secret and the tokens never reached anything the server keeps or shows. */
async function keptToItself(tableId: string, answers: string[], tokens: string[]) {
  const changes = await query<{ body: unknown }>(
    server.pool,
    sql`SELECT body FROM ${ident(server.schemas.app, 'changes')} WHERE table_id = ${tableId}`,
  );
  const events = await query<{ detail: unknown }>(
    server.pool,
    sql`SELECT * FROM ${ident(server.schemas.audit, 'events')}`,
  );
  const listed = await request<SourceMeta[]>('GET', '/api/sources');
  for (const text of [
    JSON.stringify(changes.rows),
    JSON.stringify(events.rows),
    listed.body,
    ...answers,
    logs.lines.join('\n'),
  ])
    for (const part of [(app as MicrosoftLive).clientSecret, ...tokens]) expect(text).not.toContain(part);
}

describe.skipIf(!app || !site)('SharePoint list sources against the real Microsoft Graph', () => {
  let token = '';
  let siteId = '';
  let listId: string | undefined;
  const title = `${TEST_PREFIX}plants_${suffix}`;

  const graph = async (method: string, path: string, body?: unknown) => {
    const answer = await liveRequest(token, method, `${GRAPH}${path}`, body);
    expect(answer.status, `${method} ${path}: ${answer.status} ${answer.text}`).toBeLessThan(300);
    return answer.json;
  };

  beforeAll(async () => {
    token = await liveToken(app as MicrosoftLive);
    const address = new URL(site!);
    siteId = String(
      (await graph('GET', `/sites/${address.host}${address.pathname === '/' ? '' : `:${address.pathname}`}`))
        .id,
    );
    const list = await graph('POST', `/sites/${siteId}/lists`, {
      displayName: title,
      list: { template: 'genericList' },
      columns: [
        { name: 'Price', number: { decimalPlaces: 'two' } },
        { name: 'Planted', dateTime: { format: 'dateOnly' } },
        { name: 'Organic', boolean: {} },
        { name: 'Season', choice: { choices: ['Spring', 'Summer'], displayAs: 'dropDownMenu' } },
      ],
    });
    listId = String(list.id);
    for (const fields of [
      { Title: 'Basil', Price: 3.5, Planted: '2026-04-02', Organic: true, Season: 'Spring' },
      { Title: 'Thyme', Price: 4, Planted: '2026-04-09', Organic: false, Season: 'Summer' },
      { Title: 'Sage', Price: 5.25, Planted: '2026-04-16', Organic: true, Season: 'Spring' },
    ])
      await graph('POST', `/sites/${siteId}/lists/${listId}/items`, { fields });
    await started('m365_live');
  }, 180_000);

  afterAll(async () => {
    if (listId) await liveRequest(token, 'DELETE', `${GRAPH}/sites/${siteId}/lists/${listId}`);
  }, 60_000);

  it(
    'syncs a list, keeps an override when an item changes, and keeps the secret to itself',
    { timeout: 300_000 },
    async () => {
      const { id, tested } = await source({ kind: 'sharepoint-list', sites: [site] });
      expect(
        tested.json.steps.map((step) => [step.step, step.status]),
        tested.body,
      ).toEqual([
        ['resolve', 'ok'],
        ['connect', 'ok'],
        ['tls', 'ok'],
        ['authenticate', 'ok'],
        ['lists', 'ok'],
        ['rows', 'ok'],
      ]);
      const objects = await request<SourceObject[]>('GET', `/api/sources/${id}/objects`);
      expect(objects.json).toContainEqual(
        expect.objectContaining({ schema: siteId, name: listId, label: title, type: 'list' }),
      );
      const select = { kind: 'object' as const, object: { schema: siteId, name: listId! } };
      const preview = await request<SourcePreview>('POST', `/api/sources/${id}/preview`, { select });
      const types = Object.fromEntries(
        preview.json.columns.map((column) => [column.name, column.suggested?.type]),
      );
      expect(types).toMatchObject({
        Title: 'text',
        Price: 'number',
        Planted: 'date',
        Organic: 'checkbox',
        Season: 'singleSelect',
        'Item ID': 'number',
      });
      expect(preview.json.keyCandidates).toEqual([['Item ID']]);
      const { tableId, field } = await syncedTable(
        id,
        select,
        preview.json,
        ['Title', 'Price', 'Planted', 'Organic', 'Season'],
        'Item ID',
      );
      const first = await sync(tableId);
      expect(first.source!.status, JSON.stringify(first.source!.status)).toMatchObject({
        state: 'idle',
        stats: { added: 3 },
      });
      const thyme = (await rows(tableId)).find((row) => row.values[field.Title!] === 'Thyme')!;
      // A date-only column keeps the day it was given, whatever the site's time zone.
      expect(thyme.values).toMatchObject({
        [field.Price!]: 4,
        [field.Planted!]: '2026-04-09',
        [field.Organic!]: false,
        [field.Season!]: 'Summer',
      });
      await applied({
        kind: 'record.update',
        tableId,
        records: [{ id: thyme.id, values: { [field.Title!]: 'Lemon thyme' } }],
      });

      const items = await graph(
        'GET',
        `/sites/${siteId}/lists/${listId}/items?$expand=fields($select=Title)&$select=id`,
      );
      const item = (items.value as Array<{ id: string; fields: { Title: string } }>).find(
        (entry) => entry.fields.Title === 'Thyme',
      )!;
      await graph('PATCH', `/sites/${siteId}/lists/${listId}/items/${item.id}/fields`, {
        Title: 'Common thyme',
        Price: 4.5,
      });
      const second = await sync(tableId);
      expect(second.source!.status.stats, JSON.stringify(second.source!.status)).toMatchObject({
        added: 0,
        changed: 1,
        removed: 0,
      });
      const kept = (await rows(tableId)).find((row) => row.id === thyme.id)!;
      expect(kept.values).toMatchObject({ [field.Title!]: 'Lemon thyme', [field.Price!]: 4.5 });
      expect(kept.overrides![field.Title!]).toMatchObject({ source: 'Common thyme' });
      await keptToItself(tableId, [tested.body, preview.body, JSON.stringify(second.source)], [token]);
    },
  );
});

describe.skipIf(!app || !site)('Excel workbook sources against the real Microsoft Graph', () => {
  let token = '';
  let driveId = '';
  let itemId: string | undefined;
  const name = `${TEST_PREFIX}beds_${suffix}.xlsx`;

  const graph = async (method: string, path: string, body?: unknown) => {
    const answer = await liveRequest(token, method, `${GRAPH}${path}`, body);
    expect(answer.status, `${method} ${path}: ${answer.status} ${answer.text}`).toBeLessThan(300);
    return answer.json;
  };

  async function upload(rowsOf: unknown[][]) {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('Beds').addRows(rowsOf);
    const bytes = Buffer.from(await book.xlsx.writeBuffer());
    const answer = await liveRequest(
      token,
      'PUT',
      `${GRAPH}/drives/${driveId}/root:/${encodeURIComponent(name)}:/content`,
      bytes,
      {
        'content-type': 'application/octet-stream',
      },
    );
    expect(answer.status, answer.text).toBeLessThan(300);
    itemId = String(answer.json.id);
  }

  beforeAll(async () => {
    token = await liveToken(app as MicrosoftLive);
    const address = new URL(site!);
    const found = await graph(
      'GET',
      `/sites/${address.host}${address.pathname === '/' ? '' : `:${address.pathname}`}`,
    );
    driveId = String((await graph('GET', `/sites/${String(found.id)}/drive?$select=id,webUrl`)).id);
    await upload([
      ['Bed', 'Plant', 'Area'],
      ['N-1', 'Basil', 2.5],
      ['N-2', 'Thyme', 3],
    ]);
    await started('m365_live');
  }, 180_000);

  afterAll(async () => {
    if (itemId) await liveRequest(token, 'DELETE', `${GRAPH}/drives/${driveId}/items/${itemId}`);
  }, 60_000);

  it('syncs a workbook’s sheet, and follows it when the file changes', { timeout: 300_000 }, async () => {
    const drive = await graph('GET', `/drives/${driveId}?$select=webUrl`);
    const workbook = workbookAddressOf(`${String(drive.webUrl)}/${encodeURIComponent(name)}`);
    expect(workbook, `no workbook address from ${String(drive.webUrl)}`).not.toBeNull();
    const { id, tested } = await source({ kind: 'excel-online', workbooks: [workbook] });
    expect(
      tested.json.steps.map((step) => [step.step, step.status]),
      tested.body,
    ).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'ok'],
      ['authenticate', 'ok'],
      ['workbooks', 'ok'],
      ['rows', 'ok'],
    ]);
    const objects = await request<SourceObject[]>('GET', `/api/sources/${id}/objects`);
    expect(objects.json.map((object) => [object.schema, object.name])).toEqual([[itemId, 'Beds']]);
    const select = { kind: 'object' as const, object: { schema: itemId!, name: 'Beds' } };
    const preview = await request<SourcePreview>('POST', `/api/sources/${id}/preview`, { select });
    expect(preview.json.columns.map((column) => [column.name, column.suggested?.type])).toEqual([
      ['Bed', 'text'],
      ['Plant', 'text'],
      ['Area', 'number'],
    ]);
    const { tableId, field } = await syncedTable(id, select, preview.json, ['Bed', 'Plant', 'Area'], 'Bed');
    expect((await sync(tableId)).source!.status).toMatchObject({ state: 'idle', stats: { added: 2 } });
    const thyme = (await rows(tableId)).find((row) => row.values[field.Bed!] === 'N-2')!;
    await applied({
      kind: 'record.update',
      tableId,
      records: [{ id: thyme.id, values: { [field.Plant!]: 'Lemon thyme' } }],
    });
    await upload([
      ['Bed', 'Plant', 'Area'],
      ['N-1', 'Basil', 2.5],
      ['N-2', 'Common thyme', 3.5],
      ['S-1', 'Sage', 1],
    ]);
    // A new version of a file takes a moment to be the one Graph hands out.
    await pause(5_000);
    const second = await sync(tableId);
    expect(second.source!.status.stats, JSON.stringify(second.source!.status)).toMatchObject({
      added: 1,
      changed: 1,
      removed: 0,
    });
    const kept = (await rows(tableId)).find((row) => row.id === thyme.id)!;
    expect(kept.values).toMatchObject({ [field.Plant!]: 'Lemon thyme', [field.Area!]: 3.5 });
    expect(kept.overrides![field.Plant!]).toMatchObject({ source: 'Common thyme' });
    await keptToItself(tableId, [tested.body, preview.body, JSON.stringify(second.source)], [token]);
  });
});

describe.skipIf(!app || !environment)('Dataverse sources against a real environment', () => {
  let token = '';
  const made: string[] = [];
  const api = `${environment}/api/data/v9.2`;
  const names = ['Basil', 'Thyme', 'Sage'].map((plant) => `${TEST_PREFIX}${suffix} ${plant}`);

  beforeAll(async () => {
    token = await liveToken(app as MicrosoftLive, environment!);
    for (const [index, name] of names.entries()) {
      const created = await liveRequest(
        token,
        'POST',
        `${api}/accounts`,
        { name, numberofemployees: index + 3 },
        {
          prefer: 'return=representation',
          'odata-version': '4.0',
          'odata-maxversion': '4.0',
        },
      );
      expect(created.status, created.text).toBeLessThan(300);
      made.push(String(created.json.accountid));
    }
    await started('m365_live');
  }, 180_000);

  afterAll(async () => {
    for (const id of made) await liveRequest(token, 'DELETE', `${api}/accounts(${id})`);
  }, 60_000);

  it(
    'syncs a table, keeps an override when a row changes, and keeps the secret to itself',
    { timeout: 300_000 },
    async () => {
      const { id, tested } = await source({ kind: 'dataverse', environmentUrl: environment });
      expect(
        tested.json.steps.map((step) => [step.step, step.status]),
        tested.body,
      ).toEqual([
        ['resolve', 'ok'],
        ['connect', 'ok'],
        ['tls', 'ok'],
        ['authenticate', 'ok'],
        ['entities', 'ok'],
      ]);
      const objects = await request<SourceObject[]>('GET', `/api/sources/${id}/objects`);
      expect(objects.json).toContainEqual(expect.objectContaining({ name: 'account', type: 'table' }));
      const select = { kind: 'object' as const, object: { schema: null, name: 'account' } };
      const preview = await request<SourcePreview>('POST', `/api/sources/${id}/preview`, { select });
      const accountName = preview.json.columns.find((column) => /^account name$/i.test(column.name))!;
      const employees = preview.json.columns.find((column) => /employees/i.test(column.name))!;
      expect(accountName.suggested?.type).toBe('text');
      expect(employees.suggested).toMatchObject({ type: 'number', options: { precision: 0 } });
      expect(preview.json.keyCandidates).toEqual([['Row ID']]);
      const { tableId, field } = await syncedTable(
        id,
        select,
        preview.json,
        [accountName.name, employees.name],
        'Row ID',
      );
      const first = await sync(tableId);
      expect(first.source!.status.state, JSON.stringify(first.source!.status)).toBe('idle');
      const ours = () =>
        rows(tableId).then((all) =>
          all.filter((row) => names.includes(String(row.values[field[accountName.name]!]))),
        );
      expect((await ours()).map((row) => row.values[field[employees.name]!]).sort()).toEqual([3, 4, 5]);
      const thyme = (await ours()).find((row) => row.values[field[accountName.name]!] === names[1])!;
      await applied({
        kind: 'record.update',
        tableId,
        records: [{ id: thyme.id, values: { [field[accountName.name]!]: `${names[1]} (lemon)` } }],
      });
      const changed = await liveRequest(token, 'PATCH', `${api}/accounts(${made[1]})`, {
        numberofemployees: 40,
      });
      expect(changed.status, changed.text).toBeLessThan(300);
      const second = await sync(tableId);
      expect(second.source!.status.stats, JSON.stringify(second.source!.status)).toMatchObject({
        changed: 1,
      });
      const kept = (await rows(tableId)).find((row) => row.id === thyme.id)!;
      expect(kept.values).toMatchObject({
        [field[accountName.name]!]: `${names[1]} (lemon)`,
        [field[employees.name]!]: 40,
      });
      await keptToItself(tableId, [tested.body, preview.body, JSON.stringify(second.source)], [token]);
    },
  );
});
