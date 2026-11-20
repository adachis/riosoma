import {
  NAMED_FUNCTION_LIMITS,
  NamedFunctionDefinitions,
  type NamedFunctionDefinition,
} from '@riosoma/contracts';
import { diagnostic, type Ast, type FormulaError, type Result, type Span } from './ast.js';
import { FUNCTIONS } from './check.js';
import { parse } from './parser.js';

interface Definition {
  name: string;
  parameters: readonly string[];
  ast: Ast;
}
interface NamedFunctions {
  /** Canonical names for callers that offer function completion. */
  names: readonly string[];
  expand(ast: Ast): Result<{ ast: Ast }>;
}
class InvalidDefinition {
  constructor(readonly error: FormulaError) {}
}
const children = (node: Ast): readonly Ast[] =>
  node.kind === 'call'
    ? node.args
    : node.kind === 'binary'
      ? [node.left, node.right]
      : node.kind === 'unary'
        ? [node.operand]
        : [];

/**
 * Validate the whole database registry, including unused definitions. Bodies can only read their
 * parameters; record fields and table ranges must enter through arguments already resolved by
 * the caller. Expansion preserves lazy branches and gives both execution engines the same AST.
 */
export function prepareNamedFunctions(input: readonly NamedFunctionDefinition[]): Result<NamedFunctions> {
  const definitions = new Map<string, Definition>();
  const reject = (node: Span, key: string, params?: FormulaError['params']): never => {
    throw new InvalidDefinition(diagnostic(node, key, params));
  };
  try {
    const parsedInput = NamedFunctionDefinitions.safeParse(input);
    if (!parsedInput.success) return { error: diagnostic({ start: 0, end: 0 }, 'formula.named.invalid') };
    for (const definition of parsedInput.data) {
      const name = definition.name.toUpperCase();
      const parameters = definition.parameters.map((parameter) => parameter.toUpperCase());
      if (
        FUNCTIONS[name] ||
        definitions.has(name) ||
        new Set(parameters).size !== parameters.length ||
        parameters.some((parameter) => parameter === 'TRUE' || parameter === 'FALSE')
      )
        reject({ start: 0, end: definition.body.length }, 'formula.named.invalid', { name });
      const parsed = parse(definition.body);
      if ('error' in parsed) return { error: { ...parsed.error, params: { ...parsed.error.params, name } } };
      definitions.set(name, { name, parameters, ast: parsed.ast });
    }
    const dependencies = new Map<string, Ast[]>();
    for (const definition of definitions.values()) {
      const calls: Ast[] = [];
      const pending = [definition.ast];
      while (pending.length) {
        const node = pending.pop()!;
        if (
          node.kind === 'field' &&
          (node.tableName !== undefined ||
            node.fieldId ||
            !definition.parameters.includes(node.name.toUpperCase()))
        )
          reject(node, 'formula.named.parameter', { name: node.name });
        if (node.kind === 'call') {
          const target = definitions.get(node.name);
          const signature = target
            ? { min: target.parameters.length, max: target.parameters.length }
            : FUNCTIONS[node.name];
          if (!signature) return reject(node, 'formula.function.unknown', { name: node.name });
          if (node.args.length < signature.min || node.args.length > signature.max)
            reject(node, 'formula.function.arity', {
              name: node.name,
              min: signature.min,
              max: signature.max === Infinity ? -1 : signature.max,
              actual: node.args.length,
            });
          if (target) calls.push(node);
        }
        pending.push(...children(node));
      }
      dependencies.set(definition.name, calls);
    }
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (definition: Definition): void => {
      if (visited.has(definition.name)) return;
      visiting.add(definition.name);
      for (const call of dependencies.get(definition.name)!) {
        if (call.kind !== 'call') continue;
        if (visiting.has(call.name)) reject(call, 'formula.named.circular', { name: call.name });
        visit(definitions.get(call.name)!);
      }
      visiting.delete(definition.name);
      visited.add(definition.name);
    };
    definitions.forEach(visit);
  } catch (error) {
    if (error instanceof InvalidDefinition) return { error: error.error };
    throw error;
  }
  return {
    names: Object.freeze([...definitions.keys()]),
    expand(ast) {
      let nodes = 0;
      // Copy each parameter occurrence so lookup coercion remains local to that occurrence.
      const walk = (node: Ast, depth: number, bindings?: ReadonlyMap<string, Ast>, span?: Span): Ast => {
        if (++nodes > NAMED_FUNCTION_LIMITS.expandedNodes || depth > NAMED_FUNCTION_LIMITS.depth)
          reject(span ?? node, 'formula.runtime.limit');
        if (node.kind === 'field' && bindings) {
          const argument = bindings.get(node.name.toUpperCase());
          if (!argument) return reject(span ?? node, 'formula.named.parameter', { name: node.name });
          return walk(argument, depth + 1);
        }
        const location = span ?? { start: node.start, end: node.end };
        if (node.kind === 'call') {
          const definition = definitions.get(node.name);
          const signature = definition
            ? { min: definition.parameters.length, max: definition.parameters.length }
            : FUNCTIONS[node.name];
          if (!signature) return reject(location, 'formula.function.unknown', { name: node.name });
          if (node.args.length < signature.min || node.args.length > signature.max)
            reject(location, 'formula.function.arity', {
              name: node.name,
              min: signature.min,
              max: signature.max === Infinity ? -1 : signature.max,
              actual: node.args.length,
            });
          const args = node.args.map((arg) => walk(arg, depth + 1, bindings, span));
          if (definition) {
            return walk(
              definition.ast,
              depth + 1,
              new Map(definition.parameters.map((parameter, i) => [parameter, args[i]!])),
              location,
            );
          }
          return { ...node, ...location, args };
        }
        if (node.kind === 'binary')
          return {
            ...node,
            ...location,
            left: walk(node.left, depth + 1, bindings, span),
            right: walk(node.right, depth + 1, bindings, span),
          };
        if (node.kind === 'unary')
          return { ...node, ...location, operand: walk(node.operand, depth + 1, bindings, span) };
        return { ...node, ...location };
      };
      try {
        return { ast: walk(ast, 0) };
      } catch (error) {
        if (error instanceof InvalidDefinition) return { error: error.error };
        throw error;
      }
    },
  };
}
