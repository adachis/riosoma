import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGrid } from './grid.js';
import { createRenderer } from './render.js';
import type { RenderFrame } from './render.js';
import { createSelectionState } from './selection.js';
import type { GridHost, GridOptions } from './types.js';

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

function host(): GridHost<string> {
  return {
    getRow: (index) => `row-${index}`,
    ensureRows: vi.fn(),
    renderCell: vi.fn((el, context) => {
      el.textContent = context.row;
    }),
    renderHeader: vi.fn((el, column) => {
      el.textContent = column.id;
    }),
    renderRowHeader: vi.fn(),
    renderFooter: vi.fn((el, column) => {
      el.textContent = `test.footer.${column.id}`;
    }),
    describeFooter: vi.fn((col: number) => `test.footer.label.${col}`),
    onFooterActivate: vi.fn(),
    onUndo: vi.fn(),
    editText: () => '',
    commitText: () => null,
  };
}

describe('drawing the footer row', () => {
  function fixture(showFooter = true) {
    const header = document.createElement('div');
    const viewport = document.createElement('div');
    const footer = document.createElement('div');
    const selection = createSelectionState(() => renderer.invalidate());
    const renderer = createRenderer<string>(header, viewport, selection, footer);
    const frame: RenderFrame<string> = {
      options: {
        host: host(),
        columns: [
          { id: 'a', width: 100, edit: 'none' },
          { id: 'b', width: 100, edit: 'none', align: 'end' },
          { id: 'c', width: 100, edit: 'none' },
        ],
        rowCount: 12,
        rowHeight: 32,
        frozenColumnCount: 1,
        label: 'test.grid',
        showFooter,
      },
      width: 364,
      height: 64,
      scrollX: 0,
      scrollY: 0,
      prefix: [0, 100, 200, 300],
      frozen: 1,
      rows: { start: 0, end: 2 },
      columns: { start: 1, end: 3 },
      frozenColumns: { start: 0, end: 1 },
    };
    return { footer, renderer, frame, host: frame.options.host };
  }

  it('draws a cell per column after the last record, frozen ones first, named for screen readers', () => {
    const { footer, renderer, frame, host } = fixture();
    renderer.draw(frame);
    const row = footer.querySelector('[role="row"]')!;
    expect(row.getAttribute('aria-rowindex')).toBe('14');
    const cells = [...footer.querySelectorAll<HTMLElement>('[role="gridcell"]')];
    expect(cells.map((cell) => cell.getAttribute('aria-colindex'))).toEqual(['1', '2', '3']);
    expect(cells.map((cell) => cell.textContent)).toEqual([
      'test.footer.a',
      'test.footer.b',
      'test.footer.c',
    ]);
    expect(cells.map((cell) => cell.getAttribute('aria-label'))).toEqual([
      'test.footer.label.0',
      'test.footer.label.1',
      'test.footer.label.2',
    ]);
    expect(cells[1]!.style.textAlign).toBe('end');
    expect(cells.every((cell) => cell.dataset.rioFooter !== undefined && !cell.dataset.rioColumn)).toBe(true);
    expect(renderer.footerCell(2)).toBe(cells[2]);
    expect(row.querySelector('.rio-grid__row-header')!.getAttribute('aria-hidden')).toBe('true');
    expect(host.renderFooter).toHaveBeenCalledTimes(3);
  });

  it('redraws only when told the summaries changed, and marks the cell the keyboard is on', () => {
    const { footer, renderer, frame, host } = fixture();
    renderer.draw(frame);
    renderer.draw({ ...frame, scrollY: 12 });
    expect(host.renderFooter).toHaveBeenCalledTimes(3);
    renderer.invalidateFooter();
    renderer.draw({ ...frame, footerActive: 1 });
    expect(host.renderFooter).toHaveBeenCalledTimes(6);
    const active = [...footer.querySelectorAll('[data-active]')];
    expect(active).toEqual([renderer.footerCell(1)]);
  });

  it('draws nothing when the grid has no footer', () => {
    const { footer, renderer, frame, host } = fixture(false);
    renderer.draw(frame);
    expect(footer.querySelectorAll('[role="gridcell"]')).toHaveLength(0);
    expect(host.renderFooter).not.toHaveBeenCalled();
  });
});

