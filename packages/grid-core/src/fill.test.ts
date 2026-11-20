import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCellInteraction } from './cell-interaction.js';
import type { createEditing } from './editing.js';
import { createFill, dragTarget, keyboardFill, type FillHooks } from './fill.js';
import { createGrid } from './grid.js';
import { createSelectionState } from './selection.js';
import type { CellRange, GridHost, GridOptions, GridSelection } from './types.js';

const ROW = 30;
const COLUMN = 100;
const HEADER = 64;
const range = (top: number, left: number, bottom: number, right: number): CellRange => ({
  start: { row: top, col: left },
  end: { row: bottom, col: right },
});

function fixture() {
  const layer = document.createElement('div');
  document.body.append(layer);
  let selection: GridSelection = {
    active: { row: 1, col: 1 },
    range: range(1, 1, 2, 2),
    rows: { kind: 'none' },
  };
  let editing = false;
  const host: GridHost<string> = {
    getRow: () => 'test.row',
    ensureRows: vi.fn(),
    renderCell: vi.fn(),
    renderHeader: vi.fn(),
    renderRowHeader: vi.fn(),
    editText: () => '',
    commitText: () => null,
    fill: vi.fn(),
  };
  const options: GridOptions<string> = {
    host,
    columns: Array.from({ length: 4 }, (_, index) => ({ id: `col${index}`, width: COLUMN, edit: 'inline' })),
    rowCount: 20,
    rowHeight: ROW,
    frozenColumnCount: 0,
    label: 'test.grid',
  };
  const bounds = { left: 0, top: 0, right: 500, bottom: 600, width: 500, height: 600, x: 0, y: 0 };
  const hooks: FillHooks<string> = {
    options: () => options,
    range: () => selection.range,
    active: () => selection.active,
    hit: (x, y) => ({
      row: Math.max(0, Math.min(19, Math.floor(y / ROW))),
      col: Math.max(0, Math.min(3, Math.floor((x - HEADER) / COLUMN))),
    }),
    rect: (block) => ({
      inline: HEADER + block.start.col * COLUMN,
      top: block.start.row * ROW,
      width: (block.end.col - block.start.col + 1) * COLUMN,
      height: (block.end.row - block.start.row + 1) * ROW,
    }),
    edge: () => HEADER,
    size: () => ({ width: 500, height: 600 }),
    bounds: () => ({ ...bounds, toJSON: () => bounds }) as DOMRect,
    scroll: vi.fn(),
    select: vi.fn((block: CellRange, active) => {
      selection = { active, range: block, rows: { kind: 'none' } };
    }),
    editing: () => editing,
  };
  const fill = createFill(layer, hooks);
  const handle = layer.querySelector<HTMLElement>('.rio-grid__fill-handle')!;
  const outline = layer.querySelector<HTMLElement>('.rio-grid__fill-outline')!;
  const pointer = (type: string, x: number, y: number, init: PointerEventInit = {}) =>
    handle.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 7,
        pointerType: 'mouse',
        button: 0,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  return {
    fill,
    handle,
    outline,
    host,
    hooks,
    options,
    pointer,
    select(next: GridSelection) {
      selection = next;
    },
    edit(value: boolean) {
      editing = value;
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('fill handle', () => {
  it('sits on the end corner of the selected block and hides while it can’t be used', () => {
    const f = fixture();
    f.fill.position();
    expect(f.handle.hidden).toBe(false);
    expect(f.handle.style.insetInlineStart).toBe(`${HEADER + 3 * COLUMN}px`);
    expect(f.handle.style.insetBlockStart).toBe(`${3 * ROW}px`);
    expect(f.handle.getAttribute('aria-hidden')).toBe('true');
    f.options.readOnly = true;
    f.fill.position();
    expect(f.handle.hidden).toBe(true);
    f.options.readOnly = false;
    f.edit(true);
    f.fill.position();
    expect(f.handle.hidden).toBe(true);
    f.edit(false);
    f.select({ active: { row: 1, col: 0 }, range: null, rows: { kind: 'some', rows: new Set([1]) } });
    f.fill.position();
    expect(f.handle.hidden).toBe(true);
    f.select({ active: { row: 30, col: 0 }, range: range(30, 0, 30, 0), rows: { kind: 'none' } });
    f.fill.position();
    expect(f.handle.hidden).toBe(true);
    f.select({ active: { row: 0, col: 0 }, range: range(0, 0, 0, 0), rows: { kind: 'none' } });
    delete f.options.host.fill;
    f.fill.position();
    expect(f.handle.hidden).toBe(true);
  });

  it('drags down with a live outline, fills the new cells in one request, and selects the block', () => {
    const f = fixture();
    f.fill.position();
    f.pointer('pointerdown', 364, 90);
    expect(f.outline.hidden).toBe(true);
    f.pointer('pointermove', 300, 200);
    expect(f.outline.hidden).toBe(false);
    expect(f.outline.style.insetBlockStart).toBe(`${ROW}px`);
    expect(f.outline.style.blockSize).toBe(`${6 * ROW}px`);
    expect(f.outline.style.inlineSize).toBe(`${2 * COLUMN}px`);
    f.pointer('pointerup', 300, 200);
    expect(f.outline.hidden).toBe(true);
    expect(f.host.fill).toHaveBeenCalledExactlyOnceWith({
      source: range(1, 1, 2, 2),
      target: range(3, 1, 6, 2),
      direction: 'down',
      copy: false,
    });
    expect(f.hooks.select).toHaveBeenCalledWith(range(1, 1, 6, 2), { row: 1, col: 1 });
  });

  it.each([
    ['across', 480, 70, range(1, 3, 2, 3), 'right', false],
    ['up', 250, 5, range(0, 1, 0, 2), 'up', false],
    ['back', 70, 80, range(1, 0, 2, 0), 'left', false],
    ['down, copying with Alt', 250, 140, range(3, 1, 4, 2), 'down', true],
  ] as const)('fills %s', (_, x, y, target, direction, altKey) => {
    const f = fixture();
    f.fill.position();
    f.pointer('pointerdown', 364, 90, { pointerType: altKey ? 'pen' : 'touch' });
    f.pointer('pointermove', x, y, { pointerType: altKey ? 'pen' : 'touch' });
    f.pointer('pointerup', x, y, { altKey, pointerType: altKey ? 'pen' : 'touch' });
    expect(f.host.fill).toHaveBeenCalledExactlyOnceWith({
      source: range(1, 1, 2, 2),
      target,
      direction,
      copy: altKey,
    });
  });

  it('fills nothing when the drag ends inside the block, is canceled, or Escape is pressed', () => {
    const f = fixture();
    f.fill.position();
    f.pointer('pointerdown', 364, 90);
    f.pointer('pointermove', 250, 60);
    f.pointer('pointerup', 250, 60);
    f.pointer('pointerdown', 364, 90);
    f.pointer('pointermove', 250, 400);
    f.pointer('pointercancel', 250, 400);
    f.pointer('pointerdown', 364, 90);
    f.pointer('pointermove', 250, 400);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(f.outline.hidden).toBe(true);
    f.pointer('pointerup', 250, 400);
    expect(f.host.fill).not.toHaveBeenCalled();
    expect(f.hooks.select).not.toHaveBeenCalled();
  });

  it('fills down as far as the data goes after a double click or double tap', () => {
    vi.useFakeTimers();
    const f = fixture();
    f.fill.position();
    f.pointer('pointerdown', 364, 90);
    f.pointer('pointerup', 364, 90);
    vi.advanceTimersByTime(100);
    f.pointer('pointerdown', 365, 91);
    f.pointer('pointerup', 365, 91);
    expect(f.host.fill).toHaveBeenCalledExactlyOnceWith({
      source: range(1, 1, 2, 2),
      target: null,
      direction: 'down',
      copy: false,
    });
    vi.advanceTimersByTime(1000);
    f.pointer('pointerdown', 364, 90);
    f.pointer('pointerup', 364, 90);
    expect(f.host.fill).toHaveBeenCalledTimes(1);
  });

  it('keeps the press from starting a selection in the grid underneath', () => {
    const f = fixture();
    const below = vi.fn((event: Event) => event.defaultPrevented);
    f.handle.parentElement!.addEventListener('pointerdown', (event) => below(event));
    f.fill.position();
    f.pointer('pointerdown', 364, 90);
    expect(below).not.toHaveBeenCalled();
  });
});

describe('fill ranges', () => {
  it('follows the axis the pointer went further past the block on', () => {
    const source = range(2, 2, 3, 3);
    expect(dragTarget(source, { row: 3, col: 3 })).toBeNull();
    expect(dragTarget(source, { row: 9, col: 5 })).toEqual({ direction: 'down', target: range(4, 2, 9, 3) });
    expect(dragTarget(source, { row: 4, col: 9 })).toEqual({ direction: 'right', target: range(2, 4, 3, 9) });
    expect(dragTarget(source, { row: 0, col: 1 })).toEqual({ direction: 'up', target: range(0, 2, 1, 3) });
    expect(dragTarget(source, { row: 2, col: 0 })).toEqual({ direction: 'left', target: range(2, 0, 3, 1) });
  });

  it('copies the first row or column into the rest, or the row above or column before into one', () => {
    expect(keyboardFill(range(2, 1, 5, 3), 'down')).toEqual({
      source: range(2, 1, 2, 3),
      target: range(3, 1, 5, 3),
      direction: 'down',
      copy: true,
    });
    expect(keyboardFill(range(2, 1, 2, 3), 'down')).toEqual({
      source: range(1, 1, 1, 3),
      target: range(2, 1, 2, 3),
      direction: 'down',
      copy: true,
    });
    expect(keyboardFill(range(0, 1, 0, 3), 'down')).toBeNull();
    expect(keyboardFill(range(2, 1, 5, 3), 'right')).toEqual({
      source: range(2, 1, 5, 1),
      target: range(2, 2, 5, 3),
      direction: 'right',
      copy: true,
    });
    expect(keyboardFill(range(2, 2, 5, 2), 'right')).toEqual({
      source: range(2, 1, 5, 1),
      target: range(2, 2, 5, 2),
      direction: 'right',
      copy: true,
    });
    expect(keyboardFill(range(2, 0, 5, 0), 'right')).toBeNull();
    expect(keyboardFill(null, 'down')).toBeNull();
  });
});

describe('fill and find keys in a grid', () => {
  function grid(readOnly = false) {
    const node = document.createElement('div');
    document.body.append(node);
    const host: GridHost<string> = {
      getRow: () => 'test.row',
      ensureRows: vi.fn(),
      renderCell: vi.fn(),
      renderHeader: vi.fn(),
      renderRowHeader: vi.fn(),
      editText: () => 'test.value',
      commitText: vi.fn(() => null),
      fill: vi.fn(),
      onFind: vi.fn(),
    };
    const api = createGrid(node, {
      host,
      columns: Array.from({ length: 3 }, (_, index) => ({ id: `col${index}`, width: 100, edit: 'inline' })),
      rowCount: 10,
      rowHeight: 32,
      frozenColumnCount: 0,
      label: 'test.grid',
      readOnly,
    });
    const input = node.querySelector('textarea')!;
    const press = (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      input.dispatchEvent(event);
      return event;
    };
    return { api, host, press };
  }

  it('fills down with Ctrl+D and right with Ctrl+R from the selection', () => {
    const { api, host, press } = grid();
    api.setSelection({ active: { row: 1, col: 0 }, range: range(1, 0, 4, 1), rows: { kind: 'none' } });
    expect(press('d', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(host.fill).toHaveBeenLastCalledWith({
      source: range(1, 0, 1, 1),
      target: range(2, 0, 4, 1),
      direction: 'down',
      copy: true,
    });
    press('r', { ctrlKey: true });
    expect(host.fill).toHaveBeenLastCalledWith({
      source: range(1, 0, 4, 0),
      target: range(1, 1, 4, 1),
      direction: 'right',
      copy: true,
    });
    api.destroy();
  });

  it('opens the grid’s own find and replace instead of the browser’s', () => {
    const { api, host, press } = grid();
    api.setSelection({ active: { row: 0, col: 0 }, range: range(0, 0, 0, 0), rows: { kind: 'none' } });
    expect(press('f', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(host.onFind).toHaveBeenLastCalledWith('find');
    expect(press('h', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(host.onFind).toHaveBeenLastCalledWith('replace');
    expect(press('f', { metaKey: true }).defaultPrevented).toBe(false);
    api.destroy();
  });

  it('commits an edit in progress before opening find, and stays put when the edit is refused', () => {
    const container = document.createElement('div');
    const input = document.createElement('textarea');
    container.append(input);
    document.body.append(container);
    const stop = vi.fn(() => true);
    const keyDown = vi.fn();
    const editor = {
      stop,
      keyDown,
      ownsKeys: () => true,
      isEditing: () => true,
      focus: vi.fn(),
      start: vi.fn(),
    };
    const onFind = vi.fn();
    const options: GridOptions<string> = {
      host: {
        getRow: () => 'test.row',
        ensureRows: vi.fn(),
        renderCell: vi.fn(),
        renderHeader: vi.fn(),
        renderRowHeader: vi.fn(),
        editText: () => '',
        commitText: () => null,
        onFind,
      },
      columns: [{ id: 'col0', width: 100, edit: 'inline' }],
      rowCount: 1,
      rowHeight: 32,
      frozenColumnCount: 0,
      label: 'test.grid',
    };
    const cells = createCellInteraction(
      container,
      input,
      createSelectionState(() => {}),
      editor as unknown as ReturnType<typeof createEditing<string>>,
      {
        options: () => options,
        pageRows: () => 1,
        reveal: () => null,
        hit: () => null,
        bounds: () => container.getBoundingClientRect(),
        scroll: vi.fn(),
        invalidate: vi.fn(),
      },
      true,
    );
    const press = (init: KeyboardEventInit) =>
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    press({ key: 'f', metaKey: true });
    expect(stop).toHaveBeenCalledWith(true);
    expect(onFind).toHaveBeenCalledExactlyOnceWith('find');
    stop.mockReturnValue(false);
    press({ key: 'h', metaKey: true, shiftKey: true });
    expect(onFind).toHaveBeenCalledTimes(1);
    press({ key: 'a' });
    expect(keyDown).toHaveBeenCalledTimes(1);
    cells.destroy();
  });

  it('leaves a read-only grid unfilled', () => {
    const { api, host, press } = grid(true);
    api.setSelection({ active: { row: 1, col: 0 }, range: range(1, 0, 4, 1), rows: { kind: 'none' } });
    press('d', { ctrlKey: true });
    expect(host.fill).not.toHaveBeenCalled();
    api.destroy();
  });
});
