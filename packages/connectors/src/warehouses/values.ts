import type { CellValue } from '@riosoma/contracts';
import { ConnectorError } from '../types.js';
import { KEYS } from './errors.js';
import type { Described } from './mapping.js';

/**
 * Values on their way from a warehouse to Riosoma's forms: numbers, `YYYY-MM-DD`, ISO instants in
 * UTC, and text.  They follow the SQL connectors' `convert` and `keyValue`, reading each column by
 * its class instead of its type name, since the four warehouses name their types four ways.  Each
 * connector first unwraps its driver's own value objects into plain ones: numbers or digit
 * strings, booleans, `Date`s or date and time text, JSON values or JSON text, and bytes.
 */

const DAY = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
const INSTANT =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,9}))?)?\s*(Z|UTC|GMT|[+-]\d{2}(?::?\d{2})?)?$/i;
const TRUE_WORDS = new Set(['1', 't', 'true', 'y', 'yes', 'on']);
const RAW = JSON as unknown as { isRawJSON(value: unknown): value is { rawJSON: string } };

function unreadable(what: string): ConnectorError {
  return new ConnectorError(KEYS.read, `the source sent ${what} Riosoma can't read`);
}

/** One value as a cell of the field type it is read as. */
export function cellOf(value: unknown, fieldType: string, column: Described): CellValue {
  if (value === null || value === undefined) return null;
  if (
    column.arraysAsJson &&
    Array.isArray(value) &&
    !(
      column.kind === 'location' &&
      value.length === 2 &&
      value.every((coordinate) => typeof coordinate === 'number')
    )
  )
    return textOf(value, 'json');
  switch (fieldType) {
    case 'location': {
      let lat: unknown;
      let lng: unknown;
      if (Array.isArray(value)) {
        if (column.column.sourceType === 'geopoint') [lat, lng] = value;
        else [lng, lat] = value;
      } else if (typeof value === 'string') {
        const point = /^POINT\s*\(\s*([^\s]+)\s+([^\s)]+)\s*\)$/i.exec(value.trim());
        if (point) [lng, lat] = point.slice(1).map(Number);
        else if (value.includes(',')) [lat, lng] = value.split(',').map(Number);
        else if (/^[0-9bcdefghjkmnpqrstuvwxyz]+$/.test(value)) {
          const bounds = [
            [-180, 180],
            [-90, 90],
          ];
          let axis = 0;
          for (const character of value.slice(0, 12)) {
            const bits = '0123456789bcdefghjkmnpqrstuvwxyz'.indexOf(character);
            for (let bit = 4; bit >= 0; bit--) {
              const range = bounds[axis]!;
              range[bits & (1 << bit) ? 0 : 1] = (range[0]! + range[1]!) / 2;
              axis = 1 - axis;
            }
          }
          [lng, lat] = bounds.map(([min, max]) => (min! + max!) / 2);
        }
      } else if (typeof value === 'object') {
        const point = value as Record<string, unknown>;
        lat = point.lat;
        lng = point.lon ?? point.lng;
        if (Array.isArray(point.coordinates)) [lng, lat] = point.coordinates;
      }
      if (
        typeof lat !== 'number' ||
        typeof lng !== 'number' ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        Math.abs(lat) > 90 ||
        Math.abs(lng) > 180
      )
        throw unreadable('a location');
      return { lat, lng, label: null };
    }

    case 'number':
    case 'currency':
    case 'percent':
      return numberOf(value);
    case 'checkbox':
      return truthOf(value);
    case 'date':
      // The column's own class decides, as the SQL connectors let the column's type decide.
      return column.kind === 'timestamp' ? instantOf(value) : dayOf(value);
    case 'multipleSelect':
      return Array.isArray(value)
        ? value.map((item) => textOf(item, 'unknown'))
        : String(value).split(',').filter(Boolean);
    default:
      return textOf(value, column.kind);
  }
}

/**
 * One key column's value in the form keys take: a decimal's exact digits, an integer as a number
 * while a double holds it exactly and as digits beyond that, and anything else as its suggested
 * field type converts it.  Keys never depend on the field type a person chose.
 */
export function keyPartOf(value: unknown, column: Described): CellValue {
  if (value === null || value === undefined) return null;
  switch (column.kind) {
    case 'decimal':
      return digitsOf(value);
    case 'integer': {
      const number = typeof value === 'bigint' ? Number(value) : Number(digitsOf(value));
      return Number.isSafeInteger(number) ? number : digitsOf(value);
    }
    case 'float':
      return numberOf(value);
    default:
      return cellOf(value, column.column.suggested?.type ?? 'text', column);
  }
}

/**
 * A number field's value.  NaN and the infinities have no number form, so they read as empty, and
 * anything that isn't a number at all fails the read.
 */
function numberOf(value: unknown): number | null {
  if (RAW.isRawJSON(value)) value = value.rawJSON;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^[+-]?(nan|inf|infinity)$/i.test(text)) return null;
    const number = Number(text);
    if (text.length > 0 && Number.isFinite(number)) return number;
  }
  throw unreadable('a number');
}

function truthOf(value: unknown): boolean {
  if (RAW.isRawJSON(value)) return Number(value.rawJSON) !== 0;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  if (value instanceof Uint8Array) return value.some((byte) => byte !== 0);
  return typeof value === 'string' && TRUE_WORDS.has(value.trim().toLowerCase());
}

