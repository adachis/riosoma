import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  IngestStudy,
  IngestStudyAssumptionAnswer,
  IngestDecisionQuestion,
  TableId,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { responseAllowed, normalizeMarker, type QuestionResponse } from '@riosoma/ingest';
import { requireActor } from '../../auth/sessions.js';
import { parse } from '../../http/validate.js';
import { currentValues } from '../../data/physical/records.js';
import { loadFields } from '../../data/metadata.js';
import { loadOriginal } from '../../data/files/originals.js';
import { extractSource } from '../extract/index.js';
import { headings, headingValue } from './questions.js';
import { message } from '../../api-v1/messages.js';
import { liveAccess, type LiveAccess } from '../live/access.js';
import { questions } from '../live/store.js';
import { requireEvidenceAccess } from '../setup/evidence.js';
import { organizationIngest } from '../originals/retention.js';
import { PipelineStore } from '../pipeline/store.js';
import { answerIngestRows, removeIngestFileRows } from '../write/index.js';
import { loadStudy, saveStudy } from './store.js';
import { createStudyField } from './fields.js';
import { recheckFormat } from './validation.js';
import { answeredValue, kind, sameLocation } from '../pipeline/reading.js';

const base = '/api/tables/:tableId/ingest/files/:fileId';
const params = z.object({ tableId: TableId, fileId: z.string().uuid() });
const session = { config: { policy: { kind: 'session' as const, beforeBody: true as const } } };
const notFound = () => new AppError('not_found', 'errors.notFound');

export async function expectedRows(a: LiveAccess, fileId: string) {
  const fields = await loadFields(a.c.db, a.c.schemas, [a.table.id]);
  const ids = await query<{ record_id: string }>(
    a.c.db,
    sql`SELECT record_id FROM ${ident(a.c.schemas.app, 'ingest_row_state')}
    WHERE org_id = ${a.context.orgId} AND table_id = ${a.table.id} AND file_id = ${fileId} ORDER BY at->>'sheet', (at->>'row')::integer, record_id`,
  );
  const values = await currentValues(
    a.c.db,
    a.c.schemas.data,
    a.table.id,
    fields,
    ids.rows.map((row) => row.record_id),
  );
  return ids.rows.flatMap(({ record_id: id }) =>
    values.has(id)
      ? [
          {
            values: Object.fromEntries(
              a.table.ingest!.fields.map((field) => [field.key, values.get(id)![field.fieldId] ?? null]),
            ),
          },
        ]
      : [],
  );
}

