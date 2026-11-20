import type { SourceObjectRef, SourceSelect } from '@riosoma/contracts';
import { ConnectorError } from '../types.js';
import { KEYS } from './errors.js';

/**
 * How one warehouse writes SQL: how a name is quoted so it can never be read as anything but a
 * name, and the parts of its grammar the query guard must read the way the warehouse does, so an
 * admin's query can't hide a second statement from it.
 */
export interface Dialect {
  /** Writes a name so the warehouse reads it exactly as given, case and all */
  quote(name: string): string;
  /** Characters that open a string or a quoted name.  The same one closes it, and a doubled one stands for itself */
  quotes: readonly string[];
  /** What starts a comment that runs to the end of its line */
  lineComments: readonly string[];
  /** Dollar-quoted strings: only `$$`, or tagged ones like `$body$` too */
  dollarQuotes?: 'bare' | 'tagged';
  /** Openings the guard refuses rather than follow, like triple-quoted strings */
  refused?: readonly string[];
}

/** Quoting that doubles the quote character inside a name. */
function doubling(mark: string): (name: string) => string {
  return (name) => mark + name.replaceAll(mark, mark + mark) + mark;
}

/**
 * BigQuery reads escapes inside a quoted name the way it reads them inside a string, so a backtick
 * or a backslash is escaped with a backslash, and a control character by its code.
 */
function backslashing(name: string): string {
  let quoted = '`';
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '\\' || character === '`') quoted += `\\${character}`;
    else if (code < 0x20 || code === 0x7f) quoted += `\\u${code.toString(16).padStart(4, '0')}`;
    else quoted += character;
  }
  return `${quoted}\``;
}

export const SNOWFLAKE: Dialect = {
  quote: doubling('"'),
  quotes: ["'", '"'],
  lineComments: ['--', '//'],
  dollarQuotes: 'bare',
};

export const BIGQUERY: Dialect = {
  quote: backslashing,
  quotes: ["'", '"', '`'],
  lineComments: ['--', '#'],
  refused: ["'''", '"""'],
};

export const DATABRICKS: Dialect = {
  quote: doubling('`'),
  quotes: ["'", '"', '`'],
  lineComments: ['--'],
  refused: ["'''", '"""'],
};

export const DUCKDB: Dialect = {
  quote: doubling('"'),
  quotes: ["'", '"'],
  lineComments: ['--'],
  dollarQuotes: 'tagged',
};

/**
 * ClickHouse reads a backslash inside a quoted name as an escape, the way it reads one in a string,
 * so a backslash in a name gets another, and a backtick doubles.  Its heredocs (`$tag$…$tag$`)
 * read like tagged dollar quotes, and `#` starts a comment the way MySQL's does.
 */
export const CLICKHOUSE: Dialect = {
  quote: (name) => `\`${name.replaceAll('\\', '\\\\').replaceAll('`', '``')}\``,
  quotes: ["'", '"', '`'],
  lineComments: ['--', '#'],
  dollarQuotes: 'tagged',
};

export const TRINO: Dialect = {
  quote: doubling('"'),
  quotes: ["'", '"'],
  lineComments: ['--'],
};

/** Druid's SQL layer reads `//` as a comment to the end of the line, as well as `--`. */
export const DRUID: Dialect = {
  quote: doubling('"'),
  quotes: ["'", '"'],
  lineComments: ['--', '//'],
};

/** A string literal for engines whose strings take no backslash escapes: quotes double, and that's all. */
export function literal(value: string): string {
  if (value.includes('\0')) throw new ConnectorError(KEYS.read, 'a name holds a NUL character');
  return `'${value.replaceAll("'", "''")}'`;
}

function refusal(reason: string): ConnectorError {
  return new ConnectorError(KEYS.read, `the query guard refused this query: ${reason}`);
}

const NAME_CHARACTER = /[\p{L}\p{N}_$]/u;

/**
 * An admin's query as a derived table, or a refusal.  Like the SQL connectors' guard, it keeps the
 * query inside its parentheses: no second statement, no unbalanced parenthesis, and no string or
 * comment the warehouse would end somewhere the guard doesn't.  Where the warehouses differ or a
 * setting could change the reading (nested comments, backslash escapes), the guard refuses instead
 * of guessing.  One trailing semicolon goes, since that's how people paste a query.
 */
export function guard(sql: string, dialect: Dialect): string {
  const text = sql.trim().replace(/;\s*$/, '').trimEnd();
  if (text.length === 0) throw refusal('it is empty');
  if (text.includes('\0')) throw refusal('it holds a NUL character');
  for (const opening of dialect.refused ?? [])
    if (text.includes(opening)) throw refusal(`the guard doesn't read ${opening} quoting`);
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const character = text[i]!;
    if (character === ';') throw refusal('it holds more than one statement');
    if (dialect.lineComments.some((start) => text.startsWith(start, i))) {
      const end = text.slice(i).search(/[\r\n]/);
      if (end < 0) break;
      i += end;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw refusal('a comment never ends');
      // Some warehouses nest comments and some don't, so a nested one can't be read safely.
      if (text.slice(i + 2, end).includes('/*')) throw refusal('it nests comments');
      i = end + 1;
      continue;
    }
    if (dialect.quotes.includes(character)) {
      let closed = false;
      for (i++; i < text.length; i++) {
        // Backslash escapes depend on the warehouse and its settings, so the guard won't guess.
        if (text[i] === '\\') throw refusal('it uses a backslash inside quotes');
        if (text[i] === character) {
          if (text[i + 1] === character) i++;
          else {
            closed = true;
            break;
          }
        }
      }
      if (!closed) throw refusal('a quote never ends');
      continue;
    }
    // A `$` inside a name is part of the name, not the start of a string.
    if (character === '$' && dialect.dollarQuotes && !NAME_CHARACTER.test(text[i - 1] ?? '')) {
      const tag =
        dialect.dollarQuotes === 'tagged'
          ? /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i))?.[0]
          : text.startsWith('$$', i)
            ? '$$'
            : undefined;
      if (tag !== undefined) {
        const end = text.indexOf(tag, i + tag.length);
        if (end < 0) throw refusal('a dollar-quoted string never ends');
        i = end + tag.length - 1;
        continue;
      }
    }
    if (character === '(') depth++;
    else if (character === ')' && --depth < 0) throw refusal("its parentheses don't balance");
  }
  if (depth !== 0) throw refusal("its parentheses don't balance");
  return `(\n${text}\n) AS q`;
}

/** A qualified name, each part quoted on its own. */
export function quotePath(parts: readonly string[], dialect: Dialect): string {
  return parts.map((part) => dialect.quote(part)).join('.');
}

/** Where a select reads from: a quoted name for a table or view, or the guarded query. */
function fromSql(
  select: SourceSelect,
  dialect: Dialect,
  path: (object: SourceObjectRef) => readonly string[],
): string {
  return select.kind === 'object' ? quotePath(path(select.object), dialect) : guard(select.sql, dialect);
}

/** The chosen columns of a select, each quoted, with a limit for previews. */
export function selectSql(
  select: SourceSelect,
  columns: readonly string[],
  dialect: Dialect,
  path: (object: SourceObjectRef) => readonly string[],
  limit?: number,
): string {
  const projection = columns.length > 0 ? columns.map((name) => dialect.quote(name)).join(', ') : '*';
  const from = fromSql(select, dialect, path);
  return `SELECT ${projection} FROM ${from}${limit === undefined ? '' : ` LIMIT ${limit}`}`;
}
