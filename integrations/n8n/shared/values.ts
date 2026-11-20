import type { ApiRecord, FieldMeta } from './types';

/**
 * Turns values from n8n items into the forms Riosoma's REST API accepts, and records from the API
 * into items.  The API names select options, people, and linked records the readable way, so
 * most values pass through, and the work here is in dates, numbers, checkboxes, lists, and files.
 */

/** A value that can't be written to its field, with a message that says why. */
export class ValueProblem extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
    this.name = 'ValueProblem';
  }
}

export const TEXT_TYPES = ['text', 'longText', 'email', 'url', 'phone'];
export const NUMBER_TYPES = ['number', 'currency', 'percent', 'duration', 'rating'];
/** Types Riosoma fills in itself, and the button, which holds no value */
export const COMPUTED_TYPES = [
  'createdTime',
  'lastModifiedTime',
  'createdBy',
  'lastModifiedBy',
  'recordId',
  'lookup',
  'rollup',
  'count',
  'formula',
  'autoNumber',
  'button',
];

/** Whether writes can set this field.  Links that follow matching values change on their own. */
export function isWritable(field: FieldMeta): boolean {
  if (COMPUTED_TYPES.includes(field.type)) return false;
  return !(field.type === 'link' && field.options?.match);
}

const RECORD_ID = /^rec[0-9A-Za-z]{14}$/;
const FILE_ID = /^att[0-9A-Za-z]{14}$/;
const FILE_PATH = /\/api\/files\/(att[0-9A-Za-z]{14})(?:[/?#]|$)/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const WITH_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?$/;

export interface ValueContext {
  /** The Riosoma address, for reading file addresses and making them absolute */
  address: string;
  /** Where a date and time with no offset is read, such as the workflow's time zone */
  timeZone: string;
}

/** A Luxon DateTime, which n8n hands over for date fields, without depending on Luxon. */
interface DateTimeLike {
  isValid: boolean;
  toISODate(): string | null;
  toJSDate(): Date;
}

function isDateTime(value: unknown): value is DateTimeLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as DateTimeLike).toISODate === 'function' &&
    typeof (value as DateTimeLike).toJSDate === 'function'
  );
}

/** The offset of a time zone from UTC at an instant, in minutes. */
function offsetMinutes(timeZone: string, instant: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const local = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((local - Math.floor(instant / 1000) * 1000) / 60_000);
}

/** The instant a wall-clock time in a time zone stands for, as an ISO string. */
export function wallTimeToInstant(text: string, timeZone: string): string | null {
  const match = WALL_TIME.exec(text.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms] = match;
  const wall = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0),
    Number((ms ?? '0').padEnd(3, '0')),
  );
  // The zone's offset can differ across the hour a clock changes, so check it at the guess.
  let instant = wall - offsetMinutes(timeZone, wall) * 60_000;
  instant = wall - offsetMinutes(timeZone, instant) * 60_000;
  return new Date(instant).toISOString();
}

export function toDate(field: FieldMeta, value: unknown, ctx: ValueContext): string | null {
  const includeTime = field.options?.includeTime === true;
  const fail = (): never => {
    throw new ValueProblem(
      field.name,
      includeTime
        ? 'Expected a date and time, such as 2026-10-15T14:30:00Z or 2026-10-15 14:30.'
        : 'Expected a date, such as 2026-10-15.',
    );
  };
  if (isDateTime(value)) {
    if (!value.isValid) return fail();
    return includeTime ? value.toJSDate().toISOString() : value.toISODate();
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return fail();
    return includeTime ? value.toISOString() : value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string') return fail();
  const text = value.trim();
  if (DATE_ONLY.test(text)) return includeTime ? wallTimeToInstant(`${text}T00:00`, ctx.timeZone) : text;
  // A date field without a time keeps the day as written, whatever the offset.
  if (!includeTime) return /^\d{4}-\d{2}-\d{2}[T ]/.test(text) ? text.slice(0, 10) : fail();
  if (WITH_OFFSET.test(text)) {
    const time = Date.parse(text);
    return Number.isNaN(time) ? fail() : new Date(time).toISOString();
  }
  return wallTimeToInstant(text, ctx.timeZone) ?? fail();
}

export function toNumber(field: FieldMeta, value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))
    return Number(value.trim());
  throw new ValueProblem(field.name, `Expected a number, but got ${describe(value)}.`);
}

export function toBoolean(field: FieldMeta, value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'on', 'checked'].includes(text)) return true;
    if (['false', 'no', 'n', '0', 'off', 'unchecked', ''].includes(text)) return false;
  }
  throw new ValueProblem(field.name, `Expected true or false, but got ${describe(value)}.`);
}

function describe(value: unknown): string {
  if (typeof value === 'string') return `"${value.length > 60 ? `${value.slice(0, 57)}...` : value}"`;
  if (Array.isArray(value)) return 'a list';
  if (value && typeof value === 'object') return 'an object';
  return String(value);
}

/**
 * A list from a value that may already be one, may be JSON text holding one, or may be text with
 * commas between the items.  `whole` keeps text that is itself one item, such as an option's name.
 */
