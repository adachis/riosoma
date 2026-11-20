import { runLiveWork } from '../live/work.js';
import { studyUnknown } from '../study/runner.js';
import { studyKnownColumns } from '../study/known.js';
import { createAiReader } from '../ai-reader/index.js';
import type { StoredTable } from '../../data/types.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AppError, type IngestFile, type IngestRowReason } from '@riosoma/contracts';
import {
  canonical,
  createQuestion,
  decide,
  responseAllowed,
  questionHold,
  matchSignatures,
  type DecisionQuestion,
  type QuestionResponse,
  type ExtractedSource,
} from '@riosoma/ingest';
import { ident, query, sql } from '@riosoma/db';
import { actorFor } from '../../automations/run.js';
import { AccessScope } from '../../data/access.js';
import { sourceOptionsPage } from '../../data/select-options.js';
import { loadFields, loadTable } from '../../data/metadata.js';
import {
  inspectOriginal,
  loadOriginal,
  storeOriginal,
  type OriginalRow,
} from '../../data/files/originals.js';
import { fileStorage } from '../../data/files/storage.js';
import { notify } from '../../notifications/produce.js';
import { message } from '../../api-v1/messages.js';
import { extractSource } from '../extract/index.js';
import {
  answerIngestRows,
  removeIngestFileRows,
  writeIngestRows,
  type IdentityChoice,
  type WriteRow,
} from '../write/index.js';
import { hashValue } from '../write/storage.js';
import type { LookupTables, ReaderFacts, ReaderFact } from '../readers/index.js';
import { receiveFile, requireEditor, type ReceiveInput } from './arrival.js';
import {
  answeredValue,
  cleanValue,
  fileQuestion,
  findingQuestion,
  kind,
  readFormat,
  sameLocation,
  valueDoubt,
} from './reading.js';
import {
  INGEST_CONCURRENCY,
  INGEST_FILES_PER_HOUR,
  INGEST_LEASE_MS,
  INGEST_PART_LIMIT,
  LeaseLost,
  PipelineStore,
} from './store.js';
import {
  isTryLater,
  TryLaterError,
  type IngestClaim,
  type PipelineFunctions,
  type PipelineReading,
  type ReadingDoubt,
} from './types.js';

