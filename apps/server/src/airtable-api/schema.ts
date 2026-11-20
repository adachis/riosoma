import {
  ChoiceColor,
  fieldDefault,
  isCurrencyCode,
  visibleFieldIds,
  type DatabaseRole,
  type FieldOptionsOf,
  type ResultType,
  type ViewMeta,
  type ViewType,
} from '@riosoma/contracts';
import type { StoredField, StoredTable } from '../data/types.js';
import { AirtableError } from './errors.js';
import { message } from '../api-v1/messages.js';

/**
 * Riosoma's schema in the terms of Airtable's metadata API: field types by Airtable's names, with
 * their options as close as Riosoma's types allow.  Types Airtable has no name for take the name of
 * the type whose values they read as here (see `values.ts`).
 */

export interface AirtableFieldMeta {
  id: string;
  name: string;
  type: string;
  description?: string;
  options?: Record<string, unknown>;
}

/** Riosoma's colors by Airtable's names.  Airtable has no brown, so it gets a dark orange. */
export const COLORS: Record<ChoiceColor, string> = {
  gray: 'grayLight2',
  red: 'redLight2',
  orange: 'orangeLight2',
  yellow: 'yellowLight2',
  green: 'greenLight2',
  teal: 'tealLight2',
  blue: 'blueLight2',
  purple: 'purpleLight2',
  pink: 'pinkLight2',
  brown: 'orangeDark1',
};

/** The bright shade Airtable names for checkbox and rating icons. */
function bright(color: ChoiceColor): string {
  return `${color === 'brown' ? 'orange' : color}Bright`;
}

const DATE_FORMATS = {
  local: 'l',
  friendly: 'LL',
  us: 'M/D/YYYY',
  european: 'D/M/YYYY',
  iso: 'YYYY-MM-DD',
} as const;

type DateOptions = FieldOptionsOf<'date'>;

function dateFormat(options: Pick<DateOptions, 'dateFormat'>) {
  return { name: options.dateFormat, format: DATE_FORMATS[options.dateFormat] };
}

function timeZone(zone: string): string {
  if (zone === 'client') return 'client';
  return zone === 'UTC' ? 'utc' : zone;
}

function dateOptions(options: Omit<DateOptions, 'includeTime'>, includeTime: boolean) {
  if (!includeTime) return { dateFormat: dateFormat(options) };
  return {
    dateFormat: dateFormat(options),
    timeFormat:
      options.timeFormat === '24h'
        ? { name: '24hour', format: 'HH:mm' }
        : { name: '12hour', format: 'h:mma' },
    timeZone: timeZone(options.timeZone),
  };
}

/** How a signature's time reads, since it keeps no display options of its own */
const dateDefaults = { dateFormat: 'iso', timeFormat: '24h', timeZone: 'client' } as const;

export const DURATIONS = {
  'h:mm': 'h:mm',
  'h:mm:ss': 'h:mm:ss',
  'h:mm:ss.s': 'h:mm:ss.S',
  'h:mm:ss.ss': 'h:mm:ss.SS',
  'h:mm:ss.sss': 'h:mm:ss.SSS',
} as const;

function currencySymbol(code: string): string {
  const part = new Intl.NumberFormat('en-US', { style: 'currency', currency: code })
    .formatToParts(0)
    .find((item) => item.type === 'currency');
  return part?.value ?? code;
}

/** What a computed field produces, as Airtable describes a formula's, lookup's, or rollup's result. */
function result(
  type: ResultType,
  options: {
    precision?: number | null;
    dateFormat?: DateOptions['dateFormat'];
    timeFormat?: DateOptions['timeFormat'];
    timeZone?: string;
  } = {},
): { type: string; options?: Record<string, unknown> } {
  const dates = {
    dateFormat: options.dateFormat ?? 'local',
    timeFormat: options.timeFormat ?? 'local',
    timeZone: options.timeZone ?? 'client',
  };
  switch (type) {
    case 'number':
      return {
        type: 'number',
        ...(options.precision !== null && options.precision !== undefined
          ? { options: { precision: options.precision } }
          : {}),
      };
    case 'boolean':
      return { type: 'checkbox', options: { icon: 'check', color: 'greenBright' } };
    case 'date':
      return { type: 'date', options: dateOptions(dates, false) };
    case 'datetime':
      return { type: 'dateTime', options: dateOptions(dates, true) };
    case 'array':
      return { type: 'multipleLookupValues' };
    default:
      return { type: 'singleLineText' };
  }
}

