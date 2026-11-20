import { boolean, date, dateReadings, DATE_FORMATS, instant, number, text } from '../cleaners.js';
import type { Scalar } from '../cleaners.js';
import type { SerializableValue } from '../storage.js';

export type NormalizedValue = {
  kind: 'empty' | 'text' | 'number' | 'date' | 'instant' | 'boolean' | 'data';
  value: SerializableValue;
};

/** An inherited object property is not a field offered by the file or the expected rows. */
export function pairFieldValue(values: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(values, key) ? values[key] : undefined;
}

/** Stable JSON also makes objects independent of their property insertion order. */
export function serializableValue(value: unknown): SerializableValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(serializableValue);
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, serializableValue((value as Record<string, unknown>)[key])]),
    );
  return String(value);
}

/**
 * What a field holds decides how two of its values are compared.  An identifier is text, so
 * `00123` is not `123`, and `1e3` is not `1000`.  Only a number field reads digits as a number.
 */
export type PairFieldType = 'text' | 'number' | 'date' | 'dateTime' | 'boolean';

/**
 * Without a type, a value is read as whatever it looks like.  That suits searching a file for a
 * value, and it is never used to decide whether two rows are equal.
 */
export function normalizePairValue(value: unknown, type?: PairFieldType): NormalizedValue {
  if (value === null || value === undefined) return { kind: 'empty', value: null };
  if (typeof value === 'boolean' && (type === undefined || type === 'boolean'))
    return { kind: 'boolean', value };
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
    return { kind: 'data', value: serializableValue(value) };
  const trimmed = text(typeof value === 'boolean' ? String(value) : value).value;
  if (trimmed === null) return { kind: 'empty', value: null };
  if (type === 'text') return { kind: 'text', value: trimmed };
  if (type === 'boolean') {
    const flag = boolean(trimmed);
    return flag.certain && flag.value !== null
      ? { kind: 'boolean', value: flag.value }
      : { kind: 'text', value: trimmed };
  }
  const day = (): NormalizedValue | null => {
    const days = dateReadings(trimmed, DATE_FORMATS);
    if (new Set(days.values()).size === 1) {
      const cleaned = date(trimmed, { formats: [days.keys().next().value!] });
      return { kind: 'date', value: cleaned.value };
    }
    // Without a supplied date convention, month-first dates use the American calendar notation.
    const monthFirst = date(trimmed, { formats: ['MM/DD/YYYY', 'MM-DD-YYYY'] });
    return monthFirst.certain && monthFirst.value !== null ? { kind: 'date', value: monthFirst.value } : null;
  };
  const moment = (): NormalizedValue | null => {
    const timestamp = instant(trimmed);
    return timestamp.value === null ? null : { kind: 'instant', value: timestamp.value };
  };
  const decimalValue = (): NormalizedValue | null => {
    if (typeof value === 'boolean') return null;
    let decimal = number(value as Scalar);
    // Ambiguous punctuation follows the American decimal convention, using the same cleaner.
    if (!decimal.certain) decimal = number(value as Scalar, { decimalMark: '.' });
    return decimal.certain && decimal.value !== null ? { kind: 'number', value: decimal.value } : null;
  };
  const readings =
    type === 'number'
      ? [decimalValue]
      : type === 'date'
        ? [day, moment]
        : type === 'dateTime'
          ? [moment, day]
          : [moment, day, decimalValue];
  for (const reading of readings) {
    const found = reading();
    if (found) return found;
  }
  return { kind: 'text', value: trimmed };
}

export function pairValueKey(value: unknown, type?: PairFieldType): string {
  return JSON.stringify(normalizePairValue(value, type));
}
export function pairValuesEqual(left: unknown, right: unknown, type?: PairFieldType): boolean {
  return pairValueKey(left, type) === pairValueKey(right, type);
}
