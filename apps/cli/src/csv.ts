/**
 * Comma-separated values, read and written a row at a time.
 *
 * A file someone exports from a spreadsheet is bigger than the memory a command should take, so
 * the reader is a generator over the chunks as they arrive, and the writer prints each row before
 * the next one is read.  The rules followed are the ones RFC 4180 writes down and the ones
 * spreadsheets actually use: a field may be quoted, a quoted field may hold a delimiter, a
 * newline, or a quote doubled, a line may end with a carriage return, and a file may start with a
 * byte-order mark.
 */

export interface CsvOptions {
  delimiter?: string;
}

/** Reads rows as they arrive.  A blank line is skipped, since a file often ends with one. */
export async function* readCsv(
  chunks: AsyncIterable<string>,
  options: CsvOptions = {},
): AsyncGenerator<string[]> {
  const delimiter = options.delimiter ?? ',';
  let field = '';
  let row: string[] = [];
  let quoted = false;
  /** A quote inside a quoted field, waiting to see whether the next character doubles it */
  let pending = false;
  let started = false;
  let fresh = true;

  for await (const chunk of chunks) {
    let text = typeof chunk === 'string' ? chunk : String(chunk);
    if (fresh) {
      text = text.replace(/^\uFEFF/, '');
      fresh = false;
    }
    for (const character of text) {
      if (pending) {
        pending = false;
        if (character === '"') {
          field += '"';
          continue;
        }
        quoted = false;
      }
      if (quoted) {
        if (character === '"') pending = true;
        else field += character;
        started = true;
        continue;
      }
      if (character === '"' && field === '') {
        quoted = true;
        started = true;
        continue;
      }
      if (character === delimiter) {
        row.push(field);
        field = '';
        started = true;
        continue;
      }
      // A carriage return is half of a line ending, and the line feed that follows ends the row.
      if (character === '\r') continue;
      if (character === '\n') {
        row.push(field);
        field = '';
        if (started || row.length > 1) yield row;
        row = [];
        started = false;
        continue;
      }
      field += character;
      started = true;
    }
  }
  // A file that doesn't end with a newline still has its last row in hand.
  row.push(field);
  if (started || row.length > 1) yield row;
}

/** Whether a value has to be quoted to survive a round trip. */
function needsQuotes(value: string, delimiter: string): boolean {
  return (
    value.includes('"') ||
    value.includes(delimiter) ||
    value.includes('\n') ||
    value.includes('\r') ||
    value !== value.trim()
  );
}

/** One row as a line of CSV, without its ending. */
export function csvRow(cells: readonly string[], delimiter = ','): string {
  return cells
    .map((cell) => (needsQuotes(cell, delimiter) ? `"${cell.replaceAll('"', '""')}"` : cell))
    .join(delimiter);
}

/** One value as CSV text: nothing for empty, JSON for a value with parts, text for the rest. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}
