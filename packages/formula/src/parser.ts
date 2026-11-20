import { diagnostic, type Ast, type BinaryOperator, type FormulaError, type Result } from './ast.js';

type Token = {
  kind: 'number' | 'string' | 'field' | 'column' | 'name' | 'symbol' | 'eof';
  text: string;
  start: number;
  end: number;
};
const precedence: Record<BinaryOperator, number> = {
  '||': 1,
  '&&': 2,
  '=': 3,
  '!=': 3,
  '<>': 3,
  '<': 3,
  '<=': 3,
  '>': 3,
  '>=': 3,
  '&': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
};
class ParseFailure {
  constructor(readonly error: FormulaError) {}
}

/** Offsets are zero-based UTF-16 offsets; end is exclusive, including at EOF. */
export function parse(source: string): Result<{ ast: Ast }> {
  let offset = 0;
  let depth = 0;
  const fail = (start: number, end: number, key = 'formula.syntax.unexpected'): never => {
    throw new ParseFailure(diagnostic({ start, end }, key, { token: source.slice(start, end) }));
  };
  const next = (): Token => {
    while (/\s/.test(source[offset] ?? '') && offset < source.length) offset++;
    const start = offset;
    if (offset === source.length) return { kind: 'eof', text: '', start, end: offset };
    const ch = source[offset++]!;
    if (ch === '"' || ch === "'" || ch === '{' || ch === '[') {
      const closing = ch === '{' ? '}' : ch === '[' ? ']' : ch;
      let text = '';
      while (offset < source.length) {
        const c = source[offset++]!;
        if (c === closing)
          return { kind: ch === '{' ? 'field' : ch === '[' ? 'column' : 'string', text, start, end: offset };
        if (c === '\\') {
          const escaped = source[offset++];
          if (escaped === undefined) fail(start, source.length, 'formula.syntax.unterminated');
          if (ch === '{' || ch === '[')
            text += escaped === closing || escaped === '\\' ? escaped : `\\${escaped}`;
          else {
            const escapes: Record<string, string> = {
              n: '\n',
              r: '\r',
              t: '\t',
              b: '\b',
              f: '\f',
              '\\': '\\',
              '"': '"',
              "'": "'",
            };
            if (escaped === 'u') {
              const hex = source.slice(offset, offset + 4);
              if (!/^[0-9a-f]{4}$/i.test(hex))
                fail(offset - 2, Math.min(offset + 4, source.length), 'formula.syntax.escape');
              text += String.fromCharCode(Number.parseInt(hex, 16));
              offset += 4;
            } else text += escapes[escaped!] ?? `\\${escaped}`;
          }
        } else text += c;
      }
      return fail(start, source.length, 'formula.syntax.unterminated');
    }
    offset = start;
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(offset));
    if (number) {
      offset += number[0].length;
      if (!Number.isFinite(Number(number[0]))) fail(start, offset, 'formula.syntax.number');
      return { kind: 'number', text: number[0], start, end: offset };
    }
    const name = /^[A-Za-z_][A-Za-z_0-9]*/.exec(source.slice(offset));
    if (name) {
      offset += name[0].length;
      return { kind: 'name', text: name[0], start, end: offset };
    }
    const symbol = /^(?:&&|\|\||!=|<>|<=|>=|[+\-*/&=<>(),])/.exec(source.slice(offset));
    if (symbol) {
      offset += symbol[0].length;
      return { kind: 'symbol', text: symbol[0], start, end: offset };
    }
    return fail(start, start + 1);
  };
  try {
    let token = next();
    const take = () => {
      const current = token;
      token = next();
      return current;
    };
    const at = (text: string) => token.text === text;
    const expect = (text: string) => {
      if (token.text !== text) fail(token.start, token.end);
      return take();
    };
    const expression = (minimum = 0): Ast => {
      if (++depth > 256) fail(token.start, token.end, 'formula.syntax.depth');
      const first = take();
      let left: Ast;
      if ((first.kind === 'name' || first.kind === 'string') && token.kind === 'column') {
        const column = take();
        left = {
          kind: 'field',
          tableName: first.text,
          name: column.text,
          start: first.start,
          end: column.end,
        };
      } else if (first.kind === 'number' || first.kind === 'string') {
        left = {
          kind: 'literal',
          value: first.kind === 'number' ? Number(first.text) : first.text,
          start: first.start,
          end: first.end,
        };
      } else if (first.kind === 'field') {
        left = { kind: 'field', name: first.text, start: first.start, end: first.end };
      } else if (first.text === '-') {
        const operand = expression(7);
        left = { kind: 'unary', operand, start: first.start, end: operand.end };
      } else if (first.text === '(') {
        left = expression();
        const last = expect(')');
        left = { ...left, start: first.start, end: last.end };
      } else if (first.kind === 'name') {
        const name = first.text.toUpperCase();
        if (token.text === '(') {
          take();
          const args: Ast[] = [];
          if (!at(')')) {
            args.push(expression());
            while (at(',')) {
              take();
              args.push(expression());
            }
          }
          const last = expect(')');
          left = { kind: 'call', name, args, start: first.start, end: last.end };
        } else if (name === 'TRUE' || name === 'FALSE') {
          left = { kind: 'literal', value: name === 'TRUE', start: first.start, end: first.end };
        } else left = { kind: 'field', name: first.text, start: first.start, end: first.end };
      } else return fail(first.start, first.end);
      while (token.kind === 'symbol') {
        const operator = token.text as BinaryOperator;
        const level = precedence[operator];
        if (level === undefined || level < minimum) break;
        take();
        const right = expression(level + 1);
        left = { kind: 'binary', operator, left, right, start: left.start, end: right.end };
      }
      depth--;
      return left;
    };
    const ast = expression();
    if (token.kind !== 'eof') fail(token.start, token.end);
    return { ast };
  } catch (error) {
    if (error instanceof ParseFailure) return { error: error.error };
    throw error;
  }
}
