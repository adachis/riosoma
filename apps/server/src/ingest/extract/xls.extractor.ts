import { cell, EMPTY_CELL, type Cell, type SourceSheet } from '@riosoma/ingest';
import type { CellObject, Range } from 'xlsx';
import { compoundFile } from './compound.extractor.js';
import { ExtractionFailure, LIMITS, outcome, type Extractor } from './types.js';

function storedCell(
  item: CellObject | undefined,
  date1904: boolean,
  isDate: (format: string) => boolean,
): Cell {
  if (!item || item.t === 'z' || item.v === undefined || item.v === null) return EMPTY_CELL;
  if (item.t === 'e') {
    const errors: Record<number, string> = {
      0: '#NULL!',
      7: '#DIV/0!',
      15: '#VALUE!',
      23: '#REF!',
      29: '#NAME?',
      36: '#NUM!',
      42: '#N/A',
      43: '#GETTING_DATA',
    };
    return cell(errors[Number(item.v)] ?? '');
  }
  if (item.t === 'n' && typeof item.v === 'number') {
    if (item.z && isDate(String(item.z)))
      return cell(new Date(Math.round((item.v - (date1904 ? 24107 : 25569)) * 86400000)));
    const format = String(item.z ?? '').split(';')[0] ?? '';
    if (Number.isInteger(item.v) && /^0{2,}$/.test(format))
      return cell(String(item.v).padStart(format.length, '0'));
  }
  return cell(item.v);
}

const extractor: Extractor = {
  priority: 110,
  async claims(bytes) {
    const container = await compoundFile(bytes);
    return Boolean(container?.FullPaths.some((path) => /^[^/]+\/(?:Workbook|Book)$/.test(path)));
  },
  async extract(bytes, context) {
    const { read, utils, SSF } = await import('xlsx');
    // Read in-memory BIFF only, with formula text, calculation chains, macros, rich HTML, and formatted output disabled.
    let book;
    try {
      book = read(bytes, {
        type: 'buffer',
        raw: true,
        dense: false,
        cellFormula: false,
        cellHTML: false,
        cellNF: true,
        cellStyles: false,
        cellText: false,
        cellDates: false,
        sheetStubs: false,
        bookDeps: false,
        bookFiles: false,
        bookVBA: false,
        password: '',
        WTF: false,
      });
    } catch (error) {
      if (error instanceof Error && /password|encrypt/i.test(error.message))
        return outcome('needs-password', context.sniffedType);
      throw error;
    }
    const dimensions: Array<{
      name: string;
      height: number;
      width: number;
      ranges: Range[];
      values: Array<{ row: number; column: number; value: Cell }>;
    }> = [];
    let cells = 0;
    for (const name of book.SheetNames) {
      const sheet = book.Sheets[name]!;
      const ranges = sheet['!merges'] ?? [];
      const values: (typeof dimensions)[number]['values'] = [];
      let height = 0;
      let width = 0;
      for (const [address, item] of Object.entries(sheet)) {
        if (!/^[A-Z]+\d+$/.test(address)) continue;
        const { r: row, c: column } = utils.decode_cell(address);
        if (
          ranges.some(
            (range) =>
              row >= range.s.r &&
              row <= range.e.r &&
              column >= range.s.c &&
              column <= range.e.c &&
              (row !== range.s.r || column !== range.s.c),
          )
        )
          continue;
        const value = storedCell(item as CellObject, Boolean(book.Workbook?.WBProps?.date1904), SSF.is_date);
        if (value.t === 'empty') continue;
        height = Math.max(height, row + 1);
        width = Math.max(width, column + 1);
        if (!Number.isSafeInteger(height * width) || cells + height * width > LIMITS.cells)
          throw new ExtractionFailure('size-limit');
        values.push({ row, column, value });
      }
      cells += height * width;
      dimensions.push({ name, height, width, ranges, values });
    }
    const sheets: SourceSheet[] = dimensions.map(({ name, height, width, ranges, values }, index) => {
      const rows = Array.from({ length: height }, () => Array.from({ length: width }, () => EMPTY_CELL));
      for (const { row, column, value } of values) rows[row]![column] = value;
      return {
        name,
        hidden: Boolean(book.Workbook?.Sheets?.[index]?.Hidden),
        rows,
        merges: ranges
          .filter((range) => range.s.r < height && range.s.c < width)
          .map((range) => ({
            top: range.s.r + 1,
            left: range.s.c + 1,
            bottom: Math.min(range.e.r + 1, height),
            right: Math.min(range.e.c + 1, width),
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
