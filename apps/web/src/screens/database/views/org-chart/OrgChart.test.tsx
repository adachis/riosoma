import { I18nProvider } from '@lingui/react';
import { toastQueue } from '@riosoma/ui';
import { i18n } from '../../../../i18n';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldMeta, GridConfig, newId, type DatabaseRole, type RowData } from '@riosoma/contracts';
import { openDatabase } from '../../../../data/session';
import { FakeServer } from '../../../../data/testing';
import type { DatabaseSession } from '../../../../data/types';
import { useSchema } from '../../../../data/hooks';
import { OrgChartView } from './OrgChartView';
import { CARD_WIDTH, cardHeight, chartLayout, fitChart, visibleChart } from './layout';
import { readChartLocation } from './location';
import * as recordStore from '../timeline/records';
import * as formatting from '../../../../grid/format';

const sessions: DatabaseSession[] = [];
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  sessions.splice(0).forEach((session) => session.close());
  window.history.replaceState({}, '', window.location.pathname);
  vi.restoreAllMocks();
});
const tableId = newId('table');
const parent = FieldMeta.parse({
  id: newId('field'),
  tableId,
  name: 'Parent',
  type: 'link',
  options: { linkedTableId: tableId },
  description: '',
  position: 1,
  createdAt: '',
  updatedAt: '',
});
const record = (id: string, parents: string[] = []): RowData => ({
  id,
  values: { [parent.id]: parents },
  createdAt: '',
  updatedAt: '',
  createdBy: null,
  updatedBy: null,
});

describe('org chart layout', () => {
  it('connects visible parents and opens cycles without changing link values', () => {
    const a = newId('record'),
      b = newId('record'),
      c = newId('record'),
      outside = newId('record');
    const rows = [record(a, [b]), record(b, [a]), record(c, [outside])];
    const saved = structuredClone(rows);
    const result = chartLayout(rows, parent, new Set(), 84);
    expect(result.nodes.map((node) => node.key)).toEqual([a, b, c]);
    expect(result.byId.get(a)?.parent).toBeNull();
    expect(result.byId.get(b)?.parent).toBe(a);
    expect(result.byId.get(c)?.parent).toBeNull();
    expect(rows).toEqual(saved);
    expect(chartLayout(rows, parent, new Set([a]), 84).nodes.map((node) => node.key)).toEqual([a, c]);
  });
  it('lays out a five thousand record chain without recursion and culls cards and edges', () => {
    const ids = Array.from({ length: 5000 }, () => newId('record'));
    const rows = ids.map((id, index) => record(id, index ? [ids[index - 1]!] : []));
    const result = chartLayout(rows, parent, new Set(), 84);
    expect(result.nodes).toHaveLength(5000);
    expect(result.width).toBe(CARD_WIDTH);
    const drawn = visibleChart(result, { x: 0, y: -148000, zoom: 1 }, { width: 800, height: 600 });
    expect(drawn.nodes.length).toBeGreaterThan(0);
    expect(drawn.nodes.length).toBeLessThan(7);
    expect(drawn.edges.length).toBeLessThan(7);
    const fit = fitChart(result, { width: 800, height: 600 });
    expect(Number.isFinite(fit.x)).toBe(true);
  });
  it('centers parents over children and draws connectors crossing the viewport', () => {
    const ids = Array.from({ length: 3 }, () => newId('record'));
    const result = chartLayout(
      [record(ids[0]!), record(ids[1]!, [ids[0]!]), record(ids[2]!, [ids[0]!])],
      parent,
      new Set(),
      84,
    );
    expect(result.nodes[0]!.x).toBe((result.nodes[1]!.x + result.nodes[2]!.x) / 2);
    const drawn = visibleChart(result, { x: 0, y: -85, zoom: 1 }, { width: 800, height: 60 });
    expect(drawn.nodes).toHaveLength(0);
    expect(drawn.edges.map((edge) => edge.key.split(':')[1]).sort()).toEqual(['bus', 'drop', 'drop', 'stub']);
  });
  it('ignores malformed or foreign view locations and bounds camera values', () => {
    expect(readChartLocation('?org=broken', 'view').zoom).toBe(1);
    expect(
      readChartLocation(
        `?${new URLSearchParams({ org: JSON.stringify({ view: 'other', zoom: 2 }) })}`,
        'view',
      ).zoom,
    ).toBe(1);
    expect(
      readChartLocation(
        `?${new URLSearchParams({ org: JSON.stringify({ view: 'view', zoom: 100, x: 1e20 }) })}`,
        'view',
      ),
    ).toMatchObject({ zoom: 2, x: 1e8 });
  });
});

