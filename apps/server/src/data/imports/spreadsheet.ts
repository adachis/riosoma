import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type ExcelJS from 'exceljs';
import { AppError, LIMITS, SPREADSHEET_LIMITS, type SheetCell } from '@riosoma/contracts';
import { entryBytes, entryStream, zipEntries, ZipTooLarge, type ZipEntry } from './zip.js';

/**
 * Reads an uploaded workbook for importing, with ExcelJS's streaming reader: its parsers read the
 * workbook's parts and stream each sheet's rows, so a large sheet is never held whole.  The zip
 * around them is read here, from its directory, because the reader's own pass over the archive
 * stops after the first sheet on current versions of Node.  That also means shared strings are
 * read before any sheet, so no sheet waits in a temporary file.  Merged cells are the one thing the
 * reader skips, and a sheet lists its merges only after its rows, so a quick scan of each sheet's
 * XML finds them first and the rows then carry each merged value in every cell it covers, the way
 * the sheet shows it.
 */

export type SpreadsheetEvent =
  | { kind: 'sheet'; name: string; position: number }
  | { kind: 'row'; number: number; cells: SheetCell[] }
  | { kind: 'end'; rows: number; total: number };

export interface SpreadsheetOptions {
  /** Reading stops with a clear message once this fires */
  signal?: AbortSignal;
  /** Rows a sheet sends.  Later ones are only counted. */
  rowsPerSheet?: number;
}

export interface Range {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface WorkbookWorksheet {
  name: string;
  hidden: boolean;
  date1904: boolean;
  merges: Range[];
  rows: AsyncIterable<ExcelJS.Row>;
  /** The streaming parser loses these cached formula types, which extraction must retain. */
  cachedResults: ReadonlyMap<string, boolean | ExcelJS.CellErrorValue>;
  /** The streaming parser keeps only the last inline run and decodes its text twice. */
  inlineStrings: ReadonlyMap<string, string>;
}

type WorksheetReader = ExcelJS.stream.xlsx.WorksheetReader;

// Load only the streaming constructor to leave the worker's budget for worksheet values.
const WorkbookReader = createRequire(import.meta.url)(
  'exceljs/lib/stream/xlsx/workbook-reader.js',
) as typeof ExcelJS.stream.xlsx.WorkbookReader;

/** The reader's part parsers, which it keeps to itself, and what they leave behind. */
interface ReaderParts {
  _parseRels(entry: Readable): Promise<void>;
  _parseWorkbook(entry: Readable): Promise<void>;
  _parseSharedStrings(entry: Readable): AsyncGenerator<unknown>;
  _parseStyles(entry: Readable): Promise<void>;
  _parseWorksheet(
    iterator: AsyncIterable<string>,
    sheetNo: string,
  ): Generator<{ eventType: string; value: WorksheetReader }, void>;
  sharedStrings?: unknown[];
  workbookRels?: Array<{ Id?: string; Type?: string; Target?: string }>;
  model?: { sheets?: Array<{ name?: string; rId?: string; state?: string }> };
  properties?: { model?: { date1904?: boolean } };
}

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
/** Older `.xls` workbooks and password-protected ones are both compound files. */
const COMPOUND = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);
const DAY = 86_400_000;
/** Day zero of a 1900 workbook, when a cell holds only a time. */
const TIME_ONLY_BEFORE = Date.UTC(1899, 11, 31);
/** The most a workbook's shared strings may take once unpacked.  Other small parts get less. */
const STRINGS_LIMIT = 256 * 1024 * 1024;
const PART_LIMIT = 16 * 1024 * 1024;
/** The parser buffers a chunk's XML events, so small chunks also bound its live row objects. */
const TEXT_CHUNK = 16 * 1024;

const notSpreadsheet = () => new AppError('validation_failed', 'import.spreadsheet.notSpreadsheet');
const tooLarge = () =>
  new AppError('payload_too_large', 'import.spreadsheet.tooLarge', {
    params: { megabytes: SPREADSHEET_LIMITS.uploadBytes / 1024 / 1024 },
  });
const timedOut = () =>
  new AppError('validation_failed', 'import.spreadsheet.timeout', {
    params: { minutes: SPREADSHEET_LIMITS.seconds / 60 },
  });

function failure(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZipTooLarge) return tooLarge();
  return new AppError('validation_failed', 'import.spreadsheet.unreadable', { cause: error });
}

