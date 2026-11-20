import { AppError, isGroup, type DashboardConfig, type FilterGroup, type Tile } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type { CommandContext } from '../commands/context.js';

/** A tile that reads records. */
export type DataTile = Exclude<Tile, { kind: 'text' }>;

export function isDataTile(tile: Tile): tile is DataTile {
  return tile.kind !== 'text';
}

export function filterFieldIds(filter: FilterGroup | null | undefined): string[] {
  if (!filter) return [];
  return filter.conditions.flatMap((condition) =>
    isGroup(condition) ? filterFieldIds(condition) : [condition.fieldId],
  );
}

/** Every field a tile reads, including the ones its filter tests. */
export function tileFieldIds(tile: DataTile): string[] {
  const ids = filterFieldIds(tile.source.filter);
  switch (tile.kind) {
    case 'number':
      if (tile.value.fieldId) ids.push(tile.value.fieldId);
      break;
    case 'chart':
      ids.push(tile.groupBy.fieldId);
      if (tile.seriesBy) ids.push(tile.seriesBy);
      if (tile.value.fieldId) ids.push(tile.value.fieldId);
      break;
    case 'pivot':
      ids.push(...tile.pivot.rows.map((group) => group.fieldId));
      if (tile.pivot.column) ids.push(tile.pivot.column.fieldId);
      ids.push(...tile.pivot.values.flatMap((value) => (value.fieldId ? [value.fieldId] : [])));
      break;
    case 'records':
      ids.push(...tile.fieldIds);
      break;
  }
  return [...new Set(ids)];
}

function referenceKeys(tile: DataTile): string[] {
  const { tableId, viewId } = tile.source;
  return [
    `table:${tableId}`,
    ...(viewId ? [`view:${tableId}:${viewId}`] : []),
    ...tileFieldIds(tile).map((fieldId) => `field:${tableId}:${fieldId}`),
  ];
}

/**
 * Checks that every tile reads a table of this database, and views and fields of that table.
 * Trashed ones pass, since restoring them brings the tile back.  A reference the dashboard already
 * held passes too, even once a purge has removed what it pointed at, so one stale tile never
 * blocks editing the rest.  Anything else reads as not found, so IDs don't reveal what exists.
 */
export async function validateDashboardConfig(
  c: CommandContext,
  config: DashboardConfig,
  previous: DashboardConfig | null,
): Promise<void> {
  const tileIds = config.tiles.map((tile) => tile.id);
  if (new Set(tileIds).size !== tileIds.length)
    throw new AppError('validation_failed', 'errors.validationFailed');
  const tiles = config.tiles.filter(isDataTile);
  if (!tiles.length) return;
  const held = new Set(previous ? previous.tiles.filter(isDataTile).flatMap(referenceKeys) : []);
  const tableIds = [...new Set(tiles.map((tile) => tile.source.tableId))];
  const viewIds = [...new Set(tiles.flatMap((tile) => (tile.source.viewId ? [tile.source.viewId] : [])))];
  const fieldIds = [...new Set(tiles.flatMap(tileFieldIds))];
  const tables = await query<{ id: string }>(
    c.db,
    sql`SELECT id FROM ${ident(c.schemas.app, 'tables')}
    WHERE id = ANY(${tableIds}::text[]) AND database_id = ${c.databaseId} AND org_id = ${c.actor.orgId}`,
  );
  const views = await query<{ id: string; table_id: string }>(
    c.db,
    sql`SELECT id, table_id FROM ${ident(c.schemas.app, 'views')} WHERE id = ANY(${viewIds}::text[])`,
  );
  const fields = await query<{ id: string; table_id: string }>(
    c.db,
    sql`SELECT id, table_id FROM ${ident(c.schemas.app, 'fields')} WHERE id = ANY(${fieldIds}::text[])`,
  );
  const known = new Set([
    ...tables.rows.map((row) => `table:${row.id}`),
    ...views.rows.map((row) => `view:${row.table_id}:${row.id}`),
    ...fields.rows.map((row) => `field:${row.table_id}:${row.id}`),
  ]);
  // Views and fields match only with their own table, and the table only in this database.
  for (const key of tiles.flatMap(referenceKeys))
    if (!known.has(key) && !held.has(key)) throw new AppError('not_found', 'errors.notFound');
}
