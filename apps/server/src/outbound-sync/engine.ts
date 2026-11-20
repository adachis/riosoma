import {
  SYNC_OUT_LIMITS,
  type DestinationCredential,
  type DestinationLookup,
  type OutboundDestination,
  type OutboundSyncSettings,
  type SyncOutColumn,
  type SyncOutMessage,
  type SyncOutStats,
  type SyncOutWithheldField,
} from '@riosoma/contracts';
import type { DestinationKind } from '@riosoma/contracts';
import { query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { Clock } from '../data/imports/core/clock.js';
import type { Resolve } from '../automations/outbound.js';
import type { FastifyInstance } from 'fastify';
import { actorFor } from '../automations/run.js';
import { auditEvent, authDatabase } from '../auth/database.js';
import { dataStore } from '../data/context.js';
import { EXPORT_PAGE, snapshotOrder } from '../data/export/source.js';
import { relationContext, withButtonSources } from '../data/format.js';
import { policyAllows } from '../org-units/policy.js';
import { SnapshotCache } from '../data/snapshots.js';
import type { StoredField } from '../data/types.js';
import {
  DestinationError,
  destinationFor,
  type DestinationAdapter,
  type DestinationContext,
  type MappedColumn,
  type OutboundCell,
  type OutsideColumn,
  type OutsideTable,
  type RowResult,
  type TableClaim,
} from './destination.js';
import { reconcileColumns, type ColumnOutcome } from './columns.js';
import { syncRead } from './read.js';
import {
  credentialOf,
  destinationOf,
  mappingOf,
  settingsOf,
  statusOf,
  tables,
  type SyncRow,
} from './store.js';
import { buildColumnPlans, cellForField, columnSignature, EMPTY_CELL, hashRow } from './values.js';

/**
 * One run of a sync: read the view as its creator, send what changed since last time, and record
 * what happened.  A write to the sync row, the map, or the run row always proves the lease first,
 * so a run another worker took over, or one on a sync someone turned off, writes nothing more.  No
 * transaction is ever open while the destination is being called.
 */

/** Thrown when another worker took the run over, so this one stops touching it. */
class LeaseLost extends Error {}

const RECORD_ID = /^rec[0-9A-Za-z]{14}$/;

export interface SyncWorkerLike {
  app: FastifyInstance;
  snapshots: SnapshotCache;
  clock: Clock;
  resolve: Resolve;
  allowPrivate(url: URL): boolean;
  context(
    adapter: DestinationAdapter,
    where: OutboundDestination | DestinationLookup,
    credential: DestinationCredential,
    signal: AbortSignal,
  ): DestinationContext;
}

function cutText(text: string, max: number): { text: string; cut: boolean } {
  const points = [...text];
  if (points.length <= max) return { text, cut: false };
  return { text: points.slice(0, max).join(''), cut: true };
}

export async function runOutboundSync(
  worker: SyncWorkerLike,
  job: SyncRow,
  signal: AbortSignal,
): Promise<void> {
  const ctx = worker.app.ctx;
  const { pool, schemas } = dataStore(ctx);
  const t = tables(schemas);
  const audit = authDatabase(ctx).audit;
  const runId = job.lease_token!;
  const settings = settingsOf(job);
  const startedMs = worker.clock.now();
  // A run of its own snapshot cache, so it orders the view afresh and never reuses a run before it.
  const snapshots = new SnapshotCache(() => dataStore(ctx), 0, worker.app.log);

  const notes: SyncOutMessage[] = [];
  const stats: SyncOutStats = { created: 0, updated: 0, removed: 0, unchanged: 0, failed: 0, ms: 0 };
  let truncated = 0;
  let firstProblem: { message: SyncOutMessage; scope: 'run' | 'sync' } | null = null;
  const problem = (message: SyncOutMessage, scope: 'run' | 'sync') => {
    if (!firstProblem) firstProblem = { message, scope };
  };

  /** Proves the lease and runs `fn` in one short transaction.  No row means the run was taken over. */
  async function leased<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    return withTransaction(pool, async (db) => {
      const held = await query(
        db,
        sql`SELECT id FROM ${t.syncs} WHERE id = ${job.id} AND lease_token = ${runId} AND enabled FOR UPDATE`,
      );
      if (!held.rows.length) throw new LeaseLost();
      return fn(db);
    });
  }

  // Step 1: start.  One transaction that opens the run and clears what a new run must not inherit.
  const priorReconcile = await withTransaction(pool, async (db) => {
    const held = await query<{ needs_reconcile: boolean }>(
      db,
      sql`SELECT needs_reconcile FROM ${t.syncs} WHERE id = ${job.id} AND lease_token = ${runId} AND enabled FOR UPDATE`,
    );
    if (!held.rows.length) return null;
    await query(
      db,
      sql`UPDATE ${t.runs} SET outcome = 'canceled', ended_at = now()
      WHERE sync_id = ${job.id} AND outcome = 'running' AND id <> ${runId}`,
    );
    const stored = statusOf(job);
    await query(
      db,
      sql`INSERT INTO ${t.runs} (id, sync_id, org_id, trigger, actor_id, outcome)
      VALUES (${runId}, ${job.id}, ${job.org_id}, ${job.queued_trigger ?? 'schedule'}, ${job.queued_by}, 'running')`,
    );
    await query(
      db,
      sql`UPDATE ${t.syncs} SET status = ${JSON.stringify({ ...stored, state: 'running', progress: null })}::jsonb,
      queued_trigger = NULL, queued_by = NULL, queued_again = false, needs_reconcile = true
      WHERE id = ${job.id}`,
    );
    return held.rows[0]!.needs_reconcile;
  });
  if (priorReconcile === null) return;

  const stopSync = async (reason: string): Promise<void> => {
    await leased(async (db) => {
      await query(
        db,
        sql`UPDATE ${t.syncs} SET enabled = false, stopped_because = ${reason}, next_run_at = NULL,
        lease_at = NULL, lease_token = NULL, needs_reconcile = true,
        status = ${JSON.stringify({ ...statusOf(job), state: 'idle', progress: null })}::jsonb, updated_at = now()
        WHERE id = ${job.id}`,
      );
      await query(
        db,
        sql`UPDATE ${t.runs} SET outcome = 'stopped', ended_at = now(), error_key = ${reason}
        WHERE id = ${runId} AND outcome = 'running'`,
      );
      await auditEvent(
        db,
        audit,
        'data.outboundSync.stopped',
        { orgId: job.org_id },
        {
          syncId: job.id,
          databaseId: job.database_id,
          viewId: job.view_id,
          kind: job.kind,
          reason,
        },
      );
    });
    worker.app.log.warn({ syncId: job.id, messageKey: reason }, 'outbound sync stopped');
  };

  async function auditRan(reason: string | null, outcome: string): Promise<void> {
    await withTransaction(pool, (db) =>
      auditEvent(
        db,
        audit,
        'data.outboundSync.ran',
        { orgId: job.org_id, userId: job.queued_by ?? null },
        {
          syncId: job.id,
          databaseId: job.database_id,
          viewId: job.view_id,
          kind: job.kind,
          trigger: job.queued_trigger ?? 'schedule',
          outcome,
          created: stats.created,
          updated: stats.updated,
          removed: stats.removed,
          unchanged: stats.unchanged,
          failed: stats.failed,
          ...(reason ? { messageKey: reason } : {}),
        },
      ),
    );
  }

  let unclean = false;
  let guardTripped = false;

  try {
    // Step 2: access, policy, and the credential, before anything is sent.
    const actor = await actorFor(pool, schemas, job.created_by, job.org_id);
    if (!actor) return await stopSync('syncOut.stopped.creatorGone');
    if (
      !(await policyAllows(
        pool,
        `"${schemas.app}"`,
        { orgId: job.org_id, userId: job.created_by },
        'syncOut',
        'externalSharing',
      ))
    )
      return await stopSync('syncOut.stopped.policy');

    const reading = await syncRead(ctx, snapshots, actor, job.view_id, settings.timeZone);
    if (!reading.ok) {
      if ('stop' in reading) return await stopSync(reading.stop);
      problem(reading.fail, 'run');
      return await finish('failed');
    }
    const adapter = destinationFor(job.kind as DestinationKind);
    if (!adapter) {
      problem({ messageKey: 'syncOut.destination.unknownKind' }, 'sync');
      return await finish('failed');
    }
    const credential = await credentialOf(job, ctx.config.secretKey!, pool).catch(() => null);
    if (!credential) {
      problem({ messageKey: 'credentials.unavailable' }, 'sync');
      return await finish('failed');
    }
    const destination = destinationOf(job);
    const http = worker.context(adapter, destination, credential, signal);
    const limits = adapter.limits;

    const { plans, keyPlan } = buildColumnPlans(reading.fields, reading.read.table.primaryFieldId, {
      timeZone: settings.timeZone,
      locale: settings.locale,
    });
    const fieldsById = new Map(reading.fields.map((field) => [field.id, field]));

    // Column limit, before making anything.
    if (plans.length + 1 > limits.columns) {
      problem(
        {
          messageKey: 'syncOut.airtable.columns',
          params: { count: plans.length + 1, limit: limits.columns },
        },
        'sync',
      );
      return await finish('failed');
    }

    // Step 3: the outside table.
    let outside: OutsideTable | null;
    const stored = destination.table;
    if (!stored.id) {
      // Tables other syncs in this organization already fill, so none of them is ever adopted.
      const takenRows = await query<{ id: string }>(
        pool,
        sql`SELECT destination->'table'->>'id' AS id FROM ${t.syncs}
        WHERE org_id = ${job.org_id} AND id <> ${job.id} AND destination->'table'->>'id' IS NOT NULL`,
      );
      const claim: TableClaim = { syncId: job.id, since: null, taken: takenRows.rows.map((row) => row.id) };
      outside = await adapter.createTable(http, destination, [...plans, keyPlan], claim);
      await leased((db) =>
        query(
          db,
          sql`UPDATE ${t.syncs} SET destination = ${JSON.stringify({
            ...destination,
            table: { ...stored, id: outside!.id, url: outside!.url },
          })}::jsonb WHERE id = ${job.id}`,
        ),
      );
    } else {
      outside = await adapter.describe(http, destination);
      if (!outside) {
        problem({ messageKey: 'syncOut.airtable.gone' }, 'sync');
        return await finish('failed');
      }
    }

    // Step 4: reconcile the columns.
    const priorMapping = mappingOf(job);
    const recon = reconcileColumns({
      plans,
      keyPlan,
      mapping: priorMapping,
      table: outside,
      keyColumnId: job.key_column_id,
      createColumns: settings.createColumns,
      columnNameLength: limits.columnNameLength,
      fit: (plan, column) => adapter.fit(plan, column),
    });
    if (recon.key.action === 'blocked') {
      problem({ messageKey: 'syncOut.target.keyColumn' }, 'sync');
      return await finish('failed');
    }

    let keyColumn: OutsideColumn;
    if (recon.key.action === 'match') keyColumn = recon.key.column;
    else {
      const [made] = await adapter.addColumns(http, destination, outside, [keyPlan]);
      if (!made) {
        problem({ messageKey: 'syncOut.target.keyColumn' }, 'sync');
        return await finish('failed');
      }
      keyColumn = made;
      outside = { ...outside, columns: [...outside.columns, made] };
    }

    // The columns that still need making, added after the ones already there.
    const toCreate = recon.columns.filter(
      (c): c is Extract<ColumnOutcome, { action: 'create' }> => c.action === 'create',
    );
    const createdByField = new Map<string, OutsideColumn>();
    if (toCreate.length) {
      const made = await adapter.addColumns(
        http,
        destination,
        outside,
        toCreate.map((c) => ({ ...c.plan, name: c.name })),
      );
      toCreate.forEach((c, index) => {
        const column = made[index];
        if (column && c.plan.fieldId) createdByField.set(c.plan.fieldId, column);
      });
    }

    // Build the mapping in view order, then the retired fields whose columns are cleared.
    interface Send {
      entry: SyncOutColumn;
      field: StoredField | null;
      write: MappedColumn;
    }
    const sends: Send[] = [];
    for (const outcome of recon.columns) {
      if (outcome.action === 'skip') {
        notes.push({
          messageKey:
            outcome.reason === 'syncOut.skip.readOnly'
              ? 'syncOut.note.columnReadOnly'
              : 'syncOut.note.columnMissing',
          params: { name: outcome.plan.name },
          ...(outcome.plan.fieldId ? { fieldId: outcome.plan.fieldId } : {}),
        });
        continue;
      }
      const column =
        outcome.action === 'match' ? outcome.column : createdByField.get(outcome.plan.fieldId ?? '');
      if (!column) continue;
      const write = outcome.action === 'match' ? outcome.write : 'typed';
      const field = outcome.plan.fieldId ? (fieldsById.get(outcome.plan.fieldId) ?? null) : null;
      sends.push({
        entry: {
          fieldId: outcome.plan.fieldId ?? '',
          fieldName: outcome.plan.name,
          columnId: column.id,
          columnName: column.name,
          columnType: column.type,
          write,
          sent: true,
        },
        field,
        write: { plan: outcome.plan, column, write },
      });
    }
    for (const retired of recon.retired) {
      const priorEntry = priorMapping.find((entry) => entry.columnId === retired.column.id);
      if (priorEntry?.sent !== false)
        notes.push({
          messageKey: 'syncOut.note.cleared',
          params: { name: retired.entry.fieldName },
          fieldId: retired.entry.fieldId,
        });
      sends.push({
        entry: {
          ...retired.entry,
          columnName: retired.column.name,
          columnType: retired.column.type,
          sent: false,
        },
        field: null,
        write: { plan: null, column: retired.column, write: retired.entry.write },
      });
    }

    const mapping = sends.map((send) => send.entry);
    const signature = columnSignature(mapping, keyColumn.id);
    const mappedColumns: MappedColumn[] = sends.map((send) => send.write);
    await leased((db) =>
      query(
        db,
        sql`UPDATE ${t.syncs} SET mapping = ${JSON.stringify(mapping)}::jsonb, key_column_id = ${keyColumn.id}
        WHERE id = ${job.id}`,
      ),
    );

    // Step 5: reconcile the map against the outside rows, when the last run was unclean.
    const dupRemove: Array<{ recordId: string; externalId: string }> = [];
    const adoptable = new Map<string, string>();
    if (priorReconcile) {
      const current = await loadAllMap(pool, t, job.id);
      const seen = new Map<string, string[]>();
      for await (const page of adapter.keys(http, destination, outside, keyColumn)) {
        for (const { externalId, key } of page) {
          if (!RECORD_ID.test(key)) continue;
          const list = seen.get(key) ?? [];
          list.push(externalId);
          seen.set(key, list);
        }
      }
      const updates: Array<{ recordId: string; externalId: string | null; sentHash: string | null }> = [];
      for (const [recordId, externals] of seen) {
        const existing = current.get(recordId);
        if (existing?.externalId && externals.includes(existing.externalId)) {
          for (const extra of externals.filter((id) => id !== existing.externalId))
            dupRemove.push({ recordId, externalId: extra });
        } else if (existing) {
          // The record is Riosoma's but its row moved; take the first and send it again.
          updates.push({ recordId, externalId: externals[0]!, sentHash: null });
          for (const extra of externals.slice(1)) dupRemove.push({ recordId, externalId: extra });
        } else {
          // A keyed row for a record the map doesn't know.  Adopt it only if the view shows it.
          adoptable.set(recordId, externals[0]!);
        }
      }
      // A row the map points to that no outside row still has was deleted there, so make it again.
      for (const [recordId, entry] of current)
        if (entry.externalId && !seen.has(recordId))
          updates.push({ recordId, externalId: null, sentHash: null });
      if (updates.length)
        await leased((db) =>
          writeMap(
            db,
            t,
            job.id,
            updates.map((u) => ({ ...u, seenRun: null })),
          ),
        );
    }

    // Step 6: page the view and send what changed.
    const order = snapshotOrder(
      { pool, schemas, read: reading.read },
      (await snapshots.get(reading.read)).snapshot,
    );
    const total = order.total;
    if (total > limits.rows) {
      problem({ messageKey: 'syncOut.airtable.rows', params: { count: total, limit: limits.rows } }, 'run');
      return await finish('failed');
    }
    if (limits.cells !== null && total * (mapping.length + 1) > limits.cells) {
      problem(
        {
          messageKey: 'syncOut.airtable.cells',
          params: { count: total * (mapping.length + 1), limit: limits.cells },
        },
        'run',
      );
      return await finish('failed');
    }

    const pageFields = withButtonSources(reading.fields, reading.read.fields);
    let done = 0;
    let stoppedWriting = false;
    for (let offset = 0; offset < total && !stoppedWriting; offset += EXPORT_PAGE) {
      if (signal.aborted) {
        stoppedWriting = true;
        break;
      }
      const rows = (await order.page(offset, EXPORT_PAGE, pageFields)).filter(
        (row): row is NonNullable<typeof row> => row !== null,
      );
      if (!rows.length) continue;
      const relations = await relationContext({
        db: pool,
        schemas,
        table: reading.read.table,
        scope: reading.scope,
        fields: pageFields,
        rows,
        names: true,
      });
      const fmtCtx = { locale: settings.locale, timeZone: settings.timeZone, ...relations };
      const recordIds = rows.map((row) => row.id);
      const mapRows = await loadMap(pool, t, job.id, recordIds);
      for (const recordId of recordIds) {
        if (!mapRows.has(recordId) && adoptable.has(recordId)) {
          mapRows.set(recordId, { externalId: adoptable.get(recordId)!, sentHash: null });
        }
      }

      const creates: Array<{ recordId: string; cells: OutboundCell[]; hash: string }> = [];
      const updates: Array<{ recordId: string; externalId: string; cells: OutboundCell[]; hash: string }> =
        [];
      const unchangedIds: string[] = [];
      for (const row of rows) {
        const cells = sends.map((send) => {
          if (!send.field) return EMPTY_CELL;
          const cell = cellForField(send.field, row, fieldsById, fmtCtx);
          const trimmed = cutText(cell.text, limits.cellCharacters);
          if (trimmed.cut) {
            truncated += 1;
            return { ...cell, text: trimmed.text };
          }
          return cell;
        });
        const hash = hashRow(signature, cells);
        const existing = mapRows.get(row.id);
        if (!existing?.externalId) creates.push({ recordId: row.id, cells, hash });
        else if (existing.sentHash !== hash)
          updates.push({ recordId: row.id, externalId: existing.externalId, cells, hash });
        else unchangedIds.push(row.id);
      }

      try {
        await sendBatches(
          creates.map((c) => ({ ...c, externalId: undefined })),
          'create',
        );
        await sendBatches(updates, 'update');
      } catch (error) {
        stoppedWriting = true;
        if (error instanceof DestinationError) {
          problem(
            {
              messageKey: error.problem.messageKey,
              ...(error.problem.params ? { params: error.problem.params } : {}),
            },
            error.problem.scope === 'sync' ? 'sync' : 'run',
          );
          if (error.unconfirmed) unclean = true;
        } else {
          unclean = true;
          throw error;
        }
      }

      if (unchangedIds.length) {
        stats.unchanged += unchangedIds.length;
        await leased((db) => stampSeen(db, t, job.id, unchangedIds, runId));
      }
      done += rows.length;
      await leased((db) =>
        query(
          db,
          sql`UPDATE ${t.syncs} SET status = ${JSON.stringify({ ...statusOf(job), state: 'running', progress: { done, total } })}::jsonb WHERE id = ${job.id}`,
        ),
      );
    }

    const readEveryPage = !stoppedWriting && !signal.aborted;
    if (signal.aborted) {
      problem({ messageKey: 'syncOut.run.timeout' }, 'run');
      unclean = true;
    }

    // Step 7: remove what left, only after a full pass.
    if (readEveryPage) {
      for (const dup of dupRemove) await removeOne(dup);
      if (stats.removed > 0 && dupRemove.length)
        notes.push({ messageKey: 'syncOut.note.duplicates', params: { count: dupRemove.length } });

      const removeMissing = (
        await leased((db) =>
          query<{ settings: OutboundSyncSettings }>(
            db,
            sql`SELECT settings FROM ${t.syncs} WHERE id = ${job.id}`,
          ),
        )
      ).rows[0]?.settings.removeMissing;
      if (removeMissing) {
        const counts = await removalCounts(pool, t, job.id, runId);
        if (counts.removable > 20 && counts.removable * 2 > counts.tracked) {
          guardTripped = true;
          problem({ messageKey: 'syncOut.removal.tooMany', params: { count: counts.removable } }, 'run');
        } else {
          await removeMissingRows(adapter, http, destination, outside, keyColumn, mappedColumns);
        }
      }
    }

    // The truncation note carries how many values were cut.
    if (truncated) notes.push({ messageKey: 'syncOut.note.truncated', params: { count: truncated } });

    // A problem with the whole run or the whole sync that stopped the writing fails the run.  A
    // run that read every page with only row failures, or that ran out of time, is partial.
    const outcome = signal.aborted
      ? 'partial'
      : stoppedWriting && firstProblem
        ? 'failed'
        : guardTripped || stats.failed > 0
          ? 'partial'
          : 'succeeded';
    await finish(outcome, reading.withheld);
    return;

    // --- helpers that close over the run's state ---

    async function sendBatches(
      rows: Array<{ recordId: string; cells: OutboundCell[]; hash: string; externalId?: string }>,
      op: 'create' | 'update',
    ): Promise<void> {
      for (let i = 0; i < rows.length; i += limits.writeBatch) {
        const chunk = rows.slice(i, i + limits.writeBatch);
        const batch =
          op === 'create'
            ? { op: 'create' as const, rows: chunk.map((r) => ({ recordId: r.recordId, cells: r.cells })) }
            : {
                op: 'update' as const,
                rows: chunk.map((r) => ({ recordId: r.recordId, cells: r.cells, externalId: r.externalId! })),
              };
        const results = await adapter!.apply(http, destination, outside!, keyColumn, mappedColumns, batch);
        await applyResults(chunk, results);
      }
    }

    async function applyResults(
      chunk: Array<{ recordId: string; hash: string; externalId?: string }>,
      results: readonly RowResult[],
    ): Promise<void> {
      const byRecord = new Map(results.map((result) => [result.recordId, result]));
      const writes: Array<{
        recordId: string;
        externalId: string | null;
        sentHash: string | null;
        seenRun: string | null;
      }> = [];
      for (const row of chunk) {
        const result = byRecord.get(row.recordId);
        if (!result) continue;
        if (result.outcome === 'created' || result.outcome === 'updated') {
          if (result.outcome === 'created') stats.created += 1;
          else stats.updated += 1;
          writes.push({
            recordId: row.recordId,
            externalId: result.externalId,
            sentHash: row.hash,
            seenRun: runId,
          });
        } else if (result.outcome === 'gone') {
          // The outside row an update named is gone, so clear the map and the next run makes it again.
          writes.push({ recordId: row.recordId, externalId: null, sentHash: null, seenRun: runId });
        } else if (result.outcome === 'failed') {
          stats.failed += 1;
          problem(
            {
              messageKey: result.problem.messageKey,
              ...(result.problem.params ? { params: result.problem.params } : {}),
            },
            'run',
          );
          // A refused row is kept from removal but doesn't make the run unclean.
          writes.push({
            recordId: row.recordId,
            externalId: row.externalId ?? null,
            sentHash: null,
            seenRun: runId,
          });
        }
      }
      if (writes.length) await leased((db) => writeMap(db, t, job.id, writes));
    }

    async function removeOne(row: { recordId: string; externalId: string }): Promise<void> {
      const results = await adapter!.apply(http, destination, outside!, keyColumn, mappedColumns, {
        op: 'remove',
        rows: [row],
      });
      const result = results[0];
      if (result && (result.outcome === 'removed' || result.outcome === 'gone')) {
        stats.removed += result.outcome === 'removed' ? 1 : 0;
        await leased((db) =>
          query(db, sql`DELETE FROM ${t.rows} WHERE sync_id = ${job.id} AND record_id = ${row.recordId}`),
        );
      }
    }

    async function removeMissingRows(
      adapterArg: DestinationAdapter,
      httpArg: DestinationContext,
      destinationArg: ReturnType<typeof destinationOf>,
      outsideArg: OutsideTable,
      keyArg: OutsideColumn,
      columnsArg: MappedColumn[],
    ): Promise<void> {
      for (;;) {
        const batch = await query<{ record_id: string; external_id: string | null }>(
          pool,
          sql`SELECT record_id, external_id FROM ${t.rows}
          WHERE sync_id = ${job.id} AND seen_run IS DISTINCT FROM ${runId}
          ORDER BY record_id LIMIT ${adapterArg.limits.removeBatch}`,
        );
        if (!batch.rows.length) break;
        const withId = batch.rows.filter((row) => row.external_id);
        const withoutId = batch.rows.filter((row) => !row.external_id);
        if (withoutId.length)
          await leased((db) =>
            query(
              db,
              sql`DELETE FROM ${t.rows} WHERE sync_id = ${job.id} AND record_id = ANY(${withoutId.map((r) => r.record_id)}::text[])`,
            ),
          );
        if (!withId.length) continue;
        const results = await adapterArg.apply(httpArg, destinationArg, outsideArg, keyArg, columnsArg, {
          op: 'remove',
          rows: withId.map((row) => ({ recordId: row.record_id, externalId: row.external_id! })),
        });
        const removed: string[] = [];
        const failed: string[] = [];
        for (const result of results) {
          if (result.outcome === 'removed' || result.outcome === 'gone') {
            if (result.outcome === 'removed') stats.removed += 1;
            removed.push(result.recordId);
          } else if (result.outcome === 'failed') {
            stats.failed += 1;
            failed.push(result.recordId);
            problem(
              {
                messageKey: result.problem.messageKey,
                ...(result.problem.params ? { params: result.problem.params } : {}),
              },
              'run',
            );
          }
        }
        if (removed.length)
          await leased((db) =>
            query(
              db,
              sql`DELETE FROM ${t.rows} WHERE sync_id = ${job.id} AND record_id = ANY(${removed}::text[])`,
            ),
          );
        if (failed.length) await leased((db) => stampSeen(db, t, job.id, failed, runId));
      }
    }
  } catch (error) {
    if (error instanceof LeaseLost) return;
    if (error instanceof DestinationError) {
      problem(
        {
          messageKey: error.problem.messageKey,
          ...(error.problem.params ? { params: error.problem.params } : {}),
        },
        error.problem.scope === 'sync' ? 'sync' : 'run',
      );
      if (error.unconfirmed) unclean = true;
    } else {
      problem({ messageKey: 'syncOut.run.failed' }, 'run');
      worker.app.log.error({ syncId: job.id, runId, err: String(error) }, 'outbound sync run failed');
    }
    await finish('failed').catch(() => undefined);
  } finally {
    // A last resort: if finish never ran, clear the lease and fail the run row so it isn't re-claimed.
    await withTransaction(pool, async (db) => {
      const held = await query(
        db,
        sql`SELECT 1 FROM ${t.syncs} WHERE id = ${job.id} AND lease_token = ${runId}`,
      );
      if (!held.rows.length) return;
      const nextRunAt = settings.everyMinutes
        ? sql`now() + ${settings.everyMinutes} * interval '1 minute'`
        : sql`NULL`;
      await query(
        db,
        sql`UPDATE ${t.syncs} SET lease_at = NULL, lease_token = NULL, next_run_at = ${nextRunAt}, queued_trigger = NULL,
        status = jsonb_set(status, '{state}', '"failed"'), updated_at = now() WHERE id = ${job.id} AND lease_token = ${runId}`,
      );
      await query(
        db,
        sql`UPDATE ${t.runs} SET outcome = 'failed', ended_at = now(), error_key = 'syncOut.run.failed'
        WHERE id = ${runId} AND outcome = 'running'`,
      );
    }).catch(() => undefined);
  }

  async function finish(outcome: string, withheld: SyncOutWithheldField[] = []): Promise<void> {
    stats.ms = Math.max(0, worker.clock.now() - startedMs);
    const succeeded = outcome === 'succeeded';
    const state = outcome === 'failed' ? 'failed' : 'idle';
    const nowIso = new Date().toISOString();
    const error = firstProblem?.message ?? null;
    const everyMinutes = settings.everyMinutes;
    await leased(async (db) => {
      const queuedAgain = (
        await query<{ queued_again: boolean }>(
          db,
          sql`SELECT queued_again FROM ${t.syncs} WHERE id = ${job.id}`,
        )
      ).rows[0];
      const nextRunAt = queuedAgain?.queued_again
        ? sql`now()`
        : everyMinutes
          ? sql`now() + ${everyMinutes} * interval '1 minute'`
          : sql`NULL`;
      const nextTrigger = queuedAgain?.queued_again ? sql`'manual'` : sql`NULL`;
      const status = {
        ...statusOf(job),
        state,
        lastRunAt: nowIso,
        lastSuccessAt: succeeded || outcome === 'partial' ? nowIso : statusOf(job).lastSuccessAt,
        error: outcome === 'succeeded' ? null : error,
        stats: { ...stats },
        progress: null,
        withheld,
      };
      await query(
        db,
        sql`UPDATE ${t.syncs} SET status = ${JSON.stringify(status)}::jsonb,
        failures = ${succeeded ? 0 : job.failures + 1}, needs_reconcile = ${unclean},
        next_run_at = ${nextRunAt}, queued_trigger = ${nextTrigger},
        lease_at = NULL, lease_token = NULL, updated_at = now()
        WHERE id = ${job.id}`,
      );
      await query(
        db,
        sql`UPDATE ${t.runs} SET outcome = ${outcome}, ended_at = now(), stats = ${JSON.stringify(stats)}::jsonb,
        error_key = ${error?.messageKey ?? null}, error_params = ${error?.params ? JSON.stringify(error.params) : null},
        notes = ${JSON.stringify(notes)}::jsonb
        WHERE id = ${runId} AND outcome = 'running'`,
      );
      await query(
        db,
        sql`DELETE FROM ${t.runs} WHERE sync_id = ${job.id} AND outcome <> 'running'
        AND seq <= (SELECT seq FROM ${t.runs} WHERE sync_id = ${job.id} ORDER BY seq DESC OFFSET ${SYNC_OUT_LIMITS.runsKept} LIMIT 1)`,
      );
    });
    await auditRan(error?.messageKey ?? null, outcome);
    worker.app.log.info(
      {
        syncId: job.id,
        runId,
        outcome,
        created: stats.created,
        updated: stats.updated,
        removed: stats.removed,
      },
      'outbound sync finished',
    );
  }
}

