import { afterEach, expect, it, vi } from 'vitest';
import type { GridApi, GridSelection } from '../../../../packages/grid-core/src/types';
import { openDatabase } from '../data';
import { FakeServer } from '../data/testing';
import { i18n } from '../i18n';
import type { RowData } from '@riosoma/contracts';
import { createGridController } from './view/controller';

const dispose: Array<() => void> = [];
afterEach(() => {
  for (const close of dispose.splice(0)) close();
});

it('selects the new record’s first cell and takes the focus, so typing fills it in', async () => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  const server = new FakeServer();
  const fixture = server.createDatabase(3);
  const session = await openDatabase(fixture.databaseId, server.deps());
  dispose.push(() => session.close());
  const rows = session.openView(fixture.viewId);
  for (let i = 0; i < 80; i++) await Promise.resolve();
  const schema = session.getSchema();
  const table = schema.tableById.get(fixture.tableId)!;
  const abort = new AbortController();
  const controller = createGridController(
    {
      session,
      rows,
      fields: schema.fields.get(fixture.tableId)!,
      format: { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() },
      table,
      view: schema.viewById.get(fixture.viewId)!,
      peers: [],
      onConfig: vi.fn(),
      onExpand: vi.fn(),
      onField: vi.fn(),
      onMenu: vi.fn(),
      onPreview: vi.fn(),
    },
    abort.signal,
  );
  dispose.push(() => {
    abort.abort();
    controller.destroy();
  });
  let selection: GridSelection = { active: null, range: null, rows: { kind: 'none' } };
  const api = {
    getSelection: () => selection,
    setSelection: vi.fn((next: GridSelection) => {
      selection = next;
    }),
    scrollToCell: vi.fn(),
    focus: vi.fn(),
    rowsChanged: vi.fn(),
    setDecorations: vi.fn(),
    update: vi.fn(),
  } as unknown as GridApi<RowData>;
  controller.attach(api);
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });

  controller.host.onAddRow?.();
  expect(rows.rowCount()).toBe(4);
  for (const frame of frames.splice(0)) frame(0);
  const cell = { row: 3, col: 0 };
  expect(api.setSelection).toHaveBeenLastCalledWith({
    active: cell,
    range: { start: cell, end: cell },
    rows: { kind: 'none' },
  });
  expect(api.scrollToCell).toHaveBeenCalledWith(cell, 'nearest');
  expect(api.focus).toHaveBeenCalled();
});

it('creates a record with group defaults through history and can undo the creation', async () => {
  const server = new FakeServer();
  const fixture = server.createDatabase(3);
  const session = await openDatabase(fixture.databaseId, server.deps());
  dispose.push(() => session.close());
  const rows = session.openView(fixture.viewId);
  for (let index = 0; index < 80; index++) await Promise.resolve();
  const schema = session.getSchema();
  const table = schema.tableById.get(fixture.tableId)!;
  const abort = new AbortController();
  const controller = createGridController(
    {
      session,
      rows,
      table,
      fields: schema.fields.get(fixture.tableId)!,
      view: schema.viewById.get(fixture.viewId)!,
      format: { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() },
      peers: [],
      onConfig: vi.fn(),
      onExpand: vi.fn(),
      onField: vi.fn(),
      onMenu: vi.fn(),
      onPreview: vi.fn(),
    },
    abort.signal,
  );
  dispose.push(() => {
    abort.abort();
    controller.destroy();
  });
  controller.addGroup({
    key: 'ready',
    level: 1,
    start: 0,
    count: 1,
    values: { [table.primaryFieldId]: 'Ready' },
    summaries: {},
  });
  const added = rows.getRow(1)!;
  expect(added.values[table.primaryFieldId]).toBe('Ready');
  for (let index = 0; index < 100; index++) await Promise.resolve();
  expect((await session.getRecord(table.id, added.id))?.values[table.primaryFieldId]).toBe('Ready');
  await session.undo();
  for (let index = 0; index < 100; index++) await Promise.resolve();
  expect(rows.rowCount()).toBe(3);
});
