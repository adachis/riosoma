import { changeLogExpression } from './change-log.js';
import { computedOverride } from './overrides.js';
import type { CellValue, FieldSpec, FieldType, SignatureValue } from '@riosoma/contracts';
import { ident, sql, type Sql } from '@riosoma/db';
import type { StoredField } from '../types.js';
import { relationExpr } from './relations.js';
import { formulaExpression, formulaScalar } from './formulas.js';

/**
 * How each field type maps onto Postgres: the column type, how to read a value so it decodes the
 * same way whatever the session's time zone or date style, and how to pass a value in.
 */
export const SYSTEM = {
  rid: '__rid',
  id: '__id',
  createdAt: '__created_at',
  createdBy: '__created_by',
  updatedAt: '__updated_at',
  updatedBy: '__updated_by',
  deletedAt: '__deleted_at',
  overrides: '__overrides',
} as const;

export type ColumnType =
  | 'text'
  | 'numeric'
  | 'boolean'
  | 'date'
  | 'timestamptz'
  | 'text[]'
  | 'double precision'
  | 'smallint'
  | 'bigint'
  | 'daterange'
  | 'tstzrange'
  | 'jsonb';

/** The column type a field needs, or null for types computed from system columns. */
export function columnType(spec: Pick<FieldSpec, 'type'> & { options?: unknown }): ColumnType | null {
  switch (spec.type) {
    // JSON keeps the text as written, key order and number spelling included, which `jsonb` wouldn't do.
    case 'barcode':
    case 'time':
    case 'json':
    case 'text':
    case 'longText':
    case 'email':
    case 'url':
    case 'phone':
    case 'singleSelect':
      return 'text';
    // A range sorts and filters by its start, which `lower()` reads.
    case 'dateRange':
      return (spec.options as { includeTime?: boolean } | undefined)?.includeTime ? 'tstzrange' : 'daterange';
    case 'multiCurrency':
    case 'location':
    case 'signature':
      return 'jsonb';
    case 'number':
      return 'numeric';
    case 'currency':
    case 'percent':
    case 'duration':
      return 'double precision';
    case 'rating':
      return 'smallint';
    case 'autoNumber':
      return 'bigint';
    case 'checkbox':
      return 'boolean';
    case 'date':
      return (spec.options as { includeTime?: boolean } | undefined)?.includeTime ? 'timestamptz' : 'date';
    case 'attachment':
    case 'multipleSelect':
    case 'user':
      return 'text[]';
    default:
      return null;
  }
}

/** The SQL spelling of a column type, from a fixed list. */
export function typeSql(type: ColumnType): Sql {
  switch (type) {
    case 'text':
      return sql`text`;
    case 'numeric':
      return sql`numeric`;
    case 'boolean':
      return sql`boolean`;
    case 'date':
      return sql`date`;
    case 'timestamptz':
      return sql`timestamptz`;
    case 'text[]':
      return sql`text[]`;
    case 'double precision':
      return sql`double precision`;
    case 'smallint':
      return sql`smallint`;
    case 'bigint':
      return sql`bigint`;
    case 'daterange':
      return sql`daterange`;
    case 'tstzrange':
      return sql`tstzrange`;
    case 'jsonb':
      return sql`jsonb`;
  }
}

const SYSTEM_COLUMN_OF: Partial<Record<FieldType, string>> = {
  createdTime: SYSTEM.createdAt,
  lastModifiedTime: SYSTEM.updatedAt,
  createdBy: SYSTEM.createdBy,
  lastModifiedBy: SYSTEM.updatedBy,
  recordId: SYSTEM.id,
};

