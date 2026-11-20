import { ident, query, sql } from '@riosoma/db';
import { AppError, IngestValueSource } from '@riosoma/contracts';
import { applyCleaners, normalizeMarker, type CleanerSpec, type ExtractedSource } from '@riosoma/ingest';
import type { StoredTable } from '../../data/types.js';
import type { IngestWorker } from '../pipeline/worker.js';
import type { IngestClaim, PipelineReading } from '../pipeline/types.js';
import type { StoredIngestFormat } from '../tables/store.js';
import { headings, headingValue, columnQuestion, columnDecision } from './questions.js';
import { recheckFormat } from './validation.js';
import { answerIngestRows } from '../write/index.js';
import { hashValue } from '../write/storage.js';
import { message } from '../../api-v1/messages.js';
import { ownField } from './fields.js';
import { initialStudy } from './runner.js';
import { loadStudy, checkpointStudy, headingFiles } from './store.js';
import { loadOriginal } from '../../data/files/originals.js';
import { extractSource } from '../extract/index.js';

/** Unmapped headings belong to the format, so later files share the first pending question. */
export async function studyKnownColumns(
  worker: IngestWorker,
  claim: IngestClaim,
  table: StoredTable,
  source: ExtractedSource,
  format: StoredIngestFormat,
  reading: PipelineReading,
) {
  if (format.reading === 'ai') return;
  const { pool, schemas } = worker.store.data;
  for (const heading of headings(source, format)) {
    if (
      (format.ignoredHeadings ?? []).includes(normalizeMarker(heading.heading)) ||
      Object.values(format.reading === 'layout' ? format.rules.columns : (format.rules.bindings ?? {})).some(
        (column) =>
          'aliases' in column &&
          column.aliases.some((alias: string) => normalizeMarker(alias) === normalizeMarker(heading.heading)),
      ) ||
      Object.values(format.valueSources ?? {}).some((source) => {
        const binding = IngestValueSource.safeParse(source);
        return (
          binding.success &&
          (binding.data.kind === 'column' || binding.data.kind === 'lookup') &&
          binding.data.aliases.some((alias) => normalizeMarker(alias) === normalizeMarker(heading.heading))
        );
      })
    )
      continue;
    const previous = await query<{ document: ReturnType<typeof columnQuestion> }>(
      pool,
      sql`SELECT document FROM ${ident(schemas.app, 'ingest_questions')}
        WHERE org_id = ${claim.file.orgId} AND table_id = ${table.id} AND document->>'kind' = 'column'
          AND document->'scopeContext'->>'format' = ${format.id}
          AND document->'evidence'->0->>'column' = ${heading.heading} ORDER BY created_at LIMIT 1`,
    );
    const question =
      previous.rows[0]?.document ?? columnQuestion(claim.file, heading, table.ingest!, format.id);
    const decision = await columnDecision(worker, claim, question);
    let answer = decision.status === 'decided' ? decision.response : await worker.raise(claim, question);
    if (!answer) continue;
    if (answer.type === 'skipFile') return true;
    let createdFieldKey: string | undefined;
    if (answer.type === 'answer' && answer.answer.type === 'choice' && answer.answer.value === 'ownField') {
      const study = (await loadStudy(worker.store, claim.file, claim.file.id)) ?? initialStudy(claim.file);
      study.state = 'ready';
      study.formatId = format.id;
      study.selectedFormatId = format.id;
      study.reading = reading;
      study.questions = [question];
      const key = await ownField(worker, claim, table, study, heading.heading, question.id);
      await checkpointStudy(worker.store, claim, study);
      if (key) {
        answer = { type: 'answer', answer: { type: 'choice', value: key } };
        createdFieldKey = key;
      } else continue;
    }
    if (
      answer.type === 'answer' &&
      answer.answer.type === 'choice' &&
      !['leaveOut', 'ownField'].includes(answer.answer.value)
    ) {
      const key = answer.answer.value;
      const column = format.reading === 'layout' ? format.rules.columns[key] : undefined;
      if (column) column.aliases.push(heading.heading);
      const binding = format.reading === 'reader' ? format.rules.bindings?.[key] : undefined;
      const cleaners: CleanerSpec[] =
        column?.cleaners ??
        (binding?.kind === 'column' && binding.dateFormats
          ? [{ kind: 'date', formats: binding.dateFormats }]
          : []);
      format.valueSources = {
        ...format.valueSources,
        [key]: { kind: 'column', aliases: [...new Set([...(column?.aliases ?? []), heading.heading])] },
      };
      if (format.reading === 'reader')
        format.rules.bindings = {
          ...format.rules.bindings,
          [key]: { ...format.rules.bindings?.[key], kind: 'column', aliases: [heading.heading] },
        };
      for (const row of reading.rows) {
        const raw = headingValue(source, row.at, heading);
        const cleaned = applyCleaners(raw, cleaners);
        row.values[key] = cleaned.certain ? cleaned.value : raw;
        row.raw[key] = String(raw ?? '');
        const result = await answerIngestRows(
          table,
          question.id,
          row.values[key],
          `column:${question.id}:${hashValue(row.at)}`,
          {
            app: worker.app,
            message,
            lease: { fileId: claim.file.id, token: claim.token },
            createdFieldKeys: createdFieldKey ? [createdFieldKey] : [],
          },
          { fileId: claim.file.id, field: key, at: [row.at] },
        );
        if (result.status !== 'written' || result.refused.length)
          throw new AppError('conflict', result.messageId ?? 'ingest.pipeline.writeStopped');
      }
      for (const affected of await headingFiles(worker.store, claim.file, question.id)) {
        if (affected.file_id === claim.file.id || !affected.prepared) continue;
        const file = await worker.store.tables.readFile(claim.file, affected.file_id);
        if (!file || file.state === 'skipped') continue;
        const bytes = await loadOriginal(pool, schemas.app, worker.app.ctx.config, file);
        const extracted = bytes && (await extractSource(file.name, bytes));
        if (!extracted || extracted.status !== 'extracted')
          throw new AppError('conflict', 'ingest.pipeline.originalExpired');
        const originalHeading = headings(extracted.source, format).find(
          (entry) => normalizeMarker(entry.heading) === normalizeMarker(heading.heading),
        );
        if (!originalHeading) continue;
        for (const row of affected.prepared.rows) {
          const raw = headingValue(extracted.source, row.at, originalHeading);
          const cleaned = applyCleaners(raw, cleaners);
          const value = cleaned.certain ? cleaned.value : raw;
          const result = await answerIngestRows(
            table,
            question.id,
            value,
            `column:${question.id}:${file.id}:${hashValue(row.at)}`,
            {
              app: worker.app,
              message,
              allowPaused: true,
              lease: { fileId: claim.file.id, token: claim.token },
              createdFieldKeys: createdFieldKey ? [createdFieldKey] : [],
            },
            { fileId: file.id, field: key, at: [row.at] },
          );
          if (result.status !== 'written' || result.refused.length)
            throw new AppError('conflict', result.messageId ?? 'ingest.pipeline.writeStopped');
        }
      }
      const saved = await worker.store.fenced(claim, (db) =>
        worker.store.tables
          .inTransaction(db)
          .updateFormat(
            { ...claim.file, userId: null },
            format.id,
            format.revision,
            format,
            format.valueSources,
          ),
      );
      Object.assign(format, saved);
      await recheckFormat(worker, claim.file, format.id, claim);
    } else if (answer.type === 'unknown') {
      const reasons = [
        { messageId: question.messageId, source: { kind: 'question' as const, questionId: question.id } },
      ];
      for (const row of reading.rows)
        row.reasons = [
          ...(row.reasons ?? []).filter(
            (reason) => !(reason.source.kind === 'question' && reason.source.questionId === question.id),
          ),
          ...reasons,
        ];
      const affected = new Set([
        claim.file.id,
        ...(await headingFiles(worker.store, claim.file, question.id)).map((file) => file.file_id),
      ]);
      for (const fileId of affected) {
        const file = await worker.store.tables.readFile(claim.file, fileId);
        if (!file || file.state === 'skipped') continue;
        const result = await answerIngestRows(
          table,
          question.id,
          null,
          `column-flag:${question.id}:${fileId}`,
          {
            app: worker.app,
            message,
            allowPaused: true,
            lease: { fileId: claim.file.id, token: claim.token },
          },
          { fileId, reasons },
        );
        if (result.status !== 'written' || result.refused.length)
          throw new AppError('conflict', result.messageId ?? 'ingest.pipeline.writeStopped');
      }
    } else {
      await worker.store.fenced(claim, (db) =>
        query(
          db,
          sql`UPDATE ${ident(schemas.app, 'ingest_formats')} SET ignored_headings = ignored_headings || ${JSON.stringify([normalizeMarker(heading.heading)])}::jsonb
          WHERE org_id = ${claim.file.orgId} AND table_id = ${table.id} AND id = ${format.id}`,
        ),
      );
    }
  }
}
