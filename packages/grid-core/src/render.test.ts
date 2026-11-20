import { describe, expect, it, vi } from 'vitest';
import { createRenderer } from './render.js';
import type { RenderFrame } from './render.js';
import { createSelectionState } from './selection.js';
import type { GridHost } from './types.js';

function fixture() {
  const header = document.createElement('div');
  const viewport = document.createElement('div');
  const selection = createSelectionState(() => renderer.invalidate());
  const renderer = createRenderer<string>(header, viewport, selection);
  const host: GridHost<string> = {
    getRow: (index) => (index < 3 ? `row-${index}` : undefined),
    ensureRows: vi.fn(),
    renderCell: vi.fn((el, context) => {
      el.textContent = context.row;
    }),
    renderHeader: vi.fn((el, column) => {
      el.textContent = column.id;
    }),
    renderRowHeader: vi.fn((el, index) => {
      el.textContent = String(index);
    }),
    rowClass: (_, index) => (index === 0 ? 'rio-test-row' : null),
    editText: () => '',
    commitText: () => null,
  };
  const frame: RenderFrame<string> = {
    options: {
      host,
      columns: [
        { id: 'a', width: 100, edit: 'none' },
        { id: 'b', width: 100, edit: 'none' },
      ],
      rowCount: 10,
      rowHeight: 32,
      frozenColumnCount: 1,
      label: 'test.grid',
    },
    width: 264,
    height: 64,
    scrollX: 0,
    scrollY: 0,
    prefix: [0, 100, 200],
    frozen: 1,
    rows: { start: 0, end: 2 },
    columns: { start: 1, end: 2 },
    frozenColumns: { start: 0, end: 1 },
  };
  return { header, viewport, host, frame, renderer, selection };
}

