/**
 * The text rules both file formats share.  A downloaded file lands in a spreadsheet, which runs
 * some strings as formulas, so every value that could be one is defused here rather than in each
 * writer.  CSV shape follows RFC 4180: CRLF between records, and quotes around any value holding
 * a comma, a quote, or a line break, with inner quotes doubled.
 */

/** Excel only reads a CSV as UTF-8 when the mark says so. */
export const BYTE_ORDER_MARK = '\uFEFF';

export const LINE_END = '\r\n';

/** Leading characters a spreadsheet reads as a formula, a date, or a query rather than text. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** Values needing quotes once they hold a delimiter, a quote, or a line break. */
const QUOTED = /[",\r\n]/;

/** Prefixes an apostrophe so a value that looks like a formula stays text. */
export function guardFormula(text: string): string {
  return FORMULA_LEAD.test(text) ? `'${text}` : text;
}

/** One CSV field, guarded and quoted as needed. */
export function csvField(text: string): string {
  const value = guardFormula(text);
  return QUOTED.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** One CSV record, line end included, so a file always ends the way it separates. */
export function csvRecord(cells: readonly string[]): string {
  return `${cells.map(csvField).join(',')}${LINE_END}`;
}
