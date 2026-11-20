import { GROUP_KEY_MAX_LENGTH } from './group-key.js';
import { z } from 'zod';
import { ChartSort, ChartType, GroupBy, TileValue } from './dashboards.js';
export { GroupBy, PIVOT_ORDERS, PivotOrder, PivotSettings } from './dashboards.js';
import { FieldId, type FieldMeta } from './fields.js';
import { WhereToken, operatorsForField } from './filters.js';
import type { RowData } from './rows.js';

/**
 * Chart and pivot views: a table's records summarized on the server, through the view's filter and
 * the reader's access, so they work on tables of any size.  Both read from
 * `POST /api/databases/:databaseId/views/:viewId/aggregate` (`ViewAggregateRequest`) →
 * `ViewAggregate` (session, read access).  The server computes from the view's saved settings, so
 * a changed setting is saved before its numbers are asked for.  An answer that can't be computed
 * carries one of the dashboard tiles' message keys.  A grid view's summary row reads from the same
 * route, with `summary` set.
 */

/**
 * What a grid column's footer shows about the view's records.  `range` is the largest number less
 * the smallest, or for dates the days from the earliest to the latest.
 */
export const SUMMARY_KINDS = [
  'none',
  'count',
  'filled',
  'empty',
  'percentFilled',
  'unique',
  'sum',
  'average',
  'median',
  'min',
  'max',
  'range',
  'earliest',
  'latest',
  'checked',
  'unchecked',
] as const;
export const SummaryKind = z.enum(SUMMARY_KINDS);
export type SummaryKind = z.infer<typeof SummaryKind>;

const NUMBER_TYPES: ReadonlySet<FieldMeta['type']> = new Set([
  'number',
  'currency',
  'percent',
  'duration',
  'rating',
  'autoNumber',
  'count',
]);
const DATE_TYPES: ReadonlySet<FieldMeta['type']> = new Set(['date', 'createdTime', 'lastModifiedTime']);

/** Whether each record holds one number, one date, or one checkbox, which some summaries need. */
function scalarOf(field: Pick<FieldMeta, 'type' | 'options'>): 'number' | 'date' | 'boolean' | null {
  if (field.type === 'formula' || field.type === 'rollup') {
    const result = (field.options as { resultType: string }).resultType;
    return result === 'number'
      ? 'number'
      : result === 'date' || result === 'datetime'
        ? 'date'
        : result === 'boolean'
          ? 'boolean'
          : null;
  }
  if (NUMBER_TYPES.has(field.type)) return 'number';
  if (DATE_TYPES.has(field.type)) return 'date';
  return field.type === 'checkbox' ? 'boolean' : null;
}

/**
 * The summaries a field's footer offers, in menu order.  Every field counts records, fields that
 * can be empty count filled and empty cells, and numbers, dates, and checkboxes add their own.
 */
export function summaryKindsFor(field: Pick<FieldMeta, 'type' | 'options'>): SummaryKind[] {
  const kinds: SummaryKind[] = ['none', 'count'];
  if (operatorsForField(field).includes('isEmpty')) kinds.push('filled', 'empty', 'percentFilled');
  const scalar = scalarOf(field);
  // Signatures and buttons have no values to tell apart, and a range's start alone isn't its value.
  if (
    field.type !== 'signature' &&
    field.type !== 'button' &&
    field.type !== 'changeLog' &&
    field.type !== 'dateRange' &&
    scalar !== 'boolean'
  )
    kinds.push('unique');
  if (field.type === 'multiCurrency') kinds.push('sum');
  if (field.type === 'time') kinds.push('earliest', 'latest');
  if (scalar === 'number') kinds.push('sum', 'average', 'median', 'min', 'max', 'range');
  if (scalar === 'date') kinds.push('earliest', 'latest', 'range');
  if (scalar === 'boolean') kinds.push('checked', 'unchecked');
  return kinds;
}

/**
 * The most groups one answer holds: rows (a chart's categories) and columns (its series).  Past
 * these, an answer keeps the first groups in order and says it left the rest out.
 */
export const AGGREGATE_CAPS = { rows: 1_000, columns: 100 } as const;

/**
 * Chart: the view's records grouped along one field and computed per group, drawn as the kinds of
 * chart a dashboard tile draws.  The view's own filter chooses the records.
 */
export const ChartSettings = z.object({
  chart: ChartType.default('column'),
  /** Categories along the axis, or slices of the pie, or null until chosen */
  groupBy: GroupBy.nullable().default(null),
  value: TileValue.prefault({}),
  /** Splits each category into series by another field, such as status */
  seriesBy: FieldId.nullable().default(null),
  sort: ChartSort.default('category'),
  stacked: z.boolean().default(false),
});
export type ChartSettings = z.infer<typeof ChartSettings>;

