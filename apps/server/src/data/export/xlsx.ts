import { fetchRowsById } from '../physical/records.js';
import { loadTable } from '../metadata.js';
import { relationContext } from '../format.js';
import { idsOf } from '@riosoma/contracts';
import { ExcelSparklines } from './sparklines.js';
import { HEADER_COLOR_RGB, isBarField, type ChoiceColor } from '@riosoma/contracts';
import { once } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { FieldSpec, cellValue, type CellValue, type FieldOptionsOf, type RowData } from '@riosoma/contracts';
import { buttonLink, formatValue, type FormatContext } from '../format.js';
import type { StoredField } from '../types.js';
import { sheetName } from './filename.js';
import { exportPages, type ExportOrder, type ExportSource } from './source.js';
import { guardFormula } from './text.js';

/**
 * A formatted workbook, streamed.  Numbers, currency, percentages, dates, and checkboxes go in as
 * the values they are, carrying the number format that shows them the way the app does, so a
 * spreadsheet can total a column or sort a date without anyone re-typing it.  Everything else is
 * text, worded exactly as the matching CSV cell is.
 */

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The header stays in sight while a long sheet scrolls. */
const FROZEN_HEADER: Array<Partial<ExcelJS.WorksheetView>> = [
  { state: 'frozen', ySplit: 1, topLeftCell: 'A2', activeCell: 'A2' },
];

/**
 * Widths are characters.  Ten is the floor because a spreadsheet only records a width that differs
 * from its own default of nine, and sixty is the ceiling so one long note can't fill a screen.
 */
const MIN_WIDTH = 10;
const MAX_WIDTH = 60;

/** 3 May 2021 at 04:05:06: a one-digit month and day, so a locale's own padding shows up. */
const SAMPLE = new Date(Date.UTC(2021, 4, 3, 4, 5, 6));

/** A date field's stored wall date, which carries neither a time nor a zone. */
const WALL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A cell's value; `undefined` leaves the cell empty rather than writing a blank one. */
export type ExcelValue = string | number | boolean | Date | undefined;

export interface ExcelColumn {
  /** The field its cells are read as; a computed column resolves to what it returns. */
  field: StoredField;
  /** The number format the whole column carries, or null for text and checkboxes. */
  format: string | null;
  /** Duration seconds become Excel days when a numeric conditional format needs them. */
  divisor?: number;
}

type DateOptions = Pick<FieldOptionsOf<'date'>, 'dateFormat' | 'timeFormat' | 'timeZone'>;

/**
 * A computed field's values are whatever it returns, so its cells are read as that field type: a
 * formula returning a number gets a number's cells and format.  This is the resolution the text
 * formatter already does, kept once per column instead of parsed again for every cell.
 */
export function resolvedField(field: StoredField): StoredField {
  if (field.type !== 'formula' && field.type !== 'rollup') return field;
  const type = field.options.resultType;
  if (type === 'array') return field;
  const spec = FieldSpec.parse({
    type: type === 'boolean' ? 'checkbox' : type === 'datetime' ? 'date' : type,
    options: { ...field.options, includeTime: type === 'datetime', thousands: true },
  });
  return { ...field, ...spec };
}

export function excelColumns(fields: readonly StoredField[], locale: string): ExcelColumn[] {
  return fields.map((stored) => {
    const field = resolvedField(stored);
    return { field, format: columnFormat(field, locale) };
  });
}

function decimals(precision: number): string {
  return precision > 0 ? `.${'0'.repeat(precision)}` : '';
}

/** No fixed precision shows a number as entered, so the fraction digits stay optional. */
function numberFormat(options: FieldOptionsOf<'number'>): string {
  const whole = options.thousands ? '#,##0' : '0';
  return `${whole}${options.precision === null ? '.##########' : decimals(options.precision)}`;
}

function currencySymbol(code: string, locale: string): string {
  const parts = new Intl.NumberFormat(locale, { style: 'currency', currency: code }).formatToParts(0);
  return parts.find((part) => part.type === 'currency')?.value ?? code;
}

function dateFormat(options: DateOptions, locale: string, includeTime: boolean): string {
  const date =
    options.dateFormat === 'iso'
      ? 'yyyy-mm-dd'
      : options.dateFormat === 'us'
        ? 'm/d/yyyy'
        : options.dateFormat === 'european'
          ? 'd/m/yyyy'
          : pattern('date', locale);
  if (!includeTime) return date;
  const time =
    options.timeFormat === '12h'
      ? 'h:mm AM/PM'
      : options.timeFormat === '24h'
        ? 'hh:mm'
        : pattern('time', locale);
  return `${date} ${time}`;
}

