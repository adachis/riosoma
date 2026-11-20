import { retentionFor } from './governance.js';
import { retentionCutoff } from './retention.js';
import {
  AppError,
  DatabaseId,
  RecordId,
  TableId,
  type DatabaseTrash,
  type TrashedDatabases,
  type TrashedRecordsPage,
  type TrashWindow,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../auth/sessions.js';
import { parse } from '../http/validate.js';
import { AccessScope } from './access.js';
import { dataStore } from './context.js';
import { loadDatabase, loadField, loadFields, loadTable, loadTables } from './metadata.js';
import { displayExpr } from './physical/relations.js';

const Cursor = z.object({ at: z.string().datetime({ offset: true }), id: RecordId });

export type ListedTrashItem = DatabaseTrash['items'][number];
export type ListedTrash = DatabaseTrash;

/**
 * The window as a countdown reads it.  A legal hold stops purging, so it reports no number of days
 * rather than one the purge worker will not honor.
 */
export function trashWindow(retention: {
  effective: { trashDays: number | null };
  legalHold: boolean;
}): TrashWindow {
  return {
    days: retention.legalHold ? null : retention.effective.trashDays,
    legalHold: retention.legalHold,
  };
}

export async function trashRoutes(app: FastifyInstance): Promise<void> {
  const session = { config: { policy: { kind: 'session' as const } } };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get('/api/databases/:databaseId/trash', session, async (request): Promise<ListedTrash> => {
    const { databaseId } = parse(z.object({ databaseId: DatabaseId }), request.params);
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    return withTransaction(pool, async (db) => {
      await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const scope = new AccessScope(db, schemas, actor);
      await scope.require(databaseId, 'read');
      const retention = await retentionFor(db, schemas, actor.orgId, databaseId);
      const cutoff = retention.legalHold ? null : retentionCutoff(retention.effective.trashDays);
      const items: ListedTrashItem[] = [];
      const records: DatabaseTrash['records'] = [];
      for (const kind of [
        'table',
        'field',
        'view',
        'dashboard',
        'automation',
        'interface',
        'script',
      ] as const) {
        // Tables, dashboards, automations, interfaces, and scripts belong to the database, and fields and views to a table in it.
        const direct = kind !== 'field' && kind !== 'view';
        const result = await query<{
          id: string;
          name: string;
          table_id: string | null;
          table_name: string | null;
          trashed_at: Date;
          trashed_by: string | null;
        }>(
          db,
          sql`SELECT item.id, item.name, ${direct ? sql`NULL::text` : sql`t.id`} AS table_id,
            ${direct ? sql`NULL::text` : sql`t.name`} AS table_name, item.trashed_at, item.trashed_by
            FROM ${ident(schemas.app, `${kind}s`)} item
            ${direct ? sql`` : sql`JOIN ${ident(schemas.app, 'tables')} t ON t.id = item.table_id AND t.trashed_at IS NULL`}
            WHERE ${direct ? sql`item.database_id` : sql`t.database_id`} = ${databaseId}
            AND ${kind === 'table' ? sql`item.purged_at IS NULL` : sql`TRUE`}
            AND item.trashed_at IS NOT NULL AND (${cutoff}::timestamptz IS NULL OR item.trashed_at >= ${cutoff})`,
        );
        for (const item of result.rows) {
          if (kind === 'field') {
            // A trashed field someone can't see, directly or through what it's computed from, isn't
            // listed for them, not even by name.
            const stored = scope.limited(databaseId) ? await loadField(db, schemas, item.id) : null;
            if (!scope.visibleFields(item.table_id!, [stored ?? item]).length) continue;
          }
          items.push({
            kind,
            id: item.id,
            name: item.name,
            tableId: item.table_id,
            tableName: item.table_name,
            trashedAt: item.trashed_at.toISOString(),
            trashedBy: item.trashed_by,
          });
        }
      }
      items.sort((a, b) => b.trashedAt.localeCompare(a.trashedAt) || b.id.localeCompare(a.id));
      for (const table of await loadTables(db, schemas, databaseId)) {
        const result = await query<{ count: string }>(
          db,
          sql`SELECT count(*) AS count FROM ${ident(schemas.data, table.id)}
          WHERE __deleted_at IS NOT NULL AND (${cutoff}::timestamptz IS NULL OR __deleted_at >= ${cutoff}) AND (${scope.recordPredicate(table.id)})`,
        );
        const count = Number(result.rows[0]!.count);
        if (count) records.push({ tableId: table.id, tableName: table.name, count });
      }
      return { items, records, retention: trashWindow(retention) };
    });
  });

  /** The window a database's countdowns and delete confirmations name. */
  app.get('/api/databases/:databaseId/trash-window', session, async (request): Promise<TrashWindow> => {
    const { databaseId } = parse(z.object({ databaseId: DatabaseId }), request.params);
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    const scope = new AccessScope(pool, schemas, actor);
    await scope.require(databaseId, 'read', { includeTrashed: true });
    return trashWindow(await retentionFor(pool, schemas, actor.orgId, databaseId));
  });

  app.get('/api/tables/:tableId/trash/records', session, async (request): Promise<TrashedRecordsPage> => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    const input = parse(z.object({ cursor: z.string().max(1000).optional() }), request.query);
    let cursor: z.infer<typeof Cursor> | undefined;
    if (input.cursor) {
      try {
        cursor = Cursor.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
      } catch {
        throw new AppError('validation_failed', 'errors.validationFailed');
      }
    }
    const { pool, schemas } = dataStore(app.ctx);
    return withTransaction(pool, async (db) => {
      await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const scope = new AccessScope(db, schemas, requireActor(request));
      const table = await loadTable(db, schemas, tableId);
      if (!table || table.trashed) throw new AppError('not_found', 'errors.notFound');
      await scope.require(table.databaseId, 'read');
      const retention = await retentionFor(db, schemas, scope.actor.orgId, table.databaseId);
      const cutoff = retention.legalHold ? null : retentionCutoff(retention.effective.trashDays);
      const primary = scope
        .visibleFields(tableId, await loadFields(db, schemas, [tableId]))
        .find((f) => f.id === table.primaryFieldId);
      const result = await query<{
        id: string;
        name: string;
        at: string;
        trashed_at: Date;
        trashed_by: string | null;
      }>(
        db,
        sql`SELECT __id AS id, ${primary ? displayExpr(primary) : sql`__id`} AS name,
          to_char(__deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, __deleted_at AS trashed_at, __trashed_by AS trashed_by
          FROM ${ident(schemas.data, tableId)} WHERE __deleted_at IS NOT NULL AND (${cutoff}::timestamptz IS NULL OR __deleted_at >= ${cutoff})
          AND (${scope.recordPredicate(tableId)})
          AND ${cursor ? sql`(__deleted_at, __id) < (${cursor.at}::timestamptz, ${cursor.id})` : sql`TRUE`}
          ORDER BY __deleted_at DESC, __id DESC LIMIT 101`,
      );
      const page = result.rows.slice(0, 100);
      const last = page.at(-1);
      return {
        records: page.map((row) => ({
          id: row.id,
          name: row.name,
          trashedAt: row.trashed_at.toISOString(),
          trashedBy: row.trashed_by,
        })),
        // Preserve Postgres microseconds in the cursor; JavaScript dates would lose tied rows.
        next:
          result.rows.length > 100 && last
            ? Buffer.from(JSON.stringify({ at: last.at.replace(' ', 'T'), id: last.id })).toString(
                'base64url',
              )
            : null,
      };
    });
  });

  app.get('/api/trash', session, async (request): Promise<TrashedDatabases> => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    const candidates = await query<{
      id: string;
      trashed_at: Date;
      favorite: boolean | null;
      opened_at: Date | null;
    }>(
      pool,
      sql`SELECT d.id, d.trashed_at, s.favorite, s.opened_at FROM ${ident(schemas.app, 'databases')} d
        LEFT JOIN ${ident(schemas.app, 'user_database_state')} s ON s.database_id = d.id AND s.user_id = ${actor.userId}
        WHERE d.org_id = ${actor.orgId} AND d.trashed_at IS NOT NULL AND d.purged_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${ident(schemas.app, 'folder_databases')} fd
          JOIN ${ident(schemas.app, 'folders')} f ON f.org_id = fd.org_id AND f.id = fd.folder_id
          JOIN ${ident(schemas.app, 'folders')} ancestor ON ancestor.org_id = f.org_id
            AND (ancestor.id = f.id OR ancestor.id = ANY(f.path))
          WHERE fd.database_id = d.id AND ancestor.trashed_at IS NOT NULL)
        ORDER BY d.trashed_at DESC, d.id DESC`,
    );
    const scope = new AccessScope(pool, schemas, actor);
    const databases: TrashedDatabases['databases'] = [];
    for (const row of candidates.rows) {
      if ((await scope.databaseRole(row.id, { includeTrashed: true })) !== 'owner') continue;
      const retention = await retentionFor(pool, schemas, actor.orgId, row.id);
      const cutoff = retentionCutoff(retention.effective.trashDays);
      if (!retention.legalHold && cutoff && row.trashed_at < cutoff) continue;
      const database = await loadDatabase(pool, schemas, row.id);
      if (database)
        databases.push({
          id: row.id,
          name: database.name,
          icon: database.icon,
          color: database.color,
          updatedAt: database.updatedAt,
          role: 'owner',
          favorite: row.favorite ?? false,
          openedAt: row.opened_at?.toISOString() ?? null,
          trashedAt: row.trashed_at.toISOString(),
          retention: trashWindow(retention),
        });
    }
    return { databases };
  });
}
