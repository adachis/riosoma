import { afterEach, expect, it, vi } from 'vitest';
import { createGrid } from './grid.js';
import type { GridHost } from './types.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});
function fixture(pins = 2) {
  vi.useFakeTimers();
  let resize = () => {};
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const node = document.createElement('div');
  document.body.append(node);
  const heightRead = vi.fn(() => 432);
  Object.defineProperty(node, 'clientHeight', { get: heightRead });
  const host: GridHost<string> = {
    frozenRows: () => pins,
    getRow: (index) => String(index),
    ensureRows: vi.fn(),
    renderCell: (el, context) => {
      el.textContent = context.row;
    },
    renderHeader: (el, column) => {
      el.textContent = column.id;
    },
    renderRowHeader: vi.fn(),
    editText: () => 'test.value',
    commitText: () => 'test.invalid',
    fill: vi.fn(),
  };
  const api = createGrid(node, {
    host,
    label: 'test.grid',
    rowCount: 1000,
    rowHeight: 32,
    frozenColumnCount: 1,
    columns: Array.from({ length: 10 }, (_, index) => ({ id: String(index), width: 100, edit: 'inline' })),
  });
  cleanup.push(api.destroy);
  const scroller = node.querySelector<HTMLElement>('.rio-grid__scroller')!;
  Object.defineProperties(scroller, {
    clientWidth: { value: 600, configurable: true },
    clientHeight: { value: 336 },
  });
  const viewport = node.querySelector<HTMLElement>('.rio-grid__viewport')!;
  viewport.getBoundingClientRect = () => new DOMRect(0, 96, 600, 336);
  const pinned = node.querySelector<HTMLElement>('.rio-grid__pinned')!;
  pinned.getBoundingClientRect = () => new DOMRect(0, 32, 600, 64);
  const header = node.querySelector<HTMLElement>('.rio-grid__header')!;
  header.getBoundingClientRect = () => new DOMRect(0, 0, 600, 32);
  node.setPointerCapture = vi.fn();
  node.hasPointerCapture = () => false;
  resize();
  vi.advanceTimersByTime(100);
  const frame = () => vi.advanceTimersByTime(20);
  return { node, api, host, scroller, heightRead, frame, resize };
}

for (const direction of ['ltr', 'rtl'] as const) {
  it.each(['scroll-first', 'resize-first', 'undelivered'] as const)(
    `preserves scrolling to the last field through a phone resize in ${direction} with %s delivery`,
    (delivery) => {
      const { node, api, scroller, frame, resize } = fixture(0);
      api.update({
        columns: [
          { id: 'name', width: 180, edit: 'inline' },
          { id: 'contact', width: 180, edit: 'inline' },
        ],
        showAddColumn: true,
        direction,
      });
      frame();
      Object.defineProperty(scroller, 'clientWidth', { value: 300, configurable: true });
      const end = direction === 'rtl' ? -164 : 164;
      scroller.scrollLeft = end;
      // Native scrolling and resize delivery can arrive in either order, on different frames.
      if (delivery === 'scroll-first') {
        scroller.dispatchEvent(new Event('scroll'));
        frame();
      }
      resize();
      if (delivery === 'resize-first') scroller.dispatchEvent(new Event('scroll'));
      frame();
      expect(scroller.scrollLeft).toBe(end);
      expect(node.querySelector<HTMLElement>('.rio-grid__header-actions')!.hidden).toBe(false);
    },
  );
}

it('keeps an empty horizontal scroller reachable by keyboard as rows change', () => {
  const { api, scroller, frame } = fixture(0);
  api.update({ rowCount: 0 });
  frame();
  expect(scroller.tabIndex).toBe(0);
  scroller.focus();
  expect(document.activeElement).toBe(scroller);
  api.update({ rowCount: 1 });
  frame();
  expect(scroller.tabIndex).toBe(-1);
});

