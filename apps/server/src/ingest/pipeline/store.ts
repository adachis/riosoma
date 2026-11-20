import type { StoredTable } from '../../data/types.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AppError, type IngestFile } from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import { dataStore } from '../../data/context.js';
import { loadTable } from '../../data/metadata.js';
import { notify } from '../../notifications/produce.js';
import { IngestTableStore, type IngestContext, type IngestFilePatch } from '../tables/store.js';
import { DecisionStore } from '../decisions/store.js';
import type { IngestClaim, PipelineJob, PipelineReading } from './types.js';
import { organizationIngest } from '../originals/retention.js';

export const INGEST_FILES_PER_HOUR = 60;
export const INGEST_PART_LIMIT = 25;
export const INGEST_CONCURRENCY = 2;
export const INGEST_LEASE_MS = 5 * 60_000;
export class LeaseLost extends Error {}
export const backoff = (attempts: number) => Math.min(60 * 60_000, 1_000 * 2 ** Math.min(attempts, 12));

export class PipelineStore {
  constructor(readonly app: FastifyInstance) {}
  get data() {
    return dataStore(this.app.ctx);
  }
  get tables() {
    return new IngestTableStore(this.data.pool, this.data.schemas);
  }
  get decisions() {
    return new DecisionStore(this.data.pool, this.data.schemas);
  }
  async job(db: Queryable, file: IngestFile): Promise<PipelineJob> {
    const { schemas } = this.data;
    const result = await query<PipelineJob>(
      db,
      sql`INSERT INTO ${ident(schemas.app, 'ingest_pipeline_jobs')}
      (org_id, table_id, file_id, run_id) VALUES (${file.orgId}, ${file.tableId}, ${file.id}, ${randomUUID()})
      ON CONFLICT (org_id, table_id, file_id) DO UPDATE SET file_id = EXCLUDED.file_id RETURNING *`,
    );
    return result.rows[0]!;
  }
  async locked<T>(
    context: IngestContext,
    work: (db: Queryable, table: StoredTable) => Promise<T>,
  ): Promise<T> {
    const { pool, schemas } = this.data;
    return withTransaction(pool, async (db) => {
      const before = await loadTable(db, schemas, context.tableId);
      if (!before || before.orgId !== context.orgId) throw new AppError('not_found', 'errors.notFound');
      await query(
        db,
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:database:${before.databaseId}`}, 0))`,
      );
      await query(
        db,
        sql`SELECT id FROM ${ident(schemas.app, 'tables')} WHERE org_id = ${context.orgId} AND id = ${context.tableId} FOR UPDATE`,
      );
      const table = await loadTable(db, schemas, context.tableId);
      if (!table || table.trashed) throw new AppError('not_found', 'errors.notFound');
      return work(db, table);
    });
  }
  async fenced<T>(
    claim: IngestClaim,
    work: (db: Queryable, file: IngestFile, table: StoredTable) => Promise<T>,
  ): Promise<T> {
    return this.locked(claim.file, async (db, table) => {
      const { schemas } = this.data;
      const owned = await query(
        db,
        sql`SELECT id FROM ${ident(schemas.app, 'ingest_files')}
        WHERE org_id = ${claim.file.orgId} AND table_id = ${claim.file.tableId} AND id = ${claim.file.id}
          AND state = 'reading' AND leased_by = ${claim.token} AND lease_until > clock_timestamp() FOR UPDATE`,
      );
      if (!owned.rowCount) throw new LeaseLost();
      const file = (await this.tables.inTransaction(db).readFile(claim.file, claim.file.id))!;
      const result = await work(db, file, table);
      const stillTimely = await query<{ owned: boolean }>(
        db,
        sql`SELECT ${file.leaseUntil}::timestamptz > clock_timestamp() AS owned`,
      );
      if (!stillTimely.rows[0]?.owned) throw new LeaseLost();
      return result;
    });
  }
  async saveJob(db: Queryable, claim: IngestClaim): Promise<void> {
    const { schemas } = this.data;
    const job = claim.job;
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'ingest_pipeline_jobs')} SET
      prepared = ${JSON.stringify(job.prepared)}::jsonb, question_ids = ${JSON.stringify(job.question_ids)}::jsonb,
      notified_questions = ${JSON.stringify(job.notified_questions)}::jsonb, notified = ${job.notified},
      attempts = ${JSON.stringify(job.attempts)}::jsonb, parts_created = ${job.parts_created}
      WHERE org_id = ${job.org_id} AND table_id = ${job.table_id} AND file_id = ${job.file_id}`,
    );
  }
  async report(db: Queryable, table: StoredTable, file: IngestFile, job: PipelineJob): Promise<void> {
    if (job.notified || !table.ingest?.ownerId || !['held', 'read', 'failed'].includes(file.state)) return;
    await notify(db, this.data.schemas, {
      orgId: file.orgId,
      recipientId: table.ingest.ownerId,
      actorId: null,
      subjectId: file.id,
      kind: file.state === 'read' ? 'ingest.file.read' : 'ingest.file.held',
      target: {
        databaseId: table.databaseId,
        tableId: table.id,
        tableName: table.name,
        ingestCounts: file.counts,
        ...(file.holdReason ? { reason: { messageKey: file.holdReason } } : {}),
      },
    });
    job.notified = true;
  }
  async finish(claim: IngestClaim, patch: IngestFilePatch): Promise<void> {
    await this.fenced(claim, async (db, file, table) => {
      if (patch.counts) {
        // Answer writes preserve row checkpoints, so review counts come from current row state.
        const flagged = await query<{ count: string }>(
          db,
          sql`SELECT count(*) FROM ${ident(this.data.schemas.app, 'ingest_row_state')}
          WHERE org_id = ${file.orgId} AND table_id = ${file.tableId} AND file_id = ${file.id}
            AND jsonb_array_length(reasons) > 0`,
        );
        patch = { ...patch, counts: { ...patch.counts, flagged: Number(flagged.rows[0]!.count) } };
      }
      const updated = await this.tables.inTransaction(db).updateFile({ ...file, userId: null }, file.id, {
        ...patch,
        ...(patch.checks
          ? {
              checks: {
                ...(file.checks.originalSafety ? { originalSafety: file.checks.originalSafety } : {}),
                ...(file.checks.probationFormats ? { probationFormats: file.checks.probationFormats } : {}),
                ...(file.checks.ai ? { ai: file.checks.ai } : {}),
                ...patch.checks,
              },
            }
          : {}),
        ...(patch.notes
          ? {
              notes: [
                ...new Map(
                  [
                    ...file.notes.filter(
                      (note) =>
                        (note.messageId.startsWith('files.') ||
                          note.messageId === 'ingest.pipeline.originalExpired') &&
                        note.messageId !== 'files.checks.scannerUnavailable',
                    ),
                    ...patch.notes,
                  ].map((note) => [JSON.stringify(note), note]),
                ).values(),
              ],
            }
          : {}),
        leaseUntil: null,
        leasedBy: null,
      });
      if (
        updated.state === 'read' &&
        file.state === 'reading' &&
        updated.formatId &&
        !(
          Array.isArray(file.checks.probationFormats) &&
          file.checks.probationFormats.includes(updated.formatId)
        ) &&
        updated.counts.flagged === 0 &&
        updated.counts.refused === 0
      ) {
        const settings = await organizationIngest(db, this.data.schemas, file.orgId);
        const passed = await query(
          db,
          sql`UPDATE ${ident(this.data.schemas.app, 'ingest_formats')}
          SET probation_passed = probation_passed + 1,
            state = CASE WHEN probation_passed + 1 >= ${settings.probationFiles} THEN 'live' ELSE 'probation' END,
            updated_at = now()
          WHERE org_id = ${file.orgId} AND table_id = ${file.tableId} AND id = ${updated.formatId}
            AND state = 'probation' AND study_file_id IS NULL RETURNING id`,
        );
        // Rereading the same arrival cannot supply another clean file toward probation.
        if (passed.rowCount)
          await query(
            db,
            sql`UPDATE ${ident(this.data.schemas.app, 'ingest_files')}
          SET checks = checks || jsonb_build_object('probationFormats', ${JSON.stringify([
            ...(Array.isArray(file.checks.probationFormats) ? file.checks.probationFormats : []),
            updated.formatId,
          ])}::jsonb)
          WHERE org_id = ${file.orgId} AND table_id = ${file.tableId} AND id = ${file.id}`,
          );
      }
      await this.decisions.inTransaction(db).reconcileQuestions(file, claim.job.question_ids, file.id);
      await this.report(db, table, updated, claim.job);
      await this.saveJob(db, claim);
    });
  }
  async wait(
    claim: IngestClaim,
    reason = 'ingest.pipeline.tryLater',
    checks?: PipelineReading['checks'],
  ): Promise<void> {
    await this.finish(claim, {
      state: 'waiting',
      holdReason: reason,
      nextAttemptAt: new Date(Date.now() + backoff(claim.file.attempts)).toISOString(),
      ...(checks ? { checks } : {}),
    });
  }
}
