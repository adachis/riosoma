import type {
  FieldMeta,
  GroupKey,
  PivotAggregate,
  PivotCell,
  PivotSettings,
  TileValue,
} from '@riosoma/contracts';
import type { FormatContext } from '../../../../grid/format';
import { formatValue } from '../../dashboards/aggregates';
import { groupLabel, type GroupWords } from '../summary/fields';

/**
 * The pivot as a table: header rows, body rows in reading order without the ones inside folded
 * groups, and the Total row.  The table on screen and the downloaded file both come from here, so
 * a download holds exactly what the view shows.
 */

export interface PivotWords extends GroupWords {
  total: string;
  /** Names the records behind every record's number */
  everything: string;
  valueName(value: TileValue, field: FieldMeta | undefined): string;
  /** Names the records behind a cell, from its row's labels and its column's */
  cell(row: string, column: string): string;
}

/** The records behind a cell: its row groups, outermost first, and its column when it has one. */
export interface CellTarget {
  row: GroupKey[];
  column?: GroupKey;
  title: string;
}

export interface HeaderCell {
  text: string;
  colSpan: number;
  rowSpan: number;
  /** The corner above the row labels */
  corner?: boolean;
}

export interface ValueCell {
  text: string;
  /** Null for a blank cell, which has no records behind it */
  target: CellTarget | null;
  /** In the Total column */
  total: boolean;
}

export interface BodyRow {
  /** The row's group keys as JSON, which folding and React both key on */
  id: string;
  keys: GroupKey[];
  /** Zero for the outermost row field */
  depth: number;
  label: string;
  /** An outer group's own row, which folds away the rows inside it */
  group: boolean;
  collapsed: boolean;
  cells: ValueCell[];
}

export interface PivotModel {
  header: HeaderCell[][];
  rows: BodyRow[];
  footer: BodyRow | null;
  rowFieldNames: string[];
  /** Cells per row after the label, for spanning messages across the table */
  width: number;
}

export const rowId = (keys: readonly GroupKey[]) => JSON.stringify(keys);

