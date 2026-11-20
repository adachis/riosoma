import type { RollupFunction } from '@riosoma/contracts';
import { describe, FUNCTIONS, type Ast, type BinaryOperator } from '@riosoma/formula';
import type { Written } from '../fields.js';

/**
 * Grist's formulas are Python.  The ones that are a single expression over the record's own
 * columns, with Grist's spreadsheet functions and a few of Python's own, translate to Riosoma's
 * language: `$Price * $Quantity`, `$First + " " + $Last`, `UPPER($Name) if $Active else ""`,
 * `round($Total, 2)`, or `$Name.upper()`.  Anything else, like statements over several lines,
 * lookups into other tables, keyword arguments, or Python's collections, keeps Grist's values,
 * with a line in the report.  Whether a translation gives the same results is checked against
 * Grist's own, record by record, once the formula is made.
 */

type Kind = 'number' | 'text' | 'boolean' | 'date' | 'unknown';

type Py =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'none' }
  | { kind: 'column'; name: string }
  | { kind: 'name'; name: string }
  | { kind: 'call'; callee: Py; args: Py[] }
  | { kind: 'attribute'; object: Py; name: string }
  | { kind: 'unary'; operator: '-' | '+' | 'not'; operand: Py }
  | { kind: 'binary'; operator: string; left: Py; right: Py }
  | { kind: 'if'; test: Py; then: Py; otherwise: Py };

interface Token {
  kind: 'number' | 'string' | 'name' | 'column' | 'op' | 'end';
  text: string;
  value?: string | number;
}

class Untranslatable extends Error {
  constructor(readonly functions: string[] = []) {
    super('untranslatable');
  }
}

const OPERATORS = [
  '**',
  '//',
  '==',
  '!=',
  '<=',
  '>=',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '(',
  ')',
  ',',
  '.',
  '[',
];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at]!;
    if (char === ' ' || char === '\t') {
      at++;
      continue;
    }
    // A formula of several lines is statements, which don't translate.
    if (char === '\n' || char === '\r' || char === ';' || char === '#') throw new Untranslatable();
    const number = /^(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(source.slice(at));
    if (number) {
      tokens.push({ kind: 'number', text: number[0], value: Number(number[0]) });
      at += number[0].length;
      continue;
    }
    if (char === '"' || char === "'") {
      if (source.startsWith(char.repeat(3), at)) throw new Untranslatable();
      let text = '';
      let end = at + 1;
      for (; end < source.length && source[end] !== char; end++) {
        if (source[end] === '\n') throw new Untranslatable();
        if (source[end] === '\\') {
          const escaped = source[++end];
          const escapes: Record<string, string> = {
            n: '\n',
            t: '\t',
            r: '\r',
            '\\': '\\',
            "'": "'",
            '"': '"',
          };
          if (escaped === undefined || escapes[escaped] === undefined) throw new Untranslatable();
          text += escapes[escaped];
        } else text += source[end];
      }
      if (end >= source.length) throw new Untranslatable();
      tokens.push({ kind: 'string', text: source.slice(at, end + 1), value: text });
      at = end + 1;
      continue;
    }
    if (char === '$') {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(at + 1));
      if (!name) throw new Untranslatable();
      tokens.push({ kind: 'column', text: name[0] });
      at += 1 + name[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(at));
    if (name) {
      // Prefixed strings, like f-strings, don't translate.
      if (
        /^[rRbBuUfF]{1,2}$/.test(name[0]) &&
        (source[at + name[0].length] === '"' || source[at + name[0].length] === "'")
      )
        throw new Untranslatable();
      tokens.push({ kind: 'name', text: name[0] });
      at += name[0].length;
      continue;
    }
    const operator = OPERATORS.find((item) => source.startsWith(item, at));
    if (!operator || operator === '[') throw new Untranslatable();
    tokens.push({ kind: 'op', text: operator });
    at += operator.length;
  }
  tokens.push({ kind: 'end', text: '' });
  return tokens;
}

