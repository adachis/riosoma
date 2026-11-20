import type { CellValue, RestEndpoint, SourceColumn } from '@riosoma/contracts';
import {
  cellColumn,
  cellValue,
  emptyStats,
  keyFieldType,
  observe,
  parseNumber,
  readingOf,
  type CellReading,
  type CellStats,
  type FileCell,
} from '../files/cells.js';

/**
 * How an API source turns JSON records into columns.  Nested objects become dotted columns, like
 * `address.city`, down to the endpoint's depth, and anything deeper stays JSON.  Lists of plain
 * values become text joined with commas, or JSON when the endpoint says so, and lists of objects
 * are always JSON.  Types then come from the rules file sources use, over the records sampled, so
 * an API and a file with the same values agree on every column's type.  MongoDB sources flatten
 * their documents by the same rules, with their own types arriving as leaves.
 */

/** JSON's own number reader keeps whole numbers past 2^53 as their exact text. */
const RAW = JSON as unknown as {
  rawJSON(text: string): object;
  isRawJSON(value: unknown): value is { rawJSON: string };
};

/** Records sampled for types, as the importer samples a column's first thousand values. */
export const SAMPLE_RECORDS = 1_000;
/** Pages read for a sample at most, however few records they hold. */
export const SAMPLE_PAGES = 10;
/** Columns a record set may have, a guard against records keyed by their own values. */
export const MAX_COLUMNS = 500;
const MAX_NAME = 255;
const KEYABLE_TYPES = new Set(['number', 'text', 'email', 'url', 'phone', 'date']);

/**
 * How a value arrived: a plain JSON value, a list joined as text, JSON, or a whole number too long
 * for a number.  Sources whose records hold more than JSON's types, like MongoDB's, add their own,
 * which arrive as leaves.
 */
export type Shape =
  | 'string'
  | 'number'
  | 'boolean'
  | 'list'
  | 'json'
  | 'integer'
  | 'objectId'
  | 'date'
  | 'decimal'
  | 'long'
  | 'uuid'
  | 'binary'
  | 'timestamp'
  | 'regex'
  | 'code'
  | 'key';

/** Shapes kept exactly as their text, since a number can't hold every value they have. */
const EXACT_SHAPES = new Set<Shape>(['integer', 'decimal', 'long']);
/** Shapes that are text whatever they look like, like an ID that happens to be all digits. */
const TEXT_SHAPES = new Set<Shape>(['objectId', 'uuid', 'regex', 'code', 'key']);
/** Shapes Riosoma can't hold, like binary data, which read as empty. */
const UNSUPPORTED_SHAPES = new Set<Shape>(['binary']);
/**
 * Shapes a source declares as numbers, whose exact text converts to a number when someone chooses
 * one.  A JSON whole number too long for a number is usually an ID, so it isn't one of them.
 */
const NUMERIC_SHAPES = new Set<Shape>(['number', 'decimal', 'long']);

/**
 * A value a source has already read in its own terms, for records that hold more than JSON's
 * types.  It flattens as one cell and is never walked into.  In a list joined as text it is its
 * `text`, and inside JSON it is its `json`, where undefined leaves it out.
 */
export class Leaf {
  constructor(
    readonly cell: FileCell,
    readonly shape: Shape,
    readonly json: unknown,
    /** How it reads in a list joined as text, or null when it can't be part of one */
    readonly text: string | null,
  ) {}

  toJSON(): unknown {
    return this.json;
  }
}

/** Reads a JSON answer, keeping long whole numbers, like large IDs, exactly as written. */
export function parseJson(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' && Math.abs(value) > Number.MAX_SAFE_INTEGER && context?.source
      ? RAW.rawJSON(context.source)
      : value,
  );
}

export function isRecordObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !RAW.isRawJSON(value) &&
    !(value instanceof Leaf)
  );
}

/** The value at a path like `data.items`, where a number picks a list's item, or undefined. */
export function valueAt(document: unknown, path: string): unknown {
  if (path === '') return document;
  let current = document;
  for (const part of path.split('.')) {
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
    else if (isRecordObject(current) && Object.hasOwn(current, part)) current = current[part];
    else return undefined;
  }
  return current;
}

/** A value at a path as text a request can carry, like a cursor, or null when it isn't one. */
export function textAt(document: unknown, path: string): string | null {
  const value = valueAt(document, path);
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (RAW.isRawJSON(value)) return value.rawJSON;
  return null;
}

