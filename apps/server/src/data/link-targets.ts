import {
  AppError,
  TableId,
  TableMeta,
  readsSourceLive,
  roleAllows,
  type LinkTarget,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../auth/sessions.js';
import { parse } from '../http/validate.js';
import { AccessScope } from './access.js';
import { dataStore } from './context.js';
import { loadFields, loadTable, loadViews } from './metadata.js';

export async function linkTargetRoutes(app: FastifyInstance): Promise<void> {
  const session = { config: { policy: { kind: 'session' as const } } };
  async function targets(actor: ReturnType<typeof requireActor>, tableId?: string): Promise<LinkTarget[]> {
    const { pool, schemas } = dataStore(app.ctx);
    return withTransaction(pool, async (db) => {
      await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const candidates = await query<{ id: string; database_id: string; name: string }>(
        db,
        sql`SELECT t.id, t.database_id, d.name FROM ${ident(schemas.app, 'tables')} t
          JOIN ${ident(schemas.app, 'databases')} d ON d.id = t.database_id AND d.org_id = t.org_id
          WHERE t.org_id = ${actor.orgId} AND t.trashed_at IS NULL AND d.trashed_at IS NULL
            AND ${tableId ? sql`t.id = ${tableId}` : sql`TRUE`}
          ORDER BY lower(d.name), d.id, t.position, t.id`,
      );
      const scope = new AccessScope(db, schemas, actor);
      const result: LinkTarget[] = [];
      for (const candidate of candidates.rows) {
        const role = await scope.databaseRole(candidate.database_id);
        if (!roleAllows(role, tableId ? 'read' : 'editRecords')) continue;
        await scope.prepare(candidate.database_id);
        const table = (await loadTable(db, schemas, candidate.id))!;
        if (!tableId && (readsSourceLive(table.source) || table.joined)) continue;
        const fields = scope.visibleFields(table.id, await loadFields(db, schemas, [table.id]));
        if (!fields.some((field) => field.id === table.primaryFieldId)) continue;
        result.push({
          table: TableMeta.parse(table),
          database: { id: candidate.database_id, name: candidate.name },
          canEditSchema: roleAllows(role, 'editSchema'),
          ...(tableId ? { viewId: (await loadViews(db, schemas, [table.id]))[0]?.id } : {}),
        });
      }
      return result;
    });
  }
  app.get('/api/link-targets', session, (request) => targets(requireActor(request)));
  app.get('/api/tables/:tableId/link-target', session, async (request) => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    const [target] = await targets(requireActor(request), tableId);
    if (!target) throw new AppError('not_found', 'errors.notFound');
    return target;
  });
}
