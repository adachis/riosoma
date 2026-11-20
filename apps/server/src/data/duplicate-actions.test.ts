import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import {
  LIMITS,
  newId,
  type CommandBatchResult,
  type DatabaseSchema,
  type RowsPage,
  type RowData,
  type TableCopyJob,
  type FieldSpec,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { permissionFixture } from './permissions/permissions.test-helpers.js';
import { readFixture } from './snapshots.test-helpers.js';
import { loadDatabaseRules, saveFieldRules, saveRecordRules } from './permissions/store.js';
import { TABLE_COPY_BACKGROUND_THRESHOLD } from './duplicate-jobs.js';
import { changesChannel } from './notify.js';
import { purgeTrash } from './purge.js';

let kit: TestPostgres;
let server: ServerFixture;
let listener: PoolClient;
const notices = new Map<string, number>();
const clientId = newId('client');
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'duplicate_actions');
  listener = await server.pool.connect();
  listener.on('notification', (event) => {
    if (event.payload) {
      const notice = JSON.parse(event.payload) as { databaseId: string; seq: number };
      notices.set(notice.databaseId, Math.max(notices.get(notice.databaseId) ?? 0, notice.seq));
    }
  });
  await query(listener, sql`LISTEN ${ident(changesChannel(server.schemas))}`);
}, 60_000);
afterAll(async () => {
  listener?.release();
  await server?.close();
  await kit?.stop();
});
async function send(
  databaseId: string,
  input: Record<string, unknown>,
  who: SignedIn = server.owner,
  expected?: string,
) {
  const command = { id: newId('command'), groupId: newId('action'), ...input };
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: who.headers,
    payload: { clientId, commands: [command] },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<CommandBatchResult>().results[0]!;
  expect(result, response.body).toMatchObject(
    expected ? { status: 'rejected', error: { messageKey: expected } } : { status: 'applied' },
  );
  return { command, result };
}
async function get<T>(url: string): Promise<T> {
  const response = await server.app.inject({ url, headers: server.owner.headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}
async function undo(databaseId: string, groupId: string, who = server.owner, direction = 'undo') {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/${direction}`,
    headers: who.headers,
    payload: { commandId: newId('command'), groupId, clientId, confirmedMajorCreation: true },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ status: 'applied', skipped: 0 });
}
async function fixture() {
  const databaseId = newId('database'),
    tableId = newId('table'),
    viewId = newId('view');
  const fields = {
    name: newId('field'),
    amount: newId('field'),
    rich: newId('field'),
    box: newId('field'),
    file: newId('field'),
    lines: newId('field'),
    label: newId('field'),
    price: newId('field'),
    formula: newId('field'),
    self: newId('field'),
  };
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Copies',
      table: {
        id: tableId,
        name: 'Items',
        fields: [
          { id: fields.name, name: 'Name', type: 'text' },
          {
            id: fields.amount,
            name: 'Amount',
            type: 'number',
            description: 'Amount description',
            options: { precision: 2, defaultValue: { kind: 'value', value: 5 } },
          },
          { id: fields.rich, name: 'Notes', type: 'longText', options: { richText: true } },
          { id: fields.box, name: 'Done', type: 'checkbox' },
          { id: fields.file, name: 'Files', type: 'attachment' },
        ],
        view: { id: viewId, name: 'Grid' },
        records: [],
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  await send(databaseId, {
    kind: 'field.create',
    tableId,
    field: { id: fields.formula, name: 'Double', type: 'formula', options: { expression: '{Amount} * 2' } },
  });
  await send(databaseId, {
    kind: 'field.create',
    tableId,
    field: {
      id: fields.lines,
      name: 'Lines',
      type: 'lineItems',
      options: {
        columns: [
          { id: fields.label, name: 'Description', type: 'text' },
          { id: fields.price, name: 'Price', type: 'number' },
        ],
      },
    },
  });
  await send(databaseId, {
    kind: 'field.create',
    tableId,
    field: { id: fields.self, name: 'Related', type: 'link', options: { linkedTableId: tableId } },
  });
  const file = newId('attachment');
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'files')} (id, org_id, table_id, field_id, name, size, type, sha256, storage, storage_key, attached_at)
    VALUES (${file}, ${server.owner.info.org.id}, ${tableId}, ${fields.file}, 'shared.txt', 3, 'text/plain', ${'a'.repeat(64)}, 'postgres', ${file}, now())`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'file_chunks')} (storage_key, position, bytes) VALUES (${file}, 0, ${Buffer.from('abc')})`,
  );
  const records = [newId('record'), newId('record')];
  const rich = '**Rich notes**\n\nA second paragraph.';
  await send(databaseId, {
    kind: 'record.create',
    tableId,
    records: records.map((id, index) => ({
      id,
      values: {
        [fields.name]: `Item ${index + 1}`,
        [fields.amount]: index + 8,
        [fields.box]: index === 0,
        [fields.rich]: rich,
        [fields.file]: [file],
        [fields.lines]: [{ values: { [fields.label]: 'Child', [fields.price]: 11 } }],
      },
    })),
  });
  await send(databaseId, {
    kind: 'record.update',
    tableId,
    records: [{ id: records[0], values: { [fields.self]: [records[1]] } }],
  });
  return { databaseId, tableId, viewId, fields, records, file };
}
const schema = (id: string) => get<DatabaseSchema>(`/api/databases/${id}/schema`);
const rows = async (viewId: string) =>
  (await get<RowsPage>(`/api/views/${viewId}/rows?refresh=1`)).rows.filter((row) => row !== null);

async function audited(databaseId: string, groupId: string) {
  const changes = await query<{ seq: string; kind: string }>(
    server.pool,
    sql`SELECT seq, kind FROM ${ident(server.schemas.app, 'changes')} WHERE database_id = ${databaseId} AND group_id = ${groupId} ORDER BY seq`,
  );
  const audit = await query(
    server.pool,
    sql`SELECT e.id FROM ${ident(server.schemas.audit, 'events')} e
    WHERE metadata->>'databaseId' = ${databaseId}
    AND action = ${`data.${changes.rows[0]!.kind.replace('record.', 'records.')}`}
    AND EXISTS (SELECT 1 FROM ${ident(server.schemas.app, 'changes')} c
      WHERE c.database_id = ${databaseId} AND c.group_id = ${groupId} AND c.at = e.at)`,
  );
  expect(changes.rowCount).toBeGreaterThan(0);
  expect(audit.rowCount).toBeGreaterThan(0);
  await expect
    .poll(() => notices.get(databaseId) ?? 0)
    .toBeGreaterThanOrEqual(Number(changes.rows.at(-1)!.seq));
}

describe('duplication through the command bus', () => {
  it('undoes copied field settings while preserving later view edits', async () => {
    const f = await fixture();
    await send(f.databaseId, {
      kind: 'view.update',
      viewId: f.viewId,
      config: {
        hiddenFieldIds: [f.fields.amount],
        colorScales: [{ fieldId: f.fields.amount, stops: [{ color: 'red' }, { color: 'green' }] }],
        dataBars: [{ fieldId: f.fields.amount, color: 'blue' }],
        iconSets: [{ fieldId: f.fields.amount, thresholds: [3, 9] }],
        colorRules: [
          {
            id: 'amount',
            target: 'cell',
            color: 'blue',
            condition: { id: 'amount-condition', fieldId: f.fields.amount, operator: 'gt', value: 3 },
          },
        ],
      },
    });
    const fieldId = newId('field');
    const { command } = await send(f.databaseId, {
      kind: 'field.duplicate',
      fieldId: f.fields.amount,
      newFieldId: fieldId,
      name: 'Amount copy',
    });
    const copied = (await schema(f.databaseId)).views.find((view) => view.id === f.viewId)!;
    const sorts = [{ fieldId: f.fields.name, direction: 'desc' }];
    const extraRule = {
      id: 'name',
      name: '',
      target: 'cell',
      color: 'green',
      condition: { id: 'name-condition', fieldId: f.fields.name, operator: 'contains', value: 'Item' },
    };
    await send(f.databaseId, {
      kind: 'view.update',
      viewId: f.viewId,
      config: {
        sorts,
        rowHeight: 'tall',
        hiddenFieldIds: [...copied.config.hiddenFieldIds, f.fields.rich],
        colorRules: [...copied.config.colorRules, extraRule],
        dataBars: copied.config.dataBars.map((item) =>
          item.fieldId === f.fields.amount ? { ...item, color: 'green' } : item,
        ),
        fieldOrder: [f.fields.rich, ...copied.config.fieldOrder.filter((id) => id !== f.fields.rich)],
      },
    });
    await undo(f.databaseId, command.groupId);
    const undone = (await schema(f.databaseId)).views.find((view) => view.id === f.viewId)!;
    expect(undone.config).toMatchObject({
      sorts,
      rowHeight: 'tall',
      hiddenFieldIds: [f.fields.amount, f.fields.rich],
    });
    expect(undone.config.colorRules.map((rule) => rule.id)).toEqual(['amount', 'name']);
    expect(undone.config.fieldOrder[0]).toBe(f.fields.rich);
    expect(undone.config.fieldOrder).not.toContain(fieldId);
    expect(undone.config.colorScales.map((item) => item.fieldId)).toEqual([f.fields.amount]);
    expect(undone.config.iconSets.map((item) => item.fieldId)).toEqual([f.fields.amount]);
    expect(undone.config.dataBars).toEqual([{ fieldId: f.fields.amount, color: 'green', showValue: true }]);
    await undo(f.databaseId, command.groupId, server.owner, 'redo');
    const redone = (await schema(f.databaseId)).views.find((view) => view.id === f.viewId)!;
    expect(redone.config.sorts).toEqual(sorts);
    expect(redone.config.colorRules).toContainEqual(extraRule);
    expect(redone.config.hiddenFieldIds).toContain(fieldId);
    await undo(f.databaseId, command.groupId);
  });

  it('duplicates a visible field without editing an unrelated protected filter', async () => {
    const f = await permissionFixture(server);
    const filter = {
      conjunction: 'and',
      conditions: [{ id: 'salary', fieldId: f.people.fields.salary, operator: 'gt', value: 1 }],
    };
    await send(f.databaseId, { kind: 'view.update', viewId: f.people.viewId, config: { filter } });
    const fieldId = newId('field');
    const { command } = await send(
      f.databaseId,
      {
        kind: 'field.duplicate',
        fieldId: f.people.fields.name,
        newFieldId: fieldId,
        name: 'Name copy',
        withValues: false,
      },
      f.persons.creator.signed,
    );
    expect(
      (await schema(f.databaseId)).views.find((view) => view.id === f.people.viewId)!.config.filter,
    ).toEqual(filter);
    await undo(f.databaseId, command.groupId, f.persons.creator.signed);
    expect(
      (await schema(f.databaseId)).views.find((view) => view.id === f.people.viewId)!.config.filter,
    ).toEqual(filter);
  });

  it('undoes an unchanged record copy with an inherited lock and keeps ordinary lock checks', async () => {
    const f = await readFixture(server, [{ type: 'text' }, { type: 'checkbox' }]);
    const recordId = newId('record');
    await send(f.table.databaseId, {
      kind: 'record.create',
      tableId: f.table.id,
      records: [{ id: recordId, values: { [f.fields[0]!.id]: 'Locked original', [f.fields[1]!.id]: true } }],
    });
    await send(f.table.databaseId, {
      kind: 'table.update',
      tableId: f.table.id,
      recordLock: {
        condition: {
          conjunction: 'and',
          conditions: [{ id: 'locked', fieldId: f.fields[1]!.id, operator: 'is', value: true }],
        },
        bypass: 'owners',
        reason: 'Approved',
      },
    });
    const editor = await server.addMember();
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${server.owner.info.org.id}, 'database', ${f.table.databaseId}, 'user', ${editor.userId}, 'editor')`,
    );
    const { command, result } = await send(
      f.table.databaseId,
      {
        kind: 'record.duplicate',
        tableId: f.table.id,
        viewId: f.view.id,
        recordIds: [recordId],
      },
      editor,
    );
    const copy = (result.output!.recordIds as string[])[0]!;
    await send(
      f.table.databaseId,
      { kind: 'record.trash', tableId: f.table.id, recordIds: [copy] },
      editor,
      'data.locks.recordLocked',
    );
    await undo(f.table.databaseId, command.groupId, editor);
    expect((await rows(f.view.id)).map((row) => row.id)).toEqual([recordId]);
    await undo(f.table.databaseId, command.groupId, editor, 'redo');
    await undo(f.table.databaseId, command.groupId, editor);
    const changed = await send(
      f.table.databaseId,
      {
        kind: 'record.duplicate',
        tableId: f.table.id,
        recordIds: [recordId],
      },
      editor,
    );
    const changedId = (changed.result.output!.recordIds as string[])[0]!;
    await send(f.table.databaseId, {
      kind: 'record.update',
      tableId: f.table.id,
      records: [{ id: changedId, values: { [f.fields[0]!.id]: 'Later edit' } }],
    });
    const skipped = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${f.table.databaseId}/undo`,
      headers: editor.headers,
      payload: { commandId: newId('command'), groupId: changed.command.groupId, clientId },
    });
    expect(skipped.json()).toMatchObject({ status: 'nothing', skipped: 1 });
    expect((await rows(f.view.id)).find((row) => row.id === changedId)!.values[f.fields[0]!.id]).toBe(
      'Later edit',
    );
    const protectedCopy = await send(
      f.table.databaseId,
      {
        kind: 'record.duplicate',
        tableId: f.table.id,
        recordIds: [recordId],
      },
      editor,
    );
    const protectedId = (protectedCopy.result.output!.recordIds as string[])[0]!;
    await send(f.table.databaseId, {
      kind: 'record.setLock',
      tableId: f.table.id,
      recordIds: [protectedId],
      locked: true,
      reason: 'Later manual lock',
    });
    const request = () =>
      server.app.inject({
        method: 'POST',
        url: `/api/databases/${f.table.databaseId}/undo`,
        headers: editor.headers,
        payload: { commandId: newId('command'), groupId: protectedCopy.command.groupId, clientId },
      });
    expect((await request()).json()).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.locks.recordLocked' },
    });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'grants')} SET role = 'reader'
      WHERE resource_id = ${f.table.databaseId} AND principal_id = ${editor.userId}`,
    );
    expect((await request()).json()).toMatchObject({ status: 'rejected', error: { code: 'forbidden' } });
    expect((await rows(f.view.id)).map((row) => row.id)).toContain(protectedId);
  });

  it('keeps copied parents and line items together when either receives a later edit', async () => {
    const f = await fixture();
    const lines = (await schema(f.databaseId)).fields.find((field) => field.id === f.fields.lines)!;
    if (lines.type !== 'lineItems') throw new Error('Missing lines');
    for (const editChild of [false, true]) {
      const { command, result } = await send(f.databaseId, {
        kind: 'record.duplicate',
        tableId: f.tableId,
        recordIds: [f.records[0]],
      });
      const copyId = (result.output!.recordIds as string[])[0]!;
      const childId = (
        (await rows(f.viewId)).find((row) => row.id === copyId)!.values[f.fields.lines] as string[]
      )[0]!;
      await undo(f.databaseId, command.groupId);
      await undo(f.databaseId, command.groupId, server.owner, 'redo');
      expect((await rows(f.viewId)).find((row) => row.id === copyId)!.values[f.fields.lines]).toContain(
        childId,
      );
      await send(f.databaseId, {
        kind: 'record.update',
        tableId: editChild ? lines.options.linkedTableId : f.tableId,
        records: [
          {
            id: editChild ? childId : copyId,
            values: { [editChild ? f.fields.label : f.fields.name]: 'Later edit' },
          },
        ],
      });
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/databases/${f.databaseId}/undo`,
        headers: server.owner.headers,
        payload: { commandId: newId('command'), groupId: command.groupId, clientId },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().skipped).toBeGreaterThan(0);
      const retained = (await rows(f.viewId)).find((row) => row.id === copyId);
      expect(retained).toBeDefined();
      expect(retained!.values[f.fields.lines]).toContain(childId);
      const child = await get<RowData>(`/api/tables/${lines.options.linkedTableId}/records/${childId}`);
      expect(child.values[f.fields.label]).toBe(editChild ? 'Later edit' : 'Child');
    }
  });

  it('keeps a later manual child lock when a copied parent also has a conditional lock', async () => {
    const f = await fixture();
    const editor = await server.addMember();
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${server.owner.info.org.id}, 'database', ${f.databaseId}, 'user', ${editor.userId}, 'editor')`,
    );
    const { command, result } = await send(
      f.databaseId,
      {
        kind: 'record.duplicate',
        tableId: f.tableId,
        recordIds: [f.records[0]],
      },
      editor,
    );
    const copyId = (result.output!.recordIds as string[])[0]!;
    const childId = (
      (await rows(f.viewId)).find((row) => row.id === copyId)!.values[f.fields.lines] as string[]
    )[0]!;
    const lines = (await schema(f.databaseId)).fields.find((field) => field.id === f.fields.lines)!;
    if (lines.type !== 'lineItems') throw new Error('Missing lines');
    await send(f.databaseId, {
      kind: 'table.update',
      tableId: f.tableId,
      recordLock: {
        condition: {
          conjunction: 'and',
          conditions: [{ id: 'locked', fieldId: f.fields.box, operator: 'is', value: true }],
        },
        bypass: 'owners',
        reason: 'Approved',
      },
    });
    await send(f.databaseId, {
      kind: 'record.setLock',
      tableId: lines.options.linkedTableId,
      recordIds: [childId],
      locked: true,
      reason: 'Child review',
    });
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${f.databaseId}/undo`,
      headers: editor.headers,
      payload: { commandId: newId('command'), groupId: command.groupId, clientId },
    });
    expect(response.json()).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.locks.recordLocked' },
    });
    expect((await rows(f.viewId)).find((row) => row.id === copyId)!.values[f.fields.lines]).toContain(
      childId,
    );
  });

  for (const withRecords of [false, true])
    it(`copies a self-link limited to another copied view with records=${withRecords}`, async () => {
      const f = await fixture();
      const limitedView = withRecords ? newId('view') : f.viewId;
      const filter = {
        conjunction: 'and',
        conditions: [{ id: 'choices', fieldId: f.fields.amount, operator: 'gt', value: 8 }],
      };
      if (withRecords)
        await send(f.databaseId, {
          kind: 'view.create',
          view: { id: limitedView, tableId: f.tableId, name: 'Choices', type: 'grid', config: { filter } },
        });
      else await send(f.databaseId, { kind: 'view.update', viewId: limitedView, config: { filter } });
      const original = (await schema(f.databaseId)).fields.find((field) => field.id === f.fields.self)!;
      await send(f.databaseId, {
        kind: 'field.update',
        fieldId: original.id,
        options: { ...original.options, limitToViewId: limitedView },
      });
      const tableId = newId('table');
      const { command } = await send(f.databaseId, {
        kind: 'table.duplicate',
        tableId: f.tableId,
        newTableId: tableId,
        name: 'Limited copy',
        withRecords,
      });
      const copied = await schema(f.databaseId);
      const link = copied.fields.find((field) => field.tableId === tableId && field.name === original.name)!;
      const view = copied.views.find(
        (view) => view.tableId === tableId && view.name === (withRecords ? 'Choices' : 'Grid'),
      )!;
      expect(link.options).toMatchObject({ linkedTableId: tableId, limitToViewId: view.id });
      if (withRecords) {
        const grid = copied.views.find((view) => view.tableId === tableId && view.name === 'Grid')!;
        const name = copied.fields.find((field) => field.tableId === tableId && field.name === 'Name')!.id;
        const record = (await rows(grid.id)).find((row) => row.values[name] === 'Item 1')!;
        await send(
          f.databaseId,
          {
            kind: 'record.update',
            tableId,
            records: [{ id: record.id, values: { [link.id]: [record.id] } }],
          },
          server.owner,
          'data.link.outsideLimit',
        );
      }
      await audited(f.databaseId, command.groupId);
      await undo(f.databaseId, command.groupId);
    });

  it('copies effective manual order in every view when row numbers have gaps', async () => {
    const f = await readFixture(server, [{ type: 'text' }]);
    const recordIds = Array.from({ length: 4 }, () => newId('record'));
    await send(f.table.databaseId, {
      kind: 'record.create',
      tableId: f.table.id,
      records: recordIds.map((id, index) => ({ id, values: { [f.fields[0]!.id]: String(index) } })),
    });
    const second = newId('view');
    await send(f.table.databaseId, {
      kind: 'view.create',
      view: { id: second, tableId: f.table.id, name: 'Second', type: 'grid', config: {} },
    });
    await send(f.table.databaseId, { kind: 'record.trash', tableId: f.table.id, recordIds: [recordIds[0]] });
    for (const viewId of [f.view.id, second])
      await send(f.table.databaseId, {
        kind: 'record.move',
        tableId: f.table.id,
        viewId,
        recordIds: [recordIds[3]],
        place: viewId === second ? { before: recordIds[1] } : { after: recordIds[1] },
      });
    const tableId = newId('table');
    const { command } = await send(f.table.databaseId, {
      kind: 'table.duplicate',
      tableId: f.table.id,
      newTableId: tableId,
      name: 'Ordered copy',
      withRecords: true,
    });
    const copied = await schema(f.table.databaseId);
    const name = copied.fields.find((field) => field.tableId === tableId)!.id;
    for (const sourceView of copied.views.filter((view) => view.tableId === f.table.id)) {
      const target = copied.views.find((view) => view.tableId === tableId && view.name === sourceView.name)!;
      expect((await rows(target.id)).map((row) => row.values[name])).toEqual(
        (await rows(sourceView.id)).map((row) => row.values[f.fields[0]!.id]),
      );
    }
    await undo(f.table.databaseId, command.groupId);
  });

  it('copies every editable scalar type without changing text, structured values, or signature metadata', async () => {
    const choice = { id: newId('choice'), name: 'Ready', color: 'green' };
    const samples: Array<{ spec: FieldSpec | { type: string; options?: unknown }; value: unknown }> = [
      { spec: { type: 'text' }, value: 'An original name' },
      { spec: { type: 'longText' }, value: 'First\nSecond' },
      { spec: { type: 'number' }, value: 12.5 },
      { spec: { type: 'currency' }, value: 123.45 },
      { spec: { type: 'percent' }, value: 0.25 },
      { spec: { type: 'duration' }, value: 3723.5 },
      { spec: { type: 'rating' }, value: 4 },
      { spec: { type: 'user' }, value: [server.owner.userId] },
      { spec: { type: 'checkbox' }, value: true },
      { spec: { type: 'date' }, value: '2026-10-02' },
      { spec: { type: 'date', options: { includeTime: true } }, value: '2026-10-02T18:30:00.000Z' },
      { spec: { type: 'singleSelect', options: { choices: [choice] } }, value: choice.id },
      { spec: { type: 'multipleSelect', options: { choices: [choice] } }, value: [choice.id] },
      { spec: { type: 'email' }, value: 'person@example.test' },
      { spec: { type: 'url' }, value: 'https://example.test/records' },
      { spec: { type: 'phone' }, value: '+1 555 0101' },
      { spec: { type: 'barcode' }, value: '00123456789' },
      { spec: { type: 'time' }, value: '23:12:13' },
      { spec: { type: 'multiCurrency' }, value: { amount: 123.45, code: 'EUR' } },
      { spec: { type: 'dateRange' }, value: { start: '2026-10-02', end: '2026-10-03' } },
      { spec: { type: 'json' }, value: '{"z":1.50,"a":[true,null],"z":2}' },
      { spec: { type: 'location' }, value: { lat: 40.7128, lng: -74.006, label: 'New York' } },
      {
        spec: { type: 'signature' },
        value: { name: 'Original signer', drawing: { path: 'M10 20l3 2', width: 100, height: 50 } },
      },
    ];
    const read = await readFixture(
      server,
      samples.map((sample) => sample.spec) as Parameters<typeof readFixture>[1],
    );
    const record = newId('record');
    await send(read.table.databaseId, {
      kind: 'record.create',
      tableId: read.table.id,
      records: [
        {
          id: record,
          values: Object.fromEntries(read.fields.map((field, index) => [field.id, samples[index]!.value])),
        },
      ],
    });
    const before = (await rows(read.view.id))[0]!;
    const { command, result } = await send(read.table.databaseId, {
      kind: 'record.duplicate',
      tableId: read.table.id,
      recordIds: [record],
      viewId: read.view.id,
    });
    expect(
      (await rows(read.view.id)).find((row) => row.id === (result.output!.recordIds as string[])[0])!.values,
    ).toEqual(before.values);
    await undo(read.table.databaseId, command.groupId);
    const copy = newId('table');
    const tableAction = await send(read.table.databaseId, {
      kind: 'table.duplicate',
      tableId: read.table.id,
      newTableId: copy,
      name: 'Scalar copy',
      withRecords: true,
    });
    const meta = await schema(read.table.databaseId);
    const copied = (await rows(meta.views.find((view) => view.tableId === copy)!.id))[0]!;
    for (const original of read.fields)
      expect(
        copied.values[
          meta.fields.find((field) => field.tableId === copy && field.name === original.name)!.id
        ],
      ).toEqual(before.values[original.id]);
    await undo(read.table.databaseId, tableAction.command.groupId);
  });

  it('preserves field permissions and placement in locked and hidden views, then restores the exact configs', async () => {
    const f = await fixture();
    const hidden = newId('view');
    await send(f.databaseId, {
      kind: 'view.create',
      view: {
        id: hidden,
        tableId: f.tableId,
        name: 'Hidden',
        type: 'grid',
        config: { hiddenFieldIds: [f.fields.amount] },
      },
    });
    await send(f.databaseId, { kind: 'view.update', viewId: f.viewId, config: { locked: true } });
    const permissions = {
      restricted: { roles: ['creator'] as const, users: [] },
      locked: { roles: ['creator'] as const, users: [] },
    };
    await saveFieldRules(
      server.pool,
      server.schemas,
      {
        orgId: server.owner.info.org.id,
        databaseId: f.databaseId,
        tableId: f.tableId,
        fieldId: f.fields.amount,
      },
      {
        restricted: { ...permissions.restricted, roles: [...permissions.restricted.roles] },
        locked: { ...permissions.locked, roles: [...permissions.locked.roles] },
      },
      server.owner.userId,
    );
    const before = await schema(f.databaseId);
    const fieldId = newId('field');
    const { command } = await send(f.databaseId, {
      kind: 'field.duplicate',
      fieldId: f.fields.amount,
      newFieldId: fieldId,
      name: 'Locked copy',
    });
    const copiedRules = await query(
      server.pool,
      sql`SELECT restricted, locked FROM ${ident(server.schemas.app, 'field_permissions')} WHERE field_id = ${fieldId}`,
    );
    expect(copiedRules.rows[0]).toEqual(permissions);
    expect(
      (await schema(f.databaseId)).views.find((view) => view.id === hidden)!.config.hiddenFieldIds,
    ).toContain(fieldId);
    await undo(f.databaseId, command.groupId);
    expect((await schema(f.databaseId)).views.map((view) => view.config)).toEqual(
      before.views.map((view) => view.config),
    );
  });

  for (const type of ['formula', 'lookup', 'rollup', 'link', 'oneWay', 'attachment', 'lineItems'] as const)
    it(`duplicates ${type} field definitions and values in one undo group`, async () => {
      const f = await fixture();
      let sourceId =
        type === 'formula'
          ? f.fields.formula
          : type === 'link'
            ? f.fields.self
            : type === 'attachment'
              ? f.fields.file
              : f.fields.lines;
      if (type === 'lookup' || type === 'rollup' || type === 'oneWay') {
        sourceId = newId('field');
        await send(f.databaseId, {
          kind: 'field.create',
          tableId: f.tableId,
          field: {
            id: sourceId,
            name: type,
            type: type === 'oneWay' ? 'link' : type,
            options:
              type === 'oneWay'
                ? { linkedTableId: f.tableId, oneWay: true }
                : {
                    linkFieldId: f.fields.self,
                    targetFieldId: f.fields.amount,
                    ...(type === 'rollup' ? { fn: 'sum' } : {}),
                  },
          },
        });
        if (type === 'oneWay')
          await send(f.databaseId, {
            kind: 'record.update',
            tableId: f.tableId,
            records: [{ id: f.records[0], values: { [sourceId]: [f.records[1]] } }],
          });
      }
      const before = await schema(f.databaseId);
      const values = await rows(f.viewId);
      const id = newId('field');
      const { command } = await send(f.databaseId, {
        kind: 'field.duplicate',
        fieldId: sourceId,
        newFieldId: id,
        name: 'Definition copy',
        withValues: true,
      });
      const copied = (await schema(f.databaseId)).fields.find((field) => field.id === id)!;
      const original = before.fields.find((field) => field.id === sourceId)!;
      expect(copied.type).toBe(original.type);
      if (copied.type === 'link' && original.type === 'link') {
        expect(copied.options.linkedTableId).toBe(original.options.linkedTableId);
        expect(copied.options.oneWay).toBe(original.options.oneWay);
        expect(copied.options.inverseFieldId).not.toBe(original.options.inverseFieldId ?? undefined);
      } else if (!['attachment', 'lineItems'].includes(type))
        expect(copied.options).toEqual(original.options);
      const after = await rows(f.viewId);
      if (!['attachment', 'lineItems'].includes(type))
        for (const row of after)
          expect(row.values[id]).toEqual(values.find((item) => item.id === row.id)!.values[sourceId]);
      if (type === 'lineItems') expect(after[0]!.values[id]).not.toEqual(values[0]!.values[sourceId]);
      if (type === 'attachment') {
        expect(after[0]!.values[id]).not.toEqual(values[0]!.values[sourceId]);
        expect(
          (
            await query(
              server.pool,
              sql`SELECT storage_key FROM ${ident(server.schemas.app, 'files')} WHERE field_id = ${id}`,
            )
          ).rows,
        ).toEqual([{ storage_key: f.file }]);
      }
      await audited(f.databaseId, command.groupId);
      await undo(f.databaseId, command.groupId);
      expect((await schema(f.databaseId)).tables.map((table) => table.id)).toEqual(
        before.tables.map((table) => table.id),
      );
      expect((await schema(f.databaseId)).fields.map((field) => field.id)).toEqual(
        before.fields.map((field) => field.id),
      );
      expect((await rows(f.viewId)).map((row) => row.values)).toEqual(values.map((row) => row.values));
      await undo(f.databaseId, command.groupId, server.owner, 'redo');
      expect((await rows(f.viewId)).map((row) => row.values)).toEqual(after.map((row) => row.values));
      await undo(f.databaseId, command.groupId);
    });

  it('copies line-item links to parent records in later batches', async () => {
    const read = await readFixture(server, [{ type: 'text' }]);
    const databaseId = read.table.databaseId;
    const lineId = newId('field');
    const labelId = newId('field');
    const linkId = newId('field');
    await send(databaseId, {
      kind: 'field.create',
      tableId: read.table.id,
      field: {
        id: lineId,
        name: 'Related lines',
        type: 'lineItems',
        options: {
          columns: [
            { id: labelId, name: 'Label', type: 'text' },
            {
              id: linkId,
              name: 'Target',
              type: 'link',
              options: { linkedTableId: read.table.id, oneWay: true },
            },
          ],
        },
      },
    });
    const recordIds = Array.from({ length: LIMITS.recordsPerCommand + 1 }, () => newId('record'));
    for (let offset = 0; offset < recordIds.length; offset += 500)
      await send(databaseId, {
        kind: 'record.create',
        tableId: read.table.id,
        records: recordIds
          .slice(offset, offset + 500)
          .map((id, index) => ({ id, values: { [read.fields[0]!.id]: `Row ${offset + index}` } })),
      });
    await send(databaseId, {
      kind: 'record.update',
      tableId: read.table.id,
      records: [
        {
          id: recordIds[0],
          values: {
            [lineId]: [{ values: { [labelId]: 'Later row', [linkId]: [recordIds.at(-1)] } }],
          },
        },
      ],
    });
    const original = await get<RowData>(`/api/tables/${read.table.id}/records/${recordIds[0]}`);
    const tableId = newId('table');
    const { command, result } = await send(databaseId, {
      kind: 'table.duplicate',
      tableId: read.table.id,
      newTableId: tableId,
      name: 'Batch links copy',
      withRecords: true,
    });
    const jobId = result.output!.jobId as string;
    await expect
      .poll(async () => (await get<TableCopyJob>(`/api/duplicate-jobs/${jobId}`)).state, {
        timeout: 30_000,
      })
      .not.toBe('running');
    expect(await get<TableCopyJob>(`/api/duplicate-jobs/${jobId}`)).toMatchObject({ state: 'finished' });
    const meta = await schema(databaseId);
    const lines = meta.fields.find((field) => field.tableId === tableId && field.type === 'lineItems')!;
    if (lines.type !== 'lineItems') throw new Error('Missing copied lines');
    const copied = await query<{ id: string }>(
      server.pool,
      sql`SELECT __id AS id FROM ${ident(server.schemas.data, tableId)} ORDER BY __rid`,
    );
    const first = await get<RowData>(`/api/tables/${tableId}/records/${copied.rows[0]!.id}`);
    const childId = (first.values[lines.id] as string[])[0]!;
    expect(original.values[lineId]).not.toContain(childId);
    const child = await get<RowData>(`/api/tables/${lines.options.linkedTableId}/records/${childId}`);
    const link = lines.options.columns.find((column) => column.name === 'Target')!;
    expect(child.values[link.id]).toEqual([copied.rows.at(-1)!.id]);
    await audited(databaseId, command.groupId);
    await undo(databaseId, command.groupId);
    expect((await schema(databaseId)).tables.some((table) => table.id === tableId)).toBe(false);
    expect((await get<RowData>(`/api/tables/${read.table.id}/records/${recordIds[0]}`)).values).toEqual(
      original.values,
    );
  });

  it('copies large tables in the background with progress, and cancels without leaving any copied state', async () => {
    const read = await readFixture(server, [{ type: 'text' }]);
    const databaseId = read.table.databaseId;
    const recordIds = Array.from({ length: TABLE_COPY_BACKGROUND_THRESHOLD + 1 }, () => newId('record'));
    for (let offset = 0; offset < recordIds.length; offset += 500)
      await send(databaseId, {
        kind: 'record.create',
        tableId: read.table.id,
        records: recordIds
          .slice(offset, offset + 500)
          .map((id, index) => ({ id, values: { [read.fields[0]!.id]: `Row ${offset + index}` } })),
      });
    const tableId = newId('table');
    const { command, result } = await send(databaseId, {
      kind: 'table.duplicate',
      tableId: read.table.id,
      newTableId: tableId,
      name: 'Background copy',
      withRecords: true,
    });
    const job = result.output!.jobId as string;
    await expect
      .poll(async () => (await get<{ state: string }>(`/api/duplicate-jobs/${job}`)).state, {
        timeout: 30_000,
      })
      .toBe('finished');
    expect(await get(`/api/duplicate-jobs/${job}`)).toMatchObject({
      copied: recordIds.length,
      total: recordIds.length,
    });
    await audited(databaseId, command.groupId);
    await undo(databaseId, command.groupId);
    const connection = await server.pool.connect();
    try {
      await query(connection, sql`BEGIN`);
      await query(
        connection,
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${server.schemas.app}:database:${databaseId}`}, 0))`,
      );
      const canceledId = newId('table');
      const queued = await send(databaseId, {
        kind: 'table.duplicate',
        tableId: read.table.id,
        newTableId: canceledId,
        name: 'Canceled copy',
        withRecords: true,
      });
      const canceledJob = queued.result.output!.jobId as string;
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/duplicate-jobs/${canceledJob}/cancel`,
        headers: server.owner.headers,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ state: 'canceled' });
      await query(connection, sql`COMMIT`);
      await expect
        .poll(async () => (await get<{ result: unknown }>(`/api/duplicate-jobs/${canceledJob}`)).result, {
          timeout: 30_000,
        })
        .toMatchObject({ status: 'rejected', error: { messageKey: 'duplicate.table.canceled' } });
      expect(
        (
          await query(
            server.pool,
            sql`SELECT id FROM ${ident(server.schemas.app, 'tables')} WHERE id = ${canceledId}`,
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await query(
            server.pool,
            sql`SELECT seq FROM ${ident(server.schemas.app, 'changes')} WHERE group_id = ${queued.command.groupId}`,
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await query(connection, sql`ROLLBACK`);
      connection.release();
    }
  });
  it('copies records, shared attachments, rich text, paired links, and new line rows after each original in one undo group', async () => {
    const f = await fixture();
    const before = await rows(f.viewId);
    const listener = await server.pool.connect();
    const notices: string[] = [];
    listener.on('notification', (event) => {
      if (event.payload?.includes(f.databaseId)) notices.push(event.payload);
    });
    try {
      await query(listener, sql`LISTEN ${ident(changesChannel(server.schemas))}`);
      const { command, result } = await send(f.databaseId, {
        kind: 'record.duplicate',
        tableId: f.tableId,
        viewId: f.viewId,
        recordIds: f.records,
      });
      const copies = result.output!.recordIds as string[];
      const after = await rows(f.viewId);
      expect(after.map((row) => row.id)).toEqual([f.records[0], copies[0], f.records[1], copies[1]]);
      for (const [index, id] of copies.entries()) {
        const row = after.find((row) => row.id === id)!;
        for (const key of ['name', 'amount', 'rich', 'box', 'file', 'formula'] as const)
          expect(row.values[f.fields[key]]).toEqual(before[index]!.values[f.fields[key]]);
        expect(row.values[f.fields.lines]).not.toEqual(before[index]!.values[f.fields.lines]);
      }
      expect(after.find((row) => row.id === copies[0])!.values[f.fields.self]).toEqual([f.records[1]]);
      const meta = await schema(f.databaseId);
      const inverse = meta.fields.find((field) => field.id === f.fields.self)!;
      if (inverse.type !== 'link') throw new Error('Missing link');
      expect(after.find((row) => row.id === f.records[1])!.values[inverse.options.inverseFieldId!]).toContain(
        copies[0],
      );
      const chunks = await query(
        server.pool,
        sql`SELECT storage_key FROM ${ident(server.schemas.app, 'file_chunks')}`,
      );
      expect(chunks.rows.filter((row) => row.storage_key === f.file)).toHaveLength(1);
      await audited(f.databaseId, command.groupId);
      await expect.poll(() => notices.length).toBeGreaterThan(0);
      await undo(f.databaseId, command.groupId);
      expect((await rows(f.viewId)).map((row) => ({ id: row.id, values: row.values }))).toEqual(
        before.map((row) => ({ id: row.id, values: row.values })),
      );
    } finally {
      await query(listener, sql`UNLISTEN *`);
      listener.release();
    }
  });

  it('uses view sorting and remains idempotent on retry', async () => {
    const f = await fixture();
    await send(f.databaseId, {
      kind: 'view.update',
      viewId: f.viewId,
      config: { sorts: [{ fieldId: f.fields.amount, direction: 'desc' }] },
    });
    const { command, result } = await send(f.databaseId, {
      kind: 'record.duplicate',
      tableId: f.tableId,
      viewId: f.viewId,
      recordIds: [f.records[0]],
    });
    const retry = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${f.databaseId}/commands`,
      headers: server.owner.headers,
      payload: { clientId, commands: [command] },
    });
    expect(retry.json<CommandBatchResult>().results[0]).toMatchObject({
      status: 'duplicate',
      output: result.output,
    });
    expect((await rows(f.viewId)).map((row) => row.values[f.fields.amount])).toEqual([9, 8, 8]);
    await undo(f.databaseId, command.groupId);
    expect(await rows(f.viewId)).toHaveLength(2);
  });

  for (const withValues of [false, true])
    it(`copies field options, descriptions, defaults, formatting, and permissions with values=${withValues}`, async () => {
      const f = await fixture();
      await send(f.databaseId, {
        kind: 'view.update',
        viewId: f.viewId,
        config: {
          colorRules: [
            {
              id: 'large',
              target: 'cell',
              condition: { id: 'condition', fieldId: f.fields.amount, operator: 'gt', value: 3 },
              color: 'blue',
            },
          ],
        },
      });
      const before = await schema(f.databaseId);
      const id = newId('field');
      const { command } = await send(f.databaseId, {
        kind: 'field.duplicate',
        fieldId: f.fields.amount,
        newFieldId: id,
        name: 'Amount copy',
        withValues,
      });
      const after = await schema(f.databaseId);
      const original = before.fields.find((field) => field.id === f.fields.amount)!;
      expect(after.fields.find((field) => field.id === id)).toMatchObject({
        type: original.type,
        options: original.options,
        description: original.description,
      });
      const view = after.views.find((view) => view.id === f.viewId)!;
      expect(view.config.fieldOrder.indexOf(id)).toBe(view.config.fieldOrder.indexOf(f.fields.amount) + 1);
      expect(view.config.colorRules.some((rule) => rule.condition.fieldId === id)).toBe(true);
      expect((await rows(f.viewId)).map((row) => row.values[id])).toEqual(withValues ? [8, 9] : [null, null]);
      await audited(f.databaseId, command.groupId);
      await undo(f.databaseId, command.groupId);
      const undone = await schema(f.databaseId);
      expect(undone.fields.map((field) => field.id)).toEqual(before.fields.map((field) => field.id));
      expect(undone.views[0]!.config).toEqual(before.views[0]!.config);
    });

  for (const withRecords of [false, true])
    it(`copies tables with internal pairs, forms, and records=${withRecords}, then matches manual trash and restoration`, async () => {
      const f = await fixture();
      await send(f.databaseId, {
        kind: 'view.create',
        view: {
          id: newId('view'),
          tableId: f.tableId,
          name: 'Form',
          type: 'form',
          config: { form: { questions: [{ fieldId: f.fields.name, required: true }] } },
        },
      });
      const before = await schema(f.databaseId);
      const id = newId('table');
      const { command } = await send(f.databaseId, {
        kind: 'table.duplicate',
        tableId: f.tableId,
        newTableId: id,
        name: 'Items copy',
        withRecords,
      });
      const after = await schema(f.databaseId);
      const fields = after.fields.filter((field) => field.tableId === id);
      expect(fields.map((field) => field.name).sort()).toEqual(
        before.fields
          .filter((field) => field.tableId === f.tableId)
          .map((field) => field.name)
          .sort(),
      );
      expect(after.views.filter((view) => view.tableId === id).map((view) => view.type)).toEqual([
        'grid',
        'form',
      ]);
      const copied = await rows(after.views.find((view) => view.tableId === id && view.type === 'grid')!.id);
      expect(copied).toHaveLength(withRecords ? 2 : 0);
      const link = fields.find((field) => field.name === 'Related')!;
      if (link.type !== 'link') throw new Error('Missing link');
      expect(link.options.linkedTableId).toBe(id);
      expect(fields.some((field) => field.id === link.options.inverseFieldId)).toBe(true);
      if (withRecords) {
        const name = fields.find((field) => field.name === 'Name')!.id;
        const a = copied.find((row) => row.values[name] === 'Item 1')!,
          b = copied.find((row) => row.values[name] === 'Item 2')!;
        expect(a.values[link.id]).toEqual([b.id]);
        const file = fields.find((field) => field.name === 'Files')!;
        const metadata = await query<{ storage_key: string }>(
          server.pool,
          sql`SELECT storage_key FROM ${ident(server.schemas.app, 'files')} WHERE field_id = ${file.id}`,
        );
        expect(metadata.rows.every((row) => row.storage_key === f.file)).toBe(true);
      }
      await audited(f.databaseId, command.groupId);
      await send(f.databaseId, { kind: 'table.trash', tableId: id });
      const manualTrash = await schema(f.databaseId);
      await send(f.databaseId, { kind: 'table.restore', tableId: id });
      await undo(f.databaseId, command.groupId);
      const undone = await schema(f.databaseId);
      expect(undone.tables.map((table) => table.id)).toEqual(manualTrash.tables.map((table) => table.id));
      expect(undone.fields).toEqual(manualTrash.fields);
      await undo(f.databaseId, command.groupId, server.owner, 'redo');
      const restored = await schema(f.databaseId);
      expect(restored.tables.map((table) => table.id)).toEqual(after.tables.map((table) => table.id));
      expect(restored.fields).toEqual(after.fields);
      expect(await rows(after.views.find((view) => view.tableId === id && view.type === 'grid')!.id)).toEqual(
        copied,
      );
    });

  it('copies links to another database, including inverse permissions, and restores both databases on undo and redo', async () => {
    const f = await fixture();
    const external = await readFixture(server, [{ type: 'text' }]);
    const destination = newId('record');
    await send(external.table.databaseId, {
      kind: 'record.create',
      tableId: external.table.id,
      records: [{ id: destination, values: { [external.fields[0]!.id]: 'Destination' } }],
    });
    const linkId = newId('field');
    await send(f.databaseId, {
      kind: 'field.create',
      tableId: f.tableId,
      field: { id: linkId, name: 'External', type: 'link', options: { linkedTableId: external.table.id } },
    });
    await send(f.databaseId, {
      kind: 'record.update',
      tableId: f.tableId,
      records: [{ id: f.records[0], values: { [linkId]: [destination] } }],
    });
    const original = (await schema(f.databaseId)).fields.find((field) => field.id === linkId)!;
    if (original.type !== 'link') throw new Error('Missing external link');
    const locked = { roles: ['creator'] as const, users: [] };
    await saveFieldRules(
      server.pool,
      server.schemas,
      {
        orgId: server.owner.info.org.id,
        databaseId: external.table.databaseId,
        tableId: external.table.id,
        fieldId: original.options.inverseFieldId!,
      },
      { restricted: null, locked: { ...locked, roles: [...locked.roles] } },
      server.owner.userId,
    );
    const before = await schema(external.table.databaseId);
    for (const kind of ['field.duplicate', 'table.duplicate'] as const) {
      const copyId = newId(kind === 'field.duplicate' ? 'field' : 'table');
      const { command } = await send(
        f.databaseId,
        kind === 'field.duplicate'
          ? { kind, fieldId: linkId, newFieldId: copyId, name: 'External copy', withValues: true }
          : { kind, tableId: f.tableId, newTableId: copyId, name: 'External table copy', withRecords: true },
      );
      const source = (await schema(f.databaseId)).fields.find((field) =>
        kind === 'field.duplicate'
          ? field.id === copyId
          : field.tableId === copyId && field.name === 'External',
      )!;
      if (source.type !== 'link') throw new Error('Missing copied external link');
      expect(source.options.linkedTableId).toBe(external.table.id);
      expect(
        (await loadDatabaseRules(server.pool, server.schemas, external.table.databaseId)).fields.find(
          (rule) => rule.fieldId === source.options.inverseFieldId,
        )?.locked,
      ).toEqual(locked);
      const expectedFields =
        kind === 'table.duplicate'
          ? (await schema(external.table.databaseId)).fields.map((field) => field.id)
          : before.fields.map((field) => field.id);
      await undo(f.databaseId, command.groupId);
      expect((await schema(external.table.databaseId)).fields.map((field) => field.id)).toEqual(
        expectedFields,
      );
      await undo(f.databaseId, command.groupId, server.owner, 'redo');
      expect((await schema(external.table.databaseId)).fields.map((field) => field.id)).toContain(
        source.options.inverseFieldId,
      );
      await undo(f.databaseId, command.groupId);
      expect((await schema(external.table.databaseId)).fields.map((field) => field.id)).toEqual(
        expectedFields,
      );
    }
  });

  it('copies table rules, locks, and settings with references to the copied fields', async () => {
    const f = await fixture();
    await send(f.databaseId, {
      kind: 'table.update',
      tableId: f.tableId,
      historyRetentionDays: 30,
      allowComputedOverrides: true,
      recordLock: {
        condition: {
          conjunction: 'and',
          conditions: [{ id: 'approved', fieldId: f.fields.box, operator: 'is', value: true }],
        },
        bypass: 'owners',
        reason: 'Approved',
      },
    });
    await saveRecordRules(
      server.pool,
      server.schemas,
      {
        orgId: server.owner.info.org.id,
        databaseId: f.databaseId,
        tableId: f.tableId,
      },
      [
        {
          id: newId('recordRule'),
          roles: ['editor'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'positive', fieldId: f.fields.amount, operator: 'gt', value: 1 }],
          },
        },
      ],
      server.owner.userId,
    );
    const tableId = newId('table');
    const { command } = await send(f.databaseId, {
      kind: 'table.duplicate',
      tableId: f.tableId,
      newTableId: tableId,
      name: 'Permission copy',
      withRecords: true,
    });
    const after = await schema(f.databaseId);
    const box = after.fields.find((field) => field.tableId === tableId && field.name === 'Done')!;
    const amount = after.fields.find((field) => field.tableId === tableId && field.name === 'Amount')!;
    expect(after.tables.find((table) => table.id === tableId)).toMatchObject({
      historyRetentionDays: 30,
      allowComputedOverrides: true,
      recordLock: {
        condition: { conjunction: 'and', conditions: [{ fieldId: box.id, operator: 'is', value: true }] },
        bypass: 'owners',
        reason: 'Approved',
      },
    });
    expect(
      (await loadDatabaseRules(server.pool, server.schemas, f.databaseId)).records.find(
        (rule) => rule.tableId === tableId,
      ),
    ).toMatchObject({
      roles: ['editor'],
      condition: { conjunction: 'and', conditions: [{ fieldId: amount.id, operator: 'gt', value: 1 }] },
    });
    await undo(f.databaseId, command.groupId);
    await undo(f.databaseId, command.groupId, server.owner, 'redo');
    await undo(f.databaseId, command.groupId);
  });

  it('retains shared attachment bytes after the source field is purged', async () => {
    const f = await fixture();
    const fieldId = newId('field');
    await send(f.databaseId, {
      kind: 'field.duplicate',
      fieldId: f.fields.file,
      newFieldId: fieldId,
      name: 'Stored copy',
      withValues: true,
    });
    await send(f.databaseId, { kind: 'field.trash', fieldId: f.fields.file });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'fields')}
      SET trashed_at = now() - interval '200 days' WHERE id = ${f.fields.file}`,
    );
    await purgeTrash(server.ctx);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT id FROM ${ident(server.schemas.app, 'files')} WHERE field_id = ${f.fields.file}`,
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT bytes FROM ${ident(server.schemas.app, 'file_chunks')} WHERE storage_key = ${f.file}`,
        )
      ).rows,
    ).toEqual([{ bytes: Buffer.from('abc') }]);
    expect((await rows(f.viewId))[0]!.values[fieldId]).toHaveLength(1);
  });

  it('copies only visible linked records and restores the original links on undo', async () => {
    const f = await permissionFixture(server);
    const before = await rows(f.teams.viewId);
    const { command, result } = await send(
      f.databaseId,
      { kind: 'record.duplicate', tableId: f.teams.tableId, recordIds: [f.teams.records.alpha] },
      f.persons.editor.signed,
    );
    const id = (result.output!.recordIds as string[])[0]!;
    const copy = await get<RowData>(`/api/tables/${f.teams.tableId}/records/${id}`);
    expect(copy.values[f.teams.fields.people]).toEqual([f.people.records.ana]);
    await audited(f.databaseId, command.groupId);
    await undo(f.databaseId, command.groupId, f.persons.editor.signed);
    expect((await rows(f.teams.viewId)).map((row) => ({ id: row.id, values: row.values }))).toEqual(
      before.map((row) => ({ id: row.id, values: row.values })),
    );
  });

  it('defaults locked values and refuses a copy outside record rules without leaking hidden fields', async () => {
    const f = await permissionFixture(server);
    const editor = f.persons.editor.signed;
    const { command, result } = await send(
      f.databaseId,
      { kind: 'record.duplicate', tableId: f.people.tableId, recordIds: [f.people.records.ana] },
      editor,
    );
    const copied = (result.output!.recordIds as string[])[0]!;
    const row = (await rows(f.people.viewId)).find((row) => row.id === copied)!;
    expect(row.values[f.people.fields.notes]).toBeNull();
    expect(row.values[f.people.fields.salary]).toBeNull();
    await undo(f.databaseId, command.groupId, editor);
    await send(f.databaseId, {
      kind: 'field.update',
      fieldId: f.people.fields.region,
      options: {
        choices: [
          { id: f.people.choices.west, name: 'West', color: 'blue' },
          { id: f.people.choices.east, name: 'East', color: 'red' },
        ],
        defaultValue: { kind: 'value', value: f.people.choices.east },
      },
    });
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'field_permissions')} (field_id, org_id, database_id, table_id, locked, updated_by)
      VALUES (${f.people.fields.region}, ${server.owner.info.org.id}, ${f.databaseId}, ${f.people.tableId}, ${JSON.stringify({ roles: ['owner'], users: [] })}::jsonb, ${server.owner.userId})
      ON CONFLICT (field_id) DO UPDATE SET locked = EXCLUDED.locked`,
    );
    await send(
      f.databaseId,
      { kind: 'record.duplicate', tableId: f.people.tableId, recordIds: [f.people.records.ana] },
      editor,
      'data.access.recordOutsideRules',
    );
  });
});
