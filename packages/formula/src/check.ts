import {
  diagnostic,
  fieldType,
  type Ast,
  type FieldTypes,
  type FormulaError,
  type FormulaType,
  type Result,
} from './ast.js';

/**
 * `range`: a list of dates, like a date range field's two ends.  `numbers`: a number, or a list of
 * them that the function flattens, like the prices a lookup holds.
 */
export type ArgumentType = 'value' | 'number' | 'numbers' | 'text' | 'dateLike' | 'array' | 'range';
export interface Signature {
  min: number;
  max: number;
  args: readonly ArgumentType[];
  rest?: ArgumentType;
  /** `element`: one item of the list the first argument is */
  result: FormulaType | 'branch' | 'arrayInput' | 'flatten' | 'element';
}
const signatures: Record<string, Signature> = {};
function define(
  names: string,
  min: number,
  max: number,
  args: ArgumentType[],
  result: Signature['result'],
  rest?: ArgumentType,
): void {
  for (const name of names.split(' ')) signatures[name] = { min, max, args, result, rest };
}
define('XLOOKUP', 3, 6, ['value', 'value', 'value', 'value', 'number', 'number'], 'element');
define('SUMIFS AVERAGEIFS MAXIFS MINIFS', 3, Infinity, [], 'number', 'value');
define('COUNTIFS', 2, Infinity, [], 'number', 'value');
define('RANK', 1, 3, ['number', 'number', 'value'], 'number');
define('PREVIOUS NEXT', 1, 3, ['value', 'value', 'value'], 'element');
define('RUNNINGSUM', 1, 3, ['number', 'value', 'value'], 'number');
define('RUNNINGCOUNT', 0, 3, ['value', 'value', 'value'], 'number');
define('ABS INT SQRT EXP LOG10 EVEN ODD', 1, 1, ['number'], 'number');
define('ROUND ROUNDUP ROUNDDOWN MOD POWER', 2, 2, ['number', 'number'], 'number');
define('CEILING FLOOR LOG', 1, 2, ['number', 'number'], 'number');
define('MAX MIN SUM AVERAGE', 1, Infinity, [], 'number', 'numbers');
define('COUNT COUNTA COUNTALL', 1, Infinity, [], 'number', 'value');
define('VALUE', 1, 1, ['text'], 'number');
define('CONCATENATE', 1, Infinity, [], 'text', 'value');
define('LEN', 1, 1, ['text'], 'number');
define('LOWER UPPER TRIM ENCODE_URL_COMPONENT', 1, 1, ['text'], 'text');
define('LEFT RIGHT REPT', 2, 2, ['text', 'number'], 'text');
define('MID', 3, 3, ['text', 'number', 'number'], 'text');
define('FIND SEARCH', 2, 3, ['text', 'text', 'number'], 'number');
define('SUBSTITUTE', 3, 4, ['text', 'text', 'text', 'number'], 'text');
define('REPLACE', 4, 4, ['text', 'number', 'number', 'text'], 'text');
define('T', 1, 1, ['value'], 'text');
define('REGEX_MATCH', 2, 2, ['text', 'text'], 'boolean');
define('REGEX_EXTRACT', 2, 2, ['text', 'text'], 'text');
define('REGEX_REPLACE', 3, 3, ['text', 'text', 'text'], 'text');
define('TRUE FALSE', 0, 0, [], 'boolean');
define('BLANK', 0, 0, [], 'blank');
define('ERROR', 0, 1, ['text'], 'blank');
define('IF', 2, 3, ['value', 'value', 'value'], 'branch');
define('SWITCH', 3, Infinity, [], 'branch', 'value');
define('AND OR XOR', 1, Infinity, [], 'boolean', 'value');
define('NOT ISERROR', 1, 1, ['value'], 'boolean');
define('TODAY', 0, 0, [], 'date');
define('NOW CREATED_TIME', 0, 0, [], 'datetime');
define('LAST_MODIFIED_TIME', 0, Infinity, [], 'datetime', 'value');
define('RECORD_ID', 0, 0, [], 'text');
define('DATEADD', 3, 3, ['dateLike', 'number', 'text'], 'datetime');
define('DATETIME_DIFF', 2, 3, ['dateLike', 'dateLike', 'text'], 'number');
define('DATETIME_FORMAT', 1, 2, ['dateLike', 'text'], 'text');
define('DATETIME_PARSE', 1, 3, ['text', 'text', 'text'], 'datetime');
define('YEAR MONTH DAY HOUR MINUTE SECOND', 1, 1, ['dateLike'], 'number');
define('WEEKDAY WEEKNUM', 1, 2, ['dateLike', 'text'], 'number');
define('WORKDAY', 2, 3, ['dateLike', 'number', 'text'], 'date');
define('WORKDAY_DIFF', 2, 3, ['dateLike', 'dateLike', 'text'], 'number');
define('IS_BEFORE IS_AFTER', 2, 2, ['dateLike', 'dateLike'], 'boolean');
define('IS_SAME', 2, 3, ['dateLike', 'dateLike', 'text'], 'boolean');
define('SET_TIMEZONE', 2, 2, ['dateLike', 'text'], 'datetime');
define('DATESTR TIMESTR', 1, 1, ['dateLike'], 'text');
define('ARRAYJOIN', 1, 2, ['array', 'text'], 'text');
define('ARRAYUNIQUE ARRAYCOMPACT', 1, 1, ['array'], 'arrayInput');
define('ARRAYFLATTEN', 1, 1, ['array'], 'flatten');
define('START END', 1, 1, ['range'], 'element');
define('ARRAYSLICE', 2, 3, ['array', 'number', 'number'], 'arrayInput');
export const FUNCTIONS: Readonly<Record<string, Readonly<Signature>>> = Object.freeze(signatures);

