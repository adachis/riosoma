import { readsLive } from '../../sources/live.js';
import { AppError, DuplicatesRequest, TableId, type Duplicates } from '@riosoma/contracts';
import { query, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../../auth/sessions.js';
import { parse } from '../../http/validate.js';
import { AccessScope } from '../access.js';
import { dataStore } from '../context.js';
import { loadFields, loadTable } from '../metadata.js';
import { findDuplicates } from './find.js';

/** Finding duplicate records, for anyone who can read the table.  Merging is a command. */
export async function duplicateRoutes(app: FastifyInstance): Promise<void> {
  const session = { config: { policy: { kind: 'session' as const } } };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.post('/api/tables/:tableId/duplicates', session, async (request): Promise<Duplicates> => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    const input = parse(DuplicatesRequest, request.body);
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    return withTransaction(pool, async (db) => {
      // One snapshot for the whole comparison, and nothing here can write.
      await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const scope = new AccessScope(db, schemas, actor);
      const table = await loadTable(db, schemas, tableId);
      if (!table || table.trashed) throw new AppError('not_found', 'errors.notFound');
      await scope.require(table.databaseId, 'read');
      if (readsLive(table)) throw new AppError('validation_failed', 'sources.live.viewUnsupported');
      const fields = scope.visibleFields(tableId, await loadFields(db, schemas, [tableId]));
      return findDuplicates(db, schemas, scope, table, fields, input);
    });
  });
}