// --- small data helpers ---

interface MapEntry {
  externalId: string | null;
  sentHash: string | null;
}

async function loadMap(
  db: Queryable,
  t: ReturnType<typeof tables>,
  syncId: string,
  recordIds: readonly string[],
): Promise<Map<string, MapEntry>> {
  if (!recordIds.length) return new Map();
  const result = await query<{ record_id: string; external_id: string | null; sent_hash: string | null }>(
    db,
    sql`SELECT record_id, external_id, sent_hash FROM ${t.rows} WHERE sync_id = ${syncId} AND record_id = ANY(${recordIds}::text[])`,
  );
  return new Map(
    result.rows.map((row) => [row.record_id, { externalId: row.external_id, sentHash: row.sent_hash }]),
  );
}

async function loadAllMap(
  db: Queryable,
  t: ReturnType<typeof tables>,
  syncId: string,
): Promise<Map<string, MapEntry>> {
  const result = await query<{ record_id: string; external_id: string | null; sent_hash: string | null }>(
    db,
    sql`SELECT record_id, external_id, sent_hash FROM ${t.rows} WHERE sync_id = ${syncId}`,
  );
  return new Map(
    result.rows.map((row) => [row.record_id, { externalId: row.external_id, sentHash: row.sent_hash }]),
  );
}

