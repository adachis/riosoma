import type { Ast } from './ast.js';

export type FormulaBuilder =
  | { kind: 'combine'; first: string; second: string; separator: string }
  | { kind: 'difference'; start: string; end: string; unit: 'days' | 'hours' | 'minutes' }
  | { kind: 'mapping'; field: string; match: string; then: string; otherwise: string }
  | { kind: 'bucket'; field: string; boundary: number; then: string; otherwise: string }
  | { kind: 'links'; field: string; position: number };

function field(node: Ast | undefined): string | undefined {
  return node?.kind === 'field' && node.tableName === undefined ? (node.fieldId ?? node.name) : undefined;
}
function text(node: Ast | undefined): string | undefined {
  return node?.kind === 'literal' && typeof node.value === 'string' ? node.value : undefined;
}
function number(node: Ast | undefined): number | undefined {
  if (node?.kind === 'unary') {
    const value = number(node.operand);
    return value === undefined ? undefined : -value;
  }
  return node?.kind === 'literal' && typeof node.value === 'number' && Number.isFinite(node.value)
    ? node.value
    : undefined;
}

/** Match the entire shape so opening a builder cannot discard an expression it can't represent. */
export function formulaBuilder(ast: Ast): FormulaBuilder | undefined {
  if (ast.kind !== 'call') return;
  const [a, b, c] = ast.args;
  if (ast.name === 'CONCATENATE' && ast.args.length === 3) {
    const first = field(a),
      second = field(c),
      separator = text(b);
    if (first && second && separator !== undefined) return { kind: 'combine', first, second, separator };
  }
  if (ast.name === 'DATETIME_DIFF' && ast.args.length === 3) {
    const end = field(a),
      start = field(b),
      unit = text(c);
    if (start && end && (unit === 'days' || unit === 'hours' || unit === 'minutes'))
      return { kind: 'difference', start, end, unit };
  }
  if (ast.name === 'IF' && ast.args.length === 3 && a?.kind === 'binary') {
    const source = field(a.left),
      then = text(b),
      otherwise = text(c);
    if (source && then !== undefined && otherwise !== undefined) {
      const match = text(a.right),
        boundary = number(a.right);
      if (a.operator === '=' && match !== undefined)
        return { kind: 'mapping', field: source, match, then, otherwise };
      if (a.operator === '<' && boundary !== undefined)
        return { kind: 'bucket', field: source, boundary, then, otherwise };
    }
  }
  if (
    ast.name === 'ARRAYJOIN' &&
    ast.args.length === 2 &&
    text(b) === '' &&
    a?.kind === 'call' &&
    a.name === 'ARRAYSLICE' &&
    a.args.length === 3
  ) {
    const source = field(a.args[0]),
      position = number(a.args[1]);
    if (
      source &&
      position !== undefined &&
      Number.isSafeInteger(position) &&
      position > 0 &&
      position === number(a.args[2])
    )
      return { kind: 'links', field: source, position };
  }
}