export function pivotModel(
  data: PivotAggregate,
  settings: PivotSettings,
  fields: readonly FieldMeta[],
  format: FormatContext,
  words: PivotWords,
  collapsed: ReadonlySet<string>,
): PivotModel {
  const field = (id: string | undefined) => fields.find((item) => item.id === id);
  const rowFields = settings.rows.map((group) => field(group.fieldId));
  const columnField = field(settings.column?.fieldId);
  const { values } = settings;
  const valueFields = values.map((value) => field(value.fieldId ?? undefined));
  const columned = settings.column !== null;
  const totalColumn = !columned || settings.rowTotals;
  const valueNames = values.map((value, index) => words.valueName(value, valueFields[index]));
  const rowFieldNames = rowFields.map((item) => item?.name ?? '');
  const corner = rowFieldNames.join(' / ');
  const columnLabels = data.columns.map((column) => groupLabel(columnField, column.key, column.label, words));

  const header: HeaderCell[][] = [];
  if (columned) {
    header.push([
      { text: corner, colSpan: 1, rowSpan: 2, corner: true },
      ...columnLabels.map((text) => ({ text, colSpan: values.length, rowSpan: 1 })),
      ...(settings.rowTotals ? [{ text: words.total, colSpan: values.length, rowSpan: 1 }] : []),
    ]);
    const repeats = data.columns.length + (settings.rowTotals ? 1 : 0);
    header.push(
      Array.from({ length: repeats }, () => valueNames)
        .flat()
        .map((text) => ({ text, colSpan: 1, rowSpan: 1 })),
    );
  } else
    header.push([
      { text: corner, colSpan: 1, rowSpan: 1, corner: true },
      ...valueNames.map((text) => ({ text, colSpan: 1, rowSpan: 1 })),
    ]);

  const shown = (value: number | null | undefined, index: number) =>
    value === null || value === undefined
      ? ''
      : (formatValue(value, values[index]!, valueFields[index], format) ?? '');
  const cellsOf = (
    row: GroupKey[],
    title: string,
    cells: readonly PivotCell[],
    total: PivotCell,
  ): ValueCell[] => {
    const out: ValueCell[] = [];
    const push = (cell: PivotCell, target: CellTarget, isTotal: boolean) =>
      values.forEach((_, index) => {
        const text = cell ? shown(cell[index], index) : '';
        out.push({ text, target: text ? target : null, total: isTotal });
      });
    if (columned)
      data.columns.forEach((column, index) => {
        const label = columnLabels[index]!;
        push(
          cells[index] ?? null,
          { row, column: column.key, title: title ? words.cell(title, label) : label },
          false,
        );
      });
    if (totalColumn) push(total, { row, title: title || words.everything }, true);
    return out;
  };

  const depth = settings.rows.length;
  const rows: BodyRow[] = [];
  // Each outer group's row comes before the rows inside it, so their labels are known by then.
  const path: string[] = [];
  for (const row of data.rows) {
    const level = row.keys.length - 1;
    // A row inside a folded group stays out of the table, and out of the download.
    const folded = row.keys.slice(0, level).some((_, j) => collapsed.has(rowId(row.keys.slice(0, j + 1))));
    if (folded) continue;
    const id = rowId(row.keys);
    const group = row.keys.length < depth;
    const label = groupLabel(rowFields[level], row.keys[level] ?? null, row.label, words);
    path.length = level;
    path.push(label);
    rows.push({
      id,
      keys: row.keys,
      depth: level,
      label,
      group,
      collapsed: group && collapsed.has(id),
      cells: cellsOf(row.keys, path.join(' / '), row.cells, row.total),
    });
  }
  const footer: BodyRow | null = data.totals
    ? {
        id: 'total',
        keys: [],
        depth: 0,
        label: words.total,
        group: false,
        collapsed: false,
        cells: cellsOf([], '', data.totals.cells, data.totals.total),
      }
    : null;
  return {
    header,
    rows,
    footer,
    rowFieldNames,
    width: (columned ? data.columns.length : 0) * values.length + (totalColumn ? values.length : 0),
  };
}

/** Excel reads a CSV as UTF-8 only when the file says so. */
const BYTE_ORDER_MARK = '\uFEFF';
/** Leading characters a spreadsheet reads as a formula rather than text. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function field(text: string, guard: boolean): string {
  const value = guard && FORMULA_LEAD.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * The pivot as CSV, laid out as the view shows it: a column for each row field, with each row's
 * label in its own field's column, then the values as they read on screen.  Labels come from
 * people's data, so any that a spreadsheet would run as a formula stay text.
 */
export function pivotCsv(model: PivotModel): string {
  const lines: string[] = [];
  const blanks = model.rowFieldNames.map(() => '');
  model.header.forEach((cells, index) => {
    const line = (index === 0 ? model.rowFieldNames : blanks).map((text) => field(text, true));
    for (const cell of cells) {
      if (cell.corner) continue;
      line.push(field(cell.text, true), ...Array.from({ length: cell.colSpan - 1 }, () => ''));
    }
    lines.push(line.join(','));
  });
  for (const row of model.footer ? [...model.rows, model.footer] : model.rows) {
    const labels = blanks.map((_, j) => (j === row.depth ? field(row.label, true) : ''));
    lines.push([...labels, ...row.cells.map((cell) => field(cell.text, false))].join(','));
  }
  return `${BYTE_ORDER_MARK}${lines.map((line) => `${line}\r\n`).join('')}`;
}

/** Control characters and the separators and reserved characters file systems refuse. */
const UNSAFE_NAME = /[\\/:*?"<>|\p{Cc}\p{Cf}]/gu;

/** `<table> - <view>.csv`, safe on every file system. */
export function csvName(table: string, view: string): string {
  const tidy = (name: string) =>
    name
      .replace(UNSAFE_NAME, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60)
      .replace(/[.\s]+$/, '');
  const parts = [tidy(table), tidy(view)].filter(Boolean);
  return `${parts.join(' - ') || 'pivot'}.csv`;
}
