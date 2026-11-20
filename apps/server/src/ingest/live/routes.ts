import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  IngestDecisionQuestion,
  IngestLiveAnswer,
  IngestLivePage,
  IngestLiveRequest,
  SPREADSHEET_LIMITS,
  TableId,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { requireActor } from '../../auth/sessions.js';
import { parse } from '../../http/validate.js';
import { dataStore } from '../../data/context.js';
import { fileName } from '../../data/files/detect.js';
import { uploadLimit } from '../../data/files/settings.js';
import { requireEvidenceAccess } from '../setup/evidence.js';
import { kind } from '../pipeline/reading.js';
import { PipelineStore, receiveFile } from '../pipeline/index.js';
import { liveAccess, type LiveAccess } from './access.js';
import { files, formats, questions, rules, summary } from './store.js';
import { loadStudy, saveStudy } from '../study/store.js';
import { queueWork, retryAnswerWork } from './work.js';

const base = '/api/tables/:tableId/ingest';
const session = { config: { policy: { kind: 'session' as const, beforeBody: true as const } } };
const params = z.object({ tableId: TableId });
const fileParams = params.extend({ fileId: z.string().uuid() });
const notFound = () => new AppError('not_found', 'errors.notFound');
const tooLarge = () => new AppError('payload_too_large', 'data.file.tooLarge');

async function fileEntry(a: LiveAccess, fileId: string) {
  const entry = (await files(a, { limit: 1, offset: 0 }, fileId)).items[0];
  if (!entry) throw notFound();
  return entry;
}

