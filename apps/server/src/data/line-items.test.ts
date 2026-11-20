import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DatabaseArchive,
  newId,
  type CommandBatchResult,
  type DatabaseSchema,
  type RowData,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { publicDefinition, submitAnswers } from './public-forms.js';
import ExcelJS from 'exceljs';
import { actorFor } from '../automations/run.js';
import { AccessScope } from './access.js';
import { requireWholeRead, writeArchive } from './archives/write.js';
import { restoreArchive } from './archives/restore.js';
import { openFormEdit, saveFormEdit, undoFormEdit } from './public-form-edits.js';
import { readFormEditToken } from './public-form-edit-tokens.js';

let kit: TestPostgres;
let server: ServerFixture;
const clientId = newId('client');
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'lines');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function command(
  databaseId: string,
  input: Record<string, unknown>,
  who = server.owner,
  error?: string,
) {
  const groupId = newId('action');
  const result = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: who.headers,
    payload: { clientId, commands: [{ id: newId('command'), groupId, ...input }] },
  });
  expect(result.statusCode, result.body).toBe(200);
  const row = result.json<CommandBatchResult>().results[0]!;
  if (error) expect(row.error?.messageKey, result.body).toBe(error);
  else expect(row.status, result.body).toBe('applied');
  return groupId;
}
async function get<T>(url: string, who = server.owner): Promise<T> {
  const result = await server.app.inject({ url, headers: who.headers });
  expect(result.statusCode, result.body).toBe(200);
  return result.json<T>();
}
async function setup() {
  const databaseId = newId('database');
  const tableId = newId('table');
  const name = newId('field');
  const lines = newId('field');
  const label = newId('field');
  const amount = newId('field');
  const checked = newId('field');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Invoices',
      table: {
        id: tableId,
        name: 'Invoices',
        fields: [{ id: name, name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  await command(databaseId, {
    kind: 'field.create',
    tableId,
    field: {
      id: lines,
      name: 'Rows',
      type: 'lineItems',
      options: {
        columns: [
          { id: label, name: 'Description', type: 'text' },
          { id: amount, name: 'Amount', type: 'currency' },
          { id: checked, name: 'Included', type: 'checkbox' },
        ],
      },
    },
  });
  const schema = await get<DatabaseSchema>(`/api/databases/${databaseId}/schema`);
  const field = schema.fields.find((field) => field.id === lines)!;
  if (field.type !== 'lineItems') throw new Error('Missing line field');
  const child = field.options.linkedTableId;
  const parent = newId('record');
  const first = newId('record');
  const second = newId('record');
  await command(databaseId, {
    kind: 'record.create',
    tableId,
    records: [
      {
        id: parent,
        values: {
          [name]: 'Invoice 1',
          [lines]: [
            { id: first, values: { [label]: 'Labor', [amount]: 12.5, [checked]: true } },
            { id: second, values: { [label]: 'Parts', [amount]: 7.5, [checked]: false } },
          ],
        },
      },
    ],
  });
  return {
    databaseId,
    tableId,
    name,
    lines,
    label,
    amount,
    checked,
    child,
    parent,
    first,
    second,
    field,
    schema,
    read: () => get<RowData>(`/api/tables/${tableId}/records/${parent}`),
  };
}

it('stores ordered real records in a hidden child table and calculates scoped totals and filtered rollups', async () => {
  const f = await setup();
  expect(f.schema.tables.find((table) => table.id === f.child)?.lineItems).toEqual({
    parentTableId: f.tableId,
    parentFieldId: f.lines,
  });
  expect((await f.read()).values[f.lines]).toEqual([f.first, f.second]);
  expect((await f.read()).lineItemTotals?.[f.lines]?.[f.amount]).toBe(20);
  expect((await get<RowData>(`/api/tables/${f.child}/records/${f.first}`)).values[f.label]).toBe('Labor');
  const sum = newId('field');
  const count = newId('field');
  await command(f.databaseId, {
    kind: 'field.create',
    tableId: f.tableId,
    field: {
      id: sum,
      name: 'Included total',
      type: 'rollup',
      options: {
        linkFieldId: f.lines,
        targetFieldId: f.amount,
        fn: 'sum',
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'included', fieldId: f.checked, operator: 'is', value: true }],
        },
      },
    },
  });
  await command(f.databaseId, {
    kind: 'field.create',
    tableId: f.tableId,
    field: { id: count, name: 'Line count', type: 'count', options: { linkFieldId: f.lines } },
  });
  const row = await f.read();
  expect(row.values[sum]).toBe(12.5);
  expect(row.values[count]).toBe(2);
  const other = newId('record');
  await command(f.databaseId, {
    kind: 'record.create',
    tableId: f.tableId,
    records: [{ id: other, values: {} }],
  });
  await command(
    f.databaseId,
    { kind: 'record.update', tableId: f.tableId, records: [{ id: other, values: { [f.lines]: [f.first] } }] },
    server.owner,
    'data.link.unknownRecord',
  );
});

