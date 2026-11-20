import { coordinatesText, dateRangeText, type ListItem } from '@riosoma/contracts';
import { evaluateRecords, RECORD_FUNCTIONS } from './records.js';
import { FUNCTIONS, singleReads } from './check.js';
import type { Ast, EvaluationContext, FormulaRecord, FormulaType, FormulaValue } from './ast.js';
import { dateFunction, fromWall } from './dates.js';
import { regex } from './regex.js';
import {
  compare,
  external,
  failure,
  finite,
  isBlank,
  isDate,
  isError,
  numeric,
  textValue,
  truth,
  type Value,
} from './value.js';

const DATE_FUNCTIONS = new Set(
  'TODAY NOW DATEADD DATETIME_DIFF DATETIME_FORMAT DATETIME_PARSE YEAR MONTH DAY HOUR MINUTE SECOND WEEKDAY WEEKNUM WORKDAY WORKDAY_DIFF IS_BEFORE IS_AFTER IS_SAME SET_TIMEZONE DATESTR TIMESTR'.split(
    ' ',
  ),
);
const flatten = (values: readonly Value[]): Value[] =>
  values.flatMap((v) => (Array.isArray(v) ? flatten(v) : [v]));
function compareInContext(a: Value, b: Value, operator: string, context: EvaluationContext): boolean {
  if (isDate(a) && isDate(b) && a.kind !== b.kind) {
    const normalize = (value: Value): Value =>
      isDate(value) && value.kind === 'date'
        ? {
            kind: 'datetime',
            value: new Date(
              fromWall(new Date(`${value.value}T00:00:00Z`), value.timeZone ?? context.timeZone),
            ).toISOString(),
          }
        : value;
    return compare(normalize(a), normalize(b), operator);
  }
  return compare(a, b, operator);
}
function call(name: string, args: readonly Value[], context: EvaluationContext): Value {
  if (DATE_FUNCTIONS.has(name)) return dateFunction(name, args, context);
  const a = args[0] ?? null,
    b = args[1] ?? null,
    c = args[2] ?? null;
  const n = numeric(a),
    m = numeric(b),
    s = textValue(a),
    t = textValue(b);
  const count = (v: Value) => Math.trunc(numeric(v));
  const numbers = () => flatten(args).filter((v): v is number => typeof v === 'number');
  switch (name) {
    case 'TRUE':
      return true;
    case 'FALSE':
      return false;
    case 'BLANK':
      return null;
    case 'ERROR':
      return failure('formula.runtime.explicit', args.length ? { detail: s } : undefined);
    case 'ABS':
      return Math.abs(n);
    case 'ROUND':
    case 'ROUNDUP':
    case 'ROUNDDOWN': {
      const precision = Math.trunc(m);
      if (precision < -308 || precision > 308) return failure('formula.runtime.number');
      const scale = 10 ** precision,
        scaled = n * scale;
      const rounded =
        name === 'ROUND'
          ? Math.round(scaled)
          : name === 'ROUNDUP'
            ? Math.sign(scaled) * Math.ceil(Math.abs(scaled))
            : Math.trunc(scaled);
      return finite(rounded / scale);
    }
    case 'CEILING':
    case 'FLOOR': {
      const significance = args.length > 1 ? m : 1;
      if (significance <= 0) return failure('formula.runtime.number');
      return finite(
        (name === 'CEILING' ? Math.ceil(n / significance) : Math.floor(n / significance)) * significance,
      );
    }
    case 'INT':
      return Math.floor(n);
    case 'MOD':
      return m === 0 ? failure('formula.runtime.divisionByZero') : finite(n % m);
    case 'POWER':
      return finite(n ** m);
    case 'SQRT':
      return finite(Math.sqrt(n));
    case 'EXP':
      return finite(Math.exp(n));
    case 'LOG': {
      const base = args.length > 1 ? m : 10;
      return n <= 0 || base <= 0 || base === 1
        ? failure('formula.runtime.number')
        : finite(Math.log(n) / Math.log(base));
    }
    case 'LOG10':
      return finite(Math.log10(n));
    case 'EVEN':
      return Math.sign(n) * Math.ceil(Math.abs(n) / 2) * 2;
    case 'ODD':
      return (n < 0 ? -1 : 1) * (Math.ceil((Math.abs(n) - 1) / 2) * 2 + 1);
    case 'MAX':
    case 'MIN': {
      const ns = numbers();
      return ns.length ? ns.reduce((a, b) => (name === 'MAX' ? Math.max(a, b) : Math.min(a, b))) : 0;
    }
    case 'SUM':
      return finite(numbers().reduce((a, b) => a + b, 0));
    case 'AVERAGE': {
      const ns = numbers();
      return ns.length
        ? finite(ns.reduce((a, b) => a + b, 0) / ns.length)
        : failure('formula.runtime.divisionByZero');
    }
    case 'COUNT':
      return numbers().length;
    case 'COUNTA':
      return flatten(args).filter((v) => !isBlank(v)).length;
    case 'COUNTALL':
      return flatten(args).length;
    case 'VALUE': {
      const value = s.trim().replace(/[$,£€¥\s]/g, '');
      return value === '' || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)
        ? failure('formula.runtime.number')
        : finite(Number(value));
    }
    case 'CONCATENATE':
      return args.map(textValue).join('');
    case 'LEN':
      return s.length;
    case 'LEFT':
    case 'RIGHT': {
      const length = count(b);
      if (length < 0) return failure('formula.runtime.argument');
      return name === 'LEFT' ? s.slice(0, length) : length === 0 ? '' : s.slice(-length);
    }
    case 'MID': {
      const start = count(b),
        length = count(c);
      return start < 1 || length < 0
        ? failure('formula.runtime.argument')
        : s.slice(start - 1, start - 1 + length);
    }
    case 'FIND':
    case 'SEARCH': {
      const start = args.length > 2 ? Math.max(0, count(c) - 1) : 0;
      const position = (name === 'SEARCH' ? t.toLowerCase() : t).indexOf(
        name === 'SEARCH' ? s.toLowerCase() : s,
        start,
      );
      return position < 0 ? (name === 'SEARCH' ? null : 0) : position + 1;
    }
    case 'SUBSTITUTE': {
      const replacement = textValue(c);
      if (t === '') return s;
      if (args.length < 4) return s.split(t).join(replacement);
      const occurrence = count(args[3]!);
      if (occurrence < 1) return failure('formula.runtime.argument');
      let index = -t.length;
      for (let i = 0; i < occurrence; i++) {
        index = s.indexOf(t, index + t.length);
        if (index < 0) return s;
      }
      return s.slice(0, index) + replacement + s.slice(index + t.length);
    }
    case 'REPLACE': {
      const start = count(b),
        length = count(c);
      return start < 1 || length < 0
        ? failure('formula.runtime.argument')
        : s.slice(0, start - 1) + textValue(args[3]!) + s.slice(start - 1 + length);
    }
    case 'LOWER':
      return s.toLowerCase();
    case 'UPPER':
      return s.toUpperCase();
    case 'TRIM':
      return s.trim();
    case 'REPT': {
      const times = count(b);
      return times < 0 || times > 1_000_000 || s.length * times > 1_000_000
        ? failure('formula.runtime.limit')
        : s.repeat(times);
    }
    case 'T':
      return typeof a === 'string' ? a : null;
    case 'ENCODE_URL_COMPONENT':
      return encodeURIComponent(s).replace(
        /[!'()*]/g,
        (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
      );
    case 'REGEX_MATCH':
      return regex(t).match(s) !== null;
    case 'REGEX_EXTRACT': {
      const match = regex(t).match(s);
      return match ? match.groups[0]! : failure('formula.runtime.regexNoMatch');
    }
    case 'REGEX_REPLACE':
      return regex(t).replace(s, textValue(c));
    case 'NOT':
      return !truth(a);
    case 'XOR':
      return args.filter(truth).length % 2 === 1;
    case 'ARRAYJOIN':
      return (Array.isArray(a) ? a : []).map(textValue).join(args.length > 1 ? t : ', ');
    case 'ARRAYUNIQUE':
      return (Array.isArray(a) ? a : []).filter(
        (v, i, all) => all.findIndex((other) => JSON.stringify(other) === JSON.stringify(v)) === i,
      );
    case 'ARRAYCOMPACT':
      return (Array.isArray(a) ? a : []).filter((v) => !isBlank(v));
    case 'ARRAYFLATTEN':
      return flatten(Array.isArray(a) ? a : []);
    case 'START':
      return Array.isArray(a) ? (a[0] ?? null) : null;
    case 'END':
      return Array.isArray(a) ? (a.at(-1) ?? null) : null;
    case 'ARRAYSLICE': {
      const values = Array.isArray(a) ? a : [];
      const start = count(b),
        end = args.length > 2 ? count(c) : values.length;
      if (start === 0 || (args.length > 2 && end === 0)) return failure('formula.runtime.argument');
      return values.slice(start > 0 ? start - 1 : start, end < 0 ? values.length + end + 1 : end);
    }
    default:
      return failure('formula.function.unknown', { name });
  }
}

type Runner = (record: FormulaRecord, context: EvaluationContext) => Value;

/**
 * A date range, location, or signature as formulas see it.  A range field is its two ends, a
 * signature the moment it was signed, and a location its coordinates.  Inside a lookup's list,
 * each is the text a download would hold.
 */
function objectItem(item: ListItem | null, kind?: 'date' | 'datetime'): Value {
  if (item === null || typeof item !== 'object') return item;
  if ('start' in item) {
    return kind
      ? [
          { kind, value: item.start },
          { kind, value: item.end },
        ]
      : dateRangeText(item);
  }
  if ('values' in item) return JSON.stringify(item);
  if ('fieldIds' in item) return JSON.stringify(item);
  if ('amount' in item) return `${item.code} ${item.amount}`;
  if ('lat' in item) return coordinatesText(item);
  return kind === 'datetime' ? { kind, value: item.signedAt } : item.signedAt;
}
/**
 * A lookup's one item, as the type the checker gave it.  An item of another kind, which a lookup
 * holds only for a moment after its target changes type, reads the way SQL reads it.
 */
function itemAs(item: Value, type: FormulaType | undefined): Value {
  if (item === null || isError(item)) return item;
  switch (type) {
    case 'number':
      return typeof item === 'number' ? item : null;
    case 'boolean':
      return typeof item === 'boolean' ? item : null;
    case 'date':
    case 'datetime':
      return typeof item === 'string' ? { kind: type, value: item } : null;
    case 'text':
      return typeof item === 'string' ? item : textValue(item);
    default:
      return item;
  }
}
/** A lookup read as one value: blank when it's empty, and an error when it holds more than one. */
function one(list: Value, type: FormulaType | undefined): Value {
  if (!Array.isArray(list)) return list;
  if (list.length > 1) return failure('formula.list.several');
  return itemAs(list[0] ?? null, type);
}
const prepared = new WeakMap<Ast, Runner>();
/** Lookup references read as one value have runners of their own. */
const preparedSingle = new WeakMap<Ast, Runner>();
function prepare(ast: Ast, singles: ReadonlySet<Ast>): Runner {
  const cache = ast.kind === 'field' && singles.has(ast) ? preparedSingle : prepared;
  const cached = cache.get(ast);
  if (cached) return cached;
  let run: Runner;
  switch (ast.kind) {
    case 'literal':
      run = () => ast.value;
      break;
    case 'field': {
      const read: Runner = (record, context) => {
        if (!ast.fieldId) return failure('formula.field.unresolved', { name: ast.name });
        let value = record.values[ast.fieldId] ?? null;
        if (ast.fieldType === 'recordId') value = record.id;
        if (ast.fieldType === 'createdTime') value = record.createdAt;
        if (ast.fieldType === 'lastModifiedTime') value = record.updatedAt;
        // A field that failed on its own, like a rollup of an erroring formula, passes its error on.
        if (isError(value)) return value;
        // A lookup is always a list, of however many values its links bring, even none.
        if (ast.fieldType === 'lookup')
          return (value === null ? [] : Array.isArray(value) ? value : [value]).map((item) =>
            objectItem(item as ListItem | null),
          );
        // A link is its linked records' names, which the caller supplies, and a multiple select its
        // choices' names, each a list even when there's nothing in it.
        if (ast.fieldType === 'link')
          return (value === null ? [] : Array.isArray(value) ? value : [value]) as Value[];
        if (ast.fieldType === 'multipleSelect')
          return (value === null ? [] : Array.isArray(value) ? value : [value]).map(
            (id) => context.choices?.get(String(id)) ?? null,
          );
        if (value === null) return null;
        if ((ast.valueType === 'date' || ast.valueType === 'datetime') && typeof value === 'string')
          return { kind: ast.valueType, value };
        if (ast.fieldType === 'singleSelect') return context.choices?.get(String(value)) ?? null;
        if (ast.fieldType === 'createdBy' || ast.fieldType === 'lastModifiedBy')
          return context.people?.get(String(value)) ?? null;
        if (ast.fieldType === 'user')
          return Array.isArray(value) ? value.map((id) => context.people?.get(String(id)) ?? null) : null;
        if (Array.isArray(value)) return value.map((item) => objectItem(item));
        if (typeof value === 'object') {
          const type = ast.valueType;
          const kind = typeof type === 'object' ? type.array : type === 'datetime' ? 'datetime' : undefined;
          return objectItem(value, kind === 'date' || kind === 'datetime' ? kind : undefined);
        }
        return value;
      };
      const type = ast.valueType;
      run = singles.has(ast)
        ? (r, c) => one(read(r, c), typeof type === 'object' ? type.array : undefined)
        : read;
      break;
    }
    case 'unary': {
      const operand = prepare(ast.operand, singles);
      run = (r, c) => {
        const value = operand(r, c);
        return isError(value) ? value : finite(-numeric(value));
      };
      break;
    }
    case 'binary': {
      const left = prepare(ast.left, singles),
        right = prepare(ast.right, singles);
      run = (r, c) => {
        const a = left(r, c);
        if (isError(a)) return a;
        if (ast.operator === '&&' && !truth(a)) return false;
        if (ast.operator === '||' && truth(a)) return true;
        const b = right(r, c);
        if (isError(b)) return b;
        switch (ast.operator) {
          case '+':
            return finite(numeric(a) + numeric(b));
          case '-':
            return finite(numeric(a) - numeric(b));
          case '*':
            return finite(numeric(a) * numeric(b));
          case '/':
            return numeric(b) === 0
              ? failure('formula.runtime.divisionByZero')
              : finite(numeric(a) / numeric(b));
          case '&':
            return textValue(a) + textValue(b);
          case '&&':
          case '||':
            return truth(b);
          default:
            return compareInContext(a, b, ast.operator, c);
        }
      };
      break;
    }
    case 'call': {
      const args = ast.args.map((arg) => prepare(arg, singles)),
        signature = FUNCTIONS[ast.name];
      if (!signature) {
        run = () => failure('formula.function.unknown', { name: ast.name });
        break;
      }
      if (args.length < signature.min || args.length > signature.max) {
        run = () => failure('formula.function.arity', { name: ast.name });
        break;
      }
      run = (r, c) => {
        const get = (i: number): Value => args[i]?.(r, c) ?? null;
        if (RECORD_FUNCTIONS.has(ast.name))
          return evaluateRecords(ast, r, c, (node, row, ctx) => prepare(node, singles)(row, ctx));
        if (ast.name === 'ISERROR') return isError(get(0));
        if (ast.name === 'IF') {
          const condition = get(0);
          return isError(condition) ? condition : get(truth(condition) ? 1 : 2);
        }
        if (ast.name === 'AND' || ast.name === 'OR') {
          for (const arg of args) {
            const value = arg(r, c);
            if (isError(value)) return value;
            if (truth(value) === (ast.name === 'OR')) return ast.name === 'OR';
          }
          return ast.name === 'AND';
        }
        if (ast.name === 'SWITCH') {
          const target = get(0);
          if (isError(target)) return target;
          for (let i = 1; i + 1 < args.length; i += 2) {
            const pattern = get(i);
            if (isError(pattern)) return pattern;
            if (compareInContext(target, pattern, '=', c)) return get(i + 1);
          }
          return args.length % 2 === 0 ? get(args.length - 1) : null;
        }
        if (ast.name === 'RECORD_ID') return r.id;
        if (ast.name === 'CREATED_TIME') return { kind: 'datetime', value: r.createdAt };
        if (ast.name === 'LAST_MODIFIED_TIME') {
          if (args.length === 0) return { kind: 'datetime', value: r.updatedAt };
          let latest: string | null = null;
          for (const node of ast.args) {
            if (node.kind !== 'field' || !node.fieldId) return failure('formula.type.fieldRequired');
            const time = r.fieldUpdatedAt?.[node.fieldId];
            if (time === undefined) return failure('formula.runtime.modificationUnavailable');
            if (time && (!latest || time > latest)) latest = time;
          }
          return latest ? { kind: 'datetime', value: latest } : null;
        }
        const values: Value[] = [];
        for (const arg of args) {
          const value = arg(r, c);
          if (isError(value)) return value;
          values.push(value);
        }
        try {
          return call(ast.name, values, c);
        } catch {
          return failure(
            ast.name.startsWith('REGEX_')
              ? 'formula.runtime.regex'
              : DATE_FUNCTIONS.has(ast.name)
                ? 'formula.runtime.date'
                : 'formula.runtime.argument',
          );
        }
      };
      break;
    }
  }
  cache.set(ast, run);
  return run;
}

/** Each formula's lookups read as one value, worked out once per formula. */
const reads = new WeakMap<Ast, ReadonlySet<Ast>>();

/** ASTs are immutable; prepared runners are cached without retaining records or contexts. */
export function evaluate(ast: Ast, record: FormulaRecord, context: EvaluationContext): FormulaValue {
  let singles = reads.get(ast);
  if (!singles) {
    singles = singleReads(ast);
    reads.set(ast, singles);
  }
  try {
    const value = prepare(ast, singles)(record, context);
    return external(typeof value === 'number' ? finite(value) : value);
  } catch {
    return failure('formula.runtime.argument');
  }
}
export { isError } from './value.js';
