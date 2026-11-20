import { ingestStudyRoutes } from '../ingest/study/routes.js';
import { ingestLiveRoutes } from '../ingest/live/routes.js';
import { ingestDraftRoutes } from '../ingest/drafts/routes.js';
import { ingestSetupRoutes } from '../ingest/setup/routes.js';
import { ingestBuildRoutes } from '../ingest/build/routes.js';
import { installTableCopies, tableCopyJob, cancelTableCopy, CopyJobParams } from './duplicate-jobs.js';
import { runHomeCommand } from './commands/home.js';
import type { AppContext } from '../app.js';
import type { Actor } from '../http/policy.js';
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  Command,
  DatabaseCreate,
  DatabaseId,
  UndoRequest,
  newId,
  type DatabaseSummary,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { z } from 'zod';
import { requireActor } from '../auth/sessions.js';
import { parse } from '../http/validate.js';
import { AccessScope } from './access.js';
import { BatchEnvelope, runCommands } from './commands/index.js';
import { createDatabase } from './commands/database-create.js';
import { createTable } from './commands/schema.js';
import { lock, LONG_DEADLINES, recordChange, retry, userError } from './commands/transaction.js';
import { dataStore } from './context.js';
import { loadDatabase, loadSchema } from './metadata.js';
import { runUndo } from './undo.js';
import { previewUndo } from './undo-preview.js';
import { linkTargetRoutes } from './link-targets.js';

const DatabaseParams = z.object({ databaseId: DatabaseId });

