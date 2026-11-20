import { csvRows } from './csv';
import { sheetRowOf, type ImportCell } from './cells';

/**
 * Where an import's rows come from: a CSV file, read here in the browser, or one sheet of a
 * spreadsheet the server read, kept as its row lines.  Either one can be read again from the
 * start, which the preview does whenever a choice changes.
 */
export type ImportSource = { kind: 'csv'; file: Blob } | { kind: 'sheet'; rows: Blob };

export interface NumberedRow {
  /** The row's number in its file: a CSV record's place, or a sheet's own row number */
  number: number;
  cells: ImportCell[];
}

export class SourceError extends Error {}

async function* lines(blob: Blob, progress: (fraction: number) => void, chunkSize = 256 * 1024) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    pending += decoder.decode(await blob.slice(offset, offset + chunkSize).arrayBuffer(), { stream: true });
    let start = 0;
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n', start)) {
      yield pending.slice(start, end);
      start = end + 1;
    }
    pending = pending.slice(start);
    progress(Math.min(1, (offset + chunkSize) / blob.size));
  }
  pending += decoder.decode();
  if (pending) yield pending;
}

export async function* numberedRows(
  source: ImportSource,
  progress: (fraction: number) => void = () => undefined,
): AsyncGenerator<NumberedRow> {
  if (source.kind === 'csv') {
    let number = 0;
    for await (const cells of csvRows(source.file, progress)) yield { number: ++number, cells };
    return;
  }
  for await (const line of lines(source.rows, progress)) {
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new SourceError();
    }
    const row = sheetRowOf(value);
    if (!row) throw new SourceError();
    yield row;
  }
  progress(1);
}

export async function* sourceRows(
  source: ImportSource,
  progress?: (fraction: number) => void,
): AsyncGenerator<ImportCell[]> {
  for await (const row of numberedRows(source, progress)) yield row.cells;
}
