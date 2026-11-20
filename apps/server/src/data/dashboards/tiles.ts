import {
  OTHER_GROUP_KEY,
  type FilterGroup,
  type RowData,
  type Tile,
  type TileData,
  type ViewMeta,
} from '@riosoma/contracts';
import { ident, join, keyword, query, sql, type Queryable, type Sql } from '@riosoma/db';
import { formatValue, type FormatContext } from '../format.js';
import { fetchPageByRid } from '../physical/records.js';
import { compileOrder } from '../physical/sorts.js';
import { compileViewOrder } from '../physical/order.js';
import { viewOrder } from '../view-aggregates/group-values.js';
import type { StoredField, StoredTable } from '../types.js';
import {
  dimension,
  measure,
  type DateBucket,
  type Dimension,
  type Measure,
  type ValueContext,
} from './values.js';

/**
 * Computes each kind of tile from the records a tile reads.  Numbers are one aggregate, charts
 * group in SQL and keep only their first categories, and record lists read one short page.
 */

export const UNAVAILABLE = 'dashboards.tile.unavailable';
export const BAD_AGGREGATE = 'dashboards.tile.badAggregate';

/** The key of the category, or series, that combines the rest */
export const OTHER_KEY = OTHER_GROUP_KEY;
const OTHER_LABEL = 'Other';
/** Series past this many combine into one, which keeps a stray text field from flooding a chart */
export const MAX_SERIES = 25;

/** The records a tile reads, as SQL, with the fields the person can see. */
export interface TileRecords {
  table: StoredTable;
  /** The record table */
  from: Sql;
  /** Live records the person may see, through the view's filter and then the tile's */
  where: Sql;
  /** The person's record predicate alone, for reading rows by row number */
  scope: Sql;
  fields: ReadonlyMap<string, StoredField>;
  view: ViewMeta | null;
  dashboardFilters?: FilterGroup[];
  values: ValueContext;
}

type NumberTile = Extract<Tile, { kind: 'number' }>;
export type ChartTile = Extract<Tile, { kind: 'chart' }>;
type RecordsTile = Extract<Tile, { kind: 'records' }>;

const badAggregate: TileData = { kind: 'error', messageKey: BAD_AGGREGATE };

export async function numberData(db: Queryable, tile: NumberTile, s: TileRecords): Promise<TileData> {
  const m = measure(tile.value, s.fields, s.values);
  if (!m) return badAggregate;
  const result = await query<{ records: number; value: number | null }>(
    db,
    m.join
      ? sql`SELECT (SELECT count(*) FROM ${s.from} WHERE ${s.where})::double precision AS records,
        (SELECT ${m.expr} FROM ${s.from} ${m.join} WHERE ${s.where}) AS value`
      : sql`SELECT count(*)::double precision AS records, ${m.expr} AS value FROM ${s.from} WHERE ${s.where}`,
  );
  const row = result.rows[0]!;
  return { kind: 'number', value: row.value ?? m.empty, records: row.records };
}

const FORMAT: FormatContext = {
  locale: 'en-US',
  timeZone: 'UTC',
  people: new Map(),
  files: new Map(),
  linked: new Map(),
};
const DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const MONTH = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' });