async function mount(
  options: {
    count?: number;
    role?: DatabaseRole;
    readOnly?: boolean;
    restricted?: boolean;
    locked?: number;
    parents?: Array<number | null>;
    address?: string;
    showDetails?: boolean;
  } = {},
) {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  const server = new FakeServer();
  const fixture = server.createDatabase(0);
  const schema = server.database(fixture.databaseId).schema;
  const link = FieldMeta.parse({
    ...schema.fields[0],
    id: newId('field'),
    name: 'Parent',
    type: 'link',
    options: { linkedTableId: fixture.tableId },
    position: 2,
  });
  const prefix = fixture.tableId.slice(3, 10);
  const id = (index: number) => `rec${prefix}${index.toString(36).padStart(7, '0')}`;
  server.seed(
    {
      ...schema,
      fields: [...schema.fields, link],
      views: [
        {
          ...schema.views[0]!,
          name: 'Team',
          type: 'orgChart',
          config: GridConfig.parse({
            orgChart: { parentFieldId: link.id },
            hiddenFieldIds: options.showDetails ? [link.id] : [fixture.numberFieldId, link.id],
          }),
        },
      ],
    },
    new Map([
      [
        fixture.tableId,
        {
          count: options.count ?? 3,
          values: (index: number) => ({
            [fixture.textFieldId]: `Person ${index + 1}`,
            [fixture.numberFieldId]: index,
            [link.id]: options.parents
              ? options.parents[index] == null
                ? []
                : [id(options.parents[index]!)]
              : index === 1
                ? [id(0)]
                : [],
          }),
        },
      ],
    ]),
  );
  const session = await openDatabase(fixture.databaseId, server.deps());
  sessions.push(session);
  if (options.role) vi.spyOn(session, 'role').mockReturnValue(options.role);
  if (options.restricted) {
    const current = session.getSchema();
    vi.spyOn(session, 'getSchema').mockReturnValue({
      ...current,
      access: {
        ...current.access,
        fields: new Map([[link.id, { fieldId: link.id, editable: false, restricted: false, locked: true }]]),
      },
    });
  }
  if (options.locked !== undefined) {
    const cached = session.cachedRecord.bind(session);
    vi.spyOn(session, 'cachedRecord').mockImplementation((table, recordId) => {
      const row = cached(table, recordId);
      return row && recordId === id(options.locked!)
        ? { ...row, lock: { manual: true, reason: '', canEdit: false } }
        : row;
    });
  }
  if (options.address) window.history.replaceState({}, '', options.address);
  else window.history.replaceState({}, '', `/${fixture.databaseId}/${fixture.tableId}/${fixture.viewId}`);
  const onExpand = vi.fn();
  const run = vi.spyOn(session, 'run');
  function Harness() {
    const current = useSchema(session)!;
    return (
      <OrgChartView
        session={session}
        table={current.tableById.get(fixture.tableId)!}
        view={current.viewById.get(fixture.viewId)!}
        fields={current.fields.get(fixture.tableId)!}
        format={{ locale: 'en-US', timeZone: 'UTC', collaborators: new Map() }}
        canEdit={true}
        readOnly={options.readOnly}
        onExpand={onExpand}
        onConfig={() => {}}
      />
    );
  }
  render(
    <I18nProvider i18n={i18n}>
      <Harness />
    </I18nProvider>,
  );
  await screen.findByRole('treeitem', { name: /^Person 1(?: |$)/ });
  return { server, session, run, onExpand, fixture, link, id };
}

