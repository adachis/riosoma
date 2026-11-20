import type pg from 'pg';

/**
 * Parameterized SQL from template literals.  Interpolated values become `$n` parameters,
 * `ident()` inserts a checked and quoted identifier, `keyword()` inserts one of a fixed set of
 * keywords, and nested `sql` fragments merge with their parameters renumbered.  Nothing else can
 * put text into a query, so a value can never become SQL.
 *
 *     const t = ident(schemas.data, table.id);
 *     await query(db, sql`SELECT __id FROM ${t} WHERE ${ident(field.id)} = ${value}`);
 */
export class Sql {
  /** @internal */
  constructor(
    readonly strings: readonly string[],
    readonly values: readonly unknown[],
  ) {}
}

class Identifier {
  constructor(readonly text: string) {}
}

class Keyword {
  constructor(readonly text: string) {}
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** A quoted identifier, or a dotted path of them: `ident('rio_data', 'tblX')` → `"rio_data"."tblX"`. */
export function ident(...parts: string[]): Identifier {
  if (parts.length === 0) throw new Error('ident() needs at least one name');
  for (const p of parts) {
    if (!IDENTIFIER.test(p)) throw new Error(`Refusing unsafe SQL identifier: ${JSON.stringify(p)}`);
  }
  return new Identifier(parts.map((p) => `"${p}"`).join('.'));
}

const KEYWORDS = [
  'ASC',
  'DESC',
  'NULLS FIRST',
  'NULLS LAST',
  'AND',
  'OR',
  'NOT',
  'TRUE',
  'FALSE',
  'NULL',
  'DEFAULT',
] as const;
export type SqlKeyword = (typeof KEYWORDS)[number];

export function keyword(word: SqlKeyword): Keyword {
  if (!(KEYWORDS as readonly string[]).includes(word)) throw new Error(`Not an allowed keyword: ${word}`);
  return new Keyword(word);
}

export function sql(strings: TemplateStringsArray, ...values: unknown[]): Sql {
  return new Sql([...strings], values);
}

/** Fragments joined with a separator, e.g. `join(conditions, ' AND ')`. */
export function join(parts: readonly Sql[], separator: ', ' | ' AND ' | ' OR ' | ' '): Sql {
  if (parts.length === 0) return sql``;
  const strings: string[] = [''];
  const values: unknown[] = [];
  parts.forEach((part, i) => {
    if (i > 0) strings[strings.length - 1] += separator;
    values.push(part);
    strings.push('');
  });
  return new Sql(strings, values);
}

/** An empty fragment, for optional clauses. */
export const EMPTY = sql``;

/** Turns a fragment into text with `$1…$n` placeholders and its parameter list. */
export function compile(query: Sql): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const walk = (q: Sql): string => {
    let text = q.strings[0] ?? '';
    q.values.forEach((value, i) => {
      if (value instanceof Sql) text += walk(value);
      else if (value instanceof Identifier || value instanceof Keyword) text += value.text;
      else {
        values.push(value);
        text += `$${values.length}`;
      }
      text += q.strings[i + 1] ?? '';
    });
    return text;
  };
  return { text: walk(query), values };
}

export type Queryable = Pick<pg.PoolClient, 'query'>;

export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  db: Queryable,
  q: Sql,
): Promise<pg.QueryResult<R>> {
  const { text, values } = compile(q);
  return db.query<R>(text, values);
}