it('places pinned editors, errors, and fill handles inside the pinned pane', () => {
  const { node, api, frame } = fixture();
  const cell = { row: 0, col: 1 };
  api.setSelection({ active: cell, range: { start: cell, end: cell }, rows: { kind: 'none' } });
  frame();
  const layer = node.querySelector<HTMLElement>('.rio-grid__editors')!;
  const input = node.querySelector<HTMLTextAreaElement>('textarea')!;
  expect(layer.style.insetBlockStart).toBe('32px');
  expect(
    Number.parseFloat(node.querySelector<HTMLElement>('.rio-grid__fill-handle')!.style.insetBlockStart),
  ).toBe(32);
  api.startEditing(cell);
  frame();
  expect(input.style.insetBlockStart).toBe('0px');
  input.value = 'test.changed';
  api.stopEditing(true);
  expect(node.querySelector<HTMLElement>('.rio-grid__error')!.hidden).toBe(false);
  expect(
    Number.parseFloat(node.querySelector<HTMLElement>('.rio-grid__error')!.style.insetBlockStart),
  ).toBeGreaterThanOrEqual(0);
});

it('retains touch selection focus through the compatibility mouse press without blocking scrolling', () => {
  const { node } = fixture();
  const cell = node.querySelector<HTMLElement>('[role="gridcell"][data-rio-row="0"][data-rio-col="0"]')!;
  const input = node.querySelector<HTMLTextAreaElement>('textarea')!;
  const outside = document.createElement('main');
  outside.tabIndex = -1;
  document.body.append(outside);
  const down = new PointerEvent('pointerdown', {
    pointerId: 4,
    pointerType: 'touch',
    button: 0,
    bubbles: true,
    cancelable: true,
  });
  cell.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(false);
  cell.dispatchEvent(new PointerEvent('pointerup', { pointerId: 4, pointerType: 'touch', bubbles: true }));
  expect(document.activeElement).toBe(input);
  const mouse = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true });
  // A native compatibility press focuses the nearest focusable ancestor unless canceled.
  if (cell.dispatchEvent(mouse)) outside.focus();
  expect(document.activeElement).toBe(input);
});

it('keeps data arrivals out of geometry reads and native scroll writes and debounces pins', () => {
  const { api, host, scroller, heightRead, frame } = fixture();
  vi.mocked(host.ensureRows).mockClear();
  heightRead.mockClear();
  scroller.scrollTop = 300;
  scroller.dispatchEvent(new Event('scroll'));
  const writeScroll = vi.spyOn(scroller, 'scrollTop', 'set');
  for (let count = 0; count < 4; count++) {
    api.rowsChanged();
    frame();
  }
  expect(heightRead).not.toHaveBeenCalled();
  expect(writeScroll).not.toHaveBeenCalled();
  expect(
    vi.mocked(host.ensureRows).mock.calls.filter(([start, end]) => start === 0 && end === 2).length,
  ).toBeLessThanOrEqual(1);
  writeScroll.mockClear();
  api.update({ rowCount: 1000 });
  frame();
  expect(writeScroll).not.toHaveBeenCalled();
});

it('keeps the fill handle beside its pinned cell when the pinned pane scrolls', () => {
  const { node, api, frame } = fixture(10);
  const cell = { row: 3, col: 1 };
  api.setSelection({ active: cell, range: { start: cell, end: cell }, rows: { kind: 'none' } });
  frame();
  const handle = node.querySelector<HTMLElement>('.rio-grid__fill-handle')!;
  expect(handle.style.insetBlockStart).toBe('128px');
  const pinned = node.querySelector<HTMLElement>('.rio-grid__pinned')!;
  pinned.scrollTop = 32;
  pinned.dispatchEvent(new Event('scroll'));
  expect(handle.style.insetBlockStart).toBe('96px');
});

