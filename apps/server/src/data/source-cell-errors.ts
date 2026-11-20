import { ident, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { CellValue } from '@riosoma/contracts';
import type { StoredField } from './types.js';
import { columnType, jsonValueExpr } from './physical/columns.js';

// This key cannot be a field ID.  The existing record metadata keeps refused source cells
// alongside overrides, without changing the physical schema of every synced table.
export const SOURCE_CELL_ERRORS = '__sourceErrors';
export const ARRAY_CELL_ERROR = 'sources.engines.arrayCell';

/** Only records being edited need their refused values when an override compares with the source */
export async function sourceErrorValues(db: Queryable, schema: string, tableId: string, ids: string[]) {
  if (!ids.length) return new Map<string, Record<string, { source: CellValue }>>();
  const found = await query<{ id: string; cells: Record<string, { source: CellValue }> }>(
    db,
    sql`SELECT __id AS id, __overrides -> ${SOURCE_CELL_ERRORS} AS cells FROM ${ident(schema, tableId)} WHERE __id = ANY(${ids}::text[])`,
  );
  return new Map(found.rows.map((row) => [row.id, row.cells ?? {}]));
}

/** Arrays stay JSON text in text-backed fields, while scalar storage needs an empty error cell */
export function sourceCellError(field: StoredField, value: CellValue | undefined): string | null {
  return field.source && columnType(field) !== 'text' && typeof value === 'string' && value.startsWith('[')
    ? ARRAY_CELL_ERROR
    : null;
}

/** The connector encodes unexpected arrays as JSON text, which cannot be cast into scalar storage */
export function sourceArrayCondition(field: StoredField, value: Sql): Sql {
  return !field.source || columnType(field) === 'text'
    ? sql`FALSE`
    : sql`(jsonb_typeof(${value}) = 'string' AND (${value} #>> '{}') LIKE '[%')`;
}

export function sourceCellValue(field: StoredField, value: Sql): Sql {
  return jsonValueExpr(
    field,
    sql`CASE WHEN ${sourceArrayCondition(field, value)} THEN 'null'::jsonb ELSE ${value} END`,
  );
}

/** Replace only source issues, retaining real overrides and omitting empty metadata */
export function withSourceCellErrors(overrides: Sql, errors: Sql): Sql {
  return sql`NULLIF((COALESCE(${overrides}, '{}'::jsonb) - ${SOURCE_CELL_ERRORS}) ||
    CASE WHEN ${errors} <> '{}'::jsonb THEN jsonb_build_object(${SOURCE_CELL_ERRORS}::text, ${errors}) ELSE '{}'::jsonb END, '{}'::jsonb)`;
}
