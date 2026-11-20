import { resolveSelectOptions } from '../select-options.js';
import { readsLive } from '../../sources/live.js';
import {
  AppError,
  DatabaseId,
  ViewAggregateRequest,
  ViewId,
  isTimeZone,
  type ViewAggregate,
  type ViewMeta,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../../auth/sessions.js';
import { parse } from '../../http/validate.js';
import { AccessScope } from '../access.js';
import { dataStore, type DataSchemas } from '../context.js';
import { BUSY, failure, naturalCollation } from '../dashboards/routes.js';
import type { TileRecords } from '../dashboards/tiles.js';
import { loadFields, loadTable, loadView } from '../metadata.js';
import { compileFilter } from '../physical/filters.js';
import type { ReadContext, StoredField, StoredTable } from '../types.js';
import { badViewSetting } from '../view-settings.js';
import { narrowView } from '../view-where.js';
import { aggregateRecords, chartAggregate, fitsView, isAnswer, pivotAggregate, viewPlan } from './compute.js';
import { gridSummary } from './grid-summary.js';

/**
 * `POST /api/databases/:databaseId/views/:viewId/aggregate`: a chart or pivot view's numbers, the
 * records behind one of them, or a grid view's summary row, read through the person's access in one
 * consistent snapshot.
 * Every statement has a deadline, so a slow aggregate gives its connection back and the view says
 * the server is busy instead of waiting on it.
 */

/** How long each query may run, and how long one request may spend on them all. */
export const AGGREGATE_DEADLINES = { statementMs: 5_000, requestMs: 20_000 };

class OutOfTime extends Error {}

function notFound(): never {
  throw new AppError('not_found', 'errors.notFound');
}

/** The view's records as SQL: live ones the person may see, through the view's filter. */
export function viewRecords(
  table: StoredTable,
  view: ViewMeta,
  fields: readonly StoredField[],
  scope: AccessScope,
  schemas: DataSchemas,
  read: ReadContext,
): TileRecords {
  const visible = new Map(scope.visibleFields(table.id, fields).map((field) => [field.id, field]));
  const predicate = scope.recordPredicate(table.id);
  return {
    table,
    from: sql`${ident(schemas.data, table.id)}`,
    where: sql`${ident(table.id, '__deleted_at')} IS NULL AND NOT ${ident(table.id, '__source_gone')}
      AND (${predicate}) AND ${compileFilter(view.config.filter, visible, read, schemas.app)}`,
    scope: predicate,
    fields: visible,
    view,
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

export async function viewAggregateRoutes(app: FastifyInstance): Promise<void> {
  const session = { config: { policy: { kind: 'session' as const } } };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.post(
    '/api/databases/:databaseId/views/:viewId/aggregate',
    session,
    async (request): Promise<ViewAggregate> => {
      const { databaseId, viewId } = parse(
        z.object({ databaseId: DatabaseId, viewId: ViewId }),
        request.params,
      );
      const input = parse(ViewAggregateRequest, request.body);
      if (!isTimeZone(input.timeZone)) throw new AppError('validation_failed', 'errors.validationFailed');
      const actor = requireActor(request);
      const { pool, schemas } = dataStore(app.ctx);
      // The driver's own deadline drops the connection, so the database has to give up first.
      const statementMs = Math.max(
        1,
        Math.min(AGGREGATE_DEADLINES.statementMs, app.ctx.config.dbQueryTimeoutMs - 1_000),
      );
      return withTransaction(pool, async (db) => {
        // One snapshot for every query, so a pivot's totals agree with its cells.
        await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
        const loaded = await loadView(db, schemas, viewId);
        if (!loaded || loaded.trashed || loaded.databaseId !== databaseId) notFound();
        const scope = new AccessScope(db, schemas, actor);
        await scope.require(databaseId, 'read');
        // A link's `where` narrows this read alone, so a grid's summary row matches its rows.
        const view = narrowView(loaded.view, input.where);
        const { chart, pivot } = view.config;
        const summarized = view.type === 'chart' || view.type === 'pivot' ? view.type : null;
        if (input.summary) {
          // The summary row is the grid's, and it names no records of its own.
          if (view.type !== 'grid') badViewSetting('type');
          if (input.records) throw new AppError('validation_failed', 'errors.validationFailed');
        } else {
          if (!summarized) badViewSetting('type');
          if (summarized === 'chart' && !chart.groupBy) badViewSetting('chart.groupBy');
          if (summarized === 'pivot' && !pivot.rows.length) badViewSetting('pivot.rows');
          const shape =
            summarized === 'chart'
              ? { rows: 1, column: chart.seriesBy !== null }
              : { rows: pivot.rows.length, column: pivot.column !== null };
          if (input.records && !fitsView(shape, input.records))
            throw new AppError('validation_failed', 'errors.validationFailed');
        }
        const table = await loadTable(db, schemas, view.tableId);
        if (!table || table.trashed) notFound();
        if (readsLive(table)) throw new AppError('validation_failed', 'sources.live.viewUnsupported');
        const read: ReadContext = {
          timeZone: input.timeZone,
          now: new Date(),
          natural: await naturalCollation(db, schemas),
        };
        const records = viewRecords(
          table,
          view,
          await resolveSelectOptions(
            db,
            schemas,
            scope,
            scope.visibleFields(table.id, await loadFields(db, schemas, [table.id])),
          ),
          scope,
          schemas,
          read,
        );
        const started = performance.now();
        const deadline = () => {
          if (performance.now() - started >= AGGREGATE_DEADLINES.requestMs) throw new OutOfTime();
        };
        await query(db, sql`SAVEPOINT aggregate`);
        try {
          // The savepoint also bounds the local timeout, so recovery restores the normal deadline.
          await query(db, sql`SELECT set_config('statement_timeout', ${String(statementMs)}, true)`);
          let answer: ViewAggregate;
          if (input.summary || !summarized) answer = await gridSummary(db, records, view.config, deadline);
          else if (input.records) {
            const plan = viewPlan(records, summarized, view.config);
            answer = isAnswer(plan)
              ? plan
              : await aggregateRecords(db, records, plan, input.records, schemas);
          } else
            answer =
              summarized === 'chart'
                ? await chartAggregate(db, records, chart, deadline)
                : await pivotAggregate(db, records, pivot, deadline);
          // Aggregate work only reads.  Restore the timeout before releasing or committing.
          await query(db, sql`ROLLBACK TO SAVEPOINT aggregate`);
          await query(db, sql`RELEASE SAVEPOINT aggregate`);
          return answer;
        } catch (error) {
          const messageKey = error instanceof OutOfTime ? BUSY : failure(error);
          if (!messageKey) throw error;
          await query(db, sql`ROLLBACK TO SAVEPOINT aggregate`);
          await query(db, sql`RELEASE SAVEPOINT aggregate`);
          if (messageKey === BUSY) request.log.warn({ viewId }, 'view aggregate ran out of time');
          return { kind: 'error', messageKey };
        }
      });
    },
  );
}
