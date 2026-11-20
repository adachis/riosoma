import { IngestField } from '../ingest-fields.js';
import { newId } from '../ids.js';
import { FIELD_TYPES } from './field-types.js';
import { z } from 'zod';
import { createFilterGroup } from './filter-schema.js';
import {
  RequiredValidation,
  TextValidation,
  PatternValidation,
  NumberValidation,
  DateValidation,
} from './validation.js';
import { FieldSource } from '../source-refs.js';
import { AiFieldSettings } from './ai-fields.js';

/**
 * Field types and their options.  A field's type decides its Postgres column, the values it
 * accepts, how it filters and sorts, and which editor opens.  See docs/architecture/data-core.md.
 */
export { FIELD_TYPES } from './field-types.js';
export const FieldType = z.enum(FIELD_TYPES);
export type FieldType = z.infer<typeof FieldType>;

/**
 * Types whose values Riosoma fills in itself, and the button, which holds no value at all.
 * Commands can't write to them, and forms never ask them.
 */
export const COMPUTED_FIELD_TYPES = [
  'changeLog',
  'createdTime',
  'lastModifiedTime',
  'createdBy',
  'lastModifiedBy',
  'recordId',
  'lookup',
  'rollup',
  'count',
  'formula',
  'autoNumber',
  'button',
] as const satisfies readonly FieldType[];

/** Types a table's primary field may have. */
export const PRIMARY_FIELD_TYPES = [
  'text',
  'number',
  'date',
  'email',
  'url',
  'phone',
  'createdTime',
  'lastModifiedTime',
  'recordId',
  'formula',
  'currency',
  'percent',
  'duration',
  'autoNumber',
] as const satisfies readonly FieldType[];

export function isComputedType(type: FieldType): boolean {
  return (COMPUTED_FIELD_TYPES as readonly FieldType[]).includes(type);
}

export function isPrimaryType(type: FieldType): boolean {
  return (PRIMARY_FIELD_TYPES as readonly FieldType[]).includes(type);
}

const TEXTUAL: readonly FieldType[] = [
  'barcode',
  'time',
  'changeLog',
  'text',
  'longText',
  'email',
  'url',
  'phone',
  'recordId',
  'formula',
];
const PLAIN_JSON: readonly FieldType[] = [
  'number',
  'currency',
  'percent',
  'duration',
  'rating',
  'autoNumber',
  'checkbox',
];
const MOMENTS: readonly FieldType[] = ['date', 'createdTime', 'lastModifiedTime'];

/**
 * Whether a field can change from one type to another.  Nothing becomes a signature, which only
 * a person can make, and a signature only becomes text.  JSON and locations trade values with
 * text, and JSON also takes numbers and checkboxes.  Date ranges trade values with text and dates.
 * A button holds nothing, so any field can become one and it can become anything.  The other
 * types convert as they always have.  The server refuses the rest with `data.field.cannotConvert`.
 */
export function canConvert(from: FieldType, to: FieldType): boolean {
  if (from === 'lineItems' || to === 'lineItems') return from === to;
  if (from === to || from === 'button' || to === 'button') return true;
  if (from === 'changeLog' || to === 'changeLog') return false;
  if (from === 'multiCurrency') return to === 'text' || to === 'longText';
  if (to === 'multiCurrency') return TEXTUAL.includes(from) || from === 'number' || from === 'currency';
  if (to === 'signature') return false;
  if (from === 'signature' || from === 'json' || from === 'location')
    return to === 'text' || to === 'longText';
  if (from === 'dateRange') return to === 'text' || to === 'longText' || to === 'date';
  if (to === 'json') return TEXTUAL.includes(from) || PLAIN_JSON.includes(from);
  if (to === 'location') return TEXTUAL.includes(from);
  if (to === 'dateRange') return TEXTUAL.includes(from) || MOMENTS.includes(from);
  return true;
}

