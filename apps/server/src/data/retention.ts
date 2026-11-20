import type { RetentionPolicy } from '@riosoma/contracts';
import type pg from 'pg';
import { compile, ident, query, sql, withTransaction, type Queryable, type Sql } from '@riosoma/db';
import type { AppContext } from '../app.js';
import { auditEvent } from '../auth/database.js';
import { dataStore, type DataSchemas } from './context.js';
import { retentionFor } from './governance.js';

export const RETENTION_BATCH_SIZE = 500;
export const retentionCutoff = (days: number | null, now = new Date()): Date | null =>
  days === null ? null : new Date(now.getTime() - days * 86_400_000);

export async function recordPurge(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  databaseId: string | null,
  counts: Record<string, number>,
): Promise<void> {
  const removed = Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0));
  if (!Object.keys(removed).length) return;
  // What went, counted and never copied: a purge event carries no removed contents.
  await auditEvent(
    db,
    compile(sql`${ident(schemas.audit)}`).text,
    'governance.retention.purged',
    { orgId },
    { databaseId, counts: removed },
  );
}

async function removeBatch(db: Queryable, table: ReturnType<typeof ident>, condition: Sql): Promise<number> {
  const result = await query(
    db,
    sql`DELETE FROM ${table} WHERE ctid IN (
    SELECT ctid FROM ${table} WHERE ${condition} LIMIT ${RETENTION_BATCH_SIZE})`,
  );
  return result.rowCount ?? 0;
}

async function removeAuditBatch(db: Queryable, schemas: DataSchemas, condition: Sql): Promise<number> {
  const events = ident(schemas.audit, 'events');
  await query(db, sql`SELECT set_config('riosoma.retention_purge', 'on', true)`);
  // Each event leaves its place in the chain and its hash behind, so an integrity check still
  // walks an unbroken chain, and an event that goes missing another way is still a break.
  const result = await query(
    db,
    sql`WITH expired AS (
      SELECT ctid AS row_id, org_id, chain_seq, hash FROM ${events}
      WHERE ${condition} LIMIT ${RETENTION_BATCH_SIZE}
    ), journaled AS (
      INSERT INTO ${ident(schemas.audit, 'purged')} (org_id, chain_seq, hash)
      SELECT COALESCE(org_id, ''), chain_seq, hash FROM expired ON CONFLICT DO NOTHING
    )
    DELETE FROM ${events} rows USING expired WHERE rows.ctid = expired.row_id`,
  );
  await query(db, sql`SELECT set_config('riosoma.retention_purge', 'off', true)`);
  return result.rowCount ?? 0;
}

