import { ident, join, sql, type Sql } from '@riosoma/db';
import type { StoredField } from '../types.js';
import { relationExpr } from './relations.js';

/** Totals use the same scoped junction reads as a SUM rollup. */
export function lineItemTotals(field: StoredField, alias?: string): Sql {
  if (field.type !== 'lineItems' || !field.relation) return sql`'{}'::jsonb`;
  const entries = (field.lineColumns ?? []).filter(
    (column) => column.type === 'number' || column.type === 'currency',
  );
  if (!entries.length) return sql`'{}'::jsonb`;
  return sql`jsonb_build_object(${join(
    entries.flatMap((column) => {
      const rollup: StoredField = {
        ...field,
        type: 'rollup',
        options: {
          linkFieldId: field.id,
          targetFieldId: column.id,
          fn: 'sum',
          precision: null,
          resultType: 'number',
        },
        relation: { ...field.relation!, target: column },
      };
      return [sql`${column.id}::text`, sql`COALESCE(${relationExpr(rollup, alias)}, 0)`];
    }),
    ', ',
  )})`;
}

export const totalsColumn = (id: string): Sql => sql`${ident(`__totals_${id}`)}`;
