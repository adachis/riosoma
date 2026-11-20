import type { CellValue, SheetCell, SourceColumn } from '@riosoma/contracts';

/**
 * How a file source reads the cells of a CSV file, a TSV file, or a workbook: the same rules the
 * upload importer uses (`apps/web/src/screens/import/columns.ts` and the grid's own reading of pasted
 * text), so a file synced from a bucket and the same file imported by hand agree on every column's
 * type and every date.  A CSV cell is text, and a workbook's cells keep their types, so a number
 * stays a number and a date stays a date.
 *
 * Two things differ, both because a sync has no person behind it.  A date with a time and no zone
 * reads as UTC, where the importer reads it in the importing person's zone, and a column of a few
 * repeated values is offered as a single select rather than suggested as one, since a synced
 * column's choices grow with the source.
 */

export type FileCell = SheetCell;

/** What the importer notices about a column's first thousand values. */
export interface CellStats {
  count: number;
  number: boolean;
  checkbox: boolean;
  email: boolean;
  url: boolean;
  mdy: boolean;
  dmy: boolean;
  time: boolean;
  long: boolean;
  precision: number;
}

export type CellType = 'text' | 'longText' | 'number' | 'date' | 'dateTime' | 'checkbox' | 'email' | 'url';

/** How one column's cells are read: its type, and for dates, which way round a numeric one goes. */
export interface CellReading {
  type: CellType;
  precision: number;
  dateOrder: 'mdy' | 'dmy';
}

/** Values the importer looks at per column before it decides. */
export const SAMPLE_VALUES = 1_000;

const BOOLEAN_TEXT = /^(true|false|yes|no|1|0|x|checked|unchecked|on|off|y|n)$/i;
/** Words that uncheck a box.  Anything else the importer accepts as a checkbox checks it. */
const UNCHECKED = new Set(['false', 'no', 'n', '0', 'unchecked', 'off']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LONG_TEXT = 255;
const MOST_DECIMALS = 8;

export function isDateCell(cell: FileCell | undefined): cell is { date: string } {
  return typeof cell === 'object' && cell !== null && 'date' in cell;
}

function isErrorCell(cell: FileCell | undefined): cell is { error: string } {
  return typeof cell === 'object' && cell !== null && 'error' in cell;
}

function isBlank(cell: FileCell | undefined): boolean {
  return cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '');
}

/** A cell as text: what a text field stores, the way the importer writes it. */
export function cellText(cell: FileCell | undefined): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number') return String(cell);
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
  if (isDateCell(cell)) return cell.date.replace('T', ' ');
  return cell.error;
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'ftp:'].includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- numbers

const SPACE_LIKE = /[\u00A0\u2007\u2009\u202F\u200B\uFEFF]/g;
const NEGATIVE_SIGNS = ['-', '\u2212', '\u2013', '\u2011'];
const CURRENCY = /^(?:R\$|US\$|\p{Sc})+\s*|\s*(?:R\$|US\$|\p{Sc})+$/gu;

/** Digits under one reading of the separators, or null when they don't fit it. */
function readNumber(text: string, decimal: string, groups: readonly string[]): number | null {
  let integer = '';
  let fraction = '';
  let inFraction = false;
  let grouped = -1;
  for (const character of text) {
    if (character >= '0' && character <= '9') {
      if (inFraction) fraction += character;
      else integer += character;
      continue;
    }
    if (inFraction) return null;
    if (character === decimal) {
      if (grouped >= 0 && integer.length - grouped !== 3) return null;
      inFraction = true;
      continue;
    }
    if (groups.includes(character)) {
      if (integer.length === 0) return null;
      if (grouped < 0 ? integer.length > 3 : integer.length - grouped !== 3) return null;
      grouped = integer.length;
      continue;
    }
    return null;
  }
  if (grouped >= 0 && integer.length - grouped !== 3) return null;
  if (integer === '' && fraction === '') return null;
  const value = Number(`${integer === '' ? '0' : integer}.${fraction}`);
  return Number.isFinite(value) ? value : null;
}