it('undoes and redoes row edits, removals, additions, and order through the command history', async () => {
  const f = await setup();
  const added = newId('record');
  const groupId = await command(f.databaseId, {
    kind: 'record.update',
    tableId: f.tableId,
    records: [
      {
        id: f.parent,
        values: {
          [f.lines]: [
            { id: f.second, values: { [f.amount]: 15 } },
            { id: added, values: { [f.label]: 'Shipping', [f.amount]: 3 } },
          ],
        },
      },
    ],
  });
  expect((await f.read()).values[f.lines]).toEqual([f.second, added]);
  expect((await f.read()).lineItemTotals?.[f.lines]?.[f.amount]).toBe(18);
  for (const direction of ['undo', 'redo']) {
    const result = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${f.databaseId}/${direction}`,
      headers: server.owner.headers,
      payload: { commandId: newId('command'), clientId, groupId },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json(), result.body).toMatchObject({ status: 'applied', skipped: 0 });
    const row = await f.read();
    expect(row.values[f.lines]).toEqual(direction === 'undo' ? [f.first, f.second] : [f.second, added]);
    expect(row.lineItemTotals?.[f.lines]?.[f.amount]).toBe(direction === 'undo' ? 20 : 18);
  }
});

it('applies parent record rules, field restrictions, and field locks to direct child reads and writes', async () => {
  const f = await setup();
  const member: SignedIn = await server.addMember();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${f.databaseId}, 'user', ${member.userId}, 'editor')`,
  );
  async function put(url: string, payload: Record<string, unknown>) {
    const response = await server.app.inject({ method: 'PUT', url, headers: server.owner.headers, payload });
    expect(response.statusCode, response.body).toBe(200);
  }
  await put(`/api/tables/${f.tableId}/record-rules`, {
    rules: [
      {
        id: newId('recordRule'),
        roles: ['editor'],
        users: [],
        condition: {
          conjunction: 'and',
          conditions: [{ id: 'hidden', fieldId: f.name, operator: 'is', value: 'Invoice 2' }],
        },
      },
    ],
  });
  const hidden = await server.app.inject({
    url: `/api/tables/${f.child}/records/${f.first}`,
    headers: member.headers,
  });
  expect(hidden.statusCode, hidden.body).toBe(404);
  await command(
    f.databaseId,
    { kind: 'record.update', tableId: f.child, records: [{ id: f.first, values: { [f.amount]: 100 } }] },
    member,
    'data.access.recordHidden',
  );
  await put(`/api/tables/${f.tableId}/record-rules`, { rules: [] });
  await put(`/api/fields/${f.amount}/permissions`, {
    restricted: { roles: ['creator'], users: [] },
    locked: null,
  });
  const visibleSchema = await get<DatabaseSchema>(`/api/databases/${f.databaseId}/schema`, member);
  const visibleField = visibleSchema.fields.find((field) => field.id === f.lines)!;
  expect(visibleField.type).toBe('lineItems');
  if (visibleField.type === 'lineItems')
    expect(visibleField.options.columns.map((column) => column.id)).not.toContain(f.amount);
  const visibleParent = await get<RowData>(`/api/tables/${f.tableId}/records/${f.parent}`, member);
  expect(visibleParent.lineItemTotals?.[f.lines]?.[f.amount]).toBeUndefined();
  const visibleLine = await get<RowData>(`/api/tables/${f.child}/records/${f.first}`, member);
  expect(visibleLine.values[f.amount]).toBeUndefined();
  await put(`/api/fields/${f.amount}/permissions`, { restricted: null, locked: null });
  await put(`/api/fields/${f.lines}/permissions`, {
    restricted: null,
    locked: { roles: ['creator'], users: [] },
  });
  await command(
    f.databaseId,
    { kind: 'record.update', tableId: f.child, records: [{ id: f.first, values: { [f.amount]: 100 } }] },
    member,
    'data.access.fieldLocked',
  );
  await put(`/api/fields/${f.lines}/permissions`, {
    restricted: { roles: ['creator'], users: [] },
    locked: null,
  });
  const restricted = await server.app.inject({
    url: `/api/tables/${f.child}/records/${f.first}`,
    headers: member.headers,
  });
  expect(restricted.statusCode, restricted.body).toBe(404);
});

