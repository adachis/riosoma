import {
  permissionFixture,
  applied,
  command,
  inject,
  schemaOf,
  tokenFor,
} from './permissions/permissions.test-helpers.js';
import { viewShapedBy } from './shared-view-reads.js';
import { GridConfig } from '@riosoma/contracts';
import { AccessScope } from './access.js';
import { changeFor } from '../realtime/redact.js';
import { databaseSchema, providerGridSettings } from '../ai/tools.js';
import type { Change, SharedViewLink, SharedViewOpen, TokenCreated, UndoResult } from '@riosoma/contracts';
import { afterAll, beforeAll, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { newId, type CommandBatchResult, type RowsPage } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { readFixture } from './snapshots.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'grid_extras');
}, 60000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});
async function fixture() {
  const read = await readFixture(server, [{ type: 'text' }, { type: 'text' }, { type: 'number' }]);
  const ids = Array.from({ length: 24 }, () => newId('record'));
  const [name, status, amount] = read.fields.map((field) => field.id) as [string, string, string];
  const send = async (command: Record<string, unknown>) => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${read.table.databaseId}/commands`,
      headers: server.owner.headers,
      payload: {
        clientId: newId('client'),
        commands: [{ id: newId('command'), groupId: newId('action'), ...command }],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<CommandBatchResult>().results[0]!;
  };
  expect(
    await send({
      kind: 'record.create',
      tableId: read.table.id,
      records: ids.map((id, index) => ({
        id,
        values: { [name]: `Record ${index}`, [status]: index < 12 ? 'A' : 'B', [amount]: index },
      })),
    }),
  ).toMatchObject({ status: 'applied' });
  const update = (config: unknown) => send({ kind: 'view.update', viewId: read.view.id, config });
  const page = async () =>
    (
      await server.app.inject({
        url: `/api/views/${read.view.id}/rows?refresh=1`,
        headers: server.owner.headers,
      })
    ).json<RowsPage>();
  return { read, ids, name, status, amount, send, update, page };
}
it('pins before grouped and sorted records, counts the remaining groups, and preserves pins through unrelated changes', async () => {
  const f = await fixture();
  expect(
    await f.update({
      pinnedRecordIds: [f.ids[15], f.ids[3]],
      groups: [{ fieldId: f.status, direction: 'asc' }],
      sorts: [{ fieldId: f.amount, direction: 'desc' }],
    }),
  ).toMatchObject({ status: 'applied' });
  const page = await f.page();
  expect(page.pinnedCount).toBe(2);
  expect(page.rows.slice(0, 2).map((row) => row?.id)).toEqual([f.ids[15], f.ids[3]]);
  expect(page.groups?.map((group) => [group.start, group.count])).toEqual([
    [2, 11],
    [13, 11],
  ]);
  expect(await f.update({ rowHeight: 'tall' })).toMatchObject({ status: 'applied' });
  expect((await f.page()).pinnedCount).toBe(2);
  expect(await f.update({ pinnedRecordIds: [newId('record')] })).toMatchObject({ status: 'rejected' });
});
it('keeps manual order per grid, refuses sorted moves, and exports group and field colors', async () => {
  const f = await fixture();
  expect(
    await f.send({
      kind: 'record.move',
      tableId: f.read.table.id,
      viewId: f.read.view.id,
      recordIds: [f.ids[3]],
      place: { before: f.ids[0] },
    }),
  ).toMatchObject({ status: 'applied' });
  expect((await f.page()).rows[0]?.id).toBe(f.ids[3]);
  expect(
    await f.update({
      pinnedRecordIds: [f.ids[2]],
      headerColors: { [f.status]: 'blue' },
      columnGroups: [{ id: 'details', name: 'Details', fieldIds: [f.status, f.amount], color: 'green' }],
    }),
  ).toMatchObject({ status: 'applied' });
  const response = await server.app.inject({
    url: `/api/views/${f.read.view.id}/export?format=xlsx&locale=en-US&timeZone=UTC`,
    headers: server.owner.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.rawPayload as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.worksheets[0]!;
  expect(sheet.getCell('B1').value).toBe('Details');
  expect(sheet.getCell('B1').fill).toMatchObject({ fgColor: { argb: 'FFDDEFE1' } });
  expect(sheet.getCell('B2').fill).toMatchObject({ fgColor: { argb: 'FFDEE9FD' } });
  expect(sheet.views[0]).toMatchObject({
    state: 'frozen',
    xSplit: 1,
    ySplit: 3,
    topLeftCell: 'B4',
    activeCell: 'B4',
  });
  expect(await f.update({ sorts: [{ fieldId: f.name, direction: 'asc' }] })).toMatchObject({
    status: 'applied',
  });
  expect(
    await f.send({
      kind: 'record.move',
      tableId: f.read.table.id,
      viewId: f.read.view.id,
      recordIds: [f.ids[3]],
      place: { before: f.ids[0] },
    }),
  ).toMatchObject({ status: 'rejected', error: { messageKey: 'data.record.moveSorted' } });
});

it('hides inaccessible pin references in schema, API, and realtime reads and preserves them on a visible edit', async () => {
  const f = await permissionFixture(server);
  const pins = [f.people.records.ana, f.people.records.zanzibar];
  await applied(server, server.owner, f.databaseId, {
    kind: 'view.update',
    viewId: f.people.viewId,
    config: { pinnedRecordIds: pins },
  });
  const who = f.persons.limitedCreator.signed;
  const shown = await schemaOf(server, who, f.databaseId);
  expect(shown.views.find((view) => view.id === f.people.viewId)!.config.pinnedRecordIds).toEqual([pins[0]]);
  const page = await server.app.inject({ url: `/api/views/${f.people.viewId}/rows`, headers: who.headers });
  expect(page.json<RowsPage>().pinnedCount).toBe(1);
  expect(JSON.stringify(page.json())).not.toContain(pins[1]);
  const token = await tokenFor(server, who);
  const api = await server.app.inject({
    url: `/api/v1/tables/${f.people.tableId}/views`,
    headers: { authorization: `Bearer ${token.token}` },
  });
  expect(api.statusCode).toBe(200);
  expect(api.body).not.toContain(pins[1]);
  const saved = (await schemaOf(server, server.owner, f.databaseId)).views.find(
    (view) => view.id === f.people.viewId,
  )!;
  const actor = {
    kind: 'member' as const,
    sessionId: newId('client'),
    adminRoles: [],
    csrfToken: who.info.csrfToken,
    userId: who.userId,
    orgId: server.owner.info.org.id,
  };
  const scope = new AccessScope(server.pool, server.schemas, actor);
  await scope.require(f.databaseId, 'read');
  const tools = await databaseSchema(server.app, actor, f.databaseId);
  expect(JSON.stringify(tools)).not.toContain(pins[1]);
  expect(tools.tables.find((table) => table.id === f.people.tableId)!.views[0]!.config).toMatchObject({
    pinnedRecordIds: [pins[0]],
  });
  const event = await changeFor(server.pool, server.schemas, scope, f.databaseId, {
    kind: 'view.updated',
    view: saved,
  } as Change);
  expect(JSON.stringify(event)).not.toContain(pins[1]);
  expect(
    await command(server, who, f.databaseId, {
      kind: 'view.update',
      viewId: f.people.viewId,
      config: { pinnedRecordIds: [] },
    }),
  ).toMatchObject({ status: 'applied' });
  expect(
    (await schemaOf(server, server.owner, f.databaseId)).views.find((view) => view.id === f.people.viewId)!
      .config.pinnedRecordIds,
  ).toEqual([pins[1]]);
  expect(
    await command(server, who, f.databaseId, {
      kind: 'view.update',
      viewId: f.people.viewId,
      config: { pinnedRecordIds: [f.people.records.zulu] },
    }),
  ).toMatchObject({ status: 'rejected' });
});

it('undoes a pin for a schema editor who can’t see a field the view groups', async () => {
  const f = await permissionFixture(server);
  const { salary, notes } = f.people.fields;
  const columnGroups = [{ id: 'details', name: 'Details', fieldIds: [salary, notes], collapsed: false }];
  await applied(server, server.owner, f.databaseId, {
    kind: 'view.update',
    viewId: f.people.viewId,
    config: {
      summaries: {},
      columnGroups,
      headerColors: { [salary]: 'red', [notes]: 'blue' },
      iconSets: [{ fieldId: salary, thresholds: [1, 2], labels: ['Private band', '', ''] }],
    },
  });
  const who = f.persons.creator.signed;
  const shown = (await schemaOf(server, who, f.databaseId)).views.find(
    (view) => view.id === f.people.viewId,
  )!;
  expect(shown.config.columnGroups).toEqual([
    { id: 'details', name: 'Details', fieldIds: [notes], collapsed: false },
  ]);
  expect(shown.config.iconSets).toEqual([]);
  const groupId = newId('action');
  const pinned = await inject(server, who, 'POST', `/api/databases/${f.databaseId}/commands`, {
    clientId: newId('client'),
    commands: [
      {
        id: newId('command'),
        groupId,
        kind: 'view.update',
        viewId: f.people.viewId,
        config: { pinnedRecordIds: [f.people.records.ana], rowHeight: 'tall' },
      },
    ],
  });
  expect(pinned.statusCode, pinned.body).toBe(200);
  const undone = await inject(server, who, 'POST', `/api/databases/${f.databaseId}/undo`, {
    commandId: newId('command'),
    groupId,
    clientId: newId('client'),
  });
  expect(undone.statusCode, undone.body).toBe(200);
  expect(undone.json<UndoResult>()).toMatchObject({ status: 'applied', skipped: 0 });
  const saved = (await schemaOf(server, server.owner, f.databaseId)).views.find(
    (view) => view.id === f.people.viewId,
  )!;
  expect(saved.config.pinnedRecordIds).toEqual([]);
  expect(saved.config.rowHeight).not.toBe('tall');
  expect(saved.config.columnGroups).toEqual(columnGroups);
  expect(saved.config.headerColors).toEqual({ [salary]: 'red', [notes]: 'blue' });
  const redone = await inject(server, who, 'POST', `/api/databases/${f.databaseId}/redo`, {
    commandId: newId('command'),
    groupId,
    clientId: newId('client'),
  });
  expect(redone.statusCode, redone.body).toBe(200);
  expect(redone.json<UndoResult>()).toMatchObject({ status: 'applied', skipped: 0 });
  const after = (await schemaOf(server, server.owner, f.databaseId)).views.find(
    (view) => view.id === f.people.viewId,
  )!;
  expect(after.config.pinnedRecordIds).toEqual([f.people.records.ana]);
  expect(after.config.columnGroups).toEqual(columnGroups);
});

it('changes visible icon sets without exposing or overwriting hidden settings', async () => {
  const f = await permissionFixture(server);
  const score = newId('field');
  await applied(server, server.owner, f.databaseId, {
    kind: 'field.create',
    tableId: f.people.tableId,
    field: { id: score, name: 'Score', type: 'number', description: '', options: {} },
  });
  const privateSet = {
    fieldId: f.people.fields.salary,
    style: 'flags',
    thresholds: [1, 2],
    labels: ['Private band', '', ''],
  };
  const publicSet = { fieldId: score, style: 'arrows', thresholds: [0, 100], labels: ['', '', ''] };
  const update = (who: typeof server.owner, iconSets: unknown[]) =>
    command(server, who, f.databaseId, {
      kind: 'view.update',
      viewId: f.people.viewId,
      config: { iconSets },
    });
  expect(await update(server.owner, [privateSet, publicSet])).toMatchObject({ status: 'applied' });
  const who = f.persons.creator.signed;
  const sets = async (reader: typeof server.owner) =>
    (await schemaOf(server, reader, f.databaseId)).views.find((view) => view.id === f.people.viewId)!.config
      .iconSets;
  expect(await sets(who)).toEqual([publicSet]);
  expect(await update(who, [{ ...privateSet, thresholds: [3, 4] }, publicSet])).toMatchObject({
    status: 'rejected',
    error: { messageKey: 'data.access.fieldHidden' },
  });
  const changed = { ...publicSet, thresholds: [10, 20], labels: ['', '', 'Complete'] };
  expect(await update(who, [changed])).toMatchObject({ status: 'applied' });
  expect(await sets(who)).toEqual([changed]);
  expect(await sets(server.owner)).toEqual([privateSet, changed]);
  expect(await update(who, [])).toMatchObject({ status: 'applied' });
  expect(await sets(server.owner)).toEqual([privateSet]);
});

it('refuses a move of a grouped field the person can’t see into another group', async () => {
  const f = await permissionFixture(server);
  const { salary, notes, region } = f.people.fields;
  await applied(server, server.owner, f.databaseId, {
    kind: 'view.update',
    viewId: f.people.viewId,
    config: {
      summaries: {},
      columnGroups: [
        { id: 'pay', name: 'Pay', fieldIds: [salary] },
        { id: 'details', name: 'Details', fieldIds: [notes] },
      ],
    },
  });
  const who = f.persons.creator.signed;
  expect(
    await command(server, who, f.databaseId, {
      kind: 'view.update',
      viewId: f.people.viewId,
      config: { columnGroups: [{ id: 'details', name: 'Details', fieldIds: [notes, salary] }] },
    }),
  ).toMatchObject({ status: 'rejected', error: { messageKey: 'data.access.fieldHidden' } });
  expect(
    await command(server, who, f.databaseId, {
      kind: 'view.update',
      viewId: f.people.viewId,
      config: { columnGroups: [{ id: 'pay', name: 'Pay', fieldIds: [salary, region] }] },
    }),
  ).toMatchObject({ status: 'applied' });
  const saved = (await schemaOf(server, server.owner, f.databaseId)).views.find(
    (view) => view.id === f.people.viewId,
  )!;
  // Salary stays in the group it was stored in, and the group the patch left out is gone.
  expect(saved.config.columnGroups).toEqual([
    { id: 'pay', name: 'Pay', fieldIds: [salary, region], collapsed: false },
  ]);
});

it('shares pin order and presentation without exposing saved pin identifiers', async () => {
  const f = await fixture();
  expect(
    await f.update({
      pinnedRecordIds: [f.ids[15]],
      headerColors: { [f.status]: 'blue' },
      columnGroups: [{ id: 'details', name: 'Details', fieldIds: [f.status, f.amount], color: 'green' }],
    }),
  ).toMatchObject({ status: 'applied' });
  const published = await server.app.inject({
    method: 'PUT',
    url: `/api/views/${f.read.view.id}/shared-view`,
    headers: server.owner.headers,
  });
  expect(published.statusCode, published.body).toBe(200);
  const link = published.json<SharedViewLink>();
  const layout = await server.app.inject({ url: `/api/public/views/${link.linkId}` });
  expect(layout.statusCode, layout.body).toBe(200);
  const display = layout.json<SharedViewOpen>().display;
  expect(display.headerColors).toEqual({ [f.status]: 'blue' });
  expect(display.columnGroups?.[0]).toMatchObject({ name: 'Details', color: 'green' });
  expect(layout.body).not.toContain(f.ids[15]);
  const rows = await server.app.inject({ url: `/api/public/views/${link.linkId}/rows` });
  expect(rows.statusCode, rows.body).toBe(200);
  expect(rows.json<RowsPage>().pinnedCount).toBe(1);
  expect(rows.json<RowsPage>().rows[0]?.id).toBe(f.ids[15]);
});

it('authorizes API arrangement changes and preserves omitted configuration', async () => {
  const f = await fixture();
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: server.owner.headers,
    payload: { name: 'Grid tests', databases: 'all', scopes: ['schema.bases:write', 'data.records:write'] },
  });
  expect(response.statusCode, response.body).toBe(200);
  const headers = { authorization: `Bearer ${response.json<TokenCreated>().token}` };
  const patch = (payload: Record<string, unknown>) =>
    server.app.inject({
      method: 'PATCH',
      url: `/api/v1/views/${f.read.view.id}/grid`,
      headers,
      payload,
    });
  expect((await patch({ pinnedRecordIds: [f.ids[2]] })).json()).toMatchObject({
    results: [{ status: 'applied' }],
  });
  const iconSets = [{ fieldId: f.amount, thresholds: [0, 10], style: 'flags', labels: ['', '', 'Complete'] }];
  expect((await patch({ iconSets })).json()).toMatchObject({ results: [{ status: 'applied' }] });
  expect((await patch({ headerColors: { [f.status]: 'red' } })).json()).toMatchObject({
    results: [{ status: 'applied' }],
  });
  const saved = await schemaOf(server, server.owner, f.read.table.databaseId);
  expect(saved.views.find((view) => view.id === f.read.view.id)!.config.iconSets).toEqual(iconSets);
  expect((await f.page()).pinnedCount).toBe(1);
  const move = await server.app.inject({
    method: 'POST',
    url: `/api/v1/tables/${f.read.table.id}/records/move`,
    headers,
    payload: { viewId: f.read.view.id, recordIds: [f.ids[3]], place: { before: f.ids[0] } },
  });
  expect(move.statusCode, move.body).toBe(200);
  expect(move.json()).toMatchObject({
    recordIds: [f.ids[3]],
    viewId: f.read.view.id,
    undoGroupId: expect.any(String),
  });
  expect((await f.page()).rows.slice(0, 2).map((row) => row?.id)).toEqual([f.ids[2], f.ids[3]]);
  const reader = await tokenFor(server, server.owner);
  const denied = await server.app.inject({
    method: 'PATCH',
    url: `/api/v1/views/${f.read.view.id}/grid`,
    headers: { authorization: `Bearer ${reader.token}` },
    payload: { pinnedRecordIds: [] },
  });
  expect(denied.statusCode).toBe(403);
});

it('keeps a grid’s arrangement on grid views alone', async () => {
  const f = await fixture();
  const listId = newId('view');
  expect(
    await f.send({
      kind: 'view.create',
      view: { id: listId, tableId: f.read.table.id, name: 'List', type: 'list', config: {} },
    }),
  ).toMatchObject({ status: 'applied' });
  for (const config of [
    { pinnedRecordIds: [f.ids[0]] },
    { columnGroups: [{ id: 'details', name: 'Details', fieldIds: [f.name] }] },
    { headerColors: { [f.name]: 'blue' } },
  ])
    expect(await f.send({ kind: 'view.update', viewId: listId, config })).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.view.gridOnly' },
    });
  // A setting the list view keeps is left alone by a change to something else.
  expect(await f.send({ kind: 'view.update', viewId: listId, config: { rowHeight: 'tall' } })).toMatchObject({
    status: 'applied',
  });
  const token = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: server.owner.headers,
    payload: { name: 'Grid tests', databases: 'all', scopes: ['schema.bases:write'] },
  });
  const refused = await server.app.inject({
    method: 'PATCH',
    url: `/api/v1/views/${listId}/grid`,
    headers: { authorization: `Bearer ${token.json<TokenCreated>().token}` },
    payload: { pinnedRecordIds: [f.ids[0]] },
  });
  expect(refused.statusCode, refused.body).toBe(422);
  expect(refused.json()).toMatchObject({ error: { messageKey: 'data.view.gridOnly' } });
  // Someone outside the database learns nothing about its views, not even their kind.
  const outsider = await server.addMember();
  const outsiderToken = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: outsider.headers,
    payload: { name: 'Grid tests', databases: 'all', scopes: ['schema.bases:write'] },
  });
  expect(outsiderToken.statusCode, outsiderToken.body).toBe(200);
  for (const viewId of [listId, f.read.view.id]) {
    const hidden = await server.app.inject({
      method: 'PATCH',
      url: `/api/v1/views/${viewId}/grid`,
      headers: { authorization: `Bearer ${outsiderToken.json<TokenCreated>().token}` },
      payload: { pinnedRecordIds: [f.ids[0]] },
    });
    expect(hidden.statusCode, hidden.body).toBe(404);
    expect(hidden.json()).toMatchObject({ error: { messageKey: 'errors.notFound' } });
  }
  // Pins stored on a view of another kind, however they got there, never reorder it or freeze its
  // export around them.
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'views')}
    SET config = jsonb_set(config, '{pinnedRecordIds}', ${JSON.stringify([f.ids[5]])}::jsonb)
    WHERE id = ${listId}`,
  );
  const rows = await server.app.inject({
    url: `/api/views/${listId}/rows?refresh=1`,
    headers: server.owner.headers,
  });
  expect(rows.statusCode, rows.body).toBe(200);
  expect(rows.json<RowsPage>().pinnedCount).toBe(0);
  expect(rows.json<RowsPage>().rows[0]?.id).toBe(f.ids[0]);
  const exported = await server.app.inject({
    url: `/api/views/${listId}/export?format=xlsx&locale=en-US&timeZone=UTC`,
    headers: server.owner.headers,
  });
  expect(exported.statusCode, exported.body).toBe(200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(exported.rawPayload as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  expect(workbook.worksheets[0]!.views[0]).toMatchObject({
    state: 'frozen',
    ySplit: 1,
    topLeftCell: 'A2',
  });
});