export class IngestWorker {
  readonly store: PipelineStore;
  functions: PipelineFunctions;
  private readonly reservations = new Set<string>();
  private readonly active = new Set<Promise<void>>();
  private completedFiles = 0;
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;
  private claiming: Promise<void> = Promise.resolve();
  private stopped = false;
  constructor(
    readonly app: FastifyInstance,
    functions: PipelineFunctions = {},
  ) {
    this.store = new PipelineStore(app);
    this.functions = {
      studyUnknown: (source, table, context) =>
        studyUnknown(this, source, table as StoredTable, context.claim),
      ...functions,
    };
  }
  receiveFile(table: StoredTable, input: ReceiveInput) {
    return receiveFile(this.store, table, { ...input, bytes: Buffer.from(input.bytes) });
  }
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) =>
        this.app.log.warn({ err: String(error) }, 'ingest worker pass failed'),
      );
    }, 15_000);
    this.timer.unref();
  }
  pause(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
  tick(): Promise<void> {
    this.ticking ??= this.pass().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }
  private async pass(): Promise<void> {
    await runLiveWork(this);
    for (const claim of await this.claim(INGEST_CONCURRENCY)) {
      const work = this.run(claim)
        .catch((error: unknown) => this.app.log.warn({ err: String(error) }, 'ingest file run failed'))
        .finally(() => {
          this.active.delete(work);
          this.completedFiles++;
        });
      this.active.add(work);
    }
  }
  async drain(now = new Date()): Promise<void> {
    for (;;) {
      const completed = this.completedFiles;
      await this.ticking;
      const worked = await runLiveWork(this);
      const claims = await this.claim(INGEST_CONCURRENCY, now);
      await Promise.all(claims.map((claim) => this.run(claim)));
      await Promise.allSettled(this.active);
      // Finishing a tick's file can expose its next arrival during the claim query or active wait.
      if (!worked && !claims.length && !this.active.size && completed === this.completedFiles) return;
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.pause();
    await this.ticking;
    await Promise.allSettled(this.active);
  }
  /** A table row lock makes the arrival head exclusive across servers, including lease recovery. */
  async claim(limit = INGEST_CONCURRENCY, now = new Date()): Promise<IngestClaim[]> {
    const previous = this.claiming;
    let release!: () => void;
    this.claiming = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.claimAvailable(limit, now);
    } finally {
      release();
    }
  }
  private async claimAvailable(limit: number, now: Date): Promise<IngestClaim[]> {
    if (this.stopped || !this.app.ctx.pool || !this.app.ctx.config.database) return [];
    const room = Math.max(0, Math.min(limit, INGEST_CONCURRENCY - this.reservations.size));
    const claims: IngestClaim[] = [];
    const { pool, schemas } = this.store.data;
    const expired = await query<{ org_id: string; table_id: string; id: string }>(
      pool,
      sql`SELECT f.org_id, f.table_id, f.id FROM ${ident(schemas.app, 'ingest_files')} f
        JOIN ${ident(schemas.app, 'tables')} t ON t.org_id = f.org_id AND t.id = f.table_id
        WHERE t.trashed_at IS NULL AND f.state = 'reading' AND f.lease_until <= clock_timestamp()
        ORDER BY f.seq LIMIT 50`,
    );
    for (const row of expired.rows) {
      try {
        await this.store.locked({ orgId: row.org_id, tableId: row.table_id }, async (db) => {
          const tables = this.store.tables.inTransaction(db);
          const context = { orgId: row.org_id, tableId: row.table_id, userId: null };
          const file = await tables.readFile(context, row.id);
          if (file?.state === 'reading' && file.leaseUntil && Date.parse(file.leaseUntil) <= Date.now())
            await tables.updateFile(context, row.id, { state: 'waiting', leasedBy: null, leaseUntil: null });
        });
      } catch (error) {
        // A table may be trashed after the recovery scan releases its snapshot.
        if (!(error instanceof AppError && error.code === 'not_found')) throw error;
      }
    }
    // Keep the head predicate identical before and after acquiring the database and table locks.
    const available = sql`FROM ${ident(schemas.app, 'tables')} t
      JOIN LATERAL (SELECT f.id, f.seq, f.next_attempt_at, f.lease_until, f.state FROM ${ident(schemas.app, 'ingest_files')} f
        WHERE f.org_id = t.org_id AND f.table_id = t.id AND NOT f.is_example
          AND f.state IN ('received', 'waiting', 'reading') ORDER BY f.seq LIMIT 1) head ON true
      WHERE t.trashed_at IS NULL AND t.ingest->>'state' = 'live'
        AND (head.next_attempt_at IS NULL OR head.next_attempt_at <= ${now})
        AND (head.state <> 'reading' OR head.lease_until <= clock_timestamp())
        AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'ingest_live_requests')} r
          WHERE r.org_id = t.org_id AND r.table_id = t.id AND r.file_id = head.id AND r.state IN ('queued', 'running'))`;
    while (claims.length < room) {
      const found = await query<{ org_id: string; id: string }>(
        pool,
        sql`SELECT t.org_id, t.id ${available} ORDER BY head.seq LIMIT 1`,
      );
      const context = found.rows[0];
      if (!context) break;
      let claim: IngestClaim | null;
      try {
        // Wait in the same database-before-table order as writers. Transaction lock deadlines
        // bound contention; a busy lock must not look like an empty queue to drain or tick.
        claim = await this.store.locked({ orgId: context.org_id, tableId: context.id }, async (db) => {
          const fileIds = await query<{ id: string }>(
            db,
            sql`SELECT f.id FROM ${ident(schemas.app, 'ingest_files')} f
              WHERE f.org_id = ${context.org_id} AND f.table_id = ${context.id}
                AND f.id = (SELECT head.id ${available} AND t.org_id = ${context.org_id} AND t.id = ${context.id})
              FOR UPDATE`,
          );
          if (!fileIds.rows[0]) return null;
          const identity = { orgId: context.org_id, tableId: context.id, userId: null };
          const tables = this.store.tables.inTransaction(db);
          let file = (await tables.readFile(identity, fileIds.rows[0].id))!;
          // State recovery uses the same transition vocabulary as a person's retry.
          if (file.state === 'reading')
            file = await tables.updateFile(identity, file.id, {
              state: 'waiting',
              leaseUntil: null,
              leasedBy: null,
            });
          const recent = await query<{ count: string; first: Date }>(
            db,
            sql`SELECT count(*), min(started_at) AS first
          FROM ${ident(schemas.app, 'ingest_pipeline_jobs')} WHERE org_id = ${file.orgId} AND table_id = ${file.tableId}
            AND started_at > ${now}::timestamptz - interval '1 hour'`,
          );
          if (Number(recent.rows[0]!.count) >= INGEST_FILES_PER_HOUR) {
            await tables.updateFile(identity, file.id, {
              state: 'waiting',
              holdReason: 'ingest.pipeline.hourlyLimit',
              nextAttemptAt: new Date(recent.rows[0]!.first.getTime() + 3_600_001).toISOString(),
            });
            return null;
          }
          const token = randomUUID();
          file = await tables.updateFile(identity, file.id, {
            state: 'reading',
            leasedBy: token,
            leaseUntil: new Date(Date.now() + INGEST_LEASE_MS).toISOString(),
            attempts: file.attempts + 1,
            nextAttemptAt: null,
          });
          const job = await this.store.job(db, file);
          await query(
            db,
            sql`UPDATE ${ident(schemas.app, 'ingest_pipeline_jobs')} SET started_at = ${now}
          WHERE org_id = ${file.orgId} AND table_id = ${file.tableId} AND file_id = ${file.id}`,
          );
          return { file, token, job };
        });
      } catch (error) {
        // A table may be trashed between the candidate scan and its locked recheck.
        if (error instanceof AppError && error.code === 'not_found') continue;
        if (!claims.length) throw error;
        // Already committed claims must still reach run, even if the next table times out.
        this.app.log.warn({ err: String(error) }, 'ingest claim pass failed after claiming files');
        break;
      }
      if (!claim) continue;
      this.reservations.add(claim.token);
      claims.push(claim);
    }
    return claims;
  }
  async run(claim: IngestClaim): Promise<void> {
    const heartbeat = setInterval(() => {
      void this.renew(claim).catch(() => undefined);
    }, INGEST_LEASE_MS / 3);
    heartbeat.unref();
    try {
      await this.process(claim);
    } catch (error) {
      if (
        error instanceof LeaseLost ||
        (error instanceof AppError && error.messageKey === 'ingest.pipeline.leaseLost')
      )
        return;
      try {
        if (isTryLater(error) || (error instanceof AppError && error.code === 'unavailable'))
          await this.store.wait(
            claim,
            error instanceof TryLaterError ? error.messageId : undefined,
            error instanceof TryLaterError ? error.checks : undefined,
          );
        else if (error instanceof AppError && error.messageKey.startsWith('files.'))
          await this.hold(claim, error.messageKey);
        else
          await this.store.finish(claim, {
            state: 'failed',
            holdReason: 'ingest.pipeline.failed',
            notes: [{ messageId: 'ingest.pipeline.failed' }],
          });
      } catch (lost) {
        if (!(lost instanceof LeaseLost)) throw lost;
      }
    } finally {
      clearInterval(heartbeat);
      this.reservations.delete(claim.token);
    }
  }
  private async renew(claim: IngestClaim): Promise<void> {
    const { pool, schemas } = this.store.data;
    await query(
      pool,
      sql`UPDATE ${ident(schemas.app, 'ingest_files')} SET lease_until = ${new Date(Date.now() + INGEST_LEASE_MS)}
      WHERE org_id = ${claim.file.orgId} AND table_id = ${claim.file.tableId} AND id = ${claim.file.id}
        AND state = 'reading' AND leased_by = ${claim.token} AND lease_until > clock_timestamp()`,
    );
  }
  private async pauseOwner(claim: IngestClaim, table: StoredTable): Promise<boolean> {
    const { pool, schemas } = this.store.data;
    const ownerId = table.ingest?.ownerId;
    let writable = false;
    if (ownerId) {
      const actor = await actorFor(pool, schemas, ownerId, table.orgId);
      if (actor) {
        const scope = new AccessScope(pool, schemas, actor);
        try {
          await scope.require(table.databaseId, 'editRecords');
          const fields = await loadFields(pool, schemas, [table.id]);
          writable = fields
            .filter((field) => field.ingest)
            .every((field) => scope.canEditField(table.id, field));
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
        }
      }
    }
    if (writable) return false;
    await this.store.fenced(claim, async (db, file, current) => {
      if (current.ingest?.ownerId !== ownerId) {
        await this.store.tables.inTransaction(db).updateFile({ ...file, userId: null }, file.id, {
          state: 'waiting',
          leasedBy: null,
          leaseUntil: null,
          holdReason: 'ingest.pipeline.tryLater',
        });
        return;
      }
      if (current.ingest?.state === 'live') {
        await this.store.tables
          .inTransaction(db)
          .changeSettings({ ...file, userId: null }, current.ingest.revision, {
            ...current.ingest,
            state: 'paused',
          });
        const members = await query<{ user_id: string }>(
          db,
          sql`SELECT user_id FROM ${ident(schemas.app, 'memberships')} WHERE org_id = ${table.orgId}`,
        );
        for (const member of members.rows) {
          let receive = member.user_id === ownerId;
          const actor = await actorFor(db, schemas, member.user_id, table.orgId);
          if (!receive && actor) {
            try {
              await new AccessScope(db, schemas, actor).require(table.databaseId, 'editSchema');
              receive = true;
            } catch (error) {
              if (!(error instanceof AppError)) throw error;
            }
          }
          if (receive)
            await notify(db, schemas, {
              orgId: file.orgId,
              recipientId: member.user_id,
              actorId: null,
              subjectId: table.id,
              kind: 'ingest.paused',
              target: {
                databaseId: table.databaseId,
                tableId: table.id,
                tableName: table.name,
                reason: { messageKey: 'ingest.write.ownerCannotWrite' },
              },
            });
        }
      }
      await this.store.tables.inTransaction(db).updateFile({ ...file, userId: null }, file.id, {
        state: 'waiting',
        leasedBy: null,
        leaseUntil: null,
        holdReason: 'ingest.write.ownerCannotWrite',
      });
    });
    return true;
  }
  async raise(claim: IngestClaim, question: DecisionQuestion): Promise<QuestionResponse | null> {
    return this.store.fenced(claim, async (db, file, table) => {
      const decisions = this.store.decisions.inTransaction(db);
      await decisions.raiseQuestion(file, question);
      if (!claim.job.question_ids.includes(question.id)) claim.job.question_ids.push(question.id);
      const answer = await decisions.findAnswer(file, question.id);
      if (!answer && !claim.job.notified_questions.includes(question.id) && table.ingest?.ownerId) {
        await notify(db, this.store.data.schemas, {
          orgId: file.orgId,
          recipientId: table.ingest.ownerId,
          actorId: null,
          subjectId: question.id,
          kind: 'ingest.question',
          target: {
            databaseId: table.databaseId,
            tableId: table.id,
            tableName: table.name,
            reason: { messageKey: question.messageId },
          },
        });
        claim.job.notified_questions.push(question.id);
      }
      await this.store.saveJob(db, claim);
      return answer?.response ?? null;
    });
  }
  private async hold(
    claim: IngestClaim,
    messageId: string,
    question?: DecisionQuestion,
    reading?: PipelineReading,
  ): Promise<void> {
    if (question) {
      const answer = await this.raise(claim, question);
      if (answer?.type === 'skipFile') {
        await this.store.finish(claim, { state: 'skipped', holdReason: null });
        return;
      }
    }
    await this.store.finish(claim, {
      state: 'held',
      holdReason: messageId,
      notes: [
        ...(reading?.notes ?? []),
        { messageId, ...(reading?.failure?.params && { params: reading.failure.params }) },
      ],
      checks: reading?.checks ?? {},
    });
  }
  private async parts(claim: IngestClaim, source: ExtractedSource, table: StoredTable): Promise<boolean> {
    const parts = source.parts ?? [];
    if (!parts.length) return false;
    if (claim.file.origin === 'part') {
      await this.hold(claim, 'ingest.pipeline.partDepth');
      return true;
    }
    if (parts.length > INGEST_PART_LIMIT) {
      await this.hold(claim, 'ingest.pipeline.partLimit');
      return true;
    }
    if (!claim.job.parts_created) {
      const { pool, schemas } = this.store.data;
      const inspected = await Promise.all(
        parts.map((part) =>
          inspectOriginal(
            pool,
            schemas.app,
            this.app.ctx.config,
            claim.file.orgId,
            { name: part.name, bytes: Buffer.from(part.bytes) },
            true,
          ),
        ),
      );
      const outside: OriginalRow[] = [];
      try {
        await this.store.fenced(claim, async (db, file) => {
          const tables = this.store.tables.inTransaction(db);
          for (const [index, part] of parts.entries()) {
            const checked = inspected[index]!;
            const duplicate = await query(
              db,
              sql`SELECT id FROM ${ident(schemas.app, 'ingest_files')} WHERE org_id = ${file.orgId} AND table_id = ${file.tableId} AND sha256 = ${checked.sha256} LIMIT 1`,
            );
            let child = await tables.createFile(
              { ...file, userId: null },
              {
                parentId: file.id,
                origin: 'part',
                name: part.name,
                mediaType: checked.type,
                sizeBytes: part.bytes.length,
                sha256: checked.sha256,
                storedFile: null,
                droppedBy: file.droppedBy,
                senderId: file.senderId,
                receivedAt: file.receivedAt,
              },
            );
            const pending =
              checked.safety.state === 'held' && checked.safety.reason === 'files.checks.scannerUnavailable';
            if (checked.safety.state !== 'held' || pending) {
              const original = await storeOriginal(
                db,
                schemas.app,
                this.app.ctx.config,
                {
                  orgId: file.orgId,
                  tableId: file.tableId,
                  fileId: child.id,
                  userId: table.ingest!.ownerId!,
                },
                { name: part.name, bytes: Buffer.from(part.bytes) },
                (row) => outside.push(row),
                checked,
              );
              child = await tables.updateFile({ ...file, userId: null }, child.id, {
                storedFile: original.id,
                checks: { originalSafety: checked.safety },
                notes:
                  checked.safety.state === 'noted'
                    ? checked.safety.notes.map((messageId) => ({ messageId }))
                    : [],
              });
            }
            if (checked.safety.state === 'held')
              child = await tables.updateFile({ ...file, userId: null }, child.id, {
                state: pending ? 'waiting' : 'held',
                holdReason: checked.safety.reason,
              });
            if (duplicate.rowCount && pending)
              child = await tables.updateFile({ ...file, userId: null }, child.id, {
                notes: [{ messageId: 'ingest.pipeline.seenBefore' }],
              });
            if (duplicate.rowCount && checked.safety.state !== 'held')
              child = await tables.updateFile({ ...file, userId: null }, child.id, {
                state: 'held',
                holdReason: 'ingest.pipeline.seenBefore',
              });
            const childJob = await this.store.job(db, child);
            await this.store.report(db, table, child, childJob);
            await this.store.saveJob(db, { file: child, token: '', job: childJob });
          }
          claim.job.parts_created = true;
          await this.store.saveJob(db, claim);
        });
      } catch (error) {
        for (const original of outside)
          await fileStorage(original.storage, pool, schemas.app, this.app.ctx.config).delete(
            original.storage_key,
          );
        throw error;
      }
    }
    if (source.kind === 'email') {
      const formats = (await this.store.tables.listFormats(claim.file)).filter((format) =>
        ['live', 'probation'].includes(format.state),
      );
      if (
        matchSignatures(
          source,
          formats.map((format) => ({ ...format.signature, id: format.id })),
        ).status !== 'none'
      )
        return false;
    }
    if (source.kind === 'archive' || source.kind === 'email') {
      await this.store.finish(claim, {
        state: 'read',
        holdReason: null,
        notes: [{ messageId: 'ingest.pipeline.partsQueued', params: { count: parts.length } }],
        checks: { parts: parts.length },
      });
      return true;
    }
    return false;
  }
  private async process(claim: IngestClaim): Promise<void> {
    const { pool, schemas } = this.store.data;
    let table = (await loadTable(pool, schemas, claim.file.tableId))!;
    if (table.ingest?.state !== 'live') {
      await this.store.wait(claim, 'ingest.pipeline.paused');
      return;
    }
    if (await this.pauseOwner(claim, table)) return;
    const file = claim.file;
    if (!file.storedFile || (file.expiresAt && Date.parse(file.expiresAt) <= Date.now())) {
      await this.hold(claim, 'ingest.pipeline.originalExpired');
      return;
    }
    claim.job.question_ids = [];
    let format = file.formatId ? await this.store.tables.readFormat(file, file.formatId) : null;
    const formats = (await this.store.tables.listFormats(file)).filter(
      (entry) =>
        ['live', 'probation'].includes(entry.state) &&
        (!entry.unknownSenderId || entry.unknownSenderId === file.senderId),
    );
    const previousReading = claim.job.prepared;
    if (!format || !formats.some((entry) => entry.id === format!.id)) {
      format = null;
      if (previousReading) previousReading.reread = true;
      if (file.formatId)
        await this.store.fenced(claim, async (db) => {
          await this.store.tables.inTransaction(db).updateFile({ ...file, userId: null }, file.id, {
            formatId: null,
          });
          await this.store.saveJob(db, claim);
        });
    }
    let reading: PipelineReading | null = format && !previousReading?.reread ? previousReading : null;
    let studiedReading = false;
    if (!reading) {
      const bytes = await loadOriginal(pool, schemas.app, this.app.ctx.config, file, true, {
        token: claim.token,
      });
      if (!bytes) {
        await this.hold(claim, 'ingest.pipeline.originalUnavailable');
        return;
      }
      if (file.notes.some((note) => note.messageId === 'ingest.pipeline.seenBefore')) {
        await this.hold(claim, 'ingest.pipeline.seenBefore');
        return;
      }
      const extracted = await extractSource(
        file.name,
        bytes,
        file.origin === 'part' ? { archiveDepth: 1, emailDepth: 1 } : {},
      );
      if (extracted.status !== 'extracted') {
        const question =
          extracted.status === 'needs-password'
            ? fileQuestion(file, 'passwordProtected', extracted.messageKey)
            : ['unclaimed', 'outside-feature'].includes(extracted.status)
              ? findingQuestion(file, extracted.messageKey)
              : undefined;
        await this.hold(claim, extracted.messageKey, question, {
          rows: [],
          checks: { extraction: extracted },
        });
        return;
      }
      const source = extracted.source;
      if (await this.parts(claim, source, table)) return;
      if (!format) {
        const failing = (await this.store.tables.listFormats(file)).filter(
          (entry) => entry.state === 'failing',
        );
        const blocked = matchSignatures(
          source,
          failing.map((entry) => ({ ...entry.signature, id: entry.id })),
        );
        if (blocked.status !== 'none') {
          const failedFormat = failing.find((entry) => entry.id === blocked.matches[0]!.signature.id)!;
          const reason = failedFormat.studyFileId
            ? 'ingest.study.failing'
            : 'ingest.questions.unrecognizedFormat';
          await this.hold(
            claim,
            reason,
            failedFormat.studyFileId
              ? findingQuestion(file, reason)
              : fileQuestion(file, 'unrecognizedFormat', 'format'),
            {
              rows: [],
              checks: {
                finding: failedFormat.checks,
              },
            },
          );
          return;
        }
        const matched = matchSignatures(
          source,
          formats.map((entry) => ({ ...entry.signature, id: entry.id })),
        );
        if (matched.status === 'matched')
          format = formats.find((entry) => entry.id === matched.match.signature.id)!;
        else if (matched.status === 'tie') {
          const question = fileQuestion(
            file,
            'unopenableFileType',
            'formatTie',
            matched.tied.map((entry) => entry.signature.id),
          );
          const response = await this.raise(claim, question);
          if (response?.type === 'skipFile') {
            await this.store.finish(claim, { state: 'skipped' });
            return;
          }
          if (response?.type === 'answer' && response.answer.type === 'choice')
            format = formats.find((entry) => entry.id === response.answer.value)!;
          if (!format) {
            await this.hold(claim, 'ingest.pipeline.formatTie');
            return;
          }
        } else if (file.senderId && formats.some((entry) => entry.unknownSenderId === file.senderId)) {
          const senderFormats = formats.filter((entry) => entry.unknownSenderId === file.senderId);
          if (senderFormats.length === 1) format = senderFormats[0]!;
          else {
            const question = fileQuestion(
              file,
              'unopenableFileType',
              'formatTie',
              senderFormats.map((entry) => entry.id),
            );
            const response = await this.raise(claim, question);
            if (response?.type === 'skipFile') {
              await this.store.finish(claim, { state: 'skipped', holdReason: null });
              return;
            }
            if (response?.type === 'answer' && response.answer.type === 'choice')
              format = senderFormats.find((entry) => entry.id === response.answer.value)!;
          }
        } else if (this.functions.studyUnknown) {
          const studied = await this.functions.studyUnknown(source, table, { claim, worker: this });
          if (studied && 'type' in studied && studied.type === 'study') {
            if (studied.skip) {
              const removed = await removeIngestFileRows(table, file.id, `study-skip:${file.id}`, {
                app: this.app,
                message,
                lease: { fileId: file.id, token: claim.token },
                preserveFileState: true,
              });
              if (removed.status === 'stopped' || removed.refused.length)
                throw new AppError('conflict', removed.messageId ?? 'ingest.pipeline.writeStopped');
              await this.store.finish(claim, { state: 'skipped', holdReason: null });
              return;
            }
            if (studied.waiting) {
              await this.hold(claim, studied.reason ?? 'ingest.pipeline.questionsOpen');
              return;
            }
            format = studied.format;
            reading = studied.reading;
            studiedReading = true;
          } else if (studied && 'id' in studied) {
            if (
              studied.orgId === table.orgId &&
              studied.tableId === table.id &&
              ['live', 'probation'].includes(studied.state)
            ) {
              const saved = await this.store.tables.readFormat(file, studied.id);
              if (saved && ['live', 'probation'].includes(saved.state)) format = saved;
            }
          } else if (studied && !('type' in studied)) {
            // Newly learned formats must finish the organization's clean-file probation.
            format = await this.store.fenced(claim, async (db) =>
              this.store.tables
                .inTransaction(db)
                .createFormat(
                  { ...file, userId: null },
                  { ...studied, state: 'probation', probationPassed: 0 },
                ),
            );
          }
        }
      }
      if (!format) {
        await this.hold(
          claim,
          'ingest.questions.unrecognizedFormat',
          fileQuestion(file, 'unrecognizedFormat', 'format'),
        );
        return;
      }
      await this.store.fenced(claim, async (db) => {
        await this.store.tables.inTransaction(db).updateFile({ ...file, userId: null }, file.id, {
          formatId: format!.id.startsWith('study-') ? null : format!.id,
        });
      });
      const lookups: Record<string, Record<string, string>> = {};
      const fields = await loadFields(pool, schemas, [table.id]);
      const owner = await actorFor(pool, schemas, table.ingest!.ownerId!, table.orgId);
      if (!owner) {
        await this.pauseOwner(claim, table);
        return;
      }
      const scope = new AccessScope(pool, schemas, owner);
      await scope.require(table.databaseId, 'editRecords');
      for (const field of fields)
        if (
          field.ingest?.role === 'data' &&
          (field.type === 'singleSelect' || field.type === 'multipleSelect')
        ) {
          const choices = [...field.options.choices];
          if (field.options.source) {
            const page = await sourceOptionsPage(pool, schemas, scope, field);
            if (page.truncated) {
              await this.hold(claim, 'ingest.pipeline.lookupLimit');
              return;
            }
            choices.push(...page.choices);
          }
          lookups[field.ingest.key] = Object.fromEntries(choices.map((choice) => [choice.name, choice.id]));
        }
      const facts: Record<string, ReaderFact> = {};
      const answered = await query<{ document: DecisionQuestion }>(
        pool,
        sql`SELECT document FROM ${ident(schemas.app, 'ingest_questions')}
        WHERE org_id = ${file.orgId} AND table_id = ${file.tableId} AND document->'target'->>'file' = ${file.id}`,
      );
      for (const row of answered.rows) {
        const answer = await this.store.decisions.findAnswer(file, row.document.id);
        if (answer?.response.type === 'answer') facts[row.document.key] = answer.response.answer.value;
      }
      try {
        if (!studiedReading)
          reading = await readFormat(
            source,
            format,
            table,
            file,
            this.functions,
            lookups as LookupTables,
            facts as ReaderFacts,
          );
      } catch (error) {
        if (isTryLater(error)) throw error;
        await this.hold(
          claim,
          'ingest.pipeline.readFailed',
          findingQuestion(file, 'ingest.pipeline.readFailed'),
        );
        return;
      }
      if (
        !studiedReading &&
        reading &&
        (await studyKnownColumns(this, claim, table, source, format, reading))
      ) {
        const removed = await removeIngestFileRows(table, file.id, `column-skip:${file.id}`, {
          app: this.app,
          message,
          lease: { fileId: file.id, token: claim.token },
          preserveFileState: true,
        });
        if (removed.status !== 'written' || removed.refused.length)
          throw new AppError('conflict', removed.messageId ?? 'ingest.pipeline.writeStopped');
        await this.store.finish(claim, { state: 'skipped', holdReason: null });
        return;
      }
      if (!reading) {
        await this.hold(
          claim,
          'ingest.pipeline.readerUnavailable',
          findingQuestion(file, 'ingest.pipeline.readerUnavailable'),
        );
        return;
      }
      reading.notes = [...source.warnings.map((messageId) => ({ messageId })), ...(reading.notes ?? [])];
      if (format.state === 'probation') reading.notes.push({ messageId: 'ingest.pipeline.probation' });
      if (previousReading?.reread) {
        const written = await query<{ result: { outcomes: Record<string, { settled: boolean }> } }>(
          pool,
          sql`SELECT result FROM ${ident(schemas.app, 'ingest_write_batches')} WHERE file_id = ${file.id}
            AND run_id = ${claim.job.run_id} AND operation = 'write:outcomes'`,
        );
        const positions = written.rows.flatMap((batch) =>
          Object.entries(batch.result.outcomes)
            .filter(([, outcome]) => outcome.settled)
            .map(([position]) => Number(position)),
        );
        if (
          positions.some(
            (position) =>
              !reading!.rows[position] ||
              !sameLocation(previousReading.rows[position]!.at, reading!.rows[position]!.at),
          )
        ) {
          await this.hold(claim, 'ingest.write.changedRun', findingQuestion(file, 'ingest.write.changedRun'));
          return;
        }
      }
      claim.job.prepared = reading;
      await this.store.fenced(claim, async (db) => this.store.saveJob(db, claim));
    }
    table = (await loadTable(pool, schemas, file.tableId))!;
    if (table.ingest?.state !== 'live') {
      await this.store.wait(claim, 'ingest.pipeline.paused');
      return;
    }
    const currentFormat =
      format &&
      (format.id.startsWith('study-') ? format : await this.store.tables.readFormat(file, format.id));
    if (
      !currentFormat ||
      (!format?.id.startsWith('study-') && !['live', 'probation'].includes(currentFormat.state))
    ) {
      if (claim.job.prepared) claim.job.prepared.reread = true;
      await this.store.fenced(claim, async (db) => {
        await this.store.tables.inTransaction(db).updateFile({ ...file, userId: null }, file.id, {
          formatId: null,
        });
        await this.store.saveJob(db, claim);
      });
      await this.hold(
        claim,
        'ingest.questions.unrecognizedFormat',
        fileQuestion(file, 'unrecognizedFormat', 'format'),
      );
      return;
    }
    if (reading.failure) {
      await this.hold(
        claim,
        reading.failure.messageId,
        findingQuestion(file, reading.failure.messageId),
        reading,
      );
      return;
    }
    const missing = table.ingest!.fields.find(
      (field) =>
        field.required &&
        reading!.rows.length > 0 &&
        reading!.rows.every((row) => !Object.hasOwn(row.values, field.key)),
    );
    if (missing) {
      await this.hold(
        claim,
        'ingest.pipeline.columnMissing',
        findingQuestion(file, 'ingest.pipeline.columnMissing'),
        {
          ...reading,
          failure: { messageId: 'ingest.pipeline.columnMissing', params: { field: missing.key } },
        },
      );
      return;
    }
    if (!reading.rows.length) {
      await this.hold(claim, 'ingest.layout.noRows', findingQuestion(file, 'ingest.layout.noRows'), reading);
      return;
    }
    const settled = await this.settle(claim, table, reading, format!);
    if (settled.skip) {
      await this.store.finish(claim, { state: 'skipped', holdReason: null });
      return;
    }
    if (settled.fileHeld) {
      await this.hold(claim, settled.reason ?? 'ingest.pipeline.questionsOpen', undefined, reading);
      return;
    }
    const services = {
      app: this.app,
      message,
      lease: { fileId: file.id, token: claim.token },
      checkpointInputId: hashValue([file.id, claim.job.run_id]),
      requireAllDecisions: !!(
        await query(
          pool,
          sql`SELECT file_id FROM ${ident(schemas.app, 'ingest_studies')}
        WHERE org_id = ${file.orgId} AND table_id = ${table.id} AND file_id = ${file.id}`,
        )
      ).rowCount,
    };
    let result = await writeIngestRows(table, file.id, claim.job.run_id, settled.rows, services);
    if (result.status === 'stopped') {
      if (result.messageId === 'ingest.pipeline.leaseLost') throw new LeaseLost();
      if (result.messageId === 'ingest.write.ownerCannotWrite') {
        await this.pauseOwner(claim, table);
        return;
      }
      if (result.messageId === 'ingest.write.inactive') {
        await this.store.wait(claim, 'ingest.pipeline.paused');
        return;
      }
      await this.hold(claim, result.messageId ?? 'ingest.pipeline.writeStopped', undefined, reading);
      return;
    }
    let checks = reading.checks ?? {};
    if (result.disagreements.length) {
      const question = fileQuestion(file, 'fileTableDisagreement', 'tableDisagreement', [
        'keepTable',
        'takeFile',
      ]);
      if (question.form.type === 'choices') {
        const selections = result.disagreements
          .filter((difference) => difference.rows.length > 1 || difference.records.length > 1)
          .map((difference) => ({
            identity: difference.identity,
            rows: difference.rows,
            recordIds: difference.records.map((record) => record.id),
          }));
        if (selections.length) question.form.selections = selections;
      }
      question.evidence = result.disagreements.slice(0, 3).map((difference) => ({
        file: file.id,
        examples: [
          canonical({
            incoming: difference.rows.slice(0, 3).map((row) => settled.rows[row]?.values),
            existing: difference.records.slice(0, 3),
          }).slice(0, 4000),
        ],
      }));
      // Counts and examples stay in protected file evidence, never in a notification target.
      const rebuilt = createQuestion(kind('fileTableDisagreement'), { ...question }, question.scopeContext);
      const answer = await this.raise(claim, rebuilt);
      const disagreementChecks = {
        ...reading.checks,
        disagreement: { ...result.comparison, examples: question.evidence },
      };
      checks = disagreementChecks;
      if (answer?.type === 'skipFile') {
        await this.store.finish(claim, {
          state: 'skipped',
          counts: result.counts,
          checks: disagreementChecks,
        });
        return;
      }
      if (answer?.type === 'answer' && answer.answer.type === 'choice' && responseAllowed(rebuilt, answer)) {
        const selection = answer.answer;
        const choices: Record<string, IdentityChoice> = Object.fromEntries(
          result.disagreements.map((difference) => [
            difference.identity,
            {
              choice: selection.value as IdentityChoice['choice'],
              ...selection.selections?.find((entry) => entry.identity === difference.identity),
            },
          ]),
        );
        result = await writeIngestRows(table, file.id, claim.job.run_id, settled.rows, services, choices);
      } else if (answer?.type === 'unknown' && services.requireAllDecisions) {
        for (const row of settled.rows)
          row.reasons = [
            ...row.reasons,
            { messageId: rebuilt.messageId, source: { kind: 'question', questionId: rebuilt.id } },
          ];
        const choices: Record<string, IdentityChoice> = Object.fromEntries(
          result.disagreements.map((difference) => [difference.identity, { choice: 'keepTable' }]),
        );
        result = await writeIngestRows(table, file.id, claim.job.run_id, settled.rows, services, choices);
      }
    }
    const held =
      reading.flagged ||
      settled.held ||
      result.disagreements.length > 0 ||
      result.refused.length > 0 ||
      result.status === 'stopped';
    await this.store.finish(claim, {
      state: held ? 'held' : 'read',
      holdReason: reading.flagged ? 'ingest.aiReader.flagged' : held ? 'ingest.pipeline.questionsOpen' : null,
      counts: result.counts,
      notes: reading.notes ?? [],
      checks,
    });
  }
  private async settle(
    claim: IngestClaim,
    table: StoredTable,
    reading: PipelineReading,
    format: NonNullable<Awaited<ReturnType<PipelineStore['tables']['readFormat']>>>,
  ) {
    const rows: WriteRow[] = reading.rows.map((row) => ({
      ...structuredClone(row),
      reasons: row.reasons ?? [],
      aiFields: row.aiFields ?? (format.reading === 'ai' ? Object.keys(row.values) : []),
    }));
    const doubts = [...(reading.doubts ?? [])];
    const knownKeys = new Set(table.ingest!.fields.map((field) => field.key));
    const unknownKeys = [...new Set(rows.flatMap((row) => Object.keys(row.values)))].filter(
      (key) => !knownKeys.has(key),
    );
    if (unknownKeys.length) {
      const definition = kind('unknownColumn');
      const question = createQuestion(
        definition,
        {
          key: `${claim.file.id}:columns`,
          values: unknownKeys.map((value) => ({ type: 'text', value })),
          form: {
            type: 'mapping',
            columns: unknownKeys.map((heading) => ({
              heading,
              examples: rows.slice(0, 3).map((row) => String(row.values[heading] ?? '')),
              fields: [...knownKeys],
            })),
          },
          evidence: unknownKeys.map((column) => ({
            file: claim.file.id,
            column,
            examples: rows.slice(0, 3).map((row) => String(row.values[column] ?? '')),
          })),
          target: { type: 'file', file: claim.file.id },
          exits: ['skipFile'],
        },
        { format: format.id },
      );
      const response = await this.resolve(claim, {
        item: { kind: definition, format: format.id, inputs: { format: { type: 'text', value: format.id } } },
        question,
      });
      if (response?.type === 'skipFile')
        return { rows, held: false, fileHeld: false, skip: true, reason: null };
      if (response?.type !== 'answer' || response.answer.type !== 'mapping')
        return { rows, held: true, fileHeld: true, skip: false, reason: 'ingest.pipeline.questionsOpen' };
      for (const mapping of response.answer.value)
        for (const row of rows) {
          if (mapping.field && Object.hasOwn(row.values, mapping.heading))
            row.values[mapping.field] = row.values[mapping.heading];
          delete row.values[mapping.heading];
        }
      reading.checks = { ...reading.checks, columnMapping: response.answer.value };
    }
    const fields = await loadFields(this.store.data.pool, this.store.data.schemas, [table.id]);
    for (const row of rows)
      for (const definition of table.ingest!.fields) {
        if (
          row.reasons.some(
            (reason) => reason.fieldKey === definition.key && reason.source.kind === 'question',
          ) ||
          doubts.some(
            (doubt) =>
              doubt.question.target.type === 'field' &&
              doubt.question.target.field === definition.key &&
              doubt.question.target.rows.some((at) => sameLocation(at, row.at)),
          )
        )
          continue;
        const field = fields.find((entry) => entry.id === definition.fieldId)!;
        const value = row.values[definition.key];
        const cleaned = cleanValue(
          value,
          field.type === 'date' && field.options.includeTime ? 'instant' : field.type,
        );
        if (
          (cleaned && !cleaned.certain) ||
          (definition.required && (value === null || value === undefined || value === ''))
        )
          doubts.push(
            valueDoubt(
              claim.file,
              format,
              definition.key,
              row.at,
              row.raw[definition.key] ?? String(value ?? ''),
              field.type === 'date'
                ? 'date'
                : ['number', 'currency', 'percent', 'rating'].includes(field.type)
                  ? 'number'
                  : 'text',
            ),
          );
      }
    let removedRows = 0;
    let held = false,
      fileHeld = false,
      skip = false;
    const sender = claim.file.senderId
      ? await this.store.tables.readSender(claim.file, claim.file.senderId)
      : null;
    const studied = await query(
      this.store.data.pool,
      sql`SELECT file_id FROM ${ident(this.store.data.schemas.app, 'ingest_studies')}
      WHERE org_id = ${claim.file.orgId} AND table_id = ${table.id} AND file_id = ${claim.file.id}`,
    );
    for (const doubt of doubts) {
      if (sender) {
        const identity = { id: sender.id, kind: sender.kind, value: sender.value };
        doubt.item = {
          ...doubt.item,
          sender: identity,
          inputs: { ...doubt.item.inputs, sender: { type: 'text', value: sender.value } },
        };
        doubt.question = createQuestion(doubt.item.kind, doubt.question, {
          ...doubt.question.scopeContext,
          sender: identity,
        });
      }
      const response = await this.resolve(claim, doubt);
      if (!response && studied.rowCount) fileHeld = true;
      if (response?.type === 'skipFile') {
        skip = true;
        continue;
      }
      const target = questionHold(doubt.question);
      const affected =
        target.type === 'file'
          ? rows
          : rows.filter((row) => target.rows.some((at) => sameLocation(at, row.at)));
      if (response?.type === 'answer') {
        if (doubt.question.kind === 'unknownColumn' && response.answer.type === 'mapping') {
          for (const mapping of response.answer.value)
            for (const row of affected) {
              if (mapping.field && Object.hasOwn(row.values, mapping.heading))
                row.values[mapping.field] = row.values[mapping.heading];
              delete row.values[mapping.heading];
            }
          reading.checks = { ...reading.checks, columnMapping: response.answer.value };
        }
        if (target.type === 'field') {
          const value = answeredValue(doubt, response);
          const result = await answerIngestRows(
            table,
            doubt.question.id,
            value,
            `resolved:${claim.job.run_id}:${doubt.question.id}:${hashValue(response)}`,
            { app: this.app, message, lease: { fileId: claim.file.id, token: claim.token } },
          );
          if (result.messageId === 'ingest.pipeline.leaseLost') throw new LeaseLost();
          if (result.status === 'stopped')
            throw new AppError('unavailable', result.messageId ?? 'ingest.pipeline.writeStopped');
          if (result.disagreements.length || result.refused.length) held = true;
          for (const row of affected) row.values[target.field] = value;
        }
        continue;
      }
      if (response?.type === 'removeRow') {
        removedRows += affected.length;
        for (const row of affected) row.held = { questionId: doubt.question.id };
        continue;
      }
      held = true;
      if (target.type === 'file') fileHeld = true;
      if (target.type === 'rows') for (const row of affected) row.held = { questionId: doubt.question.id };
      if (target.type === 'field')
        for (const row of affected) {
          row.values[target.field] = null;
          const reason: IngestRowReason = {
            messageId: doubt.question.messageId,
            fieldKey: target.field,
            source: { kind: 'question', questionId: doubt.question.id },
          };
          row.reasons = [...row.reasons, reason];
        }
    }
    if (removedRows)
      reading.notes = [
        ...(reading.notes ?? []),
        { messageId: 'ingest.pipeline.rowsRemoved', params: { count: removedRows } },
      ];
    return { rows, held, fileHeld, skip, reason: held ? 'ingest.pipeline.questionsOpen' : null };
  }
  private async resolve(claim: IngestClaim, doubt: ReadingDoubt): Promise<QuestionResponse | null> {
    const rules = await this.store.decisions.findRules(claim.file, doubt.item);
    const request = {
      item: doubt.item,
      builtIns: doubt.builtIns,
      rules,
      question: doubt.question,
      target: doubt.question.target,
      key: doubt.question.key,
      attempt: 'unused' as const,
    };
    let outcome = decide(request);
    if (outcome.status === 'ask') {
      const response = await this.raise(claim, outcome.question);
      doubt.question = outcome.question;
      outcome = decide({
        ...request,
        question: outcome.question,
        ...(response
          ? {
              answer: {
                questionId: outcome.question.id,
                questionVersion: outcome.question.version,
                response,
              },
            }
          : {}),
      });
    }
    if (outcome.status === 'decided') {
      if (responseAllowed(request.question, outcome.response)) return outcome.response;
      return this.raise(claim, request.question);
    }
    if (outcome.status === 'attemptAllowed' && this.functions.attemptOnce) {
      if (!Object.hasOwn(claim.job.attempts, doubt.question.id)) {
        const response = await this.functions.attemptOnce(doubt.question, doubt.question.evidence);
        claim.job.attempts[doubt.question.id] =
          response && responseAllowed(doubt.question, response) ? response : null;
        await this.store.fenced(claim, async (db) => this.store.saveJob(db, claim));
      }
      return claim.job.attempts[doubt.question.id] ?? null;
    }
    return null;
  }
  private async locate(fileId: string, userId: string) {
    const { pool, schemas } = this.store.data;
    const found = await query<{ org_id: string; table_id: string }>(
      pool,
      sql`SELECT org_id, table_id FROM ${ident(schemas.app, 'ingest_files')} WHERE id = ${fileId}`,
    );
    const location = found.rows[0];
    if (!location) throw new AppError('not_found', 'errors.notFound');
    const table = (await loadTable(pool, schemas, location.table_id))!;
    await requireEditor(this.store, pool, table, userId);
    return {
      table,
      file: (await this.store.tables.readFile(
        { orgId: location.org_id, tableId: location.table_id },
        fileId,
      ))!,
    };
  }
  private async queue(
    fileId: string,
    userId: string,
    action: 'resume' | 'readAnyway' | 'retry' | 'skip',
  ): Promise<IngestFile> {
    const located = await this.locate(fileId, userId);
    return this.store.locked(located.file, async (db, table) => {
      await requireEditor(this.store, db, table, userId);
      if (!table.ingest) throw new AppError('conflict', 'ingest.live.notInMode');
      if (table.ingest.state === 'setup') throw new AppError('conflict', 'ingest.live.inSetup');
      const tables = this.store.tables.inTransaction(db);
      const file = (await tables.readFile(located.file, fileId))!;
      if (
        action !== 'skip' &&
        (!file.storedFile || (file.expiresAt && Date.parse(file.expiresAt) <= Date.now()))
      )
        throw new AppError('conflict', 'ingest.pipeline.originalExpired');
      if (
        (action === 'readAnyway' && file.holdReason !== 'ingest.pipeline.seenBefore') ||
        (action === 'retry' && !['failed', 'held'].includes(file.state))
      )
        throw new AppError('conflict', 'ingest.files.state');
      if (file.state === 'reading') throw new AppError('conflict', 'ingest.files.state');
      const job = await this.store.job(db, file);
      if (action === 'retry')
        await query(
          db,
          sql`DELETE FROM ${ident(this.store.data.schemas.app, 'ingest_studies')}
          WHERE org_id = ${file.orgId} AND table_id = ${file.tableId} AND file_id = ${file.id} AND document->>'state' = 'unavailable'`,
        );
      // A resumed reading keeps row positions and its run ID so prior batches remain settled.
      if (action === 'retry' && !job.prepared) job.attempts = {};
      if (action === 'resume' && job.prepared) job.prepared.reread = true;
      const updated = await tables.updateFile({ ...file, userId }, file.id, {
        state: action === 'skip' ? 'skipped' : 'waiting',
        holdReason: null,
        leasedBy: null,
        leaseUntil: null,
        nextAttemptAt: null,
        ...(action === 'readAnyway'
          ? { notes: file.notes.filter((note) => note.messageId !== 'ingest.pipeline.seenBefore') }
          : {}),
      });
      await this.store.saveJob(db, { file, token: '', job });
      return updated;
    });
  }
  readAnyway(fileId: string, userId: string) {
    return this.queue(fileId, userId, 'readAnyway');
  }
  skipFile(fileId: string, userId: string) {
    return this.queue(fileId, userId, 'skip');
  }
  retryFile(fileId: string, userId: string) {
    return this.queue(fileId, userId, 'retry');
  }
  async resumeFile(fileId: string, userId: string, answeredQuestionId?: string): Promise<IngestFile> {
    const { table, file } = await this.locate(fileId, userId);
    const { pool, schemas } = this.store.data;
    const studied = await query(
      pool,
      sql`SELECT file_id FROM ${ident(schemas.app, 'ingest_studies')}
      WHERE org_id = ${file.orgId} AND table_id = ${file.tableId} AND file_id = ${file.id}`,
    );
    if (studied.rowCount) return this.queue(fileId, userId, 'resume');
    const questions = await query<{ document: DecisionQuestion }>(
      pool,
      sql`SELECT document FROM ${ident(schemas.app, 'ingest_questions')}
      WHERE org_id = ${file.orgId} AND table_id = ${file.tableId} AND active AND document->'target'->>'file' = ${file.id}
        ${answeredQuestionId ? sql`AND id = ${answeredQuestionId}` : sql``}`,
    );
    if (answeredQuestionId && !questions.rows.length) return file;
    const savedJob = await this.store.job(pool, file);
    let reread = questions.rows.length === 0;
    for (const { document } of questions.rows) {
      const answer = await this.store.decisions.findAnswer(file, document.id);
      if (!answer || document.target.type !== 'field' || answer.response.type !== 'answer') {
        reread = true;
        continue;
      }
      let response = answer.response;
      if (
        document.kind === 'ruleConflict' &&
        document.form.type === 'choices' &&
        response.answer.type === 'choice'
      ) {
        const selected = document.form.choices.find((choice) => choice.id === response.answer.value);
        if (selected?.answer) response = { type: 'answer', answer: selected.answer };
      }
      const original = savedJob.prepared?.doubts?.find((doubt) => doubt.question.id === document.id);
      const result = await answerIngestRows(
        table,
        document.id,
        answeredValue(
          {
            item: {
              kind: original?.item.kind ?? kind(document.kind) ?? kind('blankRequiredValue'),
              value: document.scopeContext.value,
              inputs: {},
            },
            question: document,
          },
          response,
        ),
        `answer:${answer.id}`,
        { app: this.app, message, allowPaused: true, userId },
      );
      if (result.status !== 'written' || result.refused.length)
        throw new AppError(
          'conflict',
          result.refused[0]?.reason.messageKey ?? result.messageId ?? 'ingest.pipeline.writeStopped',
        );
    }
    if (reread) return this.queue(fileId, userId, 'resume');
    return this.store.locked(file, async (db) => {
      const job = await this.store.job(db, file);
      const tables = this.store.tables.inTransaction(db);
      let updated = (await tables.readFile(file, file.id))!;
      await requireEditor(this.store, db, (await loadTable(db, schemas, file.tableId))!, userId);
      if (updated.state === 'reading') throw new AppError('conflict', 'ingest.files.state');
      const flagged = await query<{ count: string }>(
        db,
        sql`SELECT count(*) FROM ${ident(schemas.app, 'ingest_row_state')}
        WHERE org_id = ${file.orgId} AND table_id = ${file.tableId} AND file_id = ${file.id} AND jsonb_array_length(reasons) > 0`,
      );
      updated = await tables.updateFile({ ...file, userId }, file.id, {
        counts: { ...updated.counts, flagged: Number(flagged.rows[0]!.count) },
      });
      if (answeredQuestionId) {
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'ingest_questions')} SET active = false, updated_at = now()
          WHERE org_id = ${file.orgId} AND table_id = ${file.tableId} AND id = ${answeredQuestionId}`,
        );
        job.question_ids = job.question_ids.filter((id) => id !== answeredQuestionId);
      } else {
        await this.store.decisions.inTransaction(db).reconcileQuestions(file, [], file.id);
        job.question_ids = [];
      }
      const pending = await query(
        db,
        sql`SELECT q.id FROM ${ident(schemas.app, 'ingest_questions')} q
        WHERE q.org_id = ${file.orgId} AND q.table_id = ${file.tableId} AND q.active
          AND q.document->'target'->>'file' = ${file.id} LIMIT 1`,
      );
      if (!pending.rowCount)
        for (const state of ['waiting', 'reading', 'read'] as const)
          updated = await tables.updateFile({ ...file, userId }, file.id, { state, holdReason: null });
      await this.store.saveJob(db, { file, token: '', job });
      return updated;
    });
  }
}

export function installIngest(app: FastifyInstance): IngestWorker {
  const worker = new IngestWorker(app, { readWithAi: createAiReader(app.ctx) });
  app.ctx.ingest = worker;
  app.addHook('onReady', async () => worker.start());
  app.addHook('onClose', async () => worker.close());
  return worker;
}
