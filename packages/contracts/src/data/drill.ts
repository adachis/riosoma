import { z } from 'zod';
import { PIVOT_ROW_MAX } from './group-key.js';
import { DashboardFilters } from './dashboards.js';
import { GroupKey } from './aggregates.js';
import type { RowData } from './rows.js';

/**
 * Dashboard drill-down: the records behind one category of a chart tile, or behind one part of a
 * category when the chart divides it by a series field, or behind a pivot cell or total.
 * `POST /api/dashboards/:dashboardId/tiles/:tileId/records` (`TileRecordsRequest`) →
 * `TileRecordsAnswer` (session, read access).
 *
 * The server writes the part as a filter on the chart's own grouping, then checks, in the same
 * snapshot as the records, that the filter picks out exactly the records the chart grouped there,
 * empty values and "Other" included.  When no filter can, the answer is an error that says why
 * instead of a list that is only close.  Records come through the reader's own access, with only
 * the fields they can see.
 */

/**
 * The key of the category, or series, that combines the rest of a chart's groups.  Postgres text
 * can't hold a NUL character, so no value's own key can ever match it.
 */
export { OTHER_GROUP_KEY, TILE_ID_PATTERN, isGroupKey, parsePivotSlice } from './group-key.js';

/** A part of a chart: a category's key, and a series key when the chart is divided. */
export const TileSlice = z.object({
  category: GroupKey,
  /** Left out for every part of the category */
  series: GroupKey.optional(),
});
export type TileSlice = z.infer<typeof TileSlice>;

/** A pivot cell, an outer group, or a total when row or column keys are omitted. */
export const PivotSlice = z.object({
  row: z.array(GroupKey).max(PIVOT_ROW_MAX),
  column: GroupKey.optional(),
});
export type PivotSlice = z.infer<typeof PivotSlice>;
export const DashboardSlice = z.union([TileSlice, PivotSlice]);
export type DashboardSlice = z.infer<typeof DashboardSlice>;

export const TileRecordsRequest = z.object({
  /** For date groups and relative date filters */
  timeZone: z.string().min(1).max(64),
  slice: DashboardSlice,
  filters: DashboardFilters.optional(),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(100).default(50),
});
export type TileRecordsRequest = z.infer<typeof TileRecordsRequest>;
/** A request as a client writes it, with the defaults left out */
export type TileRecordsInput = z.input<typeof TileRecordsRequest>;

export type TileRecordsAnswer =
  | {
      kind: 'records';
      /** A page of the records, in the order of the view the tile reads */
      rows: RowData[];
      total: number;
      /**
       * A grid view of the tile's table that lists exactly these records once `where` (a token for
       * `RowsQuery.where`) narrows it, or null when no grid view can
       */
      open: { viewId: string; where: string } | null;
    }
  | { kind: 'error'; messageKey: string; params?: Record<string, string | number> };