it('accepts nested REST writes and exposes lines as Airtable-compatible linked records', async () => {
  const f = await setup();
  const tokenResponse = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: server.owner.headers,
    payload: {
      name: 'Lines',
      databases: [f.databaseId],
      scopes: ['data.records:read', 'data.records:write', 'schema.bases:read'],
    },
  });
  expect(tokenResponse.statusCode, tokenResponse.body).toBe(200);
  const headers = { authorization: `Bearer ${tokenResponse.json<{ token: string }>().token}` };
  const write = await server.app.inject({
    method: 'PATCH',
    url: `/api/v1/tables/${f.tableId}/records`,
    headers,
    payload: {
      fieldKey: 'id',
      records: [{ id: f.parent, fields: { [f.lines]: [{ id: f.second, values: { [f.amount]: 25 } }] } }],
    },
  });
  expect(write.statusCode, write.body).toBe(200);
  expect((await f.read()).values[f.lines]).toEqual([f.second]);
  expect((await f.read()).lineItemTotals?.[f.lines]?.[f.amount]).toBe(25);
  const linked = await server.app.inject({ url: `/v0/${f.databaseId}/${f.tableId}/${f.parent}`, headers });
  expect(linked.statusCode, linked.body).toBe(200);
  expect(linked.json<{ fields: Record<string, unknown> }>().fields.Rows).toEqual([f.second]);
});

