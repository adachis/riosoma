import type { StoredTable } from '../../data/types.js';
import { createHash } from 'node:crypto';
import { AppError, IngestOrganizationSettings, type IngestFile } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import { actorFor } from '../../automations/run.js';
import { AccessScope } from '../../data/access.js';
import { inspectOriginal, storeOriginal, type OriginalRow } from '../../data/files/originals.js';
import { fileStorage } from '../../data/files/storage.js';
import { loadTable } from '../../data/metadata.js';
import { refuseDemo } from '../../demo/boundary.js';
import { fileQuestion } from './reading.js';
import { notify } from '../../notifications/produce.js';
import type { PipelineStore } from './store.js';

export async function requireEditor(store: PipelineStore, db: Queryable, table: StoredTable, userId: string) {
  const actor = await actorFor(db, store.data.schemas, userId, table.orgId);
  if (!actor) throw new AppError('forbidden', 'data.access.denied');
  refuseDemo(actor);
  const scope = new AccessScope(db, store.data.schemas, actor);
  await scope.require(table.databaseId, 'editRecords');
  return scope;
}

export interface ReceiveInput {
  bytes: Buffer;
  name: string;
  droppedBy: string;
}

/** Inspection finishes before the table transaction starts, and refused bytes never enter storage. */
export async function receiveFile(
  store: PipelineStore,
  table: StoredTable,
  input: ReceiveInput,
): Promise<IngestFile> {
  const { pool, schemas } = store.data;
  const current = await loadTable(pool, schemas, table.id);
  if (!current || current.orgId !== table.orgId) throw new AppError('not_found', 'errors.notFound');
  await requireEditor(store, pool, current, input.droppedBy);
  if (!current.ingest || !['live', 'paused'].includes(current.ingest.state))
    throw new AppError('conflict', 'ingest.pipeline.inactive');
  let inspected: Awaited<ReturnType<typeof inspectOriginal>> | undefined;
  let reason: string | undefined;
  try {
    inspected = await inspectOriginal(pool, schemas.app, store.app.ctx.config, table.orgId, input, true);
    if (inspected.safety.state === 'held') reason = inspected.safety.reason;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    reason = error.messageKey;
  }
  const outside: OriginalRow[] = [];
  try {
    return await store.locked({ orgId: table.orgId, tableId: table.id }, async (db, locked) => {
      await requireEditor(store, db, locked, input.droppedBy);
      const settings = locked.ingest;
      if (!settings || !['live', 'paused'].includes(settings.state))
        throw new AppError('conflict', 'ingest.pipeline.inactive');
      const context = { orgId: locked.orgId, tableId: locked.id, userId: input.droppedBy };
      const tables = store.tables.inTransaction(db);
      const hash = createHash('sha256').update(input.bytes).digest('hex');
      const duplicate = await query(
        db,
        sql`SELECT id FROM ${ident(schemas.app, 'ingest_files')}
        WHERE org_id = ${table.orgId} AND table_id = ${table.id} AND sha256 = ${hash} LIMIT 1`,
      );
      const org = await query<{ settings: { ingest?: unknown } }>(
        db,
        sql`SELECT settings FROM ${ident(schemas.app, 'orgs')} WHERE id = ${table.orgId}`,
      );
      const days =
        settings.originals.keepDays ??
        IngestOrganizationSettings.parse(org.rows[0]?.settings.ingest ?? {}).originalKeepDays;
      let file = await tables.createFile(context, {
        origin: 'drop',
        name: input.name,
        mediaType: inspected?.type ?? 'application/octet-stream',
        sizeBytes: input.bytes.length,
        sha256: hash,
        storedFile: null,
        droppedBy: input.droppedBy,
        expiresAt: days === 'forever' ? null : new Date(Date.now() + days * 86_400_000).toISOString(),
      });
      if (inspected)
        file = await tables.updateFile(context, file.id, {
          checks: { originalSafety: inspected.safety },
          notes:
            inspected.safety.state === 'noted'
              ? inspected.safety.notes.map((messageId) => ({ messageId }))
              : [],
        });
      const retryable = reason === 'files.checks.scannerUnavailable';
      if (inspected && (!reason || retryable)) {
        const original = await storeOriginal(
          db,
          schemas.app,
          store.app.ctx.config,
          { orgId: table.orgId, tableId: table.id, fileId: file.id, userId: input.droppedBy },
          input,
          (row) => outside.push(row),
          inspected,
        );
        file = await tables.updateFile(context, file.id, { storedFile: original.id });
      }
      const holdReason = reason ?? (duplicate.rowCount ? 'ingest.pipeline.seenBefore' : null);
      if (holdReason)
        file = await tables.updateFile(context, file.id, {
          state: retryable ? 'waiting' : 'held',
          holdReason,
          nextAttemptAt: retryable ? new Date(Date.now() + 2_000).toISOString() : null,
          notes: [{ messageId: holdReason }],
          checks: inspected ? { originalSafety: inspected.safety } : {},
        });
      if (!holdReason && settings.state === 'paused')
        file = await tables.updateFile(context, file.id, {
          state: 'waiting',
          holdReason: 'ingest.pipeline.paused',
        });
      const job = await store.job(db, file);
      if (holdReason === 'files.checks.passwordProtected') {
        const question = fileQuestion(file, 'passwordProtected', holdReason);
        await store.decisions.inTransaction(db).raiseQuestion(file, question);
        job.question_ids.push(question.id);
        job.notified_questions.push(question.id);
        if (settings.ownerId)
          await notify(db, schemas, {
            orgId: file.orgId,
            recipientId: settings.ownerId,
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
      }
      if (retryable && duplicate.rowCount) {
        file = await tables.updateFile(context, file.id, {
          notes: [...file.notes, { messageId: 'ingest.pipeline.seenBefore' }],
        });
      }
      await store.report(db, locked, file, job);
      await store.saveJob(db, { file, token: '', job });
      return file;
    });
  } catch (error) {
    // Outside storage does not roll back with the database that owns it.
    for (const original of outside)
      await fileStorage(original.storage, pool, schemas.app, store.app.ctx.config).delete(
        original.storage_key,
      );
    throw error;
  }
}
