import type { Cell, Cleaned } from './source.js';

export type Scalar = string | number | boolean | null;
export type CleanerInput = Scalar | Cell | undefined;
export interface CleanerIssue {
  key: 'ingest.cleaner.ambiguous' | 'ingest.cleaner.invalid' | 'ingest.cleaner.missingInput';
  input: string;
}
export interface CleanerResult<T> extends Cleaned<T> {
  issue?: CleanerIssue;
}
export interface EmptyOptions {
  placeholders?: readonly string[];
}
export interface TextOptions extends EmptyOptions {
  collapseSpaces?: boolean;
}
export interface NumberOptions extends EmptyOptions {
  decimalMark?: '.' | ',';
  groupingMark?: '.' | ',' | ' ' | 'none';
  units?: readonly string[];
}
export const DATE_FORMATS = [
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'MM/DD/YYYY',
  'DD/MM/YYYY',
  'MM-DD-YYYY',
  'DD-MM-YYYY',
] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];
export interface DateOptions extends EmptyOptions {
  formats?: readonly DateFormat[];
}
export interface DurationOptions extends NumberOptions {
  unit?: 'seconds' | 'minutes' | 'hours';
  clock?: 'hours:minutes' | 'minutes:seconds';
}
export interface BooleanOptions extends EmptyOptions {
  trueValues?: readonly string[];
  falseValues?: readonly string[];
}
export interface IdentifierOptions extends EmptyOptions {
  width?: number;
}
export interface LookupOptions extends EmptyOptions {
  entries: Readonly<Record<string, Scalar>>;
  caseSensitive?: boolean;
}

export function inputValue(input: CleanerInput): Scalar | undefined {
  return typeof input === 'object' && input !== null ? input.v : input;
}

function success<T>(value: T): { value: T; certain: true } {
  return { value, certain: true };
}
function unsure<T>(input: string, ambiguous = false, value: T | null = null): CleanerResult<T> {
  return {
    value,
    certain: false,
    issue: { key: ambiguous ? 'ingest.cleaner.ambiguous' : 'ingest.cleaner.missingInput', input },
  };
}
function invalid<T>(input: string): CleanerResult<T> {
  return { value: null, certain: false, issue: { key: 'ingest.cleaner.invalid', input } };
}

export function isEmpty(input: CleanerInput, options: EmptyOptions = {}): boolean {
  const value = inputValue(input);
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().normalize('NFC').toLowerCase();
  return (
    normalized === '' ||
    (options.placeholders ?? []).some((word) => word.trim().normalize('NFC').toLowerCase() === normalized)
  );
}

export function blank(input: CleanerInput, options: EmptyOptions = {}): CleanerResult<Scalar> {
  return success(isEmpty(input, options) ? null : (inputValue(input) ?? null));
}
export function text(input: CleanerInput, options: TextOptions = {}): CleanerResult<string> {
  if (isEmpty(input, options)) return success(null);
  const value = String(inputValue(input)).trim().normalize('NFC');
  return success(options.collapseSpaces ? value.replace(/\s+/gu, ' ') : value);
}

