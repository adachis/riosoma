import {
  LIMITS,
  newId,
  type Choice,
  type ChoiceColor,
  type FieldOptionsOf,
  type FieldSpec,
  type RollupFunction,
} from '@riosoma/contracts';
import { describe, FUNCTIONS, parse, type Ast } from '@riosoma/formula';
import type { Attachment } from '../core/files.js';
import type { Note } from '../core/report.js';
import { isRecord, textOf } from '../core/values.js';
import type { Finish, FieldPlan, FormulaOptions, SourceField } from './model.js';

/**
 * What every tool's reader uses to plan its fields: the plans themselves, reading cells into
 * Riosoma's values, and choice colors from whatever the tool names them by.
 */

export function note(status: Note['status'], key: string, params?: Note['params']): Note {
  return { status, key, ...(params ? { params } : {}) };
}

export function valuePlan(
  field: SourceField,
  spec: FieldSpec,
  read: (value: unknown) => unknown,
  notes: Note[] = [],
  finish?: Finish,
): FieldPlan {
  return {
    kind: 'value',
    source: field,
    id: newId('field'),
    name: field.name,
    spec,
    read,
    notes,
    ...(finish ? { finish } : {}),
  };
}

export function omitted(field: SourceField, key: string, params?: Note['params']): FieldPlan {
  return {
    kind: 'omitted',
    source: field,
    id: newId('field'),
    name: field.name,
    notes: [note('omitted', key, params)],
  };
}

export function filesPlan(field: SourceField, read: (value: unknown) => Attachment[]): FieldPlan {
  return { kind: 'files', source: field, id: newId('field'), name: field.name, notes: [], read };
}

export function linkPlan(
  field: SourceField,
  linkedTable: string,
  inverse: string | null,
  prefersSingle: boolean,
  read: ((value: unknown) => string[]) | null,
): FieldPlan {
  return {
    kind: 'link',
    source: field,
    id: newId('field'),
    name: field.name,
    notes: [],
    linkedTable,
    inverse,
    prefersSingle,
    read,
  };
}

/** A people field: email addresses as text until the job sees whether they're all members here. */
export function peoplePlan(
  field: SourceField,
  emails: (value: unknown) => string[],
  allowMultiple: boolean,
  notes: Note[] = [],
): FieldPlan {
  const people = new Set<string>();
  const plan = valuePlan(
    field,
    { type: 'text', options: {} },
    (cell) => {
      const found = emails(cell);
      for (const email of found) people.add(email.toLowerCase());
      return found.length ? found.join(', ') : null;
    },
    notes,
    { kind: 'people', allowMultiple },
  );
  return plan.kind === 'value' ? { ...plan, people } : plan;
}

export const asText = (value: unknown) => textOf(value);
export const asTrimmed = (value: unknown) => (typeof value === 'string' ? value.trim() : textOf(value));
export const asNumber = (value: unknown) => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    return Number(value);
  return value ?? null;
};
export const asCheck = (value: unknown) =>
  value === true || value === 1 || value === '1' || value === 'true' || value === 't';

/** A day as `YYYY-MM-DD`. */
export function asDay(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value;
}

/** A moment as an ISO instant in UTC, from any of the ways tools write one. */
export function asInstant(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  const text = /^\d{4}-\d{2}-\d{2} \d/.test(value) ? value.replace(' ', 'T') : value;
  const time = Date.parse(text);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
}

/** Choices with IDs here, and each one's ID by the name the tool's cells use. */
export function choicesOf(list: ReadonlyArray<{ name: string; color: ChoiceColor }>): {
  choices: Choice[];
  byName: Map<string, string>;
} {
  const choices: Choice[] = [];
  const byName = new Map<string, string>();
  for (const item of list) {
    const name = item.name.trim().slice(0, LIMITS.nameLength);
    if (!name || byName.has(item.name)) continue;
    const id = newId('choice');
    choices.push({ id, name, color: item.color });
    byName.set(item.name, id);
  }
  return { choices, byName };
}