/** A field's type and options as Airtable names them.  `seen` stops a lookup of a lookup going round. */
function described(
  field: StoredField,
  seen: ReadonlySet<string> = new Set(),
): { type: string; options?: Record<string, unknown> } {
  // A model fills in an AI field, so it's described as a formula that reads itself, a type clients
  // know they can't write, with what its own type holds as the result.
  if (field.ai)
    return {
      type: 'formula',
      options: {
        formula: `{${field.id}}`,
        isValid: true,
        referencedFieldIds: [field.id],
        result: described({ ...field, ai: undefined }, seen),
      },
    };
  switch (field.type) {
    case 'barcode':
      return { type: 'barcode' };
    case 'time':
    case 'multiCurrency':
      return { type: 'singleLineText' };
    case 'changeLog':
      return {
        type: 'formula',
        options: { formula: `{${field.id}}`, isValid: true, result: { type: 'multilineText' } },
      };
    case 'text':
    case 'location':
    case 'dateRange':
      return { type: 'singleLineText' };
    case 'longText':
      return { type: field.options.richText ? 'richText' : 'multilineText' };
    case 'json':
      return { type: 'multilineText' };
    case 'email':
      return { type: 'email' };
    case 'url':
      return { type: 'url' };
    case 'phone':
      return { type: 'phoneNumber' };
    case 'number':
      return {
        type: 'number',
        ...(field.options.precision !== null ? { options: { precision: field.options.precision } } : {}),
      };
    case 'currency':
      return {
        type: 'currency',
        options: { precision: field.options.precision, symbol: currencySymbol(field.options.code) },
      };
    case 'percent':
      return { type: 'percent', options: { precision: field.options.precision } };
    case 'duration':
      return { type: 'duration', options: { durationFormat: DURATIONS[field.options.format] } };
    case 'rating':
      return {
        type: 'rating',
        options: {
          icon: field.options.icon === 'circle' ? 'dot' : field.options.icon,
          max: field.options.max,
          color: bright(field.options.color),
        },
      };
    case 'checkbox':
      return { type: 'checkbox', options: { icon: 'check', color: bright(field.options.color) } };
    case 'date':
      return field.options.includeTime
        ? { type: 'dateTime', options: dateOptions(field.options, true) }
        : { type: 'date', options: dateOptions(field.options, false) };
    // When it was signed, which is how formulas read a signature too.  Only a person signing sets
    // one, so it's described as the time the field itself last changed, a type clients know they
    // can't write.
    case 'signature':
      return {
        type: 'lastModifiedTime',
        options: {
          isValid: true,
          referencedFieldIds: [field.id],
          result: { type: 'dateTime', options: dateOptions(dateDefaults, true) },
        },
      };
    case 'createdTime':
    case 'lastModifiedTime': {
      const time = {
        result: field.options.includeTime
          ? { type: 'dateTime', options: dateOptions(field.options, true) }
          : { type: 'date', options: dateOptions(field.options, false) },
      };
      return {
        type: field.type,
        options:
          field.type === 'lastModifiedTime' ? { isValid: true, referencedFieldIds: [], ...time } : time,
      };
    }
    case 'singleSelect':
    case 'multipleSelect':
      return {
        type: field.type === 'singleSelect' ? 'singleSelect' : 'multipleSelects',
        options: {
          choices: field.options.choices.map((choice) => ({
            id: choice.id,
            name: choice.name,
            color: COLORS[choice.color],
          })),
        },
      };
    case 'user':
      return { type: field.options.allowMultiple ? 'multipleCollaborators' : 'singleCollaborator' };
    case 'createdBy':
    case 'lastModifiedBy':
      return { type: field.type };
    case 'recordId':
      return {
        type: 'formula',
        options: {
          formula: 'RECORD_ID()',
          isValid: true,
          referencedFieldIds: [],
          result: { type: 'singleLineText' },
        },
      };
    case 'autoNumber':
      return { type: 'autoNumber' };
    case 'attachment':
      return { type: 'multipleAttachments', options: { isReversed: false } };
    case 'button':
      return { type: 'button' };
    case 'lineItems':
    case 'link':
      return {
        type: 'multipleRecordLinks',
        options: {
          linkedTableId: field.options.linkedTableId,
          isReversed: false,
          prefersSingleRecordLink: field.options.prefersSingle,
          ...(field.options.inverseFieldId ? { inverseLinkFieldId: field.options.inverseFieldId } : {}),
        },
      };
    case 'count':
      return { type: 'count', options: { isValid: true, recordLinkFieldId: field.options.linkFieldId } };
    case 'lookup': {
      const target = field.relation?.target;
      const inner = target && !seen.has(target.id) ? described(target, new Set([...seen, field.id])) : null;
      return {
        type: 'multipleLookupValues',
        options: {
          isValid: inner !== null,
          recordLinkFieldId: field.options.linkFieldId,
          fieldIdInLinkedTable: field.options.targetFieldId,
          result: inner,
        },
      };
    }
    case 'rollup':
      return {
        type: 'rollup',
        options: {
          isValid: field.relation?.target !== undefined,
          recordLinkFieldId: field.options.linkFieldId,
          fieldIdInLinkedTable: field.options.targetFieldId,
          referencedFieldIds: [],
          result: result(field.options.resultType, { precision: field.options.precision }),
        },
      };
    case 'formula':
      return {
        type: 'formula',
        options: {
          // Stored with field IDs in braces, which is how Airtable's metadata gives formulas too.
          formula: field.options.expression,
          isValid: !field.formula?.error,
          referencedFieldIds: [...new Set((field.formula?.fields ?? []).map((item) => item.id))],
          result: result(field.options.resultType, field.options),
        },
      };
  }
}

