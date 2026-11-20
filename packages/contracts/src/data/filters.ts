import { WHERE_TOKEN_LENGTH, WHERE_TOKEN_PATTERN } from './where-token.js';
export { isWhereToken } from './where-token.js';
import { z } from 'zod';
import {
  ChoiceId,
  FieldId,
  LIMITS,
  RecordId,
  UserId,
  type FieldMeta,
  type FieldType,
  type ResultType,
} from './fields.js';
import { isDateOnly } from './values.js';
import { parseTimeOfDay } from './more-field-values.js';

/**
 * View filters and sorts.  The server compiles them to SQL and clients edit them, so the rules for
 * which operators suit which field, and what value each needs, live here for both.
 *
 * Date conditions compare calendar days.  For fields that include a time, the day is taken in the
 * field's time zone, or in the viewer's when the field shows each person their own.
 *
 * Date ranges sort and compare by their start: `is`, `isBefore`, and the rest ask about the day a
 * range starts.  `isWithin` a period asks for the whole range inside it, `overlaps` a period for
 * any day of it, and `containsDate` for a range that includes the day (a `DateTarget`).  A
 * location `isWithin` a `LocationDistance` of a point, JSON `contains` text, signatures are only
 * empty or not, and buttons have no value to filter.
 */
export { OPERATORS, Operator, isGroup } from './filter-schema.js';
import { createFilterGroup, type Operator } from './filter-schema.js';

type Family =
  | 'multiCurrency'
  | 'time'
  | 'text'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'select'
  | 'multi'
  | 'user'
  | 'link'
  | 'users'
  | 'files'
  | 'dateRange'
  | 'json'
  | 'location'
  | 'signature'
  | 'none';

const FAMILY: Record<FieldType, Family> = {
  text: 'text',
  longText: 'text',
  email: 'text',
  url: 'text',
  phone: 'text',
  recordId: 'text',
  number: 'number',
  checkbox: 'checkbox',
  date: 'date',
  createdTime: 'date',
  lastModifiedTime: 'date',
  singleSelect: 'select',
  multipleSelect: 'multi',
  createdBy: 'user',
  lastModifiedBy: 'user',
  link: 'link',
  lineItems: 'link',
  // Computed from other records; `familyOf` refines these by the field's result type.
  lookup: 'text',
  rollup: 'number',
  count: 'number',
  formula: 'text',
  currency: 'number',
  percent: 'number',
  duration: 'number',
  rating: 'number',
  autoNumber: 'number',
  user: 'users',
  attachment: 'files',
  dateRange: 'dateRange',
  json: 'json',
  location: 'location',
  signature: 'signature',
  button: 'none',
  barcode: 'text',
  time: 'time',
  changeLog: 'none',
  multiCurrency: 'multiCurrency',
};

const BY_FAMILY: Record<Family, readonly Operator[]> = {
  multiCurrency: [
    'eq',
    'neq',
    'lt',
    'lte',
    'gt',
    'gte',
    'contains',
    'doesNotContain',
    'is',
    'isNot',
    'isEmpty',
    'isNotEmpty',
  ],
  time: ['is', 'isNot', 'isBefore', 'isAfter', 'isOnOrBefore', 'isOnOrAfter', 'isEmpty', 'isNotEmpty'],
  text: ['contains', 'doesNotContain', 'is', 'isNot', 'isEmpty', 'isNotEmpty'],
  number: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'isEmpty', 'isNotEmpty'],
  checkbox: ['is'],
  date: [
    'is',
    'isNot',
    'isBefore',
    'isAfter',
    'isOnOrBefore',
    'isOnOrAfter',
    'isWithin',
    'isEmpty',
    'isNotEmpty',
  ],
  select: ['is', 'isNot', 'isAnyOf', 'isNoneOf', 'isEmpty', 'isNotEmpty'],
  multi: ['hasAnyOf', 'hasAllOf', 'isExactly', 'hasNoneOf', 'isEmpty', 'isNotEmpty'],
  user: ['is', 'isNot', 'isAnyOf', 'isNoneOf', 'isEmpty', 'isNotEmpty'],
  link: ['contains', 'doesNotContain', 'hasAnyOf', 'hasNoneOf', 'isEmpty', 'isNotEmpty'],
  users: ['hasAnyOf', 'hasAllOf', 'isExactly', 'hasNoneOf', 'isEmpty', 'isNotEmpty'],
  /** `contains` matches file names */
  files: ['contains', 'doesNotContain', 'isEmpty', 'isNotEmpty'],
  dateRange: [
    'containsDate',
    'overlaps',
    'isWithin',
    'is',
    'isNot',
    'isBefore',
    'isAfter',
    'isOnOrBefore',
    'isOnOrAfter',
    'isEmpty',
    'isNotEmpty',
  ],
  /** `contains` matches the JSON text */
  json: ['contains', 'doesNotContain', 'isEmpty', 'isNotEmpty'],
  location: ['isWithin', 'isEmpty', 'isNotEmpty'],
  signature: ['isEmpty', 'isNotEmpty'],
  none: [],
};

