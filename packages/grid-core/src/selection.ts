import type { CellRef, GridSelection } from './types.js';

export function sameCell(a: CellRef | null, b: CellRef | null): boolean {
  return a === b || (!!a && !!b && a.row === b.row && a.col === b.col);
}

function copy(selection: GridSelection): GridSelection {
  return {
    active: selection.active && { ...selection.active },
    range: selection.range && { start: { ...selection.range.start }, end: { ...selection.range.end } },
    rows:
      selection.rows.kind === 'some'
        ? { kind: 'some', rows: new Set(selection.rows.rows) }
        : { kind: selection.rows.kind },
  };
}

function equal(a: GridSelection, b: GridSelection): boolean {
  if (
    !sameCell(a.active, b.active) ||
    !sameCell(a.range?.start ?? null, b.range?.start ?? null) ||
    !sameCell(a.range?.end ?? null, b.range?.end ?? null) ||
    a.rows.kind !== b.rows.kind
  )
    return false;
  if (a.rows.kind !== 'some' || b.rows.kind !== 'some') return true;
  const rows = b.rows.rows;
  return a.rows.rows.size === rows.size && [...a.rows.rows].every((row) => rows.has(row));
}

export function createSelectionState(changed: (selection: GridSelection) => void) {
  let value: GridSelection = { active: null, range: null, rows: { kind: 'none' } };
  let extent: CellRef | null = null;
  let rowAnchor: number | null = null;

  function publish(next: GridSelection) {
    if (equal(value, next)) return;
    value = copy(next);
    changed(copy(value));
  }

  function select(cell: CellRef, extend = false) {
    const active = extend && value.active ? value.active : cell;
    extent = { ...cell };
    rowAnchor = null;
    publish({
      active,
      range: {
        start: { row: Math.min(active.row, cell.row), col: Math.min(active.col, cell.col) },
        end: { row: Math.max(active.row, cell.row), col: Math.max(active.col, cell.col) },
      },
      rows: { kind: 'none' },
    });
  }

  return {
    get: () => copy(value),
    active: () => value.active && { ...value.active },
    /** The selected block alone, without copying a row selection that may hold a million rows */
    range: () => value.range && { start: { ...value.range.start }, end: { ...value.range.end } },
    extent: () => extent && { ...extent },
    set(selection: GridSelection) {
      extent =
        selection.range && selection.active
          ? {
              row:
                selection.range.start.row === selection.active.row
                  ? selection.range.end.row
                  : selection.range.start.row,
              col:
                selection.range.start.col === selection.active.col
                  ? selection.range.end.col
                  : selection.range.start.col,
            }
          : selection.active && { ...selection.active };
      rowAnchor = selection.active?.row ?? null;
      publish(selection);
    },
    select,
    collapse() {
      if (value.active) select(value.active);
    },
    selectRow(row: number, mode: 'replace' | 'extend' | 'toggle', rowCount: number) {
      if (mode !== 'extend' || rowAnchor === null) rowAnchor = row;
      let rows = new Set<number>();
      if (mode === 'toggle') {
        rows =
          value.rows.kind === 'some'
            ? new Set(value.rows.rows)
            : value.rows.kind === 'all'
              ? new Set(Array.from({ length: rowCount }, (_, index) => index))
              : rows;
        if (rows.has(row)) rows.delete(row);
        else rows.add(row);
      } else {
        for (let index = Math.min(rowAnchor, row); index <= Math.max(rowAnchor, row); index++)
          rows.add(index);
      }
      const active = { row: mode === 'extend' ? rowAnchor : row, col: value.active?.col ?? 0 };
      extent = { row, col: active.col };
      publish({ active, range: null, rows: rows.size ? { kind: 'some', rows } : { kind: 'none' } });
    },
    selectAll(rowCount: number, columnCount: number) {
      if (!rowCount || !columnCount) return;
      const active = value.active ?? { row: 0, col: 0 };
      extent = { row: rowCount - 1, col: columnCount - 1 };
      publish({ active, range: { start: { row: 0, col: 0 }, end: extent }, rows: { kind: 'none' } });
    },
    rowSelected: (row: number) =>
      value.rows.kind === 'all' || (value.rows.kind === 'some' && value.rows.rows.has(row)),
    cellSelected({ row, col }: CellRef) {
      const range = value.range;
      return (
        !!range &&
        row >= range.start.row &&
        row <= range.end.row &&
        col >= range.start.col &&
        col <= range.end.col
      );
    },
    cellActive: (cell: CellRef) => sameCell(value.active, cell),
  };
}