it('hides lines when their parent field or table is trashed and restores access through undo', async () => {
  const f = await setup();
  for (const input of [
    { kind: 'field.trash', fieldId: f.lines },
    { kind: 'table.trash', tableId: f.tableId },
  ]) {
    const groupId = await command(f.databaseId, input);
    const hidden = await server.app.inject({
      url: `/api/tables/${f.child}/records/${f.first}`,
      headers: server.owner.headers,
    });
    expect(hidden.statusCode, hidden.body).toBe(404);
    const restored = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${f.databaseId}/undo`,
      headers: server.owner.headers,
      payload: { commandId: newId('command'), clientId, groupId },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json()).toMatchObject({ status: 'applied', skipped: 0 });
    const line = await get<RowData>(`/api/tables/${f.child}/records/${f.first}`);
    expect(line.values[f.amount]).toBe(12.5);
  }
});

it('materializes required repeatable public form sections and exports typed child cells', async () => {
  const f = await setup();
  const viewId = newId('view');
  await command(f.databaseId, {
    kind: 'view.create',
    view: {
      id: viewId,
      tableId: f.tableId,
      name: 'Submit invoice',
      type: 'form',
      config: { form: { questions: [{ fieldId: f.lines, label: '', help: '', required: true }] } },
    },
  });
  const shared = await server.app.inject({
    method: 'PUT',
    url: `/api/views/${viewId}/public-form`,
    headers: server.owner.headers,
  });
  expect(shared.statusCode, shared.body).toBe(200);
  const formId = shared.json<{ formId: string }>().formId;
  const definition = await publicDefinition(server.ctx, formId);
  expect(definition.questions[0]?.options.columns).toHaveLength(3);
  const permissions = await server.app.inject({
    method: 'PUT',
    url: `/api/fields/${f.amount}/permissions`,
    headers: server.owner.headers,
    payload: { restricted: { roles: ['creator'], users: [] }, locked: null },
  });
  expect(permissions.statusCode, permissions.body).toBe(200);
  const restricted = await publicDefinition(server.ctx, formId);
  expect(restricted.questions[0]?.options.columns).toHaveLength(2);
  const restored = await server.app.inject({
    method: 'PUT',
    url: `/api/fields/${f.amount}/permissions`,
    headers: server.owner.headers,
    payload: { restricted: null, locked: null },
  });
  expect(restored.statusCode, restored.body).toBe(200);
  await submitAnswers(server.ctx, formId, {
    [f.lines]: [{ values: { [f.label]: 'Form row', [f.amount]: 9.25 } }],
  });
  const parents = await query<{ id: string }>(
    server.pool,
    sql`SELECT __id AS id FROM ${ident(server.schemas.data, f.tableId)} WHERE __id <> ${f.parent} AND __deleted_at IS NULL`,
  );
  expect(parents.rows).toHaveLength(1);
  const submitted = await get<RowData>(`/api/tables/${f.tableId}/records/${parents.rows[0]!.id}`);
  expect(submitted.lineItemTotals?.[f.lines]?.[f.amount]).toBe(9.25);
  const grid = f.schema.views.find((view) => view.tableId === f.tableId)!;
  const exported = await server.app.inject({
    url: `/api/views/${grid.id}/export?format=xlsx&locale=en-US&timeZone=UTC`,
    headers: server.owner.headers,
  });
  expect(exported.statusCode, exported.body).toBe(200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(exported.rawPayload as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  expect(workbook.worksheets).toHaveLength(2);
  const sheet = workbook.worksheets[1]!;
  expect(sheet.getRow(1).values).toEqual([undefined, 'Invoices', 'Description', 'Amount', 'Included']);
  expect(sheet.getCell('C2').value).toBe(12.5);
  expect(sheet.getCell('C2').numFmt).toContain('$');
});

it('archives ordered lines and restores one owned child table with remapped parent IDs', async () => {
  const f = await setup();
  await command(f.databaseId, {
    kind: 'record.update',
    tableId: f.tableId,
    records: [{ id: f.parent, values: { [f.lines]: [f.second, f.first] } }],
  });
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id))!;
  const archive = await withTransaction(server.pool, async (db) => {
    const scope = new AccessScope(db, server.schemas, actor);
    await scope.prepare(f.databaseId);
    await requireWholeRead(db, server.schemas, scope, f.databaseId, 'editSchema');
    return writeArchive(db, server.schemas, f.databaseId, { records: 'all', comments: true }, scope);
  });
  expect
    .soft(archive.tables.find((table) => table.id === f.tableId)?.records[0]?.values[f.lines])
    .toEqual([f.second, f.first]);
  expect.soft(archive.tables.find((table) => table.id === f.child)).toMatchObject({
    lineItems: { parentTableId: f.tableId, parentFieldId: f.lines },
    records: expect.arrayContaining([expect.objectContaining({ id: f.first, parentId: f.parent })]),
  });
  const databaseId = newId('database');
  const report = await restoreArchive(server.ctx, actor, {
    archive: DatabaseArchive.parse(JSON.parse(JSON.stringify(archive))),
    databaseId,
    name: 'Restored invoices',
  });
  expect(report.tables).toBe(2);
  const schema = await get<DatabaseSchema>(`/api/databases/${databaseId}/schema`);
  expect(schema.tables).toHaveLength(2);
  const lines = schema.fields.find((field) => field.type === 'lineItems')!;
  if (lines.type !== 'lineItems') throw new Error('Missing restored lines');
  const parentTable = schema.tables.find((table) => table.id === lines.tableId)!;
  const parentRows = await query<{ id: string }>(
    server.pool,
    sql`SELECT __id AS id FROM ${ident(server.schemas.data, parentTable.id)}`,
  );
  const parent = await get<RowData>(`/api/tables/${parentTable.id}/records/${parentRows.rows[0]!.id}`);
  const childRows = await query<{ id: string; parent: string }>(
    server.pool,
    sql`SELECT __id AS id, __parent_id AS parent FROM ${ident(server.schemas.data, lines.options.linkedTableId)}`,
  );
  expect(childRows.rows).toHaveLength(2);
  expect(childRows.rows.every((row) => row.parent === parent.id)).toBe(true);
  const ordered = await Promise.all(
    (parent.values[lines.id] as string[]).map((id) =>
      get<RowData>(`/api/tables/${lines.options.linkedTableId}/records/${id}`),
    ),
  );
  const label = lines.options.columns.find((column) => column.name === 'Description')!.id;
  const amount = lines.options.columns.find((column) => column.name === 'Amount')!.id;
  expect(ordered.map((row) => row.values[label])).toEqual(['Parts', 'Labor']);
  expect(parent.lineItemTotals?.[lines.id]?.[amount]).toBe(20);
  await command(databaseId, {
    kind: 'record.update',
    tableId: lines.options.linkedTableId,
    records: [{ id: ordered[0]!.id, values: { [amount]: 30 } }],
  });
});

it('trashes every child on an empty replacement and restores the collection through undo', async () => {
  const f = await setup();
  const groupId = await command(f.databaseId, {
    kind: 'record.update',
    tableId: f.tableId,
    records: [{ id: f.parent, values: { [f.lines]: [] } }],
  });
  expect((await f.read()).values[f.lines]).toEqual([]);
  const active = await query(
    server.pool,
    sql`SELECT __id FROM ${ident(server.schemas.data, f.child)} WHERE __deleted_at IS NULL`,
  );
  expect(active.rowCount).toBe(0);
  const undone = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${f.databaseId}/undo`,
    headers: server.owner.headers,
    payload: { commandId: newId('command'), clientId, groupId },
  });
  expect(undone.statusCode, undone.body).toBe(200);
  expect(undone.json()).toMatchObject({ status: 'applied', skipped: 0 });
  expect((await f.read()).values[f.lines]).toEqual([f.first, f.second]);
  expect((await f.read()).lineItemTotals?.[f.lines]?.[f.amount]).toBe(20);
});

