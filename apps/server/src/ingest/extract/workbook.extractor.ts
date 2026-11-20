import type ExcelJS from 'exceljs';
import { cell, EMPTY_CELL, type Cell, type SourceSheet } from '@riosoma/ingest';
import type { cellOf as spreadsheetCell, Range } from '../../data/imports/spreadsheet.js';
import { guardedEntries, guardedMember, isZip } from './archive.js';
import { ExtractionFailure, LIMITS, outcome, type Extractor } from './types.js';

function storedCell(item: ExcelJS.Cell, date1904: boolean, cellOf: typeof spreadsheetCell): Cell {
  const stored = cellOf(item, date1904);
  if (stored && typeof stored === 'object')
    return 'date' in stored ? { v: stored.date, t: 'date' } : cell(stored.error);
  // A zero-padding number format is an explicit instruction to display an identifier as text.
  const format = item.numFmt?.split(';')[0];
  if (typeof stored === 'number' && Number.isInteger(stored) && /^0{2,}$/.test(format ?? ''))
    return cell(String(stored).padStart(format!.length, '0'));
  return cell(stored);
}

const extractor: Extractor = {
  priority: 100,
  claims(bytes) {
    return isZip(bytes) && guardedEntries(bytes).has('xl/workbook.xml');
  },
  async extract(bytes, context) {
    const { cellOf, readWorkbook } = await import('../../data/imports/spreadsheet.js');
    const entries = guardedEntries(bytes);
    // Validate every part, including ignored macros, before the workbook reader inflates the archive.
    for (const entry of entries.values()) guardedMember(bytes, entry);
    const sparse: Array<{
      name: string;
      hidden: boolean;
      height: number;
      width: number;
      merges: Range[];
      values: Array<{ row: number; column: number; value: Cell }>;
    }> = [];
    let cells = 0;
    for await (const sheet of readWorkbook(bytes)) {
      let height = 0;
      let width = 0;
      const values: (typeof sparse)[number]['values'] = [];
      for await (const row of sheet.rows) {
        row.eachCell({ includeEmpty: false }, (item, column) => {
          if (
            sheet.merges.some(
              (merge) =>
                row.number >= merge.top &&
                row.number <= merge.bottom &&
                column >= merge.left &&
                column <= merge.right &&
                (row.number !== merge.top || column !== merge.left),
            )
          )
            return;
          const inline = sheet.inlineStrings.get(item.address);
          if (inline !== undefined) item.value = inline;
          const cached = sheet.cachedResults.get(item.address);
          if (cached !== undefined)
            item.value = { ...(item.value as ExcelJS.CellFormulaValue), result: cached };
          const value = storedCell(item, sheet.date1904, cellOf);
          if (value.t === 'empty') return;
          height = Math.max(height, row.number);
          width = Math.max(width, column);
          // Extents only grow, so reject oversized grids before keeping more values or allocating rows.
          if (!Number.isSafeInteger(height * width) || cells + height * width > LIMITS.cells)
            throw new ExtractionFailure('size-limit');
          values.push({ row: row.number, column, value });
        });
      }
      cells += height * width;
      sparse.push({ name: sheet.name, hidden: sheet.hidden, height, width, merges: sheet.merges, values });
    }
    // Every sheet's extent has passed the combined cell cap before any rectangular grid is built.
    const sheets: SourceSheet[] = sparse.map(({ name, hidden, height, width, merges, values }) => {
      const rows = Array.from({ length: height }, () => Array.from({ length: width }, () => EMPTY_CELL));
      for (const { row, column, value } of values) rows[row - 1]![column - 1] = value;
      return {
        name,
        hidden,
        rows,
        merges: merges
          .filter((merge) => merge.top <= height && merge.left <= width)
          .map((merge) => ({
            ...merge,
            bottom: Math.min(merge.bottom, height),
            right: Math.min(merge.right, width),
          })),
      };
    });
    if (!sheets.length) return outcome('empty', context.sniffedType);
    return {
      kind: 'workbook',
      name: context.name,
      sheets,
      warnings: sheets.every((sheet) => sheet.rows.every((row) => row.every((item) => item.t === 'empty')))
        ? ['ingest.extract.empty']
        : [],
    };
  },
};
export default extractor;