/**
 * A language's own numeric date order, read from the runtime rather than a table of languages.
 * Excel words month names in its own language, so a "friendly" date keeps the numeric pattern and
 * only its order follows the reader.
 */
function localeDate(locale: string): string {
  let text = '';
  for (const part of new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).formatToParts(SAMPLE)) {
    if (part.type === 'day' || part.type === 'month') {
      const token = part.type === 'day' ? 'd' : 'm';
      text += part.value.length > 1 ? token.repeat(2) : token;
    } else if (part.type === 'year') text += 'yyyy';
    // Separators are kept; a letter would read as another part of the pattern.
    else if (part.type === 'literal') text += part.value.replace(/[^\s./-]/g, '');
  }
  return text || 'yyyy-mm-dd';
}

function clock(locale: string): string {
  const parts = new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).formatToParts(SAMPLE);
  return parts.some((part) => part.type === 'dayPeriod') ? 'h:mm AM/PM' : 'hh:mm';
}

/** One pattern per language, since working it out for every cell would dwarf the rest of the work. */
const PATTERNS = new Map<string, string>();
const PATTERN_LIMIT = 64;

function pattern(kind: 'date' | 'time', locale: string): string {
  const key = `${kind}:${locale}`;
  const cached = PATTERNS.get(key);
  if (cached) return cached;
  const built = kind === 'date' ? localeDate(locale) : clock(locale);
  // The language arrives in a request, so the cache stays small enough to be forgotten.
  if (PATTERNS.size < PATTERN_LIMIT) PATTERNS.set(key, built);
  return built;
}

function columnFormat(field: StoredField, locale: string): string | null {
  switch (field.type) {
    case 'currency': {
      const symbol = currencySymbol(field.options.code, locale).replaceAll('"', '""');
      return `"${symbol}"#,##0${decimals(field.options.precision)}`;
    }
    case 'percent':
      return `0${decimals(field.options.precision)}%`;
    case 'count':
      return '#,##0';
    case 'number':
      return numberFormat(field.options);
    case 'date':
    case 'createdTime':
    case 'lastModifiedTime':
      return dateFormat(field.options, locale, field.options.includeTime);
    default:
      return null;
  }
}

/** The wall-clock reading the person sees, as a moment Excel stores without shifting it again. */
function zonedDate(instant: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const at = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return new Date(
    Date.UTC(at('year'), at('month') - 1, at('day'), at('hour') % 24, at('minute'), at('second')),
  );
}

function excelDate(value: string, options: DateOptions, viewerZone: string): Date | null {
  const wall = WALL_DATE.exec(value);
  if (wall) return new Date(Date.UTC(Number(wall[1]), Number(wall[2]) - 1, Number(wall[3])));
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) return null;
  return zonedDate(instant, options.timeZone === 'client' ? viewerZone : options.timeZone);
}

/** Code points of the longest line, so a note with line breaks doesn't stretch a column. */
function displayWidth(text: string): number {
  let widest = 0;
  for (const line of text.split('\n')) widest = Math.max(widest, [...line].length);
  return widest;
}

/** Widens a column while the first page is measured; `widths` is null once they are written. */
function measure(widths: number[] | null, index: number, shown: string): void {
  if (widths) widths[index] = Math.max(widths[index]!, displayWidth(shown));
}

/**
 * One cell.  A value that isn't what its column holds — a formula that returned text in a number
 * column, a date that can't be read — falls back to the same text a CSV cell would carry.
 */
export function cellOf(
  column: ExcelColumn,
  value: CellValue,
  context: FormatContext,
  index: number,
  widths: number[] | null,
): ExcelValue {
  const { field, format } = column;
  switch (field.type) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'count':
    case 'rating':
    case 'duration':
      if (typeof value === 'number' && Number.isFinite(value) && format) {
        measure(widths, index, formatValue(field, value, context));
        return value / (column.divisor ?? 1);
      }
      break;
    case 'date':
    case 'createdTime':
    case 'lastModifiedTime': {
      const date = typeof value === 'string' ? excelDate(value, field.options, context.timeZone) : null;
      if (date && format) {
        measure(widths, index, formatValue(field, value, context));
        return date;
      }
      break;
    }
    case 'checkbox': {
      const checked = value === true;
      measure(widths, index, checked ? 'TRUE' : 'FALSE');
      return checked;
    }
    default:
      break;
  }
  const shown = formatValue(field, value, context);
  measure(widths, index, shown);
  return shown === '' ? undefined : guardFormula(shown);
}

