import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, waitFor, within } from '@testing-library/react';
import { FieldMeta, type GridGroupBoundary, type RowData } from '@riosoma/contracts';
import type { GridHost } from '../../../../../packages/grid-core/src/types';
import { createGroupedGrid, type GroupedGrid } from './engine';
import { i18n } from '../../i18n';
import { openDatabase } from '../../data';
import { FakeServer } from '../../data/testing';
import { createGridController } from '../view/controller';

let grid: GroupedGrid | undefined;
const dispose: Array<() => void> = [];
const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')!;
const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')!;
beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  localStorage.clear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: () => void) {}
      observe() {
        queueMicrotask(() => this.callback());
      }
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 900 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
});
afterEach(() => {
  grid?.destroy();
  grid = undefined;
  for (const close of dispose.splice(0)) close();
  document.body.replaceChildren();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', width);
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', height);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const READY = 'cho00000000000001';

/** A grouped grid of two records in one group, by a text field or a single select field */
function fixture(
  enabled = true,
  type: 'text' | 'singleSelect' = 'text',
  renderAddIcon?: GridHost<RowData>['renderAddIcon'],
) {
  const field = FieldMeta.parse({
    id: 'fld00000000000001',
    tableId: 'tbl00000000000001',
    name: 'Name',
    description: '',
    type,
    ...(type === 'singleSelect'
      ? { options: { choices: [{ id: READY, name: 'Ready', color: 'blue' }] } }
      : {}),
    position: 0,
    createdAt: '',
    updatedAt: '',
  });
  const rows: RowData[] = Array.from({ length: 2 }, (_, index) => ({
    id: `rec0000000000000${index}`,
    values: { [field.id]: String(index) },
    createdAt: '',
    createdBy: null,
    updatedAt: '',
    updatedBy: null,
  }));
  const groups: GridGroupBoundary[] = [
    {
      key: 'a',
      level: 1,
      start: 0,
      count: 2,
      values: { [field.id]: type === 'singleSelect' ? READY : 'Ready' },
      summaries: { [field.id]: { kind: 'count', value: 2 } },
    },
  ];
  const host: GridHost<RowData> = {
    renderAddIcon,
    getRow: (index) => rows[index],
    ensureRows: vi.fn(),
    renderCell: (el, context) => {
      el.textContent = String(context.row.values[field.id]);
    },
    renderHeader: (el) => {
      el.textContent = field.name;
    },
    renderRowHeader: (el) => {
      el.replaceChildren();
    },
    editText: () => '',
    commitText: vi.fn(() => null),
    copy: vi.fn(() => ({ text: 'selected' })),
    clear: vi.fn(),
  };
  const node = document.createElement('div');
  document.body.append(node);
  const state = {
    groups,
    enabled,
    fields: [field],
    format: { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() },
    storageKey: 'test.groups',
    add: vi.fn(),
  };
  grid = createGroupedGrid(
    node,
    {
      host,
      columns: [{ id: field.id, width: 300, edit: 'inline' }],
      rowCount: 2,
      rowHeight: 32,
      frozenColumnCount: 1,
      label: 'Projects',
      showAddRow: true,
      showAddColumn: true,
    },
    state,
  );
  return { node, host, state };
}

it.each([true, false])('uses one library plus per creation control with grouping %s', async (enabled) => {
  const { node } = fixture(enabled);
  for (const selector of ['[data-rio-add]', '[data-rio-add-column]']) {
    await waitFor(() => {
      const button = node.querySelector(selector)!;
      expect(button.querySelectorAll('svg')).toHaveLength(1);
      expect(button.textContent).toBe('');
    });
  }
});

it('preserves the host creation renderer through the grouping wrapper', async () => {
  const renderAddIcon = vi.fn((button: HTMLElement) => {
    const marker = document.createElement('span');
    marker.dataset.hostIcon = '';
    button.replaceChildren(marker);
  });
  const { node } = fixture(false, 'text', renderAddIcon);
  await waitFor(() => expect(node.querySelectorAll('[data-host-icon]')).toHaveLength(2));
  expect(renderAddIcon).toHaveBeenCalledTimes(2);
});

it('renders accessible group coordinates and collapses and expands from the grid keyboard', async () => {
  const { node, host } = fixture();
  const screen = within(node);
  await waitFor(() => expect(screen.getByRole('treegrid')).toBeTruthy());
  const header = screen.getByRole('row', { name: 'Ready, 2 records' });
  expect(header.getAttribute('aria-level')).toBe('1');
  expect(within(header).getByLabelText('Count 2 (Name)').textContent).toBe('2');
  fireEvent.click(screen.getByRole('button', { name: 'Ready, 2 records' }));
  await waitFor(() => expect(header.getAttribute('aria-expanded')).toBe('false'));
  expect(screen.queryByRole('gridcell', { name: '0' })).toBeNull();
  fireEvent.keyDown(node.querySelector('textarea')!, { key: 'ArrowRight' });
  await waitFor(() => expect(header.getAttribute('aria-expanded')).toBe('true'));
  await waitFor(() => expect(host.ensureRows).toHaveBeenCalledWith(0, 2));
  grid!.setSelection({
    active: { row: 0, col: 0 },
    range: { start: { row: 0, col: 0 }, end: { row: 1, col: 0 } },
    rows: { kind: 'none' },
  });
  expect(grid!.getSelection().range?.end.row).toBe(1);
});

it.each([true, false])('honors record edit locks when grouping is %s', async (enabled) => {
  const { node, host } = fixture(enabled);
  host.canStartEdit = vi.fn((cell) => cell.row !== 1);
  const screen = within(node);
  await waitFor(() => expect(screen.getByRole('gridcell', { name: '1' })).toBeTruthy());
  grid!.setSelection({
    active: { row: 1, col: 0 },
    range: { start: { row: 1, col: 0 }, end: { row: 1, col: 0 } },
    rows: { kind: 'none' },
  });
  const input = node.querySelector('textarea')!;
  fireEvent.keyDown(input, { key: 'F2' });
  expect(input.hasAttribute('data-editing')).toBe(false);
  expect(host.canStartEdit).toHaveBeenLastCalledWith({ row: 1, col: 0 });
  fireEvent.doubleClick(screen.getByRole('gridcell', { name: '1' }));
  expect(input.hasAttribute('data-editing')).toBe(false);
  expect(host.commitText).not.toHaveBeenCalled();
  grid!.setSelection({
    active: { row: 0, col: 0 },
    range: { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } },
    rows: { kind: 'none' },
  });
  fireEvent.keyDown(input, { key: 'F2' });
  expect(host.canStartEdit).toHaveBeenLastCalledWith({ row: 0, col: 0 });
  expect(input.hasAttribute('data-editing')).toBe(true);
});

it('passes group defaults to adding and redraws a count without breaking collapse storage', async () => {
  const { node, state } = fixture();
  const screen = within(node);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add record in Ready' })).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Add record in Ready' }));
  expect(state.add).toHaveBeenCalledWith(state.groups[0]);
  grid!.grouping({ ...state, groups: [{ ...state.groups[0]!, count: 3 }] });
  await waitFor(() => expect(screen.getByRole('row', { name: 'Ready, 3 records' })).toBeTruthy());
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Storage unavailable');
  });
  expect(() => grid!.collapseGroups(true)).not.toThrow();
  await waitFor(() =>
    expect(screen.getByRole('row', { name: 'Ready, 3 records' }).getAttribute('aria-expanded')).toBe('false'),
  );
});