describe('pooled drawing', () => {
  it('identifies overscan cells and redraws them as they enter the viewport without invalidating other rows', () => {
    const { frame, renderer, host } = fixture();
    renderer.draw({ ...frame, rows: { start: 0, end: 3 }, height: 32 });
    const renderCell = vi.mocked(host.renderCell);
    expect(renderCell.mock.calls.map(([, cell]) => [cell.rowIndex, cell.visible])).toEqual([
      [0, true],
      [0, true],
      [1, false],
      [1, false],
      [2, false],
      [2, false],
    ]);
    renderCell.mockClear();
    renderer.draw({ ...frame, rows: { start: 0, end: 3 }, height: 32, scrollY: 16 });
    expect(renderCell.mock.calls.map(([, cell]) => [cell.rowIndex, cell.visible])).toEqual([
      [1, true],
      [1, true],
    ]);
    renderCell.mockClear();
    renderer.draw({ ...frame, rows: { start: 0, end: 3 }, height: 32, scrollY: 32 });
    expect(renderCell.mock.calls.map(([, cell]) => [cell.rowIndex, cell.visible])).toEqual([
      [0, false],
      [0, false],
    ]);
  });

  it('opens a marked cell and clears its button when the pool reuses it', () => {
    const { viewport, host, frame, renderer } = fixture();
    host.cellComment = (row, column) => (row === 'row-0' && column.id === 'b' ? 'test.cellComments' : null);
    host.onCellComment = vi.fn();
    renderer.draw(frame);
    const button = viewport.querySelector<HTMLButtonElement>('.rio-grid__comment:not([hidden])')!;
    expect(button.getAttribute('aria-label')).toBe('test.cellComments');
    button.click();
    expect(host.onCellComment).toHaveBeenCalledWith({ row: 0, col: 1 });
    renderer.draw({ ...frame, rows: { start: 8, end: 10 }, scrollY: 256 });
    expect(viewport.querySelector('.rio-grid__comment:not([hidden])')).toBeNull();
  });

  it('reuses row and cell elements and clears content, classes, and decorations when a row is unloaded', () => {
    const { viewport, frame, renderer } = fixture();
    renderer.setDecorations([
      { kind: 'presence', row: 0, col: 0, color: 'var(--rio-accent)', label: 'test.presence' },
    ]);
    renderer.draw(frame);
    // Records' rows, leaving out the add-record row, which stays hidden until the last record shows
    const originalRows = [...viewport.querySelectorAll('.rio-grid__row[role="row"]')];
    const originalCells = new Set(viewport.querySelectorAll('.rio-grid__cell[role="gridcell"]'));
    expect(viewport.querySelector('.rio-test-row')).not.toBeNull();
    expect(viewport.querySelector('.rio-grid__presence-label')).not.toBeNull();
    renderer.draw({ ...frame, scrollY: 256, rows: { start: 8, end: 10 } });
    const nextRows = [...viewport.querySelectorAll('.rio-grid__row[role="row"]')];
    expect(new Set(nextRows)).toEqual(new Set(originalRows));
    expect(nextRows.map((row) => row.getAttribute('aria-rowindex'))).toEqual(['10', '11']);
    expect(new Set(viewport.querySelectorAll('.rio-grid__cell[role="gridcell"]'))).toEqual(originalCells);
    expect(viewport.querySelector('.rio-test-row')).toBeNull();
    expect(viewport.querySelector('.rio-grid__presence-label')).toBeNull();
    for (const cell of originalCells) {
      expect(cell.textContent).toBe('');
      expect(cell.hasAttribute('data-loading')).toBe(true);
    }
  });

  it('redraws only invalidated rows and supplies the shared selection flags', () => {
    const { frame, renderer, host, selection } = fixture();
    renderer.draw(frame);
    expect(host.renderCell).toHaveBeenCalledTimes(4);
    renderer.draw({ ...frame, scrollY: 0.5 });
    expect(host.renderCell).toHaveBeenCalledTimes(4);
    renderer.invalidate(1, 2);
    renderer.draw(frame);
    expect(host.renderCell).toHaveBeenCalledTimes(6);
    selection.set({
      active: { row: 1, col: 1 },
      range: { start: { row: 1, col: 0 }, end: { row: 1, col: 1 } },
      rows: { kind: 'some', rows: new Set([1]) },
    });
    renderer.draw(frame);
    expect(host.renderCell).toHaveBeenLastCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ rowIndex: 1, colIndex: 1, selected: true, active: true }),
    );
    expect(host.renderRowHeader).toHaveBeenLastCalledWith(expect.any(HTMLElement), 1, 'row-1', true);
  });

  it('marks found cells, the current one apart, without borrowing a presence color', () => {
    const { viewport, frame, renderer } = fixture();
    renderer.setDecorations([
      { kind: 'match', row: 0, col: 0, current: true },
      { kind: 'match', row: 1, col: 1, current: false },
    ]);
    renderer.draw(frame);
    const marks = [...viewport.querySelectorAll<HTMLElement>('.rio-grid__decoration--match')];
    expect(marks).toHaveLength(2);
    expect(marks.map((mark) => mark.hasAttribute('data-current'))).toEqual([true, false]);
    expect(marks.every((mark) => mark.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(marks[0]!.style.getPropertyValue('--rio-grid-decoration-color')).toBe('');
    renderer.setDecorations([]);
    renderer.draw(frame);
    expect(viewport.querySelector('.rio-grid__decoration--match')).toBeNull();
  });

  it('keeps frozen cells first in the accessibility tree and translates the add action', () => {
    const { header, viewport, frame, renderer } = fixture();
    renderer.draw(frame);
    expect(
      [...header.querySelectorAll('[role="columnheader"]')].map((cell) => cell.getAttribute('aria-colindex')),
    ).toEqual(['1', '2']);
    renderer.draw({
      ...frame,
      rows: { start: 9, end: 11 },
      options: { ...frame.options, showAddRow: true, messages: { 'grid.addRow': 'test.addRow' } },
    });
    const add = viewport.querySelector<HTMLButtonElement>('[data-rio-add]')!;
    // The button sits in a cell of a row after the last record, since a row group owns only rows.
    const row = add.closest<HTMLElement>('[role="row"]')!;
    expect(add.parentElement!.getAttribute('role')).toBe('gridcell');
    expect(row.parentElement).toBe(viewport);
    expect(row.hidden).toBe(false);
    expect(row.getAttribute('aria-rowindex')).toBe('12');
    expect(add.parentElement!.getAttribute('aria-colspan')).toBe('2');
    expect(viewport.lastElementChild).toBe(row);
    expect(add.getAttribute('aria-label')).toBe('test.addRow');
    expect(add.title).toBe('test.addRow');
    renderer.draw({
      ...frame,
      rows: { start: 9, end: 11 },
      options: { ...frame.options, showAddRow: true, readOnly: true },
    });
    expect(add.disabled).toBe(true);
  });

  it('keeps the add buttons’ text nodes across redraws, so a press that spans one still clicks', () => {
    const { header, viewport, frame, selection } = fixture();
    const actions = document.createElement('div');
    const renderer = createRenderer<string>(header, viewport, selection, undefined, actions);
    const at = (messages: Record<string, string>) => ({
      ...frame,
      rows: { start: 9, end: 11 },
      options: { ...frame.options, showAddRow: true, showAddColumn: true, messages },
    });
    renderer.draw(at({ 'grid.addRow': 'test.addRow' }));
    const addColumn = actions.querySelector<HTMLButtonElement>('[data-rio-add-column]')!;
    const add = viewport.querySelector<HTMLButtonElement>('[data-rio-add]')!;
    const glyph = addColumn.firstChild;
    const label = add.firstChild;
    expect(glyph?.textContent).toBe('+');
    expect(label?.textContent).toBe('+');
    renderer.draw({ ...at({ 'grid.addRow': 'test.addRow' }), scrollY: 1 });
    expect(addColumn.firstChild).toBe(glyph);
    expect(add.firstChild).toBe(label);
    renderer.draw(at({ 'grid.addRow': 'test.addAnother' }));
    expect(add.getAttribute('aria-label')).toBe('test.addAnother');
    expect(add.firstChild).toBe(label);
    expect(addColumn.firstChild).toBe(glyph);
  });

  it('shows the full add-field target after scrolling past a clipped edge in either direction', () => {
    const { header, viewport, frame, selection } = fixture();
    const actions = document.createElement('div');
    const renderer = createRenderer<string>(header, viewport, selection, undefined, actions);
    const button = actions.querySelector<HTMLButtonElement>('[data-rio-add-column]')!;
    for (const direction of ['ltr', 'rtl'] as const) {
      const options = { ...frame.options, showAddColumn: true, direction };
      renderer.draw({ ...frame, options, width: 290 });
      expect(button.style.visibility).toBe('hidden');
      renderer.draw({ ...frame, options, width: 290, scrollX: 14 });
      expect(button.style.visibility).toBe('');
      expect(button.style.transform).toBe(`translateX(${direction === 'ltr' ? 86 : -86}px)`);
      expect(button.getAttribute('aria-label')).toBe('Add field');
      renderer.draw({ ...frame, options, width: 304 });
      expect(button.style.visibility).toBe('');
    }
  });

  it('shows the add-record action only when the whole target fits after resizing or scrolling', () => {
    const { viewport, frame, renderer } = fixture();
    const add = viewport.querySelector<HTMLButtonElement>('[data-rio-add]')!;
    const row = add.closest<HTMLElement>('[data-rio-add-row]')!;
    const options = { ...frame.options, rowCount: 1, showAddRow: true };
    const at = { ...frame, options, rows: { start: 0, end: 2 } };
    renderer.draw({ ...at, height: 57 });
    expect(row.style.visibility).toBe('hidden');
    renderer.draw({ ...at, height: 64 });
    expect(row.style.visibility).toBe('');
    renderer.draw({ ...at, height: 57, scrollY: 7 });
    expect(row.style.visibility).toBe('');
    renderer.draw({ ...at, height: 57, scrollY: 33 });
    expect(row.style.visibility).toBe('hidden');
    renderer.draw({ ...at, height: 57, scrollY: 32 });
    expect(row.style.visibility).toBe('');
  });

  it('leaves a row header’s buttons in the page when every row redraws', () => {
    const { viewport, frame, host, renderer } = fixture();
    const buttons = new WeakMap<HTMLElement, HTMLButtonElement>();
    host.renderRowHeader = vi.fn((el: HTMLElement, index: number) => {
      const expand = buttons.get(el) ?? el.ownerDocument.createElement('button');
      buttons.set(el, expand);
      expand.setAttribute('aria-label', `test.expand.${index}`);
      if (el.firstChild !== expand) el.replaceChildren(expand);
    });
    renderer.draw(frame);
    const expand = viewport.querySelector<HTMLButtonElement>('[aria-label="test.expand.0"]')!;
    const heading = expand.parentElement!;
    const removals: Node[] = [];
    const observer = new MutationObserver((records) =>
      records.forEach((record) => removals.push(...record.removedNodes)),
    );
    observer.observe(heading, { childList: true });
    renderer.invalidate();
    renderer.draw(frame);
    observer.takeRecords().forEach((record) => removals.push(...record.removedNodes));
    observer.disconnect();
    expect(host.renderRowHeader).toHaveBeenCalledTimes(4);
    expect(removals).toEqual([]);
    expect(heading.firstChild).toBe(expand);
  });

  it('keeps a group row’s buttons and their text nodes through invalidate() and a new options object', () => {
    const { viewport, frame, host, renderer } = fixture();
    // A host that draws the way grouped rows do: a toggle and an add button it keeps, whose labels
    // it writes only when they change.
    const drawn = new WeakMap<HTMLElement, { toggle: HTMLButtonElement; add: HTMLButtonElement }>();
    host.renderCell = vi.fn((el: HTMLElement, context: { row: string; colIndex: number }) => {
      if (context.colIndex !== 0) {
        if (el.textContent !== context.row) el.textContent = context.row;
        return;
      }
      let parts = drawn.get(el);
      if (!parts) {
        parts = {
          toggle: el.ownerDocument.createElement('button'),
          add: el.ownerDocument.createElement('button'),
        };
        drawn.set(el, parts);
      }
      if (parts.toggle.textContent !== context.row) parts.toggle.textContent = context.row;
      if (parts.add.textContent !== '+') parts.add.textContent = '+';
      if (el.firstChild !== parts.toggle || el.lastChild !== parts.add)
        el.replaceChildren(parts.toggle, parts.add);
    });
    host.renderRowHeader = (el, index) => {
      if (el.textContent !== String(index)) el.textContent = String(index);
    };
    renderer.draw(frame);
    const toggle = viewport.querySelector<HTMLElement>('[data-rio-row="0"][data-rio-col="0"] button')!;
    const add = toggle.nextElementSibling!;
    const label = toggle.firstChild;
    const glyph = add.firstChild;
    expect(label?.textContent).toBe('row-0');
    const removals: Node[] = [];
    const observer = new MutationObserver((records) =>
      records.forEach((record) => removals.push(...record.removedNodes)),
    );
    observer.observe(viewport, { childList: true, subtree: true });
    renderer.invalidate();
    renderer.draw(frame);
    // The view's settings changing hands the grid new options, with new objects for the same columns.
    renderer.invalidate();
    renderer.draw({
      ...frame,
      options: { ...frame.options, columns: frame.options.columns.map((column) => ({ ...column })) },
    });
    observer.takeRecords().forEach((record) => removals.push(...record.removedNodes));
    observer.disconnect();
    expect(host.renderCell).toHaveBeenCalledTimes(12);
    expect(removals).toEqual([]);
    expect(viewport.contains(toggle)).toBe(true);
    expect(toggle.firstChild).toBe(label);
    expect(add.firstChild).toBe(glyph);
  });

  it('still empties a pooled cell that moves to another column', () => {
    const { viewport, frame, renderer } = fixture();
    renderer.draw(frame);
    const cell = viewport.querySelector<HTMLElement>('[data-rio-row="0"][data-rio-col="1"]')!;
    const content = cell.firstElementChild as HTMLElement;
    content.append(document.createElement('mark'));
    content.className = 'rio-grid__content test-leftover';
    renderer.draw({
      ...frame,
      options: {
        ...frame.options,
        columns: [frame.options.columns[0]!, { id: 'c', width: 100, edit: 'none' }],
      },
    });
    expect(content.querySelector('mark')).toBeNull();
    expect(content.className).toBe('rio-grid__content');
  });
});

