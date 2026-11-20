import { retentionFor } from './governance.js';
import { newId } from '@riosoma/contracts';
import {
  lockRetention,
  purgeRetained,
  recordPurge,
  retentionCutoff,
  RETENTION_BATCH_SIZE,
} from './retention.js';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { promptReads } from './access.js';
import { dataStore, type DataSchemas } from './context.js';
import { LONG_DEADLINES, recordChange } from './commands/transaction.js';
import { loadField, loadFields, loadTable } from './metadata.js';
import { columnType } from './physical/columns.js';
import { dropColumn, dropRecordTable } from './physical/ddl.js';
import type { FileRow } from './files/metadata.js';
import { fileStorage } from './files/storage.js';
import { purgeOriginals, type OriginalRow } from './files/originals.js';
import { homeChannel } from './notify.js';
import { eraseExpiredLibraryReviews } from './library-review-cleanup.js';
import { purgeNotifications } from '../notifications/store.js';
import { dropLogin } from '../sql/login.js';

/** Deletes a field for good, and its link's other side, adding the IDs of what went to `purged`. */
async function purgeField(
  ctx: AppContext,
  db: Queryable,
  schemas: DataSchemas,
  id: string,
  purged: Set<string>,
  counts: Record<string, number>,
  affected: Set<string>,
): Promise<void> {
  const field = await loadField(db, schemas, id);
  if (!field) return;
  purged.add(id);
  const parent = await loadTable(db, schemas, field.tableId);
  if (parent) affected.add(parent.databaseId);
  const links = await query<{ id: string; left_field_id: string; right_field_id: string | null }>(
    db,
    sql`SELECT id, left_field_id, right_field_id FROM ${ident(schemas.app, 'links')}
      WHERE left_field_id = ${id} OR right_field_id = ${id}`,
  );
  for (const link of links.rows) {
    await dropRecordTable(db, schemas.data, `lnk_${link.id}`);
    await query(db, sql`DELETE FROM ${ident(schemas.app, 'links')} WHERE id = ${link.id}`);
    const inverseId = link.left_field_id === id ? link.right_field_id : link.left_field_id;
    const inverse = inverseId ? await loadField(db, schemas, inverseId) : null;
    // A converted endpoint may now hold live data unrelated to this archived link.
    if (inverse?.type === 'link' && inverse.options.inverseFieldId === id)
      await purgeField(ctx, db, schemas, inverse.id, purged, counts, affected);
  }
  const files = await query<FileRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'files')} WHERE field_id = ${id}`,
  );
  counts.files = (counts.files ?? 0) + files.rows.length;
  for (const file of files.rows) {
    await query(
      db,
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:file:${file.storage_key}`}, 0))`,
    );
    await query(db, sql`DELETE FROM ${ident(schemas.app, 'files')} WHERE id = ${file.id}`);
    const shared = await query(
      db,
      sql`SELECT 1 FROM ${ident(schemas.app, 'files')} WHERE storage_key = ${file.storage_key} LIMIT 1`,
    );
    if (!shared.rowCount) {
      const storage = fileStorage(file.storage, db, schemas.app, ctx.config);
      for (const key of [file.storage_key, `${file.storage_key}_small`, `${file.storage_key}_large`])
        await storage.delete(key);
    }
  }
  const backups = await query<{ column_name: string }>(
    db,
    sql`DELETE FROM ${ident(schemas.app, 'column_backups')} WHERE field_id = ${id} RETURNING column_name`,
  );
  for (const backup of backups.rows) await dropColumn(db, schemas.data, field.tableId, backup.column_name);
  if (columnType(field)) await dropColumn(db, schemas.data, field.tableId, field.columnName);
  await query(db, sql`DELETE FROM ${ident(schemas.app, 'fields')} WHERE id = ${id}`);
  await query(db, sql`DELETE FROM ${ident(schemas.app, 'data_indexes')} WHERE ${id} = ANY(field_ids)`);
}

/**
 * Clears every value of the database's AI fields whose prompts read a field just deleted for good,
 * directly or through another field, since what those values were written from is gone.  AI fields
 * in the trash are cleared too, so nothing comes back with them.  Their runs' errors go with the
 * values, since an error can quote an answer.
 */
async function clearAiValues(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
  purged: ReadonlySet<string>,
): Promise<void> {
  const tables = await query<{ id: string; primary_field_id: string | null }>(
    db,
    sql`SELECT id, primary_field_id FROM ${ident(schemas.app, 'tables')} WHERE database_id = ${databaseId}`,
  );
  const fields = await loadFields(
    db,
    schemas,
    tables.rows.map((row) => row.id),
    { includeTrashed: true },
  );
  const byId = new Map(fields.map((field) => [field.id, field]));
  const primaries = new Map(tables.rows.map((row) => [row.id, row.primary_field_id]));
  const cleared = new Set<string>();
  for (const field of fields) {
    if (!field.ai || !columnType(field)) continue;
    const reads = promptReads(field.ai.prompt, (id) => byId.get(id), primaries);
    if (![...reads.fields].some((id) => purged.has(id))) continue;
    const column = ident(field.columnName);
    await query(
      db,
      sql`UPDATE ${ident(schemas.data, field.tableId)} SET ${column} = NULL WHERE ${column} IS NOT NULL`,
    );
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'ai_field_runs')} SET superseded = true
      WHERE field_id = ${field.id} AND state = 'failed' AND NOT superseded`,
    );
    cleared.add(field.tableId);
  }
  if (cleared.size)
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'tables')} SET data_version = data_version + 1
      WHERE id = ANY(${[...cleared]}::text[])`,
    );
}

/** The command database lock makes restoration and expiry one ordered decision. */
export async function purgeTrash(ctx: AppContext): Promise<void> {
  if (!ctx.pool || !ctx.config.database) return;
  const { pool, schemas } = dataStore(ctx);
  await purgeRetained(ctx);
  const databases = await query<{ id: string; org_id: string }>(
    pool,
    sql`SELECT id, org_id FROM ${ident(schemas.app, 'databases')} ORDER BY org_id, id`,
  );
  for (const database of databases.rows) {
    const outsideOriginals: OriginalRow[] = [];
    await withTransaction(
      pool,
      async (db) => {
        await lockRetention(db, schemas, database.org_id, database.id);
        const { effective, legalHold } = await retentionFor(db, schemas, database.org_id, database.id);
        const cutoff = retentionCutoff(effective.trashDays);
        if (legalHold || !cutoff) return;
        const counts: Record<string, number> = {};
        const parent = await query<{ expired: boolean; trashed_at: Date | null }>(
          db,
          sql`SELECT trashed_at, trashed_at < ${cutoff} AS expired FROM ${ident(schemas.app, 'databases')} WHERE id = ${database.id}`,
        );
        if (!parent.rowCount) return;
        const removedDashboards = await query(
          db,
          sql`DELETE FROM ${ident(schemas.app, 'dashboards')} WHERE database_id = ${database.id}
          AND (${Boolean(parent.rows[0]!.expired)} OR trashed_at < ${cutoff})`,
        );
        counts.dashboards = removedDashboards.rowCount ?? 0;
        const removedInterfaces = await query(
          db,
          sql`DELETE FROM ${ident(schemas.app, 'interfaces')} WHERE database_id = ${database.id}
          AND (${Boolean(parent.rows[0]!.expired)} OR trashed_at < ${cutoff})`,
        );
        counts.interfaces = removedInterfaces.rowCount ?? 0;
        const removedScripts = await query(
          db,
          sql`DELETE FROM ${ident(schemas.app, 'scripts')} WHERE database_id = ${database.id}
          AND (${Boolean(parent.rows[0]!.expired)} OR trashed_at < ${cutoff})`,
        );
        counts.scripts = removedScripts.rowCount ?? 0;
        const purged = new Set<string>();
        const affected = new Set<string>();
        const tables = await query<{
          id: string;
          expired: boolean;
          trashed_at: Date | null;
          purged_at: Date | null;
        }>(
          db,
          sql`SELECT id, trashed_at, purged_at, trashed_at < ${cutoff} AS expired FROM ${ident(schemas.app, 'tables')} WHERE database_id = ${database.id}`,
        );
        for (const table of tables.rows) {
          const expired = Boolean(parent.rows[0]!.expired || table.expired);
          const retainedHistory =
            (expired || table.purged_at !== null) &&
            (
              await query(
                db,
                sql`SELECT 1 FROM ${ident(schemas.app, 'sync_runs')}
            WHERE table_id = ${table.id} LIMIT 1`,
              )
            ).rowCount;
          if (expired || table.purged_at) {
            const originals = await purgeOriginals(db, schemas.app, table.id);
            counts.files = (counts.files ?? 0) + originals.length;
            outsideOriginals.push(...originals.filter((original) => original.storage !== 'postgres'));
          }
          if (table.purged_at) {
            if (!retainedHistory)
              await query(db, sql`DELETE FROM ${ident(schemas.app, 'tables')} WHERE id = ${table.id}`);
            continue;
          }
          // Keep the deletion timestamp so comments can outlive their record's trash window.
          await query(
            db,
            sql`UPDATE ${ident(schemas.app, 'comments')} c SET record_deleted_at =
              LEAST(r.__deleted_at, ${table.trashed_at}::timestamptz, ${parent.rows[0]!.trashed_at}::timestamptz)
            FROM ${ident(schemas.data, table.id)} r WHERE c.table_id = ${table.id} AND c.record_id = r.__id
            AND c.record_deleted_at IS DISTINCT FROM
              LEAST(r.__deleted_at, ${table.trashed_at}::timestamptz, ${parent.rows[0]!.trashed_at}::timestamptz)`,
          );
          if (expired)
            await query(
              db,
              sql`UPDATE ${ident(schemas.app, 'comments')} SET record_deleted_at =
              LEAST(record_deleted_at, ${table.trashed_at}::timestamptz, ${parent.rows[0]!.trashed_at}::timestamptz)
              WHERE table_id = ${table.id}`,
            );
          const removed = await query(
            db,
            sql`DELETE FROM ${ident(schemas.data, table.id)} WHERE __id IN (
            SELECT __id FROM ${ident(schemas.data, table.id)} WHERE __deleted_at < ${cutoff} LIMIT ${RETENTION_BATCH_SIZE})`,
          );
          counts.records = (counts.records ?? 0) + (removed.rowCount ?? 0);
          const synced = await query(
            db,
            sql`SELECT table_id FROM ${ident(schemas.app, 'table_sources')} WHERE table_id = ${table.id}`,
          );
          if (synced.rowCount) {
            await query(
              db,
              sql`UPDATE ${ident(schemas.app, 'comments')} c SET record_deleted_at = r.__synced_at
              FROM ${ident(schemas.data, table.id)} r WHERE c.table_id = ${table.id} AND c.record_id = r.__id
              AND r.__source_gone AND c.record_deleted_at IS NULL`,
            );
            const removed = await query(
              db,
              sql`DELETE FROM ${ident(schemas.data, table.id)} WHERE __id IN (
              SELECT __id FROM ${ident(schemas.data, table.id)} WHERE __source_gone AND __synced_at < ${cutoff} LIMIT ${RETENTION_BATCH_SIZE})`,
            );
            counts.records = (counts.records ?? 0) + (removed.rowCount ?? 0);
          }
          // Lists' places for the records just purged go with them.
          if (!expired)
            await query(
              db,
              sql`DELETE FROM ${ident(schemas.app, 'record_positions')} p
              USING ${ident(schemas.app, 'views')} v
              WHERE p.view_id = v.id AND v.table_id = ${table.id}
                AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.data, table.id)} r WHERE r.__id = p.record_id)`,
            );
          // What the ingest process remembered about a purged record holds its values, so it goes too.
          // A table being purged takes its remembered rows with it.
          if (!expired)
            await query(
              db,
              sql`DELETE FROM ${ident(schemas.app, 'ingest_row_state')} s
              WHERE s.org_id = ${database.org_id} AND s.table_id = ${table.id}
                AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.data, table.id)} r WHERE r.__id = s.record_id)`,
            );
          if (expired) {
            // One-way destinations have no field that can lead the field purge to their junctions.
            const incoming = await query<{ id: string; left_field_id: string }>(
              db,
              sql`SELECT id, left_field_id FROM ${ident(schemas.app, 'links')}
                WHERE right_table_id = ${table.id} AND right_field_id IS NULL`,
            );
            for (const link of incoming.rows) {
              const source = await loadField(db, schemas, link.left_field_id);
              if (source?.type === 'link' && source.options.linkedTableId === table.id)
                await purgeField(ctx, db, schemas, source.id, purged, counts, affected);
              else {
                await dropRecordTable(db, schemas.data, `lnk_${link.id}`);
                await query(db, sql`DELETE FROM ${ident(schemas.app, 'links')} WHERE id = ${link.id}`);
              }
            }
          }
          const fields = await query<{ id: string }>(
            db,
            sql`SELECT id FROM ${ident(schemas.app, 'fields')} WHERE table_id = ${table.id} AND (${expired} OR trashed_at < ${cutoff})`,
          );
          for (const field of fields.rows)
            await purgeField(ctx, db, schemas, field.id, purged, counts, affected);
          const removedViews = await query(
            db,
            sql`DELETE FROM ${ident(schemas.app, 'views')} WHERE table_id = ${table.id} AND (${expired} OR trashed_at < ${cutoff})`,
          );
          counts.views = (counts.views ?? 0) + (removedViews.rowCount ?? 0);
          if (expired) {
            const remaining = await query<{ records: string }>(
              db,
              sql`SELECT count(*) AS records FROM ${ident(schemas.data, table.id)}`,
            );
            counts.records = (counts.records ?? 0) + Number(remaining.rows[0]!.records);
            counts.tables = (counts.tables ?? 0) + 1;
            await dropRecordTable(db, schemas.data, table.id);
            if (retainedHistory) {
              // Only history metadata remains, and changing the trash window cannot restore it.
              for (const catalog of [
                'table_sources',
                'record_rules',
                'record_locks',
                'field_permissions',
                'booking_pages',
                'payment_pages',
                'payment_fields',
                'signature_requests',
                'report_schedules',
                'file_uploads',
                'embedding_tables',
                'embeddings',
                'data_indexes',
                'column_backups',
              ]) {
                const removed = await query(
                  db,
                  sql`DELETE FROM ${ident(schemas.app, catalog)} WHERE table_id = ${table.id}`,
                );
                counts[catalog] = (counts[catalog] ?? 0) + (removed.rowCount ?? 0);
              }
              await query(
                db,
                sql`UPDATE ${ident(schemas.app, 'comments')} SET table_id = NULL WHERE table_id = ${table.id}`,
              );
              await query(
                db,
                sql`UPDATE ${ident(schemas.app, 'tables')}
                SET purged_at = clock_timestamp(), trashed_at = COALESCE(trashed_at, ${parent.rows[0]!.trashed_at})
                WHERE id = ${table.id}`,
              );
            } else await query(db, sql`DELETE FROM ${ident(schemas.app, 'tables')} WHERE id = ${table.id}`);
          } else {
            await query(
              db,
              sql`UPDATE ${ident(schemas.app, 'tables')} SET data_version = data_version + 1 WHERE id = ${table.id}`,
            );
          }
        }
        // Run logs retain their database identity and expire through their own counted batches.
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'automation_runs')} r
          SET state = 'skipped', finished_at = clock_timestamp(), lease_at = NULL, lease_token = NULL,
            wake_at = NULL, wait_table_id = NULL
          FROM ${ident(schemas.app, 'automations')} a
          WHERE a.id = r.automation_id AND a.database_id = ${database.id}
            AND (${Boolean(parent.rows[0]!.expired)} OR a.trashed_at < ${cutoff})
            AND r.state IN ('queued', 'waiting', 'running')`,
        );
        const removedAutomations = await query(
          db,
          sql`DELETE FROM ${ident(schemas.app, 'automations')} WHERE database_id = ${database.id}
          AND (${Boolean(parent.rows[0]!.expired)} OR trashed_at < ${cutoff})`,
        );
        counts.automations = removedAutomations.rowCount ?? 0;
        for (const id of affected) {
          if (id === database.id && parent.rows[0]!.expired) continue;
          await clearAiValues(db, schemas, id, purged);
          await recordChange(
            {
              db,
              schemas,
              databaseId: id,
              actor: {
                orgId: database.org_id,
                userId: '',
                kind: 'owner',
                adminRoles: [],
                sessionId: '',
                csrfToken: '',
              },
            },
            { body: { kind: 'access.changed' }, prev: {} },
            { commandId: newId('command'), groupId: newId('action'), clientId: null, system: true },
          );
        }
        counts.fields = purged.size;
        // An outside SQL login goes before its database does.  Its row goes with the database, and
        // the row is what keeps its role's sessions in check.
        if (parent.rows[0]!.expired) await dropLogin(db, schemas, database.id);
        const retainedTables = await query(
          db,
          sql`SELECT 1 FROM ${ident(schemas.app, 'tables')}
          WHERE database_id = ${database.id} LIMIT 1`,
        );
        if (parent.rows[0]!.expired && retainedTables.rowCount) {
          await query(
            db,
            sql`DELETE FROM ${ident(schemas.app, 'folder_databases')} WHERE database_id = ${database.id}`,
          );
          await query(
            db,
            sql`UPDATE ${ident(schemas.app, 'databases')}
            SET purged_at = COALESCE(purged_at, clock_timestamp()) WHERE id = ${database.id}`,
          );
        }
        if (parent.rows[0]!.expired && !retainedTables.rowCount) {
          counts.databases = 1;
          // Retained rows keep their promised windows after their database is gone.
          await query(
            db,
            sql`UPDATE ${ident(schemas.app, 'orgs')}
              SET retired_database_retention = retired_database_retention ||
                ${JSON.stringify({
                  [database.id]: {
                    auditDays: effective.auditDays,
                    deletedCommentsDays: effective.deletedCommentsDays,
                    historyDays: effective.historyDays,
                    automationRunsDays: effective.automationRunsDays,
                    routineRunsDays: effective.routineRunsDays,
                  },
                })}::jsonb
              WHERE id = ${database.org_id}`,
          );
          await query(
            db,
            sql`DELETE FROM ${ident(schemas.app, 'grants')} WHERE resource_kind = 'database' AND resource_id = ${database.id}`,
          );
          await query(db, sql`DELETE FROM ${ident(schemas.app, 'databases')} WHERE id = ${database.id}`);
        }
        await recordPurge(db, schemas, database.org_id, database.id, counts);
      },
      LONG_DEADLINES,
    );
    for (const original of outsideOriginals)
      await fileStorage(original.storage, pool, schemas.app, ctx.config).delete(original.storage_key);
  }
  const organizations = await query<{ org_id: string }>(
    pool,
    sql`SELECT org_id FROM ${ident(schemas.app, 'folders')} WHERE trashed_at IS NOT NULL
      UNION SELECT org_id FROM ${ident(schemas.app, 'home_shortcuts')} WHERE trashed_at IS NOT NULL
      UNION SELECT org_id FROM ${ident(schemas.app, 'home_tags')} WHERE trashed_at IS NOT NULL`,
  );
  for (const { org_id: orgId } of organizations.rows) {
    await withTransaction(pool, async (db) => {
      await lockRetention(db, schemas, orgId);
      const { effective } = await retentionFor(db, schemas, orgId);
      const cutoff = retentionCutoff(effective.trashDays);
      if (!cutoff) return;
      await query(
        db,
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:home:${orgId}`}, 0))`,
      );
      const counts: Record<string, number> = {};
      for (const table of ['home_shortcuts', 'home_tags']) {
        const removed = await query(
          db,
          sql`DELETE FROM ${ident(schemas.app, table)} WHERE org_id = ${orgId} AND id IN (
            SELECT id FROM ${ident(schemas.app, table)} WHERE org_id = ${orgId} AND trashed_at < ${cutoff} LIMIT ${RETENTION_BATCH_SIZE})`,
        );
        counts[table === 'home_shortcuts' ? 'shortcuts' : 'tags'] = removed.rowCount ?? 0;
      }
      await query(
        db,
        sql`DELETE FROM ${ident(schemas.app, 'home_tag_links')} l WHERE l.org_id = ${orgId} AND (
        (l.resource_kind = 'database' AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'databases')} d WHERE d.org_id = ${orgId} AND d.id = l.resource_id))
        OR (l.resource_kind = 'folder' AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'folders')} f WHERE f.org_id = ${orgId} AND f.id = l.resource_id)))`,
      );
      const expired = await query<{ id: string }>(
        db,
        sql`SELECT f.id FROM ${ident(schemas.app, 'folders')} f
        WHERE f.org_id = ${orgId} AND f.trashed_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'folders')} child
          WHERE child.org_id = f.org_id AND child.path @> ARRAY[f.id] AND (child.trashed_at IS NULL OR child.trashed_at >= ${cutoff}))
        AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'folder_databases')} fd
          JOIN ${ident(schemas.app, 'folders')} child ON child.org_id = fd.org_id AND child.id = fd.folder_id
          WHERE child.org_id = f.org_id AND (child.id = f.id OR child.path @> ARRAY[f.id]))`,
      );
      const ids = expired.rows.map((row) => row.id);
      counts.folders = ids.length;
      await query(
        db,
        sql`DELETE FROM ${ident(schemas.app, 'grants')} WHERE org_id = ${orgId} AND resource_kind = 'folder' AND resource_id = ANY(${ids}::text[])`,
      );
      await query(
        db,
        sql`DELETE FROM ${ident(schemas.app, 'folders')} WHERE org_id = ${orgId} AND id = ANY(${ids}::text[])`,
      );
      await recordPurge(db, schemas, orgId, null, counts);
      if (Object.values(counts).some((count) => count > 0))
        await query(db, sql`SELECT pg_notify(${homeChannel(schemas)}, ${orgId})`);
    });
  }
  await query(
    pool,
    sql`DELETE FROM ${ident(schemas.app, 'knowledge_actions')} WHERE created_at <= now() - interval '30 days'`,
  );
  await eraseExpiredLibraryReviews(pool, schemas.app);
  // Notifications are kept for 90 days, whatever they're about.
  await purgeNotifications(pool, schemas);
}

export function installTrashPurge(app: FastifyInstance): void {
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  app.addHook('onReady', async () => {
    timer = setInterval(
      () => {
        if (running) return;
        running = purgeTrash(app.ctx)
          .catch((error: unknown) => {
            app.log.error({ err: error }, 'trash purge failed');
          })
          .finally(() => {
            running = undefined;
          });
      },
      60 * 60 * 1000,
    );
    timer.unref();
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await running;
  });
}
