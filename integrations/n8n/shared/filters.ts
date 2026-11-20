import type { FieldMeta, FilterCondition, FilterGroup } from './types';
import { toBoolean, toDate, toNumber, type ValueContext } from './values';

/**
 * Filters for reading records.  The REST API takes a filter group that names fields by ID, and it
 * leaves out any condition it can't use rather than refusing it, since in the app that's a
 * condition someone is still typing.  Here a mistake would quietly widen a search or an upsert, so
 * conditions are checked against their fields before they're sent.
 */

export class FilterProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterProblem';
  }
}

type Family =
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

const FAMILY: Record<string, Family> = {
  text: 'text',
  longText: 'text',
  email: 'text',
  url: 'text',
  phone: 'text',
  recordId: 'text',
  number: 'number',
  currency: 'number',
  percent: 'number',
  duration: 'number',
  rating: 'number',
  autoNumber: 'number',
  count: 'number',
  checkbox: 'checkbox',
  date: 'date',
  createdTime: 'date',
  lastModifiedTime: 'date',
  singleSelect: 'select',
  multipleSelect: 'multi',
  createdBy: 'user',
  lastModifiedBy: 'user',
  link: 'link',
  user: 'users',
  attachment: 'files',
  dateRange: 'dateRange',
  json: 'json',
  location: 'location',
  signature: 'signature',
  button: 'none',
};

const BY_RESULT: Record<string, Family> = {
  number: 'number',
  text: 'text',
  boolean: 'checkbox',
  date: 'date',
  datetime: 'date',
  array: 'text',
};

const OPERATORS: Record<Family, readonly string[]> = {
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
  json: ['contains', 'doesNotContain', 'isEmpty', 'isNotEmpty'],
  location: ['isWithin', 'isEmpty', 'isNotEmpty'],
  signature: ['isEmpty', 'isNotEmpty'],
  none: [],
};

/** A field's filter family, following the result type of lookups, rollups, and formulas. */
function familyOf(field: FieldMeta): Family {
  if (field.type === 'lookup' || field.type === 'rollup' || field.type === 'formula')
    return BY_RESULT[String(field.options?.resultType ?? 'text')] ?? 'text';
  return FAMILY[field.type] ?? 'none';
}

export function operatorsFor(field: FieldMeta): readonly string[] {
  return OPERATORS[familyOf(field)];
}

const NO_VALUE = ['isEmpty', 'isNotEmpty'];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a condition's value has the form its field and operator need. */
function valueFits(family: Family, operator: string, value: unknown): boolean {
  const list = (check: (item: unknown) => boolean) =>
    Array.isArray(value) && value.length > 0 && value.every(check);
  const isText = (item: unknown) => typeof item === 'string' && item !== '';
  const isMode = typeof value === 'object' && value !== null && 'mode' in value;
  switch (family) {
    case 'text':
    case 'files':
    case 'json':
      return isText(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'checkbox':
      return typeof value === 'boolean';
    case 'date':
    case 'dateRange':
      return isMode;
    case 'select':
    case 'user':
      return operator === 'is' || operator === 'isNot' ? isText(value) : list(isText);
    case 'multi':
    case 'users':
      return list(isText);
    case 'link':
      return operator === 'hasAnyOf' || operator === 'hasNoneOf' ? list(isText) : isText(value);
    case 'location':
      return typeof value === 'object' && value !== null && 'km' in value;
    default:
      return false;
  }
}

function findField(fields: readonly FieldMeta[], key: unknown): FieldMeta | undefined {
  if (typeof key !== 'string') return undefined;
  return (
    fields.find((field) => field.id === key) ??
    fields.find((field) => field.name === key) ??
    fields.find((field) => field.name.toLowerCase() === key.trim().toLowerCase())
  );
}

function checkedCondition(
  raw: Record<string, unknown>,
  fields: readonly FieldMeta[],
  index: number,
): FilterCondition {
  const key = raw.fieldId ?? raw.field;
  const field = findField(fields, key);
  if (!field)
    throw new FilterProblem(`The filter names a field the table doesn't have: ${JSON.stringify(key)}.`);
  const operator = raw.operator;
  const allowed = operatorsFor(field);
  if (typeof operator !== 'string' || !allowed.includes(operator))
    throw new FilterProblem(
      `The filter uses ${JSON.stringify(operator)} on "${field.name}", which takes ${allowed.join(', ') || 'no conditions'}.`,
    );
  const condition: FilterCondition = {
    id: typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 32 ? raw.id : `c${index}`,
    fieldId: field.id,
    operator,
  };
  if (NO_VALUE.includes(operator)) return condition;
  const family = familyOf(field);
  let value = raw.value;
  // A date written as text reads as that day.
  if ((family === 'date' || family === 'dateRange') && typeof value === 'string' && DATE_ONLY.test(value))
    value = { mode: 'exactDate', date: value };
  if (!valueFits(family, operator, value))
    throw new FilterProblem(
      `The filter's condition on "${field.name}" with ${operator} needs a value of another form, but got ${JSON.stringify(value)}.`,
    );
  return { ...condition, value };
}

/**
 * A filter group ready to send: fields named by ID, name, or `field`, every condition checked
 * against its field, and IDs filled in where they're missing.
 */
export function resolveFilter(input: unknown, fields: readonly FieldMeta[]): FilterGroup {
  let counter = 0;
  const visit = (raw: unknown): FilterGroup => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new FilterProblem('A filter is a group with a conjunction and a list of conditions.');
    const group = raw as Record<string, unknown>;
    const conjunction = group.conjunction ?? 'and';
    if (conjunction !== 'and' && conjunction !== 'or')
      throw new FilterProblem('A filter group joins its conditions with "and" or "or".');
    if (!Array.isArray(group.conditions))
      throw new FilterProblem('A filter group needs a list of conditions.');
    return {
      conjunction,
      conditions: group.conditions.map((item: unknown) => {
        if (item && typeof item === 'object' && 'conditions' in item) return visit(item);
        if (!item || typeof item !== 'object') throw new FilterProblem('Each condition is an object.');
        return checkedCondition(item as Record<string, unknown>, fields, counter++);
      }),
    };
  };
  return visit(input);
}

