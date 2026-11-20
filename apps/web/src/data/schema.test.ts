import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '@riosoma/contracts';
import type { Command, FieldMeta } from '@riosoma/contracts';
import { openDatabase } from './session';
import { FakeServer } from './testing';
import type { FakeFixture } from './testing';
import type { DatabaseSession, ViewRows } from './types';

async function settle(): Promise<void> {
  for (let index = 0; index < 80; index++) await Promise.resolve();
}
let server: FakeServer, fixture: FakeFixture, session: DatabaseSession, view: ViewRows;
beforeEach(async () => {
  vi.useFakeTimers();
  server = new FakeServer();
  fixture = server.createDatabase(500);
  session = await openDatabase(fixture.databaseId, server.deps());
  view = session.openView(fixture.viewId);
  await settle();
});
afterEach(() => {
  session.close();
  vi.useRealTimers();
});
const rowsRequests = () => server.requests.filter((request) => request.path.includes('/rows?'));

describe('schema projection', () => {
  it('keeps local schema edits over remote changes and rolls back only a rejected edit', async () => {
    server.goOffline();
    await settle();
    session.run([{ kind: 'table.update', tableId: fixture.tableId, name: 'Local table' }]);
    const initial = session.getSchema();
    expect(initial.tableById.get(fixture.tableId)?.name).toBe('Local table');
    server.offline = false;
    server.remote(fixture.databaseId, [
      { kind: 'table.update', tableId: fixture.tableId, description: 'Remote description' },
    ]);
    server.rejectNext('data.table.rejected');
    server.goOnline();
    await settle();
    expect(session.getSchema()).not.toBe(initial);
    expect(session.getSchema().tableById.get(fixture.tableId)).toEqual(
      expect.objectContaining({ name: 'Table', description: 'Remote description' }),
    );
  });

  it('accepts defaulted command inputs, reloads converted rows, and restores exact values on undo', async () => {
    const command = {
      kind: 'field.convert' as const,
      fieldId: fixture.numberFieldId,
      to: { type: 'text' as const },
    };
    const action = session.run([command]);
    expect(session.getSchema().fieldById.get(fixture.numberFieldId)?.type).toBe('text');
    await action.done;
    await settle();
    expect(view.getRow(0)?.values[fixture.numberFieldId]).toBe('0');
    const request = server.requests.find((request) => request.path.endsWith('/commands'))!;
    const sent = (request.options.body as { commands: Command[] }).commands[0];
    expect(sent).toMatchObject({ dateOrder: 'mdy', timeZone: 'UTC', to: { type: 'text', options: {} } });
    expect(rowsRequests()).toHaveLength(2);
    await session.undo();
    await settle();
    expect(view.getRow(0)?.values[fixture.numberFieldId]).toBe(0);
  });

  it('refreshes order for filters and sorts but keeps the snapshot for display configuration', async () => {
    await session.run([
      {
        kind: 'view.update',
        viewId: fixture.viewId,
        config: {
          columnWidths: { [fixture.textFieldId]: 220 },
          hiddenFieldIds: [fixture.numberFieldId],
          rowHeight: 'tall',
        },
      },
    ]).done;
    await settle();
    expect(rowsRequests()).toHaveLength(1);
    server.remote(fixture.databaseId, [
      {
        kind: 'view.update',
        viewId: fixture.viewId,
        config: { sorts: [{ fieldId: fixture.numberFieldId, direction: 'desc' }] },
      },
    ]);
    await settle();
    expect(rowsRequests()).toHaveLength(2);
    expect(rowsRequests()[1]?.path).toContain('refresh=1');
    expect(view.getRow(0)?.id).toBe(fixture.recordId(499));
    server.remote(fixture.databaseId, [
      {
        kind: 'view.update',
        viewId: fixture.viewId,
        config: {
          filter: {
            conjunction: 'and',
            conditions: [{ id: 'condition_1', fieldId: fixture.numberFieldId, operator: 'lt', value: 10 }],
          },
        },
      },
    ]);
    await settle();
    expect(view.rowCount()).toBe(10);
    expect(view.getRow(0)?.id).toBe(fixture.recordId(9));
  });

  it('applies table, field, view, and database change kinds and their restores', async () => {
    const tableId = newId('table'),
      fieldId = newId('field'),
      viewId = newId('view');
    await session.run([
      {
        kind: 'table.create',
        table: {
          id: tableId,
          name: 'New table',
          fields: [{ id: fieldId, name: 'Name', type: 'text' }],
          view: { id: viewId, name: 'Grid' },
        },
      },
    ]).done;
    await settle();
    expect(session.getSchema().tableById.has(tableId)).toBe(true);
    const secondField = newId('field'),
      secondView = newId('view');
    await session.run([
      {
        kind: 'field.create',
        tableId,
        field: { id: secondField, name: 'Number', type: 'number' },
        placement: { viewId, index: 0 },
      },
      { kind: 'field.setPrimary', tableId, fieldId: secondField },
      { kind: 'view.create', view: { id: secondView, tableId, name: 'Second', type: 'grid' } },
      { kind: 'view.move', viewId: secondView, position: -1 },
      { kind: 'table.move', tableId, position: -1 },
      { kind: 'database.update', name: 'Renamed' },
    ]).done;
    await settle();
    expect(session.getSchema().tables[0]?.id).toBe(tableId);
    expect(session.getSchema().tableById.get(tableId)?.primaryFieldId).toBe(secondField);
    expect(session.getSchema().viewById.get(viewId)?.config.fieldOrder[0]).toBe(secondField);
    expect(session.getSchema().views.get(tableId)?.[0]?.id).toBe(secondView);
    expect(session.getSchema().database.name).toBe('Renamed');
    for (const command of [
      { kind: 'field.trash' as const, fieldId },
      { kind: 'view.trash' as const, viewId: secondView },
      { kind: 'table.trash' as const, tableId },
    ]) {
      await session.run([command]).done;
      await settle();
    }
    expect(session.getSchema().tableById.has(tableId)).toBe(false);
    await session.run([
      { kind: 'table.restore', tableId },
      { kind: 'field.restore', fieldId },
      { kind: 'view.restore', viewId: secondView },
    ]).done;
    await settle();
    expect(session.getSchema().fieldById.has(fieldId)).toBe(true);
    expect(session.getSchema().viewById.has(secondView)).toBe(true);
    server.remoteChange(fixture.databaseId, {
      kind: 'database.created',
      database: server.database(fixture.databaseId).schema.database,
    });
    server.remoteChange(fixture.databaseId, { kind: 'database.restored' });
    await settle();
    expect(session.role()).toBe('owner');
  });

  it('removes deleted choices in loaded rows while preserving a pending local edit', async () => {
    const fieldId = newId('field'),
      choice = newId('choice'),
      other = newId('choice');
    await session.run([
      {
        kind: 'field.create',
        tableId: fixture.tableId,
        field: {
          id: fieldId,
          name: 'Choice',
          type: 'singleSelect',
          options: {
            choices: [
              { id: choice, name: 'One', color: 'blue' },
              { id: other, name: 'Two', color: 'red' },
            ],
          },
        },
      },
    ]).done;
    await session.run([
      {
        kind: 'record.update',
        tableId: fixture.tableId,
        records: [{ id: fixture.recordId(0), values: { [fieldId]: choice } }],
      },
    ]).done;
    await settle();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.beforeRequest = (request) => (request.path.endsWith('/commands') ? blocked : Promise.resolve());
    const action = session.run([
      {
        kind: 'record.update',
        tableId: fixture.tableId,
        records: [{ id: fixture.recordId(0), values: { [fieldId]: other } }],
      },
    ]);
    const before = session.getSchema().fieldById.get(fieldId)!;
    server.remoteChange(fixture.databaseId, {
      kind: 'field.updated',
      field: {
        ...before,
        type: 'singleSelect',
        options: { choices: [{ id: other, name: 'Two', color: 'red' }] },
      } as FieldMeta,
      removedChoiceIds: [choice],
    });
    await settle();
    expect(view.getRow(0)?.values[fieldId]).toBe(other);
    server.rejectNext();
    release();
    await action.done;
    await settle();
    expect(view.getRow(0)?.values[fieldId]).toBeNull();
  });

  it('refreshes again when order changes while a refresh is in flight', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    server.afterRequest = async (request) => {
      if (request.path.includes('refresh=1') && !held) {
        held = true;
        await blocked;
      }
    };
    server.remote(fixture.databaseId, [
      {
        kind: 'view.update',
        viewId: fixture.viewId,
        config: { sorts: [{ fieldId: fixture.numberFieldId, direction: 'desc' }] },
      },
    ]);
    await settle();
    server.remote(fixture.databaseId, [
      { kind: 'view.update', viewId: fixture.viewId, config: { sorts: [] } },
    ]);
    await settle();
    release();
    await settle();
    expect(view.getRow(0)?.id).toBe(fixture.recordId(0));
    expect(rowsRequests()).toHaveLength(3);
  });
});

