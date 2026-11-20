import { TILE_ID_PATTERN } from './group-key.js';
import { z } from 'zod';
import { FieldId, LIMITS, Name, TableId, ViewId } from './fields.js';
import { FilterGroup } from './filters.js';
import type { PivotAggregate } from './aggregates.js';
import type { RowData } from './rows.js';

/**
 * Dashboards: pages of numbers, charts, pivot tables, record lists, and notes about a database's tables, kept
 * in the database beside its tables.  Tiles sit on a 12-column grid.  Every tile reads through
 * the same access rules as the grid, so two people can see different numbers on one dashboard.
 *
 * Dashboards change through commands (`dashboard.create`, `dashboard.update`, `dashboard.move`,
 * `dashboard.trash`, `dashboard.restore`), so they undo, broadcast, and go to the trash like
 * tables.  Tile data comes from `POST /api/dashboards/:dashboardId/data` (`DashboardDataRequest`)
 * → `DashboardData` (session, read access).
 */
export const DashboardId = z.string().regex(/^dsh[0-9A-Za-z]{14}$/);
export const TileId = z.string().regex(TILE_ID_PATTERN);

export const AGGREGATES = ['count', 'countUnique', 'sum', 'average', 'min', 'max'] as const;
export const Aggregate = z.enum(AGGREGATES);
export type Aggregate = z.infer<typeof Aggregate>;

export const CHART_TYPES = ['bar', 'column', 'line', 'area', 'pie', 'donut', 'scatter'] as const;
export const ChartType = z.enum(CHART_TYPES);
export type ChartType = z.infer<typeof ChartType>;

export const DATE_BUCKETS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export const DateBucket = z.enum(DATE_BUCKETS);
export type DateBucket = z.infer<typeof DateBucket>;

/** How a chart orders its categories: in their own order, or by value. */
export const CHART_SORTS = ['category', 'valueDescending', 'valueAscending'] as const;
export const ChartSort = z.enum(CHART_SORTS);
export type ChartSort = z.infer<typeof ChartSort>;

/** Where a tile's records come from: a table, narrowed by a view and then the tile's own filter. */
export const TileSource = z.object({
  tableId: TableId,
  viewId: ViewId.nullable().default(null),
  filter: FilterGroup.nullable().default(null),
});
export type TileSource = z.infer<typeof TileSource>;

/** A value to compute: how many records, or a function of one field's values. */
export const TileValue = z.object({
  fn: Aggregate.default('count'),
  /** Null only for `count` */
  fieldId: FieldId.nullable().default(null),
});
export type TileValue = z.infer<typeof TileValue>;

/** Position on the 12-column grid, in columns and rows of 80 pixels. */
export const TilePlace = z.object({
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0).max(1_000),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(12),
});
export type TilePlace = z.infer<typeof TilePlace>;

const tileBase = {
  id: TileId,
  title: z.string().max(LIMITS.nameLength).default(''),
  place: TilePlace,
};

/** What a number tile computes.  Interface number blocks share it. */
export const NumberTileSettings = z.object({ source: TileSource, value: TileValue });

/** What a chart tile computes and how it draws it.  Interface chart blocks share it. */
export const ChartTileSettings = z.object({
  source: TileSource,
  chart: ChartType.default('column'),
  /** Categories along the axis or slices of the pie */
  groupBy: z.object({
    fieldId: FieldId,
    /** Groups dates by period instead of by day */
    dateBucket: DateBucket.nullable().default(null),
  }),
  value: TileValue,
  /** Splits each category into series by another field, such as status */
  seriesBy: FieldId.nullable().default(null),
  sort: ChartSort.default('category'),
  /** Categories shown, with the rest combined as "Other" */
  limit: z.number().int().min(1).max(100).default(20),
  stacked: z.boolean().default(false),
});

/** Records grouped by one field's values, with dates grouped by a period. */
export const GroupBy = z.object({
  fieldId: FieldId,
  /** Groups dates by period instead of by day */
  dateBucket: DateBucket.nullable().default(null),
});
export type GroupBy = z.infer<typeof GroupBy>;