const BY_RESULT: Record<ResultType, Family> = {
  number: 'number',
  text: 'text',
  boolean: 'checkbox',
  date: 'date',
  datetime: 'date',
  array: 'text',
};

/** A field's filter family, following the result type of lookups, rollups, and formulas. */
function familyOf(field: Pick<FieldMeta, 'type' | 'options'>): Family {
  if (field.type === 'lookup' || field.type === 'rollup' || field.type === 'formula') {
    return BY_RESULT[(field.options as { resultType: ResultType }).resultType];
  }
  return FAMILY[field.type];
}

/** The operators a field offers, following the result type of computed fields. */
export function operatorsForField(field: Pick<FieldMeta, 'type' | 'options'>): readonly Operator[] {
  return BY_FAMILY[familyOf(field)];
}

/** Current-record operands require scalar fields and operators that compare one value. */
export function canCompareCurrentField(
  field: Pick<FieldMeta, 'type' | 'options'>,
  operator: Operator,
): boolean {
  if (
    [
      'lookup',
      'link',
      'multipleSelect',
      'user',
      'attachment',
      'dateRange',
      'location',
      'signature',
      'button',
      'multiCurrency',
      'changeLog',
    ].includes(field.type)
  )
    return false;
  if ('resultType' in field.options && field.options.resultType === 'array') return false;
  return (
    operatorsForField(field).includes(operator) &&
    [
      'is',
      'isNot',
      'eq',
      'neq',
      'lt',
      'lte',
      'gt',
      'gte',
      'isBefore',
      'isAfter',
      'isOnOrBefore',
      'isOnOrAfter',
      'contains',
      'doesNotContain',
    ].includes(operator)
  );
}

/** The operators a field offers, in the order a menu should list them. */
export function operatorsFor(type: FieldType): readonly Operator[] {
  return BY_FAMILY[FAMILY[type]];
}

export const DateTarget = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('exactDate'), date: z.string().refine(isDateOnly) }),
  z.object({
    mode: z.enum([
      'today',
      'tomorrow',
      'yesterday',
      'oneWeekAgo',
      'oneWeekFromNow',
      'oneMonthAgo',
      'oneMonthFromNow',
    ]),
  }),
  z.object({ mode: z.enum(['daysAgo', 'daysFromNow']), days: z.number().int().min(0).max(100_000) }),
]);
export type DateTarget = z.infer<typeof DateTarget>;

export const DateRange = z.discriminatedUnion('mode', [
  z.object({ mode: z.enum(['pastWeek', 'pastMonth', 'pastYear', 'nextWeek', 'nextMonth', 'nextYear']) }),
  z.object({ mode: z.enum(['pastDays', 'nextDays']), days: z.number().int().min(1).max(100_000) }),
]);
export type DateRange = z.infer<typeof DateRange>;

/** Kilometers from a point, for a location's `isWithin`.  Half the way around the Earth is the most. */
export const LocationDistance = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  km: z.number().positive().max(20_040),
});
export type LocationDistance = z.infer<typeof LocationDistance>;

const ViewFilters = createFilterGroup(FieldId, LIMITS);
export const FilterCondition = ViewFilters.condition;
export interface FilterCondition {
  id: string;
  fieldId: string;
  operator: Operator;
  value?: unknown;
  currentFieldId?: string;
}
export interface FilterGroup {
  id?: string;
  conjunction: 'and' | 'or';
  conditions: Array<FilterCondition | FilterGroup>;
}

export const FilterGroup = ViewFilters.group;

export const Sort = z.object({ fieldId: FieldId, direction: z.enum(['asc', 'desc']) });
export type Sort = z.infer<typeof Sort>;