function listOf(value: unknown, whole?: (text: string) => boolean): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [value];
  const text = value.trim();
  if (text === '') return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Not JSON, so read it as a list with commas.
    }
  }
  if (whole?.(text)) return [text];
  return text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function recordIds(field: FieldMeta, value: unknown): string[] {
  return listOf(value).map((item) => {
    const id =
      typeof item === 'string'
        ? item.trim()
        : item && typeof item === 'object' && 'id' in item
          ? String((item as { id: unknown }).id)
          : '';
    if (!RECORD_ID.test(id))
      throw new ValueProblem(
        field.name,
        `Linked records go by record ID, such as rec followed by 14 letters and digits, but got ${describe(item)}.`,
      );
    return id;
  });
}

/** A file's ID from its ID, a file object from a read, or its Riosoma address. */
function fileId(field: FieldMeta, item: unknown): string {
  let candidate: unknown = item;
  if (item && typeof item === 'object') candidate = 'id' in item ? item.id : 'url' in item ? item.url : null;
  if (typeof candidate === 'string') {
    const text = candidate.trim();
    if (FILE_ID.test(text)) return text;
    const found = FILE_PATH.exec(text);
    if (found) return found[1]!;
  }
  throw new ValueProblem(
    field.name,
    `Files go by their Riosoma ID or address, such as a file from another record, but got ${describe(item)}.  Riosoma's API attaches files already stored in Riosoma, so upload other files in Riosoma first.`,
  );
}

function people(value: unknown): string[] {
  return listOf(value).map((item) => {
    if (item && typeof item === 'object') {
      if ('id' in item && typeof item.id === 'string') return item.id;
      if ('email' in item && typeof item.email === 'string') return item.email;
    }
    return String(item).trim();
  });
}

/** A value from an item in the form the REST API accepts for this field. */
export function toRiosoma(field: FieldMeta, value: unknown, ctx: ValueContext): unknown {
  if (!isWritable(field)) throw new ValueProblem(field.name, 'Riosoma fills in this field itself.');
  if (value === undefined || value === null) return null;
  if (value === '' && !TEXT_TYPES.includes(field.type)) return field.type === 'checkbox' ? false : null;
  const type = field.type;
  if (TEXT_TYPES.includes(type)) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (isDateTime(value)) return value.toJSDate().toISOString();
    if (value instanceof Date) return value.toISOString();
    throw new ValueProblem(field.name, `Expected text, but got ${describe(value)}.`);
  }
  if (NUMBER_TYPES.includes(type)) return toNumber(field, value);
  switch (type) {
    case 'checkbox':
      return toBoolean(field, value);
    case 'date':
      return toDate(field, value, ctx);
    case 'singleSelect': {
      const item = Array.isArray(value) ? value[0] : value;
      if (item && typeof item === 'object' && 'name' in item) return String(item.name);
      return item === undefined || item === null ? null : String(item);
    }
    case 'multipleSelect': {
      const names = new Set((field.options?.choices ?? []).map((choice) => choice.name));
      return listOf(value, (text) => names.has(text)).map((item) =>
        item && typeof item === 'object' && 'name' in item ? String(item.name) : String(item),
      );
    }
    case 'user':
      return people(value);
    case 'link':
      return recordIds(field, value);
    case 'attachment':
      return listOf(value).map((item) => fileId(field, item));
    default:
      // JSON, date ranges, locations, and signatures take the API's own forms as they are.
      return value;
  }
}

function absolute(address: string, url: unknown): unknown {
  return typeof url === 'string' && url.startsWith('/') ? `${address}${url}` : url;
}

/** A value from the REST API in the form an item carries.  Files get absolute addresses. */
export function fromRiosoma(type: string | undefined, value: unknown, ctx: Pick<ValueContext, 'address'>) {
  if (type !== 'attachment' || !Array.isArray(value)) return value;
  return value.map((file: unknown) => {
    if (!file || typeof file !== 'object') return file;
    const copy = { ...(file as Record<string, unknown>) };
    copy.url = absolute(ctx.address, copy.url);
    if (copy.thumbnails && typeof copy.thumbnails === 'object') {
      const thumbnails = { ...(copy.thumbnails as Record<string, unknown>) };
      for (const key of Object.keys(thumbnails)) thumbnails[key] = absolute(ctx.address, thumbnails[key]);
      copy.thumbnails = thumbnails;
    }
    return copy;
  });
}

/**
 * A record as an item's JSON: its fields, then its ID and when it was created.  The ID always
 * wins, so a field named `id` shows only when `nest` keeps the fields under `fields`.
 */
export function recordToJson(
  record: ApiRecord,
  fields: readonly FieldMeta[],
  ctx: Pick<ValueContext, 'address'>,
  nest = false,
): Record<string, unknown> {
  const types = new Map(fields.map((field) => [field.name, field.type]));
  const values: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(record.fields))
    values[name] = fromRiosoma(types.get(name), value, ctx);
  return nest
    ? { id: record.id, createdTime: record.createdTime, fields: values }
    : { ...values, id: record.id, createdTime: record.createdTime };
}