it('keeps a row handle focused while the host refreshes the same row header', () => {
  const { frame, renderer, host, viewport } = fixture();
  const handle = document.createElement('button');
  host.renderRowHeader = (el, index) => {
    if (index === 0 && el.firstChild !== handle) el.replaceChildren(handle);
  };
  document.body.append(viewport);
  renderer.draw(frame);
  handle.focus();
  renderer.invalidate();
  renderer.draw(frame);
  expect(document.activeElement).toBe(handle);
  viewport.remove();
});

it('draws group segments above header cells and keeps their labels after horizontal virtualization', () => {
  const { header, frame, renderer } = fixture();
  const group = { id: 'details', name: 'Details', collapsed: false };
  frame.options.columns = Array.from({ length: 5 }, (_, index) => ({
    id: String(index),
    width: 100,
    edit: 'none',
    group,
  }));
  frame.prefix = [0, 100, 200, 300, 400, 500];
  frame.columns = { start: 1, end: 4 };
  renderer.draw(frame);
  const bands = [...header.querySelectorAll<HTMLElement>('[data-rio-column-group]')];
  expect(bands).toHaveLength(2);
  expect(bands.every((band) => !band.closest('[data-rio-column]'))).toBe(true);
  expect(
    [...header.querySelectorAll<HTMLElement>('[data-rio-column]')].every((cell) => cell.tabIndex === -1),
  ).toBe(true);
  renderer.draw({ ...frame, scrollX: 160, columns: { start: 2, end: 5 } });
  const scrolled = [...header.querySelectorAll<HTMLElement>('[data-rio-column-group]')];
  expect(scrolled).toHaveLength(2);
  expect(scrolled[1]!.textContent).toBe('Details');
  expect(scrolled[1]!.style.inlineSize).toBe('100px');
});