const NEEDS_NO_VALUE: readonly Operator[] = ['isEmpty', 'isNotEmpty'];

/**
 * Checks a condition against its field.  `usable` is false when the condition is still missing
 * something the person hasn't picked yet (it's ignored, not an error); `valid` is false when it
 * can never apply, such as an operator the field doesn't offer.
 */
export function checkCondition(
  field: FieldMeta | undefined,
  condition: FilterCondition,
): { valid: boolean; usable: boolean } {
  if (!field) return { valid: false, usable: false };
  if (!operatorsForField(field).includes(condition.operator)) return { valid: false, usable: false };
  if (NEEDS_NO_VALUE.includes(condition.operator)) return { valid: true, usable: true };
  const v = condition.value;
  if (v === undefined || v === null || v === '') return { valid: true, usable: false };
  const family = familyOf(field);
  const good = (() => {
    switch (family) {
      case 'time':
        return typeof v === 'string' && v.length === 8 && parseTimeOfDay(v) === v;
      case 'multiCurrency':
        return ['eq', 'neq', 'lt', 'lte', 'gt', 'gte'].includes(condition.operator)
          ? typeof v === 'number' && Number.isFinite(v)
          : typeof v === 'string' && v.length <= LIMITS.textLength;
      case 'text':
        return typeof v === 'string' && v.length <= LIMITS.textLength;
      case 'number':
        return typeof v === 'number' && Number.isFinite(v);
      case 'checkbox':
        return typeof v === 'boolean';
      case 'date':
        return condition.operator === 'isWithin'
          ? DateRange.safeParse(v).success
          : DateTarget.safeParse(v).success;
      case 'select':
        return condition.operator === 'is' || condition.operator === 'isNot'
          ? ChoiceId.safeParse(v).success
          : z.array(ChoiceId).min(1).max(LIMITS.choicesPerField).safeParse(v).success;
      case 'multi':
        return z.array(ChoiceId).min(1).max(LIMITS.choicesPerField).safeParse(v).success;
      case 'user':
        return condition.operator === 'is' || condition.operator === 'isNot'
          ? UserId.safeParse(v).success
          : z.array(UserId).min(1).max(1_000).safeParse(v).success;
      case 'link':
        return condition.operator === 'hasAnyOf' || condition.operator === 'hasNoneOf'
          ? z.array(RecordId).min(1).max(1_000).safeParse(v).success
          : typeof v === 'string' && v.length <= LIMITS.textLength;
      case 'users':
        return z.array(UserId).min(1).max(1_000).safeParse(v).success;
      case 'files':
      case 'json':
        return typeof v === 'string' && v.length <= LIMITS.textLength;
      case 'dateRange':
        return condition.operator === 'isWithin' || condition.operator === 'overlaps'
          ? DateRange.safeParse(v).success
          : DateTarget.safeParse(v).success;
      case 'location':
        return LocationDistance.safeParse(v).success;
      case 'signature':
      case 'none':
        return false;
    }
  })();
  return { valid: good, usable: good };
}

/**
 * A filter one person's read of a view adds to the view's own, such as the records behind a part
 * of a dashboard chart.  It's never saved: a link carries it as `where`, a token of URL-safe Base64
 * around the filter's JSON, and the view's rows, positions, searches, color ranges, and summary
 * row all read through it.  It can hold a tile's filter, the filter of the view the tile reads,
 * and a chart's part, so it allows more conditions and two more levels than a view's own.
 */
export const WHERE_LIMITS = {
  filterConditions: 8 * LIMITS.filterConditions,
  filterDepth: LIMITS.filterDepth + 2,
  /** Characters in a token, which keeps a request's address well under what servers accept */
  tokenLength: WHERE_TOKEN_LENGTH,
} as const;

const Where = createFilterGroup(FieldId, WHERE_LIMITS);
export const ViewWhere = Where.group;
export const WhereToken = z.string().min(1).max(WHERE_LIMITS.tokenLength).regex(WHERE_TOKEN_PATTERN);

/** A filter as a `where` token. */
export function encodeWhere(filter: FilterGroup): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(JSON.stringify(filter))) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** The filter a `where` token holds, or null when it isn't one. */
export function decodeWhere(token: string): FilterGroup | null {
  if (!WhereToken.safeParse(token).success) return null;
  try {
    const binary = atob(token.replaceAll('-', '+').replaceAll('_', '/'));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    );
    const parsed = ViewWhere.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