/** The exact digits a decimal or wide integer arrived with. */
function digitsOf(value: unknown): string {
  if (RAW.isRawJSON(value)) return value.rawJSON;
  if (typeof value === 'string') return value.trim();
  return String(value);
}

/** A calendar day, `YYYY-MM-DD`. */
function dayOf(value: unknown): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw unreadable('a date');
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'number') return dayOf(new Date(value));
  const found = DAY.exec(String(value).trim());
  if (!found) throw unreadable('a date');
  const [year, month, day] = [Number(found[1]), Number(found[2]), Number(found[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCFullYear(year);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw unreadable('a date');
  return date.toISOString().slice(0, 10);
}

/**
 * An instant, written in UTC.  Text without a zone reads as UTC, which is what a timestamp without
 * one means here, and what a session set to UTC writes for one with a zone.
 */
function instantOf(value: unknown): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw unreadable('a time');
    return value.toISOString();
  }
  if (typeof value === 'number') return instantOf(new Date(value));
  const found = INSTANT.exec(String(value).trim());
  if (!found) throw unreadable('a time');
  const [year, month, day] = [Number(found[1]), Number(found[2]), Number(found[3])];
  const [hours, minutes, seconds] = [Number(found[4] ?? 0), Number(found[5] ?? 0), Number(found[6] ?? 0)];
  const millis = Number((found[7] ?? '').padEnd(3, '0').slice(0, 3));
  const date = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds, millis));
  date.setUTCFullYear(year);
  // A part that rolled over means the source wrote something that isn't a real moment.
  if (
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hours ||
    date.getUTCMinutes() !== minutes
  )
    throw unreadable('a time');
  return new Date(date.getTime() - offsetMinutes(found[8]) * 60_000).toISOString();
}

/** A zone written as `Z`, `UTC`, `+01`, `+0130`, or `-01:30`, in minutes east of Greenwich. */
function offsetMinutes(zone: string | undefined): number {
  if (zone === undefined || /^(z|utc|gmt)$/i.test(zone)) return 0;
  const digits = zone.slice(1).replace(':', '');
  const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || '0');
  return zone.startsWith('-') ? -minutes : minutes;
}

/** Text, in the form the column's class writes: instants in UTC, JSON as compact JSON. */
function textOf(value: unknown, kind: Described['kind']): string {
  switch (kind) {
    case 'boolean':
      return String(truthOf(value));
    case 'json':
      return jsonText(value);
    case 'timestamp':
      return tryOr(() => instantOf(value), value);
    case 'date':
      return tryOr(() => dayOf(value), value);
    default:
      break;
  }
  if (typeof value === 'string') return value;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : '';
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (typeof value === 'object' && value !== null) return jsonText(value);
  return String(value);
}

function tryOr(read: () => string, value: unknown): string {
  try {
    return read();
  } catch {
    return String(value);
  }
}

/**
 * Structured data as compact JSON.  Text that is already JSON is read and written again, so every
 * warehouse's spacing comes out the same, and text that isn't JSON (like XML in a variant) stays.
 */
function jsonText(value: unknown): string {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return value;
    }
  }
  return (
    JSON.stringify(parsed, function (this: Record<string, unknown>, key: string, item: unknown) {
      // A buffer has written itself as an object by now, so its bytes come from the original.
      const original = this[key];
      if (original instanceof Uint8Array) return Buffer.from(original).toString('base64');
      return typeof item === 'bigint' ? item.toString() : item;
    }) ?? ''
  );
}

/** A whole number from a catalog, which drivers hand back as numbers, digit strings, or big integers. */
export function wholeNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : null;
  }
  return null;
}

/** A non-empty string, or null for the empty and the not-text a catalog hands back. */
export function textOr(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Objects in the connection's own schema first, and otherwise in the order the catalog gave them. */
export function ownSchemaFirst<T extends { schema: string | null }>(
  objects: readonly T[],
  schema: string,
  sameName: (left: string, right: string) => boolean = (left, right) => left === right,
): T[] {
  const own = (object: T) => object.schema !== null && sameName(object.schema, schema);
  return [...objects.filter(own), ...objects.filter((object) => !own(object))];
}

/** An integer as a number while a double holds it exactly, and as its digits beyond that. */
export function exactInteger(value: bigint | number | string): number | string {
  const text = typeof value === 'string' ? value.trim() : value.toString();
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : text;
}

/**
 * Collects rows and hands over batches of exactly the size asked for.  Drivers deliver whatever
 * their own chunking gives them, so a read holds one batch plus a partial one, never the whole
 * result.
 */
export class RowBatcher<T> {
  private held: T[] = [];

  constructor(private readonly size: number) {}

  /** The batches these rows complete, keeping whatever is left over for the next call. */
  add(rows: readonly T[]): T[][] {
    const ready: T[][] = [];
    for (const row of rows) {
      this.held.push(row);
      if (this.held.length === this.size) {
        ready.push(this.held);
        this.held = [];
      }
    }
    return ready;
  }

  /** The rows left over, or null when there are none. */
  flush(): T[] | null {
    if (this.held.length === 0) return null;
    const rest = this.held;
    this.held = [];
    return rest;
  }
}