/** Pivot rows in their groups' own order, or by the first value, either way around. */
export const PIVOT_ORDERS = [
  'labelAscending',
  'labelDescending',
  'valueAscending',
  'valueDescending',
] as const;
export const PivotOrder = z.enum(PIVOT_ORDERS);
export type PivotOrder = z.infer<typeof PivotOrder>;

/**
 * Pivot table: records grouped into rows by up to three fields, outermost first, and into columns
 * by one more, with up to five values computed for every cell.  Each outer group has a row of its
 * own above the rows inside it.
 */
export const PivotSettings = z.object({
  /** Empty until chosen */
  rows: z.array(GroupBy).max(3).default([]),
  column: GroupBy.nullable().default(null),
  values: z
    .array(TileValue)
    .min(1)
    .max(5)
    .default(() => [{ fn: 'count' as const, fieldId: null }]),
  /** A Total column at the end of each row */
  rowTotals: z.boolean().default(true),
  /** A Total row under the columns */
  columnTotals: z.boolean().default(true),
  order: PivotOrder.default('labelAscending'),
});
export type PivotSettings = z.infer<typeof PivotSettings>;

export const Tile = z.discriminatedUnion('kind', [
  z.object({ ...tileBase, kind: z.literal('number'), ...NumberTileSettings.shape }),
  z.object({ ...tileBase, kind: z.literal('chart'), ...ChartTileSettings.shape }),
  z.object({ ...tileBase, kind: z.literal('pivot'), source: TileSource, pivot: PivotSettings }),
  z.object({
    ...tileBase,
    kind: z.literal('records'),
    source: TileSource,
    fieldIds: z.array(FieldId).max(10).default([]),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  z.object({
    ...tileBase,
    kind: z.literal('text'),
    text: z.string().max(LIMITS.descriptionLength).default(''),
  }),
]);
export type Tile = z.infer<typeof Tile>;

export const DashboardConfig = z.object({ tiles: z.array(Tile).max(50).default([]) });
export type DashboardConfig = z.infer<typeof DashboardConfig>;

export const DashboardMeta = z.object({
  id: DashboardId,
  databaseId: z.string(),
  name: Name,
  position: z.number(),
  config: DashboardConfig,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DashboardMeta = z.infer<typeof DashboardMeta>;

export const DashboardCreate = z.object({
  id: DashboardId,
  name: Name,
  config: DashboardConfig.prefault({}),
});
export type DashboardCreate = z.infer<typeof DashboardCreate>;

/** Dashboard-wide conditions, including date ranges, narrowed separately for each table. */
export const DashboardFilters = z.array(z.object({ tableId: TableId, filter: FilterGroup })).max(50);
export type DashboardFilters = z.infer<typeof DashboardFilters>;

export const DashboardDataRequest = z.object({
  /** Tiles to compute; every data tile when left out */
  tileIds: z.array(TileId).max(50).optional(),
  /** For date buckets and relative date filters */
  timeZone: z.string().min(1).max(64),
  filters: DashboardFilters.optional(),
});
export type DashboardDataRequest = z.infer<typeof DashboardDataRequest>;

export type TileData =
  | PivotAggregate
  | { kind: 'number'; value: number | null; records: number }
  | {
      kind: 'chart';
      /** Category keys in order, with labels formatted for the person */
      categories: Array<{ key: string | number | null; label: string }>;
      /** One series without `seriesBy`; values line up with the categories */
      series: Array<{ key: string | number | null; label: string; values: Array<number | null> }>;
      /** Whether categories beyond the limit were combined into "Other" */
      truncated: boolean;
    }
  | { kind: 'records'; rows: RowData[]; total: number }
  /** A tile whose table, view, or fields are gone or hidden from this person */
  | { kind: 'error'; messageKey: string };

export interface DashboardData {
  tiles: Record<string, TileData>;
}