export function typeName(type: FormulaType): string {
  return typeof type === 'string' ? type : `array<${typeName(type.array)}>`;
}
export function sameType(a: FormulaType, b: FormulaType): boolean {
  return typeName(a) === typeName(b);
}
function accepts(expected: ArgumentType, actual: FormulaType): boolean {
  if (actual === 'blank' || expected === 'value') return true;
  if (expected === 'array') return typeof actual === 'object';
  if (expected === 'range')
    return typeof actual === 'object' && ['date', 'datetime', 'blank'].includes(String(actual.array));
  if (expected === 'numbers') {
    let item: FormulaType = actual;
    while (typeof item === 'object') item = item.array;
    return item === 'number' || item === 'boolean' || item === 'blank';
  }
  if (expected === 'dateLike') return actual === 'date' || actual === 'datetime' || actual === 'text';
  return actual === expected || (expected === 'number' && actual === 'boolean');
}
export function compatible(a: FormulaType, b: FormulaType): boolean {
  return (
    a === 'blank' ||
    b === 'blank' ||
    sameType(a, b) ||
    ((a === 'date' || a === 'datetime') && (b === 'date' || b === 'datetime')) ||
    ((a === 'number' || a === 'boolean') && (b === 'number' || b === 'boolean'))
  );
}

/** Fields holding a list that reads as its one item where one value belongs */
const ONE_VALUE = new Set<string>(['lookup', 'link']);

interface Analysis {
  type: FormulaType;
  error?: FormulaError;
  /** Lookup references read as their one value */
  singles: Set<Ast>;
}

/**
 * Types a formula, and finds the lookups it reads as one value.  A lookup holds a list, but where
 * the list itself wouldn't fit and one of its items would, as in `{Price} * {Quantity}`, the
 * reference reads as its one item: blank when the list is empty, and an error when it holds more
 * than one.  A link's list of names reads the same way, as in `{Client} = "Forrester"`.  Anywhere a
 * list already fits, like `COUNT`, `ARRAYJOIN`, `&`, or `IF`, it stays a list, so no formula that
 * checked before changes its meaning.
 */
