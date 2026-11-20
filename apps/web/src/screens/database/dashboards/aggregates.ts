import {
  AGGREGATES,
  type Aggregate,
  type FieldMeta,
  type FieldType,
  type TileValue,
} from '@riosoma/contracts';
import { resultField } from '../../../data/formulas';
import { displayField, formatCell, type FormatContext } from '../../../grid/format';

/** Types whose values add up: sums, averages, and the smallest and largest make sense for them. */
const NUMERIC: ReadonlySet<FieldType> = new Set([
  'number',
  'currency',
  'percent',
  'duration',
  'rating',
  'autoNumber',
  'count',
]);
/** A date range counts as the day it starts, as the server groups it */
const DATES: ReadonlySet<FieldType> = new Set(['date', 'createdTime', 'lastModifiedTime', 'dateRange']);
/** Values that make poor categories: every record has its own, or they're files */
const UNGROUPABLE: ReadonlySet<FieldType> = new Set([
  'attachment',
  'longText',
  'recordId',
  'autoNumber',
  'json',
  'location',
  'signature',
  'changeLog',
  'button',
]);
/** Values a tile can't count or add up: signatures prove something, and buttons hold nothing */
const UNCOUNTED: ReadonlySet<FieldType> = new Set(['attachment', 'signature', 'button', 'changeLog']);

/** Whether a field's values are numbers.  Formulas and rollups count by the type they produce. */
export function isNumericField(field: FieldMeta): boolean {
  // A lookup holds a list for each record, which doesn't add up to one number.
  return field.type !== 'lookup' && NUMERIC.has(resultField(field).type);
}

export function isDateField(field: FieldMeta): boolean {
  return field.type !== 'lookup' && DATES.has(resultField(field).type);
}

/**
 * The values that fit a field.  With no field, a tile can only count records.  Every field can
 * count its unique values, and only numbers add up.
 */
export function aggregatesFor(field: FieldMeta | null | undefined): Aggregate[] {
  if (!field) return ['count'];
  if (UNCOUNTED.has(field.type)) return [];
  return AGGREGATES.filter((fn) => fn === 'countUnique' || (fn !== 'count' && isNumericField(field)));
}

/** Fields a tile can compute a value from. */
export function valueFields(fields: readonly FieldMeta[]): FieldMeta[] {
  return fields.filter((field) => aggregatesFor(field).length > 0);
}

/** Fields a chart can put along its axis or split its series by. */
export function groupFields(fields: readonly FieldMeta[]): FieldMeta[] {
  return fields.filter((field) => !UNGROUPABLE.has(field.type));
}

/** Fields a records tile can show beside each record's name. */
export function recordFields(fields: readonly FieldMeta[], primaryFieldId: string): FieldMeta[] {
  // Linked records and files would show bare IDs here, since their names aren't in the tile's data.
  return fields.filter(
    (field) =>
      field.id !== primaryFieldId &&
      field.type !== 'link' &&
      field.type !== 'attachment' &&
      field.type !== 'button',
  );
}

/** Keeps a value valid for a table's fields: a missing or unfitting field falls back sensibly. */
export function fitValue(value: TileValue, fields: readonly FieldMeta[]): TileValue {
  if (value.fn === 'count') return { fn: 'count', fieldId: null };
  const field = fields.find((item) => item.id === value.fieldId);
  if (!field) return { fn: 'count', fieldId: null };
  const fitting = aggregatesFor(field);
  return fitting.includes(value.fn)
    ? value
    : { fn: fitting[0] ?? 'count', fieldId: fitting[0] ? field.id : null };
}

const wholeNumbers = new Map<string, Intl.NumberFormat>();
const fractions = new Map<string, Intl.NumberFormat>();

function wholeNumber(locale: string): Intl.NumberFormat {
  let format = wholeNumbers.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    wholeNumbers.set(locale, format);
  }
  return format;
}

function fraction(locale: string): Intl.NumberFormat {
  let format = fractions.get(locale);
  if (!format) {
    format = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    fractions.set(locale, format);
  }
  return format;
}

/**
 * A computed value as its field shows values: currency as money, durations as time, and so on.
 * Counts are whole numbers, and an average of a field that leaves its decimals open keeps two.
 */
export function formatValue(
  value: number | null,
  tileValue: TileValue,
  field: FieldMeta | undefined,
  ctx: FormatContext,
): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (tileValue.fn === 'count' || tileValue.fn === 'countUnique' || !field)
    return wholeNumber(ctx.locale).format(value);
  const shown = displayField(field, ctx);
  if (shown.type === 'number')
    return tileValue.fn === 'average' && shown.options.precision === null
      ? fraction(ctx.locale).format(value)
      : formatCell(shown, value, ctx);
  if (shown.type === 'rating' || shown.type === 'autoNumber') return fraction(ctx.locale).format(value);
  return formatCell(shown, value, ctx) || fraction(ctx.locale).format(value);
}

/**
 * A whole number on a chart's value axis, as its field shows values but without decimal places,
 * so a money axis reads $5,000,000 and not $5,000,000.00.  Only numbers and money drop them: a
 * percentage, a duration, and a rating keep the form their field gives them.
 */
export function formatAxisValue(
  value: number,
  tileValue: TileValue,
  field: FieldMeta | undefined,
  ctx: FormatContext,
): string | null {
  if (field && tileValue.fn !== 'count' && tileValue.fn !== 'countUnique' && Number.isInteger(value)) {
    const shown = displayField(field, ctx);
    if (shown.type === 'number' || shown.type === 'currency')
      return formatCell(
        { ...shown, options: { ...shown.options, precision: 0 } } as typeof shown,
        value,
        ctx,
      );
  }
  return formatValue(value, tileValue, field, ctx);
}