it('keeps group header content unchanged during vertical and horizontal scrolling', async () => {
  const { frame, renderer, header, host } = fixture();
  const group = { id: 'details', name: 'test.details', collapsed: false, color: 'blue' };
  frame.options.columns = frame.options.columns.map((column) => ({ ...column, group }));
  host.onColumnGroupToggle = vi.fn();
  host.columnDropReason = vi.fn(() => null);
  renderer.draw(frame);
  const button = header.querySelector<HTMLButtonElement>('[data-rio-column-group]')!;
  const label = button.firstChild;
  const observer = new MutationObserver(() => {});
  observer.observe(header.querySelector('.rio-grid__column-groups')!, {
    attributes: true,
    childList: true,
    subtree: true,
  });
  vi.mocked(host.columnDropReason).mockClear();
  renderer.draw({ ...frame, scrollY: 20 });
  expect(observer.takeRecords()).toEqual([]);
  renderer.draw({ ...frame, scrollX: 20 });
  expect(button.firstChild).toBe(label);
  expect(host.columnDropReason).not.toHaveBeenCalled();
  frame.options = {
    ...frame.options,
    columns: frame.options.columns.map((column) => ({
      ...column,
      group: { ...group, name: 'test.renamed', collapsed: true },
    })),
  };
  host.columnDropReason = () => 'test.locked';
  renderer.invalidate();
  renderer.draw(frame);
  expect(button.textContent).toBe('test.renamed');
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(button.disabled).toBe(true);
  observer.disconnect();
});

