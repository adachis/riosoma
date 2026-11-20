import {
  choicesForRecord,
  isTimeZone,
  type FieldMeta,
  type FieldOptionsOf,
  type FieldSpec,
  type FieldType,
} from './fields.js';
import { dayIn } from './conditions.js';
import { validateFieldValue } from './validation.js';
import { checkCellValue, idsOf, type CellValue } from './values.js';

/** Types whose fields can give new records a default value. */
export const DEFAULT_VALUE_TYPES = [
  'text',
  'number',
  'currency',
  'percent',
  'rating',
  'checkbox',
  'singleSelect',
  'multipleSelect',
  'date',
  'url',
  'email',
  'phone',
  'user',
] as const satisfies readonly FieldType[];
export type DefaultValueType = (typeof DEFAULT_VALUE_TYPES)[number];

/** A field's default, in the shape its type takes. */
export type FieldDefault = NonNullable<FieldOptionsOf<DefaultValueType>['defaultValue']>;
export type FieldDefaultKind = FieldDefault['kind'];

export function supportsDefault(type: FieldType): type is DefaultValueType {
  return (DEFAULT_VALUE_TYPES as readonly FieldType[]).includes(type);
}

/** The kinds of default a field of this type can have, in the order a picker offers them. */
export function defaultKinds(type: FieldType): FieldDefaultKind[] {
  if (!supportsDefault(type)) return [];
  if (type === 'user') return ['creator'];
  if (type === 'date') return ['value', 'today', 'now'];
  if (type === 'singleSelect') return ['value', 'firstChoice'];
  return ['value'];
}

type Spec = Pick<FieldSpec, 'type' | 'options'>;

/** The default a field holds in its options, if any. */
export function fieldDefault(field: Spec): FieldDefault | undefined {
  if (!supportsDefault(field.type)) return undefined;
  return (field.options as { defaultValue?: FieldDefault }).defaultValue;
}

/** The field with its default replaced, or taken out when `value` is undefined. */
export function withDefault<T extends Spec>(field: T, value: FieldDefault | undefined): T {
  const { defaultValue: _old, ...options } = field.options as Record<string, unknown>;
  return {
    ...field,
    options:
      value === undefined || !supportsDefault(field.type) ? options : { ...options, defaultValue: value },
  } as T;
}

/**
 * Why a field's default can't stay, as a message key, or null when it fits.  A default fits when
 * its kind suits the type, a fixed value is one the field accepts and its rules allow, and a chosen
 * option is still one of the field's own.  Unique fields, AI fields, and selects whose options come
 * from another table take no default.
 */
export function defaultIssue(field: Spec & { ai?: unknown }): string | null {
  const value = fieldDefault(field);
  if (!value) return null;
  const options = field.options as { unique?: boolean; source?: unknown; choices?: unknown[] };
  if (options.unique) return 'data.field.defaultUnique';
  if (field.ai || options.source) return 'data.field.defaultInvalid';
  if (!defaultKinds(field.type).includes(value.kind)) return 'data.field.defaultInvalid';
  if (value.kind === 'firstChoice') return options.choices?.length ? null : 'data.field.defaultInvalid';
  if (value.kind !== 'value') return null;
  const checked = checkCellValue(field as FieldMeta, value.value);
  if (!checked.ok || checked.value === null) return 'data.field.defaultInvalid';
  // A checkbox's rules can't be broken by a value it holds anyway.
  if (field.type !== 'checkbox' && validateFieldValue(field, checked.value))
    return 'data.field.defaultInvalid';
  return null;
}

/**
 * The field with its fixed default in the form the field stores values, such as a date and time in
 * UTC or a list of options without repeats.  Call it once `defaultIssue` finds nothing wrong.
 */
export function normalizedDefault<T extends Spec>(field: T): T {
  const value = fieldDefault(field);
  if (value?.kind !== 'value') return field;
  const checked = checkCellValue(field as unknown as FieldMeta, value.value);
  if (!checked.ok || checked.value === null) return field;
  return withDefault(field, { kind: 'value', value: checked.value } as FieldDefault);
}

/**
 * A default that survives a change to its field.  Options removed from a select drop out of its
 * default, and a default that no longer fits the field's type or options goes away.  Fixed values
 * move between types that hold them, such as one option becoming a list of one.
 */
