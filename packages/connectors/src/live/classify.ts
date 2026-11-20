import type { Dialect } from '../values.js';

/**
 * What a source column holds, as far as translating a filter or sort goes.  Only columns whose
 * values the source compares the way Riosoma does get a class other than `other`.
 *
 * - `text`: character data the driver hands over as it's stored.  PostgreSQL's fixed-length
 *   `character` is left out, since the driver pads it and comparisons don't.
 * - `integer`, `decimal`, `float`: numbers, except money, which arrives formatted.
 * - `boolean`: true and false, as PostgreSQL's boolean, MySQL's `tinyint(1)` and `bit(1)`, or SQL
 *   Server's `bit`.
 * - `date`: a calendar day.
 * - `instant`: a moment stored with its offset, compared as the moment it names.
 * - `wall`: a date and time with no offset, which Riosoma reads as UTC.
 */
export type SourceClass =
  'text' | 'integer' | 'decimal' | 'float' | 'boolean' | 'date' | 'instant' | 'wall' | 'other';

export function classify(sourceType: string, dialect: Dialect): SourceClass {
  const t = sourceType.toLowerCase().trim();
  const base = t
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/\[\]$/.test(t)) return 'other';
  if (dialect === 'postgres' || dialect === 'redshift' || dialect === 'athena') {
    if (['text', 'character varying', 'varchar', 'name', 'uuid', 'string'].includes(base)) return 'text';
    if (['smallint', 'integer', 'bigint', 'int2', 'int4', 'int8', 'int', 'tinyint'].includes(base))
      return 'integer';
    if (['numeric', 'decimal'].includes(base)) return 'decimal';
    if (['real', 'double precision', 'float4', 'float8', 'double', 'float'].includes(base)) return 'float';
    if (base === 'boolean' || base === 'bool') return 'boolean';
    if (base === 'date') return 'date';
    if (base === 'timestamp with time zone' || base === 'timestamptz') return 'instant';
    if (base === 'timestamp without time zone' || base === 'timestamp') return 'wall';
    if (dialect !== 'postgres') return 'other';
    // An enumerated type reads under its own name, and its labels compare as text.
    if (
      /^[a-z_][a-z0-9_$]*(\.[a-z_][a-z0-9_$]*)?$/.test(base.replaceAll('"', '')) &&
      !KNOWN_POSTGRES.has(base)
    )
      return 'text';
    return 'other';
  }
  if (dialect === 'mysql') {
    if (/^enum\(/.test(t) || /^(varchar|char|tinytext|text|mediumtext|longtext)$/.test(base)) return 'text';
    if (/^(tinyint|bit)\(1\)( unsigned)?$/.test(t)) return 'boolean';
    if (/^(tinyint|smallint|mediumint|int|integer|bigint|year)( unsigned)?( zerofill)?$/.test(base))
      return /zerofill/.test(base) ? 'other' : 'integer';
    if (/^(decimal|numeric)( unsigned)?$/.test(base)) return 'decimal';
    if (/^(float|double|double precision|real)( unsigned)?$/.test(base)) return 'float';
    if (base === 'date') return 'date';
    if (base === 'datetime' || base === 'timestamp') return 'wall';
    return 'other';
  }
  if (/^(varchar|nvarchar|char|nchar|text|ntext|uniqueidentifier)$/.test(base)) return 'text';
  if (/^(tinyint|smallint|int|bigint)$/.test(base)) return 'integer';
  if (/^(decimal|numeric)$/.test(base)) return 'decimal';
  if (/^(float|real)$/.test(base)) return 'float';
  if (base === 'bit') return 'boolean';
  if (base === 'date') return 'date';
  if (base === 'datetimeoffset') return 'instant';
  if (/^(datetime|datetime2|smalldatetime)$/.test(base)) return 'wall';
  return 'other';
}

/** PostgreSQL types that aren't text, so a bare name among them isn't taken for an enumeration. */
const KNOWN_POSTGRES = new Set([
  'money',
  'bytea',
  'json',
  'jsonb',
  'xml',
  'time',
  'time without time zone',
  'time with time zone',
  'timetz',
  'interval',
  'inet',
  'cidr',
  'macaddr',
  'macaddr8',
  'point',
  'line',
  'lseg',
  'box',
  'path',
  'polygon',
  'circle',
  'bit',
  'bit varying',
  'varbit',
  'tsvector',
  'tsquery',
  'character',
  'char',
  'bpchar',
  'citext',
  'oid',
  'pg_lsn',
  'txid_snapshot',
  'int4range',
  'int8range',
  'numrange',
  'tsrange',
  'tstzrange',
  'daterange',
]);
