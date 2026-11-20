import { isMultiCurrencyValue } from './compound-values.js';
import { multiCurrencyText, parseTimeOfDay } from './more-field-values.js';
import { distanceKm } from './compound-values.js';
import type { FieldMeta, ResultType } from './fields.js';
import {
  checkCondition,
  isGroup,
  type DateRange,
  type DateTarget,
  type FilterCondition,
  type FilterGroup,
  type LocationDistance,
} from './filters.js';
import { cellValue, type RowData } from './rows.js';
import { idsOf, isDateRangeValue, isLocationValue, type CellValue } from './values.js';

/**
 * Tests one record against filter conditions in the browser, answering exactly as the server's SQL
 * filter does for the same values.  Color rules use it, so a rule reading "Status is Done" colors
 * exactly the records a "Status is Done" filter would admit.  The server compiles the same rules
 * in `apps/server/src/data/physical/filters.ts`, and a test there checks both give the same answer
 * for every operator and field type.
 */
export interface ConditionContext {
  /** A conditional lookup compares its linked row with these current-record values. */
  currentValue?: (fieldId: string) => CellValue;
  /** The viewer's IANA time zone, for date fields that show each person their own time */
  timeZone: string;
  /** The moment relative dates such as "today" count from */
  now: Date;
  /** A linked record's display text, for `contains` on links.  Records without one never match. */
  linkedName?: (recordId: string) => string | undefined;
  /** A file's name, for `contains` on attachments.  Files without one never match. */
  fileName?: (attachmentId: string) => string | undefined;
}

/** How the filter treats a field's values, following the result type of computed fields. */
type Shape =
  | { kind: 'text'; exact: boolean }
  | { kind: 'number' }
  | { kind: 'checkbox' }
  | { kind: 'date'; includeTime: boolean; timeZone: string }
  | { kind: 'dateRange'; includeTime: boolean; timeZone: string }
  | { kind: 'location' }
  | { kind: 'list' }
  | { kind: 'link' }
  | { kind: 'files' };

const TEXT: Shape = { kind: 'text', exact: false };
/** Choice and person IDs compare exactly, where typed text ignores case. */
const EXACT: Shape = { kind: 'text', exact: true };
const NUMBER: Shape = { kind: 'number' };
const CHECKBOX: Shape = { kind: 'checkbox' };
const LIST: Shape = { kind: 'list' };

function shapeOf(field: FieldMeta): Shape {
  switch (field.type) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'duration':
    case 'rating':
    case 'autoNumber':
      return NUMBER;
    case 'checkbox':
      return CHECKBOX;
    case 'date':
      return { kind: 'date', includeTime: field.options.includeTime, timeZone: field.options.timeZone };
    case 'createdTime':
    case 'lastModifiedTime':
      // Created and modified times are always moments, whatever the field shows.
      return { kind: 'date', includeTime: true, timeZone: field.options.timeZone };
    case 'dateRange':
      return { kind: 'dateRange', includeTime: field.options.includeTime, timeZone: field.options.timeZone };
    case 'location':
      return { kind: 'location' };
    case 'singleSelect':
    case 'createdBy':
    case 'lastModifiedBy':
      return EXACT;
    case 'multipleSelect':
    case 'user':
      return LIST;
    case 'lineItems':
    case 'link':
      return { kind: 'link' };
    case 'attachment':
      return { kind: 'files' };
    default:
      return TEXT;
  }
}

/** The result type of a field computed from others, or null for a stored field. */
function computedType(field: FieldMeta): ResultType | null {
  switch (field.type) {
    case 'lookup':
    case 'rollup':
    case 'formula':
      return field.options.resultType;
    case 'count':
      return 'number';
    default:
      return null;
  }
}

function computedShape(field: FieldMeta, type: ResultType): Shape {
  switch (type) {
    case 'boolean':
      return CHECKBOX;
    case 'date':
    case 'datetime':
      return {
        kind: 'date',
        includeTime: type === 'datetime',
        timeZone: field.type === 'formula' ? field.options.timeZone : 'client',
      };
    case 'number':
      return NUMBER;
    default:
      return TEXT;
  }
}

