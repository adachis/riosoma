import { parseTimeOfDay, parseMultiCurrency } from '@riosoma/contracts';
import {
  checkCellValue,
  isComputedType,
  parseLocationText,
  splitDateRangeText,
  type CellValue,
  type Choice,
  type FieldMeta,
} from '@riosoma/contracts';
import type { FormatContext } from './format';

/**
 * The text a person types or pastes, read back into a stored value.  Pure, like `format`: the same
 * text in the same field and context always gives the same answer, and nothing here touches the
 * clock, the network, or the document.
 *
 * Pasted numbers and dates arrive written the way their source locale writes them, which is not
 * always the way the viewer's locale does, so every reading that could fit is tried in the order
 * the viewer's locale makes most likely.
 */

/** Parsing reads a cell the same way formatting writes one, so it takes the same context. */
export type ParseContext = FormatContext;

export type ParseFailure =
  | 'data.value.time'
  | 'data.value.multiCurrency'
  | 'notNumber'
  | 'notDate'
  | 'computed'
  | 'data.value.negative'
  | 'data.value.rating'
  | 'data.user.unknown'
  | 'data.user.single'
  | 'data.value.dateRange'
  | 'data.value.notJson'
  | 'data.value.tooLong'
  | 'data.value.location'
  | 'data.value.signature';

export type ParseResult =
  | { ok: true; value: CellValue }
  | { ok: false; reason: ParseFailure }
  /** Select fields only: names with no matching choice; the caller creates them, then parses again */
  | { ok: 'newChoices'; names: string[] };

export type DateOrder = 'mdy' | 'dmy' | 'ymd';

/** Words that uncheck a box.  Anything else a person types checks it. */
const UNCHECKED = new Set(['false', 'no', 'n', '0', 'unchecked', 'off']);

/** A multiple select's names arrive one per line or separated by commas. */
const CHOICE_SPLIT = /[\n\r,]+/;

/** The English month names every locale also reads, in both the American and British spellings. */
const ENGLISH_TAGS = ['en-US', 'en-GB'] as const;

/** Separators a numeric date can use; both of them have to be the same one. */
const NUMERIC_DATE = /^(\d{1,4})\s*([/.-])\s*(\d{1,4})\s*\2\s*(\d{1,4})\s*\.?$/;

/** `2026年9月27日` and `2026년 9월 27일`, which the numeric layouts don't cover. */
const CJK_DATE = /^(\d{4})\s*[年년]\s*(\d{1,2})\s*[月월]\s*(\d{1,2})\s*[日일]?$/;

const ISO_DATE =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[Tt ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(?:\s*([Zz])|\s*([+-])(\d{2}):?(\d{2}))?)?$/;

const CLOCK = /(\d{1,2}):(\d{2})(?::(\d{2}))?/;

/** `AM`, `a.m.`, and the day-period words the supported locales write instead. */
const MERIDIEM = '(?:[ap]\\.?\\s?m\\.?|午前|午後|오전|오후|上午|下午|凌晨|早上|中午|晚上)';
const MERIDIEM_PATTERN = new RegExp(MERIDIEM, 'i');
const MERIDIEM_HOUR = new RegExp(`(?:(${MERIDIEM})\\s*(\\d{1,2})|(\\d{1,2})\\s*(${MERIDIEM}))`, 'i');
/** How far from the clock a day period can sit and still belong to it. */
const MERIDIEM_WINDOW = 10;

/** Characters spreadsheets and keyboards send in place of a space or a hyphen. */
const SPACE_LIKE = /[\u00A0\u2007\u2009\u202F\u200B\uFEFF]/g;
const NEGATIVE_SIGNS = ['-', '\u2212', '\u2013', '\u2011'];
/** Currency at either end: `R$` and `US$` are words, so `\p{Sc}` alone doesn't cover them. */
const CURRENCY = /^(?:R\$|US\$|\p{Sc})+\s*|\s*(?:R\$|US\$|\p{Sc})+$/gu;

interface WallDate {
  year: number;
  month: number;
  day: number;
}