export const LIMITS = {
  nameLength: 255,
  descriptionLength: 10_000,
  fieldsPerTable: 500,
  choicesPerField: 1_000,
  cascadeEntries: 10_000,
  textLength: 100_000,
  longTextLength: 1_000_000,
  emailLength: 320,
  urlLength: 2_048,
  phoneLength: 64,
  recordsPerCommand: 1_000,
  linksPerCell: 10_000,
  usersPerCell: 1_000,
  attachmentsPerCell: 1_000,
  commandsPerRequest: 100,
  pageSize: 500,
  sortsPerView: 10,
  filterConditions: 50,
  filterDepth: 3,
  initialFields: 50,
  initialRecords: 10,
  commentLength: 10_000,
  /** Characters of a JSON field's text, once its spacing is taken out */
  jsonLength: 100_000,
  locationLabelLength: 1_000,
  /** Characters of a drawn signature's path data */
  signaturePathLength: 32_000,
  /** Pixels on each side of the pad a signature was drawn on */
  signatureSize: 4_000,
  buttonLabelLength: 100,
  urlTemplateLength: 2_048,
} as const;

/** Colors for choices, checkboxes, databases, and presence.  Themes supply each one's shades. */
export const CHOICE_COLORS = [
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'brown',
] as const;
export const ChoiceColor = z.enum(CHOICE_COLORS);
export type ChoiceColor = z.infer<typeof ChoiceColor>;

const idOf = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[0-9A-Za-z]{14}$`));
export const DatabaseId = idOf('db');
export const TableId = idOf('tbl');
export const FieldId = idOf('fld');
export const FieldFilters = createFilterGroup(FieldId, LIMITS, true);
export const ViewId = idOf('viw');
export const RecordId = idOf('rec');
export const ChoiceId = idOf('cho');
export const CommandId = idOf('cmd');
export const ActionId = idOf('act');
export const ClientId = idOf('cli');
export const UserId = idOf('usr');
export const AttachmentId = idOf('att');

export const Name = z.string().trim().min(1).max(LIMITS.nameLength);
export const Description = z.string().max(LIMITS.descriptionLength);

export const Choice = z.object({
  id: ChoiceId,
  name: Name,
  color: ChoiceColor,
});
export type Choice = z.infer<typeof Choice>;

/** True when the runtime knows the IANA time zone, e.g. `America/Chicago` or `UTC`. */
export function isTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** `client` shows each person times in their own time zone. */
export const FieldTimeZone = z.union([
  z.literal('client'),
  z.string().refine(isTimeZone, { message: 'unknown time zone' }),
]);
export const DateFormat = z.enum(['local', 'friendly', 'us', 'european', 'iso']);
export const TimeFormat = z.enum(['local', '12h', '24h']);

/** What a rollup does with the values it reads through a link. */
export const ROLLUP_FUNCTIONS = [
  'sum',
  'average',
  'min',
  'max',
  'count',
  'countAll',
  'countUnique',
  'and',
  'or',
  'concatenate',
  'arrayUnique',
  'earliest',
  'latest',
] as const;
export const RollupFunction = z.enum(ROLLUP_FUNCTIONS);
export type RollupFunction = z.infer<typeof RollupFunction>;

/**
 * The kind of value a computed field produces.  The server works it out from what the field reads
 * and stores it in the field's options, so clients know how to show, filter, and sort it.
 */
export const RESULT_TYPES = ['number', 'text', 'boolean', 'date', 'datetime', 'array'] as const;
export const ResultType = z.enum(RESULT_TYPES);
export type ResultType = z.infer<typeof ResultType>;

const Precision = z.number().int().min(0).max(8).nullable().default(null);

/** True when the runtime knows the ISO 4217 currency code, e.g. `USD` or `EUR`. */
export function isCurrencyCode(value: string): boolean {
  return /^[A-Z]{3}$/.test(value) && Intl.supportedValuesOf('currency').includes(value);
}

export const DURATION_FORMATS = ['h:mm', 'h:mm:ss', 'h:mm:ss.s', 'h:mm:ss.ss', 'h:mm:ss.sss'] as const;
export const RATING_ICONS = ['star', 'heart', 'thumbsUp', 'flag', 'circle'] as const;

/** What pressing a button does.  Runs use the person's existing execution permissions. */
export const ButtonAction = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('runAutomation'),
    automationId: idOf('aut'),
    allowConditionalTriggers: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('runScript'), scriptId: idOf('scr') }),
  z.object({
    kind: z.literal('openUrl'),
    /**
     * The link, with a field's value wherever the field appears in braces, like
     * `https://example.com/orders/{fld…}`.  Braces may name a field on the way in, and the server
     * stores its ID, so renaming the field keeps the button working, and clients show names.  A
     * field at the very start is used as it is, so a URL field can supply the whole link.  Anywhere
     * else its value is encoded.  The filled link opens in a new tab, and only when it's `http` or
     * `https`.
     */
    urlTemplate: z.string().trim().max(LIMITS.urlTemplateLength).default(''),
  }),
]);
export type ButtonAction = z.infer<typeof ButtonAction>;