it('navigates, collapses, searches hidden descendants, opens records, and preserves the address', async () => {
  const { onExpand, id } = await mount();
  const first = screen.getByRole('treeitem', { name: 'Person 1' });
  fireEvent.keyDown(first, { key: 'ArrowLeft' });
  expect(screen.queryByRole('treeitem', { name: 'Person 2' })).toBeNull();
  expect(first.getAttribute('aria-expanded')).toBe('false');
  const search = screen.getByRole('searchbox', { name: 'Find a record' });
  fireEvent.change(search, { target: { value: 'Person 2' } });
  search.focus();
  const submitted = fireEvent.keyDown(search, { key: 'Enter', cancelable: true });
  expect(submitted).toBe(false);
  const child = screen.getByRole('treeitem', { name: 'Person 2' });
  expect(child.getAttribute('aria-level')).toBe('2');
  expect(document.activeElement).toBe(search);
  fireEvent.keyDown(search, { key: 'Enter' });
  expect(onExpand).not.toHaveBeenCalled();
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(child);
  await waitFor(() => expect(window.location.search).toContain('org='));
  fireEvent.keyDown(child, { key: 'Enter' });
  expect(onExpand).toHaveBeenCalledWith(id(1));
});

it('reparents through one undoable command and refuses cycles', async () => {
  const { run, session, fixture, link, id } = await mount();
  const first = screen.getByRole('treeitem', { name: 'Person 1' });
  fireEvent.keyDown(first, { key: 'ArrowDown' });
  const child = screen.getByRole('treeitem', { name: 'Person 2' });
  fireEvent.keyDown(child, { key: 'ArrowLeft', altKey: true });
  expect(run).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]![0]).toEqual([
    {
      kind: 'record.update',
      tableId: fixture.tableId,
      records: [{ id: id(1), values: { [link.id]: null } }],
    },
  ]);
  await act(async () => {
    await run.mock.results[0]!.value.done;
  });
  const undo = vi.spyOn(session, 'undo');
  fireEvent.keyDown(child, { key: 'z', ctrlKey: true });
  await act(async () => {
    await undo.mock.results[0]!.value;
  });
  await waitFor(() => expect(session.cachedRecord(fixture.tableId, id(1))?.values[link.id]).toEqual([id(0)]));
  run.mockClear();
  fireEvent.keyDown(child, { key: 'ArrowUp' });
  fireEvent.keyDown(first, { key: 'ArrowRight', altKey: true });
  expect(run).not.toHaveBeenCalled();
});

it('refuses dropping a parent onto its descendant and rechecks record locks at drop', async () => {
  const { run, session, fixture, id } = await mount();
  const first = screen.getByRole('treeitem', { name: 'Person 1' });
  const child = screen.getByRole('treeitem', { name: 'Person 2' });
  const hit = vi.spyOn(document, 'elementFromPoint').mockReturnValue(child);
  fireEvent.pointerDown(first, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 100 });
  expect(run).not.toHaveBeenCalled();
  const other = screen.getByRole('treeitem', { name: 'Person 3' });
  hit.mockReturnValue(other);
  fireEvent.pointerDown(child, { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(window, { pointerId: 2, clientX: 100, clientY: 100 });
  const row = session.cachedRecord(fixture.tableId, id(1))!;
  vi.spyOn(session, 'cachedRecord').mockImplementation((_table, recordId) =>
    recordId === id(1) ? { ...row, lock: { manual: true, reason: '', canEdit: false } } : undefined,
  );
  fireEvent.pointerUp(window, { pointerId: 2, clientX: 100, clientY: 100 });
  expect(run).not.toHaveBeenCalled();
});

it.each([{ role: 'reader' as const }, { readOnly: true }, { restricted: true }])(
  'keeps reading views free of mutation controls and commands',
  async (options) => {
    const { run } = await mount(options);
    const first = screen.getByRole('treeitem', { name: 'Person 1' });
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('treeitem', { name: 'Person 2' }), { key: 'ArrowLeft', altKey: true });
    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Move to top level' })).toBeNull();
  },
);

it('renders only the viewport of a large chart', async () => {
  await mount({ count: 3000 });
  expect(screen.getAllByRole('treeitem').length).toBeLessThan(20);
  expect(cardHeight(3)).toBe(132);
});

const cameraTransform = () => screen.getByRole('tree').querySelector('g')!.getAttribute('transform');

it('opens a clicked card without moving the camera between clicks', async () => {
  const { onExpand, id } = await mount();
  const card = screen.getByRole('treeitem', { name: 'Person 3' });
  const before = cameraTransform();
  fireEvent.click(card);
  expect(cameraTransform()).toBe(before);
  fireEvent.doubleClick(card);
  expect(onExpand).toHaveBeenCalledWith(id(2));
});

