import { createHash } from 'node:crypto';
import { CHOICE_COLORS, type CellValue, type SourceColumn } from '@riosoma/contracts';
import { ConnectorError } from './types.js';

/** The SQL dialects live reads translate to. */
export type Dialect = 'postgres' | 'mysql' | 'sqlserver' | 'redshift' | 'athena';
/** Every SQL database a connector reads, including the ones that sync only as copies. */
export type SqlDialect = Dialect | 'oracle' | 'firebird' | 'teradata' | 'db2' | 'informix';
export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  labels?: string[];
  scale?: number;
  length?: number;
}

/**
 * The field types a column of numbers converts to cleanly, besides a number field: money and a
 * percentage, which hold the same values and only show them differently, and text.
 */
export const NUMBER_ALTERNATIVES: readonly string[] = ['currency', 'percent', 'text', 'longText'];
const NUMBER_TYPES = new Set(['number', 'currency', 'percent']);

export function column(info: ColumnInfo, dialect: SqlDialect): SourceColumn {
  const t = info.type.toLowerCase();
  const base = t.replace(/\(.*\)/, '').trim();
  let type: string | null = null;
  let options: Record<string, unknown> = {};
  let alternatives: string[] = [];
  if (info.labels) {
    type = base === 'set' ? 'multipleSelect' : 'singleSelect';
    options = {
      choices: info.labels.map((name, i) => ({
        id: `cho${createHash('sha256').update(`${i}:${name}`).digest('hex').slice(0, 14)}`,
        name,
        color: CHOICE_COLORS[i % CHOICE_COLORS.length],
      })),
    };
    alternatives = ['text', 'longText'];
  } else if (/\[\]$/.test(t) || ['json', 'jsonb', 'xml', 'clob', 'dbclob'].includes(base)) {
    type = 'longText';
  } else if (
    ['bool', 'boolean'].includes(base) ||
    (dialect === 'sqlserver' && base === 'bit') ||
    (dialect === 'mysql' && /^(tinyint|bit)\(1\)( unsigned)?$/.test(t))
  ) {
    type = 'checkbox';
    alternatives = ['text', 'longText'];
  } else if (dialect === 'oracle' && /^(number|float|binary_float|binary_double)$/.test(base)) {
    // NUMBER(p) and NUMBER(p,s) are exact, with s decimal places.  A NUMBER without a precision,
    // a FLOAT, and the binary types are floating point.
    const exact = /^number\(\s*(\d+|\*)\s*(?:,\s*(-?\d+)\s*)?\)$/.exec(t);
    type = 'number';
    options = {
      precision:
        exact && (exact[2] !== undefined || exact[1] !== '*')
          ? Math.max(0, Math.min(Number(exact[2] ?? 0), 8))
          : null,
    };
    alternatives = [...NUMBER_ALTERNATIVES];
  } else if (dialect === 'oracle' && base === 'date') {
    // Oracle's DATE carries a time of day as well.
    type = 'date';
    options = { includeTime: true, timeZone: 'UTC' };
    alternatives = ['text', 'longText'];
  } else if (
    (dialect === 'oracle' && /^(clob|nclob|long)$/.test(base)) ||
    (dialect === 'firebird' && base === 'blob sub_type text')
  ) {
    type = 'longText';
  } else if (
    /^(smallint|bigint|integer|int|int2|int4|int8|int128|tinyint|byteint|mediumint|year|serial|bigserial|smallserial|serial8)( unsigned)?$/.test(
      base,
    )
  ) {
    type = 'number';
    options = { precision: 0 };
    alternatives = [...NUMBER_ALTERNATIVES];
  } else if (/^(numeric|decimal|number|money|smallmoney)( unsigned)?$/.test(base)) {
    const scale =
      info.scale ??
      (t.match(/,\s*(-?\d+)\)/)?.[1]
        ? Number(t.match(/,\s*(-?\d+)\)/)![1])
        : /money/.test(base)
          ? dialect === 'postgres'
            ? 2
            : 4
          : // PostgreSQL numbers without a declared precision can retain any decimal scale.
            dialect === 'postgres' && !t.includes('(')
            ? null
            : 0);
    type = 'number';
    options = { precision: scale === null ? null : Math.max(0, Math.min(scale, 8)) };
    alternatives = [...NUMBER_ALTERNATIVES];
  } else if (
    /^(real|float|float4|float8|double|double precision|decfloat|smallfloat)( unsigned)?$/.test(base)
  ) {
    type = 'number';
    options = { precision: null };
    alternatives = [...NUMBER_ALTERNATIVES];
  } else if ((dialect === 'teradata' || dialect === 'informix') && base.startsWith('interval')) {
    type = 'text';
    alternatives = ['longText'];
  } else if (base === 'date') {
    type = 'date';
    alternatives = ['text', 'longText'];
  } else if (
    /^(timestamp|timestamptz|datetime|datetime2|datetimeoffset|smalldatetime)/.test(base) &&
    !(dialect === 'sqlserver' && base === 'timestamp')
  ) {
    type = 'date';
    options = { includeTime: true, timeZone: 'UTC' };
    alternatives = ['text', 'longText'];
  } else if (
    /^(char|character|varchar|varchar2|nvarchar2|character varying|nvarchar|nchar|text|tinytext|mediumtext|longtext|ntext|uuid|uniqueidentifier|lvarchar|graphic|vargraphic|time|timetz)( with(out)? time zone)?$/.test(
      base,
    )
  ) {
    const length = info.length ?? Number(t.match(/\((\d+)\)/)?.[1] ?? 0);
    type =
      length > 1000 || /\(max\)/.test(t) || (dialect === 'mysql' && /text/.test(base)) || base === 'ntext'
        ? 'longText'
        : 'text';
    alternatives = type === 'text' ? ['longText', 'email', 'url', 'phone', 'singleSelect'] : [];
  }
  return {
    name: info.name,
    sourceType: info.type,
    nullable: info.nullable,
    suggested: type ? { type, options } : null,
    alternatives,
  };
}

