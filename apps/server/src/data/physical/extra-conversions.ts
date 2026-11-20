import { checkCellValue, idsOf, isCurrencyCode, type CellValue, type FieldSpec } from '@riosoma/contracts';
import type { StoredField } from '../types.js';

export function numericType(field: FieldSpec): boolean {
  return ['number', 'currency', 'percent', 'duration', 'rating', 'autoNumber'].includes(field.type);
}

function numberFromText(value: string): number | null {
  const normalized = value
    .trim()
    .replace(/[\s,']/g, '')
    .replace(/\p{Sc}/gu, '')
    .replace(/[A-Za-z]{3}/g, (code) => (isCurrencyCode(code.toUpperCase()) ? '' : code));
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function durationFromText(value: string, minutes: boolean): number | null {
  if (!value.includes(':')) {
    const number = numberFromText(value);
    return number === null ? null : number * (minutes ? 60 : 1);
  }
  const parts = /^(\d+):([0-5]\d)(?::([0-5]\d(?:\.\d{1,3})?))?$/.exec(value.trim());
  return parts ? Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3] ?? 0) : null;
}

export function convertNumeric(target: StoredField, value: CellValue, fromText: boolean): CellValue {
  let number: number | null;
  if (fromText) {
    const text = String(value);
    if (target.type === 'duration') number = durationFromText(text, target.options.format === 'h:mm');
    else if (target.type === 'percent' && text.trim().endsWith('%')) {
      const parsed = numberFromText(text.trim().slice(0, -1));
      number = parsed === null ? null : parsed / 100;
    } else number = numberFromText(text);
  } else number = typeof value === 'number' ? value : null;
  if (target.type === 'rating' && number !== null) number = Math.round(number);
  const checked = checkCellValue(target, number);
  return checked.ok ? checked.value : null;
}

export function userNames(value: CellValue, names?: ReadonlyMap<string, string>): string | null {
  return (
    idsOf(value)
      .flatMap((id) => (names?.has(id) ? [names.get(id)!] : []))
      .join(', ') || null
  );
}

export function userMatcher(names?: ReadonlyMap<string, string>, emails?: ReadonlyMap<string, string>) {
  const byName = new Map<string, string>();
  for (const source of [names, emails]) {
    for (const [id, name] of source ?? []) {
      const key = name.trim().toLowerCase();
      if (!byName.has(key)) byName.set(key, id);
    }
  }
  return (text: string): string[] => [
    ...new Set(
      text
        .split(',')
        .map((name) => byName.get(name.trim().toLowerCase()))
        .filter((id): id is string => id !== undefined),
    ),
  ];
}