export function keptDefault<T extends Spec & { ai?: unknown }>(field: T, value: FieldDefault | undefined): T {
  if (!value || !supportsDefault(field.type)) return withDefault(field, undefined);
  let next: FieldDefault = value;
  if (value.kind === 'value') {
    const choices = new Set(
      ((field.options as { choices?: Array<{ id: string }> }).choices ?? []).map((choice) => choice.id),
    );
    let item: unknown = value.value;
    if (field.type === 'multipleSelect') {
      const list = (Array.isArray(item) ? item : [item]).filter(
        (id): id is string => typeof id === 'string' && choices.has(id),
      );
      item = list.length ? list : undefined;
    } else if (field.type === 'singleSelect') {
      const list = (Array.isArray(item) ? item : [item]).filter(
        (id): id is string => typeof id === 'string' && choices.has(id),
      );
      item = list.length === 1 ? list[0] : undefined;
    } else if (Array.isArray(item)) item = undefined;
    if (item === undefined) return withDefault(field, undefined);
    next = { kind: 'value', value: item } as FieldDefault;
  }
  const candidate = withDefault(field, next);
  return defaultIssue(candidate) ? withDefault(field, undefined) : normalizedDefault(candidate);
}

/** What a default reads when a record is made: the time, who makes it, and their time zone. */
export interface DefaultContext {
  now: Date;
  /** The person making the record, or null when nobody signed in, such as a public form */
  userId: string | null;
  /** The person's IANA time zone, which decides the day for a field that follows each viewer */
  timeZone?: string;
}

/**
 * The value a new record takes in a field nobody gave a value, or undefined for none.  A date's
 * `today` and `now` give the day the record is made, in the field's own time zone or else the
 * person's, or the moment itself when the field includes a time.  `creator` needs a person.
 */
export function defaultCellValue(
  field: Spec & { ai?: unknown },
  context: DefaultContext,
): CellValue | undefined {
  const value = fieldDefault(field);
  if (!value || defaultIssue(field)) return undefined;
  switch (value.kind) {
    case 'value': {
      const checked = checkCellValue(field as FieldMeta, value.value);
      return checked.ok && checked.value !== null ? checked.value : undefined;
    }
    case 'firstChoice':
      return (field.options as FieldOptionsOf<'singleSelect'>).choices[0]?.id;
    case 'creator':
      return context.userId ? [context.userId] : undefined;
    case 'today':
    case 'now': {
      const options = field.options as FieldOptionsOf<'date'>;
      if (options.includeTime) return context.now.toISOString();
      const zone =
        options.timeZone !== 'client'
          ? options.timeZone
          : context.timeZone && isTimeZone(context.timeZone)
            ? context.timeZone
            : 'UTC';
      return dayIn(zone, context.now);
    }
  }
}

/** A form question nobody answered: left out, empty, or only spaces.  An unchecked box is an answer. */
export function unanswered(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

type DefaultedField = Spec & { id: string; ai?: unknown; source?: unknown };

/** How many selects up a field's chain of parent selects goes, so parents take defaults first. */
function depth(field: DefaultedField, byId: ReadonlyMap<string, DefaultedField>): number {
  let count = 0;
  let current: DefaultedField | undefined = field;
  while (current && count <= byId.size) {
    const cascade = (current.options as { cascade?: { fieldId: string } }).cascade;
    if (!cascade) break;
    current = byId.get(cascade.fieldId);
    count += 1;
  }
  return count;
}

/**
 * A new record's values with its fields' defaults where nobody gave a value.  A field left out of
 * `given` takes its default, and in a form, so does a question left blank, but a value someone gave
 * always stays, even an empty one outside a form.  A select that follows another select takes its
 * default only when the parent's value allows it.  Fields a source or an AI fills take none.
 * `values` are the record's checked values, which the result adds to.
 */
export function withDefaults(
  fields: readonly DefaultedField[],
  given: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, CellValue>>,
  context: DefaultContext,
  form = false,
): Record<string, CellValue> {
  const result = { ...values };
  const byId = new Map(fields.map((field) => [field.id, field]));
  const defaulted = fields
    .filter((field) => fieldDefault(field) && !field.source && !field.ai)
    .sort((a, b) => depth(a, byId) - depth(b, byId));
  for (const field of defaulted) {
    if (form ? !unanswered(given[field.id]) : Object.hasOwn(given, field.id)) continue;
    const value = defaultCellValue(field, context);
    if (value === undefined) continue;
    if (field.type === 'singleSelect' || field.type === 'multipleSelect') {
      const options = field.options as FieldOptionsOf<'singleSelect'>;
      if (options.cascade) {
        const allowed = new Set(choicesForRecord(options, result).map((choice) => choice.id));
        const chosen = typeof value === 'string' ? [value] : idsOf(value);
        if (!chosen.every((id) => allowed.has(id))) continue;
      }
    }
    result[field.id] = value;
  }
  return result;
}