const Empty = z.object({});
const Choices = z
  .array(Choice)
  .max(LIMITS.choicesPerField)
  .refine((list) => new Set(list.map((c) => c.id)).size === list.length, { message: 'duplicate choice' });

const required = { validation: RequiredValidation.optional() };
const unique = { unique: z.boolean().optional() };

/**
 * What a new record holds in a field nobody gave a value.  `value` is a value of the field's own
 * type, as the API writes it.  A date can instead take `today` or `now`, which give the day the
 * record is made, or the moment when the field includes a time.  A user field takes `creator`, the
 * person who makes the record, and a single select can take `firstChoice`, its first option.  A
 * single select's value is one option's ID, and a multiple select's is a list of them.
 * Defaults apply only when a record is created, never when one changes.  `defaults.ts` applies
 * them and decides which ones fit a field.
 */
const valueDefault = <T extends z.ZodType>(value: T) => z.object({ kind: z.literal('value'), value });
const TextDefault = valueDefault(z.string().min(1).max(LIMITS.textLength));
const NumberDefault = valueDefault(z.number().finite());
const CheckboxDefault = valueDefault(z.boolean());
const DateDefault = z.discriminatedUnion('kind', [
  valueDefault(z.string().min(1).max(64)),
  z.object({ kind: z.literal('today') }),
  z.object({ kind: z.literal('now') }),
]);
/** One option for a single select, and a list of them for a multiple select */
const SelectDefault = z.discriminatedUnion('kind', [
  valueDefault(z.union([ChoiceId, z.array(ChoiceId).min(1).max(LIMITS.choicesPerField)])),
  z.object({ kind: z.literal('firstChoice') }),
]);
const UserDefault = z.object({ kind: z.literal('creator') });
const defaultOf = <T extends z.ZodType>(schema: T) => ({ defaultValue: schema.optional() });

export const SELECT_SOURCE_TYPES = [
  ...PRIMARY_FIELD_TYPES,
  'longText',
  'checkbox',
  'rating',
] as const satisfies readonly FieldType[];

const selectDependencies = {
  sourceTruncated: z.boolean().optional(),
  cascade: z
    .object({
      fieldId: FieldId,
      mapping: z
        .record(ChoiceId, z.array(ChoiceId).max(LIMITS.choicesPerField))
        .refine(
          (mapping) =>
            Object.keys(mapping).length <= LIMITS.choicesPerField &&
            Object.values(mapping).reduce((total, ids) => total + ids.length, 0) <= LIMITS.cascadeEntries,
        ),
    })
    .optional(),
  source: z
    .object({
      tableId: TableId,
      fieldId: FieldId.optional(),
      filter: FieldFilters.group.optional(),
    })
    .optional(),
};

export const LINE_COLUMN_TYPES = [
  'text',
  'number',
  'currency',
  'date',
  'checkbox',
  'singleSelect',
  'link',
] as const;
export const LineColumn = z.object({
  id: FieldId,
  name: Name,
  description: Description.default(''),
  type: z.enum(LINE_COLUMN_TYPES),
  options: z.record(z.string(), z.unknown()).default({}),
});
export type LineColumn = z.infer<typeof LineColumn>;

