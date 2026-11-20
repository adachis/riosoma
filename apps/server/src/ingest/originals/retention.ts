import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  AppError,
  IngestOrganizationSettings,
  type IngestFile,
  type IngestRetentionResult,
} from '@riosoma/contracts';
import { compile, ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app.js';
import { auditEvent } from '../../auth/database.js';
import { dataStore, type DataSchemas } from '../../data/context.js';
import { deleteOriginal } from '../../data/files/originals.js';
import { fileStorage, type StorageKind } from '../../data/files/storage.js';
import { IngestTableStore } from '../tables/store.js';

export type KeepDays = number | 'forever';
export const ORIGINAL_BATCH_SIZE = 100;

export async function organizationIngest(db: Queryable, schemas: DataSchemas, orgId: string) {
  const result = await query<{ settings: { ingest?: unknown } }>(
    db,
    sql`SELECT settings FROM ${ident(schemas.app, 'orgs')} WHERE id = ${orgId}`,
  );
  return IngestOrganizationSettings.parse(result.rows[0]?.settings.ingest ?? {});
}

export async function lockDatabase(db: Queryable, schemas: DataSchemas, databaseId: string) {
  await query(
    db,
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:database:${databaseId}`}, 0))`,
  );
}

/** The queue commits with the deleted metadata, so failed outside deletes remain retryable. */
export async function expireOriginal(db: Queryable, schemas: DataSchemas, file: IngestFile) {
  const removed = await deleteOriginal(db, schemas.app, file);
  if (!removed) return null;
  await query(
    db,
    sql`UPDATE ${ident(schemas.app, 'ingest_files')}
    SET original_expired_at = clock_timestamp(),
      notes = notes || '[{"messageId":"ingest.pipeline.originalExpired"}]'::jsonb
    WHERE org_id = ${file.orgId} AND table_id = ${file.tableId} AND id = ${file.id}`,
  );
  if (removed.storage !== 'postgres')
    await query(
      db,
      sql`INSERT INTO ${ident(schemas.app, 'ingest_original_deletions')}
      (id, org_id, storage, storage_key, size_bytes)
      VALUES (${removed.id}, ${file.orgId}, ${removed.storage}, ${removed.storage_key}, ${removed.size})`,
    );
  return removed;
}

/** Only committed queue entries can reach storage.  Locks prevent two runners deleting one key. */
export async function drainOriginalDeletions(
  ctx: AppContext,
  onFreed?: (orgId: string, bytes: number) => void,
): Promise<number> {
  const { pool, schemas } = dataStore(ctx);
  const result = await withTransaction(pool, async (db) => {
    const pending = await query<{
      id: string;
      org_id: string;
      storage: StorageKind;
      storage_key: string;
      size_bytes: string;
    }>(
      db,
      sql`SELECT * FROM ${ident(schemas.app, 'ingest_original_deletions')}
      WHERE retry_at <= clock_timestamp() ORDER BY retry_at, id
      LIMIT ${ORIGINAL_BATCH_SIZE} FOR UPDATE SKIP LOCKED`,
    );
    let freed = 0;
    const organizations = new Map<string, number>();
    for (const row of pending.rows) {
      try {
        await fileStorage(row.storage, pool, schemas.app, ctx.config).delete(row.storage_key);
        await query(
          db,
          sql`DELETE FROM ${ident(schemas.app, 'ingest_original_deletions')} WHERE id = ${row.id}`,
        );
        freed += Number(row.size_bytes);
        organizations.set(row.org_id, (organizations.get(row.org_id) ?? 0) + Number(row.size_bytes));
      } catch {
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'ingest_original_deletions')}
          SET attempts = attempts + 1, retry_at = clock_timestamp() + interval '1 hour' WHERE id = ${row.id}`,
        );
      }
    }
    return { freed, organizations };
  });
  for (const [orgId, bytes] of result.organizations) onFreed?.(orgId, bytes);
  return result.freed;
}

interface PeriodTable {
  id: string;
  database_id: string;
  keepDays: KeepDays;
}
export async function retentionPreview(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  tables: PeriodTable[],
) {
  let originals = 0;
  let bytes = 0;
  let examples = 0;
  const fingerprints: unknown[] = [];
  for (const table of tables) {
    const result = await query<{
      originals: string;
      bytes: string;
      examples: string;
      fingerprint: string;
      legal_hold: boolean;
    }>(
      db,
      sql`SELECT d.legal_hold,
        count(*) FILTER (WHERE f.stored_file IS NOT NULL AND NOT f.is_example AND NOT d.legal_hold
          AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'ingest_drafts')} draft
            WHERE draft.org_id = f.org_id AND draft.table_id = f.table_id AND draft.file_id = f.id AND draft.state IN ('drafting', 'ready', 'failed'))
          AND ${table.keepDays === 'forever' ? sql`false` : sql`f.received_at + ${table.keepDays} * interval '24 hours' <= clock_timestamp()`}) AS originals,
        COALESCE(sum(o.size) FILTER (WHERE NOT f.is_example AND NOT d.legal_hold
          AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'ingest_drafts')} draft
            WHERE draft.org_id = f.org_id AND draft.table_id = f.table_id AND draft.file_id = f.id AND draft.state IN ('drafting', 'ready', 'failed'))
          AND ${table.keepDays === 'forever' ? sql`false` : sql`f.received_at + ${table.keepDays} * interval '24 hours' <= clock_timestamp()`}), 0) AS bytes,
        count(*) FILTER (WHERE f.is_example AND f.stored_file IS NOT NULL) AS examples,
        md5(COALESCE(string_agg(jsonb_build_array(f.id, f.received_at, f.stored_file, f.is_example, o.size)::text,
          '' ORDER BY f.id), '')) AS fingerprint
      FROM ${ident(schemas.app, 'databases')} d
      LEFT JOIN ${ident(schemas.app, 'ingest_files')} f ON f.table_id = ${table.id} AND f.org_id = d.org_id
      LEFT JOIN ${ident(schemas.app, 'files')} o ON o.id = f.stored_file AND o.ingest_file_id = f.id
      WHERE d.id = ${table.database_id} AND d.org_id = ${orgId} GROUP BY d.legal_hold`,
    );
    const row = result.rows[0]!;
    originals += Number(row.originals);
    bytes += Number(row.bytes);
    examples += Number(row.examples);
    fingerprints.push([table, row]);
  }
  return { originals, bytes, examples, fingerprints };
}

export function confirmRetention(
  key: Buffer,
  binding: unknown,
  preview: Awaited<ReturnType<typeof retentionPreview>>,
  token?: string,
): IngestRetentionResult | null {
  if (!preview.originals) return null;
  const stamp = (expires: number) =>
    createHmac('sha256', key)
      .update(JSON.stringify(['ingest.originals.retention', binding, preview, expires]))
      .digest('hex');
  const [until, signature] = token?.split('.') ?? [];
  const expires = Number(until);
  if (
    signature &&
    /^[a-f0-9]{64}$/.test(signature) &&
    expires > Date.now() &&
    expires <= Date.now() + 10 * 60_000 &&
    timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(stamp(expires), 'hex'))
  )
    return null;
  const deadline = Date.now() + 10 * 60_000;
  return {
    status: 'confirmation-required',
    originals: preview.originals,
    bytes: preview.bytes,
    examples: preview.examples,
    confirmationToken: `${deadline}.${stamp(deadline)}`,
  };
}

export async function applyPeriods(ctx: AppContext, db: Queryable, orgId: string, tables: PeriodTable[]) {
  const { pool, schemas } = dataStore(ctx);
  const store = new IngestTableStore(pool, schemas).inTransaction(db);
  for (const table of tables) {
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'ingest_files')} SET expires_at = CASE WHEN is_example OR EXISTS (
        SELECT 1 FROM ${ident(schemas.app, 'ingest_drafts')} draft WHERE draft.org_id = ${orgId} AND draft.table_id = ${table.id}
          AND draft.file_id = ${ident(schemas.app, 'ingest_files')}.id AND draft.state IN ('drafting', 'ready', 'failed')) THEN NULL
        ELSE ${table.keepDays === 'forever' ? sql`NULL` : sql`received_at + ${table.keepDays} * interval '24 hours'`} END
      WHERE org_id = ${orgId} AND table_id = ${table.id} AND original_expired_at IS NULL`,
    );
    const hold = await query<{ legal_hold: boolean }>(
      db,
      sql`SELECT legal_hold FROM ${ident(schemas.app, 'databases')} WHERE id = ${table.database_id}`,
    );
    if (hold.rows[0]?.legal_hold) continue;
    for (;;) {
      const expired = await query<{ id: string }>(
        db,
        sql`SELECT id FROM ${ident(schemas.app, 'ingest_files')}
        WHERE org_id = ${orgId} AND table_id = ${table.id} AND NOT is_example
          AND stored_file IS NOT NULL AND expires_at <= clock_timestamp()
        ORDER BY expires_at, id LIMIT ${ORIGINAL_BATCH_SIZE} FOR UPDATE`,
      );
      for (const { id } of expired.rows) {
        const file = await store.readFile({ orgId, tableId: table.id }, id);
        if (file) await expireOriginal(db, schemas, file);
      }
      if (expired.rows.length < ORIGINAL_BATCH_SIZE) break;
    }
  }
}

