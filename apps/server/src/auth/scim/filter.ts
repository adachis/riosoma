import { join, sql, type Sql } from '@riosoma/db';
import { booleanOf, invalidFilter, storable } from './errors.js';

type Operator = 'eq' | 'co' | 'sw' | 'pr';
type Scalar = string | boolean | null;
/** A multi-valued attribute whose values a bracketed filter can select */
export type ValueParent = 'emails' | 'members';
export type Filter =
  | { kind: 'comparison'; path: string; operator: Operator; value: Scalar; exact: boolean }
  | { kind: 'and' | 'or'; left: Filter; right: Filter }
  | { kind: 'valuePath'; path: ValueParent; filter: Filter };

const RESOURCE_PATHS = new Set(['username', 'externalid', 'displayname', 'active', 'id']);
const VALUE_PATHS: Record<ValueParent, Set<string>> = {
  emails: new Set(['value', 'type', 'primary', 'display']),
  members: new Set(['value', 'type', 'display']),
};
const BOOLEAN_PATHS = new Set(['active', 'primary']);

function isParent(path: string): path is ValueParent {
  return path === 'emails' || path === 'members';
}

/**
 * Bounded recursive descent keeps quoted values separate from operators and SQL.  Without a
 * parent it reads a resource filter, where `emails[type eq "work"]` and
 * `emails[type eq "work"].value eq "x"` select values of a multi-valued attribute.  With one it
 * reads the filter inside such brackets, as a PATCH path has.
 */