export function fieldMeta(field: StoredField): AirtableFieldMeta {
  const { type, options } = described(field);
  // What a new record holds in the field when it's left out, in Riosoma's own shape, since
  // Airtable's metadata has no place for it.
  const value = field.ai ? undefined : fieldDefault(field);
  const all = value ? { ...options, defaultValue: value } : options;
  return {
    id: field.id,
    name: field.name,
    type,
    ...(field.description ? { description: field.description } : {}),
    ...(all ? { options: all } : {}),
  };
}

/** Riosoma's view types by Airtable's.  Lists read as grids, and charts, pivots, and maps as blocks. */
const VIEW_TYPES: Record<ViewType, string> = {
  grid: 'grid',
  kanban: 'kanban',
  gallery: 'gallery',
  calendar: 'calendar',
  form: 'form',
  timeline: 'timeline',
  gantt: 'timeline',
  list: 'grid',
  chart: 'block',
  pivot: 'block',
  map: 'block',
  orgChart: 'block',
};

export function tableMeta(
  table: StoredTable,
  fields: readonly StoredField[],
  views: readonly ViewMeta[],
  withVisibleFields: boolean,
) {
  return {
    id: table.id,
    name: table.name,
    ...(table.description ? { description: table.description } : {}),
    primaryFieldId: table.primaryFieldId,
    fields: fields.map(fieldMeta),
    views: views.map((view) => {
      const type = VIEW_TYPES[view.type];
      return {
        id: view.id,
        name: view.name,
        type,
        ...(withVisibleFields && type === 'grid'
          ? { visibleFieldIds: visibleFieldIds(view.config, fields, table.primaryFieldId) }
          : {}),
      };
    }),
  };
}

/** Riosoma's roles by the permission levels Airtable lists bases with. */
export const PERMISSION_LEVELS: Record<DatabaseRole, string> = {
  owner: 'create',
  creator: 'create',
  editor: 'edit',
  commenter: 'comment',
  reader: 'read',
};

/** The Airtable-style ID a database answers to as well as its own: `app` and the same characters. */
export function baseAlias(databaseId: string): string {
  return `app${databaseId.slice(2)}`;
}