/** Refuses anything that isn't an `.xlsx` workbook before a reader is spent on it. */
export function checkSignature(bytes: Buffer): void {
  const head = bytes.subarray(0, 4);
  if (head.equals(ZIP)) return;
  if (head.equals(COMPOUND)) throw new AppError('validation_failed', 'import.spreadsheet.legacy');
  throw notSpreadsheet();
}

/**
 * Text as whole characters, in small pieces.  The reader decodes each piece it's
 * given on its own, so a character split between two pieces would come out garbled.  `limit`
 * refuses a part that unpacks to more bytes than that.
 */
async function* text(source: Readable, signal?: AbortSignal, limit = STRINGS_LIMIT): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let size = 0;
  let tokenSize = 0;
  for await (const chunk of source) {
    if (signal?.aborted) throw timedOut();
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > limit) throw new ZipTooLarge();
    const decoded = decoder.write(bytes);
    // Bound XML tokens before a parser can accumulate an oversized value or attribute.
    for (const character of decoded) {
      tokenSize = character === '<' || character === '>' ? 0 : tokenSize + 1;
      if (tokenSize > LIMITS.longTextLength * 6) throw new ZipTooLarge();
    }
    pending += decoded;
    while (pending.length >= TEXT_CHUNK) {
      let end = TEXT_CHUNK;
      const last = pending.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end--;
      yield pending.slice(0, end);
      pending = pending.slice(end);
    }
  }
  pending += decoder.end();
  if (pending) yield pending;
}

function columnNumber(letters: string): number {
  let number = 0;
  for (const letter of letters) number = number * 26 + (letter.charCodeAt(0) - 64);
  return number;
}

const REF = /^([A-Z]{1,3})(\d{1,7})$/;

/** A merged range, or null for a single cell or a reference that isn't one. */
export function rangeOf(ref: string): Range | null {
  const [from, to] = ref.toUpperCase().split(':');
  const start = REF.exec(from ?? '');
  const end = REF.exec(to ?? '');
  if (!start || !end) return null;
  const range = {
    top: Math.min(Number(start[2]), Number(end[2])),
    left: Math.min(columnNumber(start[1]!), columnNumber(end[1]!)),
    bottom: Math.max(Number(start[2]), Number(end[2])),
    right: Math.max(columnNumber(start[1]!), columnNumber(end[1]!)),
  };
  return range.top === range.bottom && range.left === range.right ? null : range;
}

const MERGE = /<(?:[A-Za-z_][\w.-]*:)?mergeCell\b[^>]*?\bref\s*=\s*(["'])([^"']+)\1/g;
const CELL = /<c\b(?![^>]*\/>)([^>]*)>([\s\S]*?)<\/c>/g;

function xmlText(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (!entity.startsWith('#')) return entities[entity] ?? _;
    const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : _;
  });
}

/**
 * Merges, inline strings, and cached result types the streaming parser loses.  Unfinished tags
 * and cells wait for the next chunk, so their values survive a chunk boundary.
 */