export function parseFilter(source: string, parent?: ValueParent): Filter {
  if (!source || source.length > 4096 || !storable(source)) invalidFilter();
  const tokens: string[] = [];
  const pattern =
    /\s*("(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[()[\]]|\.[A-Za-z][A-Za-z0-9]*|[A-Za-z][A-Za-z0-9_.:-]*)/y;
  let offset = 0;
  while (offset < source.length) {
    if (!source.slice(offset).trim()) break;
    pattern.lastIndex = offset;
    const match = pattern.exec(source);
    if (!match || tokens.length >= 256) invalidFilter();
    tokens.push(match[1]!);
    offset = pattern.lastIndex;
  }
  let position = 0;
  const peek = () => tokens[position]?.toLowerCase();
  const take = () => tokens[position++] ?? invalidFilter();

  function comparison(path: string, scope: ValueParent | undefined): Filter {
    if (!(scope ? VALUE_PATHS[scope] : RESOURCE_PATHS).has(path)) invalidFilter();
    const operator = take().toLowerCase();
    if (operator !== 'eq' && operator !== 'co' && operator !== 'sw' && operator !== 'pr') invalidFilter();
    let value: Scalar = null;
    if (operator !== 'pr') {
      const token = take();
      if (token.startsWith('"')) {
        let text: unknown;
        try {
          text = JSON.parse(token);
        } catch {
          invalidFilter();
        }
        if (typeof text !== 'string' || !storable(text)) invalidFilter();
        value = text;
      } else if (token.toLowerCase() === 'true') value = true;
      else if (token.toLowerCase() === 'false') value = false;
      else if (token.toLowerCase() !== 'null') invalidFilter();
      if (BOOLEAN_PATHS.has(path)) {
        // Entra quotes its booleans, so "True" and "False" read as booleans here too.
        if (value !== null) value = booleanOf(value) ?? invalidFilter();
        if (operator !== 'eq') invalidFilter();
      } else if (value !== null && typeof value !== 'string') invalidFilter();
      if ((operator === 'co' || operator === 'sw') && typeof value !== 'string') invalidFilter();
    }
    // Identifiers compare exactly.  Names, addresses, and types ignore case.
    const exact = scope === 'members' ? path === 'value' : !scope && (path === 'externalid' || path === 'id');
    return { kind: 'comparison', path, operator, value, exact };
  }
  function atom(depth: number, scope: ValueParent | undefined): Filter {
    if (depth > 16) invalidFilter();
    if (peek() === '(') {
      take();
      const result = expression(depth + 1, scope);
      if (take() !== ')') invalidFilter();
      return result;
    }
    const name = take();
    if (!/^[A-Za-z]/.test(name)) invalidFilter();
    const path = name.toLowerCase();
    if (peek() === '[') {
      if (scope || !isParent(path)) invalidFilter();
      take();
      const inner = expression(depth + 1, path);
      if (take() !== ']') invalidFilter();
      const sub = peek();
      if (!sub?.startsWith('.')) return { kind: 'valuePath', path, filter: inner };
      take();
      return {
        kind: 'valuePath',
        path,
        filter: { kind: 'and', left: inner, right: comparison(sub.slice(1), path) },
      };
    }
    if (!scope && path === 'emails.value')
      return { kind: 'valuePath', path: 'emails', filter: comparison('value', 'emails') };
    return comparison(path, scope);
  }
  function conjunction(depth: number, scope: ValueParent | undefined): Filter {
    let left = atom(depth, scope);
    while (peek() === 'and') {
      take();
      left = { kind: 'and', left, right: atom(depth, scope) };
    }
    return left;
  }
  function expression(depth: number, scope: ValueParent | undefined): Filter {
    let left = conjunction(depth, scope);
    while (peek() === 'or') {
      take();
      left = { kind: 'or', left, right: conjunction(depth, scope) };
    }
    return left;
  }
  const result = expression(0, parent);
  if (position !== tokens.length) invalidFilter();
  return result;
}

const KEYS: Record<string, string> = {
  username: 'userName',
  externalid: 'externalId',
  displayname: 'displayName',
};

/** SCIM attribute names ignore case, including names inside value filters. */
export function attribute(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const key = Object.keys(value).find((key) => key.toLowerCase() === name.toLowerCase());
  return key ? (value as Record<string, unknown>)[key] : undefined;
}

export function matches(filter: Filter, resource: unknown): boolean {
  if (filter.kind === 'valuePath') {
    const values = attribute(resource, filter.path);
    return Array.isArray(values) && values.some((entry) => matches(filter.filter, entry));
  }
  if (filter.kind !== 'comparison')
    return filter.kind === 'and'
      ? matches(filter.left, resource) && matches(filter.right, resource)
      : matches(filter.left, resource) || matches(filter.right, resource);
  const actual = attribute(resource, filter.path);
  if (filter.operator === 'pr') return actual !== undefined && actual !== null && actual !== '';
  if (filter.value === null) return actual === undefined || actual === null;
  if (typeof filter.value === 'boolean') return booleanOf(actual) === filter.value;
  if (typeof actual !== 'string') return false;
  const left = filter.exact ? actual : actual.toLowerCase();
  const right = filter.exact ? filter.value : filter.value.toLowerCase();
  return filter.operator === 'eq'
    ? left === right
    : filter.operator === 'co'
      ? left.includes(right)
      : left.startsWith(right);
}

/** Only the fixed attribute allowlist reaches SQL structure, and all client values are parameters. */
export function filterSql(filter: Filter, document: Sql): Sql {
  if (filter.kind === 'valuePath') {
    // Brackets never nest, so one alias serves every value path.
    return sql`EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(${document}->${filter.path}, '[]'::jsonb)) AS scim_value(value)
      WHERE ${filterSql(filter.filter, sql`scim_value.value`)})`;
  }
  if (filter.kind !== 'comparison') {
    return sql`(${join([filterSql(filter.left, document), filterSql(filter.right, document)], filter.kind === 'and' ? ' AND ' : ' OR ')})`;
  }
  const field = sql`${document}->>${KEYS[filter.path] ?? filter.path}`;
  if (filter.operator === 'pr') return sql`(${field} IS NOT NULL AND ${field} <> '')`;
  if (filter.value === null) return sql`${field} IS NULL`;
  const left = filter.exact ? field : sql`lower(${field})`;
  const right = filter.exact ? String(filter.value) : String(filter.value).toLowerCase();
  if (filter.operator === 'eq') return sql`${left} = ${right}`;
  if (filter.operator === 'co') return sql`strpos(${left}, ${right}) > 0`;
  return sql`left(${left}, length(${right})) = ${right}`;
}