it('names only shown fields in the grid settings a provider reads', () => {
  const shown = newId('field');
  const withheld = newId('field');
  const other = newId('field');
  const config = GridConfig.parse({
    pinnedRecordIds: [newId('record')],
    columnGroups: [
      { id: 'pay', name: 'Pay', fieldIds: [withheld] },
      { id: 'details', name: 'Details', fieldIds: [shown, other], color: 'green' },
    ],
    headerColors: { [withheld]: 'red', [shown]: 'blue' },
    fieldOrder: [withheld, shown],
    iconSets: [
      { fieldId: withheld, thresholds: [0, 10], labels: ['Private', '', ''] },
      { fieldId: shown, thresholds: [5, 20] },
    ],
    frozenFieldCount: 2,
  });
  expect(providerGridSettings(config, new Set([shown]))).toEqual({
    pinnedRecordIds: config.pinnedRecordIds,
    iconSets: [{ fieldId: shown, thresholds: [5, 20], style: 'arrows', labels: ['', '', ''] }],
    columnGroups: [{ id: 'details', name: 'Details', fieldIds: [shown], color: 'green', collapsed: false }],
    headerColors: { [shown]: 'blue' },
    fieldOrder: [shown],
    frozenFieldCount: 2,
  });
});

it('keeps a restricted field out of the grid settings a provider reads for someone it’s hidden from', async () => {
  const f = await permissionFixture(server);
  const { salary, notes } = f.people.fields;
  await applied(server, server.owner, f.databaseId, {
    kind: 'view.update',
    viewId: f.people.viewId,
    config: {
      summaries: {},
      columnGroups: [{ id: 'details', name: 'Details', fieldIds: [salary, notes] }],
      headerColors: { [salary]: 'red', [notes]: 'blue' },
    },
  });
  const who = f.persons.creator.signed;
  const actor = {
    kind: 'member' as const,
    sessionId: newId('client'),
    adminRoles: [],
    csrfToken: who.info.csrfToken,
    userId: who.userId,
    orgId: server.owner.info.org.id,
  };
  const tools = await databaseSchema(server.app, actor, f.databaseId);
  const text = JSON.stringify(tools);
  expect(text).not.toContain(salary);
  expect(text).toContain(notes);
  expect(
    tools.tables
      .find((table) => table.id === f.people.tableId)!
      .views.find((view) => view.id === f.people.viewId)!.config,
  ).toMatchObject({
    columnGroups: [{ id: 'details', name: 'Details', fieldIds: [notes] }],
    headerColors: { [notes]: 'blue' },
  });
});