/** A parser for the part of Python's expression grammar that translates. */
function parsePython(source: string): Py {
  const tokens = tokenize(source.trim().replace(/^return\s+/, ''));
  let position = 0;
  const peek = () => tokens[position]!;
  const take = () => tokens[position++]!;
  const accept = (text: string) => {
    if (peek().text === text && peek().kind !== 'string') {
      position++;
      return true;
    }
    return false;
  };
  const expect = (text: string) => {
    if (!accept(text)) throw new Untranslatable();
  };

  const expression = (): Py => {
    const body = or();
    if (peek().kind === 'name' && peek().text === 'if') {
      take();
      const test = or();
      if (!(peek().kind === 'name' && take().text === 'else')) throw new Untranslatable();
      return { kind: 'if', test, then: body, otherwise: expression() };
    }
    return body;
  };
  const or = (): Py => {
    let left = and();
    while (peek().kind === 'name' && peek().text === 'or') {
      take();
      left = { kind: 'binary', operator: 'or', left, right: and() };
    }
    return left;
  };
  const and = (): Py => {
    let left = not();
    while (peek().kind === 'name' && peek().text === 'and') {
      take();
      left = { kind: 'binary', operator: 'and', left, right: not() };
    }
    return left;
  };
  const not = (): Py => {
    if (peek().kind === 'name' && peek().text === 'not') {
      take();
      return { kind: 'unary', operator: 'not', operand: not() };
    }
    return comparison();
  };
  const comparison = (): Py => {
    const left = sum();
    const operator = peek();
    if (operator.kind === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(operator.text)) {
      take();
      const right = sum();
      const next = peek();
      // Chained comparisons read differently in Python.
      if (next.kind === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(next.text))
        throw new Untranslatable();
      return { kind: 'binary', operator: operator.text, left, right };
    }
    if (
      operator.kind === 'name' &&
      (operator.text === 'in' || operator.text === 'is' || operator.text === 'not')
    )
      throw new Untranslatable();
    return left;
  };
  const sum = (): Py => {
    let left = product();
    while (peek().kind === 'op' && (peek().text === '+' || peek().text === '-')) {
      const operator = take().text;
      left = { kind: 'binary', operator, left, right: product() };
    }
    return left;
  };
  const product = (): Py => {
    let left = unary();
    while (peek().kind === 'op' && ['*', '/', '//', '%'].includes(peek().text)) {
      const operator = take().text;
      left = { kind: 'binary', operator, left, right: unary() };
    }
    return left;
  };
  const unary = (): Py => {
    if (peek().kind === 'op' && (peek().text === '-' || peek().text === '+')) {
      const operator = take().text as '-' | '+';
      return { kind: 'unary', operator, operand: unary() };
    }
    return power();
  };
  const power = (): Py => {
    const base = postfix();
    if (accept('**')) return { kind: 'binary', operator: '**', left: base, right: unary() };
    return base;
  };
  const postfix = (): Py => {
    let node = atom();
    for (;;) {
      if (accept('.')) {
        const name = take();
        if (name.kind !== 'name') throw new Untranslatable();
        node = { kind: 'attribute', object: node, name: name.text };
      } else if (accept('(')) {
        // Keyword arguments never get this far, since `=` alone isn't one of the operators read.
        const args: Py[] = [];
        if (!accept(')')) {
          for (;;) {
            args.push(expression());
            if (accept(')')) break;
            expect(',');
          }
        }
        node = { kind: 'call', callee: node, args };
      } else return node;
    }
  };
  const atom = (): Py => {
    const token = take();
    if (token.kind === 'number') return { kind: 'number', value: token.value as number };
    if (token.kind === 'string') {
      let value = token.value as string;
      // Python joins strings written next to each other.
      while (peek().kind === 'string') value += take().value as string;
      return { kind: 'string', value };
    }
    if (token.kind === 'column') return { kind: 'column', name: token.text };
    if (token.kind === 'name') {
      if (token.text === 'True' || token.text === 'False')
        return { kind: 'bool', value: token.text === 'True' };
      if (token.text === 'None') return { kind: 'none' };
      if (token.text === 'rec' && accept('.')) {
        const name = take();
        if (name.kind !== 'name') throw new Untranslatable();
        return { kind: 'column', name: name.text };
      }
      return { kind: 'name', name: token.text };
    }
    if (token.kind === 'op' && token.text === '(') {
      const inner = expression();
      expect(')');
      return inner;
    }
    throw new Untranslatable();
  };

  const tree = expression();
  if (peek().kind !== 'end') throw new Untranslatable();
  return tree;
}

