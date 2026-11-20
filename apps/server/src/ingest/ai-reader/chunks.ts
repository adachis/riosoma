import { cell, cellText, findHeaderRow, type ExtractedSource, type SourceSheet } from '@riosoma/ingest';
import type { StoredIngestFormat } from '../tables/store.js';

// Repeated headings, source evidence, and output rows multiply the work per cell.  Larger files need rules.
export const AI_READER_MAX_CELLS = 20_000;
export const AI_READER_CHUNK_ROWS = 100;
export const AI_READER_CHUNK_BYTES = 32_000;
export interface Chunk {
  sheet: number;
  headers: Array<{ row: number; cells: string[] }>;
  rows: Array<{ row: number; cells: string[] }>;
}
export function sourceSheets(source: ExtractedSource): SourceSheet[] | null {
  if (source.kind === 'workbook' || source.kind === 'text')
    return source.sheets?.length ? source.sheets : null;
  if (source.kind === 'email' && source.email?.tables.length)
    return source.email.tables.map((rows, index) => ({
      name: String(index + 1),
      hidden: false,
      rows: rows.map((row) => row.map(cell)),
    }));
  return null;
}

export function sheetChunks(sheet: SourceSheet, index: number, format: StoredIngestFormat): Chunk[] {
  // Alternatives must describe one heading row, within the toolkit's default search window.
  const candidate = sheet.rows
    .slice(0, 60)
    .findIndex(
      (row) =>
        format.signature.headerGroups.length > 0 &&
        format.signature.headerGroups.every((group) =>
          group.some((marker) => findHeaderRow([row], [marker]) === 0),
        ),
    );
  const header = candidate < 0 ? null : candidate;
  const numbered = sheet.rows.map((row, offset) => ({ row: offset + 1, cells: row.map(cellText) }));
  const headers = header === null ? [] : numbered.slice(0, header + 1);
  const rows = numbered.slice(headers.length);
  const chunks: Chunk[] = [];
  let window: Chunk['rows'] = [];
  const headerBytes = Buffer.byteLength(JSON.stringify({ sheet: index + 1, headers, rows: [] }));
  let bytes = headerBytes;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (window.length && (window.length >= AI_READER_CHUNK_ROWS || bytes + size > AI_READER_CHUNK_BYTES)) {
      chunks.push({ sheet: index + 1, headers, rows: window });
      window = [];
      bytes = headerBytes;
    }
    window.push(row);
    bytes += size;
  }
  if (window.length || !chunks.length) chunks.push({ sheet: index + 1, headers, rows: window });
  return chunks;
}
