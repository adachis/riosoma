import { LIMITS } from './fields.js';

/**
 * The values of date range, location, and signature fields, which are small objects, and the text
 * of JSON fields.  Everything here is pure and shared, so the server, the web app, and the public
 * API read and write these values the same way.
 *
 * API shapes (read and write alike):
 * - Date range: `{ "start": "2026-09-27", "end": "2026-09-30" }`, or ISO 8601 instants in UTC when
 *   the field includes a time.  The end is on or after the start, and a one-day range repeats the day.
 * - Location: `{ "lat": 40.7128, "lng": -74.006, "label": "New York" }`.  Degrees are rounded to
 *   six decimal places (about 11 cm), and `label` is optional.
 * - Signature: `{ "drawing": { "path": "M10 20l3 -2…", "width": 400, "height": 150 },
 *   "name": "Ada Lovelace", "signedBy": "usr…", "signedAt": "2026-09-27T15:05:00.000Z" }`.  A
 *   drawing, a typed name, or both.  Writers send `drawing` and `name`, and the server fills in
 *   `signedBy` and `signedAt` itself on every write, so a signature can be replaced but never
 *   edited, and nobody can sign as someone else.
 * - JSON: the command API carries the JSON text, `{"a":1}`, and the public REST API reads and writes
 *   the JSON value itself.  JSON `null` is the same as empty.
 * - Button: holds no value.  The public REST API reads it as `{ "label": …, "url": … }`, with
 *   `url` null when the filled link isn't `http` or `https`.
 */

/** A date range's first and last day, or first and last moment when the field includes a time. */
export interface DateRangeValue {
  start: string;
  end: string;
}

/** A place, in degrees, with an optional label such as an address. */
export interface LocationValue {
  lat: number;
  lng: number;
  label: string | null;
}

/** A drawn signature: SVG path data in the coordinates of the pad it was drawn on. */
export interface SignatureDrawing {
  path: string;
  width: number;
  height: number;
}

export interface SignatureValue {
  drawing: SignatureDrawing | null;
  /** The name the signer typed: the whole signature when nothing was drawn */
  name: string | null;
  /** The person signed in when it was written, or null for a public form */
  signedBy: string | null;
  signedAt: string;
}

/** A scoped history entry, labeled in the reader's language and time zone. */
export interface ChangeLogEntry {
  at: string;
  actorId: string | null;
  fieldIds: string[];
}

export function isChangeLogEntry(value: unknown): value is ChangeLogEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'at' in value &&
    typeof value.at === 'string' &&
    'actorId' in value &&
    (value.actorId === null || typeof value.actorId === 'string') &&
    'fieldIds' in value &&
    Array.isArray(value.fieldIds) &&
    value.fieldIds.every((id) => typeof id === 'string')
  );
}

/** An amount in one currency, without implicit exchange-rate conversion. */
export interface MultiCurrencyValue {
  amount: number;
  code: string;
}

export function isMultiCurrencyValue(value: unknown): value is MultiCurrencyValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    'amount' in value &&
    typeof value.amount === 'number' &&
    Number.isFinite(value.amount) &&
    'code' in value &&
    typeof value.code === 'string'
  );
}

export type ObjectValue =
  ChangeLogEntry | DateRangeValue | LocationValue | SignatureValue | MultiCurrencyValue;

// ------------------------------------------------------------------------------------------ JSON

/** A JSON string, or a run of JSON's own whitespace between tokens. */
const JSON_SPACING = /"(?:[^"\\]|\\.)*"|[ \t\n\r]+/g;
/** Strings, punctuation, and the bare words and numbers between them. */
const JSON_TOKEN = /"(?:[^"\\]|\\.)*"|[{}[\],:]|[^{}[\],:"]+/g;

/**
 * The JSON text without the spacing between its tokens, or null when it isn't JSON.  Numbers,
 * key order, and repeated keys stay exactly as written, which parsing and printing again would
 * not promise.
 */
export function minifyJson(text: string): string | null {
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  return text.replace(JSON_SPACING, (match) => (match.startsWith('"') ? match : ''));
}

/** The JSON text laid out with two-space indents, one member or item to a line. */
export function prettyJson(text: string): string {
  const compact = minifyJson(text);
  if (compact === null) return text;
  const tokens = compact.match(JSON_TOKEN) ?? [];
  let out = '';
  let depth = 0;
  const line = () => `\n${'  '.repeat(depth)}`;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === '{' || token === '[') {
      const close = token === '{' ? '}' : ']';
      if (tokens[i + 1] === close) {
        out += token + close;
        i += 1;
        continue;
      }
      depth += 1;
      out += token + line();
    } else if (token === '}' || token === ']') {
      depth -= 1;
      out += line() + token;
    } else if (token === ',') out += `,${line()}`;
    else if (token === ':') out += ': ';
    else out += token;
  }
  return out;
}

