import type { SourceColumn, SourceObjectRef, SourceSelect } from '@riosoma/contracts';
import { ConnectorError } from './types.js';
import type { SqlDialect } from './values.js';

export function quote(name: string, dialect: SqlDialect): string {
  if (dialect === 'mysql') return '`' + name.replaceAll('`', '``') + '`';
  if (dialect === 'sqlserver') return '[' + name.replaceAll(']', ']]') + ']';
  return '"' + name.replaceAll('"', '""') + '"';
}
export function objectSql(object: SourceObjectRef, dialect: SqlDialect): string {
  return [object.schema, object.name]
    .filter((v): v is string => v !== null)
    .map((v) => quote(v, dialect))
    .join('.');
}

/** Whether a quote at `i` opens an alternative quote like `q'[…]'` or `nq'{…}'`, as Oracle and Firebird read them. */
function alternativeQuote(sql: string, i: number, dialect: SqlDialect): boolean {
  if (dialect !== 'oracle' && dialect !== 'firebird') return false;
  if (!/^[qQ]$/.test(sql[i - 1] ?? '')) return false;
  const before = /^[nN]$/.test(sql[i - 2] ?? '') ? i - 3 : i - 2;
  return !/[A-Za-z0-9_$#]/.test(sql[before] ?? '');
}
const CLOSING: Record<string, string> = { '[': ']', '{': '}', '<': '>', '(': ')' };

/** Keep a supplied query inside its derived table, even on drivers that accept batches. */
export function querySql(sql: string, dialect: SqlDialect, alias = 'q'): string {
  if (sql.includes('\0')) throw new ConnectorError('sources.sync.read');
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === ';' || ch === '\0') throw new ConnectorError('sources.sync.read');
    if (
      (ch === '-' && sql[i + 1] === '-' && (dialect !== 'mysql' || /\s/.test(sql[i + 2] ?? ' '))) ||
      (dialect === 'mysql' && ch === '#')
    ) {
      const end = sql.slice(i).search(/[\r\n]/);
      i = end < 0 ? sql.length : i + end;
    } else if (ch === '/' && sql[i + 1] === '*') {
      // Executable comments can change the statement on compatible servers.
      if (sql[i + 2] === '!' || sql.slice(i + 2, i + 4) === 'M!')
        throw new ConnectorError('sources.sync.read');
      let nesting = 1;
      i += 2;
      for (; i < sql.length && nesting; i++) {
        if (sql.slice(i, i + 2) === '/*') {
          // Only PostgreSQL and SQL Server nest comments, so elsewhere an inner opening is ambiguous.
          if (dialect !== 'postgres' && dialect !== 'redshift' && dialect !== 'sqlserver')
            throw new ConnectorError('sources.sync.read');
          nesting++;
          i++;
        } else if (sql.slice(i, i + 2) === '*/') {
          nesting--;
          i++;
        }
      }
      if (nesting) throw new ConnectorError('sources.sync.read');
      i--;
    } else if (ch === "'" && alternativeQuote(sql, i, dialect)) {
      // The text runs to the delimiter's closing partner followed by a quote, whatever it holds.
      const open = sql[i + 1] ?? '';
      if (!open || /\s/.test(open)) throw new ConnectorError('sources.sync.read');
      const end = sql.indexOf(`${CLOSING[open] ?? open}'`, i + 2);
      if (end < 0) throw new ConnectorError('sources.sync.read');
      i = end + 1;
    } else if (
      ch === "'" ||
      ch === '"' ||
      (dialect === 'mysql' && ch === '`') ||
      (dialect === 'sqlserver' && ch === '[')
    ) {
      const end = ch === '[' ? ']' : ch;
      let closed = false;
      for (i++; i < sql.length; i++) {
        // Reject ambiguous escape syntax instead of depending on session SQL modes.  Oracle and
        // Firebird never read a backslash as an escape, so there it's only a character.
        const identifier = ch === '"' || ch === '[' || ch === '`';
        // PostgreSQL identifiers and SQL Server brackets use doubled delimiters exclusively.
        // MySQL's double quotes depend on SQL mode, so their escapes remain ambiguous.
        const literalBackslash =
          dialect === 'oracle' ||
          dialect === 'firebird' ||
          (identifier &&
            (((dialect === 'postgres' || dialect === 'redshift') && ch === '"') ||
              (dialect === 'sqlserver' && ch === '[') ||
              (dialect === 'mysql' && ch === '`')));
        if (sql[i] === '\\' && !literalBackslash) throw new ConnectorError('sources.sync.read');
        if (sql[i] === end) {
          if (sql[i + 1] === end) i++;
          else {
            closed = true;
            break;
          }
        }
      }
      if (!closed) throw new ConnectorError('sources.sync.read');
    } else if ((dialect === 'postgres' || dialect === 'redshift') && ch === '$') {
      const tag = sql.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$/)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) throw new ConnectorError('sources.sync.read');
        i = end + tag.length - 1;
      }
    } else if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) throw new ConnectorError('sources.sync.read');
  }
  if (depth !== 0) throw new ConnectorError('sources.sync.read');
  // Oracle names a derived table without AS.
  return `(${sql}\n)${dialect === 'oracle' ? '' : ' AS'} ${alias}`;
}
export function fromSql(select: SourceSelect, dialect: SqlDialect): string {
  return select.kind === 'object' ? objectSql(select.object, dialect) : querySql(select.sql, dialect);
}
/** The same, named by `alias` either way, so a live read can qualify every column it names. */
export function aliasedFromSql(select: SourceSelect, dialect: SqlDialect, alias: string): string {
  return select.kind === 'object'
    ? `${objectSql(select.object, dialect)}${dialect === 'oracle' ? '' : ' AS'} ${quote(alias, dialect)}`
    : querySql(select.sql, dialect, quote(alias, dialect));
}
/**
 * How a read selects a column so its value reaches Riosoma exactly: PostgreSQL's money as plain
 * digits, SQL Server's large and exact numbers and times as text, since its driver rounds them, and
 * Oracle's and Firebird's dates and times as text, since their drivers read them in the server
 * process's own time zone.
 */
