import { afterEach, expect, it } from 'vitest';
import { newId } from '@riosoma/contracts';
import { openDatabase } from './session';
import { syncedFixture } from './testing/synced';
import type { DatabaseSession } from './types';

const sessions: DatabaseSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
});
async function setup() {
  const fixture = syncedFixture();
  const session = await openDatabase(fixture.fixture.databaseId, fixture.server.deps());
  sessions.push(session);
  const rows = session.openView(fixture.fixture.viewId);
  for (let i = 0; i < 80; i++) await Promise.resolve();
  return { ...fixture, session, rows };
}
it('sets overrides immediately, retains the original source, clears multiple cells, and undoes clearing', async () => {
  const { session, rows, fixture } = await setup();
  const records = [0, 1].map((index) => ({
    id: fixture.recordId(index),
    values: { [fixture.textFieldId]: 'Local' },
  }));
  const edit = session.run([{ kind: 'record.update', tableId: fixture.tableId, records }]);
  expect(rows.getRow(0)?.overrides?.[fixture.textFieldId]?.source).toBe('Record 1');
  expect(await edit.done).toEqual({ applied: 1, rejected: 0 });
  await session.run([
    {
      kind: 'record.update',
      tableId: fixture.tableId,
      records: [{ ...records[0]!, values: { [fixture.textFieldId]: 'Again' } }],
    },
  ]).done;
  expect(rows.getRow(0)?.overrides?.[fixture.textFieldId]?.source).toBe('Record 1');
  const clear = session.run([
    {
      kind: 'record.clearOverrides',
      tableId: fixture.tableId,
      records: records.map(({ id }) => ({ id, fieldIds: [fixture.textFieldId] })),
    },
  ]);
  expect(rows.getRow(0)?.values[fixture.textFieldId]).toBe('Record 1');
  expect(rows.getRow(0)?.overrides).toEqual({});
  await clear.done;
  await session.undo();
  expect(rows.getRow(0)?.values[fixture.textFieldId]).toBe('Again');
  expect(rows.getRow(1)?.values[fixture.textFieldId]).toBe('Local');
  expect(rows.getRow(0)?.overrides?.[fixture.textFieldId]?.source).toBe('Record 1');
});
it('blocks record creation, deletion, source conversion, and source edits when overrides are off; local fields still edit', async () => {
  const { session, fixture } = await setup();
  await session.run([
    { kind: 'table.updateSource', tableId: fixture.tableId, settings: { allowOverrides: false } },
  ]).done;
  expect(() =>
    session.run([
      { kind: 'record.create', tableId: fixture.tableId, records: [{ id: newId('record'), values: {} }] },
    ]),
  ).toThrow();
  expect(() =>
    session.run([{ kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.recordId(0)] }]),
  ).toThrow();
  expect(() =>
    session.run([
      {
        kind: 'field.convert',
        fieldId: fixture.textFieldId,
        to: { type: 'number' },
        dateOrder: 'mdy',
        timeZone: 'UTC',
      },
    ]),
  ).toThrow();
  expect(() =>
    session.run([
      {
        kind: 'record.update',
        tableId: fixture.tableId,
        records: [{ id: fixture.recordId(0), values: { [fixture.textFieldId]: 'Denied' } }],
      },
    ]),
  ).toThrow();
  expect(
    await session.run([
      {
        kind: 'record.update',
        tableId: fixture.tableId,
        records: [{ id: fixture.recordId(0), values: { [fixture.numberFieldId]: 12 } }],
      },
    ]).done,
  ).toEqual({ applied: 1, rejected: 0 });
});
it('reloads open views after a sync and resolves the original viewport anchor after removals', async () => {
  const { server, database, session, rows, fixture } = await setup();
  const otherRows = session.openView(fixture.viewId, { stack: '' });
  for (let i = 0; i < 80; i++) await Promise.resolve();
  const anchor = rows.getRow(4)!.id;
  let anchorIndex: number | null = null;
  rows.onSyncRefresh?.(async () => {
    anchorIndex = (await rows.refresh(anchor)).anchorIndex;
  });
  database.rows(fixture.tableId).trash(fixture.recordId(0));
  const before = server.requests.filter((request) => request.path.includes('/rows?')).length;
  await session.run([{ kind: 'table.sync', tableId: fixture.tableId }]).done;
  for (let i = 0; i < 160; i++) await Promise.resolve();
  expect(session.getSchema().tableById.get(fixture.tableId)?.source?.status.state).toBe('idle');
  expect(rows.rowCount()).toBe(9);
  expect(anchorIndex).toBe(3);
  expect(rows.getRow(3)?.id).toBe(anchor);
  expect(server.requests.filter((request) => request.path.includes('/rows?')).length).toBeGreaterThan(before);
  otherRows.close();
});

it('keeps syncs out of undo history and preserves redo for a local edit', async () => {
  const { session, fixture, rows } = await setup();
  await session.run([{ kind: 'table.sync', tableId: fixture.tableId }]).done;
  expect(session.canUndo()).toBe(false);
  await session.run([
    {
      kind: 'record.update',
      tableId: fixture.tableId,
      records: [{ id: fixture.recordId(0), values: { [fixture.textFieldId]: 'Local' } }],
    },
  ]).done;
  await session.undo();
  await session.run([{ kind: 'table.sync', tableId: fixture.tableId }]).done;
  expect(session.canRedo()).toBe(true);
  await session.redo();
  expect(rows.getRow(0)?.values[fixture.textFieldId]).toBe('Local');
});

it('updates copy progress without rereading open rows', async () => {
  const { server, session, fixture } = await setup();
  const before = server.requests.filter((request) => request.path.includes('/rows?')).length;
  const table = session.getSchema().tableById.get(fixture.tableId)!;
  server.remoteChange(fixture.databaseId, {
    kind: 'table.updated',
    syncProgress: true,
    table: {
      ...table,
      source: {
        ...table.source!,
        status: {
          ...table.source!.status,
          state: 'running',
          progress: { rowsRead: 5_000 },
        },
      },
    },
  });
  for (let i = 0; i < 160; i++) await Promise.resolve();
  expect(session.getSchema().tableById.get(fixture.tableId)?.source?.status.progress?.rowsRead).toBe(5_000);
  expect(server.requests.filter((request) => request.path.includes('/rows?')).length).toBe(before);
});
