import { resolveSelectOptions } from '../select-options.js';
import { readsLive } from '../../sources/live.js';
import {
  AppError,
  DashboardDataRequest,
  DashboardId,
  TileId,
  TileRecordsRequest,
  isTimeZone,
  type DashboardData,
  type DashboardFilters,
  type TileData,
  type TileRecordsAnswer,
  type ViewMeta,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../../auth/sessions.js';
import { parse } from '../../http/validate.js';
import { AccessScope } from '../access.js';
import { dataStore, type DataSchemas } from '../context.js';
import { loadDashboard, loadFields, loadTables, loadViews, type StoredDashboard } from '../metadata.js';
import { compileFilter } from '../physical/filters.js';
import type { ReadContext, StoredField, StoredTable } from '../types.js';
import { pivotAggregate } from '../view-aggregates/compute.js';
import { filterFieldIds, isDataTile, tileFieldIds, type DataTile } from './config.js';
import { pivotTileRecords, tileRecords } from './drill.js';
import { BAD_AGGREGATE, UNAVAILABLE, chartData, numberData, recordsData, type TileRecords } from './tiles.js';

/**
 * `POST /api/dashboards/:dashboardId/data`: every data tile's numbers, charts, pivots, and records, read
 * through the person's access in one consistent snapshot.  A tile that can't be read answers with
 * an error of its own, so one deleted field never blanks the whole dashboard.
 *
 * `POST /api/dashboards/:dashboardId/tiles/:tileId/records`: the records behind one part of a
 * chart or pivot tile, through the same access, in the same kind of snapshot.
 */

/** How long each tile's queries may run, and how long one request may spend on tiles. */
export const TILE_DEADLINES = { statementMs: 5_000, requestMs: 20_000 };

export const BUSY = 'errors.unavailable';

function unavailable(): never {
  throw new AppError('not_found', 'errors.notFound');
}

/** The message a failed tile answers with, or null when the failure isn't the tile's own. */
export function failure(error: unknown): string | null {
  if (error instanceof AppError) {
    if (error.code === 'unavailable') return BUSY;
    return error.code === 'not_found' ? UNAVAILABLE : BAD_AGGREGATE;
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === '57014') return BUSY;
  // Data errors, such as a formula's text that isn't a number, come from the tile's settings.
  if (typeof code === 'string' && code.startsWith('22')) return BAD_AGGREGATE;
  return null;
}

async function guarded<T extends TileData | TileRecordsAnswer>(
  db: Queryable,
  log: FastifyBaseLogger,
  tile: DataTile,
  statementMs: number,
  expires: number,
  work: (db: Queryable) => Promise<T>,
  validateRequest = false,
): Promise<T | Extract<TileData, { kind: 'error' }>> {
  await query(db, sql`SAVEPOINT tile`);
  try {
    const timed: Queryable = {
      query: new Proxy(db.query, {
        async apply(target, _receiver, args: unknown[]) {
          const remaining = expires - performance.now();
          if (remaining <= 0) throw new AppError('unavailable', BUSY);
          let timeout = Math.max(1, Math.ceil(Math.min(statementMs, remaining)));
          let refreshed = false;
          for (;;) {
            const started = performance.now();
            await query(db, sql`SELECT set_config('statement_timeout', ${String(timeout)}, true)`);
            const finished = performance.now();
            const left = expires - finished;
            if (left <= 0) throw new AppError('unavailable', BUSY);
            if (timeout <= Math.ceil(left)) break;
            // Setup spends request time too.  Repeated refreshes reserve time for the next setup
            // so a slow connection can still dispatch SQL within the remaining budget.
            const setupMs = refreshed ? finished - started : 0;
            timeout = Math.max(1, Math.floor(Math.min(statementMs, left) - setupMs));
            refreshed = true;
          }
          return Reflect.apply(target, db, args);
        },
      }),
    };
    const data = await work(timed);
    // Tile work only reads.  Rolling it back restores the timeout before release or commit,
    // including after a successful tile.  Releasing a savepoint would keep its SET LOCAL value.
    await query(db, sql`ROLLBACK TO SAVEPOINT tile`);
    await query(db, sql`RELEASE SAVEPOINT tile`);
    return data;
  } catch (error) {
    // Invalid drill-down keys belong to the request rather than the tile's settings.
    if (validateRequest && error instanceof AppError && error.code === 'validation_failed') throw error;
    const messageKey = failure(error);
    if (!messageKey) throw error;
    await query(db, sql`ROLLBACK TO SAVEPOINT tile`);
    await query(db, sql`RELEASE SAVEPOINT tile`);
    if (messageKey === BUSY) log.warn({ tileId: tile.id }, 'dashboard tile ran out of time');
    return { kind: 'error', messageKey };
  }
}

export async function naturalCollation(db: Queryable, schemas: DataSchemas): Promise<boolean> {
  const result = await query<{ available: boolean }>(
    db,
    sql`SELECT EXISTS (
      SELECT 1 FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace
      WHERE n.nspname = ${schemas.data} AND c.collname = 'rio_natural'
    ) AS available`,
  );
  return result.rows[0]!.available;
}

export interface Loaded {
  schemas: DataSchemas;
  filters?: DashboardFilters;
  scope: AccessScope;
  read: ReadContext;
  tables: ReadonlyMap<string, StoredTable>;
  fields: readonly StoredField[];
  views: ReadonlyMap<string, ViewMeta>;
}

/** The records a tile reads, or not found when its table, view, or fields are gone or hidden. */
export function recordsOf(tile: DataTile, loaded: Loaded): TileRecords {
  const { schemas, scope, read } = loaded;
  const table = loaded.tables.get(tile.source.tableId) ?? unavailable();
  // A live table's records live in its source, which tiles don't read.
  if (readsLive(table)) unavailable();
  const fields = new Map(
    scope
      .visibleFields(
        table.id,
        loaded.fields.filter((field) => field.tableId === table.id),
      )
      .map((field) => [field.id, field]),
  );
  const filters = loaded.filters?.filter((filter) => filter.tableId === table.id) ?? [];
  if (
    [...tileFieldIds(tile), ...filters.flatMap((item) => filterFieldIds(item.filter))].some(
      (id) => !fields.has(id),
    )
  )
    unavailable();
  const view = tile.source.viewId ? (loaded.views.get(tile.source.viewId) ?? unavailable()) : null;
  if (view && view.tableId !== table.id) unavailable();
  const predicate = scope.recordPredicate(table.id);
  // The view's filter reads the way the grid reads it, then the tile's own filter narrows it.
  const where = sql`${ident(table.id, '__deleted_at')} IS NULL AND NOT ${ident(table.id, '__source_gone')}
    AND (${predicate}) AND ${compileFilter(view?.config.filter, fields, read, schemas.app)}
    AND ${compileFilter(tile.source.filter, fields, read, schemas.app)}
    AND ${compileFilter({ conjunction: 'and', conditions: filters.map((item) => item.filter) }, fields, read, schemas.app)}`;
  return {
    table,
    from: sql`${ident(schemas.data, table.id)}`,
    where,
    scope: predicate,
    fields,
    view,
    dashboardFilters: filters.map((item) => item.filter),
    values: {
      schemas,
      read,
      tableId: table.id,
      visible: (field) => scope.visibleFields(field.tableId, [field]).length > 0,
      recordPredicate: (tableId, alias) =>
        alias ? scope.linkedPredicate(tableId, alias) : scope.recordPredicate(tableId),
    },
  };
}

async function computeTiles(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  dashboard: StoredDashboard,
  input: DashboardDataRequest,
  log: FastifyBaseLogger,
  statementMs: number,
): Promise<Record<string, TileData>> {
  const wanted = input.tileIds ? new Set(input.tileIds) : null;
  const tiles = dashboard.config.tiles.filter(isDataTile).filter((tile) => !wanted || wanted.has(tile.id));
  const tileLog = log.child({ dashboardId: dashboard.id });
  return computeDataTiles(
    db,
    schemas,
    scope,
    dashboard.databaseId,
    tiles,
    input.timeZone,
    tileLog,
    statementMs,
    false,
    {},
    false,
    input.filters,
  );
}

/** The tables, fields, and views these tiles read, as the person may see them. */
export async function loadTileContext(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  databaseId: string,
  tiles: readonly DataTile[],
  timeZone: string,
  publicRead = false,
  filters?: DashboardFilters,
): Promise<Loaded> {
  const tables = new Map((await loadTables(db, schemas, databaseId)).map((table) => [table.id, table]));
  const tableIds = [...new Set(tiles.map((tile) => tile.source.tableId))].filter((id) => tables.has(id));
  return {
    schemas,
    filters,
    scope,
    read: { timeZone, now: new Date(), natural: await naturalCollation(db, schemas) },
    tables,
    fields: await resolveSelectOptions(
      db,
      schemas,
      publicRead ? undefined : scope,
      (await loadFields(db, schemas, tableIds)).filter(
        (field) =>
          scope.visibleFields(field.tableId, [field]).length &&
          (!publicRead || !scope.restrictedForAnyone(field.tableId, field)),
      ),
    ),
    views: new Map((await loadViews(db, schemas, tableIds)).map((view) => [view.id, view])),
  };
}

/**
 * Tiles over one database's tables, each read through the person's access in the transaction's
 * snapshot and answered on its own.  Interface blocks that work like tiles are computed here too.
 */
export async function computeDataTiles(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  databaseId: string,
  tiles: readonly DataTile[],
  timeZone: string,
  tileLog: FastifyBaseLogger,
  statementMs: number,
  publicRead = false,
  readOptions: Pick<ReadContext, 'simulatedRids'> = {},
  followViewOrder = false,
  filters?: DashboardFilters,
): Promise<Record<string, TileData>> {
  const loaded = await loadTileContext(db, schemas, scope, databaseId, tiles, timeZone, publicRead, filters);
  Object.assign(loaded.read, readOptions);
  const expires = performance.now() + TILE_DEADLINES.requestMs;
  const result: Record<string, TileData> = {};
  for (const tile of tiles) {
    if (performance.now() >= expires) {
      result[tile.id] = { kind: 'error', messageKey: BUSY };
      continue;
    }
    result[tile.id] = await guarded(db, tileLog, tile, statementMs, expires, async (timed) => {
      const records = recordsOf(tile, loaded);
      switch (tile.kind) {
        case 'number':
          return numberData(timed, tile, records);
        case 'chart':
          return chartData(timed, tile, records);
        case 'pivot':
          if (!tile.pivot.rows.length) return { kind: 'error', messageKey: UNAVAILABLE };
          {
            const answer = await pivotAggregate(timed, records, tile.pivot, () => {
              if (performance.now() >= expires) throw new AppError('unavailable', BUSY);
            });
            return answer.kind === 'pivot' || answer.kind === 'error'
              ? answer
              : { kind: 'error', messageKey: BAD_AGGREGATE };
          }
        case 'records':
          return recordsData(timed, tile, records, schemas.data, schemas.app, followViewOrder);
      }
    });
  }
  return result;
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  const session = { config: { policy: { kind: 'session' as const } } };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.post('/api/dashboards/:dashboardId/data', session, async (request): Promise<DashboardData> => {
    const { dashboardId } = parse(z.object({ dashboardId: DashboardId }), request.params);
    const input = parse(DashboardDataRequest, request.body);
    if (!isTimeZone(input.timeZone)) throw new AppError('validation_failed', 'errors.validationFailed');
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    // The driver's own deadline drops the connection, so the database has to give up first.
    const statementMs = Math.max(
      1,
      Math.min(TILE_DEADLINES.statementMs, app.ctx.config.dbQueryTimeoutMs - 1_000),
    );
    return withTransaction(pool, async (db) => {
      // One snapshot for every tile, so the numbers on a dashboard agree with each other.
      await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const dashboard = await loadDashboard(db, schemas, dashboardId);
      if (!dashboard || dashboard.trashed || dashboard.orgId !== actor.orgId) unavailable();
      const scope = new AccessScope(db, schemas, actor);
      await scope.require(dashboard.databaseId, 'read');
      const tiles = await computeTiles(db, schemas, scope, dashboard, input, request.log, statementMs);
      return { tiles };
    });
  });

  app.post(
    '/api/dashboards/:dashboardId/tiles/:tileId/records',
    session,
    async (request): Promise<TileRecordsAnswer> => {
      const { dashboardId, tileId } = parse(
        z.object({ dashboardId: DashboardId, tileId: TileId }),
        request.params,
      );
      const input = parse(TileRecordsRequest, request.body);
      if (!isTimeZone(input.timeZone)) throw new AppError('validation_failed', 'errors.validationFailed');
      const actor = requireActor(request);
      const { pool, schemas } = dataStore(app.ctx);
      const statementMs = Math.max(
        1,
        Math.min(TILE_DEADLINES.statementMs, app.ctx.config.dbQueryTimeoutMs - 1_000),
      );
      return withTransaction(pool, async (db) => {
        // The check that the filter matches the chart and the page it lists see the same records.
        await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
        const dashboard = await loadDashboard(db, schemas, dashboardId);
        if (!dashboard || dashboard.trashed || dashboard.orgId !== actor.orgId) unavailable();
        const scope = new AccessScope(db, schemas, actor);
        await scope.require(dashboard.databaseId, 'read');
        const tile = dashboard.config.tiles.find((item) => item.id === tileId);
        if (tile?.kind !== 'chart' && tile?.kind !== 'pivot') unavailable();
        const loaded = await loadTileContext(
          db,
          schemas,
          scope,
          dashboard.databaseId,
          [tile],
          input.timeZone,
          false,
          input.filters,
        );
        return guarded(
          db,
          request.log.child({ dashboardId }),
          tile,
          statementMs,
          performance.now() + TILE_DEADLINES.requestMs,
          (timed) =>
            tile.kind === 'pivot'
              ? pivotTileRecords(timed, tile, recordsOf(tile, loaded), input, loaded.views.values(), schemas)
              : tileRecords(timed, tile, recordsOf(tile, loaded), input, loaded.views.values(), schemas),
          true,
        );
      });
    },
  );
}