async function worksheetMetadata(
  xml: AsyncIterable<string>,
  preserveCellValues: boolean,
): Promise<{
  merges: Range[];
  cachedResults: Map<string, boolean | ExcelJS.CellErrorValue>;
  inlineStrings: Map<string, string>;
}> {
  const ranges: Range[] = [];
  const cachedResults = new Map<string, boolean | ExcelJS.CellErrorValue>();
  const inlineStrings = new Map<string, string>();
  let carried = '';
  const scan = (piece: string) => {
    for (const match of piece.matchAll(MERGE)) {
      const range = rangeOf(match[2]!);
      if (range) ranges.push(range);
    }
    if (!preserveCellValues) return;
    for (const match of piece.matchAll(CELL)) {
      const type = /\bt\s*=\s*(["'])(b|e|inlineStr)\1/.exec(match[1]!);
      const address = /\br\s*=\s*(["'])([A-Z]+\d+)\1/.exec(match[1]!);
      if (!type || !address) continue;
      if (type[2] === 'inlineStr') {
        const inline = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(match[2]!);
        if (inline) {
          const runs = inline[1]!.matchAll(/<t\b[^>]*>([^<]*)<\/t>/g);
          // Decode each run before joining, since separate runs can spell a literal entity together.
          inlineStrings.set(address[2]!, Array.from(runs, (run) => xmlText(run[1]!)).join(''));
        }
        continue;
      }
      const value = /<v\b[^>]*>([^<]*)<\/v>/.exec(match[2]!);
      if (!value || !/<f(?:\s|\/?>)/.test(match[2]!)) continue;
      cachedResults.set(
        address[2]!,
        type[2] === 'b'
          ? Number(xmlText(value[1]!)) !== 0
          : ({ error: xmlText(value[1]!) } as ExcelJS.CellErrorValue),
      );
    }
  };
  for await (const chunk of xml) {
    const piece = carried + chunk;
    const open = piece.lastIndexOf('<');
    let cut = open >= 0 && piece.indexOf('>', open) < 0 ? open : piece.length;
    if (preserveCellValues) {
      // Keep an unfinished cell too, since its inline text or cached result can cross a chunk boundary.
      let cellStart = piece.lastIndexOf('<c');
      // Font color tags also start with "<c", but carrying only their text would lose earlier runs.
      while (cellStart >= 0 && !/^<c\b/.test(piece.slice(cellStart, cellStart + 3)))
        cellStart = cellStart === 0 ? -1 : piece.lastIndexOf('<c', cellStart - 1);
      if (cellStart >= 0 && piece.indexOf('</c>', cellStart) < 0) {
        const tagEnd = piece.indexOf('>', cellStart);
        if (
          tagEnd < 0 ||
          (piece[tagEnd - 1] !== '/' &&
            /\bt\s*=\s*(["'])(b|e|inlineStr)\1/.test(piece.slice(cellStart, tagEnd)))
        )
          cut = Math.min(cut, cellStart);
      }
    }
    scan(piece.slice(0, cut));
    carried = piece.slice(cut);
  }
  scan(carried);
  return { merges: ranges, cachedResults, inlineStrings };
}

/** ExcelJS's own test for a date format: date letters outside quotes and brackets. */
export function isDateFormat(format: string | undefined): boolean {
  if (!format) return false;
  const bare = format.replace(/\[[^\]]*]/g, '').replace(/"[^"]*"/g, '');
  return /[ymdhMsb]+/.test(bare);
}

function showsTime(format: string | undefined): boolean {
  if (!format) return false;
  return /[hs]|AM\/PM|A\/P/i.test(format.replace(/\[[^\]]*]/g, '').replace(/"[^"]*"/g, ''));
}

const pad = (value: number, size = 2) => String(value).padStart(size, '0');

/**
 * A date as its wall-clock reading.  A value with no date part (a time on its own) reads as text,
 * since there's no day for it to fall on.
 */
function dateCell(date: Date, format: string | undefined): SheetCell {
  const ms = Math.round(date.getTime() / 1000) * 1000;
  if (!Number.isFinite(ms)) return null;
  const at = new Date(ms);
  if (ms < TIME_ONLY_BEFORE) {
    const seconds = at.getUTCSeconds() ? `:${pad(at.getUTCSeconds())}` : '';
    return `${at.getUTCHours()}:${pad(at.getUTCMinutes())}${seconds}`;
  }
  const day = `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  if (ms % DAY === 0 && !showsTime(format)) return { date: day };
  return {
    date: `${day}T${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`,
  };
}

/** A spreadsheet keeps fifteen significant digits, so the noise past them isn't part of the value. */
function numberCell(value: number): SheetCell {
  return Number.isFinite(value) ? Number(value.toPrecision(15)) : null;
}

/** Serial day numbers from the workbook's epoch, as ExcelJS converts plain dates. */
function serialDate(serial: number, date1904: boolean): Date {
  return new Date(Math.round((serial - (date1904 ? 24107 : 25569)) * DAY));
}

function textOf(value: ExcelJS.CellRichTextValue | string): string {
  return typeof value === 'string' ? value : value.richText.map((part) => part.text).join('');
}

/**
 * A formula's cached result.  The reader turns an error result into a number it can't read, which
 * leaves only the fact of the error, not its text.
 */
function resultCell(result: unknown, format: string | undefined, date1904: boolean): SheetCell {
  if (result === null || result === undefined) return null;
  if (typeof result === 'number') {
    if (Number.isNaN(result)) return { error: '' };
    return isDateFormat(format) ? dateCell(serialDate(result, date1904), format) : numberCell(result);
  }
  if (typeof result === 'string') return result === '' ? null : result;
  if (typeof result === 'boolean') return result;
  if (result instanceof Date) return dateCell(result, format);
  if (typeof result === 'object' && 'error' in result) return { error: String(result.error) };
  return null;
}

export function cellOf(cell: ExcelJS.Cell, date1904: boolean): SheetCell {
  const value = cell.value;
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number') return numberCell(value);
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return dateCell(value, cell.numFmt);
  if ('richText' in value) return textOf(value) || null;
  if ('error' in value) return { error: String(value.error) };
  if ('formula' in value || 'sharedFormula' in value) {
    // The value drops a result of zero, but the cell itself still has it.
    const result: unknown = (cell as { result?: unknown }).result ?? value.result;
    return resultCell(result, cell.numFmt, date1904);
  }
  if ('hyperlink' in value) return textOf(value.text) || null;
  return null;
}

/** The merges that reach a row, kept as the rows go by. */
class MergeFill {
  private readonly pending: Range[];
  private active: Array<{ range: Range; value: SheetCell }> = [];
  constructor(ranges: readonly Range[]) {
    this.pending = [...ranges].sort((a, b) => b.top - a.top);
  }
  /** The last row a merge reaches, for rows the sheet leaves out at its end. */
  get reach(): number {
    return Math.max(
      0,
      ...this.pending.map((range) => range.bottom),
      ...this.active.map((item) => item.range.bottom),
    );
  }
  covers(row: number): boolean {
    this.advance(row);
    return this.active.length > 0;
  }
  fill(row: number, cells: SheetCell[]): void {
    this.advance(row);
    for (const item of this.active) {
      const { range } = item;
      if (range.top === row) item.value = cells[range.left - 1] ?? null;
      for (let column = range.left; column <= range.right; column++) {
        if (row === range.top && column === range.left) continue;
        cells[column - 1] = item.value;
      }
    }
  }
  private advance(row: number): void {
    while (this.pending.length && this.pending.at(-1)!.top <= row)
      this.active.push({ range: this.pending.pop()!, value: null });
    this.active = this.active.filter((item) => item.range.bottom >= row);
  }
}

/** A row's cells from its first column, without the empty ones at its end. */
function trimmed(cells: SheetCell[]): SheetCell[] {
  let end = cells.length;
  while (end > 0 && (cells[end - 1] === null || cells[end - 1] === undefined)) end--;
  const row = cells.slice(0, end);
  for (let index = 0; index < row.length; index++) row[index] ??= null;
  return row;
}

/** A part named in a relationship, as a path inside the archive. */
function partPath(target: string): string {
  return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
}

async function readPart(
  parse: (entry: Readable) => Promise<unknown>,
  bytes: Buffer,
  entry: ZipEntry | undefined,
): Promise<void> {
  if (entry) await parse(Readable.from([entryBytes(bytes, entry, PART_LIMIT).toString('utf8')]));
}

/** Opens worksheet parts in tab order, without applying table import limits or filling merges. */
export async function* readWorkbook(
  bytes: Buffer,
  {
    signal,
    preserveCellValues = true,
  }: Pick<SpreadsheetOptions, 'signal'> & {
    preserveCellValues?: boolean;
  } = {},
): AsyncGenerator<WorkbookWorksheet> {
  checkSignature(bytes);
  const entries = zipEntries(bytes);
  const workbookEntry = entries.get('xl/workbook.xml');
  if (!workbookEntry) throw notSpreadsheet();
  const reader = new WorkbookReader(Readable.from([]), {
    worksheets: 'emit',
    sharedStrings: 'cache',
    styles: 'cache',
    hyperlinks: 'ignore',
    entries: 'ignore',
  }) as unknown as ReaderParts;
  await readPart((entry) => reader._parseRels(entry), bytes, entries.get('xl/_rels/workbook.xml.rels'));
  await readPart((entry) => reader._parseWorkbook(entry), bytes, workbookEntry);
  await readPart((entry) => reader._parseStyles(entry), bytes, entries.get('xl/styles.xml'));
  const strings = entries.get('xl/sharedStrings.xml');
  if (strings) {
    const source = Readable.from(text(entryStream(bytes, strings), signal, STRINGS_LIMIT));
    for await (const _event of reader._parseSharedStrings(source)) if (signal?.aborted) throw timedOut();
  }
  reader.sharedStrings ??= [];
  const date1904 = Boolean(reader.properties?.model?.date1904);
  const relations = new Map((reader.workbookRels ?? []).map((relation) => [relation.Id, relation]));
  let position = 0;
  for (const sheet of reader.model?.sheets ?? []) {
    const relation = relations.get(sheet.rId);
    // Chart sheets and dialog sheets have no worksheet grid.
    if (!relation?.Target || !relation.Type?.endsWith('/worksheet')) continue;
    const path = partPath(relation.Target);
    const entry = entries.get(path);
    if (!entry) continue;
    if (signal?.aborted) throw timedOut();
    const metadata = await worksheetMetadata(text(entryStream(bytes, entry), signal), preserveCellValues);
    const worksheet = reader._parseWorksheet(text(entryStream(bytes, entry), signal), path).next()
      .value?.value;
    if (!worksheet) throw notSpreadsheet();
    const rows = async function* (): AsyncGenerator<ExcelJS.Row> {
      for await (const row of worksheet) {
        if (signal?.aborted) throw timedOut();
        yield row;
      }
    };
    yield {
      name: sheet.name ?? `Sheet${position + 1}`,
      hidden: sheet.state === 'hidden' || sheet.state === 'veryHidden',
      date1904,
      ...metadata,
      rows: rows(),
    };
    position++;
  }
}

/**
 * Reads the workbook, sheet by sheet, in tab order.  A file that isn't a workbook, or one that turns
 * out to be damaged, fails with a message the person can act on, and so does one that takes too long.
 */
export async function* readSpreadsheet(
  bytes: Buffer,
  options: SpreadsheetOptions = {},
): AsyncGenerator<SpreadsheetEvent> {
  const { signal } = options;
  const cap = options.rowsPerSheet ?? SPREADSHEET_LIMITS.rowsPerSheet;
  checkSignature(bytes);
  try {
    let position = 0;
    let responseBytes = 0;
    // Table imports use parser values and do not need a second copy of inline cells or cached results.
    for await (const sheet of readWorkbook(bytes, { signal, preserveCellValues: false })) {
      const { name, date1904 } = sheet;
      yield { kind: 'sheet', name, position: position++ };
      const fill = new MergeFill(sheet.merges);
      let rows = 0;
      let total = 0;
      let last = 0;
      const emit = function* (number: number, cells: SheetCell[]): Generator<SpreadsheetEvent> {
        fill.fill(number, cells);
        const row = trimmed(cells);
        if (!row.length) return;
        if (row.length > LIMITS.fieldsPerTable)
          throw new AppError('validation_failed', 'import.spreadsheet.tooWide', {
            params: { sheet: name, columns: LIMITS.fieldsPerTable },
          });
        total++;
        if (rows < cap) {
          // Shared strings and merged cells can repeat a small part into a much larger response.
          let rowBytes = 16;
          for (const value of row) {
            rowBytes += Buffer.byteLength(JSON.stringify(value)) + 1;
            if (responseBytes + rowBytes > STRINGS_LIMIT) throw tooLarge();
          }
          responseBytes += rowBytes;
          rows++;
          yield { kind: 'row', number, cells: row };
        }
      };
      for await (const row of sheet.rows) {
        if (signal?.aborted) throw timedOut();
        // Rows the sheet leaves out are empty, unless a merge reaches into them.
        for (let gap = last + 1; gap < row.number; gap++) if (fill.covers(gap)) yield* emit(gap, []);
        last = row.number;
        const cells: SheetCell[] = [];
        row.eachCell({ includeEmpty: false }, (cell, column) => {
          const value = cellOf(cell, date1904);
          if (typeof value === 'string' && value.length > LIMITS.longTextLength) throw tooLarge();
          if (value && typeof value === 'object' && 'error' in value && value.error.length > 64)
            throw tooLarge();
          cells[column - 1] = value;
        });
        yield* emit(row.number, cells);
      }
      for (let gap = last + 1, reach = fill.reach; gap <= reach; gap++)
        if (fill.covers(gap)) yield* emit(gap, []);
      yield { kind: 'end', rows, total };
    }
    if (!position) throw notSpreadsheet();
  } catch (error) {
    throw failure(error);
  }
}
