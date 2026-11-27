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
const STOP_AFTER_ORDER = new Set(['LIMIT', 'OFFSET', 'FETCH', 'FOR', 'SETTINGS', 'FORMAT', 'INTO']);
const SET_OPERATORS = new Set(['UNION', 'INTERSECT', 'EXCEPT']);
const LITERAL_KEYWORDS = new Set(['NULL', 'TRUE', 'FALSE']);

interface ScannedSql {
  text: string;
  orderStart: number | undefined;
  clauseStart: number | undefined;
  suffixStart: number | undefined;
  endsWithLineComment: boolean;
}

function scanSql(sql: string, dialect: Dialect): ScannedSql {
  const text = sql.trim().replace(/;\s*$/, '').trimEnd();
  if (text.length === 0) throw refusal('it is empty');
  if (text.includes('\0')) throw refusal('it holds a NUL character');
  for (const opening of dialect.refused ?? [])
    if (text.includes(opening)) throw refusal(`the guard doesn't read ${opening} quoting`);
  let depth = 0;
  let pendingOrder: number | undefined;
  let orderStart: number | undefined;
  let clauseStart: number | undefined;
  let suffixStart: number | undefined;
  let endsWithLineComment = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i]!;
    if (character === ';') throw refusal('it holds more than one statement');
    if (dialect.lineComments.some((start) => text.startsWith(start, i))) {
      const end = text.slice(i).search(/[\r\n]/);
      if (end < 0) {
        endsWithLineComment = true;
        break;
      }
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
      pendingOrder = undefined;
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
        pendingOrder = undefined;
        const end = text.indexOf(tag, i + tag.length);
        if (end < 0) throw refusal('a dollar-quoted string never ends');
        i = end + tag.length - 1;
        continue;
      }
    }
    if (character === '(') {
      pendingOrder = undefined;
      depth++;
      continue;
    }
    if (character === ')') {
      pendingOrder = undefined;
      if (--depth < 0) throw refusal("its parentheses don't balance");
      continue;
    }
    if (
      depth === 0 &&
      /[A-Za-z_]/.test(character) &&
      !NAME_CHARACTER.test(text[i - 1] ?? '') &&
      text[i - 1] !== '.'
    ) {
      let end = i + 1;
      while (end < text.length && /[A-Za-z0-9_$]/.test(text[end]!)) end++;
      const word = text.slice(i, end).toUpperCase();
      if (word === 'ORDER') pendingOrder = i;
      else if (word === 'BY' && pendingOrder !== undefined) {
        orderStart = pendingOrder;
        clauseStart = end;
        suffixStart = undefined;
        pendingOrder = undefined;
      } else {
        pendingOrder = undefined;
        if (SET_OPERATORS.has(word)) {
          // Any earlier ORDER BY belonged to a branch before the set operator, not the whole query.
          orderStart = undefined;
          clauseStart = undefined;
          suffixStart = undefined;
        } else if (orderStart !== undefined && suffixStart === undefined && STOP_AFTER_ORDER.has(word)) {
          suffixStart = i;
        }
      }
      i = end - 1;
    } else if (!/\s/.test(character)) {
      pendingOrder = undefined;
    }
  }
  if (depth !== 0) throw refusal("its parentheses don't balance");
  return { text, orderStart, clauseStart, suffixStart, endsWithLineComment };
}

function unquoteColumn(expr: string, dialect: Dialect): string | null {
  if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(expr)) return LITERAL_KEYWORDS.has(expr.toUpperCase()) ? null : expr;
  if (dialect.quotes.includes('"') && /^"(?:[^"]|"")+"$/.test(expr))
    return expr.slice(1, -1).replaceAll('""', '"');
  if (dialect.quotes.includes('`') && /^`(?:[^`]|``)+`$/.test(expr))
    return expr.slice(1, -1).replaceAll('``', '`');
  return null;
}

function stripTrailingComments(clause: string, dialect: Dialect): string {
  let out = '';
  for (let i = 0; i < clause.length; i++) {
    const ch = clause[i]!;
    if (dialect.lineComments.some((start) => clause.startsWith(start, i))) {
      const end = clause.slice(i).search(/[\r\n]/);
      if (end < 0) break;
      out += ' ';
      i += end;
      continue;
    }
    if (clause.startsWith('/*', i)) {
      const end = clause.indexOf('*/', i + 2);
      out += ' ';
      i = end + 1;
      continue;
    }
    if (dialect.quotes.includes(ch)) {
      const start = i;
      for (i++; i < clause.length; i++) {
        if (clause[i] === ch) {
          if (clause[i + 1] === ch) i++;
          else break;
        }
      }
      out += clause.slice(start, i + 1);
      continue;
    }
    out += ch;
  }
  return out.trim();
}