async function editableLines() {
  const f = await setup();
  const viewId = newId('view');
  await command(f.databaseId, {
    kind: 'view.create',
    view: {
      id: viewId,
      tableId: f.tableId,
      name: 'Edit invoice',
      type: 'form',
      config: {
        form: { allowEdits: true, questions: [{ fieldId: f.lines, label: '', help: '', required: false }] },
      },
    },
  });
  const shared = await server.app.inject({
    method: 'PUT',
    url: `/api/views/${viewId}/public-form`,
    headers: server.owner.headers,
  });
  expect(shared.statusCode, shared.body).toBe(200);
  const formId = shared.json<{ formId: string }>().formId;
  const submitted = await submitAnswers(server.ctx, formId, {
    [f.lines]: [
      { values: { [f.label]: 'Submitted first', [f.amount]: 10 } },
      { values: { [f.label]: 'Submitted second', [f.amount]: 20 } },
    ],
  });
  const token = submitted.editLink!.path.split('#')[1]!;
  const claims = readFormEditToken(server.config.secretKey, token, { formId, purpose: 'link' });
  const row = await get<RowData>(`/api/tables/${f.tableId}/records/${claims.recordId}`);
  return { ...f, formId, viewId, token, recordId: claims.recordId, ids: row.values[f.lines] as string[] };
}

