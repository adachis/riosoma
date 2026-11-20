import { AppError, newId, type JoinedTable, type TableMeta } from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import type { AppContext } from '../app.js';
import type { AccessScope, ReadMode } from '../data/access.js';
import { dataStore } from '../data/context.js';
import { loadTable } from '../data/metadata.js';
import { joinedInputs } from '../data/physical/joined.js';
import { liveDeps, readsLive, visibleLive } from './live.js';
import { runSync, type SyncJob } from './sync.js';

/** Live inputs use the same staged, audited apply as a sync before the join is read. */
export async function refreshJoinedSources(
  ctx: AppContext,
  scope: AccessScope,
  settings: JoinedTable,
  readMode: ReadMode = {},
): Promise<void> {
  if (readMode.readOnly || scope.actor.demo) return;
  const { pool, schemas } = dataStore(ctx);
  for (const id of joinedInputs(settings)) {
    const table = await loadTable(pool, schemas, id);
    if (!table || table.trashed) throw new AppError('not_found', 'errors.notFound');
    await scope.require(table.databaseId, 'read');
    if (table.joined) await refreshJoinedSources(ctx, scope, table.joined, readMode);
    if (!readsLive(table)) continue;
    let ran = false;
    try {
      const job = await withTransaction(pool, async (db) => {
        const result = await query<SyncJob>(
          db,
          sql`SELECT ts.*, t.database_id, t.org_id
          FROM ${ident(schemas.app, 'table_sources')} ts JOIN ${ident(schemas.app, 'tables')} t ON t.id = ts.table_id
          WHERE ts.table_id = ${id} AND (ts.lease_at IS NULL OR ts.lease_at < now() - interval '30 minutes')
          FOR UPDATE OF ts SKIP LOCKED`,
        );
        const claimed = result.rows[0];
        if (!claimed) throw new AppError('conflict', 'errors.conflict');
        claimed.lease_token = newId('job');
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'table_sources')}
          SET lease_at = now(), lease_token = ${claimed.lease_token} WHERE table_id = ${id}`,
        );
        return claimed;
      });
      await runSync(ctx, job);
      ran = true;
    } catch (error) {
      // A scheduled sync or another read holds the lease.  This read takes the values already
      // there rather than failing, and the run in progress answers the next one.
      if (!(error instanceof AppError) || error.code !== 'conflict') throw error;
    }
    if (!ran) continue;
    const current = await loadTable(pool, schemas, id);
    if (current?.source?.status.state === 'failed' || current?.source?.status.state === 'held')
      throw new AppError(
        'unavailable',
        current.source.status.error?.messageKey ?? 'sources.live.unreachable',
      );
  }
}

/** Confirm live record rules on each input before the joined provenance predicate reads it. */
export async function prepareJoinedRead(
  ctx: AppContext,
  scope: AccessScope,
  table: TableMeta,
  readMode: ReadMode = {},
): Promise<Map<string, string[]>> {
  const confirmed = new Map<string, string[]>();
  if (!table.joined) return confirmed;
  await refreshJoinedSources(ctx, scope, table.joined, readMode);
  if (readMode.readOnly || scope.actor.demo) return confirmed;
  const { pool, schemas } = dataStore(ctx);
  const confirm = async (settings: JoinedTable): Promise<void> => {
    for (const id of joinedInputs(settings)) {
      const input = await loadTable(pool, schemas, id);
      if (input?.joined) await confirm(input.joined);
      if (!input || !readsLive(input) || scope.liveRules(id) === null) continue;
      const records = await query<{ id: string }>(
        pool,
        sql`SELECT __id AS id FROM ${ident(schemas.data, id)} WHERE __deleted_at IS NULL AND NOT __source_gone`,
      );
      for (let offset = 0; offset < records.rows.length; offset += 1000) {
        const visible = await visibleLive(
          liveDeps(ctx),
          input,
          scope,
          records.rows.slice(offset, offset + 1000).map((row) => row.id),
        );
        scope.confirmLive(id, visible);
        confirmed.set(id, [...(confirmed.get(id) ?? []), ...visible]);
      }
    }
  };
  await confirm(table.joined);
  return confirmed;
}