async function writeMap(
  db: Queryable,
  t: ReturnType<typeof tables>,
  syncId: string,
  rows: ReadonlyArray<{
    recordId: string;
    externalId: string | null;
    sentHash: string | null;
    seenRun: string | null;
  }>,
): Promise<void> {
  if (!rows.length) return;
  await query(
    db,
    sql`INSERT INTO ${t.rows} (sync_id, record_id, external_id, sent_hash, seen_run, updated_at)
    SELECT ${syncId}, r.record_id, r.external_id, r.sent_hash, r.seen_run, now()
    FROM unnest(${rows.map((r) => r.recordId)}::text[], ${rows.map((r) => r.externalId)}::text[],
      ${rows.map((r) => r.sentHash)}::text[], ${rows.map((r) => r.seenRun)}::text[])
      AS r(record_id, external_id, sent_hash, seen_run)
    ON CONFLICT (sync_id, record_id) DO UPDATE SET external_id = EXCLUDED.external_id,
      sent_hash = EXCLUDED.sent_hash, seen_run = COALESCE(EXCLUDED.seen_run, ${t.rows}.seen_run), updated_at = now()`,
  );
}

async function stampSeen(
  db: Queryable,
  t: ReturnType<typeof tables>,
  syncId: string,
  recordIds: readonly string[],
  run: string,
): Promise<void> {
  if (!recordIds.length) return;
  await query(
    db,
    sql`UPDATE ${t.rows} SET seen_run = ${run} WHERE sync_id = ${syncId} AND record_id = ANY(${recordIds}::text[])`,
  );
}

async function removalCounts(
  db: Queryable,
  t: ReturnType<typeof tables>,
  syncId: string,
  run: string,
): Promise<{ tracked: number; removable: number }> {
  const result = await query<{ tracked: number; removable: number }>(
    db,
    sql`SELECT count(*) FILTER (WHERE external_id IS NOT NULL)::int AS tracked,
      count(*) FILTER (WHERE external_id IS NOT NULL AND seen_run IS DISTINCT FROM ${run})::int AS removable
    FROM ${t.rows} WHERE sync_id = ${syncId}`,
  );
  return { tracked: result.rows[0]?.tracked ?? 0, removable: result.rows[0]?.removable ?? 0 };
}