export async function ingestLiveRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  const store = new PipelineStore(app);
  const read = async (request: Parameters<typeof requireActor>[0], edit = false) =>
    liveAccess(app, requireActor(request), parse(params, request.params).tableId, undefined, edit);

  // This parser belongs only to the upload plugin.  It hands the authenticated route an unread stream.
  await app.register(async (upload) => {
    upload.removeAllContentTypeParsers();
    upload.addContentTypeParser('*', (_request, payload, done) => {
      done(null, payload);
    });
    upload.post(`${base}/files`, session, async (request, reply) => {
      const a = await read(request, true);
      const name = fileName(request.headers['x-file-name']);
      const { pool, schemas } = dataStore(app.ctx);
      const limit = Math.min(
        SPREADSHEET_LIMITS.uploadBytes,
        await uploadLimit(pool, schemas.app, a.context.orgId),
      );
      if (Number(request.headers['content-length'] ?? 0) > limit) throw tooLarge();
      if (!(request.body instanceof Readable))
        throw new AppError('bad_request', 'ingest.live.uploadRequired');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request.body) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        if (size > limit) throw tooLarge();
        chunks.push(bytes);
      }
      const file = await receiveFile(store, a.table, {
        name,
        bytes: Buffer.concat(chunks, size),
        droppedBy: a.c.actor.userId,
      });
      reply.code(201);
      return fileEntry(await read(request), file.id);
    });
  });
  app.get(`${base}/files`, session, async (request) =>
    files(await read(request), parse(IngestLivePage, request.query)),
  );
  app.get(`${base}/files/:fileId`, session, async (request) => {
    const { fileId } = parse(fileParams, request.params);
    const a = await read(request);
    const entry = await fileEntry(a, fileId);
    const input = parse(IngestLivePage, request.query);
    const open = await questions(a, input, 'all', fileId);
    return { ...entry, questions: open.items, questionsNextOffset: open.nextOffset };
  });
  for (const [action, method] of [
    ['retry', 'retryFile'],
    ['read-anyway', 'readAnyway'],
    ['skip', 'skipFile'],
  ] as const)
    app.post(`${base}/files/:fileId/${action}`, session, async (request) => {
      const a = await read(request, true);
      const { fileId } = parse(fileParams, request.params);
      await fileEntry(a, fileId);
      await app.ctx.ingest![method](fileId, a.c.actor.userId);
      return fileEntry(await read(request), fileId);
    });
  app.post(`${base}/files/:fileId/remove-rows`, session, async (request, reply) => {
    const { tableId, fileId } = parse(fileParams, request.params);
    const actor = requireActor(request);
    const result = await store.locked({ orgId: actor.orgId, tableId }, async (db) => {
      const a = await liveAccess(app, actor, tableId, db, true);
      const file = await fileEntry(a, fileId);
      if (['reading', 'removed'].includes(file.state)) throw new AppError('conflict', 'ingest.files.state');
      return queueWork(a, fileId, 'remove', randomUUID());
    });
    reply.code(202);
    return result;
  });
  app.get(`${base}/questions`, session, async (request) => {
    const input = parse(
      IngestLivePage.extend({ state: z.enum(['open', 'answered']).default('open') }),
      request.query,
    );
    return questions(await read(request), input, input.state);
  });
  app.post(`${base}/questions/:questionId/answer`, session, async (request, reply) => {
    const { tableId, questionId } = parse(
      params.extend({ questionId: z.string().min(1).max(4096) }),
      request.params,
    );
    const actor = requireActor(request);
    const input = parse(IngestLiveAnswer, request.body);
    const result = await store.locked({ orgId: actor.orgId, tableId }, async (db) => {
      const a = await liveAccess(app, actor, tableId, db, true);
      await requireEvidenceAccess(a.c, tableId);
      const found = await query<{ document: object; active: boolean }>(
        db,
        sql`SELECT document, active FROM ${ident(a.c.schemas.app, 'ingest_questions')}
        WHERE org_id = ${actor.orgId} AND table_id = ${tableId} AND id = ${questionId}`,
      );
      if (!found.rows[0]) throw notFound();
      const question = IngestDecisionQuestion.parse({
        ...found.rows[0].document,
        ...a.context,
        active: found.rows[0].active,
      });
      const prior = await query(
        db,
        sql`SELECT id FROM ${ident(a.c.schemas.app, 'ingest_answers')}
        WHERE org_id = ${actor.orgId} AND table_id = ${tableId} AND question_id = ${questionId} AND question_version = ${question.version} LIMIT 1`,
      );
      if (prior.rowCount) throw new AppError('conflict', 'ingest.live.alreadyAnswered');
      if (!question.active) throw new AppError('conflict', 'ingest.decisions.staleAnswer');
      const permissions = {
        ...a.context,
        userId: actor.userId,
        canEditRecords: true,
        canEditSchema: a.schema,
      };
      const decisions = store.decisions.inTransaction(db);
      const saved = await decisions.answerQuestion(permissions, { questionId, ...input });
      if (saved.status === 'stale') throw new AppError('conflict', saved.messageId);
      const study = await loadStudy(store, a.context, question.target.file, db);
      if (study && input.source && question.target.type === 'field' && question.kind === 'valueSource') {
        study.sources[question.target.field] = input.source;
        await saveStudy(store, a.context, question.target.file, study, db);
      }
      if (input.remember) {
        const standard =
          kind(question.kind) ??
          (question.kind === 'column' ? { ...kind('unknownColumn'), id: 'column' } : undefined);
        const definition = standard && {
          ...standard,
          answerType: question.form.type,
          allowedScopes: question.allowedScopes,
        };
        if (!definition) throw new AppError('validation_failed', 'ingest.decisions.invalidRule');
        await decisions.rememberAnswer(
          permissions,
          saved.answer.id,
          definition,
          input.scope!,
          question.kind === 'column'
            ? { eq: { input: 'heading', value: { type: 'text', value: question.evidence[0]!.column! } } }
            : question.target.type === 'field'
              ? { eq: { input: 'field', value: { type: 'text', value: question.target.field } } }
              : { all: [] },
          'records',
        );
      }
      return queueWork(a, question.target.file, 'answer', saved.answer.id, question.id);
    });
    reply.code(202);
    return result;
  });
  app.get(`${base}/rules`, session, async (request) =>
    rules(await read(request), parse(IngestLivePage, request.query)),
  );
  app.post(`${base}/rules/:ruleId/off`, session, async (request) => {
    const { tableId, ruleId } = parse(params.extend({ ruleId: z.string().uuid() }), request.params);
    const actor = requireActor(request);
    await store.locked({ orgId: actor.orgId, tableId }, async (db) => {
      const a = await liveAccess(app, actor, tableId, db);
      await store.decisions
        .inTransaction(db)
        .switchOffRule(
          { ...a.context, userId: actor.userId, canEditRecords: true, canEditSchema: a.schema },
          ruleId,
        );
    });
    return { id: ruleId, enabled: false };
  });
  app.get(`${base}/formats`, session, async (request) => {
    const input = parse(
      IngestLivePage.extend({ examplesOffset: z.coerce.number().int().min(0).max(100_000).default(0) }),
      request.query,
    );
    return formats(await read(request), input, { limit: 25, offset: input.examplesOffset });
  });
  app.get(`${base}/summary`, session, async (request) => summary(await read(request)));
  app.post(`${base}/requests/:requestId/retry`, session, async (request, reply) => {
    const { tableId, requestId } = parse(params.extend({ requestId: z.string().uuid() }), request.params);
    const actor = requireActor(request);
    const result = await store.locked({ orgId: actor.orgId, tableId }, async (db) => {
      const a = await liveAccess(app, actor, tableId, db, true);
      await requireEvidenceAccess(a.c, tableId);
      return retryAnswerWork(a, requestId);
    });
    reply.code(202);
    return result;
  });
  app.get(`${base}/requests/:requestId`, session, async (request) => {
    const a = await read(request);
    const { requestId } = parse(params.extend({ requestId: z.string().uuid() }), request.params);
    const result = await query<{
      id: string;
      state: string;
      message_id: string | null;
      undo_group_id: string | null;
    }>(
      a.c.db,
      sql`SELECT id, state, message_id, undo_group_id FROM ${ident(a.c.schemas.app, 'ingest_live_requests')}
      WHERE org_id = ${a.context.orgId} AND table_id = ${a.table.id} AND id = ${requestId}`,
    );
    const row = result.rows[0];
    if (!row) throw notFound();
    return IngestLiveRequest.parse({
      id: row.id,
      state: row.state,
      messageId: row.message_id,
      undoGroupId: row.undo_group_id,
    });
  });
}