interface WallClock extends WallDate {
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

interface ParsedDate {
  wall: WallClock;
  /** Minutes east of UTC when the text named a zone, `Z` included; null when it named none. */
  offsetMinutes: number | null;
}

const ok = (value: CellValue): ParseResult => ({ ok: true, value });
const fail = (reason: ParseFailure): ParseResult => ({ ok: false, reason });

const dateOrders = new Map<string, DateOrder>();

/**
 * The order a locale writes numeric dates in, asked of `Intl` so locales beyond the supported
 * eleven are right too.  A day that can't be a month (September 27) tells the pieces apart.
 */
export function dateOrderFor(locale: string): DateOrder {
  const found = dateOrders.get(locale);
  if (found !== undefined) return found;
  const parts = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC',
  }).formatToParts(Date.UTC(2026, 8, 27));
  const initials = parts
    .filter((part) => part.type === 'year' || part.type === 'month' || part.type === 'day')
    .map((part) => part.type.charAt(0))
    .join('');
  const order: DateOrder = initials === 'ymd' ? 'ymd' : initials === 'mdy' ? 'mdy' : 'dmy';
  dateOrders.set(locale, order);
  return order;
}

// ---------------------------------------------------------------- numbers

interface Separators {
  decimal: string;
  group: string;
  secondaryGroupSize: number;
}

const separatorsCache = new Map<string, Separators>();
function separatorsFor(locale: string): Separators {
  const found = separatorsCache.get(locale);
  if (found !== undefined) return found;
  const parts = new Intl.NumberFormat(locale, {
    useGrouping: true,
    minimumFractionDigits: 1,
  }).formatToParts(-123456789.5);
  const separators: Separators = {
    decimal: parts.find((part) => part.type === 'decimal')?.value ?? '.',
    group: parts.find((part) => part.type === 'group')?.value ?? ',',
    secondaryGroupSize: Array.from(parts.filter((part) => part.type === 'integer').at(-2)?.value ?? '000')
      .length,
  };
  separatorsCache.set(locale, separators);
  return separators;
}

/**
 * Reads digits under one reading of the separators, or null when they don't fit it: a grouping
 * separator needs one to three digits before it and exactly three after, and a decimal mark can
 * appear only once.
 */
function readNumber(
  text: string,
  decimal: string,
  groups: readonly string[],
  secondaryGroupSize = 3,
): number | null {
  let integer = '';
  let fraction = '';
  let inFraction = false;
  /** Where the digits after the last grouping separator start, or -1 before the first one. */
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
      if (grouped < 0 ? integer.length > secondaryGroupSize : integer.length - grouped !== secondaryGroupSize)
        return null;
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
 * A number as a person writes one: their locale's own separators, the plain `1234.5` every locale
 * understands, grouping, a currency symbol, a percent sign, parentheses or a sign for negatives.
 */
function parseNumber(input: string, locale: string): number | null {
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

  const { decimal, group, secondaryGroupSize } = separatorsFor(locale);
  // The locale's own reading first, so `1,234` is a thousand in American English and 1.234 in
  // German; then the two plain readings, which cover numbers pasted from another locale.
  const readings: ReadonlyArray<readonly [string, readonly string[], number]> = [
    [decimal, [group, ' '], secondaryGroupSize],
    ['.', [',', ' '], 3],
    [',', ['.', ' '], 3],
  ];
  for (const [mark, groups, size] of readings) {
    const value = readNumber(text, mark, groups, size);
    if (value !== null) return negative && value !== 0 ? -value : value;
  }
  return null;
}

/** Numeric fields share this reading with filters, whose thresholds need not be writable values. */
export function parseNumericText(field: FieldMeta, input: string, locale: string): number | null {
  let text = input.trim();
  if (field.type === 'currency') {
    const parts = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: field.options.code,
    }).formatToParts(1);
    const symbols = new Set([
      field.options.code,
      ...parts.filter((part) => part.type === 'currency').map((part) => part.value),
    ]);
    for (const symbol of symbols) text = text.replaceAll(new RegExp(escapeRegExp(symbol), 'giu'), '');
  }
  if (field.type === 'percent') text = text.replace(/[%٪]/gu, '');
  text = text.replace(/[\u061c\u200e\u200f]/gu, '');
  // Normalize localized digits before parsing punctuation or duration segments.
  const digits = new Intl.NumberFormat(locale, { useGrouping: false });
  for (let digit = 0; digit <= 9; digit++) text = text.replaceAll(digits.format(digit), String(digit));
  if (field.type === 'duration' && text.includes(':')) {
    const match = /^(\d+):([0-5]\d)(?::([0-5]\d)(?:[.,](\d+))?)?$/.exec(text);
    if (!match) return null;
    const seconds =
      Number(match[1]) * 3600 +
      Number(match[2]) * 60 +
      Number(match[3] ?? 0) +
      Number(`0.${match[4] ?? '0'}`);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const value = parseNumber(text, locale);
  if (value === null) return null;
  const scaled =
    field.type === 'percent'
      ? value / 100
      : field.type === 'duration' && field.options.format === 'h:mm'
        ? value * 60
        : value;
  return Number.isFinite(scaled) ? scaled : null;
}

