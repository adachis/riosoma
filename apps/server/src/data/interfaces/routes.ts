import { sparklineFields } from '../sparklines.js';
import { resolveSelectOptions } from '../select-options.js';
import {
  AppError,
  filterBlockCondition,
  filtersFor,
  InterfaceDataRequest,
  InterfaceId,
  InterfaceRecordsRequest,
  isSummaryBlock,
  isTimeZone,
  type FieldMeta,
  type FilterCondition,
  type FilterGroup,
  type InterfaceData,
  type InterfacePage,
  type InterfaceRecordsPage,
  type RecordsBlock,
  type RowsQuery,
  type TileData,
} from '@riosoma/contracts';
import { compile, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../../auth/sessions.js';
import type { Actor } from '../../http/policy.js';
import { parse } from '../../http/validate.js';
import { AccessScope } from '../access.js';
import { dataStore, type DataSchemas } from '../context.js';
import { computeDataTiles, TILE_DEADLINES } from '../dashboards/routes.js';
import { BAD_AGGREGATE, UNAVAILABLE } from '../dashboards/tiles.js';
import { loadFields, loadTable, loadView } from '../metadata.js';
import { compileFilter } from '../physical/filters.js';
import { SnapshotCache, type SnapshotRead } from '../snapshots.js';
import { codeFrameRoutes } from './code-frame.js';
import { blockFieldIds } from './config.js';
import { loadInterface, type StoredInterface } from './store.js';

/**
 * What an interface's blocks read, all through the person's access exactly as views and dashboard
 * tiles read: `POST /api/interfaces/:interfaceId/data` computes a page's number and chart blocks
 * the way dashboard tiles are computed, and `POST /api/interfaces/:interfaceId/records` pages
 * through a records block's view in its order, narrowed by the block's own filter and by what the
 * person chose in the page's filter blocks.  Text, filter, and button blocks read nothing, and a
 * record block reads its record the way the record card does.
 */

/** A block whose table, view, or fields are gone or hidden from this person */
export const BLOCK_UNAVAILABLE = 'interfaces.block.unavailable';
/** A number or chart block's calculation that doesn't fit its field */
export const BLOCK_BAD_AGGREGATE = 'interfaces.block.badAggregate';

const BLOCK_MESSAGES: Readonly<Record<string, string>> = {
  [UNAVAILABLE]: BLOCK_UNAVAILABLE,
  [BAD_AGGREGATE]: BLOCK_BAD_AGGREGATE,
};

function notFound(): never {
  throw new AppError('not_found', 'errors.notFound');
}

function blockUnavailable(): never {
  throw new AppError('not_found', 'interfaces.block.unavailable');
}

/** A live interface this person can read, and the page asked for. */
async function openPage(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  interfaceId: string,
  pageId: string,
): Promise<{ scope: AccessScope; stored: StoredInterface; page: InterfacePage }> {
  const stored = await loadInterface(db, schemas, interfaceId);
  if (!stored || stored.trashed || stored.orgId !== actor.orgId) notFound();
  const scope = new AccessScope(db, schemas, actor);
  await scope.require(stored.databaseId, 'read');
  const page = stored.pages.find((item) => item.id === pageId) ?? notFound();
  return { scope, stored, page };
}

/**
 * The conditions a records block reads beyond its view: its own filter, then what the person chose
 * in each filter block that narrows it.  A filter block over a field this person can't see
 * narrows nothing, and so does a value that doesn't suit its field.
 */
export function blockFilter(
  page: InterfacePage,
  block: RecordsBlock,
  fields: ReadonlyMap<string, FieldMeta>,
  chosen: Readonly<Record<string, string | boolean>> = {},
): FilterGroup {
  const conditions: Array<FilterCondition | FilterGroup> = block.source.filter ? [block.source.filter] : [];
  for (const filter of filtersFor(page, block)) {
    const field = fields.get(filter.fieldId);
    const condition = field ? filterBlockCondition(filter.control, field, chosen[filter.id]) : null;
    if (condition) conditions.push({ ...condition, id: filter.id.slice(0, 32) });
  }
  return { conjunction: 'and', conditions };
}

export async function interfaceRoutes(app: FastifyInstance): Promise<void> {
  await app.register(codeFrameRoutes);
  const ctx = app.ctx;
  const session = { config: { policy: { kind: 'session' as const } } };
  // Records blocks keep their own orders, apart from the grid's, like shared views do.
  const snapshots = new SnapshotCache(() => dataStore(ctx), (ctx.config.snapshotCacheMb ?? 256) / 4, app.log);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.post('/api/interfaces/:interfaceId/data', session, async (request): Promise<InterfaceData> => {
    const { interfaceId } = parse(z.object({ interfaceId: InterfaceId }), request.params);
    const input = parse(InterfaceDataRequest, request.body);
    if (!isTimeZone(input.timeZone)) throw new AppError('validation_failed', 'errors.validationFailed');
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    // The driver's own deadline drops the connection, so the database has to give up first.
    const statementMs = Math.max(
      1,
      Math.min(TILE_DEADLINES.statementMs, ctx.config.dbQueryTimeoutMs - 1_000),
    );
    return withTransaction(pool, async (db) => {
      // One snapshot for every block, so the numbers on a page agree with each other.
      await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const { scope, stored, page } = await openPage(db, schemas, actor, interfaceId, input.pageId);
      const wanted = input.blockIds ? new Set(input.blockIds) : null;
      const blocks = page.blocks.filter(isSummaryBlock).filter((block) => !wanted || wanted.has(block.id));
      const log = request.log.child({ interfaceId: stored.id, pageId: page.id });
      const tiles = await computeDataTiles(
        db,
        schemas,
        scope,
        stored.databaseId,
        blocks,
        input.timeZone,
        log,
        statementMs,
      );
      const answers: Record<string, TileData> = {};
      for (const [id, data] of Object.entries(tiles))
        answers[id] =
          data.kind === 'error'
            ? { kind: 'error', messageKey: BLOCK_MESSAGES[data.messageKey] ?? data.messageKey }
            : data;
      return { blocks: answers };
    });
  });

  app.post(
    '/api/interfaces/:interfaceId/records',
    session,
    async (request): Promise<InterfaceRecordsPage> => {
      const { interfaceId } = parse(z.object({ interfaceId: InterfaceId }), request.params);
      const input = parse(InterfaceRecordsRequest, request.body);
      if (!isTimeZone(input.timeZone)) throw new AppError('validation_failed', 'errors.validationFailed');
      const actor = requireActor(request);
      const { pool, schemas } = dataStore(ctx);
      const { scope, stored, page } = await openPage(pool, schemas, actor, interfaceId, input.pageId);
      const block = page.blocks.find((item) => item.id === input.blockId);
      if (block?.kind !== 'records') notFound();
      const [table, loadedView] = await Promise.all([
        loadTable(pool, schemas, block.source.tableId),
        loadView(pool, schemas, block.source.viewId),
      ]);
      if (!table || table.trashed || table.databaseId !== stored.databaseId) blockUnavailable();
      if (!loadedView || loadedView.trashed || loadedView.view.tableId !== table.id) blockUnavailable();
      const fields = await resolveSelectOptions(
        pool,
        schemas,
        scope,
        scope.visibleFields(table.id, await loadFields(pool, schemas, [table.id])),
      );
      const byId = new Map(fields.map((field) => [field.id, field]));
      if (blockFieldIds(block).some((id) => !byId.has(id))) blockUnavailable();
      const context = await snapshots.readContext(input.timeZone);
      const predicate = compileFilter(
        blockFilter(page, block, byId, input.filters),
        byId,
        context,
        schemas.app,
      );
      const read: SnapshotRead = {
        table,
        view: loadedView.view,
        fields: await sparklineFields(pool, schemas, scope, fields, loadedView.view.config.sparklines),
        predicate: scope.recordPredicate(table.id),
        access: scope.accessKey(table.id),
        context,
        selection: { key: JSON.stringify(['interface', compile(predicate)]), predicate },
        values: {
          schemas,
          read: context,
          tableId: table.id,
          visible: (field) => scope.visibleFields(field.tableId, [field]).length > 0,
          recordPredicate: (tableId, alias) =>
            alias ? scope.linkedPredicate(tableId, alias) : scope.recordPredicate(tableId),
        },
      };
      const rows: RowsQuery = {
        offset: input.offset,
        limit: input.limit,
        tz: input.timeZone,
        ...(input.snapshot ? { snapshot: input.snapshot } : {}),
        ...(input.refresh ? { refresh: '1' as const } : {}),
      };
      return { ...(await snapshots.page(read, rows)), tableId: table.id };
    },
  );
}