/** Functions Grist names differently from Riosoma, or Python's own that have a match here */
const RENAMES: Readonly<Record<string, string>> = {
  CONCAT: 'CONCATENATE',
  AVERAGEA: 'AVERAGE',
  ISBLANK: '',
};
const PYTHON: Readonly<Record<string, { name: string; kind: Kind }>> = {
  len: { name: 'LEN', kind: 'number' },
  abs: { name: 'ABS', kind: 'number' },
  round: { name: 'ROUND', kind: 'number' },
  int: { name: 'INT', kind: 'number' },
  min: { name: 'MIN', kind: 'number' },
  max: { name: 'MAX', kind: 'number' },
};
const METHODS: Readonly<Record<string, { name: string; kind: Kind; args: number }>> = {
  upper: { name: 'UPPER', kind: 'text', args: 0 },
  lower: { name: 'LOWER', kind: 'text', args: 0 },
  strip: { name: 'TRIM', kind: 'text', args: 0 },
  replace: { name: 'SUBSTITUTE', kind: 'text', args: 2 },
};
const PARTS: Readonly<Record<string, string>> = {
  year: 'YEAR',
  month: 'MONTH',
  day: 'DAY',
  hour: 'HOUR',
  minute: 'MINUTE',
  second: 'SECOND',
};
const TEXT_FUNCTIONS = new Set([
  'CONCATENATE',
  'LOWER',
  'UPPER',
  'TRIM',
  'LEFT',
  'RIGHT',
  'MID',
  'SUBSTITUTE',
  'REPLACE',
  'REPT',
  'T',
  'DATESTR',
  'TIMESTR',
  'DATETIME_FORMAT',
  'REGEX_EXTRACT',
  'REGEX_REPLACE',
  'ENCODE_URL_COMPONENT',
]);
const COMPARISONS: Readonly<Record<string, BinaryOperator>> = {
  '==': '=',
  '!=': '!=',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
};

type Bare<T = Ast> = T extends unknown ? Omit<T, 'start' | 'end'> : never;
const node = (made: Bare): Ast => ({ start: 0, end: 0, ...made }) as Ast;

/** Whether a column holds text, numbers, dates, or true or false, from its Grist type */
export type ColumnKinds = (column: string) => Kind | undefined;

/** A Grist formula in Riosoma's language, with columns in braces by their Grist IDs. */
export function translateGrist(formula: string, kinds: ColumnKinds): Written {
  let tree: Py;
  try {
    tree = parsePython(formula);
  } catch {
    return { expression: null, problem: 'syntax', functions: [] };
  }
  const missing = new Set<string>();
  const walk = (py: Py): { ast: Ast; kind: Kind } => {
    switch (py.kind) {
      case 'number':
        return { ast: node({ kind: 'literal', value: py.value }), kind: 'number' };
      case 'string':
        return { ast: node({ kind: 'literal', value: py.value }), kind: 'text' };
      case 'bool':
        return { ast: node({ kind: 'literal', value: py.value }), kind: 'boolean' };
      case 'none':
        return { ast: node({ kind: 'call', name: 'BLANK', args: [] }), kind: 'unknown' };
      case 'column': {
        // A record's ID here isn't Grist's, so formulas reading it can't give the same results.
        if (py.name === 'id') throw new Untranslatable();
        const kind = kinds(py.name);
        if (kind === undefined) throw new Untranslatable();
        return { ast: node({ kind: 'field', name: py.name }), kind };
      }
      case 'unary': {
        const operand = walk(py.operand);
        if (py.operator === 'not')
          return { ast: node({ kind: 'call', name: 'NOT', args: [operand.ast] }), kind: 'boolean' };
        return py.operator === '-'
          ? { ast: node({ kind: 'unary', operand: operand.ast }), kind: 'number' }
          : operand;
      }
      case 'binary': {
        const left = walk(py.left);
        const right = walk(py.right);
        if (py.operator === 'and' || py.operator === 'or')
          return {
            ast: node({ kind: 'call', name: py.operator.toUpperCase(), args: [left.ast, right.ast] }),
            kind: 'boolean',
          };
        const comparison = COMPARISONS[py.operator];
        if (comparison)
          return {
            ast: node({ kind: 'binary', operator: comparison, left: left.ast, right: right.ast }),
            kind: 'boolean',
          };
        if (py.operator === '+' && (left.kind === 'text' || right.kind === 'text'))
          return {
            ast: node({ kind: 'binary', operator: '&', left: left.ast, right: right.ast }),
            kind: 'text',
          };
        if (py.operator === '%')
          return { ast: node({ kind: 'call', name: 'MOD', args: [left.ast, right.ast] }), kind: 'number' };
        if (py.operator === '**')
          return { ast: node({ kind: 'call', name: 'POWER', args: [left.ast, right.ast] }), kind: 'number' };
        if (py.operator === '//')
          return {
            ast: node({
              kind: 'call',
              name: 'INT',
              args: [node({ kind: 'binary', operator: '/', left: left.ast, right: right.ast })],
            }),
            kind: 'number',
          };
        return {
          ast: node({
            kind: 'binary',
            operator: py.operator as BinaryOperator,
            left: left.ast,
            right: right.ast,
          }),
          kind: py.operator === '-' && left.kind === 'date' ? 'unknown' : 'number',
        };
      }
      case 'if': {
        const test = walk(py.test);
        const then = walk(py.then);
        const otherwise = walk(py.otherwise);
        return {
          ast: node({ kind: 'call', name: 'IF', args: [test.ast, then.ast, otherwise.ast] }),
          kind: then.kind === otherwise.kind ? then.kind : 'unknown',
        };
      }
      case 'attribute': {
        const part = PARTS[py.name];
        if (!part) throw new Untranslatable();
        const object = walk(py.object);
        if (object.kind !== 'date') throw new Untranslatable();
        return { ast: node({ kind: 'call', name: part, args: [object.ast] }), kind: 'number' };
      }
      case 'call': {
        if (py.callee.kind === 'attribute') {
          const method = METHODS[py.callee.name];
          if (!method || py.args.length !== method.args) {
            missing.add(py.callee.name);
            throw new Untranslatable();
          }
          const object = walk(py.callee.object);
          return {
            ast: node({
              kind: 'call',
              name: method.name,
              args: [object.ast, ...py.args.map((arg) => walk(arg).ast)],
            }),
            kind: method.kind,
          };
        }
        if (py.callee.kind !== 'name') throw new Untranslatable();
        const args = py.args.map(walk);
        if (py.callee.name === 'str' && args.length === 1)
          return {
            ast: node({
              kind: 'binary',
              operator: '&',
              left: args[0]!.ast,
              right: node({ kind: 'literal', value: '' }),
            }),
            kind: 'text',
          };
        if (py.callee.name === 'float' && args.length === 1)
          return args[0]!.kind === 'text'
            ? { ast: node({ kind: 'call', name: 'VALUE', args: [args[0]!.ast] }), kind: 'number' }
            : args[0]!;
        const python = PYTHON[py.callee.name];
        if (python) {
          const extra =
            python.name === 'ROUND' && args.length === 1 ? [node({ kind: 'literal', value: 0 })] : [];
          return {
            ast: node({ kind: 'call', name: python.name, args: [...args.map((arg) => arg.ast), ...extra] }),
            kind: python.kind,
          };
        }
        const name = RENAMES[py.callee.name] ?? py.callee.name;
        if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name) || !FUNCTIONS[name]) {
          missing.add(py.callee.name);
          throw new Untranslatable();
        }
        return {
          ast: node({ kind: 'call', name, args: args.map((arg) => arg.ast) }),
          kind: TEXT_FUNCTIONS.has(name)
            ? 'text'
            : ['TODAY', 'DATEADD', 'NOW', 'WORKDAY', 'DATETIME_PARSE'].includes(name)
              ? 'date'
              : [
                    'AND',
                    'OR',
                    'NOT',
                    'XOR',
                    'ISERROR',
                    'IS_BEFORE',
                    'IS_AFTER',
                    'IS_SAME',
                    'REGEX_MATCH',
                  ].includes(name)
                ? 'boolean'
                : name === 'IF' || name === 'SWITCH'
                  ? 'unknown'
                  : 'number',
        };
      }
      case 'name':
        missing.add(py.name);
        throw new Untranslatable();
    }
  };
  try {
    return { expression: describe(walk(tree).ast, []), functions: [] };
  } catch {
    return missing.size
      ? { expression: null, problem: 'functions', functions: [...missing].sort() }
      : { expression: null, problem: 'syntax', functions: [] };
  }
}

