import {
  checkCondition,
  parseTimeOfDay,
  EARTH_RADIUS_KM,
  FieldSpec,
  operatorsForField,
  isGroup,
  type DateRange,
  type DateTarget,
  type FilterCondition,
  type FilterGroup,
  type LocationDistance,
} from '@riosoma/contracts';
import { join, sql, type Sql } from '@riosoma/db';
import type { ReadContext, StoredField } from '../types.js';
import { attachmentFilter } from '../files/expressions.js';
import { columnRef } from './columns.js';
import { displayExpr, linkedSource, resultType } from './relations.js';
import { formulaScalar } from './formulas.js';

type DateField = Extract<StoredField, { type: 'date' | 'createdTime' | 'lastModifiedTime' }>;
type RangeField = Extract<StoredField, { type: 'dateRange' }>;

function isDateField(field: StoredField): field is DateField {
  return field.type === 'date' || field.type === 'createdTime' || field.type === 'lastModifiedTime';
}

function todayIn(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function shift(day: string, days = 0, months = 0): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  if (months !== 0) {
    const originalDay = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + months);
    const last = new Date(date);
    last.setUTCMonth(last.getUTCMonth() + 1, 0);
    // Calendar shifts clamp to the destination month's last day, including leap years.
    date.setUTCDate(Math.min(originalDay, last.getUTCDate()));
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function targetDay(target: DateTarget, today: string): string {
  switch (target.mode) {
    case 'exactDate':
      return target.date;
    case 'today':
      return today;
    case 'tomorrow':
      return shift(today, 1);
    case 'yesterday':
      return shift(today, -1);
    case 'oneWeekAgo':
      return shift(today, -7);
    case 'oneWeekFromNow':
      return shift(today, 7);
    case 'oneMonthAgo':
      return shift(today, 0, -1);
    case 'oneMonthFromNow':
      return shift(today, 0, 1);
    case 'daysAgo':
      return shift(today, -target.days);
    case 'daysFromNow':
      return shift(today, target.days);
  }
}

function rangeDays(range: DateRange, today: string): [string, string] {
  switch (range.mode) {
    case 'pastWeek':
      return [shift(today, -7), today];
    case 'pastMonth':
      return [shift(today, 0, -1), today];
    case 'pastYear':
      return [shift(today, 0, -12), today];
    case 'nextWeek':
      return [today, shift(today, 7)];
    case 'nextMonth':
      return [today, shift(today, 0, 1)];
    case 'nextYear':
      return [today, shift(today, 0, 12)];
    case 'pastDays':
      return [shift(today, -range.days), today];
    case 'nextDays':
      return [today, shift(today, range.days)];
  }
}

function emptyCell(field: StoredField, col = columnRef(field)): Sql {
  switch (field.type) {
    case 'text':
    case 'longText':
    case 'email':
    case 'url':
    case 'phone':
    case 'recordId':
    case 'singleSelect':
    case 'createdBy':
    case 'lastModifiedBy':
    case 'json':
      return sql`(${col} IS NULL OR ${col} = '')`;
    case 'attachment':
    case 'lineItems':
    case 'link':
    case 'user':
    case 'multipleSelect':
      return sql`(${col} IS NULL OR cardinality(${col}) = 0)`;
    default:
      return sql`${col} IS NULL`;
  }
}

function dateCondition(
  field: DateField,
  condition: FilterCondition,
  ctx: ReadContext,
  col = columnRef(field),
): Sql {
  const zone = field.options.timeZone === 'client' ? ctx.timeZone : field.options.timeZone;
  const day =
    field.type === 'date' && !field.options.includeTime ? col : sql`(${col} AT TIME ZONE ${zone})::date`;
  const today = todayIn(zone, ctx.now);
  if (condition.operator === 'isWithin') {
    const [start, end] = rangeDays(condition.value as DateRange, today);
    return sql`${day} BETWEEN ${start}::date AND ${end}::date`;
  }
  const target = targetDay(condition.value as DateTarget, today);
  switch (condition.operator) {
    case 'is':
      return sql`${day} = ${target}::date`;
    case 'isNot':
      return sql`(${col} IS NULL OR ${day} <> ${target}::date)`;
    case 'isBefore':
      return sql`${day} < ${target}::date`;
    case 'isAfter':
      return sql`${day} > ${target}::date`;
    case 'isOnOrBefore':
      return sql`${day} <= ${target}::date`;
    case 'isOnOrAfter':
      return sql`${day} >= ${target}::date`;
    default:
      return sql`TRUE`;
  }
}

/**
 * A date range's days: `containsDate` a day inside it, `overlaps` any day of a period, `isWithin`
 * every day inside one.  The rest ask about the day it starts, as a date field's conditions do.
 */
function rangeCondition(field: RangeField, condition: FilterCondition, ctx: ReadContext, col: Sql): Sql {
  const zone = field.options.timeZone === 'client' ? ctx.timeZone : field.options.timeZone;
  const first = field.options.includeTime
    ? sql`(lower(${col}) AT TIME ZONE ${zone})::date`
    : sql`lower(${col})`;
  const last = field.options.includeTime
    ? sql`(upper(${col}) AT TIME ZONE ${zone})::date`
    : sql`(upper(${col}) - 1)`;
  const today = todayIn(zone, ctx.now);
  if (condition.operator === 'isWithin' || condition.operator === 'overlaps') {
    const [start, end] = rangeDays(condition.value as DateRange, today);
    return condition.operator === 'isWithin'
      ? sql`(${first} >= ${start}::date AND ${last} <= ${end}::date)`
      : sql`(${first} <= ${end}::date AND ${last} >= ${start}::date)`;
  }
  if (condition.operator === 'containsDate') {
    const day = targetDay(condition.value as DateTarget, today);
    return sql`(${first} <= ${day}::date AND ${last} >= ${day}::date)`;
  }
  const start: DateField = { ...field, type: 'date', options: { ...field.options } };
  return dateCondition(start, condition, ctx, sql`lower(${col})`);
}

/** Great-circle distance from a point, on a sphere of the Earth's mean radius. */
function locationCondition(condition: FilterCondition, col: Sql): Sql {
  const { lat, lng, km } = condition.value as LocationDistance;
  const pointLat = sql`((${col}) ->> 'lat')::double precision`;
  const pointLng = sql`((${col}) ->> 'lng')::double precision`;
  const haversine = sql`power(sin(radians(${pointLat} - ${lat}::double precision) / 2), 2)
    + cos(radians(${lat}::double precision)) * cos(radians(${pointLat}))
    * power(sin(radians(${pointLng} - ${lng}::double precision) / 2), 2)`;
  return sql`(${col} IS NOT NULL AND 2 * ${EARTH_RADIUS_KM}::double precision
    * asin(least(1::double precision, sqrt(${haversine}))) <= ${km}::double precision)`;
}

function compileCondition(
  field: StoredField,
  condition: FilterCondition,
  ctx: ReadContext,
  col?: Sql,
  appSchema?: string,
  alias?: string,
): Sql {
  field = { ...field, readContext: ctx };
  col ??= field.type === 'formula' ? formulaScalar(field, alias, ctx) : columnRef(field, alias);
  if (
    field.type === 'lookup' ||
    field.type === 'rollup' ||
    field.type === 'count' ||
    field.type === 'formula'
  ) {
    const type = resultType(field);
    const spec = FieldSpec.parse(
      type === 'boolean'
        ? { type: 'checkbox' }
        : type === 'date' || type === 'datetime'
          ? {
              type: 'date',
              options: {
                includeTime: type === 'datetime',
                timeZone: field.type === 'formula' ? field.options.timeZone : 'client',
              },
            }
          : { type: type === 'number' ? 'number' : 'text' },
    );
    const virtual: StoredField = { ...field, ...spec };
    const typed = (value: Sql): Sql =>
      type === 'number'
        ? sql`(${value})::numeric`
        : type === 'boolean'
          ? sql`(${value})::boolean`
          : type === 'date'
            ? sql`(${value})::date`
            : type === 'datetime'
              ? sql`(${value})::timestamptz`
              : value;
    if (field.type === 'lookup' || type === 'array') {
      if (condition.operator === 'isEmpty') return sql`jsonb_array_length(${col}) = 0`;
      if (condition.operator === 'isNotEmpty') return sql`jsonb_array_length(${col}) > 0`;
      const negative =
        condition.operator === 'doesNotContain' ||
        condition.operator === 'isNot' ||
        condition.operator === 'neq';
      const positive = {
        ...condition,
        operator:
          condition.operator === 'doesNotContain'
            ? ('contains' as const)
            : condition.operator === 'isNot'
              ? ('is' as const)
              : condition.operator === 'neq'
                ? ('eq' as const)
                : condition.operator,
      };
      const matches = sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${col}) AS lookup_item(value)
        WHERE ${compileCondition(virtual, positive, ctx, typed(sql`lookup_item.value #>> '{}'`), undefined, alias)})`;
      return negative ? sql`NOT (${matches})` : matches;
    }
    return compileCondition(virtual, condition, ctx, typed(col));
  }
  if (
    field.type === 'attachment' &&
    (condition.operator === 'contains' || condition.operator === 'doesNotContain')
  ) {
    const found = attachmentFilter(appSchema, field, col, condition.value);
    return condition.operator === 'contains' ? found : sql`NOT (${found})`;
  }
  if (field.type === 'multiCurrency')
    col = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte'].includes(condition.operator)
      ? sql`(${col} ->> 'amount')::numeric`
      : sql`(${col} ->> 'code') || ' ' || (${col} ->> 'amount')`;
  const empty = emptyCell(field, col);
  if (
    (field.type === 'link' || field.type === 'lineItems') &&
    (condition.operator === 'contains' || condition.operator === 'doesNotContain')
  ) {
    const linked = linkedSource(field, alias);
    const primary = field.relation?.primary;
    const found =
      linked && primary
        ? sql`EXISTS (SELECT 1 ${linked.source}
      AND strpos(lower(${displayExpr(primary, linked.record)}), lower(${condition.value}::text)) > 0)`
        : sql`FALSE`;
    return condition.operator === 'contains' ? found : sql`NOT (${found})`;
  }
  const value =
    field.type === 'time' && typeof condition.value === 'string'
      ? parseTimeOfDay(condition.value)
      : condition.value;
  if (condition.operator === 'isEmpty') return empty;
  if (condition.operator === 'isNotEmpty') return sql`NOT (${empty})`;
  if (isDateField(field)) return dateCondition(field, condition, ctx, col);
  if (field.type === 'dateRange') return rangeCondition(field, condition, ctx, col);
  if (field.type === 'location') return locationCondition(condition, col);
  if (field.type === 'checkbox') return value ? sql`${col} IS TRUE` : sql`${col} IS NOT TRUE`;
  switch (condition.operator) {
    case 'contains':
      return sql`strpos(lower(${col}), lower(${value}::text)) > 0`;
    case 'doesNotContain':
      return sql`(${empty} OR strpos(lower(${col}), lower(${value}::text)) = 0)`;
    case 'is':
    case 'isNot': {
      const text =
        field.type !== 'singleSelect' && field.type !== 'createdBy' && field.type !== 'lastModifiedBy';
      const equal = text ? sql`lower(${col}) = lower(${value}::text)` : sql`${col} = ${value}`;
      return condition.operator === 'is' ? equal : sql`(${empty} OR NOT (${equal}))`;
    }
    case 'eq':
      return sql`${col} = ${value}`;
    case 'neq':
      return sql`(${empty} OR ${col} <> ${value})`;
    case 'isBefore':
    case 'lt':
      return sql`${col} < ${value}`;
    case 'isOnOrBefore':
    case 'lte':
      return sql`${col} <= ${value}`;
    case 'isAfter':
    case 'gt':
      return sql`${col} > ${value}`;
    case 'isOnOrAfter':
    case 'gte':
      return sql`${col} >= ${value}`;
    case 'isAnyOf':
      return sql`${col} = ANY(${value}::text[])`;
    case 'isNoneOf':
      return sql`(${empty} OR NOT (${col} = ANY(${value}::text[])))`;
    case 'hasAnyOf':
      return sql`${col} && ${value}::text[]`;
    case 'hasAllOf':
      return sql`${col} @> ${value}::text[]`;
    case 'isExactly':
      return sql`(${col} @> ${value}::text[] AND ${col} <@ ${value}::text[])`;
    case 'hasNoneOf':
      return sql`(${empty} OR NOT (${col} && ${value}::text[]))`;
    default:
      return sql`TRUE`;
  }
}

/**
 * A filter as SQL.  Conditions on fields that aren't in `fields` are left out, so passing only the
 * fields a person can see drops conditions on the rest.  `alias` names the record table when the
 * query gives it one.
 */
export function compileFilter(
  filter: FilterGroup | null | undefined,
  fields: ReadonlyMap<string, StoredField>,
  ctx: ReadContext,
  appSchema?: string,
  alias?: string,
): Sql {
  return (filter && compileGroup(filter, fields, ctx, appSchema, alias)) ?? sql`TRUE`;
}

/** Whether a condition applies: its field is one of `fields`, offers its operator, and has its value. */
function applies(condition: FilterCondition, fields: ReadonlyMap<string, StoredField>): boolean {
  const field = fields.get(condition.fieldId);
  return Boolean(
    field && operatorsForField(field).includes(condition.operator) && checkCondition(field, condition).usable,
  );
}

/**
 * The part of a filter that `compileFilter` applies with these fields, or null when none of it
 * does.  Passing the fields a person can see leaves out conditions on the rest, values and all.
 */
export function usableFilter(
  filter: FilterGroup | null | undefined,
  fields: ReadonlyMap<string, StoredField>,
): FilterGroup | null {
  if (!filter) return null;
  const conditions = filter.conditions.flatMap((condition): Array<FilterCondition | FilterGroup> => {
    if (!isGroup(condition)) return applies(condition, fields) ? [condition] : [];
    const nested = usableFilter(condition, fields);
    return nested ? [nested] : [];
  });
  return conditions.length ? { ...filter, conditions } : null;
}

/**
 * A group with nothing usable in it is left out rather than read as TRUE, which inside an `or`
 * group would match every record.
 */
function compileGroup(
  group: FilterGroup,
  fields: ReadonlyMap<string, StoredField>,
  ctx: ReadContext,
  appSchema?: string,
  alias?: string,
): Sql | null {
  const conditions: Sql[] = [];
  for (const condition of group.conditions) {
    if (isGroup(condition)) {
      const nested = compileGroup(condition, fields, ctx, appSchema, alias);
      if (nested) conditions.push(nested);
    } else if (applies(condition, fields)) {
      const field = fields.get(condition.fieldId)!;
      conditions.push(sql`(${compileCondition(field, condition, ctx, undefined, appSchema, alias)})`);
    }
  }
  return conditions.length === 0
    ? null
    : sql`(${join(conditions, group.conjunction === 'and' ? ' AND ' : ' OR ')})`;
}

export function filterUsesViewerTime(
  filter: FilterGroup | null | undefined,
  fields: ReadonlyMap<string, StoredField>,
): boolean {
  return (
    filter?.conditions.some((condition) => {
      if (isGroup(condition)) return filterUsesViewerTime(condition, fields);
      const field = fields.get(condition.fieldId);
      if (
        !field ||
        (!isDateField(field) &&
          field.type !== 'dateRange' &&
          !(
            ['lookup', 'rollup', 'formula'].includes(field.type) &&
            ['date', 'datetime'].includes(resultType(field))
          )) ||
        !checkCondition(field, condition).usable ||
        condition.operator === 'isEmpty' ||
        condition.operator === 'isNotEmpty'
      )
        return false;
      return (
        (!isDateField(field) && field.type !== 'dateRange') ||
        field.options.timeZone === 'client' ||
        (condition.value as DateTarget | DateRange).mode !== 'exactDate'
      );
    }) ?? false
  );
}