export async function ingestStudyRoutes(app: FastifyInstance) {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  const store = new PipelineStore(app);
  app.get(`${base}/study`, session, async (request) => {
    const { tableId, fileId } = parse(params, request.params);
    const a = await liveAccess(app, requireActor(request), tableId);
    if (!(await store.tables.readFile(a.context, fileId))) throw notFound();
    const study = await loadStudy(store, a.context, fileId);
    if (!study) throw notFound();
    const entries = await questions(a, { limit: 100, offset: 0 }, 'all', fileId);
    return IngestStudy.parse({
      fileId,
      state: study.state,
      messageId: study.messageId,
      ...(study.state === 'unavailable' && study.build.reason ? { reason: study.build.reason } : {}),
      formatId: study.formatId,
      approvalPending: study.approvalPending,
      spentUsd: study.build.spentUsd,
      evidenceWithheld: !a.evidence,
      questions: entries.items,
      assumptions: study.assumptions.map((assumption) => ({
        id: assumption.id,
        messageId: assumption.messageId,
        reasonId: a.evidence ? assumption.reasonId : 'ingest.study.assumed',
        confirmed: assumption.confirmed,
        evidenceWithheld: !a.evidence,
        ...(a.evidence
          ? {
              answer: assumption.answer,
              question: IngestDecisionQuestion.parse({ ...assumption.question, ...a.context, active: true }),
            }
          : {}),
      })),
    });
  });
  app.post(`${base}/study/assumptions/:assumptionId`, session, async (request) => {
    const { tableId, fileId, assumptionId } = parse(
      params.extend({ assumptionId: z.string().min(1).max(4096) }),
      request.params,
    );
    const actor = requireActor(request);
    const input = parse(IngestStudyAssumptionAnswer, request.body);
    let changedFormatId: string | null = null;
    const result = await store.locked({ orgId: actor.orgId, tableId }, async (db) => {
      const a = await liveAccess(app, actor, tableId, db, true);
      await requireEvidenceAccess(a.c, tableId);
      const tables = store.tables.inTransaction(db);
      const study = await loadStudy(store, a.context, fileId, db);
      const assumption = study?.assumptions.find((entry) => entry.id === assumptionId);
      if (!study || !assumption) throw notFound();
      if (input.action === 'change' && input.response.type !== 'skipFile' && study.formatId && !a.schema)
        throw new AppError('forbidden', 'ingest.decisions.ruleForbidden');
      const file = await tables.readFile(a.context, fileId);
      if (!file || file.state === 'reading') throw new AppError('conflict', 'ingest.files.state');
      if (input.action === 'change' && !responseAllowed(assumption.question, input.response))
        throw new AppError('validation_failed', 'ingest.decisions.invalidAnswer');
      const before = assumption.answer;
      assumption.confirmed = true;
      if (input.action === 'change') {
        assumption.answer = input.response;
        study.overrides[assumptionId] = input.response;
        const question = assumption.question;
        if (input.response.type === 'skipFile') {
          // Resuming a completed file uses its existing state path, and the transaction hides the intermediate state.
          if (file.state === 'read')
            await tables.updateFile({ ...a.context, userId: actor.userId }, fileId, { state: 'waiting' });
          const removed = await removeIngestFileRows(
            a.table,
            fileId,
            `assumption-skip:${assumptionId}:${randomUUID()}`,
            {
              app,
              message,
              allowPaused: true,
              userId: actor.userId,
              transaction: db,
              preserveFileState: true,
            },
          );
          if (removed.status !== 'written' || removed.refused.length)
            throw new AppError('conflict', removed.messageId ?? 'ingest.pipeline.writeStopped');
          await tables.updateFile({ ...a.context, userId: actor.userId }, fileId, {
            state: 'skipped',
            holdReason: null,
            leasedBy: null,
            leaseUntil: null,
            nextAttemptAt: null,
          });
          study.state = 'skipped';
        }
        const field =
          question.target.type === 'field'
            ? question.target.field
            : before.type === 'answer' && before.answer.type === 'choice'
              ? before.answer.value
              : null;
        if (field && (input.response.type === 'answer' || input.response.type === 'unknown')) {
          let changedField =
            question.kind === 'column' &&
            input.response.type === 'answer' &&
            input.response.answer.type === 'choice'
              ? input.response.answer.value
              : field;
          let createdFieldKey: string | undefined;
          if (changedField === 'ownField') {
            const heading = question.evidence[0]?.column ?? field;
            if (a.schema) {
              changedField = await createStudyField(app, actor, a.table, study, heading, db);
              createdFieldKey = changedField;
            } else {
              if (!study.fieldRequests.includes(heading)) study.fieldRequests.push(heading);
              changedField = 'leaveOut';
            }
            study.overrides[assumptionId] = {
              type: 'answer',
              answer: { type: 'choice', value: changedField },
            };
            if (a.schema) assumption.answer = study.overrides[assumptionId]!;
          }
          const omitted = changedField === 'leaveOut';
          const unknown = input.response.type === 'unknown';
          const bytes = await loadOriginal(a.c.db, a.c.schemas.app, app.ctx.config, file);
          const extracted = bytes && (await extractSource(file.name, bytes));
          if (!extracted || extracted.status !== 'extracted' || !study.draft)
            throw new AppError('conflict', 'ingest.pipeline.originalExpired');
          const heading = headings(extracted.source, study.draft).find(
            (entry) => normalizeMarker(entry.heading) === normalizeMarker(question.evidence[0]?.column ?? ''),
          );
          if (question.kind === 'column' && !heading)
            throw new AppError('conflict', 'ingest.pipeline.readFailed');
          for (const row of study.reading?.rows ?? []) {
            if (
              question.target.type === 'field' &&
              question.target.rows.length &&
              !question.target.rows.some((at) => sameLocation(at, row.at))
            )
              continue;
            const value = unknown
              ? (row.values[field] ?? null)
              : omitted
                ? null
                : question.kind === 'column'
                  ? headingValue(extracted.source, row.at, heading!)
                  : answeredValue(
                      {
                        item: {
                          kind: kind(question.kind) ?? kind('blankRequiredValue'),
                          inputs: {},
                          value: row.raw[field] ?? question.scopeContext.value,
                        },
                        question,
                      },
                      input.response as Extract<QuestionResponse, { type: 'answer' }>,
                    );
            const reasons = unknown
              ? [
                  {
                    messageId: question.messageId,
                    fieldKey: field,
                    source: { kind: 'question' as const, questionId: assumptionId },
                  },
                ]
              : [];
            const targetField = omitted ? field : changedField;
            const result = await answerIngestRows(
              a.table,
              assumptionId,
              value,
              `assumption:${assumptionId}:${randomUUID()}`,
              {
                app,
                message,
                allowPaused: true,
                userId: actor.userId,
                transaction: db,
                createdFieldKeys: createdFieldKey ? [createdFieldKey] : [],
              },
              { fileId, field: targetField, at: [row.at], reasons },
            );
            if (result.status !== 'written' || result.refused.length)
              throw new AppError('conflict', result.messageId ?? 'ingest.pipeline.writeStopped');
            row.values[targetField] = value;
            row.reasons = [
              ...(row.reasons ?? []).filter(
                (reason) => !(reason.source.kind === 'question' && reason.source.questionId === assumptionId),
              ),
              ...reasons,
            ];
            if (heading) row.raw[targetField] = String(headingValue(extracted.source, row.at, heading) ?? '');
          }
          if (study.draft.reading === 'layout') {
            if (unknown || omitted) {
              delete study.draft.rules.columns[field];
              study.draft.rules.constants = { ...study.draft.rules.constants, [field]: null };
              study.ignored.push(normalizeMarker(question.evidence[0]?.column ?? field));
            } else if (question.kind === 'column') {
              const column =
                input.response.type === 'answer' && input.response.answer.value === 'ownField'
                  ? { aliases: [heading!.heading], cleaners: [{ kind: 'text' as const }] }
                  : study.draft.rules.columns[field];
              if (column) {
                delete study.draft.rules.columns[field];
                study.draft.rules.columns[changedField] = column;
              }
            } else if (
              question.kind === 'numericDateOrder' &&
              input.response.type === 'answer' &&
              input.response.answer.type === 'choice'
            ) {
              for (const cleaner of study.draft.rules.columns[field]?.cleaners ?? [])
                if (cleaner.kind === 'date')
                  cleaner.formats = [
                    input.response.answer.value === 'monthFirst' ? 'MM/DD/YYYY' : 'DD/MM/YYYY',
                  ];
            } else if (input.response.type === 'answer' && input.response.answer.type !== 'mapping')
              study.draft.rules.constants = {
                ...study.draft.rules.constants,
                [field]: input.response.answer.value,
              };
          } else {
            const bindings = study.draft.rules.bindings ?? {};
            if (question.kind === 'column' && !unknown && !omitted) {
              const binding = bindings[field];
              delete bindings[field];
              bindings[changedField] = binding ?? { kind: 'column', aliases: [heading!.heading] };
            } else if (
              question.kind === 'numericDateOrder' &&
              input.response.type === 'answer' &&
              input.response.answer.type === 'choice'
            ) {
              const binding = bindings[field];
              if (binding?.kind === 'column')
                binding.dateFormats = [
                  input.response.answer.value === 'monthFirst' ? 'MM/DD/YYYY' : 'DD/MM/YYYY',
                ];
            } else if (
              unknown ||
              omitted ||
              (input.response.type === 'answer' && input.response.answer.type !== 'mapping')
            )
              bindings[field] = {
                kind: 'fixed',
                value:
                  input.response.type === 'answer' && input.response.answer.type !== 'mapping' && !omitted
                    ? input.response.answer.value
                    : null,
              };
            study.draft.rules.bindings = bindings;
          }
        }
      }
      await saveStudy(store, a.context, fileId, study, db);
      if (input.action === 'change' && input.response.type !== 'skipFile' && study.formatId && study.draft) {
        if (!a.schema) throw new AppError('forbidden', 'ingest.decisions.ruleForbidden');
        const format = await store.tables.inTransaction(db).readFormat(a.context, study.formatId);
        if (format)
          await store.tables
            .inTransaction(db)
            .updateFormat({ ...a.context, userId: actor.userId }, format.id, format.revision, {
              ...study.draft,
              name: format.name,
              state: format.state,
              probationPassed: format.probationPassed,
            });
      }
      if (input.action === 'change' && input.response.type !== 'skipFile') changedFormatId = study.formatId;
      return { id: assumptionId, confirmed: true };
    });
    if (changedFormatId)
      await recheckFormat(app.ctx.ingest!, { orgId: actor.orgId, tableId }, changedFormatId);
    return result;
  });
  app.post(`${base}/study/approve`, session, async (request) => {
    const { tableId, fileId } = parse(params, request.params);
    const actor = requireActor(request);
    await store.locked({ orgId: actor.orgId, tableId }, async (db) => {
      const a = await liveAccess(app, actor, tableId, db, true);
      await requireEvidenceAccess(a.c, tableId);
      if (!a.schema) throw new AppError('forbidden', 'ingest.decisions.ruleForbidden');
      const study = await loadStudy(store, a.context, fileId, db);
      const question = study?.questions.find((entry) => entry.kind === 'keepRules');
      if (!study?.approvalPending || !question) throw new AppError('conflict', 'ingest.study.noApproval');
      const prior = await store.decisions.inTransaction(db).findAnswer(a.context, question.id);
      const response: QuestionResponse = prior?.response ?? {
        type: 'answer',
        answer: { type: 'choice', value: 'layout' },
      };
      await store.decisions
        .inTransaction(db)
        .answerQuestion(
          { ...a.context, userId: actor.userId, canEditRecords: true, canEditSchema: true },
          { questionId: question.id, questionVersion: question.version, response },
        );
    });
    await app.ctx.ingest!.resumeFile(fileId, actor.userId);
    return { fileId, state: 'queued' };
  });
  app.post(`${base}/pass`, session, async (request) => {
    const { tableId, fileId } = parse(params, request.params);
    const actor = requireActor(request);
    return store.locked({ orgId: actor.orgId, tableId }, async (db) => {
      const a = await liveAccess(app, actor, tableId, db, true);
      await requireEvidenceAccess(a.c, tableId);
      const tables = store.tables.inTransaction(db);
      const file = await tables.readFile(a.context, fileId);
      if (!file?.formatId || !['read', 'held'].includes(file.state))
        throw new AppError('conflict', 'ingest.files.state');
      const format = await tables.readFormat(a.context, file.formatId);
      if (!format || !['probation', 'live'].includes(format.state))
        throw new AppError('conflict', 'ingest.files.state');
      const passed = Array.isArray(file.checks.probationFormats)
        ? (file.checks.probationFormats as string[])
        : [];
      if (passed.includes(format.id)) return { fileId, formatId: format.id, state: format.state };
      const expected = await expectedRows(a, fileId);
      if (!expected.length) throw new AppError('conflict', 'ingest.layout.noRows');
      const example = (await tables.listExamples(a.context, format.id)).find(
        (entry) => entry.fileId === fileId,
      );
      if (example)
        await tables.updateExample({ ...a.context, userId: actor.userId }, example.id, { expected });
      else
        await tables.createExample(
          { ...a.context, userId: actor.userId },
          { formatId: format.id, fileId, expected, own: true },
        );

      const settings = await organizationIngest(db, a.c.schemas, actor.orgId);
      const state = format.probationPassed + 1 >= settings.probationFiles ? 'live' : 'probation';
      await query(
        db,
        sql`UPDATE ${ident(a.c.schemas.app, 'ingest_formats')} SET probation_passed = probation_passed + 1, state = ${state}, updated_at = now()
        WHERE org_id = ${actor.orgId} AND table_id = ${tableId} AND id = ${format.id} AND state = 'probation'`,
      );
      await tables.updateFile({ ...a.context, userId: actor.userId }, fileId, {
        checks: { ...file.checks, probationFormats: [...passed, format.id] },
        notes: file.notes.filter((note) => note.messageId !== 'ingest.pipeline.probation'),
      });
      return { fileId, formatId: format.id, state };
    });
  });
}
