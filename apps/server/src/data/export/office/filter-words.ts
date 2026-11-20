import {
  checkCondition,
  DateRange,
  DateTarget,
  isGroup,
  LocationDistance,
  operatorsForField,
  type FilterCondition,
  type FilterGroup,
  type Operator,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { AccessScope } from '../../access.js';
import type { DataSchemas } from '../../context.js';
import { formatValue, type FormatContext } from '../../format.js';
import { displayExpr } from '../../physical/relations.js';
import type { StoredField } from '../../types.js';
import { DATE_COPY, FILTER_COPY, OPERATOR_COPY, RANGE_OPERATOR_COPY, say, type Descriptor } from './copy.js';

/**
 * A view's filter in words, for the top of a document: "Status is Done and Due is before today".
 * It says only what the filter does for the person reading: a condition on a field they can't
 * see, or one still missing its value, is left out here exactly as the query leaves it out, and a
 * linked record they can't see is named only as a hidden record.
 */

/** The conditions that apply, the way `compileFilter` picks them. */
function applies(condition: FilterCondition, fields: ReadonlyMap<string, StoredField>): StoredField | null {
  const field = fields.get(condition.fieldId);
  if (!field || !operatorsForField(field).includes(condition.operator)) return null;
  return checkCondition(field, condition).usable ? field : null;
}

/** Records a filter names through its link conditions, by the table they're in. */
export function filterRecords(
  filter: FilterGroup | null,
  fields: ReadonlyMap<string, StoredField>,
): Map<StoredField, Set<string>> {
  const found = new Map<StoredField, Set<string>>();
  const visit = (group: FilterGroup) => {
    for (const condition of group.conditions) {
      if (isGroup(condition)) {
        visit(condition);
        continue;
      }
      const field = applies(condition, fields);
      if (field?.type !== 'link' || !Array.isArray(condition.value)) continue;
      const ids = found.get(field) ?? new Set<string>();
      for (const id of condition.value) if (typeof id === 'string') ids.add(id);
      found.set(field, ids);
    }
  };
  if (filter) visit(filter);
  return found;
}

/**
 * The names of the linked records a filter names, read through the person's own rules for the
 * linked table, so a record they can't see stays unnamed.
 */
export async function filterRecordNames(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  filter: FilterGroup | null,
  fields: ReadonlyMap<string, StoredField>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const [field, ids] of filterRecords(filter, fields)) {
    const relation = field.relation;
    const primary = relation?.primary;
    if (!relation || !primary || !ids.size) continue;
    await scope.ensureTable(relation.linkedTableId);
    if (!scope.visibleFields(relation.linkedTableId, [primary]).length) continue;
    const found = await query<{ id: string; name: string | null }>(
      db,
      sql`SELECT __id AS id, ${displayExpr(primary)} AS name
        FROM ${ident(schemas.data, relation.linkedTableId)} WHERE __id = ANY(${[...ids]}::text[])
        AND __deleted_at IS NULL AND (${scope.recordPredicate(relation.linkedTableId)})`,
    );
    for (const row of found.rows) names.set(row.id, row.name ?? '');
  }
  return names;
}

export interface FilterNames extends FormatContext {
  /** Names of the linked records the filter names, from `filterRecordNames` */
  records: ReadonlyMap<string, string>;
}

function operatorWords(field: StoredField, operator: Operator, locale: string): string {
  const ranged =
    field.type === 'dateRange'
      ? (RANGE_OPERATOR_COPY as Partial<Record<Operator, Descriptor>>)[operator]
      : null;
  return say(ranged ?? OPERATOR_COPY[operator], locale);
}

/** A list of values joined the reader's way: "Red, Blue, or Green", or "and" when every one counts. */
function listed(values: readonly string[], locale: string, every: boolean): string {
  const shown = values.filter(Boolean);
  try {
    return new Intl.ListFormat(locale, { type: every ? 'conjunction' : 'disjunction' }).format(shown);
  } catch {
    return shown.join(', ');
  }
}

function dayText(date: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(`${date}T12:00:00Z`),
  );
}

