import { regex } from './regex.js';
import type { Ast, EvaluationContext, FormulaRecord } from './ast.js';
import { compare, failure, finite, isBlank, isDate, isError, numeric, type Value } from './value.js';

export const RECORD_FUNCTIONS = new Set([
  'XLOOKUP',
  'SUMIFS',
  'COUNTIFS',
  'AVERAGEIFS',
  'MAXIFS',
  'MINIFS',
  'RANK',
  'PREVIOUS',
  'NEXT',
  'RUNNINGSUM',
  'RUNNINGCOUNT',
]);

/** Excel wildcard escaping keeps a literal star or question mark after a tilde. */
export function wildcard(pattern: string): string {
  let result = '^';
  for (let i = 0; i < pattern.length; i++) {
    let c = pattern[i]!;
    if (c === '~' && i + 1 < pattern.length) c = pattern[++i]!;
    else if (c === '*') {
      result += '[\\s\\S]*';
      continue;
    } else if (c === '?') {
      result += '[\\s\\S]';
      continue;
    }
    result += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return `${result}$`;
}

const lookupKey = (value: Value): Value =>
  isDate(value) ? value.value : typeof value === 'string' ? value.toLowerCase() : value;

export function matchesCriterion(value: Value, criterion: Value, wild = true): boolean {
  if (isError(value) || isError(criterion)) return false;
  if (isDate(value)) value = value.value;
  if (isDate(criterion)) criterion = criterion.value;
  let operator = '=';
  let expected = criterion;
  if (typeof criterion === 'string') {
    const parts = /^(<=|>=|<>|=|<|>)([\s\S]*)$/.exec(criterion);
    operator = parts?.[1] ?? '=';
    const body = parts?.[2] ?? criterion;
    if (
      typeof value === 'number' &&
      body.length < 320 &&
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d{1,4})?$/i.test(body)
    )
      expected = Number(body);
    else if (
      typeof value === 'string' &&
      ['=', '<>'].includes(operator) &&
      wild &&
      !isBlank(value) &&
      !isBlank(body)
    ) {
      const matches = Boolean(regex(wildcard(body.toLowerCase())).match(value.toLowerCase()));
      return operator === '<>' ? !matches : matches;
    } else expected = body;
  }
  if (isBlank(value) || isBlank(expected)) {
    const equal = isBlank(value) && isBlank(expected);
    if (operator === '=') return equal;
    if (operator === '<>') return !equal;
    return false;
  }
  if (typeof value !== typeof expected) return operator === '<>';
  if (typeof value === 'string' && typeof expected === 'string')
    return compare(value.toLowerCase(), expected.toLowerCase(), operator);
  return compare(value, expected, operator);
}

type Read = (ast: Ast, record: FormulaRecord, context: EvaluationContext) => Value;