it('keeps a scrolled-off pinned cell out of the scrolling rows', () => {
  const { node, api, frame } = fixture(10);
  const cell = { row: 9, col: 1 };
  api.setSelection({ active: cell, range: { start: cell, end: cell }, rows: { kind: 'none' } });
  frame();
  const handle = node.querySelector<HTMLElement>('.rio-grid__fill-handle')!;
  const clip = node.querySelector<HTMLElement>('.rio-grid__editor-clip')!;
  const input = node.querySelector<HTMLTextAreaElement>('textarea')!;
  const error = node.querySelector<HTMLElement>('.rio-grid__error')!;
  // The pane shows 160 of the 320 pixels ten pins need, and the cell sits at its bottom edge, so
  // what hangs off it stays unclipped the way it does for any other cell.
  expect(handle.hidden).toBe(false);
  expect(Number.parseFloat(handle.style.insetBlockStart)).toBe(160);
  expect(clip.style.clipPath).toBe('inset(0px)');
  const pinned = node.querySelector<HTMLElement>('.rio-grid__pinned')!;
  // Scrolled by hand so the pane's bottom edge cuts the cell, its sink stays inside the pane rather
  // than drawing over the first scrolling row.
  pinned.scrollTop = 150;
  pinned.dispatchEvent(new Event('scroll'));
  expect(Number.parseFloat(input.style.insetBlockStart)).toBe(138);
  expect(handle.hidden).toBe(true);
  expect(clip.style.clipPath).toBe('inset(0px 0px 336px 0px)');
  const scrollAway = () => {
    pinned.scrollTop = 0;
    pinned.dispatchEvent(new Event('scroll'));
  };
  scrollAway();
  // Scrolled out of the pane below, nothing of the cell covers the scrolling rows: the handle is
  // gone, and the pane's box clips the sink.
  expect(handle.hidden).toBe(true);
  expect(Number.parseFloat(input.style.insetBlockStart)).toBe(288);
  api.startEditing(cell);
  frame();
  input.value = 'test.changed';
  api.stopEditing(true);
  expect(error.hidden).toBe(false);
  scrollAway();
  expect(Number.parseFloat(error.style.insetBlockStart)).toBe(320);
  expect(clip.style.clipPath).toBe('inset(0px 0px 336px 0px)');
});

it('hides a pinned fill handle and outline the pane has scrolled out of sight', () => {
  const { node, api, frame } = fixture(10);
  const cell = { row: 9, col: 1 };
  api.setSelection({ active: cell, range: { start: cell, end: cell }, rows: { kind: 'none' } });
  frame();
  const handle = node.querySelector<HTMLElement>('.rio-grid__fill-handle')!;
  handle.setPointerCapture = vi.fn();
  handle.hasPointerCapture = () => false;
  const pointer = (type: string, y: number) =>
    handle.dispatchEvent(
      new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: 170, clientY: y }),
    );
  pointer('pointerdown', 150);
  pointer('pointermove', 120);
  frame();
  const outline = node.querySelector<HTMLElement>('.rio-grid__fill-outline')!;
  expect(outline.hidden).toBe(false);
  const pinned = node.querySelector<HTMLElement>('.rio-grid__pinned')!;
  pinned.scrollTop = 0;
  pinned.dispatchEvent(new Event('scroll'));
  // The block the drag outlines has left the pane, so neither it nor the handle covers the rows.
  expect(outline.hidden).toBe(true);
  expect(handle.hidden).toBe(true);
  pointer('pointerup', 120);
});

it('cancels a column drag released outside the header band and says so', () => {
  const { node, host, frame } = fixture(0);
  host.onColumnMove = vi.fn();
  host.dragMessage = (state, kind, index) => `test.${state}.${kind}.${index}`;
  const source = node.querySelector<HTMLElement>('[data-rio-column="1"]')!;
  source.setPointerCapture = vi.fn();
  source.hasPointerCapture = () => false;
  const pointer = (type: string, x: number, y: number) =>
    source.dispatchEvent(
      new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y }),
    );
  const hint = node.querySelector<HTMLElement>('.rio-grid__drag-hint')!;
  pointer('pointerdown', 150, 16);
  pointer('pointermove', 350, 16);
  frame();
  expect(node.querySelector<HTMLElement>('.rio-grid__drop-indicator')!.hidden).toBe(false);
  pointer('pointermove', 350, 300);
  frame();
  expect(hint.hidden).toBe(false);
  expect(hint.textContent).toBe('test.outside.column.1');
  expect(node.querySelector<HTMLElement>('.rio-grid__live')!.textContent).toBe('test.outside.column.1');
  expect(node.querySelector<HTMLElement>('.rio-grid__drop-indicator')!.hidden).toBe(true);
  pointer('pointerup', 350, 300);
  expect(host.onColumnMove).not.toHaveBeenCalled();
  expect(node.querySelector<HTMLElement>('.rio-grid__live')!.textContent).toBe('test.cancel.column.2');
});

