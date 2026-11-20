import { AppError, IngestLiveRequest, type IngestLiveEvent } from '@riosoma/contracts';
import { compile, ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import { actorFor } from '../../automations/run.js';
import { auditEvent } from '../../auth/database.js';
import { dataStore } from '../../data/context.js';
import { changesChannel } from '../../data/notify.js';
import { message } from '../../api-v1/messages.js';
import type { IngestWorker } from '../pipeline/worker.js';
import { removeIngestFileRows } from '../write/index.js';
import { stableId } from '../write/storage.js';
import { requireEvidenceAccess } from '../setup/evidence.js';
import { liveAccess, type LiveAccess } from './access.js';

async function announceQuestion(
  a: LiveAccess,
  questionId: string,
  state: 'open' | 'answered',
  db: Queryable = a.c.db,
) {
  const event: IngestLiveEvent = {
    type: 'ingestChanged',
    databaseId: a.table.databaseId,
    tableId: a.table.id,
    kind: 'question',
    id: questionId,
    state,
  };
  await query(db, sql`SELECT pg_notify(${changesChannel(a.c.schemas)}, ${JSON.stringify(event)})`);
}

export async function queueWork(
  a: LiveAccess,
  fileId: string,
  action: 'answer' | 'remove',
  id: string,
  questionId?: string,
) {
  const undoGroupId = action === 'remove' ? stableId('act', a.table.id, fileId, id, 'remove') : null;
  await query(
    a.c.db,
    sql`INSERT INTO ${ident(a.c.schemas.app, 'ingest_live_requests')}
    (id, org_id, table_id, file_id, user_id, action, undo_group_id)
    VALUES (${id}, ${a.context.orgId}, ${a.table.id}, ${fileId}, ${a.c.actor.userId}, ${action}, ${undoGroupId})`,
  );
  if (action === 'remove')
    await auditEvent(
      a.c.db,
      compile(sql`${ident(a.c.schemas.audit)}`).text,
      'data.ingest.file.removeRequested',
      a.c.actor,
      { tableId: a.table.id, fileId, requestId: id },
    );
  // Saving an answer does not settle its question until the requested writes succeed.
  if (questionId) await announceQuestion(a, questionId, 'open');
  return IngestLiveRequest.parse({ id, state: 'queued', messageId: null, undoGroupId });
}

export async function retryAnswerWork(a: LiveAccess, requestId: string) {
  const found = await query<{
    action: string;
    state: string;
    question_id: string | null;
    question_version: string | null;
    version: string | null;
    active: boolean | null;
  }>(
    a.c.db,
    sql`SELECT r.action, r.state, answer.question_id, answer.question_version, q.version, q.active
      FROM ${ident(a.c.schemas.app, 'ingest_live_requests')} r
      LEFT JOIN ${ident(a.c.schemas.app, 'ingest_answers')} answer ON answer.id = r.id
        AND answer.org_id = r.org_id AND answer.table_id = r.table_id
      LEFT JOIN ${ident(a.c.schemas.app, 'ingest_questions')} q ON q.id = answer.question_id
        AND q.org_id = answer.org_id AND q.table_id = answer.table_id
      WHERE r.id = ${requestId} AND r.org_id = ${a.context.orgId} AND r.table_id = ${a.table.id}`,
  );
  const request = found.rows[0];
  if (!request) throw new AppError('not_found', 'errors.notFound');
  if (request.action !== 'answer' || request.state !== 'failed')
    throw new AppError('conflict', 'ingest.live.retryUnavailable');
  if (!request.question_id || !request.active || request.question_version !== request.version)
    throw new AppError('conflict', 'ingest.decisions.staleAnswer');
  await query(
    a.c.db,
    sql`UPDATE ${ident(a.c.schemas.app, 'ingest_live_requests')}
      SET state = 'queued', message_id = NULL, lease_until = NULL WHERE id = ${requestId}`,
  );
  await auditEvent(
    a.c.db,
    compile(sql`${ident(a.c.schemas.audit)}`).text,
    'data.ingest.answer.retryRequested',
    a.c.actor,
    { tableId: a.table.id, questionId: request.question_id, requestId },
  );
  await announceQuestion(a, request.question_id, 'open');
  return IngestLiveRequest.parse({ id: requestId, state: 'queued', messageId: null, undoGroupId: null });
}

/** Leased requests keep slow row writes outside the route and preserve writer checkpoints on recovery. */
export async function runLiveWork(worker: IngestWorker): Promise<boolean> {
  if (!worker.app.ctx.pool || !worker.app.ctx.config.database) return false;
  const { pool, schemas } = dataStore(worker.app.ctx);
  const request = await withTransaction(pool, async (db) => {
    const result = await query<{
      id: string;
      org_id: string;
      table_id: string;
      file_id: string;
      user_id: string;
      action: string;
    }>(
      db,
      sql`UPDATE ${ident(schemas.app, 'ingest_live_requests')} SET state = 'running', lease_until = now() + interval '5 minutes'
      WHERE id = (SELECT r.id FROM ${ident(schemas.app, 'ingest_live_requests')} r
        JOIN ${ident(schemas.app, 'ingest_files')} f ON f.org_id = r.org_id AND f.table_id = r.table_id AND f.id = r.file_id
        WHERE (r.state = 'queued' OR (r.state = 'running' AND r.lease_until <= now())) AND f.state <> 'reading'
          AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'ingest_live_requests')} other
            WHERE other.org_id = r.org_id AND other.table_id = r.table_id AND other.file_id = r.file_id
              AND other.id <> r.id AND other.state = 'running' AND other.lease_until > now())
        ORDER BY r.created_at, r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED) RETURNING *`,
    );
    return result.rows[0];
  });
  if (!request) return false;
  const renew = setInterval(() => {
    void query(
      pool,
      sql`UPDATE ${ident(schemas.app, 'ingest_live_requests')} SET lease_until = now() + interval '5 minutes'
      WHERE id = ${request.id} AND state = 'running'`,
    ).catch(() => undefined);
  }, 60_000);
  renew.unref();
  let access: LiveAccess | undefined;
  let questionId: string | undefined;
  try {
    const actor = await actorFor(pool, schemas, request.user_id, request.org_id);
    if (!actor) throw new AppError('forbidden', 'data.access.denied');
    access = await liveAccess(worker.app, actor, request.table_id, pool, true);
    if (request.action === 'answer') {
      const saved = await query<{ question_id: string; target: string; response: string }>(
        pool,
        sql`SELECT question_id, question_document->'target'->>'type' AS target, response->>'type' AS response
          FROM ${ident(schemas.app, 'ingest_answers')} WHERE org_id = ${request.org_id} AND table_id = ${request.table_id} AND id = ${request.id}`,
      );
      const answer = saved.rows[0];
      if (!answer) throw new AppError('not_found', 'errors.notFound');
      questionId = answer.question_id;
      await requireEvidenceAccess(access.c, request.table_id);
      await worker.resumeFile(
        request.file_id,
        request.user_id,
        answer.target === 'field' && answer.response === 'answer' ? answer.question_id : undefined,
      );
    } else {
      const result = await removeIngestFileRows(access.table, request.file_id, request.id, {
        app: worker.app,
        message,
        allowPaused: true,
        userId: request.user_id,
      });
      if (result.status !== 'written' || result.refused.length)
        throw new AppError('conflict', result.messageId ?? 'ingest.pipeline.writeStopped');
    }
    await withTransaction(pool, async (db) => {
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'ingest_live_requests')}
        SET state = 'complete', lease_until = NULL WHERE id = ${request.id}`,
      );
      if (access && questionId) await announceQuestion(access, questionId, 'answered', db);
    });
  } catch (error) {
    await withTransaction(pool, async (db) => {
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'ingest_live_requests')}
        SET state = 'failed', lease_until = NULL, message_id = ${error instanceof AppError ? error.messageKey : 'errors.internal'}
        WHERE id = ${request.id}`,
      );
      if (access && questionId) await announceQuestion(access, questionId, 'open', db);
    });
  } finally {
    clearInterval(renew);
  }
  return true;
}