export const FieldOptions = {
  lineItems: z.object({
    ...required,
    columns: z
      .array(LineColumn)
      .max(32)
      .default([])
      .refine((columns) => new Set(columns.map((column) => column.id)).size === columns.length),
    // The generated ID belongs to input preparation rather than a static schema default.
    linkedTableId: TableId.default(() => newId('table')).meta({ default: undefined }),
    inverseFieldId: FieldId.nullable().default(null),
    prefersSingle: z.literal(false).default(false),
    match: z.never().optional(),
  }),
  barcode: z.object({ validation: TextValidation.optional(), ...unique }),
  time: z.object({ ...required, timeFormat: TimeFormat.default('local') }),
  multiCurrency: z.object({
    ...required,
    code: z.string().refine(isCurrencyCode).default('USD'),
    precision: z.number().int().min(0).max(8).default(2),
    allowNegative: z.boolean().default(true),
  }),
  changeLog: Empty,
  text: z.object({
    validation: TextValidation.optional(),
    ...unique,
    uniqueCaseInsensitive: z.boolean().optional(),
    ...defaultOf(TextDefault),
  }),
  longText: z.object({
    validation: TextValidation.optional(),
    /**
     * Formatted text.  The value stays a string, now read as Markdown, so filters, search, sorting,
     * formulas, downloads, and the API all keep working on the text itself.  Plain text is already
     * valid, so turning this on or off never changes a value.  The app reads and writes one subset:
     * `**bold**`, `*italic*` or `_italic_`, `~~strikethrough~~`, `` `inline code` ``,
     * `[links](https://example.com)` and `<https://example.com>` (http, https, and mailto only),
     * `#` to `######` headings, bulleted lists (`-`, `*`, or `+`), numbered lists (`1.` or `1)`),
     * `- [ ]` and `- [x]` checklists, `>` block quotes, and code blocks fenced with backticks or
     * tildes.  A line break inside a paragraph is a line break, and a blank line starts a new
     * paragraph.  Anything else, including HTML and entities, is shown as the characters it was
     * typed with and never interpreted.
     */
    richText: z.boolean().default(false),
  }),
  number: z.object({
    validation: NumberValidation.optional(),
    ...unique,
    /** Decimal places shown; null shows the number as entered */
    precision: z.number().int().min(0).max(8).nullable().default(null),
    thousands: z.boolean().default(true),
    allowNegative: z.boolean().default(true),
    ...defaultOf(NumberDefault),
  }),
  checkbox: z.object({ ...required, color: ChoiceColor.default('green'), ...defaultOf(CheckboxDefault) }),
  date: z.object({
    validation: DateValidation.optional(),
    ...unique,
    includeTime: z.boolean().default(false),
    dateFormat: DateFormat.default('local'),
    timeFormat: TimeFormat.default('local'),
    timeZone: FieldTimeZone.default('client'),
    ...defaultOf(DateDefault),
  }),
  singleSelect: z.object({
    ...required,
    ...unique,
    choices: Choices.default([]),
    ...selectDependencies,
    ...defaultOf(SelectDefault),
  }),
  multipleSelect: z.object({
    ...required,
    choices: Choices.default([]),
    ...selectDependencies,
    ...defaultOf(SelectDefault),
  }),
  email: z.object({ validation: PatternValidation.optional(), ...unique, ...defaultOf(TextDefault) }),
  url: z.object({ validation: PatternValidation.optional(), ...unique, ...defaultOf(TextDefault) }),
  phone: z.object({ validation: PatternValidation.optional(), ...unique, ...defaultOf(TextDefault) }),
  createdTime: z.object({
    includeTime: z.boolean().default(true),
    dateFormat: DateFormat.default('local'),
    timeFormat: TimeFormat.default('local'),
    timeZone: FieldTimeZone.default('client'),
  }),
  lastModifiedTime: z.object({
    includeTime: z.boolean().default(true),
    dateFormat: DateFormat.default('local'),
    timeFormat: TimeFormat.default('local'),
    timeZone: FieldTimeZone.default('client'),
  }),
  createdBy: Empty,
  lastModifiedBy: Empty,
  recordId: Empty,
  link: z.object({
    ...required,
    linkedTableId: TableId,
    /** The paired field on the linked table; the server fills it in */
    inverseFieldId: FieldId.nullable().default(null),
    /** Keep the link on this table alone; requires record editing access to the target. */
    oneWay: z.boolean().optional(),
    /** Holds at most one record */
    prefersSingle: z.boolean().default(false),
    /** Choices follow the view's saved filter, including later changes to that filter. */
    limitToViewId: ViewId.optional(),
    filter: FieldFilters.group.optional(),
    displayFieldIds: z
      .array(FieldId)
      .max(3)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    /**
     * Links that follow matching values: each record links to the linked table's records whose
     * `linkedFieldId` equals this record's `fieldId`.  Nobody edits these links by hand.  They
     * change whenever either value does, including through syncs.
     */
    match: z.object({ fieldId: FieldId, linkedFieldId: FieldId }).optional(),
  }),
  lookup: z.object({
    filter: FieldFilters.group.optional(),
    sort: z
      .array(z.object({ fieldId: FieldId, direction: z.enum(['asc', 'desc']) }))
      .max(10)
      .optional(),
    limit: z.number().int().min(1).max(100_000).optional(),
    linkFieldId: FieldId,
    targetFieldId: FieldId,
    resultType: ResultType.default('array'),
  }),
  rollup: z.object({
    filter: FieldFilters.group.optional(),
    linkFieldId: FieldId,
    targetFieldId: FieldId,
    fn: RollupFunction.default('sum'),
    precision: Precision,
    resultType: ResultType.default('number'),
  }),
  count: z.object({ linkFieldId: FieldId, filter: FieldFilters.group.optional() }),
  formula: z.object({
    /** Airtable-style; stored with field IDs, shown with names */
    expression: z.string().max(10_000).default(''),
    resultType: ResultType.default('text'),
    precision: Precision,
    dateFormat: DateFormat.default('local'),
    timeFormat: TimeFormat.default('local'),
    timeZone: FieldTimeZone.default('client'),
    /** False when the formula can't be sorted or filtered by, which the server decides */
    sortable: z.boolean().default(true),
  }),
  currency: z.object({
    validation: NumberValidation.optional(),
    /** ISO 4217; the viewer's locale decides where the symbol goes */
    code: z.string().refine(isCurrencyCode, { message: 'unknown currency' }).default('USD'),
    precision: z.number().int().min(0).max(8).default(2),
    allowNegative: z.boolean().default(true),
    ...defaultOf(NumberDefault),
  }),
  percent: z.object({
    validation: NumberValidation.optional(),
    /** Values are fractions: 0.25 shows as 25% */
    precision: z.number().int().min(0).max(8).default(0),
    allowNegative: z.boolean().default(true),
    ...defaultOf(NumberDefault),
  }),
  duration: z.object({
    validation: NumberValidation.optional(),
    /** Values are seconds */
    format: z.enum(DURATION_FORMATS).default('h:mm'),
  }),
  rating: z.object({
    ...required,
    max: z.number().int().min(1).max(10).default(5),
    icon: z.enum(RATING_ICONS).default('star'),
    color: ChoiceColor.default('yellow'),
    ...defaultOf(NumberDefault),
  }),
  user: z.object({
    ...required,
    /** Holds more than one person */
    allowMultiple: z.boolean().default(false),
    /** Tells people when they're added, once notifications exist */
    notify: z.boolean().default(true),
    ...defaultOf(UserDefault),
  }),
  autoNumber: Empty,
  attachment: z.object(required),
  /** Like a date's options, applied to both ends */
  dateRange: z.object({
    ...required,
    includeTime: z.boolean().default(false),
    dateFormat: DateFormat.default('local'),
    timeFormat: TimeFormat.default('local'),
    timeZone: FieldTimeZone.default('client'),
  }),
  json: z.object(required),
  location: z.object(required),
  signature: z.object(required),
  button: z.object({
    /** The button's text, or empty to show the field's name */
    label: z.string().trim().max(LIMITS.buttonLabelLength).default(''),
    action: ButtonAction.default({ kind: 'openUrl', urlTemplate: '' }),
  }),
} as const satisfies Record<FieldType, z.ZodType>;

