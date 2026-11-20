import type { SheetCell } from '@riosoma/contracts';

/**
 * One cell of an imported file.  A CSV cell is always text.  A spreadsheet's cells keep their
 * types, so a number stays a number and a date stays a date instead of turning into text.
 */
export type ImportCell = SheetCell;

export function isDateCell(cell: ImportCell | undefined): cell is { date: string } {
  return typeof cell === 'object' && cell !== null && 'date' in cell;
}

export function isErrorCell(cell: ImportCell | undefined): cell is { error: string } {
  return typeof cell === 'object' && cell !== null && 'error' in cell;
}

/** A cell as text: what a text field stores, what the preview shows, and what a header names. */
export function cellText(cell: ImportCell | undefined): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number') return String(cell);
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
  if (isDateCell(cell)) return cell.date.replace('T', ' ');
  return cell.error;
}

export function isBlankCell(cell: ImportCell | undefined): boolean {
  return cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '');
}

/**
 * A row line from the server, checked by hand: a sheet can have hundreds of thousands of them, and
 * each is read again whenever the preview changes.
 */
export function sheetRowOf(value: unknown): { number: number; cells: ImportCell[] } | null {
  if (!Array.isArray(value) || typeof value[0] !== 'number') return null;
  const cells = value.slice(1) as unknown[];
  for (const cell of cells) {
    if (cell === null || typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean')
      continue;
    if (typeof cell !== 'object') return null;
    const keys = Object.keys(cell);
    const text = (cell as Record<string, unknown>)[keys[0] ?? ''];
    if (keys.length !== 1 || (keys[0] !== 'date' && keys[0] !== 'error') || typeof text !== 'string')
      return null;
  }
  return { number: value[0], cells: cells as ImportCell[] };
}