it('preserves existing filters and sorts when a display-only patch is sent', async () => {
  await session.run([
    {
      kind: 'view.update',
      viewId: fixture.viewId,
      config: { sorts: [{ fieldId: fixture.numberFieldId, direction: 'desc' }] },
    },
  ]).done;
  await settle();
  const before = rowsRequests().length;
  await session.run([{ kind: 'view.update', viewId: fixture.viewId, config: { rowHeight: 'tall' } }]).done;
  await settle();
  expect(rowsRequests()).toHaveLength(before);
  expect(view.getRow(0)?.id).toBe(fixture.recordId(499));
  const request = server.requests.findLast((request) => request.path.endsWith('/commands'))!;
  expect((request.options.body as { commands: Command[] }).commands[0]).toMatchObject({
    config: { rowHeight: 'tall' },
  });
  const command = (request.options.body as { commands: Command[] }).commands[0]!;
  expect('config' in command ? command.config : null).toEqual({ rowHeight: 'tall' });
});

it('converts dates using supplied date order and viewer time zone', async () => {
  await session.run([
    {
      kind: 'record.update',
      tableId: fixture.tableId,
      records: [{ id: fixture.recordId(0), values: { [fixture.textFieldId]: '27/09/2026 12:30' } }],
    },
  ]).done;
  await session.run([
    {
      kind: 'field.convert',
      fieldId: fixture.textFieldId,
      to: { type: 'date', options: { includeTime: true } },
      dateOrder: 'dmy',
      timeZone: 'America/Los_Angeles',
    },
  ]).done;
  await settle();
  expect(view.getRow(0)?.values[fixture.textFieldId]).toBe('2026-09-27T19:30:00.000Z');
  await session.undo();
  await settle();
  expect(view.getRow(0)?.values[fixture.textFieldId]).toBe('27/09/2026 12:30');
});