export type FieldOptionsOf<T extends FieldType> = z.infer<(typeof FieldOptions)[T]>;

/** Multiple parent selections allow the union of their mapped choices.  An empty parent allows none. */
export function choicesForRecord(
  options: FieldOptionsOf<'singleSelect' | 'multipleSelect'>,
  values: Readonly<Record<string, unknown>>,
): Choice[] {
  if (!options.cascade) return options.choices;
  const parent = values[options.cascade.fieldId];
  const ids = typeof parent === 'string' ? [parent] : Array.isArray(parent) ? parent : [];
  const allowed = new Set(
    ids.flatMap((id) => (typeof id === 'string' ? (options.cascade!.mapping[id] ?? []) : [])),
  );
  return options.choices.filter((choice) => allowed.has(choice.id));
}

/** A different source table needs label mapping even when the select type stays the same. */
export function needsFieldConversion(from: FieldSpec, to: FieldSpec): boolean {
  if (from.type !== to.type) return true;
  return (
    (from.type === 'singleSelect' || from.type === 'multipleSelect') &&
    (to.type === 'singleSelect' || to.type === 'multipleSelect') &&
    from.options.source?.tableId !== to.options.source?.tableId
  );
}

/** Stable option identity without exposing a source record's ID to someone who cannot read it. */
export async function sourceChoiceId(recordId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(recordId)));
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let number = 0n;
  for (const byte of digest.slice(0, 11)) number = number * 256n + BigInt(byte);
  let suffix = '';
  for (let index = 0; index < 14; index++) {
    suffix = alphabet[Number(number % 62n)]! + suffix;
    number /= 62n;
  }
  return `cho${suffix}`;
}