/**
 * A number as a person writes one, read the way the importer reads it in American English:
 * grouping, a currency symbol, a percent sign, and parentheses or a sign for negatives, then the
 * two plain readings that cover numbers written in other locales.
 */
export function parseNumber(input: string): number | null {
  let text = input.replace(SPACE_LIKE, ' ').replace(/\s+/g, ' ').trim();
  let negative = false;
  const parenthesized = /^\((.*)\)$/.exec(text);
  if (parenthesized !== null) {
    negative = true;
    text = parenthesized[1]!.trim();
  }
  text = text.replace(CURRENCY, '').trim();
  text = text.replace(/\s*%$/, '').trim();
  if (NEGATIVE_SIGNS.includes(text.charAt(0))) {
    negative = !negative;
    text = text.slice(1).trim();
  } else if (text.charAt(0) === '+') {
    text = text.slice(1).trim();
  }
  if (NEGATIVE_SIGNS.includes(text.charAt(text.length - 1))) {
    negative = !negative;
    text = text.slice(0, -1).trim();
  }
  if (text === '') return null;
  // American English's own reading, which is also the plain one, then the one other locales write.
  for (const [mark, groups] of [
    ['.', [',', ' ']],
    [',', ['.', ' ']],
  ] as const) {
    const value = readNumber(text, mark, groups);
    if (value !== null) return negative && value !== 0 ? -value : value;
  }
  return null;
}

// ------------------------------------------------------------------ dates

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const NUMERIC_DATE = /^(\d{1,4})\s*([/.-])\s*(\d{1,4})\s*\2\s*(\d{1,4})\s*\.?$/;
const ISO_DATE =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[Tt ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(?:\s*([Zz])|\s*([+-])(\d{2}):?(\d{2}))?)?$/;
const CLOCK = /(\d{1,2}):(\d{2})(?::(\d{2}))?/;
const MERIDIEM = '(?:[ap]\\.?\\s?m\\.?|午前|午後|오전|오후|上午|下午|凌晨|早上|中午|晚上)';
const MERIDIEM_PATTERN = new RegExp(MERIDIEM, 'i');
const MERIDIEM_HOUR = new RegExp(`(?:(${MERIDIEM})\\s*(\\d{1,2})|(\\d{1,2})\\s*(${MERIDIEM}))`, 'i');
const MERIDIEM_WINDOW = 10;
const ZONE_SUFFIX = /[\s,]*\[?(?:(?:GMT|UTC)\s*[+\-\u2212]\d{1,2}(?::?\d{2})?|[A-Z]{2,5})\]?$/u;
const DATE_PADDING = /^[\s,;:.\u202F-]+|[\s,;:.\u202F-]+$/g;

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function expandYear(text: string): number {
  const year = Number(text);
  return text.length > 2 ? year : year <= 69 ? 2000 + year : 1900 + year;
}

/**
 * A numeric date written year first, month first, or day first, rewritten year first, as the
 * importer does before reading it, so the order never changes from one row to the next.
 */