it('opens ordered repeatable answers under the edit record scope and omits restricted child values', async () => {
  const f = await editableLines();
  await command(f.databaseId, {
    kind: 'record.update',
    tableId: f.tableId,
    records: [{ id: f.recordId, values: { [f.lines]: [...f.ids].reverse() } }],
  });
  const permission = await server.app.inject({
    method: 'PUT',
    url: `/api/fields/${f.amount}/permissions`,
    headers: server.owner.headers,
    payload: { restricted: { roles: ['creator'], users: [] }, locked: null },
  });
  expect(permission.statusCode, permission.body).toBe(200);
  const edit = await openFormEdit(server.ctx, f.formId, f.token, '198.51.100.11');
  expect(edit.edit?.values[f.lines]).toEqual([
    { id: f.ids[1], values: { [f.label]: 'Submitted second', [f.checked]: false } },
    { id: f.ids[0], values: { [f.label]: 'Submitted first', [f.checked]: false } },
  ]);
  expect(JSON.stringify(edit.edit?.values)).not.toContain(f.amount);
  expect(JSON.stringify(edit)).not.toContain('Invoice 1');
});

it('undoes child cell changes in a public edit group while preserving later edits', async () => {
  const f = await editableLines();
  const edit = await openFormEdit(server.ctx, f.formId, f.token, '198.51.100.11');
  await saveFormEdit(
    server.ctx,
    f.formId,
    edit.edit!.session,
    { [f.lines]: f.ids.map((id) => ({ id, values: { [f.amount]: 42 } })) },
    '198.51.100.11',
  );
  const saved = await query<{ seq: number }>(
    server.pool,
    sql`SELECT MIN(seq)::integer AS seq FROM ${ident(server.schemas.app, 'changes')} WHERE database_id = ${f.databaseId} AND client_id = ${`form:${f.viewId}`} AND body ->> 'kind' = 'record.updated' AND body ->> 'tableId' = ${f.tableId}`,
  );
  await command(f.databaseId, {
    kind: 'record.update',
    tableId: f.child,
    records: [{ id: f.ids[1], values: { [f.amount]: 55 } }],
  });
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id))!;
  expect((await undoFormEdit(server.ctx, actor, f.viewId, saved.rows[0]!.seq)).restored).toBeGreaterThan(0);
  expect((await get<RowData>(`/api/tables/${f.child}/records/${f.ids[0]}`)).values[f.amount]).toBe(10);
  expect((await get<RowData>(`/api/tables/${f.child}/records/${f.ids[1]}`)).values[f.amount]).toBe(55);
});

it('undoes public edit additions and removals and allows clearing every repeatable answer', async () => {
  const f = await editableLines();
  const edit = await openFormEdit(server.ctx, f.formId, f.token, '198.51.100.11');
  const added = newId('record');
  await saveFormEdit(
    server.ctx,
    f.formId,
    edit.edit!.session,
    {
      [f.lines]: [
        { id: f.ids[0], values: { [f.amount]: 42 } },
        { id: added, values: { [f.label]: 'Added', [f.amount]: 99 } },
      ],
    },
    '198.51.100.11',
  );
  const saved = await query<{ seq: number }>(
    server.pool,
    sql`SELECT MIN(seq)::integer AS seq FROM ${ident(server.schemas.app, 'changes')} WHERE database_id = ${f.databaseId} AND client_id = ${`form:${f.viewId}`} AND body ->> 'kind' = 'record.updated' AND body ->> 'tableId' = ${f.tableId}`,
  );
  const actor = (await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id))!;
  expect((await undoFormEdit(server.ctx, actor, f.viewId, saved.rows[0]!.seq)).restored).toBeGreaterThan(0);
  const restored = await get<RowData>(`/api/tables/${f.tableId}/records/${f.recordId}`);
  expect(restored.values[f.lines]).toEqual(f.ids);
  expect(restored.lineItemTotals?.[f.lines]?.[f.amount]).toBe(30);
  expect((await undoFormEdit(server.ctx, actor, f.viewId, saved.rows[0]!.seq)).restored).toBe(0);
  await saveFormEdit(server.ctx, f.formId, edit.edit!.session, { [f.lines]: [] }, '198.51.100.11');
  const active = await query(
    server.pool,
    sql`SELECT __id FROM ${ident(server.schemas.data, f.child)} WHERE __parent_id = ${f.recordId} AND __deleted_at IS NULL`,
  );
  expect(active.rowCount).toBe(0);
  expect((await openFormEdit(server.ctx, f.formId, f.token, '198.51.100.11')).edit?.values[f.lines]).toEqual(
    [],
  );
});
