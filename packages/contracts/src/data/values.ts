import { newId } from '../ids.js';
import {
  AttachmentId,
  isCurrencyCode,
  ChoiceId,
  isComputedType,
  LIMITS,
  RecordId,
  UserId,
  FieldMeta,
} from './fields.js';
import {
  isSignaturePath,
  isSignatureSize,
  jsonEqual,
  minifyJson,
  roundCoordinate,
  validCoordinates,
  type DateRangeValue,
  type LocationValue,
  type ObjectValue,
  type SignatureDrawing,
  type SignatureValue,
} from './compound-values.js';

/**
 * Cell values as they cross the API.  Text-like fields hold strings, numbers hold numbers,
 * checkboxes hold booleans, dates hold `YYYY-MM-DD` or an ISO 8601 instant in UTC, single selects
 * hold a choice ID, and multiple selects hold an array of choice IDs.  Date ranges, locations, and
 * signatures hold small objects, and JSON fields hold their JSON text.  `compound-values.ts` has
 * their shapes.  A long text field with rich text holds its Markdown, checked like any long text.
 * Empty is always null.
 */
/** One item of a list value: choice, record, and user IDs, or a lookup's values (empty ones left out) */
export interface LineItemValue {
  id: string;
  values: Record<string, CellValue>;
}
export type ListItem = string | number | boolean | ObjectValue | LineItemValue;
export type CellValue = string | number | boolean | ObjectValue | LineItemValue | ListItem[] | null;
export type CellValues = Record<string, CellValue>;

/** The IDs in a list of choices, records, or users, which only ever holds strings. */
export function idsOf(value: CellValue): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export type ValueCheck = { ok: true; value: CellValue } | { ok: false; messageKey: string };