/** Field types Airtable's API won't create, which it refuses the same way here */
const UNCREATABLE = new Set([
  'formula',
  'rollup',
  'multipleLookupValues',
  'count',
  'autoNumber',
  'createdTime',
  'lastModifiedTime',
  'createdBy',
  'lastModifiedBy',
  'button',
  'externalSyncSource',
  'aiText',
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One of Riosoma's colors from any shade Airtable names, or undefined for the default. */
function colorFrom(name: unknown): ChoiceColor | undefined {
  if (typeof name !== 'string') return undefined;
  const exact = (Object.keys(COLORS) as ChoiceColor[]).find((color) => COLORS[color] === name);
  const base = name.replace(/(Light1|Light2|Dark1|Bright)$/, '').replace(/^cyan$/, 'teal');
  return exact ?? ChoiceColor.options.find((color) => color === base);
}

/** The ISO code a currency symbol stands for, with the dollar sign as US dollars. */
function currencyFrom(symbol: unknown): string | undefined {
  if (typeof symbol !== 'string') return undefined;
  if (symbol === '$' || isCurrencyCode(symbol)) return symbol === '$' ? 'USD' : symbol;
  return Intl.supportedValuesOf('currency').find((code) => currencySymbol(code) === symbol) ?? symbol;
}

function dateFrom(options: Record<string, unknown>) {
  const named = (value: unknown) => (isObject(value) ? value : {});
  const date = named(options.dateFormat);
  const time = named(options.timeFormat).name;
  const zone = options.timeZone;
  return {
    dateFormat: date.name ?? Object.entries(DATE_FORMATS).find(([, format]) => format === date.format)?.[0],
    timeFormat: time === '24hour' ? '24h' : time === '12hour' ? '12h' : undefined,
    timeZone: zone === 'utc' ? 'UTC' : zone,
  };
}

/**
 * A field in Airtable's write format, `{ name, type, description, options }`, as Riosoma's field
 * specification, which the app's own checks then validate.  Types Airtable can't create are refused.
 */
export function fieldSpecFrom(field: unknown): Record<string, unknown> {
  if (!isObject(field))
    throw new AirtableError(422, 'INVALID_REQUEST_UNKNOWN', message('api.schema.fieldObject'));
  const { type, options: given, ...rest } = field;
  const options = isObject(given) ? given : {};
  const spec = (riosoma: string, values?: Record<string, unknown>) => ({
    ...rest,
    type: riosoma,
    ...(values ? { options: values } : {}),
  });
  switch (type) {
    case 'singleLineText':
      return spec('text');
    case 'email':
    case 'url':
    case 'barcode':
      return spec(type);
    case 'phoneNumber':
      return spec('phone');
    case 'multilineText':
    case 'richText':
      return spec('longText', { richText: type === 'richText' });
    case 'number':
    case 'percent':
      return spec(type, { precision: options.precision });
    case 'currency':
      return spec(type, { precision: options.precision, code: currencyFrom(options.symbol) });
    case 'singleSelect':
    case 'multipleSelects':
      return spec(type === 'singleSelect' ? type : 'multipleSelect', {
        choices: (Array.isArray(options.choices) ? options.choices : []).map((choice: unknown) =>
          isObject(choice) ? { name: choice.name, color: colorFrom(choice.color) } : choice,
        ),
      });
    case 'singleCollaborator':
    case 'multipleCollaborators':
      return spec('user', { allowMultiple: type === 'multipleCollaborators' });
    case 'multipleRecordLinks':
      return spec('link', {
        linkedTableId: options.linkedTableId,
        prefersSingle: options.prefersSingleRecordLink,
      });
    case 'date':
    case 'dateTime':
      return spec('date', { includeTime: type === 'dateTime', ...dateFrom(options) });
    case 'multipleAttachments':
      return spec('attachment');
    case 'checkbox':
      return spec(type, { color: colorFrom(options.color) });
    case 'rating':
      return spec(type, {
        max: options.max,
        icon: options.icon === 'dot' ? 'circle' : options.icon,
        color: colorFrom(options.color),
      });
    case 'duration':
      return spec(type, {
        format: Object.entries(DURATIONS).find(([, format]) => format === options.durationFormat)?.[0],
      });
  }
  const name = typeof type === 'string' ? type.slice(0, 100) : '';
  throw UNCREATABLE.has(name)
    ? new AirtableError(
        422,
        'UNSUPPORTED_FIELD_TYPE_FOR_CREATE',
        message('api.schema.unsupportedFieldType', { type: name }),
      )
    : new AirtableError(422, 'INVALID_FIELD_TYPE', message('api.schema.unknownFieldType', { type: name }));
}