/** Operators a list of computed values negates: "doesn't contain" means no item contains. */
const NEGATED: Partial<Record<FilterCondition['operator'], FilterCondition['operator']>> = {
  doesNotContain: 'contains',
  isNot: 'is',
  neq: 'eq',
};

/** Empty as the filter sees it: no value, no text, or an empty list.  Unchecked is not empty. */
function blank(value: CellValue | undefined): boolean {
  return (
    value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
  );
}

function textOf(value: CellValue): string | null {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : null;
}

function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function includesText(haystack: string | null | undefined, needle: unknown): boolean {
  return typeof haystack === 'string' && haystack.toLowerCase().includes(String(needle ?? '').toLowerCase());
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** The calendar day, `YYYY-MM-DD`, that a moment falls on in a time zone. */
export function dayIn(timeZone: string, moment: Date): string {
  let format = dayFormats.get(timeZone);
  if (!format) {
    if (dayFormats.size > 64) dayFormats.clear();
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormats.set(timeZone, format);
  }
  const parts = format.formatToParts(moment);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Moves a day by days and calendar months, clamping to the destination month's last day. */
function shift(day: string, days = 0, months = 0): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  if (months !== 0) {
    const originalDay = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + months);
    const last = new Date(date);
    last.setUTCMonth(last.getUTCMonth() + 1, 0);
    date.setUTCDate(Math.min(originalDay, last.getUTCDate()));
  }
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The day a date condition's target names, counting from `today`. */
export function targetDay(target: DateTarget, today: string): string {
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

/** The first and last days of a date condition's period, counting from `today`. */
export function rangeDays(range: DateRange, today: string): [string, string] {
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

/** The calendar day a stored date falls on: the date itself, or a moment's day in the time zone. */
function dayOf(value: CellValue, includeTime: boolean, timeZone: string): string | null {
  if (typeof value !== 'string' || value === '') return null;
  if (!includeTime || DATE_ONLY.test(value)) return value.slice(0, 10);
  const moment = new Date(value);
  return Number.isNaN(moment.getTime()) ? null : dayIn(timeZone, moment);
}

function matchesDate(
  shape: Extract<Shape, { kind: 'date' }>,
  value: CellValue,
  condition: FilterCondition,
  context: ConditionContext,
): boolean {
  const timeZone = shape.timeZone === 'client' ? context.timeZone : shape.timeZone;
  const day = dayOf(value, shape.includeTime, timeZone);
  const today = dayIn(timeZone, context.now);
  if (condition.operator === 'isWithin') {
    const [start, end] = rangeDays(condition.value as DateRange, today);
    return day !== null && day >= start && day <= end;
  }
  const target = targetDay(condition.value as DateTarget, today);
  switch (condition.operator) {
    case 'is':
      return day === target;
    case 'isNot':
      return day === null || day !== target;
    case 'isBefore':
      return day !== null && day < target;
    case 'isAfter':
      return day !== null && day > target;
    case 'isOnOrBefore':
      return day !== null && day <= target;
    case 'isOnOrAfter':
      return day !== null && day >= target;
    default:
      return true;
  }
}

/**
 * A date range's days: `containsDate` a day inside it, `overlaps` any day of a period, and
 * `isWithin` every day inside one.  The rest ask about the day it starts, as a date's conditions do.
 */
function matchesRange(
  shape: Extract<Shape, { kind: 'dateRange' }>,
  value: CellValue,
  condition: FilterCondition,
  context: ConditionContext,
): boolean {
  const range = isDateRangeValue(value) ? value : null;
  const start = { kind: 'date' as const, includeTime: shape.includeTime, timeZone: shape.timeZone };
  const { operator } = condition;
  if (operator !== 'isWithin' && operator !== 'overlaps' && operator !== 'containsDate')
    return matchesDate(start, range?.start ?? null, condition, context);
  if (!range) return false;
  const timeZone = shape.timeZone === 'client' ? context.timeZone : shape.timeZone;
  const first = dayOf(range.start, shape.includeTime, timeZone);
  const last = dayOf(range.end, shape.includeTime, timeZone);
  if (first === null || last === null) return false;
  const today = dayIn(timeZone, context.now);
  if (operator === 'containsDate') {
    const day = targetDay(condition.value as DateTarget, today);
    return first <= day && last >= day;
  }
  const [from, to] = rangeDays(condition.value as DateRange, today);
  return operator === 'isWithin' ? first >= from && last <= to : first <= to && last >= from;
}

function matchesShape(
  shape: Shape,
  value: CellValue,
  condition: FilterCondition,
  context: ConditionContext,
): boolean {
  const { operator } = condition;
  const target = condition.value;
  const empty = blank(value);
  if (operator === 'isEmpty') return empty;
  if (operator === 'isNotEmpty') return !empty;
  if (shape.kind === 'date') return matchesDate(shape, value, condition, context);
  if (shape.kind === 'dateRange') return matchesRange(shape, value, condition, context);
  // A location is within a distance of a point, measured along the Earth's surface.
  if (shape.kind === 'location')
    return (
      isLocationValue(value) &&
      distanceKm(target as LocationDistance, value) <= (target as LocationDistance).km
    );
  if (shape.kind === 'checkbox') return target ? value === true : value !== true;
  if (
    (shape.kind === 'link' || shape.kind === 'files') &&
    (operator === 'contains' || operator === 'doesNotContain')
  ) {
    // Links match their records' display text, and attachments their file names.
    const name = shape.kind === 'link' ? context.linkedName : context.fileName;
    const found = idsOf(value).some((id) => includesText(name?.(id), target));
    return operator === 'contains' ? found : !found;
  }
  const text = isMultiCurrencyValue(value) ? multiCurrencyText(value) : textOf(value);
  const number = isMultiCurrencyValue(value) ? value.amount : numberOf(value);
  const list = listOf(target);
  const items = Array.isArray(value) ? value : [];
  switch (operator) {
    case 'contains':
      return includesText(text, target);
    case 'doesNotContain':
      return empty || !includesText(text, target);
    case 'is':
    case 'isNot': {
      const equal =
        shape.kind === 'text' && shape.exact
          ? value === target
          : text !== null && text.toLowerCase() === String(target).toLowerCase();
      return operator === 'is' ? equal : empty || !equal;
    }
    case 'eq':
      return number !== null && number === numberOf(target);
    case 'neq':
      return empty || number !== numberOf(target);
    case 'lt':
      return number !== null && number < Number(target);
    case 'lte':
      return number !== null && number <= Number(target);
    case 'gt':
      return number !== null && number > Number(target);
    case 'gte':
      return number !== null && number >= Number(target);
    case 'isAnyOf':
      return typeof value === 'string' && list.includes(value);
    case 'isNoneOf':
      return empty || !(typeof value === 'string' && list.includes(value));
    case 'hasAnyOf':
      return items.some((item) => list.includes(item));
    case 'hasAllOf':
      return items.length > 0 && list.every((item) => items.includes(item as string));
    case 'isExactly':
      return (
        items.length > 0 &&
        list.every((item) => items.includes(item as string)) &&
        items.every((item) => list.includes(item))
      );
    case 'hasNoneOf':
      return empty || !items.some((item) => list.includes(item));
    default:
      return true;
  }
}

/**
 * Whether a value meets a condition on its field, as the view's filter would decide.  A condition
 * that can't apply yet (an operator the field lacks, or a value still missing) matches nothing.
 */
export function conditionMatches(
  field: FieldMeta,
  value: CellValue,
  condition: FilterCondition,
  context: ConditionContext,
): boolean {
  if (condition.currentFieldId) {
    if (!context.currentValue || condition.fieldId !== field.id) return false;
    let a = value,
      b = context.currentValue(condition.currentFieldId);
    const operator = condition.operator;
    if (['is', 'isNot', 'contains', 'doesNotContain'].includes(operator)) {
      if (typeof a === 'string') a = a.toLowerCase();
      if (typeof b === 'string') b = b.toLowerCase();
    }
    const same = a === b;
    if (operator === 'is' || operator === 'eq') return same;
    if (operator === 'isNot' || operator === 'neq') return !same;
    if (operator === 'contains' || operator === 'doesNotContain') {
      const found = typeof a === 'string' && typeof b === 'string' && a.includes(b);
      return operator === 'contains' ? found : !found;
    }
    if (a === null || b === null || typeof a !== typeof b || typeof a === 'object' || typeof b === 'object')
      return false;
    if (operator === 'lt' || operator === 'isBefore') return a < b;
    if (operator === 'lte' || operator === 'isOnOrBefore') return a <= b;
    if (operator === 'gt' || operator === 'isAfter') return a > b;
    if (operator === 'gte' || operator === 'isOnOrAfter') return a >= b;
    return false;
  }
  if (condition.fieldId !== field.id || !checkCondition(field, condition).usable) return false;
  if (field.type === 'time' && !['isEmpty', 'isNotEmpty'].includes(condition.operator)) {
    const target = parseTimeOfDay(String(condition.value))!;
    if (condition.operator === 'isNot') return value === null || value !== target;
    if (typeof value !== 'string') return false;
    switch (condition.operator) {
      case 'is':
        return value === target;
      case 'isBefore':
        return value < target;
      case 'isAfter':
        return value > target;
      case 'isOnOrBefore':
        return value <= target;
      case 'isOnOrAfter':
        return value >= target;
    }
  }
  const computed = computedType(field);
  if (computed === null) return matchesShape(shapeOf(field), value, condition, context);
  const shape = computedShape(field, computed);
  if (field.type !== 'lookup' && computed !== 'array') return matchesShape(shape, value, condition, context);
  // A list of values matches when any item does, and a negative condition when none does.
  const items = Array.isArray(value) ? value : [];
  if (condition.operator === 'isEmpty') return items.length === 0;
  if (condition.operator === 'isNotEmpty') return items.length > 0;
  const positive = NEGATED[condition.operator];
  const test = positive ? { ...condition, operator: positive } : condition;
  const found = items.some((item) => matchesShape(shape, item, test, context));
  return positive ? !found : found;
}

function groupMatches(
  group: FilterGroup,
  fields: ReadonlyMap<string, FieldMeta>,
  valueOf: (field: FieldMeta) => CellValue,
  context: ConditionContext,
): boolean | null {
  const results: boolean[] = [];
  for (const condition of group.conditions) {
    if (isGroup(condition)) {
      const nested = groupMatches(condition, fields, valueOf, context);
      if (nested !== null) results.push(nested);
    } else {
      const field = fields.get(condition.fieldId);
      if (field && (condition.currentFieldId || checkCondition(field, condition).usable))
        results.push(conditionMatches(field, valueOf(field), condition, context));
    }
  }
  // A group with nothing usable in it is left out, as the server leaves it out of its SQL.
  if (!results.length) return null;
  return group.conjunction === 'and' ? results.every(Boolean) : results.some(Boolean);
}

/** Whether a whole filter admits the values `valueOf` reads, skipping what can't apply yet. */
export function matchesFilter(
  filter: FilterGroup | null | undefined,
  fields: ReadonlyMap<string, FieldMeta>,
  valueOf: (field: FieldMeta) => CellValue,
  context: ConditionContext,
): boolean {
  return (filter && groupMatches(filter, fields, valueOf, context)) ?? true;
}

/** Whether a view's filter admits a record. */
export function recordMatchesFilter(
  row: RowData,
  filter: FilterGroup | null | undefined,
  fields: ReadonlyMap<string, FieldMeta>,
  context: ConditionContext,
): boolean {
  return matchesFilter(filter, fields, (field) => cellValue(row, field), context);
}
