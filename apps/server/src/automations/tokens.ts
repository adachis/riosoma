import type { CellValue } from '@riosoma/contracts';
import type { StoredField } from '../data/types.js';

/**
 * Tokens in step text: `{{trigger.record.<fieldId>}}`, `{{steps.<stepId>.record.<fieldId>}}`,
 * `{{trigger.body.<path>}}`, `{{now}}`, and `{{trigger.record.url}}`.  Parsing is shared by the
 * checks that run when an automation is saved and by the engine that fills them in.
 */
export type TokenRef =
  | { kind: 'item'; path: string[] }
  | { kind: 'index' }
  | { kind: 'output'; stepId: string; path: string[] }
  | { kind: 'now' }
  | { kind: 'url' }
  /** A field of the trigger's record, or, with `stepId`, of the record an earlier step made or changed */
  | { kind: 'field'; stepId: string | null; fieldId: string }
  /** A value in a webhook call's JSON body, or the whole body when the path is empty */
  | { kind: 'body'; path: string[] };

export type Piece = { text: string } | { raw: string; ref: TokenRef | null };

const TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/g;
const FIELD = /^trigger\.record\.(fld[0-9A-Za-z]{14})$/;
const STEP_FIELD = /^steps\.([0-9A-Za-z_-]{6,40})\.record\.(fld[0-9A-Za-z]{14})$/;

export function parseToken(path: string): TokenRef | null {
  if (path === 'index') return { kind: 'index' };
  if (path === 'item' || path.startsWith('item.'))
    return { kind: 'item', path: path === 'item' ? [] : path.slice(5).split('.') };
  const output = /^steps\.([0-9A-Za-z_-]{6,40})\.output(?:\.(.+))?$/.exec(path);
  if (output) return { kind: 'output', stepId: output[1]!, path: output[2]?.split('.') ?? [] };
  if (path === 'now') return { kind: 'now' };
  if (path === 'trigger.record.url') return { kind: 'url' };
  const field = FIELD.exec(path);
  if (field) return { kind: 'field', stepId: null, fieldId: field[1]! };
  const step = STEP_FIELD.exec(path);
  if (step) return { kind: 'field', stepId: step[1]!, fieldId: step[2]! };
  if (path === 'trigger.body') return { kind: 'body', path: [] };
  if (path.startsWith('trigger.body.')) {
    const segments = path.slice('trigger.body.'.length).split('.');
    return segments.every((segment) => segment.length > 0 && segment.length <= 200)
      ? { kind: 'body', path: segments }
      : null;
  }
  return null;
}

/** A template split into its plain text and its tokens, in order. */
export function pieces(template: string): Piece[] {
  const result: Piece[] = [];
  let last = 0;
  for (const match of template.matchAll(TOKEN)) {
    if (match.index > last) result.push({ text: template.slice(last, match.index) });
    result.push({ raw: match[0], ref: parseToken(match[1]!) });
    last = match.index + match[0].length;
  }
  if (last < template.length) result.push({ text: template.slice(last) });
  return result;
}

export function tokensIn(template: string): Array<{ raw: string; ref: TokenRef | null }> {
  return pieces(template).filter((piece): piece is { raw: string; ref: TokenRef | null } => 'raw' in piece);
}

/** What a token stands for when the engine fills it in. */
export interface TokenValue {
  /** The value as the app shows it */
  text: string;
  /** The value where JSON expects a value rather than text: numbers, booleans, null, or the body's own JSON */
  json: unknown;
  /** Email addresses it names, for an email's recipients */
  addresses: string[];
  /** For record fields, the field and the value as stored */
  cell?: { field: StoredField; value: CellValue };
}

export type Resolver = (ref: TokenRef | null, raw: string) => TokenValue;

export function fillText(template: string, resolve: Resolver): string {
  return pieces(template)
    .map((piece) => ('text' in piece ? piece.text : resolve(piece.ref, piece.raw).text))
    .join('');
}

/** The template when it's exactly one token and nothing else, so a value can be copied as it's stored. */
export function soleToken(template: string): { raw: string; ref: TokenRef | null } | null {
  const parts = pieces(template.trim());
  const only = parts.length === 1 ? parts[0] : undefined;
  return only && 'raw' in only ? only : null;
}

const STICKY_TOKEN = /\{\{\s*([^{}]*?)\s*\}\}/y;

/**
 * Fills a JSON template.  Inside a string a token becomes escaped text, and outside one it becomes
 * a JSON value, so `{"count": {{…}}}` can carry a number.
 */
export function fillJson(template: string, resolve: Resolver): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let index = 0;
  while (index < template.length) {
    STICKY_TOKEN.lastIndex = index;
    const match = template.startsWith('{{', index) ? STICKY_TOKEN.exec(template) : null;
    if (match) {
      const value = resolve(parseToken(match[1]!), match[0]);
      out += inString ? JSON.stringify(value.text).slice(1, -1) : JSON.stringify(value.json ?? null);
      index += match[0].length;
      escaped = false;
      continue;
    }
    const character = template[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    out += character;
    index += 1;
  }
  return out;
}

/** Reads a path such as `items.0.name` out of a JSON value. */
export function bodyValue(body: unknown, path: readonly string[]): unknown {
  let current = body;
  for (const segment of path) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) current = current[Number(segment)];
    else if (current && typeof current === 'object' && Object.hasOwn(current, segment))
      current = (current as Record<string, unknown>)[segment];
    else return undefined;
  }
  return current;
}

export function bodyText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
