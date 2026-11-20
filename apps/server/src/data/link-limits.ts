import { type FilterGroup } from '@riosoma/contracts';
import { ident, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { DataSchemas } from './context.js';
import { loadFields, loadView } from './metadata.js';
import { cellError } from './value-errors.js';
import { columnRef } from './physical/columns.js';
import { compileConditionalFilter, relationalConditions } from './physical/conditional.js';
import { checkCondition, canCompareCurrentField } from '@riosoma/contracts';
import { resultType } from './physical/relations.js';
import type { ReadContext, StoredField } from './types.js';

type LinkField = Extract<StoredField, { type: 'link' }>;

export function hasLinkLimit(field: StoredField): field is LinkField {
  return field.type === 'link' && Boolean(field.options.filter || field.options.limitToViewId);
}

/** Limits use all stored fields, so hiding a filter input never broadens the allowed choices. */
export async function linkLimitPredicate(
  db: Queryable,
  schemas: DataSchemas,
  field: LinkField,
  fields: readonly StoredField[],
  target: string,
  currentValue: (field: StoredField) => Sql,
  context: ReadContext = { now: new Date(), timeZone: 'UTC', natural: false },
): Promise<Sql> {
  let filter: FilterGroup | undefined = field.options.filter;
  if (field.options.limitToViewId) {
    const view = await loadView(db, schemas, field.options.limitToViewId);
    if (!view || view.trashed || view.view.tableId !== field.options.linkedTableId) return sql`FALSE`;
    filter = view.view.config.filter ?? undefined;
  }
  const byId = new Map(fields.map((item) => [item.id, item]));
  // Deleted dependencies and changed field types fail closed instead of dropping a restriction.
  for (const condition of relationalConditions(filter)) {
    const targetField = byId.get(condition.fieldId);
    if (!targetField || targetField.tableId !== field.options.linkedTableId) return sql`FALSE`;
    if (condition.currentFieldId) {
      const own = byId.get(condition.currentFieldId);
      if (
        !own ||
        own.tableId !== field.tableId ||
        resultType(own) !== resultType(targetField) ||
        !canCompareCurrentField(own, condition.operator) ||
        !canCompareCurrentField(targetField, condition.operator)
      )
        return sql`FALSE`;
    } else if (!checkCondition(targetField, condition).valid) return sql`FALSE`;
  }
  return compileConditionalFilter(filter, byId, context, schemas.app, target, currentValue);
}

/** Called inside the write transaction after scalar values and both sides of the links change. */
export async function requireLinkLimits(
  db: Queryable,
  dataSchema: string,
  field: StoredField,
  recordIds: readonly string[],
  errorField = field,
  errorRecordId?: string,
  targetRecordIds?: readonly string[],
): Promise<void> {
  if (!hasLinkLimit(field) || !field.relation || !field.appSchema || !recordIds.length) return;
  const schemas = { app: field.appSchema, data: dataSchema, audit: '' };
  const fields = await loadFields(db, schemas, [...new Set([field.tableId, field.options.linkedTableId])]);
  const predicate = await linkLimitPredicate(db, schemas, field, fields, 'target', (own) =>
    columnRef(own, 'source'),
  );
  const side = field.relation.side;
  const other = side === 'left' ? 'right' : 'left';
  const refused = await query<{ id: string }>(
    db,
    sql`SELECT source.__id AS id FROM ${ident(dataSchema, field.tableId)} source
      JOIN ${ident(dataSchema, `lnk_${field.relation.linkId}`)} edge
        ON edge.${ident(`${side}_rid`)} = source.__rid
      JOIN ${ident(dataSchema, field.options.linkedTableId)} target
        ON target.__rid = edge.${ident(`${other}_rid`)}
      WHERE source.__id = ANY(${recordIds}::text[]) AND source.__deleted_at IS NULL
        AND target.__deleted_at IS NULL AND NOT target.__source_gone
        ${targetRecordIds ? sql`AND target.__id = ANY(${targetRecordIds}::text[])` : sql``}
        AND (${predicate}) IS NOT TRUE LIMIT 1`,
  );
  if (refused.rows.length)
    throw cellError(
      'data.link.outsideLimit',
      errorField,
      errorRecordId ?? refused.rows[0]!.id,
      recordIds.indexOf(refused.rows[0]!.id),
    );
}
