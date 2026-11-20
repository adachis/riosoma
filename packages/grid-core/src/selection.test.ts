import { expect, it, vi } from 'vitest';
import { createSelectionState } from './selection.js';
import type { GridSelection } from './types.js';

it('owns selection snapshots independently of its caller and notifications', () => {
  const changed = vi.fn();
  const state = createSelectionState(changed);
  const selection: GridSelection = {
    active: { row: 3, col: 2 },
    range: { start: { row: 2, col: 1 }, end: { row: 4, col: 3 } },
    rows: { kind: 'some', rows: new Set([9]) },
  };
  state.set(selection);
  selection.active!.row = 8;
  changed.mock.calls[0]![0].range.start.row = 10;
  state.get().range!.end.col = 0;
  expect(state.cellActive({ row: 3, col: 2 })).toBe(true);
  expect(state.cellSelected({ row: 2, col: 1 })).toBe(true);
  expect(state.cellSelected({ row: 4, col: 3 })).toBe(true);
  expect(state.cellSelected({ row: 4, col: 4 })).toBe(false);
  expect(state.rowSelected(9)).toBe(true);
  expect(state.rowSelected(8)).toBe(false);
});

it('represents empty and all-row selections without allocating per-row state', () => {
  const state = createSelectionState(() => {});
  expect(state.get()).toEqual({ active: null, range: null, rows: { kind: 'none' } });
  state.set({ active: null, range: null, rows: { kind: 'all' } });
  expect(state.rowSelected(999_999)).toBe(true);
  expect(state.cellSelected({ row: 999_999, col: 0 })).toBe(false);
});

it('extends in either direction around the active cell, collapses, and suppresses duplicate notifications', () => {
  const changed = vi.fn();
  const state = createSelectionState(changed);
  state.select({ row: 3, col: 2 });
  state.select({ row: 3, col: 2 });
  state.set(state.get());
  expect(changed).toHaveBeenCalledTimes(1);
  state.select({ row: 1, col: 0 }, true);
  expect(state.get().range).toEqual({ start: { row: 1, col: 0 }, end: { row: 3, col: 2 } });
  expect(state.active()).toEqual({ row: 3, col: 2 });
  expect(state.extent()).toEqual({ row: 1, col: 0 });
  state.select({ row: 4, col: 5 }, true);
  expect(state.get().range).toEqual({ start: { row: 3, col: 2 }, end: { row: 4, col: 5 } });
  state.collapse();
  expect(state.get().range).toEqual({ start: { row: 3, col: 2 }, end: { row: 3, col: 2 } });
  expect(changed).toHaveBeenCalledTimes(4);
});

it('selects row runs from a stable anchor, toggles individual rows, and replaces row selection with cells', () => {
  const state = createSelectionState(() => {});
  state.selectRow(4, 'replace', 10);
  state.selectRow(1, 'extend', 10);
  expect(state.get().rows).toEqual({ kind: 'some', rows: new Set([1, 2, 3, 4]) });
  state.selectRow(6, 'extend', 10);
  expect(state.get().rows).toEqual({ kind: 'some', rows: new Set([4, 5, 6]) });
  state.selectRow(5, 'toggle', 10);
  expect(state.get().rows).toEqual({ kind: 'some', rows: new Set([4, 6]) });
  state.selectRow(8, 'toggle', 10);
  expect(state.get().rows).toEqual({ kind: 'some', rows: new Set([4, 6, 8]) });
  expect(state.get().range).toBeNull();
  state.select({ row: 2, col: 1 });
  expect(state.get().rows).toEqual({ kind: 'none' });
  state.set({ active: null, range: null, rows: { kind: 'all' } });
  state.selectRow(2, 'toggle', 4);
  expect(state.get().rows).toEqual({ kind: 'some', rows: new Set([0, 1, 3]) });
});

it('selects all cells without allocating per-row state and handles an empty grid', () => {
  const changed = vi.fn();
  const state = createSelectionState(changed);
  state.selectAll(0, 20);
  expect(changed).not.toHaveBeenCalled();
  state.selectAll(1_000_000, 20);
  expect(state.get()).toEqual({
    active: { row: 0, col: 0 },
    range: {
      start: { row: 0, col: 0 },
      end: { row: 999_999, col: 19 },
    },
    rows: { kind: 'none' },
  });
  expect(state.cellSelected({ row: 999_999, col: 19 })).toBe(true);
  state.selectAll(1_000_000, 20);
  expect(changed).toHaveBeenCalledTimes(1);
});