it('cancels a record drag released outside the rows and previews a target again inside them', () => {
  const { node, api, host, frame } = fixture(0);
  host.onRowMove = vi.fn();
  host.dragMessage = (state, kind, index) => `test.${state}.${kind}.${index}`;
  host.renderRowHeader = (el) => {
    el.innerHTML = '<button data-rio-drag-row></button>';
  };
  api.rowsChanged();
  frame();
  const handle = node.querySelector<HTMLElement>('[data-rio-row="2"] [data-rio-drag-row]')!;
  handle.setPointerCapture = vi.fn();
  handle.hasPointerCapture = () => false;
  const pointer = (type: string, y: number) =>
    handle.dispatchEvent(
      new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: 170, clientY: y }),
    );
  pointer('pointerdown', 176);
  pointer('pointermove', 240);
  frame();
  pointer('pointermove', 20);
  frame();
  expect(node.querySelector<HTMLElement>('.rio-grid__drag-hint')!.textContent).toBe('test.outside.row.2');
  pointer('pointermove', 240);
  frame();
  expect(node.querySelector<HTMLElement>('.rio-grid__drag-hint')!.textContent).toBe('test.target.row.4');
  pointer('pointerup', 240);
  expect(host.onRowMove).toHaveBeenCalledExactlyOnceWith(2, 4);
});

it('shows a rightward column insertion after the target', () => {
  const { node, frame } = fixture(0);
  const source = node.querySelector<HTMLElement>('[data-rio-column="1"]')!;
  source.focus();
  source.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  frame();
  expect(node.querySelector<HTMLElement>('.rio-grid__drop-indicator')!.style.transform).toBe(
    'translateX(364px)',
  );
});

it('selects between pinned rows without scrolling the main rows', () => {
  const { node, api, scroller, frame } = fixture();
  const first = node.querySelector<HTMLElement>('[data-rio-row="0"][data-rio-col="1"]')!;
  first.dispatchEvent(
    new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: 170, clientY: 48, bubbles: true }),
  );
  node.dispatchEvent(
    new PointerEvent('pointermove', { pointerId: 1, clientX: 170, clientY: 78, bubbles: true }),
  );
  frame();
  expect(api.getSelection().range).toEqual({ start: { row: 0, col: 1 }, end: { row: 1, col: 1 } });
  expect(scroller.scrollTop).toBe(0);
  node.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
});

it('draws pinned selection without reading the pinned scroll position', () => {
  const { node, api, frame } = fixture(10);
  const pinned = node.querySelector<HTMLElement>('.rio-grid__pinned')!;
  const cell = { row: 7, col: 1 };
  api.setSelection({ active: cell, range: { start: cell, end: cell }, rows: { kind: 'none' } });
  frame();
  const read = vi.spyOn(pinned, 'scrollTop', 'get');
  api.rowsChanged();
  frame();
  expect(read).not.toHaveBeenCalled();
});

