import { Readable } from 'node:stream';
import { formatCellText } from '../format.js';
import { exportPages, type ExportOrder, type ExportSource } from './source.js';
import { BYTE_ORDER_MARK, csvRecord } from './text.js';

/**
 * A view as CSV: a header of field names, then every record worded the way the app words it.  The
 * byte-order mark is what makes Excel read the file as UTF-8 instead of the system's old default.
 */
export const CSV_TYPE = 'text/csv; charset=utf-8';

/** The file as a stream: a header, then a page of records at a time. */
export function csvStream(source: ExportSource, order: ExportOrder): Readable {
  return Readable.from(records(source, order), { objectMode: false });
}

async function* records(source: ExportSource, order: ExportOrder): AsyncGenerator<string, void, undefined> {
  yield `${BYTE_ORDER_MARK}${csvRecord(source.fields.map((field) => field.name))}`;
  for await (const page of exportPages(source, order)) {
    let text = '';
    for (const row of page.rows)
      text += csvRecord(source.fields.map((field) => formatCellText(field, row, page.read, page.context)));
    yield text;
  }
}