it.each(['text', 'singleSelect'] as const)(
  'keeps a %s group row’s buttons and every text node in place through redraws, so a press that spans one still clicks',
  async (type) => {
    const { node, state } = fixture(true, type);
    const screen = within(node);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add record in Ready' })).toBeTruthy());
    const row = screen.getByRole('row', { name: 'Ready, 2 records' });
    const toggle = within(row).getByRole('button', { name: 'Ready, 2 records' });
    const add = within(row).getByRole('button', { name: 'Add record in Ready' });
    const summary = within(row).getByLabelText('Count 2 (Name)');
    const texts = (root: Node) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const found: Node[] = [];
      while (walker.nextNode()) found.push(walker.currentNode);
      return found;
    };
    const before = [...texts(toggle), ...texts(add)];
    expect(before.map((text) => text.textContent)).toEqual(['Ready', ' ', '2 records']);
    const disclosureIcon = toggle.querySelector('svg');
    expect(disclosureIcon).toBeTruthy();
    const addIcon = add.querySelector('svg');
    expect(addIcon).toBeTruthy();
    expect(add.title).toBe('Add record in Ready');
    const removals: Node[] = [];
    const observer = new MutationObserver((records) =>
      records.forEach((record) => removals.push(...record.removedNodes)),
    );
    observer.observe(row, { childList: true, subtree: true });
    // Every row drawn again, new options with new objects for the same columns, and a count that
    // arrives from the server, as happen while someone presses a group's button.  Each change to a
    // record hands the grid new lists of fields and a new format, holding the same fields.
    grid!.rowsChanged();
    grid!.update({ columns: [{ id: state.fields[0]!.id, width: 300, edit: 'inline' }] });
    grid!.grouping({
      ...state,
      fields: [...state.fields],
      format: { ...state.format },
      groups: [{ ...state.groups[0]!, count: 3 }],
    });
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Ready, 3 records' })).toBe(toggle));
    observer.takeRecords().forEach((record) => removals.push(...record.removedNodes));
    observer.disconnect();
    expect(removals).toEqual([]);
    expect(within(row).getByRole('button', { name: 'Add record in Ready' })).toBe(add);
    expect(within(row).getByLabelText('Count 2 (Name)')).toBe(summary);
    expect([...texts(toggle), ...texts(add)]).toEqual(before);
    expect(before.map((text) => text.textContent)).toEqual(['Ready', ' ', '3 records']);
    expect(toggle.querySelector('svg')).toBe(disclosureIcon);
    expect(add.querySelector('svg')).toBe(addIcon);
  },
);

