import { HomeBatchCommand, HomeCommand, FolderId, newId } from '@riosoma/contracts';
import { query, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../auth/sessions.js';
import { parse } from '../http/validate.js';
import { AccessScope } from '../data/access.js';
import { dataStore } from '../data/context.js';
import { listHome, resourceGrants } from '../data/folders.js';
import { previewHomeDrop, previewHomeMove, runHomeCommand } from '../data/commands/home.js';

export async function homeRoutes(app: FastifyInstance): Promise<void> {
  const session = { config: { policy: { kind: 'session' as const } } };
  app.get('/api/home', session, (request) => listHome(app.ctx, requireActor(request)));
  app.post('/api/home/commands', session, (request) =>
    runHomeCommand(app, requireActor(request), request.body, { batch: true }),
  );
  app.post('/api/home/drop-preview', session, async (request) => {
    const command = parse(HomeBatchCommand, request.body);
    const { pool } = dataStore(app.ctx);
    await withTransaction(pool, (db) => previewHomeDrop(app, requireActor(request), command, db));
    return { available: true };
  });
  app.post('/api/home/move-preview', session, (request) =>
    previewHomeMove(app, requireActor(request), request.body),
  );
  app.post('/api/home/undo/:commandId', session, (request) => {
    const { commandId } = parse(z.object({ commandId: z.string().min(1).max(100) }), request.params);
    const input = parse(
      HomeCommand.pick({ id: true }).extend({ confirmedLosses: z.array(z.string()).default([]) }),
      request.body,
    );
    return runHomeCommand(
      app,
      requireActor(request),
      { id: input.id, action: { kind: 'folder.trash', folderId: newId('folder') } },
      { undoOf: commandId, confirmedLosses: input.confirmedLosses },
    );
  });
  app.get('/api/folders/:folderId/grants', session, async (request) => {
    const actor = requireActor(request);
    const { folderId } = parse(z.object({ folderId: FolderId }), request.params);
    const { pool, schemas } = dataStore(app.ctx);
    return withTransaction(pool, async (db) => {
      await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      await new AccessScope(db, schemas, actor).requireFolder(folderId, 'read');
      return resourceGrants(db, schemas, actor, 'folder', folderId);
    });
  });
}
