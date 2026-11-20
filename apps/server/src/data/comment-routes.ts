import { liveDeps, readsLive, visibleLive } from '../sources/live.js';
import { prepareJoinedRead } from '../sources/joined-live.js';
import { AppError, RecordId, TableId, type CommentsPage, type HistoryPage } from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../auth/sessions.js';
import { parse } from '../http/validate.js';
import { AccessScope } from './access.js';
import { commentFields, recordComment, requireRecord, type CommentRow } from './comments.js';
import { dataStore } from './context.js';
import { recordHistoryPage } from './history.js';
import { loadTable } from './metadata.js';

import type { AppContext } from '../app.js';
import type { Actor } from '../http/policy.js';

const Params = z.object({ tableId: TableId, recordId: RecordId });
const Cursor = z.object({ tableId: TableId, recordId: RecordId, seq: z.number().int().positive().safe() });

export async function commentRoutes(app: FastifyInstance): Promise<void> {
  const session = { config: { policy: { kind: 'session' as const } } };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  app.get('/api/tables/:tableId/comments', session, (request) => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    const { recordIds } = parse(
      z.object({
        recordIds: z
          .string()
          .transform((value) => value.split(','))
          .pipe(z.array(RecordId).min(1).max(200)),
      }),
      request.query,
    );
    return readComments(app.ctx, requireActor(request), tableId, recordIds);
  });
  for (const kind of ['comments', 'history'] as const) {
    app.get(
      `/api/tables/:tableId/records/:recordId/${kind}`,
      session,
      async (request): Promise<CommentsPage | HistoryPage> => {
        const { tableId, recordId } = parse(Params, request.params);
        if (kind === 'comments') return readComments(app.ctx, requireActor(request), tableId, [recordId]);
        const input = parse(z.object({ cursor: z.string().max(1000).optional() }), request.query);
        let cursor: number | undefined;
        if (kind === 'history' && input.cursor !== undefined) {
          try {
            const decoded = Cursor.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
            if (decoded.tableId !== tableId || decoded.recordId !== recordId) throw new Error();
            cursor = decoded.seq;
          } catch {
            throw new AppError('validation_failed', 'errors.validationFailed');
          }
        }
        const { pool, schemas } = dataStore(app.ctx);
        const beforeScope = new AccessScope(pool, schemas, requireActor(request));
        const beforeTable = await loadTable(pool, schemas, tableId);
        if (!beforeTable || beforeTable.trashed) throw new AppError('not_found', 'errors.notFound');
        await beforeScope.require(beforeTable.databaseId, 'read');
        const joinedVisible = await prepareJoinedRead(app.ctx, beforeScope, beforeTable);
        return withTransaction(pool, async (db) => {
          await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
          const scope = new AccessScope(db, schemas, requireActor(request));
          for (const [inputId, visible] of joinedVisible) scope.confirmLive(inputId, visible);
          const table = await loadTable(db, schemas, tableId);
          if (!table || table.trashed) throw new AppError('not_found', 'errors.notFound');
          await scope.require(table.databaseId, 'read');
          // Someone a live table's rules limit sees a record's comments once its source agrees.
          if (readsLive(table) && scope.liveRules(tableId) !== null)
            scope.confirmLive(tableId, await visibleLive(liveDeps(app.ctx), table, scope, [recordId]));
          await requireRecord(db, schemas, scope, tableId, recordId);
          return recordHistoryPage(db, schemas, scope, table, recordId, cursor);
        });
      },
    );
  }
}

/** Shared scoped reads for the grid, REST clients, and tools. */
export async function readComments(
  ctx: AppContext,
  actor: Actor,
  tableId: string,
  recordIds: string[],
  machine = false,
): Promise<CommentsPage> {
  const { pool, schemas } = dataStore(ctx);
  const beforeScope = new AccessScope(pool, schemas, actor);
  const beforeTable = await loadTable(pool, schemas, tableId);
  if (!beforeTable || beforeTable.trashed) throw new AppError('not_found', 'errors.notFound');
  await beforeScope.require(beforeTable.databaseId, 'read');
  const joinedVisible = await prepareJoinedRead(ctx, beforeScope, beforeTable);
  return withTransaction(pool, async (db) => {
    await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    const scope = new AccessScope(db, schemas, actor);
    for (const [inputId, visible] of joinedVisible) scope.confirmLive(inputId, visible);
    const table = await loadTable(db, schemas, tableId);
    if (!table || table.trashed) throw new AppError('not_found', 'errors.notFound');
    await scope.require(table.databaseId, 'read');
    if (readsLive(table) && scope.liveRules(tableId) !== null)
      scope.confirmLive(tableId, await visibleLive(liveDeps(ctx), table, scope, recordIds));
    if (recordIds.length === 1) await requireRecord(db, schemas, scope, tableId, recordIds[0]!);
    if (machine) await scope.requireMachineUse(table.databaseId, tableId);
    const fields = await commentFields(db, schemas, scope, tableId);
    const result = await query<CommentRow>(
      db,
      sql`SELECT c.* FROM ${ident(schemas.app, 'comments')} c
      WHERE c.org_id = ${actor.orgId} AND c.database_id = ${table.databaseId} AND c.table_id = ${tableId}
        AND c.record_id = ANY(${recordIds}::text[]) AND c.deleted_at IS NULL
        AND c.record_id IN (SELECT __id FROM ${ident(schemas.data, tableId)} WHERE (${scope.recordPredicate(tableId)}))
      ORDER BY c.created_at, c.id`,
    );
    return {
      comments: result.rows.filter((row) => !row.field_id || fields.has(row.field_id)).map(recordComment),
    };
  });
}