it('takes a group’s add button away while the grid is read only and brings it back after', async () => {
  const { node } = fixture();
  const screen = within(node);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add record in Ready' })).toBeTruthy());
  grid!.update({ readOnly: true });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Add record in Ready' })).toBeNull());
  expect(screen.getByRole('button', { name: 'Ready, 2 records' })).toBeTruthy();
  grid!.update({ readOnly: false });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add record in Ready' })).toBeTruthy());
});

it('keeps the focused group control attached through redraws and keyboard collapse', async () => {
  const { node, state } = fixture();
  const screen = within(node);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Ready, 2 records' })).toBeTruthy());
  const button = screen.getByRole('button', { name: 'Ready, 2 records' });
  button.focus();
  grid!.grouping({ ...state, groups: [{ ...state.groups[0]!, count: 3 }] });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Ready, 3 records' })).toBeTruthy());
  expect(document.activeElement).toBe(button);
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
  await waitFor(() =>
    expect(screen.getByRole('row', { name: 'Ready, 3 records' }).getAttribute('aria-expanded')).toBe('false'),
  );
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
  await waitFor(() =>
    expect(screen.getByRole('row', { name: 'Ready, 3 records' }).getAttribute('aria-expanded')).toBe('true'),
  );
});

async function pasteFixture(count: number) {
  const server = new FakeServer();
  const fixture = server.createDatabase(count);
  const session = await openDatabase(fixture.databaseId, server.deps());
  dispose.push(() => session.close());
  const rows = session.openView(fixture.viewId);
  await waitFor(() => expect(rows.rowCount()).toBe(count));
  rows.ensureRows(0, count);
  if (count) await waitFor(() => expect(rows.getRow(count - 1)).toBeTruthy());
  const schema = session.getSchema();
  const table = schema.tableById.get(fixture.tableId)!;
  const abort = new AbortController();
  const onPreview = vi.fn();
  const state = {
    groups: Array.from({ length: count }, (_, index) => ({
      key: String(index),
      level: 1,
      start: index,
      count: 1,
      values: { [table.primaryFieldId]: `Group ${index}` },
      summaries: {},
    })),
    enabled: count > 0,
    fields: schema.fields.get(table.id)!,
    format: { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() },
    storageKey: 'test.paste.groups',
  };
  const controller = createGridController(
    {
      ...state,
      session,
      rows,
      table,
      view: schema.viewById.get(fixture.viewId)!,
      peers: [],
      onConfig: vi.fn(),
      onExpand: vi.fn(),
      onField: vi.fn(),
      onMenu: vi.fn(),
      onPreview,
    },
    abort.signal,
  );
  dispose.push(() => {
    abort.abort();
    controller.destroy();
  });
  const paste = vi.spyOn(controller.host, 'paste');
  const node = document.createElement('div');
  document.body.append(node);
  grid = createGroupedGrid(
    node,
    {
      host: controller.host,
      columns: controller.columns(),
      rowCount: count,
      rowHeight: 32,
      frozenColumnCount: 1,
      label: 'Projects',
    },
    state,
  );
  controller.attach(grid);
  const send = (text: string, html: string | null = null) =>
    fireEvent.paste(node.querySelector('textarea')!, {
      clipboardData: {
        types: html ? ['text/plain', 'text/html'] : ['text/plain'],
        getData: (type: string) => (type === 'text/html' ? html : text),
      },
    });
  return { node, rows, table, state, controller, onPreview, paste, send };
}