function analyze(ast: Ast, fieldTypes?: FieldTypes): Analysis {
  let error: FormulaError | undefined;
  const singles = new Set<Ast>();
  const ranges = new Set<Ast>();
  const findRanges = (node: Ast): void => {
    if (node.kind === 'call') {
      node.args.forEach((arg, i) => {
        if (
          (node.name === 'XLOOKUP' && (i === 1 || i === 2)) ||
          (node.name === 'COUNTIFS' && i % 2 === 0) ||
          (['SUMIFS', 'AVERAGEIFS', 'MAXIFS', 'MINIFS'].includes(node.name) && (i === 0 || i % 2 === 1))
        )
          ranges.add(arg);
        findRanges(arg);
      });
    } else if (node.kind === 'binary') {
      findRanges(node.left);
      findRanges(node.right);
    } else if (node.kind === 'unary') findRanges(node.operand);
  };
  findRanges(ast);
  const reject = (node: Ast, messageKey: string, params?: FormulaError['params']) => {
    error ??= diagnostic(node, messageKey, params);
  };
  const expect = (node: Ast, type: FormulaType, wanted: ArgumentType): void => {
    if (!accepts(wanted, type))
      reject(node, 'formula.type.argument', { expected: wanted, actual: typeName(type) });
  };
  /** The item type of a lookup's or link's list, when the reference could read as its one item. */
  const item = (node: Ast, type: FormulaType): FormulaType | undefined => {
    if (node.kind !== 'field' || !node.fieldId || typeof type !== 'object') return undefined;
    if (typeof type.array === 'object') return undefined;
    const input = fieldTypes?.get(node.fieldId);
    const kind = input && typeof input === 'object' && 'id' in input ? input.type : node.fieldType;
    return kind && ONE_VALUE.has(kind) ? type.array : undefined;
  };
  /** A lookup's list, read as its one item where the list wouldn't fit and the item would. */
  const single = (node: Ast, type: FormulaType, fits: (type: FormulaType) => boolean): FormulaType => {
    const one = item(node, type);
    if (one === undefined || fits(type) || !fits(one)) return type;
    singles.add(node);
    return one;
  };
  const merge = (nodes: readonly Ast[], types: readonly FormulaType[]): FormulaType => {
    let result: FormulaType = 'blank';
    for (let i = 0; i < types.length; i++) {
      const type = types[i]!;
      if (type === 'blank') continue;
      if (result === 'blank') result = type;
      else if (!sameType(result, type))
        reject(nodes[i]!, 'formula.type.branch', { expected: typeName(result), actual: typeName(type) });
    }
    return result;
  };
  /** Two values compared, with a lookup read as one value where only that makes them comparable. */
  const comparable = (left: Ast, a: FormulaType, right: Ast, b: FormulaType): [FormulaType, FormulaType] => {
    if (compatible(a, b)) return [a, b];
    const x = item(left, a),
      y = item(right, b);
    if (x !== undefined && compatible(x, b)) {
      singles.add(left);
      return [x, b];
    }
    if (y !== undefined && compatible(a, y)) {
      singles.add(right);
      return [a, y];
    }
    if (x !== undefined && y !== undefined && compatible(x, y)) {
      singles.add(left).add(right);
      return [x, y];
    }
    return [a, b];
  };
  const walk = (node: Ast): FormulaType => {
    switch (node.kind) {
      case 'literal':
        return typeof node.value === 'string'
          ? 'text'
          : typeof node.value === 'boolean'
            ? 'boolean'
            : 'number';
      case 'field': {
        if (node.tableName !== undefined && !ranges.has(node)) reject(node, 'formula.type.rangeContext');
        if (!node.fieldId) {
          reject(node, 'formula.field.unresolved', { name: node.name });
          return 'blank';
        }
        const input = fieldTypes?.get(node.fieldId);
        const type =
          input && typeof input === 'object' && 'id' in input
            ? fieldType(input)
            : fieldTypes
              ? input
              : node.valueType;
        if (!type) {
          reject(node, 'formula.field.unknown', { name: node.name });
          return 'blank';
        }
        return type;
      }
      case 'unary': {
        const fits = (type: FormulaType) => accepts('number', type);
        expect(node.operand, single(node.operand, walk(node.operand), fits), 'number');
        return 'number';
      }
      case 'binary': {
        let left = walk(node.left),
          right = walk(node.right);
        if (['+', '-', '*', '/'].includes(node.operator)) {
          const fits = (type: FormulaType) => accepts('number', type);
          expect(node.left, single(node.left, left, fits), 'number');
          expect(node.right, single(node.right, right, fits), 'number');
          return 'number';
        }
        if (node.operator === '&') return 'text';
        if (node.operator === '&&' || node.operator === '||') return 'boolean';
        [left, right] = comparable(node.left, left, node.right, right);
        if (!compatible(left, right))
          reject(node.right, 'formula.type.comparison', {
            expected: typeName(left),
            actual: typeName(right),
          });
        return 'boolean';
      }
      case 'call': {
        const signature = FUNCTIONS[node.name];
        if (!signature) {
          reject(node, 'formula.function.unknown', { name: node.name });
          return 'blank';
        }
        if (node.args.length < signature.min || node.args.length > signature.max)
          reject(node, 'formula.function.arity', {
            name: node.name,
            min: signature.min,
            max: signature.max === Infinity ? -1 : signature.max,
            actual: node.args.length,
          });
        const types = node.args.map(walk);
        const range = (arg: Ast | undefined): string | undefined => {
          if (!arg || arg.kind !== 'field' || !arg.tableId) {
            reject(arg ?? node, 'formula.type.rangeRequired');
            return;
          }
          return arg.tableId;
        };
        if (node.name === 'XLOOKUP' || node.name.endsWith('IFS')) {
          const indices =
            node.name === 'XLOOKUP'
              ? [1, 2]
              : node.name === 'COUNTIFS'
                ? node.args.map((_, i) => i).filter((i) => i % 2 === 0)
                : [0, ...node.args.map((_, i) => i).filter((i) => i % 2 === 1)];
          const tables = indices.map((i) => range(node.args[i]));
          if (tables.some((table) => table !== tables[0])) reject(node, 'formula.type.sameTable');
          if (node.name.endsWith('IFS') && node.args.length % 2 !== (node.name === 'COUNTIFS' ? 0 : 1))
            reject(node, 'formula.runtime.argument');
          if (node.name !== 'COUNTIFS' && node.name !== 'XLOOKUP') expect(node.args[0]!, types[0]!, 'number');
          if (node.name === 'XLOOKUP') {
            if (node.args[3] && !compatible(types[2]!, types[3]!))
              reject(node.args[3], 'formula.type.branch');
            if (node.args[4]) expect(node.args[4], types[4]!, 'number');
            if (node.args[5]) expect(node.args[5], types[5]!, 'number');
            return types[2] ?? 'blank';
          }
        }
        if (['PREVIOUS', 'NEXT', 'RUNNINGSUM', 'RUNNINGCOUNT', 'RANK'].includes(node.name)) {
          for (let i = node.name === 'RANK' ? 2 : 1; i < node.args.length; i++)
            if (
              !(
                node.args[i]?.kind === 'call' &&
                (node.args[i] as Extract<Ast, { kind: 'call' }>).name === 'BLANK'
              ) &&
              (node.args[i]?.kind !== 'field' ||
                (node.args[i] as Extract<Ast, { kind: 'field' }>).tableName !== undefined)
            )
              reject(node.args[i]!, 'formula.type.fieldRequired');
          if (node.name === 'PREVIOUS' || node.name === 'NEXT') return types[0] ?? 'blank';
        }
        node.args.forEach((arg, i) => {
          const wanted = signature.args[i] ?? signature.rest ?? 'value';
          types[i] = single(arg, types[i]!, (type) => accepts(wanted, type));
          expect(arg, types[i], wanted);
        });
        if (node.name === 'LAST_MODIFIED_TIME')
          node.args.forEach((arg) => {
            if (arg.kind !== 'field') reject(arg, 'formula.type.fieldRequired');
          });
        if (signature.result === 'branch') {
          if (node.name === 'IF') return merge(node.args.slice(1), types.slice(1));
          const nodes: Ast[] = [],
            branches: FormulaType[] = [];
          // A lookup compared with single values reads as its one value, as it does with `=`.
          const subject = item(node.args[0]!, types[0]!);
          if (subject !== undefined)
            for (let i = 1; i + 1 < types.length; i += 2)
              if (!compatible(types[0]!, types[i]!) && compatible(subject, types[i]!)) {
                singles.add(node.args[0]!);
                types[0] = subject;
                break;
              }
          for (let i = 1; i + 1 < types.length; i += 2) {
            types[i] = single(node.args[i]!, types[i]!, (type) => compatible(types[0]!, type));
            if (!compatible(types[0]!, types[i]!)) reject(node.args[i]!, 'formula.type.comparison');
            nodes.push(node.args[i + 1]!);
            branches.push(types[i + 1]!);
          }
          if (types.length % 2 === 0) {
            nodes.push(node.args.at(-1)!);
            branches.push(types.at(-1)!);
          }
          return merge(nodes, branches);
        }
        if (signature.result === 'arrayInput')
          return types[0] === 'blank' ? { array: 'blank' } : (types[0] ?? { array: 'blank' });
        if (signature.result === 'element') return typeof types[0] === 'object' ? types[0].array : 'blank';
        if (signature.result === 'flatten') {
          let inner = types[0] ?? 'blank';
          while (typeof inner === 'object') inner = inner.array;
          return { array: inner };
        }
        return signature.result;
      }
    }
  };
  const type = walk(ast);
  return { type, singles, ...(error ? { error } : {}) };
}

/**
 * The formula's type, or its first problem.  `oneValue` lists the lookups it reads as one value,
 * by field ID in the order they first appear, when there are any.
 */
export function check(
  ast: Ast,
  fieldTypes?: FieldTypes,
): Result<{ type: FormulaType; oneValue?: readonly string[] }> {
  const { type, error, singles } = analyze(ast, fieldTypes);
  if (error) return { error };
  const ids = [
    ...new Set(
      [...singles]
        .sort((a, b) => a.start - b.start)
        .flatMap((node) => (node.kind === 'field' && node.fieldId ? [node.fieldId] : [])),
    ),
  ];
  return ids.length ? { type, oneValue: ids } : { type };
}

/** The lookup references a formula reads as their one value, as `check` works them out. */
export function singleReads(ast: Ast, fieldTypes?: FieldTypes): ReadonlySet<Ast> {
  return analyze(ast, fieldTypes).singles;
}
