import { message } from './messages.js';
/**
 * What the tool prints.  A table of columns is what a person reads at a terminal, and `--json` is
 * what a script pipes into the next thing, so every command builds rows of plain values and one
 * place here decides how they look.  Nothing is colored and nothing depends on a terminal's width
 * being guessed right: the output is the same in a pipe as it is on a screen.
 */

export interface Column {
  /** The key each row holds this column's value under */
  name: string;
  /** The heading, which defaults to the key with its first letter in capitals */
  header?: string;
  align?: 'left' | 'right';
  /** The most characters of a value to print, which a long text field would otherwise overrun */
  width?: number;
}

/** The most characters of one value a table prints, unless the column says otherwise */
const DEFAULT_WIDTH = 60;

/** One value as text, which is what a table cell holds. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.replace(/\r?\n/g, ' ');
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function heading(column: Column): string {
  if (column.header) return column.header;
  return column.name.charAt(0).toUpperCase() + column.name.slice(1);
}

function clipped(text: string, width: number): string {
  if (width <= 1 || text.length <= width) return text;
  return `${text.slice(0, width - 1)}…`;
}

/** Rows as a table with a heading, or an empty list's own line, which a script can still read. */
export function renderTable(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: readonly Column[],
): string {
  if (!columns.length) return '';
  if (!rows.length) return message('cli.format.nothingToShow');
  const widths = widthsOf(rows, columns);
  return [
    renderHeader(columns, widths),
    renderRule(widths),
    ...rows.map((row) => renderRow(columns, widths, row)),
  ].join('\n');
}

/** How wide each column has to be to hold its heading and every value in these rows. */
export function widthsOf(rows: ReadonlyArray<Record<string, unknown>>, columns: readonly Column[]): number[] {
  return columns.map((column) => {
    const widest = rows.reduce(
      (widest, row) =>
        Math.max(widest, clipped(cellText(row[column.name]), column.width ?? DEFAULT_WIDTH).length),
      heading(column).length,
    );
    return Math.min(widest, column.width ?? DEFAULT_WIDTH);
  });
}

export function renderHeader(columns: readonly Column[], widths: readonly number[]): string {
  return line(
    columns.map(heading),
    columns.map(() => 'left'),
    widths,
  );
}

export function renderRule(widths: readonly number[]): string {
  return widths.map((width) => '-'.repeat(width)).join('  ');
}

export function renderRow(
  columns: readonly Column[],
  widths: readonly number[],
  row: Record<string, unknown>,
): string {
  return line(
    columns.map((column, index) => clipped(cellText(row[column.name]), widths[index] ?? DEFAULT_WIDTH)),
    columns.map((column) => column.align ?? 'left'),
    widths,
  );
}

function line(values: readonly string[], aligns: readonly string[], widths: readonly number[]): string {
  return values
    .map((value, index) => {
      const width = widths[index]!;
      return aligns[index] === 'right' ? value.padStart(width) : value.padEnd(width);
    })
    .join('  ')
    .trimEnd();
}

/** Rows as JSON, which is what `--json` prints and what a script reads. */
export function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** A count and its noun, in the English a summary line reads as. */
export function counted(count: number, one: string, many = message('cli.format.s', { one: one })): string {
  if (one === 'record' || one === 'request' || one === 'database')
    return message(`cli.count.${one}.${count === 1 ? 'one' : 'many'}`, { count });
  return `${count} ${count === 1 ? one : many}`;
}
