import { Leaf } from '../rest/records.js';

/**
 * How a MongoDB document becomes a record the API sources' flattening reads.  JSON's own types
 * stay as they are, and each of MongoDB's own becomes a leaf that says how it reads:
 *
 * - `ObjectId` is its 24-character hex text, and a UUID its usual dashed text.
 * - A date is an instant, which reads as a date with a time in UTC, and so does a timestamp.
 * - `Decimal128` is its exact decimal text, and so is a 64-bit whole number too long for a number.
 *   The driver hands over shorter ones as ordinary numbers, which hold them exactly.
 * - Binary data Riosoma can't hold, so a column of it is offered as unsupported and left out.
 * - A regular expression, stored code, and the lowest and highest keys read as their text.
 *
 * Inside JSON, the same values take their JSON forms: hex and dashed text, ISO instants, and exact
 * numbers, with binary data left out.  A document's `_id` is never flattened, since it has to
 * stay one value to be the record's key, so an `_id` that is itself a document reads as JSON.
 */

/** JSON's own writer puts an exact number's text in place, without rounding it. */
const RAW = JSON as unknown as { rawJSON(text: string): object };

/** How far a document nests before the rest of it is left out, a guard against a pathological one. */
const MOST_DEPTH = 100;

/** Exponents past this keep their scientific form, which is exact but would be very long written out. */
const MOST_EXPONENT = 200;

function bsonType(value: object): string | undefined {
  const type = (value as { _bsontype?: unknown })._bsontype;
  return typeof type === 'string' ? type : undefined;
}

/**
 * A decimal's exact text, written out in full rather than in scientific form, like `123000` for
 * `1.23E+5`, so it reads as a number anywhere one is read.  Trailing zeros stay, since they're
 * part of what was stored.
 */
export function plainDecimal(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?E([+-]\d+)$/i.exec(text);
  if (!match) return text;
  const [, sign, whole, fraction = '', exponent] = match;
  const shift = Number(exponent);
  if (Math.abs(shift) > MOST_EXPONENT) return text;
  const digits = whole! + fraction;
  const point = whole!.length + shift;
  const written =
    point <= 0
      ? `0.${'0'.repeat(-point)}${digits}`
      : point >= digits.length
        ? `${digits}${'0'.repeat(point - digits.length)}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${sign}${written.replace(/^0+(?=\d)/, '')}`;
}

function instant(date: Date, shape: 'date' | 'timestamp'): Leaf {
  if (!Number.isFinite(date.getTime())) return new Leaf(null, shape, null, null);
  const text = date.toISOString();
  return new Leaf({ date: text }, shape, text, text);
}

function exact(text: string, shape: 'decimal' | 'long'): Leaf {
  // A decimal can be NaN or infinite, which no field holds.
  if (!/^-?\d/.test(text)) return new Leaf(null, shape, null, text);
  const written = shape === 'decimal' ? plainDecimal(text) : text;
  return new Leaf(written, shape, RAW.rawJSON(written), written);
}

function textLeaf(text: string, shape: 'objectId' | 'uuid' | 'regex' | 'code' | 'key'): Leaf {
  return new Leaf(text, shape, text, text);
}

const BINARY = new Leaf(null, 'binary', undefined, null);

/** A UUID's usual dashed text, from the 16 bytes of a binary value of the UUID subtype. */
function uuidText(value: { [name: string]: unknown }): string | null {
  const bytes = value.buffer;
  if (value.sub_type !== 4 || !(bytes instanceof Uint8Array)) return null;
  const length = typeof value.position === 'number' ? value.position : bytes.length;
  if (length !== 16) return null;
  const hex = Buffer.from(bytes.subarray(0, 16)).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** One of MongoDB's own values as a leaf, or undefined for a value that isn't one. */
export function leafOf(value: unknown): Leaf | undefined {
  if (value instanceof Date) return instant(value, 'date');
  if (typeof value === 'bigint') return exact(value.toString(), 'long');
  if (typeof value !== 'object' || value === null) return undefined;
  if (value instanceof Uint8Array) return BINARY;
  const bson = value as { toString(): string; [name: string]: unknown };
  switch (bsonType(value)) {
    case 'ObjectId':
      return textLeaf((value as { toHexString(): string }).toHexString(), 'objectId');
    case 'Long':
      return exact(bson.toString(), 'long');
    case 'Decimal128':
      return exact(bson.toString(), 'decimal');
    case 'Binary': {
      const uuid = uuidText(bson);
      return uuid === null ? BINARY : textLeaf(uuid, 'uuid');
    }
    case 'Timestamp':
      return instant(new Date(Number(bson.t) * 1_000), 'timestamp');
    case 'BSONRegExp':
      return textLeaf(`/${String(bson.pattern)}/${String(bson.options)}`, 'regex');
    case 'Code':
      return textLeaf(String(bson.code), 'code');
    case 'MinKey':
      return textLeaf('MinKey', 'key');
    case 'MaxKey':
      return textLeaf('MaxKey', 'key');
    default:
      return undefined;
  }
}

function convert(value: unknown, depth: number): unknown {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') return value;
  const leaf = leafOf(value);
  if (leaf) return leaf;
  if (typeof value !== 'object' || depth > MOST_DEPTH) return undefined;
  if (Array.isArray(value)) return value.map((item) => convert(item, depth + 1));
  if (value instanceof RegExp) return textLeaf(String(value), 'regex');
  const bson = value as Record<string, unknown>;
  switch (bsonType(value)) {
    case 'BSONSymbol':
      return String(bson.value);
    case 'Int32':
    case 'Double':
      return Number(bson.value);
    case 'DBRef':
      return {
        $ref: bson.collection,
        $id: convert(bson.oid, depth + 1),
        ...(bson.db ? { $db: bson.db } : {}),
      };
    default: {
      const record: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(bson)) record[key] = convert(inner, depth + 1);
      return record;
    }
  }
}

/** A document as a record whose MongoDB values are leaves, ready for the API sources' flattening. */
export function documentRecord(document: Record<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    const converted = convert(value, 0);
    record[key] =
      key === '_id' && typeof converted === 'object' && converted !== null && !(converted instanceof Leaf)
        ? new Leaf(JSON.stringify(converted), 'json', converted, null)
        : converted;
  }
  return record;
}