const ok = (value: CellValue): ValueCheck => ({ ok: true, value });
const fail = (messageKey: string): ValueCheck => ({ ok: false, messageKey });

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** True for a real calendar date written as `YYYY-MM-DD`. */
export function isDateOnly(value: string): boolean {
  const m = DATE_ONLY.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function text(input: unknown, max: number, singleLine: boolean): ValueCheck {
  if (input === null || input === undefined) return ok(null);
  if (typeof input !== 'string') return fail('data.value.notText');
  const value = singleLine ? input.replace(/\r\n|\r|\n/g, ' ') : input.replace(/\r\n|\r/g, '\n');
  if (value.length > max) return fail('data.value.tooLong');
  return ok(value === '' ? null : value);
}

function numeric(input: unknown, allowNegative: boolean): ValueCheck {
  if (input === null || input === undefined) return ok(null);
  if (typeof input !== 'number' || !Number.isFinite(input)) return fail('data.value.notNumber');
  if (!allowNegative && input < 0) return fail('data.value.negative');
  return ok(Object.is(input, -0) ? 0 : input);
}

/** Round decimal digits before converting back to a number, including exponent notation. */
function roundAmount(value: number, precision: number): number {
  const [mantissa, exponent = '0'] = Math.abs(value).toString().split('e');
  const [whole, fraction = ''] = mantissa!.split('.');
  const digits = BigInt(whole! + fraction);
  const shift = Number(exponent) - fraction.length + precision;
  if (shift >= 0) return value;
  const divisor = 10n ** BigInt(-shift);
  const rounded = (digits + divisor / 2n) / divisor;
  return Number(`${value < 0 && rounded !== 0n ? '-' : ''}${rounded}e-${precision}`);
}

/** A list of unique IDs of one kind, in the order given; empty is null. */
function idList(
  input: unknown,
  valid: (id: unknown) => boolean,
  max: number,
  single: boolean,
  keys: { notList: string; unknown: string; single: string },
): ValueCheck {
  if (input === null || input === undefined) return ok(null);
  if (!Array.isArray(input) || input.length > max) return fail(keys.notList);
  const seen = new Set<string>();
  for (const id of input) {
    if (!valid(id)) return fail(keys.unknown);
    seen.add(id as string);
  }
  if (single && seen.size > 1) return fail(keys.single);
  return ok(seen.size === 0 ? null : [...seen]);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

/** One end of a date range, in the shape the matching date field stores, or null. */
function rangeEnd(input: unknown, includeTime: boolean): string | null {
  if (typeof input !== 'string') return null;
  if (!includeTime) return isDateOnly(input) ? input : null;
  if (!INSTANT.test(input)) return null;
  const time = Date.parse(input);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function dateRange(input: unknown, includeTime: boolean): ValueCheck {
  if (input === null || input === undefined || input === '') return ok(null);
  if (!isRecord(input)) return fail('data.value.dateRange');
  const start = rangeEnd(input.start, includeTime);
  const end = rangeEnd(input.end, includeTime);
  if (start === null || end === null) return fail('data.value.dateRange');
  // Days and UTC instants in this shape both sort as text.
  if (end < start) return fail('data.value.dateRange');
  return ok({ start, end } satisfies DateRangeValue);
}

function jsonText(input: unknown): ValueCheck {
  if (input === null || input === undefined) return ok(null);
  if (typeof input !== 'string') return fail('data.value.notJson');
  if (input.trim() === '') return ok(null);
  const text = minifyJson(input);
  if (text === null) return fail('data.value.notJson');
  if (text.length > LIMITS.jsonLength) return fail('data.value.tooLong');
  return ok(text === 'null' ? null : text);
}

function location(input: unknown): ValueCheck {
  if (input === null || input === undefined) return ok(null);
  if (!isRecord(input) || !validCoordinates(input.lat, input.lng)) return fail('data.value.location');
  const { label } = input;
  if (label !== undefined && label !== null && typeof label !== 'string') return fail('data.value.location');
  const text = typeof label === 'string' ? label.replace(/\r\n|\r|\n/g, ' ').trim() : '';
  if (text.length > LIMITS.locationLabelLength) return fail('data.value.tooLong');
  return ok({
    lat: roundCoordinate(input.lat),
    lng: roundCoordinate(input.lng as number),
    label: text || null,
  } satisfies LocationValue);
}

function signature(input: unknown): ValueCheck {
  if (input === null || input === undefined) return ok(null);
  if (!isRecord(input)) return fail('data.value.signature');
  const { drawing, name, signedBy, signedAt } = input;
  if (name !== undefined && name !== null && typeof name !== 'string') return fail('data.value.signature');
  const typed = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  if (typed.length > LIMITS.nameLength) return fail('data.value.tooLong');
  let drawn: SignatureDrawing | null = null;
  if (drawing !== undefined && drawing !== null) {
    if (!isRecord(drawing) || typeof drawing.path !== 'string') return fail('data.value.signature');
    if (drawing.path.length > LIMITS.signaturePathLength) return fail('data.value.tooLong');
    if (!isSignaturePath(drawing.path) || !isSignatureSize(drawing.width) || !isSignatureSize(drawing.height))
      return fail('data.value.signature');
    drawn = { path: drawing.path, width: drawing.width, height: drawing.height };
  }
  if (!drawn && !typed) return fail('data.value.signature');
  if (signedBy !== undefined && signedBy !== null && !UserId.safeParse(signedBy).success)
    return fail('data.value.signature');
  const at =
    signedAt === undefined || signedAt === null ? new Date().toISOString() : rangeEnd(signedAt, true);
  if (at === null) return fail('data.value.signature');
  return ok({
    drawing: drawn,
    name: typed || null,
    signedBy: typeof signedBy === 'string' ? signedBy : null,
    signedAt: at,
  } satisfies SignatureValue);
}

/**
 * Checks and normalizes one value for writing to a field.  The server runs this on every command,
 * and clients run it before applying an edit locally, so both sides agree on what gets stored.
 */
export function checkCellValue(field: FieldMeta, input: unknown): ValueCheck {
  if (field.type === 'button') return fail('data.value.button');
  if (isComputedType(field.type)) return fail('data.value.computed');
  switch (field.type) {
    case 'time': {
      if (input === null || input === undefined || input === '') return ok(null);
      if (typeof input !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(input))
        return fail('data.value.time');
      return ok(input.length === 5 ? `${input}:00` : input);
    }
    case 'multiCurrency': {
      if (input === null || input === undefined) return ok(null);
      if (!isRecord(input) || typeof input.code !== 'string' || !isCurrencyCode(input.code))
        return fail('data.value.multiCurrency');
      const amount = numeric(input.amount, field.options.allowNegative);
      if (!amount.ok) return amount;
      if (typeof amount.value !== 'number') return fail('data.value.multiCurrency');
      return ok({ amount: roundAmount(amount.value, field.options.precision), code: input.code });
    }
    case 'barcode':
    case 'text':
      return text(input, LIMITS.textLength, true);
    case 'longText':
      return text(input, LIMITS.longTextLength, false);
    case 'number':
    case 'currency':
    case 'percent':
      return numeric(input, field.options.allowNegative);
    case 'duration':
      return numeric(input, false);
    case 'rating': {
      if (input === null || input === undefined || input === 0) return ok(null);
      if (typeof input !== 'number' || !Number.isInteger(input)) return fail('data.value.notNumber');
      return input >= 1 && input <= field.options.max ? ok(input) : fail('data.value.rating');
    }
    case 'user':
      return idList(
        input,
        (id) => UserId.safeParse(id).success,
        LIMITS.usersPerCell,
        !field.options.allowMultiple,
        {
          notList: 'data.user.notList',
          unknown: 'data.user.unknown',
          single: 'data.user.single',
        },
      );
    case 'attachment':
      return idList(input, (id) => AttachmentId.safeParse(id).success, LIMITS.attachmentsPerCell, false, {
        notList: 'data.file.notList',
        unknown: 'data.file.unknown',
        single: 'data.file.unknown',
      });
    case 'checkbox':
      if (input === null || input === undefined) return ok(false);
      return typeof input === 'boolean' ? ok(input) : fail('data.value.notBoolean');
    case 'date': {
      if (input === null || input === undefined || input === '') return ok(null);
      if (typeof input !== 'string') return fail('data.value.notDate');
      if (!field.options.includeTime) return isDateOnly(input) ? ok(input) : fail('data.value.notDate');
      if (!INSTANT.test(input)) return fail('data.value.notDate');
      const time = Date.parse(input);
      return Number.isNaN(time) ? fail('data.value.notDate') : ok(new Date(time).toISOString());
    }
    case 'singleSelect': {
      if (input === null || input === undefined || input === '') return ok(null);
      if (typeof input !== 'string') return fail('data.value.unknownChoice');
      if (field.options.source)
        return ChoiceId.safeParse(input).success ? ok(input) : fail('data.value.unknownChoice');
      return field.options.choices.some((c) => c.id === input) ? ok(input) : fail('data.value.unknownChoice');
    }
    case 'multipleSelect': {
      if (input === null || input === undefined) return ok(null);
      if (!Array.isArray(input)) return fail('data.value.notList');
      if (input.length > LIMITS.choicesPerField) return fail('data.value.unknownChoice');
      const known = new Set(field.options.choices.map((c) => c.id));
      const seen = new Set<string>();
      for (const id of input) {
        if (
          typeof id !== 'string' ||
          (field.options.source ? !ChoiceId.safeParse(id).success : !known.has(id))
        )
          return fail('data.value.unknownChoice');
        seen.add(id);
      }
      return ok(seen.size === 0 ? null : [...seen]);
    }
    case 'email': {
      const checked = text(typeof input === 'string' ? input.trim() : input, LIMITS.emailLength, true);
      if (!checked.ok || checked.value === null) return checked;
      return EMAIL.test(checked.value as string) ? checked : fail('data.value.notEmail');
    }
    case 'url': {
      const checked = text(typeof input === 'string' ? input.trim() : input, LIMITS.urlLength, true);
      if (!checked.ok || checked.value === null) return checked;
      return /\s/.test(checked.value as string) ? fail('data.value.notUrl') : checked;
    }
    case 'phone':
      return text(typeof input === 'string' ? input.trim() : input, LIMITS.phoneLength, true);
    case 'dateRange':
      return dateRange(input, field.options.includeTime);
    case 'json':
      return jsonText(input);
    case 'location':
      return location(input);
    case 'signature':
      return signature(input);
    case 'lineItems': {
      if (Array.isArray(input) && input.some((row) => typeof row !== 'string')) {
        if (input.length > LIMITS.recordsPerCommand) return fail('data.link.notList');
        const rows: LineItemValue[] = [];
        const seen = new Set<string>();
        for (const raw of input) {
          if (!isRecord(raw) || !isRecord(raw.values)) return fail('data.link.notList');
          const id = raw.id === undefined ? newId('record') : raw.id;
          if (!RecordId.safeParse(id).success || seen.has(String(id))) return fail('data.link.unknownRecord');
          seen.add(String(id));
          const values: Record<string, CellValue> = {};
          for (const [key, value] of Object.entries(raw.values)) {
            const column = field.options.columns.find((column) => column.id === key);
            if (!column) return fail('data.field.unknown');
            const spec = FieldMeta.safeParse({
              ...column,
              tableId: field.options.linkedTableId,
              position: 0,
              createdAt: '',
              updatedAt: '',
            });
            if (!spec.success) return fail('data.field.unknown');
            const checked = checkCellValue(spec.data, value);
            if (!checked.ok) return checked;
            values[key] = checked.value;
          }
          rows.push({ id: String(id), values });
        }
        return ok(rows);
      }
      // Stored values remain linked record IDs, including an empty list.
      if (input === null || input === undefined) return ok(null);
      if (!Array.isArray(input) || input.length > LIMITS.linksPerCell) return fail('data.link.notList');
      if (input.some((id) => !RecordId.safeParse(id).success)) return fail('data.link.unknownRecord');
      return ok([...new Set(input as string[])]);
    }
    case 'link': {
      if (input === null || input === undefined) return ok(null);
      if (!Array.isArray(input) || input.length > LIMITS.linksPerCell) return fail('data.link.notList');
      const seen = new Set<string>();
      for (const id of input) {
        if (!RecordId.safeParse(id).success) return fail('data.link.unknownRecord');
        seen.add(id as string);
      }
      if (field.options.prefersSingle && seen.size > 1) return fail('data.link.single');
      return ok(seen.size === 0 ? null : [...seen]);
    }
    default:
      return fail('data.value.computed');
  }
}

export function isEmptyValue(value: CellValue | undefined): boolean {
  return (
    value === null ||
    value === undefined ||
    value === false ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** Whether two stored values are the same, treating the different kinds of empty as equal. */
export function sameValue(a: CellValue | undefined, b: CellValue | undefined): boolean {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i] || jsonEqual(v, b[i]));
  }
  return a === b || jsonEqual(a, b);
}

export function isDateRangeValue(value: unknown): value is DateRangeValue {
  return isRecord(value) && typeof value.start === 'string' && typeof value.end === 'string';
}

export function isLocationValue(value: unknown): value is LocationValue {
  return isRecord(value) && typeof value.lat === 'number' && typeof value.lng === 'number';
}

export function isSignatureValue(value: unknown): value is SignatureValue {
  return isRecord(value) && typeof value.signedAt === 'string' && 'drawing' in value;
}