/** The column holding a field's value: its own, or the system column a computed field shows. */
export function columnRef(field: StoredField, alias?: string): Sql {
  if (field.joinedRead) return field.joinedRead(alias);
  // A button holds nothing, so it has no column to read.
  if (field.type === 'button') return sql`NULL::text`;
  if (field.type === 'changeLog') return changeLogExpression(field, alias);
  if (field.type === 'formula') return formulaScalar(field, alias, field.readContext);
  if (field.type === 'lookup' || field.type === 'rollup') {
    const raw = relationExpr(field, alias);
    const json = computedOverride(field, sql`to_jsonb(${raw})`, alias);
    const type = field.type === 'lookup' ? 'array' : field.options.resultType;
    if (type === 'array') return json;
    const value = sql`(${json} #>> '{}')`;
    return type === 'number'
      ? sql`${value}::numeric`
      : type === 'boolean'
        ? sql`${value}::boolean`
        : type === 'date'
          ? sql`${value}::date`
          : type === 'datetime'
            ? sql`${value}::timestamptz`
            : value;
  }
  if (['link', 'lineItems', 'count'].includes(field.type)) return relationExpr(field, alias);
  const name = SYSTEM_COLUMN_OF[field.type] ?? field.columnName;
  return alias ? sql`${ident(alias, name)}` : sql`${ident(name)}`;
}

/** A system column, optionally qualified by a table alias. */
export function systemRef(name: (typeof SYSTEM)[keyof typeof SYSTEM], alias?: string): Sql {
  return alias ? sql`${ident(alias, name)}` : sql`${ident(name)}`;
}

const UTC_INSTANT = `YYYY-MM-DD"T"HH24:MI:SS.MS"Z"`;