/** Paths in an answer that hold lists, nearest first, for saying where the records might be. */
export function listPaths(document: unknown, limit = 8): string[] {
  const found: string[] = [];
  const queue: Array<[unknown, string, number]> = [[document, '', 0]];
  while (queue.length && found.length < limit) {
    const [value, path, depth] = queue.shift()!;
    if (Array.isArray(value)) {
      found.push(path);
      continue;
    }
    if (!isRecordObject(value) || depth >= 3) continue;
    for (const [key, inner] of Object.entries(value).slice(0, 100))
      queue.push([inner, path ? `${path}.${key}` : key, depth + 1]);
  }
  return found;
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    RAW.isRawJSON(value) ||
    (value instanceof Leaf && value.text !== null)
  );
}

function scalarText(value: unknown): string {
  if (value instanceof Leaf) return value.text ?? '';
  return RAW.isRawJSON(value) ? value.rawJSON : String(value);
}

export type Emit = (name: string, cell: FileCell, shape: Shape | null) => void;

/**
 * Every column one record has, with its cell and how the value arrived.  A record that isn't an
 * object, like a plain string in a list of tags, becomes one column named `value`.
 */
export function flatten(
  record: unknown,
  endpoint: Pick<RestEndpoint, 'flattenDepth' | 'arrays'>,
  emit: Emit,
  nameOf: (path: string[]) => string = (path) => path.join('.'),
) {
  const value = (name: string, raw: unknown): void => {
    if (raw === null || raw === undefined) emit(name, null, null);
    else if (raw instanceof Leaf) emit(name, raw.cell, raw.shape);
    else if (typeof raw === 'string') emit(name, raw, 'string');
    else if (typeof raw === 'number') emit(name, Number.isFinite(raw) ? raw : null, 'number');
    else if (typeof raw === 'boolean') emit(name, raw, 'boolean');
    else if (RAW.isRawJSON(raw)) emit(name, raw.rawJSON, 'integer');
    else if (Array.isArray(raw) && endpoint.arrays === 'text' && raw.every(isScalar)) {
      const parts = raw.filter((item) => item !== null).map(scalarText);
      emit(name, parts.length ? parts.join(', ') : null, 'list');
    } else emit(name, JSON.stringify(raw), 'json');
  };
  const walk = (object: Record<string, unknown>, prefix: string[], level: number): void => {
    for (const [key, inner] of Object.entries(object)) {
      const path = [...prefix, key];
      if (isRecordObject(inner) && level < endpoint.flattenDepth && Object.keys(inner).length > 0)
        walk(inner, path, level + 1);
      else value(nameOf(path), inner);
    }
  };
  if (isRecordObject(record)) walk(record, [], 0);
  else value('value', record);
}

/** One record's cells by column name. */
export function cellsOf(
  record: unknown,
  endpoint: Pick<RestEndpoint, 'flattenDepth' | 'arrays'>,
  nameOf?: (path: string[]) => string,
): Map<string, FileCell> {
  const cells = new Map<string, FileCell>();
  flatten(
    record,
    endpoint,
    (name, cell) => {
      if (!cells.has(name)) cells.set(name, cell);
    },
    nameOf,
  );
  return cells;
}

/** A column as an API source describes it, and how its cells become values and key parts. */
export interface RestColumn {
  column: SourceColumn;
  reading: CellReading;
  keyable: boolean;
  value(cell: FileCell | undefined, fieldType: string): CellValue;
  key(cell: FileCell | undefined): CellValue;
}

/** A column read with no sample behind it, as text, the way a missing column's values arrive. */
export function plainColumn(name: string): RestColumn {
  return restColumn(name, 'null', PLAIN_TEXT, false);
}

const PLAIN_TEXT: CellReading = { type: 'text', precision: 0, dateOrder: 'mdy' };

function restColumn(
  name: string,
  sourceType: string,
  reading: CellReading,
  json: boolean,
  numeric = false,
): RestColumn {
  const described = cellColumn(name, sourceType, reading);
  const keyType = keyFieldType(reading);
  return {
    // JSON is kept as it came, so it converts only to plain text, and a number kept exactly as text
    // converts to a number for someone who accepts the rounding.
    column: json
      ? { ...described, alternatives: ['text'] }
      : numeric
        ? { ...described, alternatives: ['number', 'longText'] }
        : described,
    reading,
    keyable: !json && KEYABLE_TYPES.has(keyType),
    value: (cell, fieldType) => cellValue(cell ?? null, fieldType, reading),
    // Keys preserve source values even when a numeric or date field is requested.
    key: (cell) =>
      typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean'
        ? cell
        : cellValue(cell ?? null, 'text', PLAIN_TEXT),
  };
}