export function projection(column: SourceColumn, ref: string, dialect: SqlDialect): string {
  const type = column.sourceType.toLowerCase();
  if (dialect === 'redshift' && type === 'geometry') return `ST_AsEWKT(${ref}, 17)`;
  if (dialect === 'redshift' && type === 'super') return `JSON_SERIALIZE(${ref})`;
  if (dialect === 'postgres') return type === 'money' ? `${ref}::numeric::text` : ref;
  if (dialect === 'sqlserver') {
    if (/^(bigint|numeric|decimal|money|smallmoney)/.test(type))
      return `CONVERT(varchar(100), ${ref}${/money/.test(type) ? ', 2' : ''})`;
    if (/^time(?:\(|$)/.test(type)) return `CONVERT(varchar(40), ${ref})`;
  }
  if (dialect === 'oracle') {
    // Keep every declared decimal place, the way the other databases write an exact number.
    const scaled = /^number\(\s*(\d+|\*)\s*,\s*([1-9]\d*)\s*\)$/.exec(type);
    if (scaled) {
      const digits = Number(scaled[2]);
      const whole = Math.max((scaled[1] === '*' ? 38 : Number(scaled[1])) - digits, 1);
      return `TO_CHAR(${ref}, 'FM${'9'.repeat(whole - 1)}0.${'0'.repeat(digits)}')`;
    }
    if (type === 'date') return `TO_CHAR(${ref}, 'YYYY-MM-DD"T"HH24:MI:SS')`;
    if (/^timestamp(\(\d\))? with (local )?time zone$/.test(type))
      return `TO_CHAR(SYS_EXTRACT_UTC(${ref}), 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"')`;
    if (/^timestamp(\(\d\))?$/.test(type)) return `TO_CHAR(${ref}, 'YYYY-MM-DD"T"HH24:MI:SS.FF3')`;
  }
  if (dialect === 'firebird') {
    if (type === 'date') return `CAST(${ref} AS VARCHAR(10))`;
    if (type === 'timestamp') return `CAST(${ref} AS VARCHAR(30))`;
    if (type === 'timestamp with time zone')
      return `REPLACE(CAST(${ref} AT TIME ZONE 'UTC' AS VARCHAR(60)), ' UTC', 'Z')`;
    if (/^time( with time zone)?$/.test(type)) return `CAST(${ref} AS VARCHAR(80))`;
    // The driver can't read DECFLOAT, so it arrives as the server writes it.
    if (/^decfloat/.test(type)) return `CAST(${ref} AS VARCHAR(64))`;
  }
  return ref;
}
export function positive(value: number | undefined, fallback: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n <= 0 || n > 2147483647) throw new ConnectorError('sources.sync.read');
  return n;
}