/** A field's type with its options.  Missing options take their defaults. */
export const FieldSpec = z.discriminatedUnion('type', [
  z.object({ type: z.literal('lineItems'), options: FieldOptions.lineItems.prefault({}) }),
  z.object({ type: z.literal('barcode'), options: FieldOptions.barcode.prefault({}) }),
  z.object({ type: z.literal('time'), options: FieldOptions.time.prefault({}) }),
  z.object({ type: z.literal('multiCurrency'), options: FieldOptions.multiCurrency.prefault({}) }),
  z.object({ type: z.literal('changeLog'), options: FieldOptions.changeLog.prefault({}) }),

  z.object({ type: z.literal('text'), options: FieldOptions.text.prefault({}) }),
  z.object({ type: z.literal('longText'), options: FieldOptions.longText.prefault({}) }),
  z.object({ type: z.literal('number'), options: FieldOptions.number.prefault({}) }),
  z.object({ type: z.literal('checkbox'), options: FieldOptions.checkbox.prefault({}) }),
  z.object({ type: z.literal('date'), options: FieldOptions.date.prefault({}) }),
  z.object({ type: z.literal('singleSelect'), options: FieldOptions.singleSelect.prefault({}) }),
  z.object({ type: z.literal('multipleSelect'), options: FieldOptions.multipleSelect.prefault({}) }),
  z.object({ type: z.literal('email'), options: FieldOptions.email.prefault({}) }),
  z.object({ type: z.literal('url'), options: FieldOptions.url.prefault({}) }),
  z.object({ type: z.literal('phone'), options: FieldOptions.phone.prefault({}) }),
  z.object({ type: z.literal('createdTime'), options: FieldOptions.createdTime.prefault({}) }),
  z.object({ type: z.literal('lastModifiedTime'), options: FieldOptions.lastModifiedTime.prefault({}) }),
  z.object({ type: z.literal('createdBy'), options: FieldOptions.createdBy.prefault({}) }),
  z.object({ type: z.literal('lastModifiedBy'), options: FieldOptions.lastModifiedBy.prefault({}) }),
  z.object({ type: z.literal('recordId'), options: FieldOptions.recordId.prefault({}) }),
  z.object({ type: z.literal('link'), options: FieldOptions.link }),
  z.object({ type: z.literal('lookup'), options: FieldOptions.lookup }),
  z.object({ type: z.literal('rollup'), options: FieldOptions.rollup }),
  z.object({ type: z.literal('count'), options: FieldOptions.count }),
  z.object({ type: z.literal('formula'), options: FieldOptions.formula.prefault({}) }),
  z.object({ type: z.literal('currency'), options: FieldOptions.currency.prefault({}) }),
  z.object({ type: z.literal('percent'), options: FieldOptions.percent.prefault({}) }),
  z.object({ type: z.literal('duration'), options: FieldOptions.duration.prefault({}) }),
  z.object({ type: z.literal('rating'), options: FieldOptions.rating.prefault({}) }),
  z.object({ type: z.literal('user'), options: FieldOptions.user.prefault({}) }),
  z.object({ type: z.literal('autoNumber'), options: FieldOptions.autoNumber.prefault({}) }),
  z.object({ type: z.literal('attachment'), options: FieldOptions.attachment.prefault({}) }),
  z.object({ type: z.literal('dateRange'), options: FieldOptions.dateRange.prefault({}) }),
  z.object({ type: z.literal('json'), options: FieldOptions.json.prefault({}) }),
  z.object({ type: z.literal('location'), options: FieldOptions.location.prefault({}) }),
  z.object({ type: z.literal('signature'), options: FieldOptions.signature.prefault({}) }),
  z.object({ type: z.literal('button'), options: FieldOptions.button.prefault({}) }),
]);
export type FieldSpec = z.infer<typeof FieldSpec>;

