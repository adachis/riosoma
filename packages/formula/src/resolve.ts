import {
  diagnostic,
  fieldList,
  fieldType,
  type Ast,
  type Fields,
  type FormulaError,
  type Result,
} from './ast.js';
import type { NamedFunctionDefinition } from '@riosoma/contracts';
import { prepareNamedFunctions } from './named-functions.js';

export function resolve(
  ast: Ast,
  fields: Fields,
  selfId?: string,
  tableId?: string,
  functions?: readonly NamedFunctionDefinition[],
): Result<{ ast: Ast }> {
  const registry = functions === undefined ? undefined : prepareNamedFunctions(functions);
  if (registry && 'error' in registry) return registry;
  const list = fieldList(fields);
  const byId = new Map(list.map((f) => [f.id, f]));
  const byName = new Map<string, (typeof list)[number][]>();
  for (const field of list) {
    const key = field.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), field]);
  }
  let error: FormulaError | undefined;
  const walk = (node: Ast): Ast => {
    switch (node.kind) {
      case 'field': {
        const candidates = (
          node.fieldId
            ? [byId.get(node.fieldId)].filter((f) => f !== undefined)
            : (byName.get(node.name.toLowerCase()) ?? [])
        ).filter((field) =>
          node.tableName !== undefined
            ? node.tableId
              ? field.tableId === node.tableId
              : field.tableId === node.tableName ||
                field.tableName?.toLowerCase() === node.tableName.toLowerCase()
            : !tableId || !field.tableId || field.tableId === tableId,
        );
        const field = candidates[0];
        const key = !field
          ? 'formula.field.unknown'
          : candidates.length > 1
            ? 'formula.field.ambiguous'
            : field.id === selfId
              ? 'formula.field.circular'
              : null;
        if (key) {
          error ??= diagnostic(node, key, { name: node.name });
          return node;
        }
        return {
          ...node,
          ...(node.tableName !== undefined ? { tableId: field!.tableId } : {}),
          fieldId: field!.id,
          fieldType: field!.type,
          valueType: fieldType(field!),
        };
      }
      case 'unary':
        return { ...node, operand: walk(node.operand) };
      case 'binary':
        return { ...node, left: walk(node.left), right: walk(node.right) };
      case 'call':
        return { ...node, args: node.args.map(walk) };
      default:
        return node;
    }
  };
  const resolved = walk(ast);
  return error ? { error } : registry ? registry.expand(resolved) : { ast: resolved };
}

export function references(ast: Ast): string[] {
  const ids = new Set<string>();
  const walk = (node: Ast): void => {
    if (node.kind === 'field' && node.fieldId) ids.add(node.fieldId);
    if (node.kind === 'unary') walk(node.operand);
    if (node.kind === 'binary') {
      walk(node.left);
      walk(node.right);
    }
    if (node.kind === 'call') node.args.forEach(walk);
  };
  walk(ast);
  return [...ids];
}

export function describe(ast: Ast, fields: Fields): string {
  const names = new Map(fieldList(fields).map((f) => [f.id, f.name]));
  const tables = new Map(fieldList(fields).map((f) => [f.tableId, f.tableName ?? f.tableId]));
  const walk = (node: Ast): string => {
    switch (node.kind) {
      case 'literal':
        return typeof node.value === 'boolean'
          ? node.value
            ? 'TRUE()'
            : 'FALSE()'
          : JSON.stringify(node.value);
      case 'field':
        if (node.tableName !== undefined) {
          const table = tables.get(node.tableId) ?? node.tableName;
          const name = names.get(node.fieldId ?? '') ?? node.name;
          const quoted = /^[A-Za-z_][A-Za-z_0-9]*$/.test(table)
            ? table
            : `'${table.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
          return `${quoted}[${name.replaceAll('\\', '\\\\').replaceAll(']', '\\]')}]`;
        }
        return `{${(names.get(node.fieldId ?? '') ?? node.name).replaceAll('\\', '\\\\').replaceAll('}', '\\}')}}`;
      case 'unary':
        return `(-${walk(node.operand)})`;
      case 'binary':
        return `(${walk(node.left)} ${node.operator} ${walk(node.right)})`;
      case 'call':
        return `${node.name}(${node.args.map(walk).join(', ')})`;
    }
  };
  return walk(ast);
}

/** Whether a result needs a complete readable table instead of one cached page. */
export function readsRecords(ast: Ast): boolean {
  if (ast.kind === 'field') return ast.tableName !== undefined;
  if (ast.kind === 'call')
    return (
      ['RANK', 'PREVIOUS', 'NEXT', 'RUNNINGSUM', 'RUNNINGCOUNT'].includes(ast.name) ||
      ast.args.some(readsRecords)
    );
  if (ast.kind === 'binary') return readsRecords(ast.left) || readsRecords(ast.right);
  return ast.kind === 'unary' && readsRecords(ast.operand);
}