describe('the keyboard in the footer', () => {
  function grid(options: Partial<GridOptions<string>> = {}) {
    vi.useFakeTimers();
    const node = document.createElement('div');
    document.body.append(node);
    const gridHost = host();
    const api = createGrid(node, {
      host: gridHost,
      columns: Array.from({ length: 3 }, (_, index) => ({
        id: `col${index}`,
        width: 100,
        edit: 'inline' as const,
      })),
      rowCount: 4,
      rowHeight: 32,
      frozenColumnCount: 0,
      label: 'test.grid',
      showFooter: true,
      ...options,
    });
    const input = node.querySelector('textarea')!;
    const press = (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      input.dispatchEvent(event);
      return event;
    };
    /** What the grid last said to screen readers, once its short pause has passed */
    const spoken = () => {
      vi.advanceTimersByTime(200);
      return node.querySelector('.rio-grid__live')!.textContent;
    };
    return { api, host: gridHost, node, input, press, spoken };
  }

  it('goes down from the last row into the footer, reads each cell, and comes back up', () => {
    const { api, host, press, spoken, node } = grid();
    api.setSelection({
      active: { row: 3, col: 1 },
      range: { start: { row: 3, col: 1 }, end: { row: 3, col: 1 } },
      rows: { kind: 'none' },
    });
    expect(press('ArrowDown').defaultPrevented).toBe(true);
    expect(api.getSelection().active).toBeNull();
    expect(spoken()).toBe('test.footer.label.1');
    expect(node.querySelector('[role="grid"]')!.getAttribute('aria-rowcount')).toBe('6');
    press('ArrowRight');
    expect(spoken()).toBe('test.footer.label.2');
    press('ArrowRight');
    expect(spoken()).toBe('test.footer.label.2');
    press('Home');
    expect(spoken()).toBe('test.footer.label.0');
    press('Tab');
    expect(spoken()).toBe('test.footer.label.1');
    press('End');
    press('ArrowDown');
    expect(spoken()).toBe('test.footer.label.2');
    press('ArrowUp');
    expect(api.getSelection().active).toEqual({ row: 3, col: 2 });
    expect(host.describeFooter).toHaveBeenLastCalledWith(2);
  });

  it('opens a footer cell with Enter, Space, or the menu key, and never starts editing a cell', () => {
    const { api, host, press, input } = grid();
    api.setSelection({
      active: { row: 3, col: 0 },
      range: { start: { row: 3, col: 0 }, end: { row: 3, col: 0 } },
      rows: { kind: 'none' },
    });
    press('ArrowDown');
    press('Enter');
    press(' ');
    press('ContextMenu');
    expect(host.onFooterActivate).toHaveBeenCalledTimes(3);
    expect(host.onFooterActivate).toHaveBeenLastCalledWith(0, expect.any(HTMLElement));
    expect(press('x').defaultPrevented).toBe(true);
    expect(api.isEditing()).toBe(false);
    expect(input.readOnly).toBe(true);
    // Undo still works from here.
    press('z', { ctrlKey: true });
    expect(host.onUndo).toHaveBeenCalledTimes(1);
    press('Escape');
    expect(api.getSelection().active).toEqual({ row: 3, col: 0 });
  });

  it('keeps its place when the grid gets the focus back, and leaves when a cell is chosen', () => {
    const { api, press, spoken } = grid();
    api.setSelection({
      active: { row: 3, col: 2 },
      range: { start: { row: 3, col: 2 }, end: { row: 3, col: 2 } },
      rows: { kind: 'none' },
    });
    press('ArrowDown');
    api.focus();
    expect(api.getSelection().active).toBeNull();
    expect(spoken()).toBe('test.footer.label.2');
    api.setSelection({
      active: { row: 1, col: 1 },
      range: { start: { row: 1, col: 1 }, end: { row: 1, col: 1 } },
      rows: { kind: 'none' },
    });
    press('ArrowDown');
    expect(api.getSelection().active).toEqual({ row: 2, col: 1 });
  });

  it('opens a footer cell that was clicked', () => {
    const { host, node } = grid();
    // Nothing is laid out in this test's document, so a cell stands in for the one the grid draws.
    const cell = document.createElement('div');
    cell.dataset.rioFooter = '1';
    node.querySelector('.rio-grid__footer')!.append(cell);
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(host.onFooterActivate).toHaveBeenCalledWith(1, expect.any(HTMLElement));
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(host.onFooterActivate).toHaveBeenCalledTimes(2);
  });

  it('reaches the footer of an empty grid, and stays in the rows when there is no footer', () => {
    const empty = grid({ rowCount: 0 });
    empty.api.focus();
    empty.press('ArrowDown');
    expect(empty.spoken()).toBe('test.footer.label.0');
    empty.api.destroy();
    const plain = grid({ showFooter: false });
    plain.api.setSelection({
      active: { row: 3, col: 0 },
      range: { start: { row: 3, col: 0 }, end: { row: 3, col: 0 } },
      rows: { kind: 'none' },
    });
    plain.press('ArrowDown');
    expect(plain.api.getSelection().active).toEqual({ row: 3, col: 0 });
    expect(plain.node.querySelector<HTMLElement>('.rio-grid__footer')!.hidden).toBe(true);
  });
});