function cellsOf(
  columns: readonly ExcelColumn[],
  row: RowData,
  context: FormatContext,
  widths: number[] | null,
  read: ReadonlyMap<string, StoredField>,
): ExcelValue[] {
  return columns.map((column, index) => {
    if (column.field.type !== 'button')
      return cellOf(column, cellValue(row, column.field), context, index, widths);
    // A button's cell is its link, worded as the CSV cell is.
    const link = buttonLink(column.field, row, read, context) ?? '';
    measure(widths, index, link);
    return link === '' ? undefined : guardFormula(link);
  });
}

export function columnWidth(header: string, widest: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.max(displayWidth(header), widest) + 2));
}

/** A spreadsheet column letter from a one-based number, for the filter's range. */
export function columnLetter(index: number): string {
  let letter = '';
  for (let rest = index; rest > 0; rest = Math.floor((rest - 1) / 26))
    letter = `${String.fromCharCode(65 + ((rest - 1) % 26))}${letter}`;
  return letter;
}

/** The workbook as a stream a reply can send while records are still being read. */
export function xlsxStream(source: ExportSource, order: ExportOrder): Readable {
  const output = new PassThrough();
  void write(output, source, order).catch((error: unknown) => {
    // The status and headers are long gone, so all that's left is to end a truncated file.
    output.destroy(error instanceof Error ? error : new Error(String(error)));
  });
  return output;
}