/** Databases, their schema, commands, undo, and redo. */
export async function dataRoutes(app: FastifyInstance): Promise<void> {
  await linkTargetRoutes(app);
  await app.register(ingestSetupRoutes);
  await app.register(ingestDraftRoutes);
  await app.register(ingestBuildRoutes);
  await app.register(ingestLiveRoutes);
  await app.register(ingestStudyRoutes);
  const session = { config: { policy: { kind: 'session' as const } } };
  installTableCopies(app);
  app.get('/api/duplicate-jobs/:jobId', session, (request) => {
    const { jobId } = parse(CopyJobParams, request.params);
    return tableCopyJob(app, requireActor(request), jobId);
  });
  app.post('/api/duplicate-jobs/:jobId/cancel', session, (request) => {
    const { jobId } = parse(CopyJobParams, request.params);
    return cancelTableCopy(app, requireActor(request), jobId);
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get('/api/databases', session, async (request): Promise<DatabaseSummary[]> => {
    const actor = requireActor(request);
    return listDatabases(app.ctx, actor);
  });

  app.post('/api/databases', session, async (request) => {
    const actor = requireActor(request);
    if (actor.kind === 'guest') throw new AppError('forbidden', 'data.access.denied');
    const input = parse(DatabaseCreate, request.body);
    const { pool, schemas } = dataStore(app.ctx);
    return retry(() =>
      withTransaction(
        pool,
        async (db) => {
          const c = { secretKey: app.ctx.config.secretKey, db, schemas, actor, databaseId: input.id };
          await lock(c, [`database:${input.id}`]);
          const existing = await loadDatabase(db, schemas, input.id);
          if (existing) {
            if (existing.orgId !== actor.orgId || existing.createdBy !== actor.userId)
              throw new AppError('conflict', 'errors.conflict');
            return loadSchema(db, schemas, input.id, 'owner', { scope: new AccessScope(db, schemas, actor) });
          }
          try {
            const groupId = input.groupId ?? newId('action');
            await createDatabase(c, { ...input, folderId: null }, groupId);
            const table = await createTable(c, input.table);
            await recordChange(c, table, { commandId: newId('command'), groupId, clientId: null });
            return loadSchema(db, schemas, input.id, 'owner', { scope: new AccessScope(db, schemas, actor) });
          } catch (error) {
            throw userError(error) ?? error;
          }
        },
        LONG_DEADLINES,
      ),
    );
  });

  app.put('/api/databases/:databaseId/favorite', session, async (request) => {
    const actor = requireActor(request);
    const { databaseId } = parse(DatabaseParams, request.params);
    const { favorite } = parse(z.object({ favorite: z.boolean() }).strict(), request.body);
    await runHomeCommand(app, actor, {
      id: newId('command'),
      action: { kind: 'favorite.set', databaseId, favorite },
    });
    return { favorite };
  });

  app.get('/api/databases/:databaseId/schema', session, async (request) => {
    const actor = requireActor(request);
    const { databaseId } = parse(DatabaseParams, request.params);
    const { pool, schemas } = dataStore(app.ctx);
    return retry(() =>
      withTransaction(pool, async (db) => {
        await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
        const scope = new AccessScope(db, schemas, actor);
        const role = await scope.require(databaseId, 'read');
        if (!actor.demo)
          await query(
            db,
            sql`INSERT INTO ${ident(schemas.app, 'user_database_state')} AS state (user_id, database_id, opened_at)
        VALUES (${actor.userId}, ${databaseId}, statement_timestamp())
        ON CONFLICT (user_id, database_id) DO UPDATE SET opened_at = EXCLUDED.opened_at
        WHERE state.opened_at IS NULL OR state.opened_at < statement_timestamp() - interval '1 minute'`,
          );
        return loadSchema(db, schemas, databaseId, role, { secretKey: app.ctx.config.secretKey, scope });
      }),
    );
  });

  app.post('/api/databases/:databaseId/commands/preview', session, async (request) => {
    const actor = requireActor(request);
    const { databaseId } = parse(DatabaseParams, request.params);
    const batch = parse(BatchEnvelope, request.body);
    const { pool } = dataStore(app.ctx);
    return withTransaction(pool, async (db) => {
      await query(db, sql`SAVEPOINT write_preview`);
      const issues: Array<{ recordId: string; fieldId: string; messageKey: string; message?: string }> = [];
      try {
        for (const input of batch.commands) {
          const command = parse(Command, input);
          if (command.kind !== 'record.create' && command.kind !== 'record.update')
            throw new AppError('validation_failed', 'errors.validationFailed');
          for (const record of command.records) {
            const result = await runCommands(
              app,
              actor,
              databaseId,
              {
                clientId: batch.clientId,
                commands: [{ ...command, id: newId('command'), records: [record] }],
              },
              db,
            );
            const error = result.results[0]?.error;
            if (error) {
              if (error.issues) issues.push(...error.issues);
              else
                for (const fieldId of Object.keys(record.values))
                  issues.push({
                    recordId: record.id,
                    fieldId,
                    messageKey: error.fields?.[fieldId] ?? error.messageKey,
                  });
            }
          }
        }
        return { issues };
      } finally {
        await query(db, sql`ROLLBACK TO SAVEPOINT write_preview`);
      }
    });
  });

  app.post('/api/databases/:databaseId/commands', session, async (request) => {
    const actor = requireActor(request);
    const { databaseId } = parse(DatabaseParams, request.params);
    const batch = parse(BatchEnvelope, request.body);
    if (
      batch.commands.some(
        (command) =>
          command &&
          typeof command === 'object' &&
          'kind' in command &&
          (command.kind === 'automation.calendarEvent' || command.kind === 'record.generateDocument'),
      )
    )
      throw new AppError('forbidden', 'data.access.denied');
    return runCommands(app, actor, databaseId, batch);
  });

  app.get('/api/databases/:databaseId/undo-preview/:groupId', session, async (request) => {
    const { databaseId } = parse(DatabaseParams, request.params);
    const { groupId } = parse(z.object({ groupId: UndoRequest.shape.groupId }), request.params);
    return previewUndo(app, requireActor(request), databaseId, groupId);
  });

  for (const direction of ['undo', 'redo'] as const) {
    app.post(`/api/databases/:databaseId/${direction}`, session, async (request) => {
      const actor = requireActor(request);
      const { databaseId } = parse(DatabaseParams, request.params);
      const result = await runUndo(app, actor, databaseId, parse(UndoRequest, request.body), direction);
      // Undoing a record's creation puts it in the trash, which gives up a pending booking's place.
      await app.ctx.payments?.release(databaseId);
      return result;
    });
  }
}

export async function listDatabases(ctx: AppContext, actor: Actor): Promise<DatabaseSummary[]> {
  const { pool, schemas } = dataStore(ctx);
  return withTransaction(pool, async (db) => {
    await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    const candidates = await query<{ id: string; favorite: boolean | null; opened_at: Date | null }>(
      db,
      sql`SELECT d.id, s.favorite, s.opened_at FROM ${ident(schemas.app, 'databases')} d
      LEFT JOIN ${ident(schemas.app, 'user_database_state')} s ON s.database_id = d.id AND s.user_id = ${actor.userId}
      WHERE d.org_id = ${actor.orgId} AND d.trashed_at IS NULL
      ORDER BY d.updated_at DESC, d.id`,
    );
    const scope = new AccessScope(db, schemas, actor);
    const summaries: DatabaseSummary[] = [];
    for (const { id, favorite, opened_at } of candidates.rows) {
      const role = await scope.databaseRole(id);
      if (!role) continue;
      const database = (await loadDatabase(db, schemas, id))!;
      summaries.push({
        id,
        favorite: favorite ?? false,
        openedAt: opened_at?.toISOString() ?? null,
        name: database.name,
        icon: database.icon,
        color: database.color,
        updatedAt: database.updatedAt,
        role,
      });
    }
    return summaries;
  });
}
