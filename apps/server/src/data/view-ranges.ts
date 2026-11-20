import {
  cellValue,
  numericList,
  isBarField,
  isScaleField,
  isSparklineField,
  type ViewRanges,
} from '@riosoma/contracts';
import { ident, join, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { DataSchemas } from './context.js';
import { relationExpr } from './physical/relations.js';
import { columnRef } from './physical/columns.js';
import { compileFilter } from './physical/filters.js';
import { formulaExpression } from './physical/formulas.js';
import { formulaRead } from './physical/records.js';
import type { SnapshotRead } from './snapshots.js';
import type { StoredField } from './types.js';

const UTC_INSTANT = `YYYY-MM-DD"T"HH24:MI:SS.MS"Z"`;

/** The lowest or highest value of a field, as text the API value decodes from. */
function bound(field: StoredField, fn: 'min' | 'max', expression?: Sql): Sql {
  if (isSparklineField(field)) {
    const source = field.sparklineSources?.[0];
    const raw = expression ?? (source ? relationExpr(source.field) : columnRef(field));
    const list = field.type === 'json' ? sql`(${raw})::jsonb` : raw;
    const aggregate = fn === 'min' ? sql`min(point)` : sql`max(point)`;
    return sql`(${fn === 'min' ? sql`min` : sql`max`}((SELECT ${aggregate} FROM (SELECT CASE WHEN jsonb_typeof(item) = 'number'
      THEN (item #>> '{}')::numeric END AS point FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${list}) = 'array'
      THEN ${list} ELSE '[]'::jsonb END) AS item) AS numeric_points)))::text`;
  }
  const value = fn === 'min' ? sql`min(${columnRef(field)})` : sql`max(${columnRef(field)})`;
  if (field.type !== 'date') return sql`(${value})::text`;
  return field.options.includeTime
    ? sql`to_char(${value} AT TIME ZONE 'UTC', ${UTC_INSTANT})`
    : sql`to_char(${value}, 'YYYY-MM-DD')`;
}

function decode(field: StoredField, raw: string | null): number | string | null {
  if (raw === null) return null;
  if (field.type === 'date') return raw;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The lowest and highest values of number and date fields across a view's records: every record
 * the view's filter admits and the reader may see, not only the rows loaded so far.  Color scales
 * and data bars measure each value against them.  Fields that can't have a scale or a bar, and
 * fields the reader can't see, are left out.
 */
export async function viewRanges(
  db: Queryable,
  schemas: DataSchemas,
  read: SnapshotRead,
  fieldIds: readonly string[],
): Promise<ViewRanges> {
  const visible = new Map(read.fields.map((field) => [field.id, field]));
  const fields = [...new Set(fieldIds)].flatMap((id) => {
    const field = visible.get(id);
    return field && (isScaleField(field) || isBarField(field) || isSparklineField(field)) ? [field] : [];
  });
  if (!fields.length) return { ranges: [] };
  const fallback: StoredField[] = [];
  const columns = fields.flatMap((field, index) => {
    // Array formulas keep their JSON results, and scalar sort behavior stays unchanged.
    const expression =
      field.type === 'formula' && isSparklineField(field)
        ? formulaExpression(field, undefined, read.context, true)
        : undefined;
    if (expression === null) {
      fallback.push(field);
      return [];
    }
    return [
      sql`${bound(field, 'min', expression)} AS ${ident(`min_${index}`)}`,
      sql`${bound(field, 'max', expression)} AS ${ident(`max_${index}`)}`,
    ];
  });
  const predicate = sql`__deleted_at IS NULL AND NOT __source_gone AND (${read.predicate})
    AND ${compileFilter(read.view.config.filter, visible, read.context, schemas.app)}`;
  const result = columns.length
    ? await query<Record<string, string | null>>(
        db,
        sql`SELECT ${join(columns, ', ')} FROM ${ident(schemas.data, read.table.id)} WHERE ${predicate}`,
      )
    : undefined;
  const row = result?.rows[0] ?? {};
  const evaluated = new Map<string, { min: number | null; max: number | null }>();
  if (fallback.length) {
    const evaluator = formulaRead(fallback, read.context);
    for (const field of fallback) evaluated.set(field.id, { min: null, max: null });
    let after = '0';
    // JavaScript-only formulas use the same scoped decoder as rows, one bounded page at a time.
    while (true) {
      const page = await query<Parameters<typeof evaluator.decode>[0]>(
        db,
        sql`SELECT ${evaluator.select} FROM ${ident(schemas.data, read.table.id)}
          WHERE ${predicate} AND __rid > ${after}::bigint ORDER BY __rid LIMIT 1000`,
      );
      for (const stored of page.rows) {
        const record = evaluator.decode(stored);
        for (const field of fallback) {
          if (record.errors?.[field.id]) continue;
          const range = evaluated.get(field.id)!;
          for (const value of numericList(cellValue(record, field))) {
            range.min = range.min === null ? value : Math.min(range.min, value);
            range.max = range.max === null ? value : Math.max(range.max, value);
          }
        }
      }
      if (page.rows.length < 1000) break;
      after = page.rows.at(-1)!.__rid;
    }
  }
  return {
    ranges: fields.map((field, index) => ({
      fieldId: field.id,
      ...(evaluated.get(field.id) ?? {
        min: decode(field, row[`min_${index}`] ?? null),
        max: decode(field, row[`max_${index}`] ?? null),
      }),
    })),
  };
}
