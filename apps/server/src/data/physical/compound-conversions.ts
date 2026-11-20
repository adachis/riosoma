import { isMultiCurrencyValue, multiCurrencyText } from '@riosoma/contracts';
import {
  isDateRangeValue,
  isLocationValue,
  isSignatureValue,
  locationText,
  minifyJson,
  parseLocationText,
  splitDateRangeText,
  type CellValue,
  type FieldSpec,
} from '@riosoma/contracts';
import { sql, type Sql } from '@riosoma/db';
import type { StoredField } from '../types.js';

/**
 * Converting fields to and from date ranges, JSON, locations, and signatures.  `canConvert` in the
 * contracts decides which changes are allowed, and this reads the values across.
 */

/** A range's two ends on their way into a range column, each read as an instant or a wall time. */
export interface RangeEnds {
  start: string;
  end: string;
  startInstant: boolean;
  endInstant: boolean;
}

const WALL_TIMES = new Map<string, Intl.DateTimeFormat>();

/** `2026-09-27 15:05`, an instant's day and time in a zone, as a date converts to text. */
export function wallTime(instant: string, zone: string): string {
  let format = WALL_TIMES.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    if (WALL_TIMES.size < 64) WALL_TIMES.set(zone, format);
  }
  const parts = format.formatToParts(new Date(instant));
  const part = (type: string) => parts.find((piece) => piece.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

/** The zone a range with times shows its days in. */
function rangeZone(field: StoredField, timeZone: string): string {
  return field.type === 'dateRange' && field.options.timeZone !== 'client'
    ? field.options.timeZone
    : timeZone;
}

/**
 * A date range, location, signature, or JSON value as text: how it reads once its field becomes a
 * text field.  Undefined for any other value, which converts as it always has.
 */
export function compoundText(
  from: StoredField,
  value: CellValue,
  timeZone: string,
  people?: ReadonlyMap<string, string>,
): string | undefined {
  if (isMultiCurrencyValue(value)) return multiCurrencyText(value);
  if (from.type === 'dateRange' && isDateRangeValue(value)) {
    const zone = rangeZone(from, timeZone);
    const end = (text: string) => (from.options.includeTime ? wallTime(text, zone) : text);
    return value.start === value.end ? end(value.start) : `${end(value.start)} – ${end(value.end)}`;
  }
  if (from.type === 'location' && isLocationValue(value)) return locationText(value);
  if (from.type === 'signature' && isSignatureValue(value)) {
    const time = wallTime(value.signedAt, timeZone);
    const name = value.name ?? (value.signedBy ? people?.get(value.signedBy) : undefined);
    return name ? `Signed by ${name} at ${time}` : `Signed at ${time}`;
  }
  return undefined;
}

/** JSON from another field's value: text that holds JSON is that JSON, other text a JSON string. */
export function jsonFrom(from: StoredField, value: CellValue): CellValue {
  if (value === null) return null;
  if (from.type === 'json') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value !== 'string') return null;
  return minifyJson(value) ?? JSON.stringify(value);
}

/** A location read from text: bare coordinates, or a label followed by them in parentheses. */
export function locationFrom(value: CellValue): CellValue {
  return typeof value === 'string' ? parseLocationText(value) : null;
}

/**
 * The ends of a range from another field's value.  A date or moment is a one-day range, and text is
 * read by `readDate`, which returns a day or a moment and says which.
 */
export function rangeFrom(
  from: StoredField,
  value: CellValue,
  readDate: (text: string) => { value: string; instant: boolean } | null,
): RangeEnds | null {
  if (value === null) return null;
  if (from.type === 'dateRange' && isDateRangeValue(value)) {
    const instant = from.options.includeTime;
    return { start: value.start, end: value.end, startInstant: instant, endInstant: instant };
  }
  if (from.type === 'date' || from.type === 'createdTime' || from.type === 'lastModifiedTime') {
    if (typeof value !== 'string') return null;
    const instant = from.type !== 'date' || from.options.includeTime;
    return { start: value, end: value, startInstant: instant, endInstant: instant };
  }
  if (typeof value !== 'string') return null;
  const [first, last] = splitDateRangeText(value);
  const start = readDate(first);
  const end = readDate(last);
  return start && end
    ? { start: start.value, end: end.value, startInstant: start.instant, endInstant: end.instant }
    : null;
}

/**
 * The SQL that turns prepared `RangeEnds` into a range column value, in the target's zone.  Ends
 * that come out in the wrong order leave the cell empty instead of stopping the conversion.
 */
export function rangeExpression(
  field: Extract<FieldSpec, { type: 'dateRange' }>,
  value: Sql,
  timeZone: string,
): Sql {
  const zone = field.options.timeZone === 'client' ? timeZone : field.options.timeZone;
  const end = (key: 'start' | 'end') => {
    const text = sql`(${value} ->> ${key}::text)`;
    const instant = sql`(${value} ->> ${`${key}Instant`}::text)::boolean`;
    return field.options.includeTime
      ? sql`CASE WHEN ${instant} THEN (${text})::timestamptz ELSE (${text})::timestamp AT TIME ZONE ${zone} END`
      : sql`CASE WHEN ${instant} THEN ((${text})::timestamptz AT TIME ZONE ${zone})::date
          ELSE (${text})::timestamp::date END`;
  };
  const range = field.options.includeTime ? sql`tstzrange` : sql`daterange`;
  return sql`(SELECT CASE WHEN ends.start <= ends.finish THEN ${range}(ends.start, ends.finish, '[]') END
    FROM (SELECT ${end('start')} AS start, ${end('end')} AS finish) AS ends
    WHERE jsonb_typeof(${value}) = 'object')`;
}