it.each([
  { text: 'first replacement\nsecond replacement', html: null },
  {
    text: 'first replacement',
    html: '<table><tr><td>first replacement</td></tr><tr><td>second replacement</td></tr></table>',
  },
])('rejects clipboard destinations inside a collapsed group for $html', async ({ text, html }) => {
  const { node, rows, table, paste, send } = await pasteFixture(3);
  const before = rows.getRow(1)!.values[table.primaryFieldId];
  await waitFor(() => expect(within(node).getByRole('button', { name: 'Group 1, 1 record' })).toBeTruthy());
  fireEvent.click(within(node).getByRole('button', { name: 'Group 1, 1 record' }));
  grid!.setSelection({
    active: { row: 0, col: 0 },
    range: { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } },
    rows: { kind: 'none' },
  });
  send(text, html);
  grid!.paste(grid!.getSelection(), { text, html });
  for (let index = 0; index < 100; index++) await Promise.resolve();
  expect(rows.getRow(1)!.values[table.primaryFieldId]).toBe(before);
  expect(paste).not.toHaveBeenCalled();
  send('safe replacement');
  await waitFor(() => expect(rows.getRow(0)!.values[table.primaryFieldId]).toBe('safe replacement'));
});

it('pastes at row zero in an empty ungrouped grid', async () => {
  const { rows, table, controller, onPreview, send } = await pasteFixture(0);
  send('first replacement\nsecond replacement');
  await waitFor(() => expect(onPreview).toHaveBeenCalledOnce());
  controller.applyPaste(onPreview.mock.calls[0]![0]);
  await waitFor(() => expect(rows.rowCount()).toBe(2));
  expect([0, 1].map((index) => rows.getRow(index)!.values[table.primaryFieldId])).toEqual([
    'first replacement',
    'second replacement',
  ]);
});

it('suppresses pastes directed at group headers', async () => {
  const { node, paste, send } = await pasteFixture(3);
  await waitFor(() => expect(within(node).getByRole('button', { name: 'Group 0, 1 record' })).toBeTruthy());
  fireEvent.click(within(node).getByRole('button', { name: 'Group 0, 1 record' }));
  send('replacement');
  expect(paste).not.toHaveBeenCalled();
});

it.each([true, false])(
  'preserves unfinished edits through row notifications when grouping is %s',
  async (enabled) => {
    const { node, host, state } = fixture(enabled);
    await waitFor(() => expect(node.querySelector('[role="gridcell"]')).toBeTruthy());
    grid!.startEditing({ row: 0, col: 0 }, 'unfinished draft');
    expect(grid!.isEditing()).toBe(true);
    grid!.grouping({
      ...state,
      groups: state.groups.map((group) => ({
        ...group,
        summaries: { [state.fields[0]!.id]: { kind: 'count', value: 9 } },
      })),
    });
    grid!.rowsChanged();
    grid!.update({ label: 'Updated projects' });
    expect(grid!.isEditing()).toBe(true);
    expect(node.querySelector('textarea')!.value).toBe('unfinished draft');
    expect(host.commitText).not.toHaveBeenCalled();
    grid!.stopEditing(true);
    expect(host.commitText).toHaveBeenCalledWith({ row: 0, col: 0 }, 'unfinished draft');
  },
);

it('keeps the selected record, range, and rows when earlier group boundaries change', async () => {
  const { state } = await pasteFixture(4);
  const original = [
    { ...state.groups[0]!, count: 2 },
    { ...state.groups[2]!, count: 2 },
  ];
  grid!.grouping({ ...state, groups: original });
  const selection = {
    active: { row: 3, col: 1 },
    range: { start: { row: 2, col: 0 }, end: { row: 3, col: 1 } },
    rows: { kind: 'some' as const, rows: new Set([2, 3]) },
  };
  grid!.setSelection(selection);
  grid!.grouping({ ...state, groups: [state.groups[0]!, state.groups[1]!, original[1]!] });
  expect(grid!.getSelection()).toEqual(selection);
  grid!.grouping({ ...state, groups: original });
  expect(grid!.getSelection()).toEqual(selection);
  grid!.grouping({ ...state, enabled: false });
  expect(grid!.getSelection()).toEqual(selection);
});