/** A column of values Riosoma can't hold, offered as unsupported and left out. */
function unsupportedColumn(name: string, sourceType: string): RestColumn {
  return {
    column: { name, sourceType, nullable: true, suggested: null, alternatives: [] },
    reading: PLAIN_TEXT,
    keyable: false,
    value: () => null,
    key: () => null,
  };
}

/**
 * Collects records' columns in the order they first appear, with what the type rules notice about
 * each one, until it has seen enough to describe them.
 */
export class Sampler {
  private readonly columns = new Map<string, { stats: CellStats; shapes: Set<Shape>; exactText: boolean }>();
  records = 0;

  constructor(
    private readonly endpoint: Pick<RestEndpoint, 'flattenDepth' | 'arrays'>,
    private readonly nameOf?: (path: string[]) => string,
  ) {}

  /** Metadata adds names without inventing records or influencing inferred types. */
  declare(names: readonly string[]): void {
    for (const name of names)
      if (!this.columns.has(name) && this.columns.size < MAX_COLUMNS && name.length <= MAX_NAME)
        this.columns.set(name, { stats: emptyStats(), shapes: new Set(), exactText: false });
  }

  add(record: unknown): void {
    this.records++;
    // A record's first value for a name is the one it keeps, as `cellsOf` does.
    const named = new Set<string>();
    flatten(
      record,
      this.endpoint,
      (name, cell, shape) => {
        if (named.has(name)) return;
        named.add(name);
        let column = this.columns.get(name);
        if (!column) {
          if (this.columns.size >= MAX_COLUMNS || name.length > MAX_NAME) return;
          column = { stats: emptyStats(), shapes: new Set(), exactText: false };
          this.columns.set(name, column);
        }
        const number = typeof cell === 'number' ? cell : typeof cell === 'string' ? parseNumber(cell) : null;
        // Long digit strings can be identifiers even when their numeric value would fit.
        column.exactText ||=
          (typeof cell === 'string' && /^[+-]?\d{16,}$/.test(cell.trim())) ||
          (number !== null && Math.abs(number) > Number.MAX_SAFE_INTEGER);
        observe(column.stats, cell);
        if (shape) column.shapes.add(shape);
      },
      this.nameOf,
    );
  }

  get full(): boolean {
    return this.records >= SAMPLE_RECORDS;
  }

  describe(): RestColumn[] {
    return [...this.columns].map(([name, { stats, shapes, exactText }]) => {
      const sourceType = shapes.size === 0 ? 'null' : shapes.size === 1 ? [...shapes][0]! : 'mixed';
      const json = shapes.has('json');
      // Values Riosoma can't hold read as empty, so a column of nothing else is left out.
      const held = [...shapes].filter((shape) => !UNSUPPORTED_SHAPES.has(shape));
      if (!json && shapes.size > 0 && held.length === 0) return unsupportedColumn(name, sourceType);
      const exact = held.some((shape) => EXACT_SHAPES.has(shape));
      const reading: CellReading = json
        ? { type: 'longText', precision: 0, dateOrder: 'mdy' }
        : exactText || exact || held.some((shape) => TEXT_SHAPES.has(shape))
          ? // Numbers too long for a number are kept exactly, as text, and IDs are always text.
            PLAIN_TEXT
          : readingOf(stats);
      const numeric = !json && exact && held.every((shape) => NUMERIC_SHAPES.has(shape));
      return restColumn(name, sourceType, reading, json, numeric);
    });
  }
}

/**
 * Columns whose values are all there and all different, as key candidates, `id` first when it
 * qualifies.  It watches every record of a full read, and forgets a column once it fails.
 */
export class KeyScan {
  private readonly open = new Map<string, { column: RestColumn; seen: Set<string> }>();
  private records = 0;

  constructor(columns: readonly RestColumn[], limit = 50) {
    for (const column of columns.filter((entry) => entry.keyable).slice(0, limit))
      this.open.set(column.column.name, { column, seen: new Set() });
  }

  add(cells: Map<string, FileCell>): void {
    this.records++;
    for (const [name, entry] of this.open) {
      const key = entry.column.key(cells.get(name));
      const text = key === null || key === '' ? null : JSON.stringify(key);
      if (text === null || entry.seen.has(text)) this.open.delete(name);
      else entry.seen.add(text);
    }
  }

  candidates(): string[][] {
    // An empty endpoint proves nothing, so it offers none.
    if (this.records === 0) return [];
    const names = [...this.open.keys()];
    const rank = (name: string) => (name === 'id' ? 0 : name.toLowerCase() === 'id' ? 1 : 2);
    return names
      .map((name, index) => ({ name, index }))
      .sort((a, b) => rank(a.name) - rank(b.name) || a.index - b.index)
      .map(({ name }) => [name]);
  }
}
