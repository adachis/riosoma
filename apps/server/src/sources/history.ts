import { AppError, type SyncHistoryPage, type SyncRun, type SyncStatus } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { AccessScope } from '../data/access.js';
import type { DataSchemas } from '../data/context.js';
import { loadTable } from '../data/metadata.js';
import type pg from 'pg';
import { purgeSourceHistory } from '../data/retention.js';

/** Expire runs and their value changes together, including tables no longer syncing. */
export async function purgeSyncHistory(db: pg.Pool, schemas: DataSchemas): Promise<void> {
  await purgeSourceHistory(db, schemas);
}

export async function startSyncRun(db: Queryable, schemas: DataSchemas, tableId: string, id: string) {
  await query(
    db,
    sql`UPDATE ${ident(schemas.app, 'sync_runs')}
    SET outcome = 'canceled', ended_at = now(), stats = jsonb_build_object(
      'added', 0, 'changed', 0, 'removed', 0, 'unchanged', 0, 'overridesCleared', 0,
      'ms', EXTRACT(epoch FROM now() - started_at) * 1000)
    WHERE table_id = ${tableId} AND outcome = 'running' AND id <> ${id}`,
  );
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.app, 'sync_runs')} (id, table_id, outcome)
    VALUES (${id}, ${tableId}, 'running') ON CONFLICT DO NOTHING`,
  );
}

export async function finishSyncRun(db: Queryable, schemas: DataSchemas, id: string, status: SyncStatus) {
  const outcome = status.state === 'failed' ? 'failed' : status.state === 'held' ? 'held' : 'succeeded';
  await query(
    db,
    sql`UPDATE ${ident(schemas.app, 'sync_runs')}
    SET ended_at = now(), outcome = ${outcome},
      stats = COALESCE(${outcome === 'succeeded' ? JSON.stringify(status.stats) : null}::jsonb,
        jsonb_build_object('added', 0, 'changed', 0, 'removed', 0, 'unchanged', 0, 'overridesCleared', 0,
          'ms', EXTRACT(epoch FROM now() - started_at) * 1000)),
      error_key = ${status.error?.messageKey ?? null}
    WHERE id = ${id} AND outcome = 'running'`,
  );
}

/** Counts are withheld when record or field rules could make them reveal hidden activity. */
export async function syncHistory(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  tableId: string,
  cursor?: string,
): Promise<SyncHistoryPage> {
  const table = await loadTable(db, schemas, tableId);
  if (!table || table.trashed) throw new AppError('not_found', 'errors.notFound');
  await scope.require(table.databaseId, 'read');
  let before: { at: string; id: string } | undefined;
  if (cursor) {
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (
        value.tableId !== tableId ||
        typeof value.id !== 'string' ||
        typeof value.at !== 'string' ||
        !Number.isFinite(Date.parse(value.at))
      )
        throw new Error();
      before = value;
    } catch {
      throw new AppError('validation_failed', 'errors.validationFailed');
    }
  }
  const result = await query<{
    id: string;
    started_at: Date;
    ended_at: Date | null;
    outcome: SyncRun['outcome'];
    stats: SyncRun['stats'];
    error_key: string | null;
  }>(
    db,
    sql`SELECT r.* FROM ${ident(schemas.app, 'sync_runs')} r
    JOIN ${ident(schemas.app, 'tables')} t ON t.id = r.table_id
    WHERE r.table_id = ${tableId}
      AND r.started_at >= now() - t.history_retention_days * interval '1 day'
      AND ${before ? sql`(r.started_at, r.id) < (${before.at}::timestamptz, ${before.id})` : sql`TRUE`}
    ORDER BY r.started_at DESC, r.id DESC LIMIT 51`,
  );
  const page = result.rows.slice(0, 50);
  const last = page.at(-1);
  // A joined table always reads through its inputs' rules, which an owner has none of, so the
  // question is whether any rule of the database narrows what this person sees.
  const limited = scope.limited(table.databaseId);
  return {
    runs: page.map((row) => ({
      id: row.id,
      tableId,
      startedAt: row.started_at.toISOString(),
      endedAt: row.ended_at?.toISOString() ?? null,
      outcome: row.outcome,
      stats: limited ? null : row.stats,
      errorKey: row.error_key,
    })),
    next:
      result.rows.length > 50 && last
        ? Buffer.from(JSON.stringify({ tableId, at: last.started_at.toISOString(), id: last.id })).toString(
            'base64url',
          )
        : null,
  };
}
