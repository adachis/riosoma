import { z } from 'zod';
import { ErrorBody } from '../errors.js';
import { FieldId, LIMITS, RecordId } from './fields.js';

/**
 * Importing a spreadsheet.  The browser sends the workbook's bytes to
 * `POST /api/imports/spreadsheet`, and the server reads it with a streaming reader and answers every
 * sheet's rows, which the browser then previews and writes as commands, the same way it does a CSV
 * file.
 */
export const SPREADSHEET_LIMITS = {
  /** The largest workbook the server accepts */
  uploadBytes: 50 * 1024 * 1024,
  /** How long reading one workbook may take */
  seconds: 120,
  /** Rows a sheet can bring.  The rest are counted, so the person can be told, but not sent. */
  rowsPerSheet: 200_000,
} as const;

/**
 * One cell as the spreadsheet holds it.  Text is a string, numbers and numeric formula results are
 * numbers, and true or false are booleans.  A date is its wall-clock reading with no zone, since a
 * spreadsheet stores none: `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm:ss` when it has a time.  An error is
 * the text the spreadsheet shows, such as `#N/A`, or empty when only its kind is known.  Empty
 * cells are null.
 */
export const SheetCell = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.strictObject({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/) }),
  z.strictObject({ error: z.string().max(64) }),
]);
export type SheetCell = z.infer<typeof SheetCell>;

/**
 * A row line: the row's number in its sheet, then its cells from the first column.  Empty rows are
 * left out, and so are empty cells at a row's end.
 */
export const SheetRow = z.tuple([z.number().int().min(1)], SheetCell);
export type SheetRow = z.infer<typeof SheetRow>;

/**
 * Every other line of the answer, which is one JSON value per line.  `{ sheet, position }` starts
 * a sheet (`position` is its place among the workbook's tabs, which the reading order need not
 * follow), row lines follow, and `{ rows, total }` ends it: `total` counts every row with a value
 * and `rows` the ones sent.  `{ done: true }` ends the answer.  A failure after the answer has
 * started arrives as an error line instead of the end.
 */
export const SpreadsheetLine = z.union([
  z.strictObject({ sheet: z.string(), position: z.number().int().min(0) }),
  z.strictObject({ rows: z.number().int().min(0), total: z.number().int().min(0) }),
  z.strictObject({ done: z.literal(true) }),
  ErrorBody,
]);
export type SpreadsheetLine = z.infer<typeof SpreadsheetLine>;

/** Records a page of `POST /api/tables/:tableId/import/records` holds at most. */
export const IMPORT_RECORDS_PAGE = 5_000;

/**
 * `POST /api/tables/:tableId/import/records`: some fields of a table's records, for matching an
 * imported file against them.  Without `recordIds` it pages through every record in the order
 * they were added.  With them it answers just those records.
 */
export const ImportRecordsRequest = z.object({
  fieldIds: z.array(FieldId).min(1).max(LIMITS.fieldsPerTable),
  /** The previous page's `next` */
  after: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  recordIds: z.array(RecordId).min(1).max(LIMITS.recordsPerCommand).optional(),
});
export type ImportRecordsRequest = z.infer<typeof ImportRecordsRequest>;

export const ImportRecordsPage = z.object({
  records: z.array(z.object({ id: RecordId, values: z.record(z.string(), z.unknown()) })),
  /** Pass as `after` for the next page.  Null on the last one. */
  next: z.string().nullable(),
});
export type ImportRecordsPage = z.infer<typeof ImportRecordsPage>;
