import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGrid } from './grid.js';
import { createRenderer, element } from './render.js';
import type { RenderFrame } from './render.js';
import { createSelectionState } from './selection.js';
import type { GridHost } from './types.js';

afterEach(() => {
  document.body.replaceChildren();
});

const CELLS = ['gridcell', 'columnheader', 'rowheader'];

function host(): GridHost<string> {
  return {
    getRow: (index) => (index < 3 ? `row-${index}` : undefined),
    ensureRows: vi.fn(),
    renderCell: vi.fn((el, context) => {
      el.textContent = context.row;
    }),
    renderHeader: vi.fn((el, column) => {
      el.textContent = column.id;
    }),
    renderRowHeader: vi.fn((el, index) => {
      const select = el.ownerDocument.createElement('button');
      select.setAttribute('aria-label', `test.select.${index}`);
      el.replaceChildren(select);
    }),
    renderFooter: vi.fn((el, column) => {
      el.textContent = `test.footer.${column.id}`;
    }),
    describeFooter: (col) => `test.footer.label.${col}`,
    editText: () => '',
    commitText: () => null,
  };
}

/**
 * The elements an element owns in the accessibility tree, the way axe's `aria-required-children`
 * finds them: hidden ones drop out, and ones with no role of their own (or a presentational one)
 * pass their children up, unless they can take focus.
 */
function owned(parent: Element): Array<{ role: string | null; node: Element }> {
  const found: Array<{ role: string | null; node: Element }> = [];
  const queue = [...parent.children];
  while (queue.length) {
    const node = queue.shift()!;
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') continue;
    const role = node.getAttribute('role');
    const focusable = node.matches('button, input, textarea, select, a[href], [tabindex]');
    if ((!role || role === 'presentation' || role === 'none') && !focusable) queue.push(...node.children);
    else found.push({ role: focusable && !role ? node.tagName.toLowerCase() : role, node });
  }
  return found;
}