it('stops automatic fill at the first collapsed record and keeps later records unchanged', async () => {
  const { node, rows, state } = await pasteFixture(4);
  const amount = state.fields[1]!.id;
  const before = [0, 1, 2, 3].map((row) => rows.getRow(row)!.values[amount]);
  await waitFor(() => expect(within(node).getByRole('button', { name: 'Group 2, 1 record' })).toBeTruthy());
  fireEvent.click(within(node).getByRole('button', { name: 'Group 2, 1 record' }));
  const cell = { row: 0, col: 1 };
  grid!.setSelection({ active: cell, range: { start: cell, end: cell }, rows: { kind: 'none' } });
  const handle = node.querySelector<HTMLElement>('.rio-grid__fill-handle')!;
  handle.setPointerCapture = vi.fn();
  handle.hasPointerCapture = () => false;
  for (let tap = 0; tap < 2; tap++) {
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 300, clientY: 60 });
    fireEvent.pointerUp(handle, { pointerId: 1, button: 0, clientX: 300, clientY: 60 });
  }
  await waitFor(() => expect(rows.getRow(1)!.values[amount]).toBe(before[0]));
  expect(rows.getRow(2)!.values[amount]).toBe(before[2]);
  expect(rows.getRow(3)!.values[amount]).toBe(before[3]);
  expect(grid!.getSelection().range?.end.row).toBe(1);
});

it('keeps an active draft on its record when group coordinates move', async () => {
  const { node, rows, state } = await pasteFixture(4);
  grid!.grouping({
    ...state,
    groups: [
      { ...state.groups[0]!, count: 2 },
      { ...state.groups[2]!, count: 2 },
    ],
  });
  grid!.startEditing({ row: 3, col: 0 }, 'moving draft');
  expect(grid!.isEditing()).toBe(true);
  grid!.grouping(state);
  expect(grid!.isEditing()).toBe(true);
  expect(node.querySelector('textarea')!.value).toBe('moving draft');
  expect(grid!.getSelection().active).toEqual({ row: 3, col: 0 });
  grid!.stopEditing(true);
  await waitFor(() => expect(rows.getRow(3)!.values[state.fields[0]!.id]).toBe('moving draft'));
  expect(rows.getRow(2)!.values[state.fields[0]!.id]).toBe('Record 3');
});

it.each([false, true])(
  'maps cell comment markers to record coordinates when grouping is %s',
  async (enabled) => {
    const { node, host } = fixture(enabled);
    host.cellComment = () => 'test.cellComments';
    host.onCellComment = vi.fn();
    grid!.rowsChanged();
    await waitFor(() =>
      expect(within(node).getAllByRole('button', { name: 'test.cellComments' })).toHaveLength(2),
    );
    fireEvent.click(within(node).getAllByRole('button', { name: 'test.cellComments' })[0]!);
    expect(host.onCellComment).toHaveBeenCalledWith({ row: 0, col: 0 });
  },
);

it.each(['user', 'createdBy', 'lastModifiedBy'] as const)(
  'refreshes uploaded, replaced, and removed pictures in %s group headers',
  async (type) => {
    const { node, state } = fixture();
    const personId = 'usr00000000000001';
    const field = FieldMeta.parse({ ...state.fields[0], type, options: {} });
    const next = {
      ...state,
      fields: [field],
      groups: state.groups.map((group) => ({
        ...group,
        values: { [field.id]: personId },
      })),
      format: {
        ...state.format,
        collaborators: new Map([[personId, { name: 'Morgan Profile', pictureUrl: null as string | null }]]),
      },
    };
    grid!.grouping(next);
    await waitFor(() =>
      expect(node.querySelector('.rio-grid-group-value .rio-person-avatar')?.textContent).toBe('MP'),
    );
    expect(node.querySelector('.rio-grid-group-toggle')?.getAttribute('aria-label')).toBe(
      'MP: Morgan Profile, 2 records',
    );
    for (const pictureUrl of ['/api/people/picture?v=first', '/api/people/picture?v=second', null]) {
      next.format.collaborators.set(personId, { name: 'Morgan Profile', pictureUrl });
      grid!.grouping(next);
      await waitFor(() => {
        const avatar = node.querySelector('.rio-grid-group-value .rio-person-avatar')!;
        if (pictureUrl) expect(avatar.querySelector('img')?.getAttribute('src')).toBe(pictureUrl);
        else {
          expect(avatar.querySelector('img')).toBeNull();
          expect(avatar.textContent).toBe('MP');
        }
      });
    }
  },
);