/** Whether two values hold the same JSON, whatever order their keys are in. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
  const left = Object.entries(a as Record<string, unknown>).filter(([, value]) => value !== undefined);
  const right = b as Record<string, unknown>;
  return (
    left.length === Object.values(right).filter((value) => value !== undefined).length &&
    left.every(([key, value]) => Object.hasOwn(right, key) && jsonEqual(value, right[key]))
  );
}

// ------------------------------------------------------------------------------------- location

/** Six decimal places, about 11 cm, keeps coordinates short and always written without exponents. */
export function roundCoordinate(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function validCoordinates(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/** `40.7128, -74.006`: how a location exports, copies its coordinates, and reads in formulas. */
export function coordinatesText(value: Pick<LocationValue, 'lat' | 'lng'>): string {
  return `${value.lat}, ${value.lng}`;
}

const COORDINATES = /^\(?\s*([+-]?\d{1,3}(?:[.,]\d+)?)\s*([,;]|\s)\s*([+-]?\d{1,3}(?:[.,]\d+)?)\s*\)?$/;

/**
 * Coordinates typed or pasted as `lat, lng`, the way maps copy them.  A decimal comma works when
 * a semicolon or a space separates the two numbers.  Out-of-range numbers read as nothing.
 */
export function parseCoordinates(text: string): { lat: number; lng: number } | null {
  const trimmed = text.trim();
  // Nothing longer is a pair of coordinates, and the limit keeps the pattern's work small.
  if (trimmed.length > 100) return null;
  const match = COORDINATES.exec(trimmed);
  if (!match) return null;
  const [, first, separator, second] = match as unknown as [string, string, string, string];
  if (separator === ',' && (first.includes(',') || second.includes(','))) return null;
  const lat = Number(first.replace(',', '.'));
  const lng = Number(second.replace(',', '.'));
  return validCoordinates(lat, lng) ? { lat: roundCoordinate(lat), lng: roundCoordinate(lng) } : null;
}

/** A location's label and coordinates as one line, `Paris (48.8566, 2.3522)`, which reads back. */
export function locationText(value: LocationValue): string {
  return value.label ? `${value.label} (${coordinatesText(value)})` : coordinatesText(value);
}

/** Text in either form `locationText` writes, or bare coordinates. */
export function parseLocationText(text: string): LocationValue | null {
  const trimmed = text.trim();
  if (trimmed.length > LIMITS.locationLabelLength + 100) return null;
  const bare = parseCoordinates(trimmed);
  if (bare) return { ...bare, label: null };
  const labeled = /^(.*\S)\s*\(([^()]*)\)$/.exec(trimmed);
  const coordinates = labeled ? parseCoordinates(labeled[2]!) : null;
  return labeled && coordinates ? { ...coordinates, label: labeled[1]! } : null;
}

/** Great-circle distance in kilometers, on a sphere of the Earth's mean radius. */
export function distanceKm(a: Pick<LocationValue, 'lat' | 'lng'>, b: Pick<LocationValue, 'lat' | 'lng'>) {
  const radians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * radians;
  const dLng = (b.lng - a.lng) * radians;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const EARTH_RADIUS_KM = 6371.0088;

// ----------------------------------------------------------------------------------- date range

/**
 * The two ends of a date range written as text: `2026-09-27/2026-09-30` (ISO 8601), or two dates
 * joined by an en or em dash, ` - `, or ` to `.  One date on its own is a one-day range.
 */
export function splitDateRangeText(text: string): [string, string] {
  const trimmed = text.trim();
  // Two dates never run this long, and the limit keeps the patterns' work small.
  if (trimmed.length > 200) return [trimmed, trimmed];
  const dash = /\s*[–—]\s*/.exec(trimmed);
  const joined = dash ?? /\s+to\s+/i.exec(trimmed) ?? /\s+-\s+/.exec(trimmed);
  if (joined && joined.index > 0)
    return [trimmed.slice(0, joined.index).trim(), trimmed.slice(joined.index + joined[0].length).trim()];
  const iso = /^(\d{4}-\d{2}-\d{2}[^/\s]*)\/(\d{4}-\d{2}-\d{2}\S*)$/.exec(trimmed);
  return iso ? [iso[1]!, iso[2]!] : [trimmed, trimmed];
}

/** `2026-09-27/2026-09-30`: how a date range exports as plain text, and reads in formulas. */
export function dateRangeText(value: DateRangeValue): string {
  return `${value.start}/${value.end}`;
}

// ------------------------------------------------------------------------------------ signature

/** Move and line commands with their numbers: what the signature pad draws. */
const PATH_TOKEN = /[MmLl]|-?\d{1,6}(?:\.\d{1,3})?|[\s,]+/g;

/**
 * Whether text is signature path data: `M` or `m` first, then moves and lines, each command
 * followed by pairs of numbers.  Nothing else can reach a drawing, so a stored signature is always
 * safe to put in an SVG.
 */
export function isSignaturePath(path: string): boolean {
  if (path.length === 0) return false;
  let consumed = 0;
  let numbers = -1;
  for (const match of path.matchAll(PATH_TOKEN)) {
    if (match.index !== consumed) return false;
    consumed += match[0].length;
    const token = match[0];
    if (/^[\s,]/.test(token)) continue;
    if (/^[MmLl]$/.test(token)) {
      if (numbers === -1 ? !/[Mm]/.test(token) : numbers === 0 || numbers % 2 !== 0) return false;
      numbers = 0;
    } else {
      if (numbers === -1) return false;
      numbers += 1;
    }
  }
  return consumed === path.length && numbers > 0 && numbers % 2 === 0;
}

/** A pad's width or height in pixels. */
export function isSignatureSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= LIMITS.signatureSize;
}