/** Reads a field's value in a form `decodeValue` turns into the API value. */
export function selectExpr(field: StoredField, alias?: string): Sql {
  if (field.type === 'formula') return formulaExpression(field, alias) ?? sql`NULL::jsonb`;
  const ref = columnRef(field, alias);
  switch (field.type) {
    case 'checkbox':
      return sql`COALESCE(${ref}, false)`;
    case 'date':
      return field.options.includeTime
        ? sql`to_char(${ref} AT TIME ZONE 'UTC', ${UTC_INSTANT})`
        : sql`to_char(${ref}, 'YYYY-MM-DD')`;
    case 'createdTime':
    case 'lastModifiedTime':
      return sql`to_char(${ref} AT TIME ZONE 'UTC', ${UTC_INSTANT})`;
    case 'number':
      return sql`${ref}::text`;
    case 'rollup':
      return field.options.resultType === 'date'
        ? sql`to_char(${ref}, 'YYYY-MM-DD')`
        : field.options.resultType === 'datetime'
          ? sql`to_char(${ref} AT TIME ZONE 'UTC', ${UTC_INSTANT})`
          : ref;
    // Both ends as the date field of the same options would read them.  The stored upper bound
    // of a day range is the day after its last one.
    case 'dateRange':
      return field.options.includeTime
        ? sql`CASE WHEN ${ref} IS NULL OR isempty(${ref}) THEN NULL ELSE jsonb_build_object(
            'start', to_char(lower(${ref}) AT TIME ZONE 'UTC', ${UTC_INSTANT}),
            'end', to_char(upper(${ref}) AT TIME ZONE 'UTC', ${UTC_INSTANT})) END`
        : sql`CASE WHEN ${ref} IS NULL OR isempty(${ref}) THEN NULL ELSE jsonb_build_object(
            'start', to_char(lower(${ref}), 'YYYY-MM-DD'),
            'end', to_char(upper(${ref}) - 1, 'YYYY-MM-DD')) END`;
    default:
      return ref;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** An object read from a `jsonb` column, in the key order the API shows. */
function objectValue(field: StoredField, raw: Record<string, unknown>): CellValue {
  switch (field.type) {
    case 'multiCurrency':
      return { amount: Number(raw.amount), code: String(raw.code) };
    case 'dateRange':
      return { start: String(raw.start), end: String(raw.end) };
    case 'location':
      return { lat: Number(raw.lat), lng: Number(raw.lng), label: text(raw.label) };
    default: {
      const drawing = raw.drawing as Record<string, unknown> | null | undefined;
      const value: SignatureValue = {
        drawing: drawing
          ? { path: String(drawing.path), width: Number(drawing.width), height: Number(drawing.height) }
          : null,
        name: text(raw.name),
        signedBy: text(raw.signedBy),
        signedAt: String(raw.signedAt),
      };
      return value;
    }
  }
}

/** A number, or blank for a decimal too large for JavaScript, which JSON couldn't carry anyway. */
const finite = (value: number): number | null => (Number.isFinite(value) ? value : null);

/** Turns what `selectExpr` read into the API value. */
export function decodeValue(field: StoredField, raw: unknown): CellValue {
  if (field.type === 'checkbox') return raw === true;
  if (field.type === 'link' || field.type === 'lineItems')
    return Array.isArray(raw) ? (raw as CellValue) : [];
  // A looked-up number too large for JavaScript is blank, as it is in a number field.
  if (field.type === 'lookup')
    return Array.isArray(raw)
      ? (raw.map((item: unknown) => (typeof item === 'number' ? finite(item) : item)) as CellValue)
      : [];
  if (field.type === 'count' || (field.type === 'rollup' && field.options.resultType === 'number'))
    return raw === null || raw === undefined ? null : finite(Number(raw));
  if (raw === null || raw === undefined) return null;
  switch (field.type) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'duration':
    case 'rating':
    case 'autoNumber':
      return finite(Number(raw));
    case 'user':
    case 'attachment':
    case 'multipleSelect':
      return Array.isArray(raw) && raw.length > 0 ? (raw as string[]) : null;
    case 'dateRange':
    case 'multiCurrency':
    case 'location':
    case 'signature':
      return typeof raw === 'object' && !Array.isArray(raw)
        ? objectValue(field, raw as Record<string, unknown>)
        : null;
    default:
      return raw as CellValue;
  }
}

/** Reads one checked value from a JSON batch without allocating a parameter per cell. */
export function jsonValueExpr(field: StoredField, value: Sql): Sql {
  const type = columnType(field);
  if (!type) throw new Error(`Field type ${field.type} has no column to write`);
  if (type === 'text[]') {
    return sql`NULLIF(ARRAY(SELECT jsonb_array_elements_text(
      NULLIF(${value}, 'null'::jsonb))), ARRAY[]::text[])`;
  }
  // Checked objects arrive whole, and ranges include both of their ends.
  if (type === 'jsonb') return sql`CASE WHEN jsonb_typeof(${value}) = 'object' THEN ${value} END`;
  if (type === 'daterange' || type === 'tstzrange') {
    const end = type === 'daterange' ? sql`date` : sql`timestamptz`;
    return sql`CASE WHEN jsonb_typeof(${value}) = 'object' THEN ${typeSql(type)}(
      (${value} ->> 'start')::${end}, (${value} ->> 'end')::${end}, '[]') END`;
  }
  const scalar = sql`NULLIF(${value} #>> '{}', '')::${typeSql(type)}`;
  return type === 'boolean' ? sql`COALESCE(${scalar}, false)` : scalar;
}

/** A value as a typed SQL parameter for a field's column.  The value must already be checked. */
export function valueExpr(field: StoredField, value: CellValue): Sql {
  const type = columnType(field);
  if (!type) throw new Error(`Field type ${field.type} has no column to write`);
  if (type === 'jsonb' || type === 'daterange' || type === 'tstzrange')
    return jsonValueExpr(field, sql`${JSON.stringify(value)}::jsonb`);
  const param = value === null || (Array.isArray(value) && value.length === 0) ? null : value;
  return sql`${param}::${typeSql(type)}`;
}

/** Reads the system columns of a record into the parts of `RowData` besides `values`. */
export const SYSTEM_SELECT = (alias?: string): Sql => {
  const r = (name: (typeof SYSTEM)[keyof typeof SYSTEM]) => systemRef(name, alias);
  return sql`${r(SYSTEM.rid)} AS __rid, ${r(SYSTEM.id)} AS __id,
    to_char(${r(SYSTEM.createdAt)} AT TIME ZONE 'UTC', ${UTC_INSTANT}) AS __created_at,
    ${r(SYSTEM.createdBy)} AS __created_by,
    to_char(${r(SYSTEM.updatedAt)} AT TIME ZONE 'UTC', ${UTC_INSTANT}) AS __updated_at,
    ${r(SYSTEM.updatedBy)} AS __updated_by, ${r(SYSTEM.overrides)} AS __overrides`;
};