/**
 * A group's key as answers carry it: a choice, person, or record ID, a period's first day as
 * `YYYY-MM-DD`, a number, `true` or `false`, or the text itself.  Null is the group of records
 * with no value.
 */
export { GROUP_KEY_MAX_LENGTH } from './group-key.js';
export const GroupKey = z.union([z.string().max(GROUP_KEY_MAX_LENGTH), z.number(), z.null()]);
export type GroupKey = z.infer<typeof GroupKey>;

export const ViewAggregateRequest = z.object({
  /** For date groups and relative date filters */
  timeZone: z.string().min(1).max(64),
  /**
   * Lists the records behind one number instead of computing the view: the records in these row
   * groups, outermost first (a chart's category), and in this column (a chart's series).  Fewer
   * row keys than row fields reads an outer group, none reads every row, and leaving the column
   * out reads every column.
   */
  records: z
    .object({
      row: z.array(GroupKey).max(3).default([]),
      column: GroupKey.optional(),
      offset: z.number().int().min(0).max(1_000_000).default(0),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .optional(),
  /**
   * A grid view's summary row instead: the record count and each column's summary as the view's
   * `summaries` setting chooses them.  It can't be combined with `records`.
   */
  summary: z.boolean().default(false),
  /** A filter this read adds to the view's own, as a `where` token, so a summary row matches its rows */
  where: WhereToken.optional(),
});
export type ViewAggregateRequest = z.infer<typeof ViewAggregateRequest>;
/** A request as a client writes it, with the defaults left out */
export type ViewAggregateInput = z.input<typeof ViewAggregateRequest>;

/** A group, with its label formatted for people.  Records with no value have an empty label. */
export interface GroupLabel {
  key: GroupKey;
  label: string;
}

export interface ChartAggregate {
  kind: 'chart';
  categories: GroupLabel[];
  /** One unnamed series without `seriesBy`.  Values line up with the categories. */
  series: Array<GroupLabel & { values: Array<number | null> }>;
  /** Whether categories or series past the caps were left out */
  capped: { categories: boolean; series: boolean };
}

/** One number per value, in the order of the pivot's values, or null where no records fall. */
export type PivotCell = Array<number | null> | null;

export interface PivotRow {
  /**
   * The row's group keys, outermost first.  An outer group's own row has fewer keys than the pivot
   * has row fields.
   */
  keys: GroupKey[];
  /** The innermost group's label */
  label: string;
  /** One cell per column, and none without a column field */
  cells: PivotCell[];
  /** The row across every column, or null when a pivot with columns leaves out row totals */
  total: PivotCell;
}

export interface PivotAggregate {
  kind: 'pivot';
  /** The column field's groups in order, and none without a column field */
  columns: GroupLabel[];
  /** Every row in reading order: an outer group's row comes before the rows inside it */
  rows: PivotRow[];
  /** The Total row, or null without column totals */
  totals: Pick<PivotRow, 'cells' | 'total'> | null;
  capped: { rows: boolean; columns: boolean };
}

export interface AggregateRecords {
  kind: 'records';
  /** A page of the records in the view's order, with the primary field and the fields the view reads */
  rows: RowData[];
  /** Every record behind the number */
  total: number;
}

/**
 * One column's summary.  Counts are whole numbers and `percentFilled` is a share from 0 to 1.
 * Sums, averages, medians, minimums, maximums, and ranges of numbers are in the field's own unit.
 * `earliest` and `latest` are values of the field: `YYYY-MM-DD` for dates without times, and an ISO
 * 8601 instant otherwise.  A date `range` counts days, with a fraction for times.  The value is
 * null when no record has one to summarize.
 */
export interface SummaryResult {
  /** Totals are separate for each ISO currency code. */
  currencies?: Record<string, number>;
  kind: Exclude<SummaryKind, 'none'>;
  value: number | string | null;
}

export interface GridSummary {
  kind: 'summary';
  /** Every record in the view, which the primary field's footer shows */
  records: number;
  /**
   * By field ID.  Fields the view hides, fields the person can't see, and summaries that don't fit
   * their field (after it changed type, say) are left out.
   */
  values: Record<string, SummaryResult>;
}

export type ViewAggregate =
  | ChartAggregate
  | PivotAggregate
  | AggregateRecords
  | GridSummary
  /** The view's fields are gone or hidden from this person, or its values don't fit them */
  | { kind: 'error'; messageKey: string };