function targetWords(target: DateTarget, locale: string): string {
  switch (target.mode) {
    case 'exactDate':
      return dayText(target.date, locale);
    case 'daysAgo':
      return say(FILTER_COPY.daysAgo, locale, { days: target.days });
    case 'daysFromNow':
      return say(FILTER_COPY.daysFromNow, locale, { days: target.days });
    default:
      return say(DATE_COPY[target.mode], locale);
  }
}

function rangeWords(range: DateRange, locale: string): string {
  switch (range.mode) {
    case 'pastDays':
      return say(FILTER_COPY.pastDays, locale, { days: range.days });
    case 'nextDays':
      return say(FILTER_COPY.nextDays, locale, { days: range.days });
    default:
      return say(DATE_COPY[range.mode], locale);
  }
}

function choiceName(field: StoredField, id: string): string {
  if (field.type !== 'singleSelect' && field.type !== 'multipleSelect') return id;
  return field.options.choices.find((choice) => choice.id === id)?.name ?? '';
}

/** Whether a list of values has to match every one, rather than any. */
const EVERY: ReadonlySet<Operator> = new Set(['hasAllOf', 'isExactly']);

function valueWords(field: StoredField, condition: FilterCondition, names: FilterNames): string {
  const { locale } = names;
  const value = condition.value;
  if (typeof value === 'boolean') return say(value ? FILTER_COPY.checked : FILTER_COPY.unchecked, locale);
  if (typeof value === 'number') return formatValue(field, value, names);
  const location = LocationDistance.safeParse(value);
  if (location.success) {
    const distance = new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'kilometer',
      maximumFractionDigits: 2,
    }).format(location.data.km);
    return say(FILTER_COPY.distance, locale, {
      distance,
      place: `${location.data.lat}, ${location.data.lng}`,
    });
  }
  const target = DateTarget.safeParse(value);
  if (target.success) return targetWords(target.data, locale);
  const range = DateRange.safeParse(value);
  if (range.success) return rangeWords(range.data, locale);
  const ids = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : [];
  const each = (id: string): string => {
    switch (field.type) {
      case 'singleSelect':
      case 'multipleSelect':
        return choiceName(field, id);
      case 'user':
      case 'createdBy':
      case 'lastModifiedBy':
        return names.people.get(id)?.name ?? '';
      case 'link':
        if (!Array.isArray(value)) return say(FILTER_COPY.quoted, locale, { text: id });
        return names.records.get(id) || say(FILTER_COPY.hiddenRecord, locale);
      default:
        return say(FILTER_COPY.quoted, locale, { text: id });
    }
  };
  return listed(ids.map(each), locale, EVERY.has(condition.operator));
}

function conditionWords(field: StoredField, condition: FilterCondition, names: FilterNames): string {
  const { locale } = names;
  const operator = operatorWords(field, condition.operator, locale);
  if (condition.operator === 'isEmpty' || condition.operator === 'isNotEmpty')
    return say(FILTER_COPY.bare, locale, { field: field.name, operator });
  return say(FILTER_COPY.condition, locale, {
    field: field.name,
    operator,
    value: valueWords(field, condition, names),
  });
}

function groupWords(
  group: FilterGroup,
  fields: ReadonlyMap<string, StoredField>,
  names: FilterNames,
  nested: boolean,
): string | null {
  const parts: string[] = [];
  for (const condition of group.conditions) {
    if (isGroup(condition)) {
      const inner = groupWords(condition, fields, names, true);
      if (inner) parts.push(inner);
      continue;
    }
    const field = applies(condition, fields);
    if (field) parts.push(conditionWords(field, condition, names));
  }
  if (!parts.length) return null;
  const joiner = group.conjunction === 'and' ? FILTER_COPY.and : FILTER_COPY.or;
  const joined = parts
    .slice(1)
    .reduce((first, second) => say(joiner, names.locale, { first, second }), parts[0]!);
  return nested && parts.length > 1 ? say(FILTER_COPY.nested, names.locale, { conditions: joined }) : joined;
}

/** The filter in words, or null when nothing in it applies to this person. */
export function describeFilter(
  filter: FilterGroup | null,
  fields: ReadonlyMap<string, StoredField>,
  names: FilterNames,
): string | null {
  return filter ? groupWords(filter, fields, names, false) : null;
}