it('pans with ordinary wheel deltas and zooms proportionally only with a modifier', async () => {
  await mount();
  const tree = screen.getByRole('tree');
  const before = cameraTransform();
  expect(fireEvent.wheel(tree, { deltaX: 40, deltaY: 0, cancelable: true })).toBe(false);
  expect(cameraTransform()).not.toBe(before);
  expect(cameraTransform()).toContain('scale(1)');
  const pinch = new WheelEvent('wheel', { deltaY: 50, bubbles: true, cancelable: true });
  Object.defineProperties(pinch, {
    ctrlKey: { value: true },
    clientX: { value: 100 },
    clientY: { value: 100 },
  });
  fireEvent(tree, pinch);
  expect(cameraTransform()).toContain(`scale(${Math.exp(-0.1)})`);
});

it.each([true, false])('pans from cards on touch before a long press', async (readOnly) => {
  const { run } = await mount({ readOnly });
  const card = screen.getByRole('treeitem', { name: 'Person 1' });
  const before = cameraTransform();
  fireEvent.pointerDown(card, { pointerType: 'touch', pointerId: 7, button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(window, { pointerType: 'touch', pointerId: 7, clientX: 140, clientY: 140 });
  fireEvent.pointerUp(window, { pointerType: 'touch', pointerId: 7, clientX: 140, clientY: 140 });
  expect(cameraTransform()).not.toBe(before);
  expect(run).not.toHaveBeenCalled();
});

it('keeps a held pan and card drag out of the address even when movement pauses', async () => {
  await mount();
  await waitFor(() => expect(window.location.search).toContain('org='));
  vi.useFakeTimers();
  const replace = vi.spyOn(window.history, 'replaceState');
  const tree = screen.getByRole('tree');
  fireEvent.pointerDown(tree, { pointerId: 4, button: 0, clientX: 20, clientY: 20 });
  fireEvent.pointerMove(window, { pointerId: 4, clientX: 50, clientY: 50 });
  act(() => vi.advanceTimersByTime(600));
  expect(replace).not.toHaveBeenCalled();
  fireEvent.pointerUp(window, { pointerId: 4 });
  act(() => vi.advanceTimersByTime(300));
  expect(replace).toHaveBeenCalledOnce();
  replace.mockClear();
  const card = screen.getByRole('treeitem', { name: 'Person 1' });
  fireEvent.click(card);
  fireEvent.pointerDown(card, { pointerId: 5, button: 0 });
  act(() => vi.advanceTimersByTime(600));
  expect(replace).not.toHaveBeenCalled();
  fireEvent.pointerUp(window, { pointerId: 5 });
  vi.useRealTimers();
});

it('uses the previous sibling for nesting and explains an absent sibling', async () => {
  const { run, link, id } = await mount({ count: 5, parents: [null, 0, 1, 2, 0] });
  const search = screen.getByRole('searchbox');
  fireEvent.change(search, { target: { value: 'Person 5' } });
  fireEvent.keyDown(search, { key: 'Enter' });
  fireEvent.keyDown(screen.getByRole('treeitem', { name: 'Person 5' }), { key: 'ArrowRight', altKey: true });
  expect(run.mock.calls[0]?.[0]).toMatchObject([
    { records: [{ id: id(4), values: { [link.id]: [id(1)] } }] },
  ]);
  fireEvent.change(search, { target: { value: 'Person 2' } });
  fireEvent.keyDown(search, { key: 'Enter' });
  fireEvent.keyDown(screen.getByRole('treeitem', { name: 'Person 2' }), { key: 'ArrowRight', altKey: true });
  expect(screen.getByRole('status').textContent).toContain('previous sibling');
});

it('announces permission refusals once a move begins, for pointer moves, keyboard moves, and undo', async () => {
  const { run } = await mount({ restricted: true });
  const card = screen.getByRole('treeitem', { name: 'Person 2' });
  // A refusal that applies to every card is said when a move begins, not on each card selected.
  expect(card.getAttribute('aria-description') ?? '').not.toContain('locked or restricted');
  // Selecting and opening a card is available, so neither says the record can't move.
  fireEvent.click(card);
  expect(screen.getByRole('status').textContent).toBe('');
  fireEvent.pointerDown(card, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
  expect(screen.getByRole('status').textContent).toBe('');
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 60, clientY: 60 });
  expect(screen.getByRole('status').textContent).toContain('locked or restricted');
  fireEvent.pointerUp(window, { pointerId: 1 });
  for (const perform of [
    () => fireEvent.keyDown(card, { key: 'ArrowLeft', altKey: true }),
    () => fireEvent.keyDown(card, { key: 'z', ctrlKey: true }),
  ]) {
    perform();
    expect(screen.getByRole('status').textContent).toContain('locked or restricted');
  }
  expect(card.getAttribute('aria-disabled')).toBeNull();
  expect(run).not.toHaveBeenCalled();
});

it('describes a locked record on its own card, and only that card', async () => {
  const { run } = await mount({ locked: 1 });
  const locked = screen.getByRole('treeitem', { name: 'Person 2' });
  expect(locked.getAttribute('aria-description')).toContain('This record is locked.');
  for (const name of ['Person 1', 'Person 3'])
    expect(screen.getByRole('treeitem', { name }).getAttribute('aria-description') ?? '').not.toContain(
      'locked',
    );
  fireEvent.click(locked);
  fireEvent.keyDown(locked, { key: 'ArrowLeft', altKey: true });
  expect(screen.getByRole('status').textContent).toContain('This record is locked.');
  expect(run).not.toHaveBeenCalled();
});

it('leaves a read-only chart free of refusals and still opens its records', async () => {
  const { run, onExpand, id } = await mount({ readOnly: true });
  const card = screen.getByRole('treeitem', { name: 'Person 2' });
  expect(card.getAttribute('aria-disabled')).toBeNull();
  expect(card.getAttribute('aria-description')).toBeNull();
  // Selecting and opening a card both work, so neither hears that the record can't move.
  fireEvent.click(card);
  fireEvent.doubleClick(card);
  expect(onExpand).toHaveBeenCalledWith(id(1));
  expect(screen.getByRole('status').textContent).toBe('');
  fireEvent.pointerDown(card, { button: 0, pointerId: 8, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(window, { pointerId: 8, clientX: 80, clientY: 80 });
  fireEvent.pointerUp(window, { pointerId: 8 });
  expect(screen.getByRole('status').textContent).toBe('');
  // Asking to move a card by keyboard still says why nothing happens.
  fireEvent.keyDown(card, { key: 'ArrowLeft', altKey: true });
  expect(screen.getByRole('status').textContent).toContain('do not have access');
  expect(run).not.toHaveBeenCalled();
});

it('explains a loop the server refuses through a record the view hides', async () => {
  const { server, run } = await mount();
  server.rejectNext('data.link.cycle');
  const child = screen.getByRole('treeitem', { name: 'Person 2' });
  fireEvent.click(child);
  fireEvent.keyDown(child, { key: 'ArrowLeft', altKey: true });
  expect(run).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Choose a different branch.'));
});

it.each(['loading', 'limited'] as const)('refuses moves with an incomplete tree', async (state) => {
  const original = recordStore.useViewRecords;
  vi.spyOn(recordStore, 'useViewRecords').mockImplementation((...args) => ({
    ...original(...args),
    [state]: true,
  }));
  const { run } = await mount();
  const card = screen.getByRole('treeitem', { name: 'Person 2' });
  expect(card.getAttribute('aria-description') ?? '').not.toContain('all records');
  fireEvent.click(card);
  expect(screen.getByRole('status').textContent).toBe('');
  fireEvent.pointerDown(card, { button: 0, pointerId: 6, clientX: 10, clientY: 10 });
  expect(screen.getByRole('status').textContent).toBe('');
  fireEvent.pointerMove(window, { pointerId: 6, clientX: 70, clientY: 70 });
  expect(screen.getByRole('status').textContent).toContain('all records');
  fireEvent.pointerUp(window, { pointerId: 6 });
  fireEvent.keyDown(card, { key: 'ArrowLeft', altKey: true });
  expect(run).not.toHaveBeenCalled();
  expect(screen.getByRole('status').textContent).toContain('all records');
});

it('keeps descendants attached when opening an existing cycle and skips identical writes', async () => {
  const { run } = await mount({ parents: [1, 2, 1] });
  expect(screen.getByRole('treeitem', { name: 'Person 1' }).getAttribute('aria-level')).toBe('2');
  const a = newId('record'),
    b = newId('record'),
    c = newId('record');
  const result = chartLayout([record(a, [b]), record(b, [c]), record(c, [b])], parent, new Set(), 84);
  expect(result.byId.get(a)?.parent).toBe(b);
  expect(result.byId.get(b)?.parent).toBeNull();
  const card = screen.getByRole('treeitem', { name: 'Person 1' });
  const target = screen.getByRole('treeitem', { name: 'Person 2' });
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);
  fireEvent.pointerDown(card, { button: 0, pointerId: 1 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerUp(window, { pointerId: 1, clientX: 100, clientY: 100 });
  expect(run).not.toHaveBeenCalled();
  expect(screen.getByRole('status').textContent).not.toContain('Parent changed');
});

it('centers the root when a stored chart location is rejected', async () => {
  await mount({ address: `/?${new URLSearchParams({ org: JSON.stringify({ view: 'foreign' }) })}` });
  await waitFor(() => expect(cameraTransform()).not.toContain('translate(24 24)'));
});

it('draws overview rectangles without text and avoids formatting cards again during a pan', async () => {
  await mount({ count: 3000 });
  const format = vi.spyOn(formatting, 'formatCell');
  const tree = screen.getByRole('tree');
  fireEvent.wheel(tree, { deltaX: 1, deltaY: 0 });
  expect(format).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Fit chart' }));
  expect(tree.querySelectorAll('text, svg, circle')).toHaveLength(0);
  expect(tree.querySelectorAll('rect')).toHaveLength(3000);
});

it('culls separate connector segments for a wide tree and its print tiles', () => {
  const root = newId('record');
  const layout = chartLayout(
    [record(root), ...Array.from({ length: 3000 }, () => record(newId('record'), [root]))],
    parent,
    new Set(),
    84,
  );
  let total = 0;
  for (let x = 0; x < layout.width; x += 800) {
    const drawn = visibleChart(layout, { x: -x, y: 0, zoom: 1 }, { width: 800, height: 600 });
    expect(drawn.edges.length).toBeLessThan(10);
    total += drawn.edges.length;
  }
  expect(total).toBeLessThan(6000);
});

it('saves collapse all and individual exceptions compactly for hundreds of managers', async () => {
  const { fixture, id } = await mount({
    count: 1500,
    parents: Array.from({ length: 1500 }, (_, index) => (index % 3 ? index - (index % 3) : null)),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
  await waitFor(() =>
    expect(readChartLocation(window.location.search, fixture.viewId).allCollapsed).toBe(true),
  );
  expect(readChartLocation(window.location.search, fixture.viewId).collapsed).toEqual([]);
  expect(window.location.href.length).toBeLessThan(6000);
  fireEvent.click(screen.getByRole('button', { name: 'Expand branch' }));
  await waitFor(() =>
    expect(readChartLocation(window.location.search, fixture.viewId).collapsed).toEqual([id(0)]),
  );
  expect(screen.getByRole('treeitem', { name: 'Person 2' }).getAttribute('aria-level')).toBe('2');
});

it('allows a read-only mouse drag to pan from a card', async () => {
  await mount({ readOnly: true });
  const before = cameraTransform();
  fireEvent.pointerDown(screen.getByRole('treeitem', { name: 'Person 1' }), {
    pointerId: 3,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: 10,
    clientY: 10,
  });
  fireEvent.pointerMove(window, { pointerId: 3, pointerType: 'mouse', buttons: 1, clientX: 60, clientY: 60 });
  fireEvent.pointerUp(window, { pointerId: 3 });
  expect(cameraTransform()).not.toBe(before);
});

it('opens a new parent when moving a collapsed branch under a leaf', async () => {
  const { run } = await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
  const first = screen.getByRole('treeitem', { name: 'Person 1' });
  const target = screen.getByRole('treeitem', { name: 'Person 3' });
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);
  fireEvent.pointerDown(first, { pointerId: 10, button: 0 });
  fireEvent.pointerMove(window, { pointerId: 10, clientX: 100, clientY: 100 });
  fireEvent.pointerUp(window, { pointerId: 10, clientX: 100, clientY: 100 });
  expect(run).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(screen.getByRole('treeitem', { name: 'Person 1' }).getAttribute('aria-level')).toBe('2'),
  );
  expect(screen.getByRole('treeitem', { name: 'Person 3' }).getAttribute('aria-expanded')).toBe('true');
});

it('includes the visible field details in each chart card name', async () => {
  await mount({ count: 1, showDetails: true });
  const card = screen.getByRole('treeitem', { name: 'Person 1 Number: 0' });
  expect(card.textContent?.trim()).toBe('Person 1 Number: 0');
});
