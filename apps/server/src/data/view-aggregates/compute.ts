import type {
  ChartAggregate,
  ChartSettings,
  ChartSort,
  GroupKey,
  PivotAggregate,
  PivotCell,
  PivotOrder,
  PivotRow,
  PivotSettings,
  RowData,
  ViewAggregate,
  ViewAggregateRequest,
} from '@riosoma/contracts';
import { ident, join, query, sql, type Queryable, type Sql } from '@riosoma/db';
import { BAD_AGGREGATE, UNAVAILABLE, among, joins, labelOf, type TileRecords } from '../dashboards/tiles.js';
import { dimension, measure, type Dimension, type Measure } from '../dashboards/values.js';
import { fetchPageByRid } from '../physical/records.js';
import { compileOrder } from '../physical/sorts.js';
import { summarize, type RankedRow, type Summary, type Values } from './summary.js';

/**
 * What a chart or pivot view shows, and the records behind any of its numbers, from the view's
 * saved settings.  A field the person can't see, or one that's gone, makes the whole answer
 * unavailable rather than quietly leaving part of it out.
 */

const unavailable: ViewAggregate = { kind: 'error', messageKey: UNAVAILABLE };
const badAggregate: ViewAggregate = { kind: 'error', messageKey: BAD_AGGREGATE };

/** A chart's categories in their own order, or by value: the pivot's orders by another name. */
const CHART_ORDERS: Record<ChartSort, PivotOrder> = {
  category: 'labelAscending',
  valueDescending: 'valueDescending',
  valueAscending: 'valueAscending',
};

/** The groups and values a view reads. */
export interface Plan {
  rows: Dimension[];
  column: Dimension | null;
  measures: Measure[];
  /** Every field the view reads, for listing its records */
  fieldIds: string[];
}

function chartPlan(s: TileRecords, settings: ChartSettings): Plan | ViewAggregate {
  const group = settings.groupBy!;
  const fieldIds = [group.fieldId, settings.seriesBy, settings.value.fieldId].filter(
    (id): id is string => id !== null,
  );
  if (fieldIds.some((id) => !s.fields.has(id))) return unavailable;
  const field = (id: string) => s.fields.get(id)!;
  const category = dimension(field(group.fieldId), s.values, 'r0', group.dateBucket);
  const series = settings.seriesBy ? dimension(field(settings.seriesBy), s.values, 'c', null) : null;
  const value = measure(settings.value, s.fields, s.values);
  if (!category || (settings.seriesBy && !series) || !value) return badAggregate;
  return { rows: [category], column: series, measures: [value], fieldIds };
}

export function pivotPlan(s: TileRecords, settings: PivotSettings): Plan | ViewAggregate {
  const fieldIds = [
    ...settings.rows.map((group) => group.fieldId),
    ...(settings.column ? [settings.column.fieldId] : []),
    ...settings.values.flatMap((value) => (value.fieldId ? [value.fieldId] : [])),
  ];
  if (fieldIds.some((id) => !s.fields.has(id))) return unavailable;
  const field = (id: string) => s.fields.get(id)!;
  const rows = settings.rows.map((group, j) =>
    dimension(field(group.fieldId), s.values, `r${j}`, group.dateBucket),
  );
  const column = settings.column
    ? dimension(field(settings.column.fieldId), s.values, 'c', settings.column.dateBucket)
    : null;
  const measures = settings.values.map((value) => measure(value, s.fields, s.values));
  if (rows.some((d) => !d) || (settings.column && !column) || measures.some((m) => !m)) return badAggregate;
  return {
    rows: rows.filter((d): d is Dimension => d !== null),
    column,
    measures: measures.filter((m): m is Measure => m !== null),
    fieldIds: [...new Set(fieldIds)],
  };
}

export const isAnswer = (plan: Plan | ViewAggregate): plan is ViewAggregate => 'kind' in plan;

export async function chartAggregate(
  db: Queryable,
  s: TileRecords,
  settings: ChartSettings,
  deadline: () => void,
): Promise<ViewAggregate> {
  const plan = chartPlan(s, settings);
  if (isAnswer(plan)) return plan;
  const [category] = plan.rows as [Dimension];
  const { column: series } = plan;
  const [value] = plan.measures as [Measure];
  const summary = await summarize(db, s, {
    rows: plan.rows,
    column: series,
    measures: plan.measures,
    order: CHART_ORDERS[settings.sort],
    rowTotals: !series,
    columnTotals: false,
    groups: false,
    deadline,
  });
  const own = (row: RankedRow) => row.tuples[0]!;
  const answer: ChartAggregate = {
    kind: 'chart',
    categories: summary.rows.map((row) => {
      const level = row.levels[0]!;
      return { key: category.keyOf(level.key), label: labelOf(category, level.key, level.name) };
    }),
    series: series
      ? summary.columns.map((line) => ({
          key: series.keyOf(line.key),
          label: labelOf(series, line.key, line.name),
          values: summary.rows.map((row) => summary.cells.get(own(row))?.get(line.tuple)?.[0] ?? value.empty),
        }))
      : [
          {
            key: null,
            label: '',
            values: summary.rows.map((row) => summary.totals.get(own(row))?.[0] ?? value.empty),
          },
        ],
    capped: { categories: summary.capped.rows, series: summary.capped.columns },
  };
  return answer;
}