export async function sweepOriginals(ctx: AppContext, batchSize = ORIGINAL_BATCH_SIZE) {
  if (!ctx.pool || !ctx.config.database) return { originals: 0, bytes: 0 };
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > ORIGINAL_BATCH_SIZE)
    throw new AppError('validation_failed', 'errors.validationFailed');
  const { pool, schemas } = dataStore(ctx);
  const store = new IngestTableStore(pool, schemas);
  const totals = new Map<string, { originals: number; bytes: number; bytesFreed: number }>();
  const freed = (orgId: string, bytes: number) => {
    const total = totals.get(orgId) ?? { originals: 0, bytes: 0, bytesFreed: 0 };
    total.bytesFreed += bytes;
    totals.set(orgId, total);
  };
  try {
    const databases = await query<{ id: string; org_id: string }>(
      pool,
      sql`SELECT id, org_id FROM ${ident(schemas.app, 'databases')} WHERE NOT legal_hold ORDER BY id`,
    );
    for (const database of databases.rows) {
      for (;;) {
        const count = await withTransaction(pool, async (db) => {
          await lockDatabase(db, schemas, database.id);
          const held = await query<{ legal_hold: boolean }>(
            db,
            sql`SELECT legal_hold FROM ${ident(schemas.app, 'databases')} WHERE id = ${database.id} FOR SHARE`,
          );
          if (!held.rows[0] || held.rows[0].legal_hold) return 0;
          const found = await query<{ id: string; table_id: string }>(
            db,
            sql`SELECT f.id, f.table_id FROM ${ident(schemas.app, 'ingest_files')} f
            JOIN ${ident(schemas.app, 'tables')} t ON t.id = f.table_id AND t.org_id = f.org_id
            WHERE t.database_id = ${database.id} AND NOT f.is_example AND f.stored_file IS NOT NULL
              AND f.expires_at <= clock_timestamp()
            ORDER BY f.expires_at, f.id LIMIT ${batchSize} FOR UPDATE OF f SKIP LOCKED`,
          );
          let bytes = 0;
          let bytesFreed = 0;
          let removed = 0;
          for (const row of found.rows) {
            const file = await store
              .inTransaction(db)
              .readFile({ orgId: database.org_id, tableId: row.table_id }, row.id);
            const original = file && (await expireOriginal(db, schemas, file));
            if (original) {
              removed++;
              bytes += Number(original.size);
              if (original.storage === 'postgres') bytesFreed += Number(original.size);
            }
          }
          return { removed, bytes, bytesFreed };
        });
        if (count === 0) break;
        const total = totals.get(database.org_id) ?? { originals: 0, bytes: 0, bytesFreed: 0 };
        total.originals += count.removed;
        total.bytes += count.bytes;
        total.bytesFreed += count.bytesFreed;
        totals.set(database.org_id, total);
        await drainOriginalDeletions(ctx, freed);
        if (count.removed < batchSize) break;
      }
    }
    await drainOriginalDeletions(ctx, freed);
  } finally {
    for (const [orgId, total] of totals)
      if (total.originals || total.bytesFreed)
        await auditEvent(
          pool,
          compile(sql`${ident(schemas.audit)}`).text,
          'data.ingest.originals.swept',
          { orgId, userId: null },
          {
            originals: total.originals,
            bytes: total.bytesFreed,
            removedBytes: total.bytes,
            pendingBytes: Math.max(0, total.bytes - total.bytesFreed),
          },
        );
  }
  return [...totals.values()].reduce(
    (a, b) => ({ originals: a.originals + b.originals, bytes: a.bytes + b.bytes }),
    { originals: 0, bytes: 0 },
  );
}

export function installOriginalSweep(app: FastifyInstance) {
  let running: Promise<unknown> | undefined;
  let timer: NodeJS.Timeout | undefined;
  app.addHook('onReady', async () => {
    timer = setInterval(() => {
      if (running) return;
      running = sweepOriginals(app.ctx)
        .catch((error: unknown) => {
          app.log.warn({ err: error }, 'original retention sweep failed');
        })
        .finally(() => {
          running = undefined;
        });
    }, 60 * 60_000);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await running;
  });
}