it('does not treat presentation references as value shaping in public reads', () => {
  const field = newId('field');
  const config = GridConfig.parse({
    headerColors: { [field]: 'blue' },
    columnGroups: [{ id: 'details', name: 'Details', fieldIds: [field] }],
    pinnedRecordIds: [newId('record')],
  });
  expect(viewShapedBy(config, new Set([field, ...config.pinnedRecordIds]))).toBe(false);
  config.sorts = [{ fieldId: field, direction: 'asc' }];
  expect(viewShapedBy(config, new Set([field]))).toBe(true);
});

it('drops trashed pins on a pin write', async () => {
  const f = await fixture();
  expect(await f.update({ pinnedRecordIds: [f.ids[0], f.ids[1]] })).toMatchObject({ status: 'applied' });
  expect(
    await f.send({ kind: 'record.trash', tableId: f.read.table.id, recordIds: [f.ids[0]] }),
  ).toMatchObject({ status: 'applied' });
  expect(await f.update({ pinnedRecordIds: [f.ids[0], f.ids[1], f.ids[2]] })).toMatchObject({
    status: 'applied',
  });
  const saved = await schemaOf(server, server.owner, f.read.table.databaseId);
  expect(saved.views.find((view) => view.id === f.read.view.id)!.config.pinnedRecordIds).toEqual([
    f.ids[1],
    f.ids[2],
  ]);
});

