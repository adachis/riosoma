import { z } from 'zod';
import { Sparkline, isSparklineField } from './sparklines.js';
import { conditionMatches, type ConditionContext } from './conditions.js';
import { ChoiceColor, FieldId, isTimeZone, LIMITS, type FieldMeta, type FieldType } from './fields.js';
import { checkCondition, FilterCondition, WhereToken } from './filters.js';
import { cellValue, type RowData } from './rows.js';
import { isDateOnly } from './values.js';

/**
 * Conditional colors: rules that color one field's cells or whole records by their values, and
 * color scales and data bars for numbers and dates, as a spreadsheet's conditional formatting does.
 * Colors are the palette's named colors.  Views draw them as tints from the legibility tier, so
 * text on a fill stays readable in every theme, and a rule's name reaches screen readers wherever
 * it colors something, so color is never the only signal.
 */
/** Portable light fills for files that do not have a theme engine. */
export const HEADER_COLOR_RGB: Record<ChoiceColor, string> = {
  gray: 'E8E8E8',
  red: 'FCE1E2',
  orange: 'FBE6D6',
  yellow: 'F8EDC5',
  green: 'DDEFE1',
  teal: 'D8EFEB',
  blue: 'DEE9FD',
  purple: 'EDDEFA',
  pink: 'F8DDED',
  brown: 'EBE1D8',
};

export const COLOR_LIMITS = { rules: 50, nameLength: 100 } as const;

/** `cell` colors the condition field's cells, and `record` tints the whole record. */
export const COLOR_TARGETS = ['cell', 'record'] as const;
export const ColorTarget = z.enum(COLOR_TARGETS);
export type ColorTarget = z.infer<typeof ColorTarget>;

export const ColorRule = z.object({
  /** Stable key for editing the list, any short string */
  id: z.string().min(1).max(32),
  /** What the color means, read to screen readers.  Empty uses the condition's own words. */
  name: z.string().max(COLOR_LIMITS.nameLength).default(''),
  target: ColorTarget,
  /** Tested exactly as a view filter tests it.  A condition still missing a value colors nothing. */
  condition: FilterCondition,
  color: ChoiceColor,
});
export type ColorRule = z.infer<typeof ColorRule>;

/** Fields a color scale can follow. */
export const SCALE_FIELD_TYPES = [
  'number',
  'currency',
  'percent',
  'duration',
  'rating',
  'date',
] as const satisfies readonly FieldType[];
/** Fields a data bar can measure. */
export const BAR_FIELD_TYPES = [
  'number',
  'currency',
  'percent',
  'duration',
  'rating',
] as const satisfies readonly FieldType[];

export function isScaleField(field: Pick<FieldMeta, 'type'>): boolean {
  return (SCALE_FIELD_TYPES as readonly FieldType[]).includes(field.type);
}

export function isBarField(field: Pick<FieldMeta, 'type'>): boolean {
  return (BAR_FIELD_TYPES as readonly FieldType[]).includes(field.type);
}

/** A fixed point on a scale: a number, or a `YYYY-MM-DD` day for a date field. */
export const ScaleValue = z.union([z.number(), z.string().refine(isDateOnly)]);
export type ScaleValue = z.infer<typeof ScaleValue>;

export const ColorStop = z.object({
  color: ChoiceColor,
  /**
   * Null follows the view: the field's lowest value for the first stop, its highest for the last,
   * and halfway between them for a middle one
   */
  value: ScaleValue.nullable().default(null),
});
export type ColorStop = z.infer<typeof ColorStop>;

export const ColorScale = z.object({
  fieldId: FieldId,
  /** From the lowest value to the highest, with an optional stop between them */
  stops: z.array(ColorStop).min(2).max(3),
});
export type ColorScale = z.infer<typeof ColorScale>;

export const DataBar = z.object({
  fieldId: FieldId,
  color: ChoiceColor.default('blue'),
  /** Off leaves the bar alone in the cell, and screen readers still read the number */
  showValue: z.boolean().default(true),
});
export type DataBar = z.infer<typeof DataBar>;

export const ICON_SET_TYPES = ['arrows', 'flags', 'ratings'] as const;
export const IconSetType = z.enum(ICON_SET_TYPES);
export type IconSetType = z.infer<typeof IconSetType>;

/** Fixed numeric thresholds keep a band's meaning stable as the view's records change. */
export const IconSet = z.object({
  fieldId: FieldId,
  style: IconSetType.default('arrows'),
  thresholds: z.tuple([z.number().finite(), z.number().finite()]).refine(([low, high]) => low <= high),
  /** Empty labels use localized descriptions of the numeric bands. */
  labels: z
    .tuple([
      z.string().max(COLOR_LIMITS.nameLength),
      z.string().max(COLOR_LIMITS.nameLength),
      z.string().max(COLOR_LIMITS.nameLength),
    ])
    .default(['', '', '']),
});
export type IconSet = z.infer<typeof IconSet>;