/** Whether a field can find records by a value equal to one given. */
export function canMatch(field: FieldMeta): boolean {
  const family = familyOf(field);
  if (family === 'date') return field.type === 'date' && field.options?.includeTime !== true;
  return family === 'text' || family === 'number' || family === 'checkbox' || field.type === 'singleSelect';
}

/** A value to match on, read the way the field compares values. */
export function toMatchValue(field: FieldMeta, value: unknown, ctx: ValueContext): unknown {
  if (value === null || value === undefined || value === '')
    throw new FilterProblem(`Matching by "${field.name}" needs a value to look for.`);
  const family = familyOf(field);
  if (family === 'number') return toNumber(field, value);
  if (family === 'checkbox') return toBoolean(field, value);
  if (family === 'date')
    return toDate({ ...field, options: { ...field.options, includeTime: false } }, value, ctx);
  if (value && typeof value === 'object' && 'name' in value) return String(value.name);
  return String(value);
}

/** The condition that finds records whose field equals a value, already written in API form. */
export function matchCondition(field: FieldMeta, value: unknown): FilterCondition {
  if (!canMatch(field))
    throw new FilterProblem(
      `Records can't be matched by "${field.name}".  Match by a text, number, checkbox, date, or single select field.`,
    );
  if (value === null || value === undefined || value === '')
    throw new FilterProblem(`Matching by "${field.name}" needs a value to look for.`);
  const family = familyOf(field);
  const base = { id: 'match', fieldId: field.id };
  if (family === 'number') return { ...base, operator: 'eq', value: Number(value) };
  if (family === 'checkbox') return { ...base, operator: 'is', value: value === true };
  if (family === 'date')
    return { ...base, operator: 'is', value: { mode: 'exactDate', date: String(value) } };
  return { ...base, operator: 'is', value: String(value) };
}

/**
 * Whether a record's value equals the one matched on, the way Riosoma compares them: text and
 * option names without regard to case, numbers as numbers, and dates by the day.
 */
export function sameValue(field: FieldMeta, recordValue: unknown, wanted: unknown): boolean {
  const family = familyOf(field);
  if (family === 'number') return recordValue !== null && Number(recordValue) === Number(wanted);
  if (family === 'checkbox') return (recordValue === true) === (wanted === true);
  if (family === 'date')
    return typeof recordValue === 'string' && recordValue.slice(0, 10) === String(wanted);
  if (field.type === 'singleSelect')
    return (
      String(recordValue ?? '')
        .trim()
        .toLowerCase() === String(wanted).trim().toLowerCase()
    );
  return String(recordValue ?? '').toLowerCase() === String(wanted).toLowerCase();
}

/** Whether a single select has an option with this name, as the server resolves names. */
export function hasChoice(field: FieldMeta, name: unknown): boolean {
  if (field.type !== 'singleSelect') return true;
  const wanted = String(name).trim().toLowerCase();
  return (field.options?.choices ?? []).some((choice) => choice.name.trim().toLowerCase() === wanted);
}
