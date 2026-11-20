// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.  If a copy
// of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Ported from EcoLogits 0.11.1 (https://github.com/genai-impact/ecologits), by Samuel Rincé,
// Adrien Banse, and the GenAI Impact contributors: ecologits/utils/range_value.py.

/** An interval, low end first. */
export interface Range {
  readonly min: number;
  readonly max: number;
}

/** A single value, or an interval when the inputs behind it are only known within bounds. */
export type ValueOrRange = number | Range;

export function isRange(value: ValueOrRange): value is Range {
  return typeof value === 'object';
}

/** An interval, refused when its ends are out of order, as the original's validator does. */
export function range(min: number, max: number): Range {
  if (min > max) throw new RangeError('min value must be lower than max value');
  return { min, max };
}

/** Adds two values.  A range plus a range adds end to end, and a range plus a value moves both ends. */
export function add(a: ValueOrRange, b: ValueOrRange): ValueOrRange {
  if (isRange(a)) return isRange(b) ? range(a.min + b.min, a.max + b.max) : range(a.min + b, a.max + b);
  if (isRange(b)) return range(b.min + a, b.max + a);
  return a + b;
}

/** Multiplies two values the same way: end by end, or both ends by a value. */
export function multiply(a: ValueOrRange, b: ValueOrRange): ValueOrRange {
  if (isRange(a)) return isRange(b) ? range(a.min * b.min, a.max * b.max) : range(a.min * b, a.max * b);
  if (isRange(b)) return range(b.min * a, b.max * a);
  return a * b;
}

/** The low end of a value, which for a single value is the value itself. */
export const low = (value: ValueOrRange): number => (isRange(value) ? value.min : value);

/** The high end of a value, which for a single value is the value itself. */
export const high = (value: ValueOrRange): number => (isRange(value) ? value.max : value);
