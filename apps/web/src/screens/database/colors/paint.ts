import { sparklineLabel, type SparklinePaint } from './sparklines';
import type { I18n } from '@lingui/core';
import {
  cellValue,
  isSparklineField,
  sparklineValues,
  sparklineShape,
  checkCondition,
  colorRuleMatches,
  isBarField,
  iconBand,
  ICON_SET_GLYPHS,
  isScaleField,
  type CellValue,
  type ChoiceColor,
  type ColorConfig,
  type ColorRule,
  type ColorScale,
  type ConditionContext,
  type DataBar,
  type FieldMeta,
  type FieldRange,
  type IconSet,
  type RowData,
  type ScaleValue,
  type SparklineShape,
} from '@riosoma/contracts';

/**
 * What a view's conditional colors draw on each record and cell.  Every view type asks the same
 * `ViewColors`, so the grid, the cards, and the record card always agree.  Fills are tints from the
 * legibility tier, which keeps `--rio-aa-choice-text` readable on them in every theme, and edges and
 * marks use the tier's line colors, which stand out at 3:1 against pages and cards.
 */

/** A tint of a palette color that text in `--rio-aa-choice-text` reads well on. */
export function softColor(color: ChoiceColor): string {
  return `var(--rio-aa-choice-${color}-soft)`;
}

/** A palette color for edges, marks, and bar ends. */
export function lineColor(color: ChoiceColor): string {
  return `var(--rio-aa-choice-${color})`;
}

export interface DataBarPaint {
  color: ChoiceColor;
  /** How far the bar reaches, as a whole percentage of the cell */
  size: number;
  showValue: boolean;
}

export interface Paint {
  sparkline?: SparklinePaint;
  /** The cell's fill as a CSS color, or null to leave its background alone */
  fill: string | null;
  /** The color of the rule that matched, for marks, or null when a scale chose the fill */
  color: ChoiceColor | null;
  bar: DataBarPaint | null;
  icon?: { glyph: string; color: ChoiceColor; label: string };
  /** Names of the rules behind the color, which screen readers hear on the cell */
  labels: readonly string[];
}

export interface RecordPaint {
  color: ChoiceColor;
  /** The rule's name, which screen readers hear wherever the record's color shows */
  label: string;
}

export interface ViewColors {
  /** The first record rule that matches, which tints the whole record */
  record(row: RowData): RecordPaint | null;
  /** A cell's own color: the first matching cell rule, else its color scale, and its data bar */
  cell(row: RowData, field: FieldMeta): Paint | null;
  /** Every rule name coloring a record or these fields of it, for a card's screen reader text */
  labels(row: RowData, fields: readonly FieldMeta[]): string[];
}

export const NO_COLORS: ViewColors = {
  record: () => null,
  cell: () => null,
  labels: () => [],
};

