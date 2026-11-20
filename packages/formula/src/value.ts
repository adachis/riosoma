import type { ErrorValue, FormulaValue } from './ast.js';
export interface DateValue {
  kind: 'date' | 'datetime';
  value: string;
  timeZone?: string;
}
export type Value = string | number | boolean | null | ErrorValue | DateValue | Value[];
export const failure = (messageKey: string, params?: ErrorValue['params']): ErrorValue => ({
  error: '#ERROR!',
  messageKey,
  ...(params ? { params } : {}),
});
export function isError(value: unknown): value is ErrorValue {
  return typeof value === 'object' && value !== null && 'error' in value;
}
export function isDate(value: Value): value is DateValue {
  return typeof value === 'object' && value !== null && 'kind' in value;
}
export function isBlank(value: Value): boolean {
  return value === null || value === '' || (Array.isArray(value) && value.length === 0);
}
export function truth(value: Value): boolean {
  return !isBlank(value) && value !== false && value !== 0;
}
export function numeric(value: Value): number {
  return value === null
    ? 0
    : typeof value === 'boolean'
      ? Number(value)
      : typeof value === 'number'
        ? value
        : NaN;
}
export function textValue(value: Value): string {
  if (value === null) return '';
  if (isDate(value)) return value.value;
  if (Array.isArray(value)) return value.map(textValue).join(', ');
  return typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
}
export function finite(value: number): Value {
  return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : failure('formula.runtime.number');
}
export function external(value: Value): FormulaValue {
  return isDate(value) ? value.value : Array.isArray(value) ? value.map(external) : value;
}
export function compare(a: Value, b: Value, operator: string): boolean {
  if (isBlank(a) || isBlank(b)) return operator === '=' && isBlank(a) && isBlank(b);
  const left = isDate(a) ? Date.parse(a.value) : typeof a === 'boolean' ? Number(a) : a;
  const right = isDate(b) ? Date.parse(b.value) : typeof b === 'boolean' ? Number(b) : b;
  if (operator === '=')
    return Array.isArray(left) || Array.isArray(right)
      ? JSON.stringify(left) === JSON.stringify(right)
      : left === right;
  if (operator === '!=' || operator === '<>') return !compare(a, b, '=');
  if (
    (typeof left !== 'string' && typeof left !== 'number') ||
    (typeof right !== 'string' && typeof right !== 'number')
  )
    return false;
  switch (operator) {
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    default:
      return false;
  }
}