/** What a formula that looks records up in another table becomes here. */
export type Looked =
  | { kind: 'lookup'; table: string; field: string; target: string }
  | { kind: 'rollup'; table: string; field: string; target: string; fn: RollupFunction }
  | { kind: 'count'; table: string; field: string };

const LOOKED_UP: Readonly<Record<string, RollupFunction>> = {
  SUM: 'sum',
  sum: 'sum',
  AVERAGE: 'average',
  MIN: 'min',
  min: 'min',
  MAX: 'max',
  max: 'max',
  COUNT: 'count',
  len: 'countAll',
};

/**
 * Grist's usual way of reading the records that refer to this one, like
 * `SUM(Tasks.lookupRecords(Project=$id).Hours)` or `len(Tasks.lookupRecords(Project=$id))`, as a
 * rollup, count, or lookup through the other side of that reference.
 */
export function lookedUp(formula: string): Looked | null {
  const found =
    /^\s*(?:return\s+)?(?:([A-Za-z]+)\(\s*)?([A-Za-z_]\w*)\.lookupRecords\(\s*([A-Za-z_]\w*)\s*=\s*\$id\s*\)(?:\.([A-Za-z_]\w*))?\s*(\))?\s*$/.exec(
      formula,
    );
  if (!found) return null;
  const [, fn, table, field, target, closing] = found;
  if (Boolean(fn) !== Boolean(closing)) return null;
  if (!fn) return target ? { kind: 'lookup', table: table!, field: field!, target } : null;
  if (!target) return fn === 'len' ? { kind: 'count', table: table!, field: field! } : null;
  const rollup = LOOKED_UP[fn];
  return rollup ? { kind: 'rollup', table: table!, field: field!, target, fn: rollup } : null;
}