describe('what the grid owns', () => {
  it('owns only row groups and rows, each row owns only cells, and extra controls sit in cells', () => {
    const header = element('div', 'rio-grid__header', 'rowgroup');
    const viewport = element('div', 'rio-grid__viewport', 'rowgroup');
    const footer = element('div', 'rio-grid__footer', 'rowgroup');
    const actions = element('div', 'rio-grid__header-actions');
    const grid = element('div', 'rio-grid__table', 'grid');
    grid.append(header, viewport, footer);
    const selection = createSelectionState(() => renderer.invalidate());
    const renderer = createRenderer<string>(header, viewport, selection, footer, actions);
    const frame: RenderFrame<string> = {
      options: {
        host: host(),
        columns: [
          { id: 'a', width: 100, edit: 'none' },
          { id: 'b', width: 100, edit: 'none' },
        ],
        rowCount: 3,
        rowHeight: 32,
        frozenColumnCount: 1,
        label: 'test.grid',
        showAddRow: true,
        showAddColumn: true,
        showFooter: true,
      },
      width: 264,
      height: 200,
      scrollX: 0,
      scrollY: 0,
      prefix: [0, 100, 200],
      frozen: 1,
      rows: { start: 0, end: 4 },
      columns: { start: 1, end: 2 },
      frozenColumns: { start: 0, end: 1 },
    };
    renderer.draw(frame);
    // Scrolled back, a recycled row is drawn again at another index.
    renderer.draw({ ...frame, scrollY: 32, rows: { start: 1, end: 4 } });
    renderer.draw(frame);

    expect(owned(grid).map(({ role }) => role)).toEqual(['rowgroup', 'rowgroup', 'rowgroup']);
    const rows = owned(grid).flatMap(({ node }) => owned(node));
    expect(rows.every(({ role }) => role === 'row')).toBe(true);
    // The header, three records, the add-record row, and the footer
    expect(rows.map(({ node }) => node.getAttribute('aria-rowindex'))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
    for (const { node } of rows) {
      const cells = owned(node);
      expect(cells.length).toBeGreaterThan(0);
      expect(cells.filter(({ role }) => !CELLS.includes(role ?? ''))).toEqual([]);
    }
    // The add-field button is outside the grid, and the add-record button inside a cell.
    expect(grid.querySelector('[data-rio-add-column]')).toBeNull();
    expect(actions.querySelector('[data-rio-add-column]')).not.toBeNull();
    expect(grid.querySelector('[data-rio-add]')!.closest('[role="gridcell"]')).not.toBeNull();
  });
});

describe('the grid element', () => {
  it('keeps an empty read-only scroller reachable and keeps its rows in the accessibility tree', () => {
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
    Object.defineProperties(node, { clientWidth: { value: 390 }, clientHeight: { value: 400 } });
    const api = createGrid(node, {
      host: host(),
      columns: Array.from({ length: 50 }, (_, index) => ({ id: String(index), width: 100, edit: 'none' })),
      rowCount: 0,
      rowHeight: 32,
      frozenColumnCount: 0,
      label: 'test.grid',
      readOnly: true,
      showAddRow: false,
    });
    try {
      const scroller = node.querySelector<HTMLElement>('.rio-grid__scroller')!;
      Object.defineProperties(scroller, { clientWidth: { value: 390 }, clientHeight: { value: 300 } });
      resize();
      vi.advanceTimersByTime(32);
      expect(scroller.tabIndex).toBe(0);
      expect(scroller.getAttribute('aria-label')).toBe('test.grid');
      scroller.focus();
      expect(document.activeElement).toBe(scroller);
      scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      vi.advanceTimersByTime(32);
      expect(scroller.scrollLeft).toBeGreaterThan(0);
      scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      vi.advanceTimersByTime(32);
      expect(scroller.scrollLeft).toBe(0);
      const modified = new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      scroller.dispatchEvent(modified);
      expect(modified.defaultPrevented).toBe(false);
      api.update({ direction: 'rtl' });
      vi.advanceTimersByTime(32);
      scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      vi.advanceTimersByTime(32);
      expect(scroller.scrollLeft).toBeLessThan(0);
      const grid = node.querySelector('[role="grid"]')!;
      expect(owned(grid).every(({ role }) => role === 'rowgroup')).toBe(true);
      api.update({ rowCount: 3, direction: 'ltr' });
      vi.advanceTimersByTime(32);
      expect(scroller.hasAttribute('tabindex')).toBe(false);
      expect(owned(scroller).every(({ role }) => role === 'row')).toBe(true);
      expect(owned(scroller).length).toBeGreaterThan(0);
      api.update({ rowCount: 0 });
      vi.advanceTimersByTime(32);
      expect(scroller.tabIndex).toBe(0);
    } finally {
      api.destroy();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('sits beside the keyboard input, the announcements, and the add-field button, and goes on destroy', () => {
    const node = document.createElement('div');
    node.setAttribute('dir', 'rtl');
    document.body.append(node);
    const api = createGrid(node, {
      host: host(),
      columns: [{ id: 'a', width: 100, edit: 'inline' }],
      rowCount: 3,
      rowHeight: 32,
      frozenColumnCount: 0,
      label: 'test.grid',
      showAddRow: true,
      showAddColumn: true,
      showFooter: true,
      direction: 'rtl',
    });
    const grid = node.querySelector('[role="grid"]')!;
    expect(node.hasAttribute('role')).toBe(false);
    expect(grid.parentElement).toBe(node);
    for (const selector of ['textarea', '.rio-grid__live', '[data-rio-add-column]']) {
      expect(node.querySelector(selector)).not.toBeNull();
      expect(grid.querySelector(selector)).toBeNull();
    }
    api.destroy();
    expect(node.children).toHaveLength(0);
    expect(node.getAttribute('dir')).toBe('rtl');
  });
});