/** Decimal arithmetic uses integer coefficients, so a sum cannot round a monetary value. */
export function canonicalDecimal(value: string): string | null {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(value);
  if (!match) return null;
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;
  let digits = (match[2] ?? '') + (match[3] ?? '');
  const point = (match[2]?.length ?? 0) + exponent;
  if (point <= 0) digits = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) digits += '0'.repeat(point - digits.length);
  else digits = `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [whole = '0', fraction = ''] = digits.split('.');
  const integer = whole.replace(/^0+(?=\d)/u, '');
  const tail = fraction.replace(/0+$/u, '');
  const unsigned = tail ? `${integer}.${tail}` : integer;
  return match[1] === '-' && unsigned !== '0' ? `-${unsigned}` : unsigned;
}
function decimalParts(value: string): { coefficient: bigint; scale: number } {
  const normalized = canonicalDecimal(value);
  if (normalized === null) throw new RangeError('ingest.decimal.invalid');
  const [whole = '0', fraction = ''] = normalized.split('.');
  return { coefficient: BigInt(whole + fraction), scale: fraction.length };
}
function fromCoefficient(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  return canonicalDecimal(
    `${negative ? '-' : ''}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`,
  )!;
}
export function addDecimals(left: string, right: string): string {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  return fromCoefficient(
    a.coefficient * 10n ** BigInt(scale - a.scale) + b.coefficient * 10n ** BigInt(scale - b.scale),
    scale,
  );
}
export function multiplyDecimals(left: string, right: string): string {
  const a = decimalParts(left);
  const b = decimalParts(right);
  return fromCoefficient(a.coefficient * b.coefficient, a.scale + b.scale);
}

function readDecimal(
  value: string,
  decimalMark: '.' | ',',
  groupingMark: NumberOptions['groupingMark'],
): string | null {
  const group = groupingMark ?? (decimalMark === '.' ? ',' : '.');
  if (group === decimalMark) return null;
  const parts = value.split(decimalMark);
  if (parts.length > 2) return null;
  let whole = parts[0] ?? '';
  const fraction = parts[1];
  if (fraction !== undefined && !/^\d+$/u.test(fraction)) return null;
  if (group !== 'none' && whole.includes(group)) {
    const groups = whole.split(group);
    if (!/^[+-]?\d{1,3}$/u.test(groups[0] ?? '') || groups.slice(1).some((part) => !/^\d{3}$/u.test(part)))
      return null;
    whole = groups.join('');
  }
  // A fraction may stand with no digit before its mark, as in ".75" and "-.75".
  if (fraction !== undefined && /^[+-]?$/u.test(whole)) whole = `${whole}0`;
  if (!/^[+-]?\d+$/u.test(whole)) return null;
  return canonicalDecimal(fraction === undefined ? whole : `${whole}.${fraction}`);
}
export function number(input: CleanerInput, options: NumberOptions = {}): CleanerResult<string> {
  if (isEmpty(input, options)) return success(null);
  const original = inputValue(input);
  if (typeof original === 'boolean') return invalid('number');
  if (typeof original === 'number') {
    if (!Number.isFinite(original)) return invalid('number');
    if (Number.isInteger(original) && !Number.isSafeInteger(original)) return unsure('exactText');
    return success(canonicalDecimal(String(original)));
  }
  let value = String(original).trim().normalize('NFC');
  const units = [...(options.units ?? [])].sort((a, b) => b.length - a.length);
  for (const unit of units) {
    if (unit && value.startsWith(unit)) {
      value = value.slice(unit.length).trim();
      break;
    }
    if (unit && value.endsWith(unit)) {
      value = value.slice(0, -unit.length).trim();
      break;
    }
  }
  if (value.startsWith('(') && value.endsWith(')')) value = `-${value.slice(1, -1)}`;
  const scientific = /^([+-]?\d[\d., ]*)[eE]([+-]?\d+)$/u.exec(value);
  if (scientific) value = scientific[1]!;
  if (/[a-z$€£]/iu.test(value)) return unsure('units');
  const reading = (mark: '.' | ',') => {
    const parsed = readDecimal(value, mark, options.groupingMark);
    return parsed === null || !scientific ? parsed : canonicalDecimal(`${parsed}e${scientific[2]}`);
  };
  if (options.decimalMark) {
    const result = reading(options.decimalMark);
    return result === null ? invalid('number') : success(result);
  }
  const candidates = [reading('.'), reading(',')].filter((item): item is string => item !== null);
  const readings = new Set(candidates);
  if (/[.,]/u.test(value) && candidates.length > 1)
    return unsure('decimalMark', true, readings.size === 1 ? [...readings][0]! : null);
  return readings.size === 1 ? success([...readings][0]!) : invalid('number');
}

function calendarDay(year: number, month: number, day: number): string | null {
  if (![year, month, day].every(Number.isInteger)) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0))
    return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
export function dateReadings(input: CleanerInput, formats: readonly DateFormat[]): Map<DateFormat, string> {
  const value = String(inputValue(input) ?? '').trim();
  const readings = new Map<DateFormat, string>();
  for (const format of formats) {
    if (!DATE_FORMATS.includes(format)) continue;
    const separator = format.includes('/') ? '/' : '-';
    const tokens = format.split(separator);
    const parts = value.split(separator);
    if (
      parts.length !== 3 ||
      parts.some((part, index) => !(tokens[index] === 'YYYY' ? /^\d{4}$/u : /^\d{1,2}$/u).test(part))
    )
      continue;
    const year = Number(parts[tokens.indexOf('YYYY')]);
    const month = Number(parts[tokens.indexOf('MM')]);
    const day = Number(parts[tokens.indexOf('DD')]);
    const result = calendarDay(year, month, day);
    if (result !== null) readings.set(format, result);
  }
  return readings;
}
export function date(input: CleanerInput, options: DateOptions = {}): CleanerResult<string> {
  if (isEmpty(input, options)) return success(null);
  const candidates = dateReadings(input, options.formats ?? ['YYYY-MM-DD']);
  const readings = new Set(candidates.values());
  if (candidates.size > 1) return unsure('formats', true, readings.size === 1 ? [...readings][0]! : null);
  if (readings.size === 1) return success([...readings][0]!);
  return options.formats || /^\d{4}-\d{1,2}-\d{1,2}$/u.test(String(inputValue(input)))
    ? invalid('calendarDay')
    : unsure('formats');
}

/** Calendar validation uses the day cleaner, and a missing time zone means UTC. */
export function instant(input: CleanerInput): CleanerResult<string> {
  if (isEmpty(input)) return success(null);
  const match =
    /^(\d{4}-\d{1,2}-\d{1,2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?([Zz]|[+-]\d{2}:\d{2})?$/u.exec(
      String(inputValue(input)).trim(),
    );
  if (!match) return invalid('instant');
  const day = date(match[1]);
  const seconds = match[4] ?? '00';
  if (!day.certain || !day.value || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(seconds) > 59)
    return invalid('instant');
  const timestamp =
    Date.parse(`${day.value}T${match[2]}:${match[3]}:${seconds}${match[6]?.toUpperCase() ?? 'Z'}`) / 1000;
  return Number.isFinite(timestamp)
    ? success(addDecimals(String(timestamp), canonicalDecimal(`0.${match[5] ?? '0'}`)!))
    : invalid('instant');
}
export function duration(input: CleanerInput, options: DurationOptions = {}): CleanerResult<string> {
  if (isEmpty(input, options)) return success(null);
  const value = String(inputValue(input)).trim();
  if (value.includes(':')) {
    if (!options.clock) return unsure('clock', true);
    const parts = /^(\d+):(\d{2})$/u.exec(value);
    if (!parts || Number(parts[2]) >= 60) return invalid('duration');
    return success(
      addDecimals(
        multiplyDecimals(parts[1]!, options.clock === 'hours:minutes' ? '3600' : '60'),
        multiplyDecimals(parts[2]!, options.clock === 'hours:minutes' ? '60' : '1'),
      ),
    );
  }
  if (!options.unit) return unsure('unit');
  const cleaned = number(input, options);
  if (!cleaned.certain || cleaned.value === null) return cleaned;
  if (cleaned.value.startsWith('-')) return invalid('duration');
  return success(
    multiplyDecimals(
      cleaned.value,
      options.unit === 'hours' ? '3600' : options.unit === 'minutes' ? '60' : '1',
    ),
  );
}
export function boolean(input: CleanerInput, options: BooleanOptions = {}): CleanerResult<boolean> {
  if (isEmpty(input, options)) return success(null);
  const value = inputValue(input);
  if (typeof value === 'boolean') return success(value);
  const normalized = String(value).trim().normalize('NFC').toLowerCase();
  const yes = (options.trueValues ?? ['true', 'yes', '1']).some(
    (item) => item.trim().normalize('NFC').toLowerCase() === normalized,
  );
  const no = (options.falseValues ?? ['false', 'no', '0']).some(
    (item) => item.trim().normalize('NFC').toLowerCase() === normalized,
  );
  if (yes && no) return unsure('booleanValues', true);
  return yes || no ? success(yes) : unsure('booleanValues');
}
export function identifier(input: CleanerInput, options: IdentifierOptions = {}): CleanerResult<string> {
  if (isEmpty(input, options)) return success(null);
  const value = inputValue(input);
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return invalid('identifier');
  if (typeof value === 'boolean') return invalid('identifier');
  if (
    options.width !== undefined &&
    (!Number.isSafeInteger(options.width) || options.width < 1 || options.width > 1000)
  )
    return invalid('width');
  const result = String(value).trim().normalize('NFC');
  if (options.width !== undefined && /^\d+$/u.test(result)) {
    if (result.length > options.width) return invalid('width');
    return success(result.padStart(options.width, '0'));
  }
  return typeof value === 'number' ? unsure('width', false, result) : success(result);
}
export function lookup(input: CleanerInput, options: LookupOptions): CleanerResult<Scalar> {
  if (isEmpty(input, options)) return success(null);
  const normalize = (value: string) =>
    options.caseSensitive ? value.trim().normalize('NFC') : value.trim().normalize('NFC').toLowerCase();
  const name = normalize(String(inputValue(input)));
  const matches = Object.entries(options.entries).filter(([key]) => normalize(key) === name);
  if (!matches.length) return unsure('entries');
  const values = new Set(matches.map(([, value]) => value));
  return values.size === 1 ? success(matches[0]![1]) : unsure('entries', true);
}
