import { isGroup, type FieldSpec, type FilterCondition, type FilterGroup } from '@riosoma/contracts';
import { join, sql, type Sql } from '@riosoma/db';
import type { ReadContext, StoredField } from '../types.js';
import { columnRef } from './columns.js';
import { compileFilter } from './filters.js';

export function relationalConditions(filter: FilterGroup | undefined): FilterCondition[] {
  return filter?.conditions.flatMap((item) => (isGroup(item) ? relationalConditions(item) : [item])) ?? [];
}

/** Filter and sort inputs count as dependencies even when the returned field is public. */
export function relationalReads(field: FieldSpec): string[] {
  if (field.type !== 'link' && field.type !== 'lookup' && field.type !== 'rollup' && field.type !== 'count')
    return [];
  return [
    ...new Set([
      ...relationalConditions(field.options.filter).flatMap((item) => [
        item.fieldId,
        ...(item.currentFieldId ? [item.currentFieldId] : []),
      ]),
      ...(field.type === 'lookup' ? (field.options.sort?.map((item) => item.fieldId) ?? []) : []),
    ]),
  ];
}

export function conditionalPredicate(field: StoredField, record: string, outer: string): Sql {
  if (field.type !== 'lookup' && field.type !== 'rollup' && field.type !== 'count') return sql`TRUE`;
  const fields = new Map(
    field.relation?.conditionFields?.map((item) => [item.id, { ...item, readContext: field.readContext }]),
  );
  return compileConditionalFilter(
    field.options.filter,
    fields,
    { now: new Date(), timeZone: 'UTC', natural: false, ...field.readContext },
    field.appSchema,
    record,
    (current) => columnRef(current, outer),
  );
}

/** Current values can come from a saved record or a draft that has not been submitted yet. */
export function compileConditionalFilter(
  filter: FilterGroup | undefined,
  fields: ReadonlyMap<string, StoredField>,
  context: ReadContext,
  appSchema: string | undefined,
  record: string,
  currentValue: (field: StoredField) => Sql,
): Sql {
  const walk = (group: FilterGroup): Sql => {
    const parts = group.conditions.map((condition): Sql => {
      if (isGroup(condition)) return walk(condition);
      const target = fields.get(condition.fieldId);
      if (!target) return sql`FALSE`;
      if (!condition.currentFieldId)
        return compileFilter(
          { conjunction: 'and', conditions: [condition] },
          fields,
          context,
          appSchema,
          record,
        );
      const current = fields.get(condition.currentFieldId);
      if (!current) return sql`FALSE`;
      let left = columnRef(target, record),
        right = currentValue(current);
      if (
        ['is', 'isNot', 'contains', 'doesNotContain'].includes(condition.operator) &&
        target.type !== 'checkbox'
      ) {
        left = sql`lower((${left})::text)`;
        right = sql`lower((${right})::text)`;
      }
      switch (condition.operator) {
        case 'is':
        case 'eq':
          return sql`${left} IS NOT DISTINCT FROM ${right}`;
        case 'isNot':
        case 'neq':
          return sql`${left} IS DISTINCT FROM ${right}`;
        case 'lt':
        case 'isBefore':
          return sql`${left} < ${right}`;
        case 'lte':
        case 'isOnOrBefore':
          return sql`${left} <= ${right}`;
        case 'gt':
        case 'isAfter':
          return sql`${left} > ${right}`;
        case 'gte':
        case 'isOnOrAfter':
          return sql`${left} >= ${right}`;
        case 'contains':
          return sql`strpos(${left}, ${right}) > 0`;
        case 'doesNotContain':
          return sql`COALESCE(strpos(${left}, ${right}), 0) = 0`;
        default:
          return sql`FALSE`;
      }
    });
    return parts.length ? sql`(${join(parts, group.conjunction === 'and' ? ' AND ' : ' OR ')})` : sql`TRUE`;
  };
  return filter ? walk(filter) : sql`TRUE`;
}