function parseOrderItems(
  clause: string,
  dialect: Dialect,
  columns?: readonly string[],
): Array<{ expr: string; suffix: string }> | null {
  const clean = stripTrailingComments(clause, dialect);
  if (!clean) return null;
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (dialect.quotes.includes(ch)) {
      for (i++; i < clean.length; i++) {
        if (clean[i] === ch) {
          if (clean[i + 1] === ch) i++;
          else break;
        }
      }
      continue;
    }
    if (ch === '(' || ch === ')') return null;
    if (ch === ',') {
      parts.push(clean.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(clean.slice(start).trim());
  const exact = columns ? new Set(columns) : null;
  const items: Array<{ expr: string; suffix: string }> = [];
  for (const part of parts) {
    if (!part) return null;
    let rest = part;
    let suffix = '';
    const nulls = /\s+NULLS\s+(?:FIRST|LAST)$/i.exec(rest);
    if (nulls) {
      suffix = nulls[0].replace(/\s+/g, ' ').toUpperCase() + suffix;
      rest = rest.slice(0, nulls.index).trimEnd();
    }
    const dir = /\s+(?:ASC|DESC)$/i.exec(rest);
    if (dir) {
      suffix = dir[0].replace(/\s+/g, ' ').toUpperCase() + suffix;
      rest = rest.slice(0, dir.index).trimEnd();
    }
    const name = unquoteColumn(rest, dialect);
    if (!name) return null;
    if (exact) {
      const quoted = rest.startsWith('"') || rest.startsWith('`');
      const known = quoted
        ? exact.has(name)
        : exact.has(name) || exact.has(name.toLowerCase()) || exact.has(name.toUpperCase());
      if (!known) return null;
    }
    items.push({ expr: rest, suffix });
  }
  return items.length ? items : null;
}

/**
 * An admin's query as a derived table, or a refusal.  Like the SQL connectors' guard, it keeps the
 * query inside its parentheses: no second statement, no unbalanced parenthesis, and no string or
 * comment the warehouse would end somewhere the guard doesn't.  Where the warehouses differ or a
 * setting could change the reading (nested comments, backslash escapes), the guard refuses instead
 * of guessing.  One trailing semicolon goes, since that's how people paste a query.
 */
export function guard(sql: string, dialect: Dialect): string {
  return `(\n${scanSql(sql, dialect).text}\n) AS q`;
}

/**
 * Wraps a query with an outer projection and optional limit while keeping top-level `ORDER BY`
 * where the engine honors it.  Simple column sorts move to the outer `ORDER BY`, and any other
 * top-level `ORDER BY` stays paired with an inner `LIMIT` when a limit is given.
 */
export function guardedSelect(
  sql: string,
  projection: string,
  dialect: Dialect,
  options: {
    limit?: number;
    columns?: readonly string[];
    qualifyOrder?: boolean;
    where?: string;
    defaultOrder?: string;
  } = {},
): string {
  const scanned = scanSql(sql, dialect);
  const wherePart = options.where ? ` WHERE ${options.where}` : '';
  const limitPart = options.limit === undefined ? '' : ` LIMIT ${options.limit}`;
  if (scanned.orderStart !== undefined && scanned.clauseStart !== undefined) {
    const body = scanned.text.slice(0, scanned.orderStart).trimEnd();
    const clause = scanned.text.slice(scanned.clauseStart, scanned.suffixStart).trim();
    const items = body ? parseOrderItems(clause, dialect, options.columns) : null;
    if (items) {
      const orderSql = items
        .map((item) => `${options.qualifyOrder ? 'q.' : ''}${item.expr}${item.suffix}`)
        .join(', ');
      const inner = scanned.suffixStart === undefined ? body : scanned.text;
      return `SELECT ${projection} FROM (\n${inner}\n) AS q${wherePart} ORDER BY ${orderSql}${limitPart}`;
    }
    if (scanned.suffixStart === undefined && options.limit !== undefined && !options.where) {
      const separator = scanned.endsWithLineComment ? '\n' : ' ';
      return `SELECT ${projection} FROM (\n${scanned.text}${separator}LIMIT ${options.limit}\n) AS q`;
    }
  }
  // A caller's default order is its paging key, so it holds even over the query's own order.
  const orderPart = options.defaultOrder ? ` ORDER BY ${options.defaultOrder}` : '';
  return `SELECT ${projection} FROM (\n${scanned.text}\n) AS q${wherePart}${orderPart}${limitPart}`;
}

/** A qualified name, each part quoted on its own. */
export function quotePath(parts: readonly string[], dialect: Dialect): string {
  return parts.map((part) => dialect.quote(part)).join('.');
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
  if (select.kind === 'object') {
    const from = quotePath(path(select.object), dialect);
    return `SELECT ${projection} FROM ${from}${limit === undefined ? '' : ` LIMIT ${limit}`}`;
  }
  return guardedSelect(select.sql, projection, dialect, { limit, columns });
}