/** Callers supply complete permission-filtered records, never a view's current page. */
export function evaluateRecords(
  ast: Extract<Ast, { kind: 'call' }>,
  record: FormulaRecord,
  context: EvaluationContext,
  read: Read,
): Value {
  const own = (i: number) => (ast.args[i] ? read(ast.args[i]!, record, context) : null);
  const at = (i: number, row: FormulaRecord) => (ast.args[i] ? read(ast.args[i]!, row, context) : null);
  if (ast.name === 'XLOOKUP' || ast.name.endsWith('IFS')) {
    const first = ast.args[ast.name === 'XLOOKUP' ? 1 : 0];
    const table = first?.kind === 'field' ? first.tableId : undefined;
    const rows = table ? context.tables?.get(table) : undefined;
    if (!rows) return failure('formula.runtime.recordsUnavailable');
    if (ast.name === 'XLOOKUP') {
      const input = own(0),
        value = isDate(input) ? input.value : input,
        mode = ast.args[4] ? numeric(own(4)) : 0,
        search = ast.args[5] ? numeric(own(5)) : 1;
      if (isError(value)) return value;
      if (![0, -1, 1, 2].includes(mode) || ![-1, 1].includes(search))
        return failure('formula.runtime.argument');
      const ordered = [...rows].sort((a, b) =>
        a.createdAt < b.createdAt
          ? -1
          : a.createdAt > b.createdAt
            ? 1
            : a.id < b.id
              ? -1
              : a.id > b.id
                ? 1
                : 0,
      );
      if (search === -1) ordered.reverse();
      const keyError = ordered.map((row) => at(1, row)).find(isError);
      if (keyError) return keyError;
      let nearest: FormulaRecord | undefined;
      for (const row of ordered) {
        const found = at(1, row),
          candidate = isDate(found) ? found.value : found;
        if (isError(candidate)) return candidate;
        if (
          mode === 2
            ? isBlank(candidate) || isBlank(value)
              ? isBlank(candidate) && isBlank(value)
              : typeof candidate === 'string' && typeof value === 'string'
                ? Boolean(regex(wildcard(value.toLowerCase())).match(candidate.toLowerCase()))
                : compare(candidate, value, '=')
            : isBlank(candidate) || isBlank(value)
              ? isBlank(candidate) && isBlank(value)
              : typeof candidate === typeof value &&
                compare(
                  typeof candidate === 'string' ? candidate.toLowerCase() : candidate,
                  typeof value === 'string' ? value.toLowerCase() : value,
                  '=',
                )
        )
          return at(2, row);
        if (mode !== -1 && mode !== 1) continue;
        if (isBlank(candidate) || typeof candidate !== typeof value) continue;
        if (
          compare(lookupKey(candidate), lookupKey(value), mode === -1 ? '<' : '>') &&
          (!nearest || compare(lookupKey(candidate), lookupKey(at(1, nearest)), mode === -1 ? '>' : '<'))
        )
          nearest = row;
      }
      return nearest ? at(2, nearest) : own(3);
    }
    const start = ast.name === 'COUNTIFS' ? 0 : 1;
    const criteria = ast.args
      .filter((_, i) => i >= start && (i - start) % 2 === 1)
      .map((arg) => read(arg, record, context));
    const error = criteria.find(isError);
    if (error) return error;
    let count = 0;
    const values: number[] = [];
    for (const row of [...rows].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )) {
      if (!criteria.every((criterion, i) => matchesCriterion(at(start + i * 2, row), criterion))) continue;
      count++;
      if (ast.name !== 'COUNTIFS') {
        const value = at(0, row);
        if (isError(value)) return value;
        if (typeof value === 'number') values.push(value);
      }
    }
    if (ast.name === 'COUNTIFS') return count;
    if (ast.name === 'AVERAGEIFS' && !values.length) return failure('formula.runtime.divisionByZero');
    if (!values.length) return 0;
    if (ast.name === 'MAXIFS') return values.reduce((a, b) => Math.max(a, b));
    if (ast.name === 'MINIFS') return values.reduce((a, b) => Math.min(a, b));
    const sum = values.reduce((a, b) => a + b, 0);
    return finite(ast.name === 'AVERAGEIFS' ? sum / values.length : sum);
  }
  if (!context.records) return failure('formula.runtime.recordsUnavailable');
  const partition = own(2);
  const rows = context.records.filter((row) => !ast.args[2] || compare(at(2, row), partition, '='));
  const order = ast.name === 'RANK' ? own(1) : null;
  if (ast.name === 'RANK' && order !== null && order !== 0 && order !== 1)
    return failure('formula.runtime.argument');
  const key = (row: FormulaRecord) =>
    ast.name === 'RANK'
      ? at(0, row)
      : ast.args[1] && !(ast.args[1].kind === 'call' && ast.args[1].name === 'BLANK')
        ? at(1, row)
        : row.createdAt;
  const compareKey = (a: Value, b: Value): number => {
    if (isBlank(a) || isError(a) || isBlank(b) || isError(b))
      return isBlank(a) || isError(a) ? (isBlank(b) || isError(b) ? 0 : 1) : -1;
    return compare(a, b, '=') ? 0 : compare(a, b, '<') ? -1 : 1;
  };
  rows.sort((a, b) => {
    const sorted = compareKey(key(a), key(b));
    if (sorted)
      return ast.name === 'RANK' &&
        !order &&
        !isBlank(key(a)) &&
        !isError(key(a)) &&
        !isBlank(key(b)) &&
        !isError(key(b))
        ? -sorted
        : sorted;
    return a.createdAt < b.createdAt
      ? -1
      : a.createdAt > b.createdAt
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0;
  });
  const position = rows.findIndex((row) => row.id === record.id);
  if (position < 0) return null;
  if (ast.name === 'RANK') {
    if (isError(own(0))) return own(0);
    if (isBlank(own(0))) return null;
    return rows.findIndex((row) => compare(key(row), own(0), '=')) + 1;
  }
  if (ast.name === 'PREVIOUS' || ast.name === 'NEXT') {
    const row = rows[position + (ast.name === 'PREVIOUS' ? -1 : 1)];
    return row ? at(0, row) : null;
  }
  const values = rows.slice(0, position + 1).map((row) => (ast.args[0] ? at(0, row) : 1));
  const error = values.find(isError);
  if (error) return error;
  return ast.name === 'RUNNINGCOUNT'
    ? values.filter((value) => !isBlank(value)).length
    : finite(values.reduce<number>((sum, value) => sum + (typeof value === 'number' ? value : 0), 0));
}