/** Every row in reading order, each outer group's row before the rows inside it. */
function pivotRows(plan: Plan, summary: Summary, withTotals: boolean): PivotRow[] {
  const depth = plan.rows.length;
  const cell = (values: Values | undefined): PivotCell => values ?? null;
  const rowAt = (row: RankedRow, length: number): PivotRow => {
    const tuple = row.tuples[length - 1]!;
    const level = row.levels[length - 1]!;
    return {
      keys: row.levels.slice(0, length).map((item, j) => plan.rows[j]!.keyOf(item.key)),
      label: labelOf(plan.rows[length - 1]!, level.key, level.name),
      cells: summary.columns.map((column) => cell(summary.cells.get(tuple)?.get(column.tuple))),
      total: withTotals ? cell(summary.totals.get(tuple)) : null,
    };
  };
  const rows: PivotRow[] = [];
  let previous: RankedRow | null = null;
  for (const row of summary.rows) {
    // The outermost group that changed starts here, and every group inside it starts with it.
    const changed = row.tuples.findIndex((tuple, j) => j < depth - 1 && previous?.tuples[j] !== tuple);
    if (changed >= 0) for (let j = changed; j < depth - 1; j++) rows.push(rowAt(row, j + 1));
    rows.push(rowAt(row, depth));
    previous = row;
  }
  return rows;
}

export async function pivotAggregate(
  db: Queryable,
  s: TileRecords,
  settings: PivotSettings,
  deadline: () => void,
): Promise<ViewAggregate> {
  const plan = pivotPlan(s, settings);
  if (isAnswer(plan)) return plan;
  const withTotals = !plan.column || settings.rowTotals;
  const summary = await summarize(db, s, {
    rows: plan.rows,
    column: plan.column,
    measures: plan.measures,
    order: settings.order,
    rowTotals: settings.rowTotals,
    columnTotals: settings.columnTotals,
    groups: plan.rows.length > 1,
    deadline,
  });
  const column = plan.column;
  const answer: PivotAggregate = {
    kind: 'pivot',
    columns: column
      ? summary.columns.map((item) => ({
          key: column.keyOf(item.key),
          label: labelOf(column, item.key, item.name),
        }))
      : [],
    rows: pivotRows(plan, summary, withTotals),
    totals: settings.columnTotals
      ? {
          cells: summary.columns.map((item) => summary.columnTotals.get(item.tuple) ?? null),
          total: withTotals ? summary.grand : null,
        }
      : null,
    capped: summary.capped,
  };
  return answer;
}

/** A group key as the dimension's key text, the way the database compares it. */
const keyText = (key: GroupKey): string | null => (key === null ? null : String(key));

/** Whether the request's keys can name groups of this view at all. */
export function fitsView(
  settings: { rows: number; column: boolean },
  target: NonNullable<ViewAggregateRequest['records']>,
): boolean {
  return target.row.length <= settings.rows && (target.column === undefined || settings.column);
}

/**
 * A page of the records behind one number, in the view's order: the records in the row groups
 * given and in the column when one is given.  The joins a list field needs match each record at
 * most once, since each group names one of its values.
 */
export async function aggregateRecords(
  db: Queryable,
  s: TileRecords,
  plan: { rows: Dimension[]; column: Dimension | null; fieldIds: readonly string[] },
  target: NonNullable<ViewAggregateRequest['records']>,
  schemas: { data: string; app: string },
): Promise<ViewAggregate> {
  const dims = plan.rows.slice(0, target.row.length);
  const conditions: Sql[] = dims.map((d, j) => among(d, [{ key: keyText(target.row[j]!), label: null }]));
  const column = target.column === undefined ? null : plan.column;
  if (column) conditions.push(among(column, [{ key: keyText(target.column!), label: null }]));
  const from = sql`${s.from} ${joins(...dims.map((d) => d.join), column?.join)}`;
  const where = sql`${s.where}${conditions.length ? sql` AND ${join(conditions, ' AND ')}` : sql``}`;
  const order = compileOrder(s.view?.config.sorts ?? [], s.fields, s.values.read, schemas.data, schemas.app);
  const page = await query<{ rid: string }>(
    db,
    sql`SELECT ${ident('__rid')} AS rid FROM ${from} WHERE ${where}
      ORDER BY ${order} LIMIT ${target.limit} OFFSET ${target.offset}`,
  );
  const total = await query<{ total: number }>(
    db,
    sql`SELECT count(*)::double precision AS total FROM ${from} WHERE ${where}`,
  );
  const shown = [...new Set([s.table.primaryFieldId, ...plan.fieldIds])].flatMap((id) => {
    const field = s.fields.get(id);
    return field ? [field] : [];
  });
  const rows = await fetchPageByRid(
    db,
    schemas.data,
    s.table.id,
    shown,
    page.rows.map((row) => Number(row.rid)),
    s.scope,
    s.values.read,
  );
  return {
    kind: 'records',
    rows: rows.filter((row): row is RowData => row !== null),
    total: total.rows[0]!.total,
  };
}

/** The groups a view reads, for listing records, or the answer that explains why it can't. */
export function viewPlan(
  s: TileRecords,
  type: 'chart' | 'pivot',
  settings: { chart: ChartSettings; pivot: PivotSettings },
): Plan | ViewAggregate {
  return type === 'chart' ? chartPlan(s, settings.chart) : pivotPlan(s, settings.pivot);
}