it('reloads converted inserted rows as well as paged rows', async () => {
  const id = newId('record');
  await session.run(
    [
      {
        kind: 'record.create',
        tableId: fixture.tableId,
        records: [{ id, values: { [fixture.numberFieldId]: 12 } }],
      },
    ],
    { placeAt: { viewId: fixture.viewId, index: 2 } },
  ).done;
  await settle();
  await session.run([{ kind: 'field.convert', fieldId: fixture.numberFieldId, to: { type: 'text' } }]).done;
  await settle();
  expect(view.getRow(2)?.values[fixture.numberFieldId]).toBe('12');
  expect(view.getRow(0)?.values[fixture.numberFieldId]).toBe('0');
});

it('keeps unrelated remote cell edits when undo restores a converted column', async () => {
  await session.run([{ kind: 'field.convert', fieldId: fixture.numberFieldId, to: { type: 'text' } }]).done;
  await settle();
  server.remote(fixture.databaseId, [
    {
      kind: 'record.update',
      tableId: fixture.tableId,
      records: [{ id: fixture.recordId(0), values: { [fixture.textFieldId]: 'Remote' } }],
    },
  ]);
  await settle();
  await session.undo();
  await settle();
  expect(view.getRow(0)?.values).toMatchObject({
    [fixture.textFieldId]: 'Remote',
    [fixture.numberFieldId]: 0,
  });
});

it('clears removed choices optimistically and restores their values when undone', async () => {
  const fieldId = newId('field'),
    choiceId = newId('choice');
  await session.run([
    {
      kind: 'field.create',
      tableId: fixture.tableId,
      field: {
        id: fieldId,
        name: 'Choice',
        type: 'singleSelect',
        options: { choices: [{ id: choiceId, name: 'One', color: 'blue' }] },
      },
    },
  ]).done;
  await session.run([
    {
      kind: 'record.update',
      tableId: fixture.tableId,
      records: [{ id: fixture.recordId(0), values: { [fieldId]: choiceId } }],
    },
  ]).done;
  await settle();
  const action = session.run([{ kind: 'field.update', fieldId, options: { choices: [] } }]);
  expect(view.getRow(0)?.values[fieldId]).toBeNull();
  await action.done;
  await settle();
  await session.undo();
  await settle();
  expect(view.getRow(0)?.values[fieldId]).toBe(choiceId);
});

it('keeps metadata stable for record edits while publishing confirmed sequence changes', async () => {
  const before = session.getSchema();
  const schemaChanged = vi.fn();
  const recordsChanged = vi.fn();
  session.subscribe(schemaChanged);
  session.subscribeRecords(fixture.tableId, recordsChanged);
  const action = session.run([
    {
      kind: 'record.update',
      tableId: fixture.tableId,
      records: [{ id: fixture.recordId(0), values: { [fixture.textFieldId]: 'Immediate echo' } }],
    },
  ]);
  expect(view.getRow(0)?.values[fixture.textFieldId]).toBe('Immediate echo');
  expect(recordsChanged).toHaveBeenCalled();
  expect(session.getSchema()).toBe(before);
  expect(schemaChanged).not.toHaveBeenCalled();
  await action.done;
  await settle();
  const confirmed = session.getSchema();
  expect(confirmed.seq).toBeGreaterThan(before.seq);
  expect(confirmed.fields).toBe(before.fields);
  expect(confirmed.views).toBe(before.views);
  expect(confirmed.tableById).toBe(before.tableById);
  expect(schemaChanged).toHaveBeenCalledTimes(1);
  session.run([{ kind: 'field.update', fieldId: fixture.textFieldId, name: 'Renamed field' }]);
  expect(session.getSchema().fieldById.get(fixture.textFieldId)?.name).toBe('Renamed field');
  expect(session.getSchema().fields).not.toBe(before.fields);
});