it.each(['select', 'fill', 'row'] as const)(
  'scrolls upward past pins during a %s gesture without jumping into pins',
  (kind) => {
    const { node, api, host, scroller, frame } = fixture();
    const move = vi.fn();
    host.onRowMove = move;
    host.renderRowHeader = (el) => {
      el.innerHTML = '<button data-rio-drag-row></button>';
    };
    scroller.scrollTop = 320;
    scroller.dispatchEvent(new Event('scroll'));
    api.rowsChanged();
    frame();
    const cell = { row: 14, col: 1 };
    api.setSelection({ active: cell, range: { start: cell, end: cell }, rows: { kind: 'none' } });
    frame();
    const target = node.querySelector<HTMLElement>(
      kind === 'fill'
        ? '.rio-grid__fill-handle'
        : kind === 'row'
          ? '[data-rio-row="14"] [data-rio-drag-row]'
          : '[data-rio-row="14"][data-rio-col="1"]',
    )!;
    target.setPointerCapture = vi.fn();
    target.hasPointerCapture = () => false;
    const pointer = (type: string, y: number) =>
      target.dispatchEvent(
        new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: 170, clientY: y }),
      );
    pointer('pointerdown', 176);
    pointer('pointermove', 100);
    frame();
    frame();
    expect(scroller.scrollTop).toBeLessThan(320);
    pointer('pointermove', 80);
    const before = scroller.scrollTop;
    frame();
    frame();
    expect(scroller.scrollTop).toBeLessThan(before);
    pointer('pointerup', 80);
    if (kind === 'row') expect(move.mock.calls[0]?.[1]).toBeGreaterThan(2);
    else expect(api.getSelection().range!.start.row).toBeGreaterThan(2);
  },
);

it('counts a separate group header row in the grid', () => {
  const { node, api, frame } = fixture();
  api.update({
    columns: [
      { id: 'a', width: 100, edit: 'none', group: { id: 'g', name: 'test.group', collapsed: false } },
    ],
  });
  frame();
  expect(node.querySelector('[role="grid"]')!.getAttribute('aria-rowcount')).toBe('1002');
  expect(node.querySelector('[data-rio-row="0"]')!.getAttribute('aria-rowindex')).toBe('3');
});

it('draws every row again only for option changes that change what rows show', () => {
  const { node, api, host, frame } = fixture();
  const renderCell = vi.fn(host.renderCell);
  host.renderCell = renderCell;
  frame();
  const drawn = () => {
    const count = renderCell.mock.calls.length;
    renderCell.mockClear();
    return count;
  };
  drawn();
  // The grid's name, its built-in labels, its add buttons, and its footer, plus settings that
  // match what it has, leave the rows as they are.
  api.update({
    label: 'test.renamed',
    messages: { 'grid.addRow': 'test.addRow' },
    showAddRow: true,
    showAddColumn: true,
    showFooter: true,
    rowHeight: 32,
    frozenColumnCount: 1,
  });
  frame();
  expect(drawn()).toBe(0);
  expect(node.querySelector('[role="grid"]')!.getAttribute('aria-label')).toBe('test.renamed');
  api.update({});
  frame();
  expect(drawn()).toBe(0);
  for (const change of [
    { readOnly: true },
    { rowHeight: 40 },
    { frozenColumnCount: 2 },
    { treegrid: true },
    { rowCount: 900 },
    { columns: [{ id: 'test.only', width: 100, edit: 'inline' as const }] },
  ]) {
    api.update(change);
    frame();
    expect(drawn()).toBeGreaterThan(0);
  }
});

it.each([0, 2])('shows committed text before the next animation frame with %i pinned rows', (pins) => {
  const { node, api, host, frame } = fixture(pins);
  let value = '0';
  host.getRow = (row) => (row === 0 ? value : String(row));
  host.commitText = (_cell, text) => {
    value = text;
    api.rowsChanged(0, 1);
    return null;
  };
  const paint = vi.fn(host.renderCell);
  host.renderCell = paint;
  api.startEditing({ row: 0, col: 0 });
  frame();
  paint.mockClear();
  const cell = node.querySelector<HTMLElement>('[role="gridcell"][data-rio-row="0"][data-rio-col="0"]')!;
  expect(cell.textContent).toBe('0');
  const input = node.querySelector<HTMLTextAreaElement>('textarea')!;
  input.value = 'Committed text';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(cell.textContent).toBe('Committed text');
  expect(paint.mock.calls.map(([, context]) => [context.rowIndex, context.colIndex])).toEqual([[0, 0]]);
  expect(api.isEditing()).toBe(false);
  expect(api.getSelection().active).toEqual({ row: 1, col: 0 });
  frame();
  expect(
    node.querySelector('[role="gridcell"][data-rio-row="1"][data-rio-col="0"]')!.hasAttribute('data-active'),
  ).toBe(true);
});