async function write(output: PassThrough, source: ExportSource, order: ExportOrder): Promise<void> {
  const columns = excelColumns(source.fields, source.locale);
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: output, useStyles: true });
  const config = source.read.view.config;
  for (const column of columns) {
    if (!config.iconSets.some((set) => set.fieldId === column.field.id)) continue;
    if (column.field.type === 'rating') column.format = '0';
    if (column.field.type === 'duration') {
      column.divisor = 86_400;
      column.format = column.field.options.format
        .replace(/^h/, '[h]')
        .replace(/\.s+$/, (fraction) => `.${'0'.repeat(fraction.length - 1)}`);
    }
  }
  // Pins, column groups, header colors, and frozen columns arrange a grid.  Another kind of view
  // exports the way it did before them, whatever its stored settings say.
  const grid = source.read.view.type === 'grid';
  const hasGroups =
    grid &&
    config.columnGroups.some((group) => columns.some((column) => group.fieldIds.includes(column.field.id)));
  const headerRow = hasGroups ? 2 : 1;
  const xSplit = grid ? Math.min(config.frozenFieldCount, columns.length) : 0;
  const ySplit = headerRow + (grid ? (order.pinnedCount ?? 0) : 0);
  const firstScrollableCell = `${columnLetter(xSplit + 1)}${ySplit + 1}`;
  const worksheet = workbook.addWorksheet(sheetName(source.read.view.name), {
    views: [
      {
        ...FROZEN_HEADER[0]!,
        xSplit,
        ySplit,
        topLeftCell: firstScrollableCell,
        activeCell: firstScrollableCell,
      },
    ],
  });
  const tint = (cell: ExcelJS.Cell, color: ChoiceColor | undefined) => {
    if (!color) return;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${HEADER_COLOR_RGB[color]}` } };
    cell.font = { bold: true, color: { argb: 'FF202020' } };
  };
  const lineSheets = await Promise.all(
    source.fields
      .filter((field) => field.type === 'lineItems')
      .map(async (field) => {
        const fields = field.lineColumns ?? [];
        const columns = excelColumns(fields, source.locale);
        const table = await loadTable(source.pool, source.schemas, field.options.linkedTableId);
        const sheet = workbook.addWorksheet(sheetName(`${field.name.slice(0, 22)} ${field.id.slice(-6)}`), {
          views: FROZEN_HEADER,
        });
        sheet.columns = [
          { width: 24 },
          ...columns.map((column) => ({
            width: columnWidth(column.field.name, 18),
            ...(column.format ? { style: { numFmt: column.format } } : {}),
          })),
        ];
        const header = sheet.addRow([
          guardFormula(source.read.table.name),
          ...columns.map((column) => guardFormula(column.field.name)),
        ]);
        header.font = { bold: true };
        header.commit();
        return { field, fields, columns, table, sheet };
      }),
  );
  async function appendLines(parent: RowData, context: FormatContext) {
    for (const entry of lineSheets) {
      if (!entry.table) continue;
      const ids = idsOf(parent.values[entry.field.id] ?? null);
      for (let start = 0; start < ids.length; start += 500) {
        const rows = await fetchRowsById(
          source.pool,
          source.schemas.data,
          entry.table.id,
          entry.fields,
          ids.slice(start, start + 500),
        );
        const byId = new Map(rows.map((row) => [row.id, row]));
        const related = await relationContext({
          db: source.pool,
          schemas: source.schemas,
          scope: source.scope,
          table: entry.table,
          fields: entry.fields,
          rows,
          names: true,
        });
        const read = new Map(entry.fields.map((field) => [field.id, field]));
        for (const id of ids.slice(start, start + 500)) {
          const row = byId.get(id);
          if (row)
            entry.sheet
              .addRow([parent.id, ...cellsOf(entry.columns, row, { ...context, ...related }, null, read)])
              .commit();
        }
      }
    }
  }
  const pages = exportPages(source, order);
  const widths = columns.map((column) => displayWidth(column.field.name));
  const first = await pages.next();
  // The first page is held back only long enough to measure it: the writer puts the column
  // definitions in the file before the first row, so a long download sizes itself from a sample.
  const held = first.done
    ? []
    : first.value.rows.map((row) => cellsOf(columns, row, first.value.context, widths, first.value.read));
  worksheet.columns = columns.map((column, index) => ({
    width: columnWidth(column.field.name, widths[index]!),
    ...(column.format ? { style: { numFmt: column.format } } : {}),
  }));
  if (columns.length) worksheet.autoFilter = `A${headerRow}:${columnLetter(columns.length)}${headerRow}`;
  if (hasGroups) {
    const band = worksheet.getRow(1);
    for (let index = 0; index < columns.length;) {
      const group = config.columnGroups.find((item) => item.fieldIds.includes(columns[index]!.field.id));
      let end = index + 1;
      while (group && end < columns.length && group.fieldIds.includes(columns[end]!.field.id)) end++;
      if (group) {
        band.getCell(index + 1).value = guardFormula(group.name);
        if (end > index + 1) worksheet.mergeCells(1, index + 1, 1, end);
        for (let column = index + 1; column <= end; column++) tint(band.getCell(column), group.color);
      }
      index = end;
    }
    band.commit();
  }
  const header = worksheet.getRow(headerRow);
  header.values = columns.map((column) => guardFormula(column.field.name));
  header.font = { bold: true };
  columns.forEach((column, index) =>
    tint(header.getCell(index + 1), grid ? config.headerColors[column.field.id] : undefined),
  );
  header.commit();
  const sparklines = config.sparklines.length
    ? new ExcelSparklines(workbook, source.fields, config.sparklines)
    : null;
  try {
    let recordCount = held.length;
    for (const [index, cells] of held.entries()) {
      sparklines?.row(first.value!.rows[index]!, headerRow + index + 1);
      worksheet.addRow(cells).commit();
      await appendLines(first.value!.rows[index]!, first.value!.context);
    }
    for (let page = await pages.next(); !page.done; page = await pages.next()) {
      // A reader that went away ends the response; there's no point reading the rest of the view.
      if (output.destroyed) return;
      const { rows, context, read } = page.value;
      for (const row of rows) {
        recordCount++;
        sparklines?.row(row, headerRow + recordCount);
        worksheet.addRow(cellsOf(columns, row, context, null, read)).commit();
        await appendLines(row, context);
      }
      await drained(output);
    }
    if (recordCount)
      for (const set of config.iconSets) {
        const index = columns.findIndex(
          (column) => column.field.id === set.fieldId && isBarField(column.field),
        );
        if (index < 0) continue;
        const letter = columnLetter(index + 1);
        const divisor = columns[index]!.divisor ?? 1;
        const low: ExcelJS.Cvfo = { type: 'num', value: set.thresholds[0] / divisor };
        const high: ExcelJS.Cvfo = { type: 'num', value: set.thresholds[1] / divisor };
        // The streaming writer supports native rating bars; repeating thresholds yields three bands.
        worksheet.addConditionalFormatting({
          ref: `${letter}${headerRow + 1}:${letter}${headerRow + recordCount}`,
          rules: [
            {
              type: 'iconSet',
              priority: index + 1,
              showValue: true,
              iconSet: set.style === 'arrows' ? '3Arrows' : set.style === 'flags' ? '3Flags' : '5Rating',
              cfvo:
                set.style === 'ratings'
                  ? [{ type: 'min' }, low, low, high, high]
                  : [{ type: 'min' }, low, high],
            },
          ],
        });
      }
    sparklines?.finish(worksheet);
    for (const entry of lineSheets) await entry.sheet.commit();
    await worksheet.commit();
    await workbook.commit();
  } finally {
    sparklines?.dispose();
  }
}

/**
 * The writer never waits for a slow reader, so the pages do: without this, a download nobody is
 * reading would buffer the whole workbook in the socket instead of on disk in front of them.
 */
async function drained(output: PassThrough): Promise<void> {
  if (output.destroyed || !output.writableNeedDrain) return;
  await Promise.race([once(output, 'drain'), once(output, 'close')]);
}