/** What one pass would remove, counted first so its purge event can be written before the events. */
async function countAuditBatch(db: Queryable, schemas: DataSchemas, condition: Sql): Promise<number> {
  const result = await query<{ count: string }>(
    db,
    sql`SELECT count(*)::text AS count FROM (
      SELECT 1 FROM ${ident(schemas.audit, 'events')} WHERE ${condition} LIMIT ${RETENTION_BATCH_SIZE}
    ) expired`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** A hold and a purge take the same organization lock before any database lock. */
export async function lockRetention(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  databaseId?: string,
): Promise<void> {
  await query(
    db,
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:database:governance:${orgId}`}, 0))`,
  );
  if (databaseId)
    await query(
      db,
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:database:${databaseId}`}, 0))`,
    );
}

/** Parent catalogs can disappear before their histories, so each history retains a database ID. */
async function purgeLogs(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
  effective: Required<RetentionPolicy>,
  now: Date,
  only?: 'automationRuns' | 'routineRuns' | 'syncHistory',
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const cutoff = (key: keyof RetentionPolicy) => retentionCutoff(effective[key], now);
  if (!only || only === 'syncHistory') {
    // A trashed source cannot reclaim its lease, so a crashed run must become eligible to expire.
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'sync_runs')} r
      SET outcome = 'canceled', ended_at = ${now}
      WHERE r.id IN (
        SELECT r.id FROM ${ident(schemas.app, 'sync_runs')} r
        JOIN ${ident(schemas.app, 'tables')} t ON t.id = r.table_id
        JOIN ${ident(schemas.app, 'databases')} d ON d.id = t.database_id
        LEFT JOIN ${ident(schemas.app, 'table_sources')} s ON s.table_id = t.id
        WHERE t.database_id = ${databaseId} AND r.outcome = 'running'
          AND (t.trashed_at IS NOT NULL OR d.trashed_at IS NOT NULL)
          AND COALESCE(s.lease_at, r.started_at) < ${now}::timestamptz - interval '30 minutes'
        ORDER BY r.started_at LIMIT ${RETENTION_BATCH_SIZE})`,
    );
    const expiredRuns = sql`SELECT r.id FROM ${ident(schemas.app, 'sync_runs')} r
      JOIN ${ident(schemas.app, 'tables')} t ON t.id = r.table_id
      WHERE t.database_id = ${databaseId} AND r.outcome <> 'running'
        AND r.started_at < ${now}::timestamptz -
          LEAST(t.history_retention_days, ${effective.historyDays}::integer) * interval '1 day'`;
    counts.syncRecordChanges = await removeBatch(
      db,
      ident(schemas.app, 'sync_record_changes'),
      sql`run_id IN (${expiredRuns})`,
    );
    counts.syncRuns = await removeBatch(
      db,
      ident(schemas.app, 'sync_runs'),
      sql`id IN (${expiredRuns}) AND NOT EXISTS (
        SELECT 1 FROM ${ident(schemas.app, 'sync_record_changes')} c
        WHERE c.run_id = ${ident(schemas.app, 'sync_runs')}.id)`,
    );
  }
  if (!only || only === 'automationRuns')
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'automation_runs')} r
      SET state = 'skipped', finished_at = ${now}, lease_at = NULL, lease_token = NULL,
        wake_at = NULL, wait_table_id = NULL
      WHERE r.id IN (SELECT r.id FROM ${ident(schemas.app, 'automation_runs')} r
        WHERE r.database_id = ${databaseId} AND r.state IN ('queued', 'waiting', 'running')
          AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'automations')} a WHERE a.id = r.automation_id)
        ORDER BY r.queued_at LIMIT ${RETENTION_BATCH_SIZE})`,
    );
  const automationCutoff = cutoff('automationRunsDays');
  if ((!only || only === 'automationRuns') && automationCutoff)
    counts.automationRuns = await removeBatch(
      db,
      ident(schemas.app, 'automation_runs'),
      sql`database_id = ${databaseId} AND state NOT IN ('waiting', 'running') AND queued_at < ${automationCutoff}`,
    );
  const routineCutoff = cutoff('routineRunsDays');
  if ((!only || only === 'routineRuns') && routineCutoff)
    counts.routineRuns = await removeBatch(
      db,
      ident(schemas.app, 'rio_routine_runs'),
      sql`database_id = ${databaseId} AND state IN ('done', 'stopped', 'failed', 'skipped') AND finished_at < ${routineCutoff}`,
    );
  const historyCutoff = cutoff('historyDays');
  if (!only && historyCutoff) {
    // Remove references first so one bulk change cannot cascade past the batch limit.
    counts.recordChanges = await removeBatch(
      db,
      ident(schemas.app, 'record_changes'),
      sql`database_id = ${databaseId} AND seq IN (SELECT seq FROM ${ident(schemas.app, 'changes')}
        WHERE database_id = ${databaseId} AND at < ${historyCutoff})`,
    );
    const removed = await query<{ seq: string; group_id: string }>(
      db,
      sql`DELETE FROM ${ident(schemas.app, 'changes')} WHERE database_id = ${databaseId} AND seq IN (
        SELECT c.seq FROM ${ident(schemas.app, 'changes')} c WHERE c.database_id = ${databaseId}
          AND c.at < ${historyCutoff} AND NOT EXISTS (
            SELECT 1 FROM ${ident(schemas.app, 'record_changes')} r
            WHERE r.database_id = c.database_id AND r.seq = c.seq)
          ORDER BY c.seq LIMIT ${RETENTION_BATCH_SIZE}) RETURNING seq, group_id`,
    );
    counts.history = removed.rowCount ?? 0;
    if (removed.rows.length) {
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'databases')} SET history_floor = GREATEST(history_floor,
        ${Math.max(...removed.rows.map((row) => Number(row.seq)))}) WHERE id = ${databaseId}`,
      );
      await query(
        db,
        sql`DELETE FROM ${ident(schemas.app, 'undo_groups')} WHERE database_id = ${databaseId}
        AND group_id = ANY(${removed.rows.map((row) => row.group_id)}::text[])`,
      );
    }
  }
  return counts;
}

/** Each pass does bounded work, and the next pass continues with the oldest remaining data. */
export async function purgeRetained(
  ctx: AppContext,
  now = new Date(),
  only?: 'automationRuns' | 'routineRuns',
): Promise<number> {
  if (!ctx.pool || !ctx.config.database) return 0;
  const { pool, schemas } = dataStore(ctx);
  return purgeRetention(pool, schemas, now, only);
}

/** Explicit source-history maintenance uses the retention worker’s policies and batch limits. */
export async function purgeSourceHistory(pool: pg.Pool, schemas: DataSchemas): Promise<number> {
  return purgeRetention(pool, schemas, new Date(), 'syncHistory');
}

async function purgeRetention(
  pool: pg.Pool,
  schemas: DataSchemas,
  now: Date,
  only?: 'automationRuns' | 'routineRuns' | 'syncHistory',
): Promise<number> {
  const databases = await query<{ id: string; org_id: string }>(
    pool,
    sql`SELECT id, org_id FROM ${ident(schemas.app, 'databases')} ORDER BY org_id, id`,
  );
  let total = 0;
  for (const database of databases.rows)
    await withTransaction(pool, async (db) => {
      await lockRetention(db, schemas, database.org_id, database.id);
      const { effective, legalHold } = await retentionFor(db, schemas, database.org_id, database.id);
      if (legalHold) return;
      const counts = await purgeLogs(db, schemas, database.id, effective, now, only);
      let expiredAudit: Sql | null = null;
      const cutoff = (key: keyof RetentionPolicy) => retentionCutoff(effective[key], now);
      if (!only) {
        const commentsCutoff = cutoff('deletedCommentsDays');
        const tables = await query<{ id: string; deleted_at: Date | null }>(
          db,
          sql`SELECT t.id, LEAST(t.trashed_at, d.trashed_at) AS deleted_at
            FROM ${ident(schemas.app, 'tables')} t JOIN ${ident(schemas.app, 'databases')} d ON d.id = t.database_id
            WHERE t.database_id = ${database.id} AND t.purged_at IS NULL`,
        );
        for (const table of tables.rows) {
          await query(
            db,
            sql`UPDATE ${ident(schemas.app, 'comments')} c SET record_deleted_at = LEAST(r.__deleted_at, ${table.deleted_at}::timestamptz)
          FROM ${ident(schemas.data, table.id)} r WHERE c.table_id = ${table.id} AND c.record_id = r.__id
          AND c.record_deleted_at IS DISTINCT FROM LEAST(r.__deleted_at, ${table.deleted_at}::timestamptz)`,
          );
        }
        if (commentsCutoff)
          counts.comments = await removeBatch(
            db,
            ident(schemas.app, 'comments'),
            sql`org_id = ${database.org_id} AND database_id = ${database.id} AND record_deleted_at < ${commentsCutoff}`,
          );
        const auditCutoff = cutoff('auditDays');
        if (auditCutoff) {
          expiredAudit = sql`org_id = ${database.org_id} AND metadata->>'databaseId' = ${database.id} AND at < ${auditCutoff}`;
          counts.audit = await countAuditBatch(db, schemas, expiredAudit);
        }
      }
      // The purge event is written before the events it counts go, so the chain never reuses a
      // place, and a later check walks the retained events and the journal as one unbroken run.
      await recordPurge(db, schemas, database.org_id, database.id, counts);
      if (expiredAudit && counts.audit) total += await removeAuditBatch(db, schemas, expiredAudit);
      total += Object.entries(counts)
        .filter(([kind]) => kind !== 'audit')
        .reduce((sum, [, count]) => sum + count, 0);
    });
  if (!only) {
    const organizations = await query<{ id: string }>(
      pool,
      sql`SELECT id FROM ${ident(schemas.app, 'orgs')} ORDER BY id`,
    );
    for (const organization of organizations.rows)
      await withTransaction(pool, async (db) => {
        await lockRetention(db, schemas, organization.id);
        const held = await query(
          db,
          sql`SELECT 1 FROM ${ident(schemas.app, 'databases')} WHERE org_id = ${organization.id} AND legal_hold LIMIT 1`,
        );
        const retired = await query<{ policies: Record<string, RetentionPolicy> }>(
          db,
          sql`SELECT retired_database_retention AS policies FROM ${ident(schemas.app, 'orgs')} WHERE id = ${organization.id}`,
        );
        for (const databaseId of Object.keys(retired.rows[0]?.policies ?? {})) {
          const retained = await retentionFor(db, schemas, organization.id, databaseId);
          const logs = await purgeLogs(db, schemas, databaseId, retained.effective, now);
          const retiredCutoff = retentionCutoff(retained.effective.auditDays, now);
          const commentsCutoff = retentionCutoff(retained.effective.deletedCommentsDays, now);
          const comments = commentsCutoff
            ? await removeBatch(
                db,
                ident(schemas.app, 'comments'),
                sql`org_id = ${organization.id} AND database_id = ${databaseId} AND record_deleted_at < ${commentsCutoff}`,
              )
            : 0;
          const condition = retiredCutoff
            ? sql`org_id = ${organization.id} AND metadata->>'databaseId' = ${databaseId} AND at < ${retiredCutoff}`
            : null;
          const removed = condition ? await countAuditBatch(db, schemas, condition) : 0;
          await recordPurge(db, schemas, organization.id, databaseId, logs);
          await recordPurge(db, schemas, organization.id, null, { audit: removed, comments });
          total += Object.values(logs).reduce((sum, count) => sum + count, 0);
          total += comments + (removed && condition ? await removeAuditBatch(db, schemas, condition) : 0);
          await query(
            db,
            sql`UPDATE ${ident(schemas.app, 'orgs')}
            SET retired_database_retention = retired_database_retention - ${databaseId}
            WHERE id = ${organization.id} AND NOT EXISTS (
              SELECT 1 FROM ${ident(schemas.audit, 'events')} WHERE org_id = ${organization.id}
              AND metadata->>'databaseId' = ${databaseId}) AND NOT EXISTS (
              SELECT 1 FROM ${ident(schemas.app, 'comments')} WHERE org_id = ${organization.id}
                AND database_id = ${databaseId}) AND NOT EXISTS (
              SELECT 1 FROM ${ident(schemas.app, 'changes')} WHERE database_id = ${databaseId})
            AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'automation_runs')} WHERE database_id = ${databaseId})
            AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'rio_routine_runs')} WHERE database_id = ${databaseId})`,
          );
        }
        if (held.rowCount) return;
        const { effective } = await retentionFor(db, schemas, organization.id);
        const cutoff = retentionCutoff(effective.auditDays, now);
        if (!cutoff) return;
        const condition = sql`org_id = ${organization.id} AND at < ${cutoff}
        AND NOT COALESCE((SELECT retired_database_retention FROM ${ident(schemas.app, 'orgs')} WHERE id = ${organization.id}) ? (metadata->>'databaseId'), false)
        AND (metadata->>'databaseId' IS NULL OR NOT EXISTS (
          SELECT 1 FROM ${ident(schemas.app, 'databases')} d WHERE d.id = metadata->>'databaseId' AND d.org_id = ${organization.id}))`;
        const count = await countAuditBatch(db, schemas, condition);
        await recordPurge(db, schemas, organization.id, null, { audit: count });
        total += count ? await removeAuditBatch(db, schemas, condition) : 0;
      });
  }
  return total;
}

/** Realtime cannot replay a range whose contents have expired. */
export async function historyExpired(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
  since: number,
): Promise<boolean> {
  const result = await query<{ history_floor: string }>(
    db,
    sql`SELECT history_floor FROM ${ident(schemas.app, 'databases')} WHERE id = ${databaseId}`,
  );
  return Number(result.rows[0]?.history_floor ?? 0) > since;
}