export function normalizeDate(text: string, order: 'mdy' | 'dmy'): string | null {
  const match = /^(\d{1,4})([/.-])(\d{1,2})\2(\d{1,4})(.*)$/.exec(text.trim());
  if (!match) return null;
  const yearFirst = match[1]!.length === 4;
  const yearText = yearFirst ? match[1]! : match[4]!;
  const rawYear = Number(yearText);
  const year = yearText.length <= 2 ? rawYear + (rawYear <= 69 ? 2000 : 1900) : rawYear;
  const month = Number(yearFirst ? match[3] : order === 'mdy' ? match[1] : match[3]);
  const day = Number(yearFirst ? match[4] : order === 'mdy' ? match[3] : match[1]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}${match[5]}`;
}

function withoutZone(text: string): string {
  const found = ZONE_SUFFIX.exec(text);
  if (found === null) return text;
  return /^(?:AM|PM)$/i.test(found[0].trim()) ? text : text.slice(0, found.index).trimEnd();
}

function meridiemKind(token: string): 'am' | 'pm' | null {
  const word = token.toLowerCase().replace(/[\s.]/g, '');
  if (word.startsWith('a')) return 'am';
  if (word.startsWith('p')) return 'pm';
  if (/午前|오전|上午|凌晨|早上/.test(word)) return 'am';
  if (/午後|오후|下午|中午|晚上/.test(word)) return 'pm';
  return null;
}

function hourOfDay(hour: number, kind: 'am' | 'pm' | null): number | null {
  if (hour > 23) return null;
  if (kind === null) return hour;
  if (hour < 1 || hour > 12) return null;
  if (kind === 'pm') return hour === 12 ? 12 : hour + 12;
  return hour === 12 ? 0 : hour;
}

function cut(text: string, ranges: ReadonlyArray<readonly [number, number] | null>): string {
  const spans = ranges
    .filter((range): range is readonly [number, number] => range !== null)
    .sort((a, b) => a[0] - b[0]);
  let kept = '';
  let at = 0;
  for (const [start, end] of spans) {
    kept += text.slice(at, Math.max(at, start));
    at = Math.max(at, end);
  }
  return kept + text.slice(at);
}

function adjacentMeridiem(
  text: string,
  start: number,
  end: number,
): { kind: 'am' | 'pm'; span: readonly [number, number] } | null {
  const windows: ReadonlyArray<readonly [number, string]> = [
    [Math.max(0, start - MERIDIEM_WINDOW), text.slice(Math.max(0, start - MERIDIEM_WINDOW), start)],
    [end, text.slice(end, end + MERIDIEM_WINDOW)],
  ];
  for (const [offset, window] of windows) {
    const found = MERIDIEM_PATTERN.exec(window);
    if (found === null) continue;
    const kind = meridiemKind(found[0]);
    if (kind !== null) return { kind, span: [offset + found.index, offset + found.index + found[0].length] };
  }
  return null;
}

function extractTime(
  text: string,
): { clock: { hour: number; minute: number; second: number }; rest: string } | null {
  const clock = CLOCK.exec(text);
  if (clock !== null) {
    const start = clock.index;
    const end = start + clock[0].length;
    const meridiem = adjacentMeridiem(text, start, end);
    const hour = hourOfDay(Number(clock[1]), meridiem === null ? null : meridiem.kind);
    const minute = Number(clock[2]);
    const second = clock[3] === undefined ? 0 : Number(clock[3]);
    if (hour === null || minute > 59 || second > 59) return null;
    return {
      clock: { hour, minute, second },
      rest: cut(text, [[start, end], meridiem === null ? null : meridiem.span]),
    };
  }
  const bare = MERIDIEM_HOUR.exec(text);
  if (bare !== null) {
    const kind = meridiemKind(bare[1] ?? bare[4] ?? '');
    const hour = kind === null ? null : hourOfDay(Number(bare[2] ?? bare[3]), kind);
    if (hour === null) return null;
    return {
      clock: { hour, minute: 0, second: 0 },
      rest: cut(text, [[bare.index, bare.index + bare[0].length]]),
    };
  }
  return null;
}

/** A date the importer can read, with the minutes east of UTC when the text named a zone. */
function parseDate(input: string): { wall: Wall; offsetMinutes: number | null } | null {
  const named = withoutZone(input.trim());
  const iso = ISO_DATE.exec(named);
  if (iso !== null) {
    const wall: Wall = {
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3]),
      hour: iso[4] === undefined ? 0 : Number(iso[4]),
      minute: iso[5] === undefined ? 0 : Number(iso[5]),
      second: iso[6] === undefined ? 0 : Number(iso[6]),
      millisecond: iso[7] === undefined ? 0 : Number(iso[7].slice(0, 3).padEnd(3, '0')),
    };
    if (!isRealDate(wall.year, wall.month, wall.day)) return null;
    if (wall.hour > 23 || wall.minute > 59 || wall.second > 59) return null;
    let offsetMinutes: number | null = null;
    if (iso[8] !== undefined) offsetMinutes = 0;
    else if (iso[9] !== undefined)
      offsetMinutes = (iso[9] === '-' ? -1 : 1) * (Number(iso[10]) * 60 + Number(iso[11] ?? '0'));
    return { wall, offsetMinutes };
  }
  const time = extractTime(named);
  const rest = (time === null ? named : time.rest).replace(DATE_PADDING, '');
  const numeric = NUMERIC_DATE.exec(rest);
  if (numeric === null) return null;
  // What reaches here was rewritten year first, which is the order the importer tries first.
  const [a, b, c] = [numeric[1]!, numeric[3]!, numeric[4]!];
  const orders: Array<[string, string, string]> =
    a.length === 4
      ? [
          [a, b, c],
          [c, a, b],
          [c, b, a],
        ]
      : [
          [c, a, b],
          [a, b, c],
          [c, b, a],
        ];
  for (const [yearText, monthText, dayText] of orders) {
    const year = expandYear(yearText);
    let month = Number(monthText);
    let day = Number(dayText);
    if (month > 12 && day >= 1 && day <= 12) [month, day] = [day, month];
    if (isRealDate(year, month, day))
      return {
        wall: {
          year,
          month,
          day,
          hour: time?.clock.hour ?? 0,
          minute: time?.clock.minute ?? 0,
          second: time?.clock.second ?? 0,
          millisecond: 0,
        },
        offsetMinutes: null,
      };
  }
  return null;
}

function dayText(wall: Wall): string {
  return `${String(wall.year).padStart(4, '0')}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}`;
}

/** A date as a date field stores it: the day, or with a time, the instant, reading no zone as UTC. */
function storedDate(text: string, includeTime: boolean): string | null {
  const parsed = parseDate(text);
  if (parsed === null) return null;
  if (!includeTime) return dayText(parsed.wall);
  const { wall } = parsed;
  const utc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
    wall.millisecond,
  );
  const date = new Date(utc - (parsed.offsetMinutes ?? 0) * 60_000);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

/** A text date in a date column, read in the column's order, or null when it isn't one. */
function textDate(text: string, order: 'mdy' | 'dmy', includeTime: boolean): string | null {
  const normalized = normalizeDate(text, order);
  return normalized === null ? null : storedDate(normalized, includeTime);
}

// ------------------------------------------------------------------ stats

export function emptyStats(): CellStats {
  return {
    count: 0,
    number: true,
    checkbox: true,
    email: true,
    url: true,
    mdy: true,
    dmy: true,
    time: false,
    long: false,
    precision: 0,
  };
}

/** Takes one cell into a column's stats, as the importer does for its first thousand values. */
export function observe(stats: CellStats, cell: FileCell | undefined): void {
  if (isBlank(cell) || isErrorCell(cell) || stats.count >= SAMPLE_VALUES) return;
  stats.count++;
  if (typeof cell !== 'string') {
    // A typed cell narrows the column to its own type.
    const typed = cell as number | boolean | { date: string };
    stats.number &&= typeof typed === 'number';
    stats.checkbox &&= typeof typed === 'boolean';
    stats.email = false;
    stats.url = false;
    const date = isDateCell(typed);
    stats.mdy &&= date;
    stats.dmy &&= date;
    if (date) stats.time ||= typed.date.includes('T');
    if (typeof typed === 'number') {
      const decimals = /\.(\d+)$/.exec(String(typed))?.[1]?.length ?? 0;
      stats.precision = Math.min(MOST_DECIMALS, Math.max(stats.precision, decimals));
    }
    return;
  }
  const value = cell.trim();
  const number = parseNumber(value);
  stats.number &&= number !== null;
  stats.checkbox &&= BOOLEAN_TEXT.test(value);
  stats.email &&= EMAIL.test(value);
  stats.url &&= isUrl(value);
  if (stats.mdy) stats.mdy = textDate(value, 'mdy', true) !== null;
  if (stats.dmy) stats.dmy = textDate(value, 'dmy', true) !== null;
  stats.time ||= /\d[:]\d|\d\s*[ap]m\b/i.test(value);
  stats.long ||= /[\r\n]/.test(cell) || cell.length > LONG_TEXT;
  if (number !== null) {
    const decimals = /^[+-]?\d{1,3}(,\d{3})+$/.test(value) ? 0 : (/[.,](\d+)$/.exec(value)?.[1]?.length ?? 0);
    stats.precision = Math.min(MOST_DECIMALS, Math.max(stats.precision, decimals));
  }
}

/** The importer's choice of type, in its order of preference. */
export function readingOf(stats: CellStats): CellReading {
  const dateOrder = stats.dmy && !stats.mdy ? 'dmy' : 'mdy';
  const reading = (type: CellType): CellReading => ({ type, precision: stats.precision, dateOrder });
  if (!stats.count) return reading('text');
  if (stats.checkbox) return reading('checkbox');
  if (stats.number) return reading('number');
  if (stats.mdy || stats.dmy) return reading(stats.time ? 'dateTime' : 'date');
  if (stats.email) return reading('email');
  if (stats.url) return reading('url');
  if (stats.long) return reading('longText');
  return reading('text');
}

const PLAIN = ['text', 'longText'];
const TEXT_KINDS = ['text', 'longText', 'email', 'url', 'phone', 'singleSelect', 'multipleSelect'];

/** A column as a file source describes it, with the type the importer would have given it. */
export function cellColumn(name: string, sourceType: string, reading: CellReading): SourceColumn {
  const column = (suggested: SourceColumn['suggested'], alternatives: string[]): SourceColumn => ({
    name,
    sourceType,
    nullable: true,
    suggested,
    alternatives,
  });
  switch (reading.type) {
    case 'number':
      return column({ type: 'number', options: { precision: reading.precision } }, PLAIN);
    case 'checkbox':
      return column({ type: 'checkbox', options: {} }, PLAIN);
    case 'date':
      return column({ type: 'date', options: {} }, PLAIN);
    case 'dateTime':
      return column({ type: 'date', options: { includeTime: true, timeZone: 'UTC' } }, PLAIN);
    default:
      return column(
        { type: reading.type, options: {} },
        TEXT_KINDS.filter((type) => type !== reading.type),
      );
  }
}

/**
 * One cell as a value of the field type it is read as.  A cell that doesn't fit the type, like
 * `n/a` in a column of numbers, arrives empty, as it does when the importer brings in a file.
 */
export function cellValue(cell: FileCell | undefined, fieldType: string, reading: CellReading): CellValue {
  if (isBlank(cell) || isErrorCell(cell)) return null;
  const value = cell as string | number | boolean | { date: string };
  switch (fieldType) {
    case 'number':
    case 'currency':
    case 'percent': {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      return parseNumber(cellText(value).trim());
    }
    case 'checkbox': {
      if (typeof value === 'boolean') return value;
      const text = cellText(value).trim();
      return BOOLEAN_TEXT.test(text) ? !UNCHECKED.has(text.toLowerCase()) : null;
    }
    case 'date': {
      const includeTime = reading.type === 'dateTime';
      if (isDateCell(value)) return storedDate(value.date, includeTime);
      return textDate(cellText(value), reading.dateOrder, includeTime);
    }
    case 'multipleSelect': {
      const names = cellText(value)
        .split(/[\n\r,]+/)
        .map((part) => part.trim())
        .filter(Boolean);
      return names.length ? [...new Set(names)] : null;
    }
    default:
      return cellText(value);
  }
}

/** The type a column's key values take: the importer's type for the column, as a field type. */
export function keyFieldType(reading: CellReading): string {
  return reading.type === 'dateTime' ? 'date' : reading.type;
}
