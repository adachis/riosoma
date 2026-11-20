import type { NoSqlKind, SearchSourceKind } from '@riosoma/contracts';
import type { Predicate, DocumentOrder } from '../nosql/query.js';
import type { Predicate as SearchPredicate, SearchOrder } from '../http-engines/search.js';
import { ConnectorError } from '../types.js';
import type { Dialect } from '../values.js';

/**
 * One piece of a live read's request.  A search engine carries a typed predicate or sort, which
 * each engine writes in its own syntax.  SQL carries text, with the values people typed kept apart
 * until the statement is written for its dialect.  PostgreSQL and MySQL get them as parameters.
 * SQL Server gets them as Unicode literals, since a page of composite keys can pass its driver's
 * parameter limit, and T-SQL literals have no escape but a doubled quote.
 */
export interface Fragment {
  readonly document?: Predicate;
  readonly documentOrder?: DocumentOrder;
  readonly native?: SearchPredicate;
  readonly nativeOrder?: SearchOrder;
  readonly parts: ReadonlyArray<string | { value: string }>;
}

export const text = (sql: string): Fragment => ({ parts: [sql] });
export const value = (input: string): Fragment => ({ parts: [{ value: input }] });

/** SQL from a template whose substitutions are fragments. */
export function sqlf(strings: TemplateStringsArray, ...fragments: Fragment[]): Fragment {
  const parts: Array<string | { value: string }> = [];
  strings.forEach((piece, index) => {
    if (piece) parts.push(piece);
    const fragment = fragments[index];
    if (fragment) parts.push(...fragment.parts);
  });
  return { parts };
}

export function joined(fragments: readonly Fragment[], separator: string): Fragment {
  const parts: Array<string | { value: string }> = [];
  fragments.forEach((fragment, index) => {
    if (index) parts.push(separator);
    parts.push(...fragment.parts);
  });
  return { parts };
}

/**
 * A number as a plain decimal literal, so every dialect reads it as an exact number rather than a
 * floating-point one.  Only numbers too large or too small for that keep an exponent.
 */
export function numberLiteral(input: number): Fragment {
  if (!Number.isFinite(input)) throw new ConnectorError('sources.sync.read');
  const plain = input.toString();
  if (!/e/i.test(plain)) return text(plain.startsWith('-') ? `(${plain})` : plain);
  const [mantissa, exponentText] = plain.toLowerCase().split('e') as [string, string];
  const exponent = Number(exponentText);
  if (exponent > 30 || exponent < -30) return text(`(${plain.toUpperCase()})`);
  const negative = mantissa.startsWith('-');
  const digits = mantissa.replace('-', '');
  const [whole, fraction = ''] = digits.split('.') as [string, string?];
  const all = whole + fraction;
  const point = whole.length + exponent;
  const decimal =
    point <= 0
      ? `0.${'0'.repeat(-point)}${all}`
      : point >= all.length
        ? all + '0'.repeat(point - all.length)
        : `${all.slice(0, point)}.${all.slice(point)}`;
  return text(negative ? `(-${decimal})` : decimal);
}

export interface Rendered {
  text: string;
  params: string[];
}

/**
 * Every way a live read can write a request.  A SQL dialect quotes and parameterizes the text.
 * The document stores and search engines carry a typed expression instead, which this renders as
 * the JSON a caller logs or digests.
 */
export type FragmentDialect = Dialect | NoSqlKind | SearchSourceKind;

export function render(fragment: Fragment, dialect: FragmentDialect): Rendered {
  if (fragment.document || fragment.documentOrder)
    return { text: JSON.stringify(fragment.document ?? fragment.documentOrder), params: [] };
  if (fragment.native || fragment.nativeOrder)
    return { text: JSON.stringify(fragment.native ?? fragment.nativeOrder), params: [] };
  const params: string[] = [];
  let out = '';
  for (const part of fragment.parts) {
    if (typeof part === 'string') out += part;
    else if (dialect === 'sqlserver' || dialect === 'athena') {
      if (part.value.includes('\0')) throw new ConnectorError('sources.sync.read');
      out += `${dialect === 'sqlserver' ? 'N' : ''}'${part.value.replaceAll("'", "''")}'`;
    } else {
      params.push(part.value);
      out += dialect === 'postgres' || dialect === 'redshift' ? `$${params.length}` : '?';
    }
  }
  return { text: out, params };
}