it('reports the pin limit explicitly when unreadable pins are preserved', async () => {
  const f = await permissionFixture(server);
  const who = f.persons.limitedCreator.signed;
  const ids = Array.from({ length: 20 }, () => newId('record'));
  await applied(server, server.owner, f.databaseId, {
    kind: 'record.create',
    tableId: f.people.tableId,
    records: ids.map((id) => ({ id, values: {} })),
  });
  await applied(server, server.owner, f.databaseId, {
    kind: 'view.update',
    viewId: f.people.viewId,
    config: { pinnedRecordIds: ids },
  });
  expect(
    await command(server, who, f.databaseId, {
      kind: 'view.update',
      viewId: f.people.viewId,
      config: { pinnedRecordIds: [f.people.records.ana] },
    }),
  ).toMatchObject({ status: 'rejected', error: { messageKey: 'data.view.pinLimit' } });
});

it('serves public links when restricted fields have display-only header settings', async () => {
  const f = await permissionFixture(server);
  const { salary, notes } = f.people.fields;
  await applied(server, server.owner, f.databaseId, {
    kind: 'view.update',
    viewId: f.people.viewId,
    config: {
      summaries: {},
      headerColors: { [salary]: 'red', [notes]: 'blue' },
      columnGroups: [{ id: 'details', name: 'Details', fieldIds: [salary, notes], collapsed: true }],
    },
  });
  const published = await server.app.inject({
    method: 'PUT',
    url: `/api/views/${f.people.viewId}/shared-view`,
    headers: server.owner.headers,
  });
  expect(published.statusCode, published.body).toBe(200);
  const { linkId } = published.json<SharedViewLink>();
  const response = await server.app.inject({ url: `/api/public/views/${linkId}` });
  expect(response.statusCode, response.body).toBe(200);
  const display = response.json<SharedViewOpen>().display;
  expect(display.headerColors).toEqual({ [notes]: 'blue' });
  expect(display.columnGroups?.[0]?.fieldIds).toEqual([notes]);
  expect(response.body).not.toContain(salary);
  const rows = await server.app.inject({ url: `/api/public/views/${linkId}/rows` });
  expect(rows.statusCode, rows.body).toBe(200);
  expect(rows.body).not.toContain(salary);
});