function utcDay(year: number, month: number, day: number): Date {
  const date = new Date(0);
  // Unlike Date.UTC, this keeps years before 100 as they are.
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

/** A period's label: "Sep 27, 2026", "Sep 21 – 27, 2026", "Sep 2026", "Q3 2026", or "2026". */
export function dateLabel(key: string, bucket: DateBucket): string {
  const match = /^(-?\d+)-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return key;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const start = utcDay(year, month, day);
  switch (bucket) {
    case 'day':
      return DAY.format(start);
    case 'week':
      return DAY.formatRange(start, utcDay(year, month, day + 6));
    case 'month':
      return MONTH.format(start);
    case 'quarter':
      return `Q${Math.floor((month - 1) / 3) + 1} ${year}`;
    case 'year':
      return String(year);
  }
}

/** A category's label, formatted for people.  Empty values have no label. */
export function labelOf(d: Dimension, key: string | null, named: string | null): string {
  if (key === null) return '';
  const kind = d.kind;
  switch (kind.type) {
    case 'number':
      return kind.format ? formatValue(kind.format, Number(key), FORMAT) : key;
    case 'date':
    case 'datetime':
      return dateLabel(key, kind.bucket);
    case 'boolean':
      return key === 'true' ? 'Checked' : 'Unchecked';
    case 'choice':
      return named ?? kind.choices?.find((choice) => choice.id === key)?.name ?? '';
    case 'person':
    case 'record':
      return named ?? '';
    case 'text':
      return key;
  }
}

export interface Group {
  key: string | null;
  label: string | null;
}

/** Whether a row's value is one of these groups, the empty group included. */
export function among(d: Dimension, groups: readonly Group[]): Sql {
  const keys = groups.flatMap((group) => (group.key === null ? [] : [group.key]));
  const empty = groups.some((group) => group.key === null);
  return sql`(COALESCE(${d.value} = ANY(${d.cast(keys)}), false) OR (${d.value} IS NULL AND ${empty}))`;
}

export const joins = (...parts: Array<Sql | null | undefined>) =>
  join(
    parts.filter((part): part is Sql => part !== null && part !== undefined),
    ' ',
  );

/** What a chart groups by and measures, or null when its fields can't be grouped or measured. */
export function chartPlan(
  tile: ChartTile,
  s: TileRecords,
): { category: Dimension; series: Dimension | undefined; measure: Measure } | null {
  const fieldOf = (id: string) => s.fields.get(id)!;
  const category = dimension(fieldOf(tile.groupBy.fieldId), s.values, 'category', tile.groupBy.dateBucket);
  const series = tile.seriesBy ? dimension(fieldOf(tile.seriesBy), s.values, 'series', null) : undefined;
  const m = measure(tile.value, s.fields, s.values);
  if (!category || series === null || !m) return null;
  return { category, series, measure: m };
}

/**
 * The categories a chart keeps, in its order, and whether more were combined as "Other".  The
 * records behind a chart's parts read these again, so "Other" means the same there.
 */
export async function keptCategories(
  db: Queryable,
  tile: ChartTile,
  s: TileRecords,
  category: Dimension,
  m: Measure,
): Promise<{ kept: Array<Group & { total: number | null }>; truncated: boolean }> {
  const byCategory = sql`(ranked.v IS NULL), ${category.order(sql`ranked.v`, sql`ranked.label`)} NULLS LAST, ranked.key`;
  const order =
    tile.sort === 'category'
      ? byCategory
      : sql`ranked.total ${keyword(tile.sort === 'valueDescending' ? 'DESC' : 'ASC')} NULLS LAST, ${byCategory}`;
  const ranked = await query<Group & { total: number | null }>(
    db,
    sql`SELECT ranked.key, ranked.label, ranked.total FROM (
      SELECT grouped.v, ${category.key(sql`grouped.v`)} AS key, ${category.label(sql`grouped.v`)} AS label,
        grouped.total
      FROM (SELECT ${category.value} AS v, ${m.expr} AS total
        FROM ${s.from} ${joins(category.join, m.join)} WHERE ${s.where} GROUP BY 1) AS grouped
    ) AS ranked ORDER BY ${order} LIMIT ${tile.limit + 1}`,
  );
  return { kept: ranked.rows.slice(0, tile.limit), truncated: ranked.rows.length > tile.limit };
}

/** The series a chart keeps, in their own order, and whether more were combined as "Other". */
export async function keptSeries(
  db: Queryable,
  s: TileRecords,
  series: Dimension,
): Promise<{ kept: Group[]; truncated: boolean }> {
  const found = await query<Group>(
    db,
    sql`SELECT ranked.key, ranked.label FROM (
      SELECT grouped.v, ${series.key(sql`grouped.v`)} AS key, ${series.label(sql`grouped.v`)} AS label
      FROM (SELECT ${series.value} AS v FROM ${s.from} ${joins(series.join)} WHERE ${s.where} GROUP BY 1) AS grouped
    ) AS ranked
    ORDER BY (ranked.v IS NULL), ${series.order(sql`ranked.v`, sql`ranked.label`)} NULLS LAST, ranked.key
    LIMIT ${MAX_SERIES + 1}`,
  );
  return { kept: found.rows.slice(0, MAX_SERIES), truncated: found.rows.length > MAX_SERIES };
}

/**
 * Groups by a field, sorts the groups as asked, and keeps the first `limit`, combining the rest as
 * "Other".  With a series, a second pass splits each kept group by the series field.  Records with
 * no value form their own group, keyed null.
 */
export async function chartData(db: Queryable, tile: ChartTile, s: TileRecords): Promise<TileData> {
  const plan = chartPlan(tile, s);
  if (!plan) return badAggregate;
  const { category, series, measure: m } = plan;
  const { kept, truncated } = await keptCategories(db, tile, s, category, m);

  let splits: Group[] = [];
  let splitsTruncated = false;
  if (series) ({ kept: splits, truncated: splitsTruncated } = await keptSeries(db, s, series));

  const categories: Array<{ key: string | number | null; label: string }> = kept.map((group) => ({
    key: category.keyOf(group.key),
    label: labelOf(category, group.key, group.label),
  }));
  if (truncated) categories.push({ key: OTHER_KEY, label: OTHER_LABEL });
  const lines: Array<{ key: string | number | null; label: string }> = series
    ? splits.map((group) => ({
        key: series.keyOf(group.key),
        label: labelOf(series, group.key, group.label),
      }))
    : [{ key: null, label: '' }];
  if (splitsTruncated) lines.push({ key: OTHER_KEY, label: OTHER_LABEL });
  const values = lines.map(() => categories.map((): number | null => m.empty));

  if (!series && !truncated) {
    kept.forEach((group, index) => {
      values[0]![index] = group.total ?? m.empty;
    });
  } else {
    const keptIn = among(category, kept);
    const splitIn = series ? among(series, splits) : sql`TRUE`;
    const cells = await query<{
      key: string | null;
      other: boolean;
      series: string | null;
      series_other: boolean;
      total: number | null;
    }>(
      db,
      sql`SELECT ${category.key(sql`cells.c`)} AS key, cells.c_other AS other,
        ${series ? series.key(sql`cells.s`) : sql`NULL::text`} AS series, cells.s_other AS series_other, cells.total
      FROM (SELECT CASE WHEN ${keptIn} THEN ${category.value} END AS c, NOT ${keptIn} AS c_other,
          ${series ? sql`CASE WHEN ${splitIn} THEN ${series.value} END` : sql`NULL::text`} AS s,
          NOT ${splitIn} AS s_other, ${m.expr} AS total
        FROM ${s.from} ${joins(category.join, series?.join, m.join)} WHERE ${s.where}
        GROUP BY 1, 2, 3, 4) AS cells`,
    );
    const categoryIndex = new Map(kept.map((group, index) => [group.key, index]));
    const lineIndex = new Map(splits.map((group, index) => [group.key, index]));
    for (const cell of cells.rows) {
      const column = cell.other ? categories.length - 1 : categoryIndex.get(cell.key);
      const line = !series ? 0 : cell.series_other ? lines.length - 1 : lineIndex.get(cell.series);
      if (column === undefined || line === undefined) continue;
      values[line]![column] = cell.total ?? m.empty;
    }
  }
  return {
    kind: 'chart',
    categories,
    series: lines.map((line, index) => ({ ...line, values: values[index]! })),
    truncated,
  };
}

/** The first records in the view's order, with the tile's fields and the primary field. */
export async function recordsData(
  db: Queryable,
  tile: RecordsTile,
  s: TileRecords,
  dataSchema: string,
  appSchema: string,
  followViewOrder = false,
): Promise<TileData> {
  const shown = [...new Set([s.table.primaryFieldId, ...tile.fieldIds])].flatMap((id) => {
    const field = s.fields.get(id);
    return field ? [field] : [];
  });
  const order =
    followViewOrder && s.view
      ? compileViewOrder(
          s.values.schemas,
          s.fields,
          await viewOrder(
            db,
            s.values.schemas,
            {
              table: s.table,
              view: s.view,
              fields: [...s.fields.values()],
              predicate: s.scope,
              context: s.values.read,
            },
            s.fields,
          ),
          s.values.read,
        )
      : compileOrder(s.view?.config.sorts ?? [], s.fields, s.values.read, dataSchema, appSchema);
  const page = await query<{ rid: string }>(
    db,
    sql`SELECT ${ident('__rid')} AS rid FROM ${s.from} WHERE ${s.where} ORDER BY ${order} LIMIT ${tile.limit}`,
  );
  const total = await query<{ total: number }>(
    db,
    sql`SELECT count(*)::double precision AS total FROM ${s.from} WHERE ${s.where}`,
  );
  const rows = await fetchPageByRid(
    db,
    dataSchema,
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