/** What a client sends to create a field.  The client picks the ID. */
export const FieldCreate = z.intersection(
  z.object({
    id: FieldId,
    name: Name,
    description: Description.default(''),
    /** Only in a synced table's `table.create`: the source column this field copies */
    source: FieldSource.optional(),
    /**
     * Makes the field an AI field, of an AI output type.  The server stores the prompt with field
     * IDs and makes whoever sends it the field's person, whatever `ownerId` says.
     */
    ai: AiFieldSettings.optional(),
  }),
  FieldSpec,
);
export type FieldCreate = z.infer<typeof FieldCreate>;

export const FieldMeta = z.intersection(
  z.object({
    ingest: IngestField.optional(),
    id: FieldId,
    tableId: TableId,
    name: Name,
    description: Description,
    /** Default position in the table; each view keeps its own order */
    position: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
    /** Set on a synced table's source fields, which only syncs and overrides change */
    source: FieldSource.optional(),
    /** Set on an AI field: the prompt its values come from, and who its runs act as */
    ai: AiFieldSettings.optional(),
  }),
  FieldSpec,
);
export type FieldMeta = z.infer<typeof FieldMeta>;

/** `POST /api/fields/:fieldId/conversion-preview`: what changing a field's type would do. */
export const ConversionPreviewRequest = z.object({
  to: FieldSpec,
  /** How to read dates written as numbers, from the person's locale */
  dateOrder: z.enum(['mdy', 'dmy', 'ymd']),
  /** The person's IANA time zone, for fields that follow each viewer */
  timeZone: z.string().refine(isTimeZone),
});
export type ConversionPreviewRequest = z.infer<typeof ConversionPreviewRequest>;

export interface ConversionPreview {
  /** Cells that aren't empty now */
  total: number;
  converted: number;
  /** Cells that would become empty */
  emptied: number;
  /** Source selections dropped or retained without an available label */
  dropped?: number;
  orphaned?: number;
  /** Up to five original values that would be lost */
  samples: unknown[];
  /** Names of options a select field would gain */
  newChoices: string[];
  tooManyChoices: boolean;
}