/** Equality enters the higher band; blanks and nonnumeric values have no icon. */
export function iconBand(set: IconSet, value: unknown): 0 | 1 | 2 | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value < set.thresholds[0] ? 0 : value < set.thresholds[1] ? 1 : 2;
}

export const ICON_SET_GLYPHS: Record<IconSetType, readonly [string, string, string]> = {
  arrows: ['↓', '→', '↑'],
  flags: ['⚑', '⚑', '⚑'],
  ratings: ['★☆☆', '★★☆', '★★★'],
};

function unique<T>(key: (item: T) => string) {
  return (items: readonly T[]) => new Set(items.map(key)).size === items.length;
}

/** The parts of a view's configuration that color it. */
export const ColorConfig = z.object({
  /** In order: the first matching cell rule colors each cell, and the first record rule each record */
  colorRules: z
    .array(ColorRule)
    .max(COLOR_LIMITS.rules)
    .refine(
      unique((rule: ColorRule) => rule.id),
      { message: 'duplicate rule' },
    )
    .default([]),
  /** At most one per field */
  colorScales: z
    .array(ColorScale)
    .max(LIMITS.fieldsPerTable)
    .refine(
      unique((scale: ColorScale) => scale.fieldId),
      { message: 'duplicate scale' },
    )
    .default([]),
  /** At most one per field */
  dataBars: z
    .array(DataBar)
    .max(LIMITS.fieldsPerTable)
    .refine(
      unique((bar: DataBar) => bar.fieldId),
      { message: 'duplicate bar' },
    )
    .default([]),
  sparklines: z
    .array(Sparkline)
    .max(LIMITS.fieldsPerTable)
    .refine(
      unique((setting: Sparkline) => setting.fieldId),
      { message: 'duplicate sparkline' },
    )
    .default([]),
  iconSets: z
    .array(IconSet)
    .max(LIMITS.fieldsPerTable)
    .refine(
      unique((set: IconSet) => set.fieldId),
      { message: 'duplicate icon set' },
    )
    .default([]),
});
export type ColorConfig = z.infer<typeof ColorConfig>;

/** Whether a fixed scale value suits its field: a number, or a day for a date field. */
export function scaleValueFits(field: Pick<FieldMeta, 'type'>, value: ScaleValue): boolean {
  return field.type === 'date' ? typeof value === 'string' : typeof value === 'number';
}

/** The fields whose lowest and highest values a view needs from the server to draw its colors. */
export function rangeFieldIds(
  config: ColorConfig,
  fields: readonly Pick<FieldMeta, 'id' | 'type' | 'options'>[],
): string[] {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const ids = new Set<string>();
  for (const scale of config.colorScales) {
    const field = byId.get(scale.fieldId);
    if (field && isScaleField(field) && scale.stops.some((stop) => stop.value === null)) ids.add(field.id);
  }
  for (const bar of config.dataBars) {
    const field = byId.get(bar.fieldId);
    if (field && isBarField(field)) ids.add(field.id);
  }
  for (const setting of config.sparklines) {
    const field = byId.get(setting.fieldId);
    if (setting.sharedAxis && field && isSparklineField(field)) ids.add(field.id);
  }
  return [...ids].sort();
}

/**
 * Whether a rule colors a record: its condition's field exists and the condition, which must be
 * complete, admits the record as a filter would.
 */
export function colorRuleMatches(
  rule: ColorRule,
  row: RowData,
  fields: ReadonlyMap<string, FieldMeta>,
  context: ConditionContext,
): boolean {
  const field = fields.get(rule.condition.fieldId);
  return (
    !!field &&
    checkCondition(field, rule.condition).usable &&
    conditionMatches(field, cellValue(row, field), rule.condition, context)
  );
}

/**
 * `GET /api/views/:viewId/ranges?fields=&tz=`: the lowest and highest values of number and date
 * fields across every record of the view the reader can see, for color scales and data bars.
 * Fields that can't have a scale or a bar, or that the reader can't see, are left out.
 */
export const ViewRangesQuery = z.object({
  /** Comma-separated field IDs */
  fields: z
    .string()
    .max(10_000)
    .transform((text) => text.split(',').filter(Boolean))
    .pipe(z.array(FieldId).min(1).max(LIMITS.fieldsPerTable)),
  /** The viewer's IANA time zone, for date filters on fields that follow each viewer */
  tz: z.string().refine(isTimeZone).optional(),
  /** The `where` token the view's rows were read with */
  where: WhereToken.optional(),
});
export type ViewRangesQuery = z.infer<typeof ViewRangesQuery>;

export interface FieldRange {
  fieldId: string;
  /** Numbers for number fields, `YYYY-MM-DD` days or ISO 8601 moments for dates, and null with no values */
  min: number | string | null;
  max: number | string | null;
}

export interface ViewRanges {
  ranges: FieldRange[];
}
