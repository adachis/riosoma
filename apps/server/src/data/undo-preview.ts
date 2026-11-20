import { AppError, type ChangeBody, type UndoPreview } from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import type { Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import type { Actor } from '../http/policy.js';
import { AccessScope } from './access.js';
import { dataStore, type DataSchemas } from './context.js';
import { loadDatabase, loadTable, loadTables } from './metadata.js';

interface Creation {
  body: Extract<ChangeBody, { kind: 'database.created' | 'table.created' }>;
  seq: string;
  at: Date;
}

/** Original history identifies creations even after undo and redo replace their inverses. */
export async function majorCreations(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
  groupId: string,
): Promise<Creation[]> {
  const result = await query<Creation>(
    db,
    sql`
    SELECT body, seq, at FROM ${ident(schemas.app, 'changes')}
    WHERE database_id = ${databaseId} AND group_id = ${groupId}
      AND undo_of IS NULL AND redo_of IS NULL
      AND kind IN ('database.created', 'table.created')
      AND body->'table'->'lineItems'->>'parentFieldId' IS NULL
      AND NOT COALESCE((prev->>'dependent')::boolean, false)
    ORDER BY seq`,
  );
  const database = result.rows.find(({ body }) => body.kind === 'database.created');
  return database ? [database] : result.rows;
}

export async function previewUndo(
  app: FastifyInstance,
  actor: Actor,
  databaseId: string,
  groupId: string,
): Promise<UndoPreview> {
  const { pool, schemas } = dataStore(app.ctx);
  return withTransaction(pool, async (db) => {
    await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    const scope = new AccessScope(db, schemas, actor);
    await scope.require(databaseId, 'read', { includeTrashed: true });
    const group = (
      await query<{ actor_id: string; state: string }>(
        db,
        sql`
      SELECT actor_id, state FROM ${ident(schemas.app, 'undo_groups')}
      WHERE database_id = ${databaseId} AND group_id = ${groupId}`,
      )
    ).rows[0];
    if (!group) throw new AppError('not_found', 'errors.notFound');
    if (group.actor_id !== actor.userId) throw new AppError('forbidden', 'data.access.denied');
    if (group.state !== 'done') return { creations: [] };
    const creations: UndoPreview['creations'] = [];
    for (const creation of await majorCreations(db, schemas, databaseId, groupId)) {
      const kind = creation.body.kind === 'database.created' ? 'database' : 'table';
      const id = creation.body.kind === 'database.created' ? databaseId : creation.body.table.id;
      const target =
        kind === 'database' ? await loadDatabase(db, schemas, id) : await loadTable(db, schemas, id);
      if (!target || target.trashed) continue;
      await scope.require(databaseId, kind === 'database' ? 'manage' : 'editSchema');
      const tables =
        kind === 'database' ? await loadTables(db, schemas, databaseId) : [await loadTable(db, schemas, id)];
      let records = 0;
      for (const table of tables) {
        if (!table) continue;
        records += Number(
          (
            await query<{ count: string }>(
              db,
              sql`
          SELECT count(*) FROM ${ident(schemas.data, table.id)}
          WHERE __deleted_at IS NULL AND NOT __source_gone`,
            )
          ).rows[0]!.count,
        );
      }
      const others = await query<{ actor_id: string; name: string; body: ChangeBody }>(
        db,
        sql`
        SELECT c.actor_id, u.name, c.body FROM ${ident(schemas.app, 'changes')} c
        JOIN ${ident(schemas.app, 'users')} u ON u.id = c.actor_id
        WHERE c.database_id = ${databaseId} AND c.seq > ${creation.seq}
          AND c.actor_id <> ${actor.userId}
          AND (${kind === 'database'} OR c.table_id = ${id} OR c.kind = 'access.changed')
        ORDER BY c.seq`,
      );
      const changed = new Map<string, UndoPreview['creations'][number]['changedSince'][number]>();
      for (const row of others.rows) {
        const person = changed.get(row.actor_id) ?? {
          actorId: row.actor_id,
          name: row.name,
          records: 0,
          tables: 0,
          shares: 0,
        };
        if (row.body.kind === 'record.created' || row.body.kind === 'table.created')
          person.records += row.body.records.length;
        if (row.body.kind === 'table.created') person.tables++;
        changed.set(row.actor_id, person);
      }
      const shares = await query<{ actor_id: string; name: string; count: string }>(
        db,
        sql`
        SELECT s.created_by AS actor_id, u.name, count(*) FROM (
          SELECT g.created_by FROM ${ident(schemas.app, 'grants')} g
          WHERE g.org_id = ${actor.orgId} AND g.resource_kind = 'database' AND g.resource_id = ${databaseId}
            AND g.created_at > ${creation.at} AND g.created_by <> ${actor.userId}
          UNION ALL
          SELECT s.created_by FROM ${ident(schemas.app, 'shared_views')} s
          JOIN ${ident(schemas.app, 'views')} v ON v.id = s.view_id
          WHERE s.org_id = ${actor.orgId} AND s.database_id = ${databaseId} AND s.stopped_at IS NULL
            AND s.created_at > ${creation.at} AND s.created_by <> ${actor.userId}
            AND (${kind === 'database'} OR v.table_id = ${id})
        ) s JOIN ${ident(schemas.app, 'users')} u ON u.id = s.created_by
        GROUP BY s.created_by, u.name`,
      );
      for (const row of shares.rows) {
        const person = changed.get(row.actor_id) ?? {
          actorId: row.actor_id,
          name: row.name,
          records: 0,
          tables: 0,
          shares: 0,
        };
        person.shares = Number(row.count);
        changed.set(row.actor_id, person);
      }
      creations.push({
        kind,
        id,
        name: target.name,
        tables: kind === 'database' ? tables.length : 0,
        records,
        changedSince: [...changed.values()],
      });
    }
    return { creations };
  });
}