it('omits trashed pins for unrestricted readers without erasing stored references', async () => {
  const f = await fixture();
  expect(await f.update({ pinnedRecordIds: [f.ids[0], f.ids[1]] })).toMatchObject({ status: 'applied' });
  expect(
    await f.send({ kind: 'record.trash', tableId: f.read.table.id, recordIds: [f.ids[0]] }),
  ).toMatchObject({ status: 'applied' });
  const shown = await schemaOf(server, server.owner, f.read.table.databaseId);
  expect(shown.views.find((view) => view.id === f.read.view.id)!.config.pinnedRecordIds).toEqual([f.ids[1]]);
  expect(await f.update({ rowHeight: 'tall' })).toMatchObject({ status: 'applied' });
  expect(
    await f.send({ kind: 'record.restore', tableId: f.read.table.id, recordIds: [f.ids[0]] }),
  ).toMatchObject({ status: 'applied' });
  expect((await f.page()).pinnedCount).toBe(2);
});

it('keeps grid group boundaries when manually arranging records', async () => {
  const f = await fixture();
  expect(await f.update({ groups: [{ fieldId: f.status, direction: 'asc' }] })).toMatchObject({
    status: 'applied',
  });
  expect(
    await f.send({
      kind: 'record.move',
      tableId: f.read.table.id,
      viewId: f.read.view.id,
      recordIds: [f.ids[15]],
      place: { before: f.ids[12] },
    }),
  ).toMatchObject({ status: 'applied' });
  const page = await f.page();
  expect(page.rows[0]?.id).toBe(f.ids[0]);
  expect(page.rows[12]?.id).toBe(f.ids[15]);
  expect(page.groups?.map((group) => [group.start, group.count])).toEqual([
    [0, 12],
    [12, 12],
  ]);
});