export function convert(value: unknown, type: string, col: SourceColumn): CellValue {
  if (value === null || value === undefined) return null;
  if (NUMBER_TYPES.has(type)) {
    const result = Number(
      /money/i.test(col.sourceType) && typeof value === 'string' ? value.replace(/[^\d.-]/g, '') : value,
    );
    if (!Number.isFinite(result)) throw new ConnectorError('sources.sync.read');
    return result;
  }
  if (type === 'checkbox')
    return Buffer.isBuffer(value)
      ? value.some((b) => b !== 0)
      : value === true || value === 1 || value === '1' || value === 't' || value === 'true';
  if (type === 'date') {
    let text = value instanceof Date ? value.toISOString() : String(value);
    if (!col.suggested?.options.includeTime) return text.slice(0, 10);
    text = text.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
    if (!/(Z|[+-]\d{2}(:?\d{2})?)$/i.test(text)) text += 'Z';
    const date = new Date(text);
    if (!Number.isFinite(date.getTime())) throw new ConnectorError('sources.sync.read');
    return date.toISOString();
  }
  if (type === 'multipleSelect')
    return Array.isArray(value) ? value.map(String) : String(value).split(',').filter(Boolean);
  if (col.suggested?.type === 'checkbox') return String(convert(value, 'checkbox', col));
  if (/^(jsonb?)$|\[\]$/i.test(col.sourceType)) return JSON.stringify(value);
  if (value instanceof Date)
    return /^time(?:\(|$)/i.test(col.sourceType) ? value.toISOString().slice(11, 23) : value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function keyValue(value: unknown, col: SourceColumn): CellValue {
  if (value === null || value === undefined) return null;
  if (
    /^(numeric|decimal|money|smallmoney)/i.test(col.sourceType) ||
    /^number\(\s*(\d+|\*)\s*,\s*[1-9]/i.test(col.sourceType)
  )
    return String(value);
  if (col.suggested?.type === 'number') {
    const number = Number(value);
    if (Number.isSafeInteger(number)) return number;
    // Oracle's NUMBER without a precision often holds whole IDs, which stay exact as their digits.
    if (/^(number|decfloat)/i.test(col.sourceType) && typeof value === 'string' && /^-?\d+$/.test(value))
      return value;
    return col.suggested.options.precision === null ? number : String(value);
  }
  return convert(value, col.suggested?.type ?? 'text', col);
}
