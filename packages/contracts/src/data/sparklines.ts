import { z } from 'zod';
import { FieldId, type FieldMeta } from './fields.js';
import { cellValue, type RowData } from './rows.js';

export const SparklineType = z.enum(['line', 'column', 'winLoss']);
export const Sparkline = z.object({
  fieldId: FieldId,
  type: SparklineType.default('line'),
  first: z.boolean().default(false),
  last: z.boolean().default(true),
  min: z.boolean().default(false),
  max: z.boolean().default(false),
  color: z.enum(['accent', 'blue', 'green', 'red', 'purple', 'gray']).default('accent'),
  sharedAxis: z.boolean().default(false),
  order: z
    .object({ fieldId: FieldId, direction: z.enum(['asc', 'desc']) })
    .nullable()
    .default(null),
});
export type Sparkline = z.infer<typeof Sparkline>;

/** JSON and array formulas can hold numeric lists without a dedicated numeric-list field type. */
export function isSparklineField(field: Pick<FieldMeta, 'type' | 'options'>): boolean {
  return (
    field.type === 'lookup' ||
    field.type === 'rollup' ||
    field.type === 'json' ||
    (field.type === 'formula' && 'resultType' in field.options && field.options.resultType === 'array')
  );
}

/** A record can be used by several views with different point orders. */
export function sparklineKey(setting: Pick<Sparkline, 'fieldId' | 'order'>): string {
  return `${setting.fieldId}:${setting.order?.fieldId ?? ''}:${setting.order?.direction ?? ''}`;
}

/** Mixed lists do not silently turn text, nulls, or booleans into numeric points. */
export function numericList(value: unknown): number[] {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    : [];
}

export function sparklineValues(row: RowData, field: FieldMeta, setting: Sparkline): number[] {
  if (row.errors?.[field.id]) return [];
  const source = row.sparklineValues?.[sparklineKey(setting)];
  if (source) return source;
  // A configured relational order must wait for the scoped source, rather than show a wrong order.
  return setting.order || field.type === 'rollup' ? [] : numericList(cellValue(row, field));
}

export interface SparklineSummary {
  min: number;
  max: number;
  last: number;
  trend: 'up' | 'down' | 'flat';
}
export function sparklineSummary(values: readonly number[]): SparklineSummary | null {
  if (!values.length) return null;
  let min = values[0]!,
    max = min;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const last = values.at(-1)!;
  return { min, max, last, trend: last > values[0]! ? 'up' : last < values[0]! ? 'down' : 'flat' };
}

export interface SparklineShape {
  path: string;
  marks: Array<{ x: number; y: number }>;
  bars: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    highlighted: boolean;
    negative: boolean;
  }>;
}

/** A fixed view box keeps drawing work independent of row count and cell width. */
export function sparklineShape(
  values: readonly number[],
  setting: Sparkline,
  range?: { min: number; max: number },
): SparklineShape {
  const summary = sparklineSummary(values);
  if (!summary) return { path: '', marks: [], bars: [] };
  let min = range?.min ?? summary.min,
    max = range?.max ?? summary.max;
  if (setting.type !== 'line') {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  // Divide before subtracting to keep opposite, very large finite numbers in range.
  const magnitude = Math.max(Math.abs(min), Math.abs(max), 1);
  const low = min / magnitude,
    span = max / magnitude - low;
  const y = (value: number) =>
    span === 0 ? 12 : 22 - Math.max(0, Math.min(1, (value / magnitude - low) / span)) * 20;
  const highlighted = (index: number, value: number) =>
    (setting.first && index === 0) ||
    (setting.last && index === values.length - 1) ||
    (setting.min && value === summary.min) ||
    (setting.max && value === summary.max);
  const marks: SparklineShape['marks'] = [],
    bars: SparklineShape['bars'] = [];
  const path: string[] = [];
  // Bound geometry by the view box while retaining the values that enabled highlights describe.
  const step = Math.max(1, Math.ceil(values.length / 96));
  for (let start = 0; start < values.length; start += step) {
    const end = Math.min(values.length, start + step);
    let lowAt = start,
      highAt = start;
    for (let index = start + 1; index < end; index++) {
      if (values[index]! < values[lowAt]!) lowAt = index;
      if (values[index]! > values[highAt]!) highAt = index;
    }
    const indices =
      setting.type === 'line'
        ? [...new Set([start, lowAt, highAt, end - 1])].sort((a, b) => a - b)
        : [
            ...new Set([
              end - 1,
              ...(setting.first && start === 0 ? [start] : []),
              ...(setting.min && values[lowAt] === summary.min ? [lowAt] : []),
              ...(setting.max && values[highAt] === summary.max ? [highAt] : []),
            ]),
          ].sort((a, b) => a - b);
    for (const index of indices) {
      const value = values[index]!;
      const x = values.length === 1 ? 50 : 2 + (index / (values.length - 1)) * 96;
      if (setting.type === 'line') {
        path.push(`${path.length ? 'L' : 'M'}${x.toFixed(2)},${y(value).toFixed(2)}`);
        if (highlighted(index, value)) marks.push({ x, y: y(value) });
      } else {
        const baseline = setting.type === 'winLoss' ? 12 : y(0);
        const top = setting.type === 'winLoss' ? (value > 0 ? 2 : value < 0 ? 22 : 12) : y(value);
        bars.push({
          x: 2 + (index / values.length) * 96,
          y: Math.min(top, baseline),
          width: Math.max(0.5, (((end - start) / values.length) * 96) / indices.length - 0.75),
          height: Math.abs(top - baseline),
          highlighted: highlighted(index, value),
          negative: value < 0,
        });
      }
    }
  }
  if (values.length === 1 && setting.type === 'line' && !marks.length)
    marks.push({ x: 50, y: y(values[0]!) });
  return { path: path.join(' '), marks, bars };
}