// ------------------------------------------------------------------ dates

const zonePartsCache = new Map<string, Intl.DateTimeFormat>();
function zoneParts(zone: string): Intl.DateTimeFormat {
  const found = zonePartsCache.get(zone);
  if (found !== undefined) return found;
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  zonePartsCache.set(zone, format);
  return format;
}

/** How far ahead of UTC a zone is at one instant, in milliseconds. */
function zoneOffsetMs(instantMs: number, zone: string): number {
  const whole = Math.floor(instantMs / 1000) * 1000;
  const parts = zoneParts(zone).formatToParts(new Date(whole));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return asUtc - whole;
}

function utcMs(wall: WallClock): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.millisecond);
}

/** The UTC instant a wall-clock reading in a zone names. */
function wallClockToInstantMs(wall: WallClock, zone: string): number {
  const asUtc = utcMs(wall);
  // The first guess can land on the other side of a daylight-saving change, so the offset it
  // implies is measured once more where the guess actually fell.
  return asUtc - zoneOffsetMs(asUtc - zoneOffsetMs(asUtc, zone), zone);
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function wallDateText(wall: WallDate): string {
  const year = String(wall.year).padStart(4, '0');
  return `${year}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}`;
}

/** A two-digit year means this century up to 69 and the last one from 70 on. */
function expandYear(text: string): number {
  const year = Number(text);
  return text.length > 2 ? year : year <= 69 ? 2000 + year : 1900 + year;
}

function meridiemKind(token: string): 'am' | 'pm' | null {
  const word = token.toLowerCase().replace(/[\s.]/g, '');
  if (word.startsWith('a')) return 'am';
  if (word.startsWith('p')) return 'pm';
  if (/午前|오전|上午|凌晨|早上/.test(word)) return 'am';
  if (/午後|오후|下午|中午|晚上/.test(word)) return 'pm';
  return null;
}

/** A clock reading with its day period applied, or null when the two don't go together. */
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

interface TimeRead {
  clock: { hour: number; minute: number; second: number };
  rest: string;
}

/**
 * A zone name the grid itself appends, `PDT` or `GMT-7`, when a field's zone isn't the viewer's.
 * Reading the text back uses the field's zone, so the name is dropped rather than parsed.
 */
const ZONE_SUFFIX = /[\s,]*\[?(?:(?:GMT|UTC)\s*[+\-\u2212]\d{1,2}(?::?\d{2})?|[A-Z]{2,5})\]?$/u;

/** Punctuation a join leaves behind once the time is gone, as in `27.09.2026, 11:05`. */
const DATE_PADDING = /^[\s,;:.\u202f-]+|[\s,;:.\u202f-]+$/g;

function withoutZone(text: string): string {
  const found = ZONE_SUFFIX.exec(text);
  if (found === null) return text;
  // `AM` and `PM` belong to the clock, not to a zone.
  return /^(?:AM|PM)$/i.test(found[0].trim()) ? text : text.slice(0, found.index).trimEnd();
}

/** The time in a date, if it names one, and the text with that time taken out. */
function extractTime(text: string): TimeRead | null {
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
  // `3pm` has no minutes, so a day period is what makes a lone number a time and not a day.
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

function fractionToMs(fraction: string | undefined): number {
  return fraction === undefined ? 0 : Number(fraction.slice(0, 3).padEnd(3, '0'));
}

function readIso(match: RegExpExecArray): ParsedDate | null {
  const wall: WallClock = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: match[4] === undefined ? 0 : Number(match[4]),
    minute: match[5] === undefined ? 0 : Number(match[5]),
    second: match[6] === undefined ? 0 : Number(match[6]),
    millisecond: fractionToMs(match[7]),
  };
  if (!isRealDate(wall.year, wall.month, wall.day)) return null;
  if (wall.hour > 23 || wall.minute > 59 || wall.second > 59) return null;
  let offsetMinutes: number | null = null;
  if (match[8] !== undefined) offsetMinutes = 0;
  else if (match[9] !== undefined) {
    offsetMinutes = (match[9] === '-' ? -1 : 1) * (Number(match[10]) * 60 + Number(match[11] ?? '0'));
  }
  return { wall, offsetMinutes };
}

interface MonthNames {
  /** Longest name first, so `September` is matched before `Sep` */
  pattern: RegExp;
  monthOf: ReadonlyMap<string, number>;
}

const monthNameCache = new Map<string, MonthNames>();
function monthNamesFor(locale: string): MonthNames {
  const found = monthNameCache.get(locale);
  if (found !== undefined) return found;
  const monthOf = new Map<string, number>();
  for (const tag of [locale, ...ENGLISH_TAGS]) {
    for (const style of ['long', 'short'] as const) {
      const names = new Intl.DateTimeFormat(tag, { month: style, timeZone: 'UTC' });
      for (let month = 0; month < 12; month += 1) {
        // Dots go, so `sept.` and `sept` both read; the pattern puts the dot back as optional.
        const name = names
          .format(Date.UTC(2000, month, 1))
          .replace(/\./g, '')
          .trim()
          .toLowerCase();
        // Japanese, Korean, and Chinese name a month with its number (`9月`); the numeric layouts
        // read those, and matching digits here would eat the day or the year.
        if (name === '' || /\d/.test(name)) continue;
        if (!monthOf.has(name)) monthOf.set(name, month);
      }
    }
  }
  const ordered = [...monthOf.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const built: MonthNames = {
    pattern: ordered.length === 0 ? /(?!)/ : new RegExp(`(${ordered.join('|')})\\.?`, 'iu'),
    monthOf,
  };
  monthNameCache.set(locale, built);
  return built;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readMonthName(text: string, locale: string): WallDate | null {
  const { pattern, monthOf } = monthNamesFor(locale);
  const named = pattern.exec(text);
  if (named === null) return null;
  const month = monthOf.get(named[1]!.toLowerCase());
  if (month === undefined) return null;
  const rest = cut(text, [[named.index, named.index + named[0].length]]);
  // A month name leaves a day and a year behind.  Whatever else is there (a weekday, the word a
  // locale puts before the time, a note in parentheses) doesn't change which day is meant.
  const numbers = [...rest.matchAll(/(\d{1,4})(?!\d)/g)].map((match) => match[1]!);
  if (numbers.length !== 2) return null;
  const [first, second] = [numbers[0]!, numbers[1]!];
  // Whichever piece has four digits is the year; otherwise the year is the one written last, as
  // `Sep 27, 26` and `27 Sep 26` both mean.
  const yearFirst = first.length === 4 && second.length !== 4;
  const year = expandYear(yearFirst ? first : second);
  const day = Number(yearFirst ? second : first);
  return isRealDate(year, month + 1, day) ? { year, month: month + 1, day } : null;
}

function readNumeric(a: string, b: string, c: string, locale: string): WallDate | null {
  const preferred: DateOrder = a.length === 4 ? 'ymd' : dateOrderFor(locale);
  const orders = (['ymd', 'mdy', 'dmy'] as DateOrder[]).filter((order) => order !== preferred);
  for (const order of [preferred, ...orders]) {
    const [yearText, monthText, dayText] =
      order === 'ymd' ? [a, b, c] : order === 'mdy' ? [c, a, b] : [c, b, a];
    const year = expandYear(yearText);
    let month = Number(monthText);
    let day = Number(dayText);
    // A date pasted from a locale that writes the day first can arrive the other way round; take
    // the piece that can only be a day.
    if (month > 12 && day >= 1 && day <= 12) [month, day] = [day, month];
    if (isRealDate(year, month, day)) return { year, month, day };
  }
  return null;
}

function readWallDate(text: string, locale: string): WallDate | null {
  const cjk = CJK_DATE.exec(text);
  if (cjk !== null) {
    const wall = { year: Number(cjk[1]), month: Number(cjk[2]), day: Number(cjk[3]) };
    return isRealDate(wall.year, wall.month, wall.day) ? wall : null;
  }
  const numeric = NUMERIC_DATE.exec(text);
  if (numeric !== null) return readNumeric(numeric[1]!, numeric[3]!, numeric[4]!, locale);
  return readMonthName(text, locale);
}

function parseDate(text: string, locale: string): ParsedDate | null {
  const named = withoutZone(text.trim());
  const iso = ISO_DATE.exec(named);
  if (iso !== null) return readIso(iso);
  const time = extractTime(named);
  const rest = (time === null ? named : time.rest).replace(DATE_PADDING, '');
  const wall = readWallDate(rest, locale);
  if (wall === null) return null;
  return {
    wall: {
      ...wall,
      hour: time === null ? 0 : time.clock.hour,
      minute: time === null ? 0 : time.clock.minute,
      second: time === null ? 0 : time.clock.second,
      millisecond: 0,
    },
    offsetMinutes: null,
  };
}

/**
 * A date as a field with these options stores it: the day the text names, or with a time, the
 * instant it names in the field's zone.  Null when the text isn't a date.
 */
function storedDate(
  text: string,
  options: { includeTime: boolean; timeZone: string },
  ctx: ParseContext,
): string | null {
  const parsed = parseDate(text.trim(), ctx.locale);
  if (parsed === null) return null;
  // A date-only field stores the day the text names, whatever time came with it.
  if (!options.includeTime) return wallDateText(parsed.wall);
  const zone = options.timeZone === 'client' ? ctx.timeZone : options.timeZone;
  const ms =
    parsed.offsetMinutes === null
      ? wallClockToInstantMs(parsed.wall, zone)
      : utcMs(parsed.wall) - parsed.offsetMinutes * 60_000;
  return new Date(ms).toISOString();
}

// ----------------------------------------------------------------- choices

/** Choice names are matched as a person would read them: case and padding aside. */
function choiceKey(name: string, locale: string): string {
  return name.trim().toLocaleLowerCase(locale);
}

function findChoice(choices: readonly Choice[], name: string, locale: string): Choice | undefined {
  const key = choiceKey(name, locale);
  return choices.find((choice) => choiceKey(choice.name, locale) === key);
}

/**
 * Every choice by the key a name is matched on, so a pasted list is walked once rather than once
 * per name.  Two names that differ only in case keep the first of them.
 */
function choiceIndex(choices: readonly Choice[], locale: string): Map<string, Choice> {
  const index = new Map<string, Choice>();
  for (const choice of choices) {
    const key = choiceKey(choice.name, locale);
    if (!index.has(key)) index.set(key, choice);
  }
  return index;
}

function parseMultipleSelect(choices: readonly Choice[], text: string, ctx: ParseContext): ParseResult {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const part of text.split(CHOICE_SPLIT)) {
    const name = part.trim();
    if (name === '') continue;
    const key = choiceKey(name, ctx.locale);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (names.length === 0) return ok(null);
  const index = choiceIndex(choices, ctx.locale);
  const ids: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const choice = index.get(choiceKey(name, ctx.locale));
    if (choice === undefined) {
      missing.push(name);
      continue;
    }
    if (!ids.includes(choice.id)) ids.push(choice.id);
  }
  // Nothing is written until every name has a choice, so the caller can create the missing ones
  // and parse the same text again.
  return missing.length === 0 ? ok(ids) : { ok: 'newChoices', names: missing };
}

// ------------------------------------------------------------------ public

/**
 * Reads text into the value a field stores.  A field Riosoma fills in itself can't be written, and
 * text a field can't hold comes back with the reason so the grid can say why it kept the old value.
 */
export function parseText(field: FieldMeta, text: string, ctx: ParseContext): ParseResult {
  if (isComputedType(field.type)) return fail('computed');
  const trimmed = text.trim();
  switch (field.type) {
    case 'time': {
      if (!trimmed) return ok(null);
      const value = parseTimeOfDay(trimmed, ctx.locale);
      return value === null ? fail('data.value.time') : ok(value);
    }
    case 'multiCurrency': {
      if (!trimmed) return ok(null);
      const parts = /^([A-Z]{3})\s+(.+)$/i.exec(trimmed);
      const amount = parseNumber(parts ? parts[2]! : trimmed, ctx.locale);
      const value =
        parseMultiCurrency(trimmed, field.options.code) ??
        (amount !== null ? { code: parts?.[1]?.toUpperCase() ?? field.options.code, amount } : null);
      if (!value) return fail('data.value.multiCurrency');
      const checked = checkCellValue(field, value);
      return checked.ok ? ok(checked.value) : fail('data.value.multiCurrency');
    }
    case 'checkbox':
      return ok(trimmed === '' ? false : !UNCHECKED.has(trimmed.toLocaleLowerCase(ctx.locale)));
    case 'number': {
      if (trimmed === '') return ok(null);
      const value = parseNumber(trimmed, ctx.locale);
      return value === null ? fail('notNumber') : ok(value);
    }
    case 'currency':
    case 'percent':
    case 'duration':
    case 'rating': {
      if (trimmed === '') return ok(null);
      const value = parseNumericText(field, trimmed, ctx.locale);
      if (value === null) return fail('notNumber');
      const checked = checkCellValue(field, value);
      if (checked.ok) return ok(checked.value);
      return fail(field.type === 'rating' ? 'data.value.rating' : 'data.value.negative');
    }
    case 'user': {
      if (trimmed === '') return ok(null);
      const ids = new Set<string>();
      for (const part of trimmed.split(',')) {
        const key = choiceKey(part, ctx.locale);
        if (!key) continue;
        const matches = [...ctx.collaborators].filter(
          ([, person]) =>
            choiceKey(person.name, ctx.locale) === key ||
            (person.email && choiceKey(person.email, ctx.locale) === key),
        );
        if (matches.length !== 1) return fail('data.user.unknown');
        ids.add(matches[0]![0]);
      }
      if (!field.options.allowMultiple && ids.size > 1) return fail('data.user.single');
      return ok(ids.size ? [...ids] : null);
    }
    case 'date': {
      if (trimmed === '') return ok(null);
      const date = storedDate(trimmed, field.options, ctx);
      return date === null ? fail('notDate') : ok(date);
    }
    case 'dateRange': {
      if (trimmed === '') return ok(null);
      const [start, end] = splitDateRangeText(trimmed).map((part) => storedDate(part, field.options, ctx));
      if (start === null || end === null) return fail('notDate');
      const checked = checkCellValue(field, { start, end });
      return checked.ok ? ok(checked.value) : fail('data.value.dateRange');
    }
    case 'json': {
      if (trimmed === '') return ok(null);
      const checked = checkCellValue(field, text);
      if (checked.ok) return ok(checked.value);
      return fail(checked.messageKey === 'data.value.tooLong' ? 'data.value.tooLong' : 'data.value.notJson');
    }
    case 'location': {
      if (trimmed === '') return ok(null);
      const place = parseLocationText(trimmed);
      return place === null ? fail('data.value.location') : ok(place);
    }
    // A signature is drawn or typed by the person signing, never pasted in.
    case 'signature':
      return trimmed === '' ? ok(null) : fail('data.value.signature');
    case 'singleSelect': {
      if (trimmed === '') return ok(null);
      const choice = findChoice(field.options.choices, trimmed, ctx.locale);
      return choice === undefined ? { ok: 'newChoices', names: [trimmed] } : ok(choice.id);
    }
    case 'multipleSelect':
      return parseMultipleSelect(field.options.choices, text, ctx);
    case 'text':
    case 'barcode':
    case 'longText':
    case 'email':
    case 'url':
    case 'phone':
      // Stored as typed; `checkCellValue` trims and normalizes what needs it.
      return ok(trimmed === '' ? null : text);
    default:
      // The types Riosoma fills in itself, which `isComputedType` stopped above.
      return fail('computed');
  }
}