export interface ViewColorsInput {
  config: ColorConfig;
  /** Every field of the table */
  fields: readonly FieldMeta[];
  /** The time zone and the loaded names that conditions read, and the moment, which defaults to now */
  context: Omit<ConditionContext, 'now'> & { now?: Date };
  /** Each field's lowest and highest values across the view, from the server */
  ranges: ReadonlyMap<string, FieldRange>;
  /** A rule's name for screen readers: its own, or its condition in words */
  label(rule: ColorRule, field: FieldMeta | undefined): string;
  i18n?: I18n;
  iconLabel?(set: IconSet, band: 0 | 1 | 2): string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A value's place on a scale: numbers as they are, days and moments in milliseconds. */
export function scalePoint(
  field: Pick<FieldMeta, 'type'>,
  value: CellValue | ScaleValue | undefined,
): number | null {
  if (field.type === 'date') {
    if (typeof value !== 'string') return null;
    const time = Date.parse(DATE_ONLY.test(value) ? `${value}T00:00:00Z` : value);
    return Number.isNaN(time) ? null : time;
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Where a value sits between two ends, from 0 to 1.  Either end can be the larger. */
function fraction(value: number, from: number, to: number): number {
  if (from === to) return 0.5;
  return Math.min(1, Math.max(0, (value - from) / (to - from)));
}

/** A tint between two palette colors, mixed as the stylesheet mixes: in OKLab. */
export function mixFill(from: ChoiceColor, to: ChoiceColor, amount: number): string {
  const percent = Math.round(amount * 100);
  if (from === to || percent <= 0) return softColor(from);
  if (percent >= 100) return softColor(to);
  return `color-mix(in oklab, ${softColor(to)} ${percent}%, ${softColor(from)})`;
}

/** The fill a scale gives a value, or null while the view's range it needs hasn't arrived. */
export function scaleFill(
  scale: ColorScale,
  field: Pick<FieldMeta, 'type'>,
  value: CellValue,
  range: FieldRange | undefined,
): string | null {
  const point = scalePoint(field, value);
  const low = scale.stops[0];
  const high = scale.stops.at(-1);
  if (point === null || !low || !high) return null;
  const from = low.value === null ? scalePoint(field, range?.min ?? null) : scalePoint(field, low.value);
  const to = high.value === null ? scalePoint(field, range?.max ?? null) : scalePoint(field, high.value);
  if (from === null || to === null) return null;
  const at = fraction(point, from, to);
  const middle = scale.stops.length === 3 ? scale.stops[1]! : null;
  if (!middle) return mixFill(low.color, high.color, at);
  const midpoint = middle.value === null ? (from + to) / 2 : scalePoint(field, middle.value);
  if (midpoint === null) return null;
  const split = fraction(midpoint, from, to);
  return at <= split
    ? mixFill(low.color, middle.color, split === 0 ? 1 : at / split)
    : mixFill(middle.color, high.color, split === 1 ? 1 : (at - split) / (1 - split));
}

/** How far a data bar reaches: from zero, or the lowest value below it, to the highest. */
export function barSize(
  field: Pick<FieldMeta, 'type'>,
  value: CellValue,
  range: FieldRange | undefined,
): number | null {
  const point = scalePoint(field, value);
  const min = scalePoint(field, range?.min ?? null);
  const max = scalePoint(field, range?.max ?? null);
  if (point === null || min === null || max === null) return null;
  const from = Math.min(0, min);
  const to = Math.max(0, max);
  return to === from ? 0 : Math.round(Math.min(1, Math.max(0, (point - from) / (to - from))) * 100);
}

export function createViewColors({
  config,
  fields,
  context,
  ranges,
  label,
  iconLabel,
  i18n,
}: ViewColorsInput): ViewColors {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const rules = config.colorRules.filter((rule) => {
    const field = byId.get(rule.condition.fieldId);
    return field !== undefined && checkCondition(field, rule.condition).usable;
  });
  const recordRules = rules.filter((rule) => rule.target === 'record');
  const cellRules = new Map<string, ColorRule[]>();
  for (const rule of rules) {
    if (rule.target !== 'cell') continue;
    const list = cellRules.get(rule.condition.fieldId) ?? [];
    list.push(rule);
    cellRules.set(rule.condition.fieldId, list);
  }
  const scales = new Map<string, ColorScale>();
  for (const scale of config.colorScales) {
    const field = byId.get(scale.fieldId);
    if (field && isScaleField(field) && !scales.has(field.id)) scales.set(field.id, scale);
  }
  const bars = new Map<string, DataBar>();
  for (const bar of config.dataBars) {
    const field = byId.get(bar.fieldId);
    if (field && isBarField(field) && !bars.has(field.id)) bars.set(field.id, bar);
  }
  const icons = new Map(
    config.iconSets
      .filter((set) => {
        const field = byId.get(set.fieldId);
        return field && isBarField(field);
      })
      .map((set) => [set.fieldId, set]),
  );
  const sparklines = new Map(
    config.sparklines
      .filter((setting) => {
        const field = byId.get(setting.fieldId);
        return field && isSparklineField(field);
      })
      .map((setting) => [setting.fieldId, setting]),
  );
  const charts = new WeakMap<RowData, Map<string, SparklinePaint | null>>();
  // The view box is fixed at 100 by 24. Equal lists can share their label and geometry across
  // fields and replacement row snapshots without retaining an unbounded scroll history.
  const lists = new Map<string, { label: string; shapes: Map<string, SparklineShape> }>();
  function chart(row: RowData, field: FieldMeta): SparklinePaint | null {
    const setting = sparklines.get(field.id);
    if (!setting || !i18n) return null;
    let cached = charts.get(row);
    if (!cached) {
      cached = new Map();
      charts.set(row, cached);
    }
    if (cached.has(field.id)) return cached.get(field.id)!;
    const values = sparklineValues(row, field, setting);
    const range = setting.sharedAxis ? ranges.get(field.id) : undefined;
    const axis =
      typeof range?.min === 'number' && typeof range.max === 'number'
        ? { min: range.min, max: range.max }
        : undefined;
    let paint: SparklinePaint | null = null;
    if (values.length) {
      const valueKey =
        values.length <= 512
          ? values.map((value) => (Object.is(value, -0) ? '-0' : String(value))).join(',')
          : undefined;
      let list = valueKey === undefined ? undefined : lists.get(valueKey);
      if (!list) {
        list = { label: sparklineLabel(values, i18n), shapes: new Map() };
        if (valueKey !== undefined) {
          lists.set(valueKey, list);
          if (lists.size > 256) lists.delete(lists.keys().next().value!);
        }
      }
      const shapeKey = [
        setting.type,
        setting.first,
        setting.last,
        setting.min,
        setting.max,
        axis?.min,
        axis?.max,
      ].join(':');
      let shape = list.shapes.get(shapeKey);
      if (!shape) {
        shape = sparklineShape(values, setting, axis);
        list.shapes.set(shapeKey, shape);
      }
      paint = { setting, shape, label: list.label };
    }
    cached.set(field.id, paint);
    return paint;
  }
  if (!rules.length && !scales.size && !bars.size && !icons.size && !sparklines.size) return NO_COLORS;

  const conditions: ConditionContext = { ...context, now: context.now ?? new Date() };
  const names = new Map<string, string>();
  const nameOf = (rule: ColorRule) => {
    let name = names.get(rule.id);
    if (name === undefined) {
      name = label(rule, byId.get(rule.condition.fieldId));
      names.set(rule.id, name);
    }
    return name;
  };
  // Rows are immutable snapshots, so a record's color holds until the row itself is replaced.
  const records = new WeakMap<RowData, RecordPaint | null>();

  function record(row: RowData): RecordPaint | null {
    const known = records.get(row);
    if (known !== undefined) return known;
    const rule = recordRules.find((rule) => colorRuleMatches(rule, row, byId, conditions));
    const paint = rule ? { color: rule.color, label: nameOf(rule) } : null;
    records.set(row, paint);
    return paint;
  }

  function cell(row: RowData, field: FieldMeta): Paint | null {
    const rule = cellRules.get(field.id)?.find((rule) => colorRuleMatches(rule, row, byId, conditions));
    const value = cellValue(row, field);
    const scale = rule ? undefined : scales.get(field.id);
    const fill = rule
      ? softColor(rule.color)
      : scale
        ? scaleFill(scale, field, value, ranges.get(field.id))
        : null;
    const setting = bars.get(field.id);
    const size = setting ? barSize(field, value, ranges.get(field.id)) : null;
    const bar =
      setting && size !== null ? { color: setting.color, size, showValue: setting.showValue } : null;
    const set = icons.get(field.id);
    const band = set ? iconBand(set, value) : null;
    const icon =
      set && band !== null
        ? {
            glyph: ICON_SET_GLYPHS[set.style][band],
            color: (['red', 'yellow', 'green'] as const)[band],
            label: set.labels[band].trim() || iconLabel?.(set, band) || String(value),
          }
        : undefined;
    const sparkline = chart(row, field);
    if (fill === null && bar === null && !icon && !sparkline) return null;
    return {
      ...(sparkline ? { sparkline } : {}),
      fill,
      color: rule?.color ?? null,
      bar,
      ...(icon ? { icon } : {}),
      labels: [
        ...(rule ? [nameOf(rule)] : []),
        ...(icon ? [icon.label] : []),
        ...(sparkline ? [sparkline.label] : []),
      ],
    };
  }

  return {
    record,
    cell,
    labels(row, shown) {
      const found = record(row);
      return [...(found ? [found.label] : []), ...shown.flatMap((field) => cell(row, field)?.labels ?? [])];
    },
  };
}
