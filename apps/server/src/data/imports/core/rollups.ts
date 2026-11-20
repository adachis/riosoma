import type { RollupFunction } from '@riosoma/contracts';
import { textOf } from './values.js';

/**
 * Airtable's API doesn't share the formula a rollup uses, only what it produces.  So the function
 * is worked out from the values: each record's linked values, run through each of Riosoma's
 * rollup functions the way Riosoma runs them, against the value Airtable gave that record.  The
 * first function that gives the same value for every record checked is the one used.
 */

export interface RollupSample {
  /** The target field's values on the linked records, in link order */
  values: unknown[];
  /** How many records the link holds */
  linked: number;
  /** What Airtable's rollup gave */
  result: unknown;
}

export interface RollupGuess {
  fn: RollupFunction;
  /** Records that were checked.  None means the function was chosen by the result's type. */
  checked: number;
}

const NUMERIC = ['number', 'currency', 'percent', 'duration', 'rating', 'autoNumber', 'count'];
const TEXT = ['singleLineText', 'multilineText', 'richText', 'email', 'url', 'phoneNumber'];
const DATES = ['date', 'dateTime', 'createdTime', 'lastModifiedTime'];

/** Functions to try, most likely first, for what the rollup produces. */
function candidates(result: string | null): RollupFunction[] {
  if (result && NUMERIC.includes(result))
    return ['sum', 'countAll', 'count', 'countUnique', 'average', 'max', 'min'];
  if (result && TEXT.includes(result)) return ['concatenate', 'max', 'min'];
  if (result === 'checkbox') return ['and', 'or'];
  if (result && DATES.includes(result)) return ['latest', 'earliest'];
  return ['arrayUnique', 'concatenate', 'sum', 'countAll', 'count', 'max', 'min'];
}

function fallback(result: string | null): RollupFunction {
  return candidates(result)[0]!;
}

const isEmpty = (value: unknown) =>
  value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length);

function flatten(values: unknown[]): unknown[] {
  return values
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value) => !isEmpty(value));
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    return Number(value);
  return null;
}

function moment(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

/** What Riosoma's rollup gives for these linked values. */
export function rollupValue(fn: RollupFunction, sample: Pick<RollupSample, 'values' | 'linked'>): unknown {
  const values = flatten(sample.values);
  const numbers = values.map(numeric).filter((value): value is number => value !== null);
  switch (fn) {
    case 'sum':
      return numbers.reduce((sum, value) => sum + value, 0);
    case 'average':
      return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
    case 'count':
      return values.length;
    case 'countAll':
      return sample.linked;
    case 'countUnique':
      return new Set(values.map((value) => JSON.stringify(value))).size;
    case 'and':
      return values.every(truthy);
    case 'or':
      return values.some(truthy);
    case 'concatenate':
      return values.map((value) => textOf(value) ?? '').join(', ');
    case 'arrayUnique': {
      const seen = new Set<string>();
      return values.filter((value) => {
        const key = JSON.stringify(value);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    case 'min':
    case 'max':
    case 'earliest':
    case 'latest': {
      const later = fn === 'max' || fn === 'latest';
      if (numbers.length === values.length && numbers.length)
        return later ? Math.max(...numbers) : Math.min(...numbers);
      const times = values.map(moment);
      if (times.every((time) => time !== null) && times.length) {
        const pick = later ? Math.max(...(times as number[])) : Math.min(...(times as number[]));
        return values[times.indexOf(pick)];
      }
      const texts = values.map((value) => textOf(value) ?? '').sort();
      return texts.length ? (later ? texts.at(-1) : texts[0]) : null;
    }
  }
}

/** Whether two values are the same, the way a person would read them. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (isEmpty(a) && isEmpty(b)) return true;
  const x = numeric(a);
  const y = numeric(b);
  if (x !== null && y !== null && typeof a !== 'string' && typeof b !== 'string')
    return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  if (typeof a === 'boolean' || typeof b === 'boolean') return truthy(a) === truthy(b);
  const first = moment(a);
  const second = moment(b);
  if (first !== null && second !== null && typeof a === 'string' && typeof b === 'string' && a.length >= 10)
    return first === second;
  if (Array.isArray(a) || Array.isArray(b)) {
    const left = Array.isArray(a) ? a : [a];
    const right = Array.isArray(b) ? b : [b];
    return left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  }
  return (textOf(a) ?? '').trim() === (textOf(b) ?? '').trim();
}

/** The rollup function that reproduces Airtable's values, or null when none of them does. */
export function inferRollup(samples: readonly RollupSample[], result: string | null): RollupGuess | null {
  // Records with nothing linked say little, and Airtable leaves some of them empty.
  const telling = samples.filter((sample) => sample.linked > 0 && !isEmpty(sample.result));
  if (!telling.length) return { fn: fallback(result), checked: 0 };
  for (const fn of candidates(result))
    if (telling.every((sample) => sameValue(rollupValue(fn, sample), sample.result)))
      return { fn, checked: telling.length };
  return null;
}