/** The Riosoma color nearest a hex color, by hue, with pale and dark shades as their hue. */
export function colorOfHex(hex: unknown): ChoiceColor {
  if (typeof hex !== 'string') return 'gray';
  const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!match) return 'gray';
  const digits = match[1]!.length === 3 ? [...match[1]!].map((d) => d + d).join('') : match[1]!;
  const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(digits.slice(at, at + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const chroma = max - min;
  if (chroma < 0.08) return 'gray';
  let hue = max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  hue = (hue * 60 + 360) % 360;
  if (hue < 15 || hue >= 345) return 'red';
  if (hue < 40) return lightness < 0.4 ? 'brown' : 'orange';
  if (hue < 65) return 'yellow';
  if (hue < 160) return 'green';
  if (hue < 200) return 'teal';
  if (hue < 255) return 'blue';
  if (hue < 290) return 'purple';
  return 'pink';
}

/** A color by name, the way Baserow and others name theirs, like `light-blue` or `dark-green`. */
export function colorOfName(name: unknown): ChoiceColor {
  const hue =
    typeof name === 'string'
      ? /(blue|cyan|teal|green|yellow|orange|red|pink|purple|brown|gray|grey)/.exec(name.toLowerCase())
      : null;
  if (!hue) return 'gray';
  const found = hue[1]!;
  return found === 'cyan' ? 'teal' : found === 'grey' ? 'gray' : (found as ChoiceColor);
}

export function precisionOf(value: unknown, max = 8): number | null {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number)
    ? Math.min(max, Math.max(0, Math.round(number)))
    : null;
}

type DateFormatName = FieldOptionsOf<'date'>['dateFormat'];

/** Riosoma's date format for a pattern like `YYYY-MM-DD` or `DD/MM/YYYY`. */
export function dateFormatOf(pattern: unknown): DateFormatName {
  if (typeof pattern !== 'string') return 'local';
  const text = pattern.toUpperCase();
  if (/^Y+[-/.]M+[-/.]D+/.test(text)) return 'iso';
  if (/^M+[-/.]D+[-/.]Y+/.test(text)) return 'us';
  if (/^D+[-/.]M+[-/.]Y+/.test(text)) return 'european';
  if (/MMM/.test(text)) return 'friendly';
  return 'local';
}

export function formulaOptions(options: Partial<FormulaOptions> = {}): FormulaOptions {
  return {
    precision: options.precision ?? null,
    dateFormat: options.dateFormat ?? 'local',
    timeFormat: options.timeFormat ?? 'local',
    timeZone: options.timeZone ?? 'client',
  };
}

/** Rollup functions by the names tools give them, in lowercase. */
export const ROLLUPS: Readonly<Record<string, RollupFunction>> = {
  sum: 'sum',
  avg: 'average',
  average: 'average',
  min: 'min',
  max: 'max',
  count: 'count',
  countall: 'countAll',
  countdistinct: 'countUnique',
  countunique: 'countUnique',
  and: 'and',
  or: 'or',
  concat: 'concatenate',
  concatenate: 'concatenate',
  arrayunique: 'arrayUnique',
  earliest: 'earliest',
  latest: 'latest',
};

export interface Written {
  expression: string | null;
  problem?: 'syntax' | 'functions';
  functions: string[];
}

/**
 * A formula written in a language like Riosoma's, with fields in braces and Excel-style functions,
 * as Riosoma writes it: each function the tool calls by another name gets Riosoma's, and the
 * functions with no match here are named so the report can say which.
 */
export function riosomaFormula(source: string, renames: Readonly<Record<string, string>>): Written {
  const parsed = parse(source);
  if ('error' in parsed) return { expression: null, problem: 'syntax', functions: [] };
  const missing = new Set<string>();
  const walk = (node: Ast): Ast => {
    switch (node.kind) {
      case 'call': {
        const name = renames[node.name] ?? node.name;
        if (!FUNCTIONS[name]) missing.add(node.name);
        return { ...node, name, args: node.args.map(walk) };
      }
      case 'unary':
        return { ...node, operand: walk(node.operand) };
      case 'binary':
        return { ...node, left: walk(node.left), right: walk(node.right) };
      default:
        return node;
    }
  };
  const mapped = walk(parsed.ast);
  if (missing.size) return { expression: null, problem: 'functions', functions: [...missing].sort() };
  return { expression: describe(mapped, []), functions: [] };
}

/** Reads a list of people, whatever shape each tool gives them in, as email addresses or names. */
export function emailsOf(value: unknown): string[] {
  const people = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return people.flatMap((person) => {
    if (typeof person === 'string')
      return person
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    if (!isRecord(person)) return [];
    const email = typeof person.email === 'string' ? person.email.trim() : '';
    const name =
      typeof person.name === 'string'
        ? person.name.trim()
        : typeof person.display_name === 'string'
          ? person.display_name.trim()
          : '';
    return email || name ? [email || name] : [];
  });
}