it('keeps a group band’s text node when every cell redraws or the options change, so a press still clicks', () => {
  const { frame, renderer, header, host } = fixture();
  const group = { id: 'details', name: 'test.details', collapsed: false };
  frame.options.columns = frame.options.columns.map((column) => ({ ...column, group }));
  host.onColumnGroupToggle = vi.fn();
  renderer.draw(frame);
  const button = header.querySelector<HTMLButtonElement>('[data-rio-column-group]')!;
  const label = button.firstChild;
  expect(label?.textContent).toBe('test.details');
  renderer.invalidate();
  renderer.draw(frame);
  expect(button.firstChild).toBe(label);
  renderer.draw({ ...frame, options: { ...frame.options } });
  expect(button.firstChild).toBe(label);
  expect(button.textContent).toBe('test.details');
});

it('places group headers in their own row above member headers', () => {
  const { frame, renderer, header } = fixture();
  frame.options.columns = frame.options.columns.map((column) => ({
    ...column,
    group: { id: 'g', name: 'test.group', collapsed: false },
  }));
  renderer.draw(frame);
  const band = header.querySelector('[data-rio-column-group]')!.closest('[role="row"]')!;
  const member = header.querySelector('[data-rio-column]')!.closest('[role="row"]')!;
  expect(band).not.toBe(member);
  expect(band.getAttribute('aria-rowindex')).toBe('1');
  expect(member.getAttribute('aria-rowindex')).toBe('2');
});
