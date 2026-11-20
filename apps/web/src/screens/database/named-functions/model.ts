import {
  NAMED_FUNCTION_LIMITS,
  type NamedFunctionInput,
  type NamedFunctionMeta,
  type FieldMeta,
} from '@riosoma/contracts';
import {
  check,
  evaluate,
  isError,
  parse,
  prepareNamedFunctions,
  resolve,
  type Ast,
  type FormulaError,
  type FormulaValue,
} from '@riosoma/formula';

export function registryFor(
  definitions: readonly NamedFunctionMeta[],
  definition: NamedFunctionInput,
  id?: string,
) {
  return [...definitions.filter((item) => item.id !== id), definition].map(({ name, parameters, body }) => ({
    name,
    parameters,
    body,
  }));
}

function calls(ast: Ast): string[] {
  if (ast.kind === 'call') return [ast.name.toUpperCase(), ...ast.args.flatMap(calls)];
  if (ast.kind === 'binary') return [...calls(ast.left), ...calls(ast.right)];
  return ast.kind === 'unary' ? calls(ast.operand) : [];
}

export function callersOf(
  definition: NamedFunctionMeta,
  definitions: readonly NamedFunctionMeta[],
  fields: readonly FieldMeta[],
  tables: readonly { id: string; name: string }[],
) {
  const used = new Set([definition.name.toUpperCase()]);
  let size = 0;
  while (size !== used.size) {
    size = used.size;
    for (const item of definitions) {
      const parsed = parse(item.body);
      if ('ast' in parsed && calls(parsed.ast).some((name) => used.has(name)))
        used.add(item.name.toUpperCase());
    }
  }
  return {
    functions: definitions
      .filter((item) => item.id !== definition.id && used.has(item.name.toUpperCase()))
      .map((item) => item.name),
    fields: fields.flatMap((field) => {
      if (field.type !== 'formula') return [];
      const parsed = parse(field.options.expression);
      return 'ast' in parsed && calls(parsed.ast).some((name) => used.has(name))
        ? [`${tables.find((table) => table.id === field.tableId)?.name ?? ''}: ${field.name}`]
        : [];
    }),
  };
}

/** Sample arguments are formula expressions, so text, dates, blanks, and lists use the same rules as fields. */
export function testFunction(
  definition: NamedFunctionInput,
  definitions: readonly NamedFunctionMeta[],
  id: string | undefined,
  samples: readonly string[],
  timeZone: string,
): { error: Pick<FormulaError, 'messageKey' | 'params'> } | { value: FormulaValue } {
  const registry = registryFor(definitions, definition, id);
  const prepared = prepareNamedFunctions(registry);
  if ('error' in prepared) return prepared;
  const limit = { error: { messageKey: 'formula.runtime.limit' } };
  const args: Ast[] = [];
  for (const sample of samples) {
    if (sample.length > NAMED_FUNCTION_LIMITS.bodyLength) return limit;
    const parsed = parse(sample);
    if ('error' in parsed) return parsed.error.messageKey === 'formula.syntax.depth' ? limit : parsed;
    args.push(parsed.ast);
  }
  // Resolution walks arguments recursively before expansion can enforce its limits.
  const pending = args.map((ast) => ({ ast, depth: 1 }));
  let nodes = 1;
  while (pending.length) {
    const { ast, depth } = pending.pop()!;
    if (++nodes > NAMED_FUNCTION_LIMITS.expandedNodes || depth > NAMED_FUNCTION_LIMITS.depth) return limit;
    const children =
      ast.kind === 'call'
        ? ast.args
        : ast.kind === 'binary'
          ? [ast.left, ast.right]
          : ast.kind === 'unary'
            ? [ast.operand]
            : [];
    for (const child of children) pending.push({ ast: child, depth: depth + 1 });
  }
  const resolved = resolve(
    { kind: 'call', name: definition.name.toUpperCase(), args, start: 0, end: definition.name.length },
    [],
    undefined,
    undefined,
    registry,
  );
  if ('error' in resolved) return resolved;
  const checked = check(resolved.ast, new Map());
  if ('error' in checked) return checked;
  const value = evaluate(
    resolved.ast,
    { id: '', values: {}, createdAt: '', updatedAt: '' },
    { now: new Date(), timeZone },
  );
  return isError(value) ? { error: value } : { value };
}
