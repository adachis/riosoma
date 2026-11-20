import { budgetReached } from '../../ai/budget.js';
import { randomUUID } from 'node:crypto';
import type { IngestBuildReason, IngestFile } from '@riosoma/contracts';
import { AppError } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import {
  createQuestion,
  decide,
  nearSignatures,
  normalizeMarker,
  canonical,
  date,
  matchSignature,
  type DecisionItem,
  type DecisionQuestion,
  type ExtractedSource,
  type QuestionResponse,
} from '@riosoma/ingest';
import type { StoredTable } from '../../data/types.js';
import { loadFields } from '../../data/metadata.js';
import { actorFor } from '../../automations/run.js';
import { connection, settingsFor, spent } from '../../ai/settings.js';
import { notify } from '../../notifications/produce.js';
import { loadOriginal } from '../../data/files/originals.js';
import { extractSource } from '../extract/index.js';
import { BuildRunner, BuildCeiling, type Draft } from '../build/runner.js';
import { buildModel } from '../build/model.js';
import { liveAccess } from '../live/access.js';
import { requireEvidenceAccess } from '../setup/evidence.js';
import {
  answeredValue,
  cleanValue,
  fileQuestion,
  kind,
  readFormat,
  sameLocation,
  valueDoubt,
} from '../pipeline/reading.js';
import type { IngestWorker } from '../pipeline/worker.js';
import { TryLaterError, type IngestClaim, type PipelineReading } from '../pipeline/types.js';
import type { StoredIngestFormat } from '../tables/store.js';
import { checkpointStudy, loadStudy, type StudyDocument } from './store.js';
import { choices, columnDecision, columnQuestion, headings, studyQuestion } from './questions.js';
import { ownField } from './fields.js';
import { ReaderBindings } from '../readers/bindings.js';

export interface StudyResult {
  type: 'study';
  format: StoredIngestFormat | null;
  reading: PipelineReading | null;
  waiting?: boolean;
  skip?: boolean;
  reason?: string;
}
export function temporaryFormat(file: IngestFile, draft: Draft): StoredIngestFormat {
  return {
    ...draft,
    name: file.id,
    id: `study-${file.id}`,
    orgId: file.orgId,
    tableId: file.tableId,
    revision: 0,
    createdBy: null,
    createdAt: file.receivedAt,
    updatedAt: file.receivedAt,
  };
}
export function initialStudy(file: IngestFile): StudyDocument {
  return {
    state: 'studying',
    messageId: null,
    draft: null,
    reading: null,
    questions: [],
    assumptions: [],
    overrides: {},
    sources: {},
    formatId: null,
    ignored: [],
    fieldRequests: [],
    approvalPending: false,
    approvalNotified: false,
    build: {
      id: randomUUID(),
      tableId: file.tableId,
      formatId: file.id,
      state: 'queued',
      attempts: 0,
      reading: null,
      spentUsd: 0,
      examples: [],
      needsExample: false,
      offersAi: false,
      evidenceWithheld: false,
    },
  };
}

/** Only file content and anonymous output keys cross the model boundary. */
async function modelSource(worker: IngestWorker, source: ExtractedSource, file: IngestFile) {
  const { pool, schemas } = worker.store.data;
  const people = await query<{ name: string; email: string }>(
    pool,
    sql`SELECT u.name, u.email FROM ${ident(schemas.app, 'users')} u JOIN ${ident(schemas.app, 'memberships')} m ON m.user_id = u.id WHERE m.org_id = ${file.orgId}`,
  );
  const identities = [file.name, ...people.rows.flatMap((person) => [person.name, person.email])].filter(
    Boolean,
  );
  const sanitize = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let text = value.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted]');
      for (const identity of identities) text = text.split(identity).join('[redacted]');
      return text;
    }
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitize(child)]));
    return value;
  };
  const clean = structuredClone(source);
  delete clean.parts;
  if (clean.email) {
    clean.email.from = '';
    delete clean.email.originalFrom;
    clean.email.messageId = '';
  }
  clean.sheets?.forEach((sheet, index) => {
    sheet.name = `sheet-${index + 1}`;
  });
  return sanitize(clean) as ExtractedSource;
}

async function signatureSafe(worker: IngestWorker, file: IngestFile, source: ExtractedSource, draft: Draft) {
  if (!matchSignature(source, draft.signature)) return false;
  const { pool, schemas } = worker.store.data;
  for (const example of await worker.store.tables.listExamples(file)) {
    const original = await worker.store.tables.readFile(file, example.fileId);
    const bytes = original && (await loadOriginal(pool, schemas.app, worker.app.ctx.config, original));
    if (!original || !bytes) return false;
    const extracted = await extractSource(original.name, bytes);
    if (extracted.status !== 'extracted' || matchSignature(extracted.source, draft.signature)) return false;
  }
  return true;
}

export async function studyUnknown(
  worker: IngestWorker,
  source: ExtractedSource,
  table: StoredTable,
  claim: IngestClaim,
): Promise<StudyResult> {
  const { file } = claim;
  const { pool, schemas } = worker.store.data;
  const study = (await loadStudy(worker.store, file, file.id)) ?? initialStudy(file);
  const save = () => checkpointStudy(worker.store, claim, study);
  const response = async (question: DecisionQuestion): Promise<QuestionResponse | null> => {
    const existing = study.questions.find((entry) => entry.id === question.id);
    if (!existing) study.questions.push(question);
    const savedAnswer = await worker.raise(claim, existing ?? question);
    const answer = study.overrides[question.id] ?? savedAnswer;
    if (answer) study.overrides[question.id] = answer;
    await save();
    return answer;
  };
  const held = async (reason = 'ingest.pipeline.questionsOpen'): Promise<StudyResult> => {
    study.state = study.state === 'unavailable' ? 'unavailable' : 'questions';
    study.messageId = reason;
    await save();
    return { type: 'study', format: null, reading: null, waiting: true, reason };
  };
  const skipped = async (): Promise<StudyResult> => {
    study.state = 'skipped';
    await save();
    return { type: 'study', format: null, reading: null, skip: true };
  };
  const formats = await worker.store.tables.listFormats(file);
  if (!study.draft) {
    const near = nearSignatures(
      source,
      formats
        .filter((format) => ['live', 'probation'].includes(format.state))
        .map((format) => ({ ...format.signature, id: format.id })),
    ).slice(0, 3);
    if (near.length) {
      const question = studyQuestion(file, 'nearFormat', 'near', {
        type: 'choices',
        choices: [
          ...near.map((match) => ({
            id: match.signature.id,
            messageId: 'ingest.pipeline.chooseFormat',
            params: { format: formats.find((format) => format.id === match.signature.id)!.name },
          })),
          { id: 'none', messageId: 'ingest.study.none' },
        ],
      });
      const answer = await response(question);
      if (answer?.type === 'skipFile') return skipped();
      if (!answer) return held();
      if (answer.type === 'answer' && answer.answer.type === 'choice' && answer.answer.value !== 'none') {
        const selected = formats.find((format) => format.id === answer.answer.value);
        if (selected && selected.reading !== 'ai') {
          study.draft = { ...structuredClone(selected), state: 'draft' };
          study.selectedFormatId = selected.id;
          // A changed heading cannot remain a required header marker for this file.
          if (study.draft.reading === 'layout') {
            const present = new Set(
              (source.sheets ?? []).flatMap((sheet) =>
                sheet.rows
                  .slice(0, 60)
                  .flatMap((row) => row.map((cell) => normalizeMarker(String(cell.v ?? '')))),
              ),
            );
            study.draft.rules.header.markers = study.draft.rules.header.markers.filter((marker) =>
              present.has(normalizeMarker(marker)),
            );
            for (const [key, column] of Object.entries(study.draft.rules.columns))
              if (!column.aliases.some((alias) => present.has(normalizeMarker(alias))))
                delete study.draft.rules.columns[key];
          }
          await save();
        }
      }
    }
  }
  if (!study.draft || (study.build.state !== 'passed' && !study.selectedFormatId)) {
    if (study.build.attempts >= 6) {
      study.state = 'unavailable';
      study.messageId = 'ingest.build.attempts';
      const answer = await response(fileQuestion(file, 'unrecognizedFormat', 'format'));
      if (answer?.type === 'skipFile') return skipped();
      return held(study.messageId);
    }
    const actor = await actorFor(pool, schemas, table.ingest!.ownerId!, file.orgId);
    if (!actor) return held('ingest.write.ownerCannotWrite');
    const controller = new AbortController();
    const settings = await settingsFor(worker.app.ctx, file.orgId, actor);
    let model: Awaited<ReturnType<typeof buildModel>> = null;
    const gate = async (): Promise<IngestBuildReason | null> => {
      await worker.store.fenced(claim, async () => undefined);
      const current = await settingsFor(worker.app.ctx, file.orgId, actor);
      if (!current.enabled) return 'aiOff';
      if (!current.ingest) return 'ingestOff';
      if (study.build.spentUsd >= current.ingestBuildLimitUsd) throw new BuildCeiling();
      if (
        current.monthlyBudgetUsd !== null &&
        budgetReached(await spent(worker.app.ctx, file.orgId), current.monthlyBudgetUsd)
      )
        return 'budgetSpent';
      try {
        const access = await liveAccess(
          worker.app,
          { ...actor, ...(model?.model.adapter.local ? {} : { dataUse: 'provider' as const }) },
          table.id,
        );
        await requireEvidenceAccess(access.c, table.id);
      } catch (error) {
        if (error instanceof AppError && error.code === 'forbidden') return 'classification';
        throw error;
      }
      if (
        model &&
        !(await connection(worker.app.ctx, file.orgId, model.model.ref.providerId, current)).available
      )
        return 'providerDown';
      return null;
    };
    let reason: string | null;
    try {
      reason = await gate();
      if (!reason) {
        model = await buildModel(
          worker.app,
          actor,
          settings,
          controller.signal,
          {
            fileId: file.id,
            token: claim.token,
          },
          'study',
        );
        if (!model) reason = 'providerDown';
      }
    } catch (error) {
      reason = error instanceof BuildCeiling ? 'ceiling' : 'providerDown';
    }
    if (!reason) {
      if (study.state === 'unavailable' && study.build.reason === 'providerDown') {
        study.state = 'studying';
        study.messageId = null;
        delete study.build.reason;
        delete study.build.messageId;
      }
      const clean = await modelSource(worker, source, file);
      let feedback: unknown;
      const runner = new BuildRunner(study.build, {
        withoutExpectedRows: true,
        checkpoint: study.checkpoint,
        signal: controller.signal,
        ceilingUsd: settings.ingestBuildLimitUsd,
        fields: table.ingest!.fields.map(({ key, required }) => ({ key, required })),
        examples: [{ id: file.id, source: clean, expected: [] }],
        gate,
        call: model!.call,
        shown: async () => undefined,
        validateSignature: async () => true,
        feedback: () => feedback,
        test: async (draft) => {
          const reading = await readFormat(clean, temporaryFormat(file, draft), table, file, {}, {}, {});
          study.reading = reading;
          const missing = table
            .ingest!.fields.filter(
              (field) => !(reading?.rows ?? []).some((row) => Object.hasOwn(row.values, field.key)),
            )
            .map((field) => field.key);
          feedback = {
            rowCount: reading?.rows.length ?? 0,
            firstRows: reading?.rows.slice(0, 3),
            uncertain: reading?.doubts?.map((doubt) => ({
              field: doubt.question.target,
              values: doubt.question.values,
            })),
            checks: reading?.checks,
            missing,
          };
          return [
            {
              exampleId: file.id,
              result: {
                passed: !!reading?.rows.length,
                differences: [],
                ...(reading?.failure
                  ? { failure: { kind: 'read-failed' as const, messageId: reading.failure.messageId } }
                  : {}),
              },
            },
          ];
        },
        question: async ({ fieldKey, kind: questionKind, choices: ids }) => {
          const q = studyQuestion(
            file,
            questionKind === 'valueSource' ? 'valueSource' : 'draftQuestion',
            `builder:${fieldKey}`,
            choices(ids),
            { type: 'field', field: fieldKey, file: file.id, rows: [] },
          );
          await response(q);
          return q.id;
        },
        answer: async (id) => {
          const answer = study.overrides[id];
          if (answer?.type === 'answer') return answer.answer.value;
          if (answer?.type === 'unknown') return 'flag';
          return undefined;
        },
        finalize: async (draft) => {
          study.draft = draft;
          return { state: 'passed', examples: [], needsExample: false, offersAi: false };
        },
        changed: async (status, draft, checkpoint) => {
          study.build = status;
          study.draft = draft;
          study.checkpoint = checkpoint;
          await save();
        },
      });
      await runner.run();
      if (study.questions.some((question) => study.overrides[question.id]?.type === 'skipFile'))
        return skipped();
      if (study.build.state === 'waiting') return held();
      if (study.build.state !== 'passed')
        reason = study.build.state === 'ceiling' ? 'ceiling' : (study.build.reason ?? 'noProgress');
    }
    if (reason) {
      study.state = 'unavailable';
      study.messageId = `ingest.build.${reason}`;
      await save();
      if (reason === 'providerDown') throw new TryLaterError(study.messageId);
      if (reason === 'keyRefused') return held(study.messageId);
      const answer = await response(fileQuestion(file, 'unrecognizedFormat', 'format'));
      if (answer?.type === 'skipFile') return skipped();
      return held(study.messageId);
    }
  }
  if (!study.draft) return held();
  const draft = structuredClone(study.draft);
  const base = temporaryFormat(file, draft);
  let reading = (await readFormat(source, base, table, file, {}, {}, {})) ?? { rows: [] };
  const foundHeadings = headings(source, draft);
  const assumptions = new Set(study.assumptions.map((entry) => entry.id));
  const assumption = (question: DecisionQuestion, answer: QuestionResponse, reasonId: string) => {
    if (!assumptions.has(question.id)) {
      study.assumptions.push({
        id: question.id,
        question,
        answer,
        confirmed: false,
        evidenceWithheld: false,
        messageId: 'ingest.study.assumed',
        reasonId,
      });
      assumptions.add(question.id);
    }
  };
  let open = false;
  const flaggedColumns: string[] = [];
  for (const heading of foundHeadings) {
    if (study.ignored.includes(normalizeMarker(heading.heading))) continue;
    const placed =
      draft.reading === 'layout'
        ? Object.entries(draft.rules.columns).find(([, column]) =>
            column.aliases.some((alias) => normalizeMarker(alias) === normalizeMarker(heading.heading)),
          )
        : Object.entries(draft.rules.bindings ?? {}).find(
            ([, binding]) =>
              (binding.kind === 'column' || binding.kind === 'lookup') &&
              binding.aliases.some((alias) => normalizeMarker(alias) === normalizeMarker(heading.heading)),
          );
    const q = columnQuestion(file, heading, table.ingest!, study.selectedFormatId);
    let answer: QuestionResponse | null;
    if (placed) {
      answer = study.overrides[q.id] ?? { type: 'answer', answer: { type: 'choice', value: placed[0] } };
      assumption(q, answer, 'ingest.study.fileHeading');
    } else {
      const decision = await columnDecision(worker, claim, q);
      answer = decision.status === 'decided' ? decision.response : await response(q);
      if (decision.status === 'decided' && decision.ruleId) assumption(q, decision.response, decision.ruleId);
    }
    if (answer?.type === 'skipFile') return skipped();
    if (!answer) {
      open = true;
      continue;
    }
    if (answer.type === 'answer' && answer.answer.type === 'choice' && answer.answer.value === 'ownField') {
      const key = await ownField(worker, claim, table, study, heading.heading, q.id);
      if (key) answer = { type: 'answer', answer: { type: 'choice', value: key } };
    }
    if (
      answer.type !== 'answer' ||
      answer.answer.type !== 'choice' ||
      ['leaveOut', 'ownField'].includes(answer.answer.value)
    ) {
      study.ignored.push(normalizeMarker(heading.heading));
      if (answer.type === 'unknown') flaggedColumns.push(q.id);
      if (
        answer.type === 'answer' &&
        answer.answer.value === 'ownField' &&
        !study.fieldRequests.includes(heading.heading)
      )
        study.fieldRequests.push(heading.heading);
      continue;
    }
    if (draft.reading === 'layout') {
      if (placed && placed[0] !== answer.answer.value) delete draft.rules.columns[placed[0]];
      const column = draft.rules.columns[answer.answer.value] ?? {
        aliases: [],
        cleaners: [{ kind: 'text' as const }],
      };
      const selected = formats.find((format) => format.id === study.selectedFormatId);
      if (selected?.reading === 'layout' && selected.rules.columns[answer.answer.value]) {
        const original = selected.rules.columns[answer.answer.value]!;
        column.aliases = [...new Set([...original.aliases, ...column.aliases])];
        column.cleaners = structuredClone(original.cleaners);
      }
      if (!column.aliases.includes(heading.heading)) column.aliases.push(heading.heading);
      draft.rules.columns[answer.answer.value] = column;
      if (study.selectedFormatId) {
        const selected = formats.find((format) => format.id === study.selectedFormatId);
        if (selected?.reading === 'layout') {
          const previous = selected.rules.columns[answer.answer.value]?.aliases ?? [];
          draft.signature.headerGroups = draft.signature.headerGroups.map((group) => [...group]);
          for (const group of draft.signature.headerGroups)
            if (
              group.some((alias) =>
                previous.some((old) => normalizeMarker(old) === normalizeMarker(alias)),
              ) &&
              !group.includes(heading.heading)
            )
              (group as string[]).push(heading.heading);
        }
      }
    } else {
      if (placed && placed[0] !== answer.answer.value) delete draft.rules.bindings?.[placed[0]];
      draft.rules.bindings = {
        ...draft.rules.bindings,
        [answer.answer.value]: { kind: 'column', aliases: [heading.heading] },
      };
    }
  }
  reading = (await readFormat(source, temporaryFormat(file, draft), table, file, {}, {}, {})) ?? reading;
  for (const [field, binding] of Object.entries(study.sources)) {
    for (const row of reading.rows) {
      if (binding.kind === 'fixed') row.values[field] = binding.value;
      if (binding.kind === 'emailSubject') row.values[field] = source.email?.subject ?? null;
      if (binding.kind === 'lookup') {
        const heading = foundHeadings.find((entry) =>
          binding.aliases.some((alias) => normalizeMarker(alias) === normalizeMarker(entry.heading)),
        );
        const cell =
          heading &&
          source.sheets?.find((sheet) => sheet.name === row.at.sheet)?.rows[(row.at.row ?? 1) - 1]?.[
            heading.index
          ];
        row.values[field] = binding.entries[String(cell?.v ?? '')] ?? null;
      }
    }
  }
  for (const questionId of flaggedColumns)
    for (const row of reading.rows)
      row.reasons = [
        ...(row.reasons ?? []),
        { messageId: 'ingest.study.column', source: { kind: 'question', questionId } },
      ];
  if (reading.failure && !reading.rows.length) return held(reading.failure.messageId);
  if (reading.failure) {
    const q = createQuestion(
      { ...kind('totalRows'), allowUnknown: true },
      {
        key: `${file.id}:checks`,
        values: [],
        form: { type: 'choices', choices: [{ id: 'useRows', messageId: 'ingest.study.useRows' }] },
        evidence: [{ file: file.id, examples: [canonical(reading.checks)] }],
        target: { type: 'file', file: file.id },
        exits: ['skipFile'],
      },
    );
    const answer = await response(q);
    if (answer?.type === 'skipFile') return skipped();
    if (!answer) open = true;
    if (answer?.type === 'unknown')
      for (const row of reading.rows)
        row.reasons = [
          ...(row.reasons ?? []),
          { messageId: q.messageId, source: { kind: 'question', questionId: q.id } },
        ];
    delete reading.failure;
  }
  const groups = new Map<string, NonNullable<PipelineReading['doubts']>>();
  const fields = await loadFields(pool, schemas, [table.id]);
  const fileText = [
    ...(source.sheets ?? []).flatMap((sheet) =>
      sheet.rows.flatMap((row) => row.map((cell) => String(cell.v ?? ''))),
    ),
    ...(source.pages ?? []).map((page) => page.text),
    ...(source.email ? [source.email.subject, source.email.bodyText] : []),
  ].join('\n');
  const requiresSource = (key: string) => {
    if (study.sources[key]) return false;
    const binding = draft.reading === 'reader' ? draft.rules.bindings?.[key] : undefined;
    if (binding?.kind === 'fact' && draft.reading === 'reader')
      return draft.rules.facts?.[binding.key] === undefined;
    const fixed =
      binding?.kind === 'fixed'
        ? binding.value
        : draft.reading === 'layout'
          ? draft.rules.constants?.[key]
          : undefined;
    return fixed !== undefined && (fixed === null || fixed === '' || !fileText.includes(String(fixed)));
  };
  for (const question of study.questions) {
    const answer = study.overrides[question.id];
    if (answer?.type === 'unknown' && question.target.type === 'file')
      for (const row of reading.rows)
        row.reasons = [
          ...(row.reasons ?? []),
          { messageId: question.messageId, source: { kind: 'question', questionId: question.id } },
        ];
    if (answer?.type === 'unknown' && question.target.type === 'field') {
      const target = question.target;
      for (const row of reading.rows)
        if (!target.rows.length || target.rows.some((at) => sameLocation(at, row.at))) {
          row.values[target.field] = null;
          row.reasons = [
            ...(row.reasons ?? []),
            {
              messageId: question.messageId,
              fieldKey: target.field,
              source: { kind: 'question', questionId: question.id },
            },
          ];
        }
    }
  }
  if (!study.selectedFormatId)
    for (const definition of table.ingest!.fields) {
      if (fields.find((field) => field.id === definition.fieldId)?.type !== 'date') continue;
      const raw = reading.rows.map((row) => row.raw[definition.key]).filter((value) => value !== undefined);
      const month = raw.map((value) => date(value, { formats: ['MM/DD/YYYY'] }).certain);
      const day = raw.map((value) => date(value, { formats: ['DD/MM/YYYY'] }).certain);
      if (!raw.length || !month.every(Boolean) || !day.every(Boolean)) continue;
      for (const row of reading.rows) {
        const value = row.raw[definition.key];
        if (
          !value ||
          date(value, { formats: ['MM/DD/YYYY'] }).value === date(value, { formats: ['DD/MM/YYYY'] }).value
        )
          continue;
        if (
          reading.doubts?.some(
            (doubt) =>
              doubt.question.target.type === 'field' &&
              doubt.question.target.field === definition.key &&
              doubt.question.target.rows.some((at) => sameLocation(at, row.at)),
          )
        )
          continue;
        const doubt = valueDoubt(file, base, definition.key, row.at, value, 'date');
        const standard = kind('numericDateOrder');
        doubt.item.kind = standard;
        doubt.question = createQuestion(
          standard,
          {
            ...doubt.question,
            form: {
              type: 'choices',
              choices: ['monthFirst', 'dayFirst'].map((id) => ({ id, messageId: `ingest.pipeline.${id}` })),
            },
          },
          doubt.question.scopeContext,
        );
        reading.doubts = [...(reading.doubts ?? []), doubt];
      }
    }
  for (const row of reading.rows)
    for (const definition of table.ingest!.fields) {
      if (!Object.hasOwn(row.values, definition.key)) continue;
      if (definition.required && requiresSource(definition.key)) continue;
      if (
        row.reasons?.some((reason) => reason.fieldKey === definition.key && reason.source.kind === 'question')
      )
        continue;
      if (
        reading.doubts?.some(
          (doubt) =>
            doubt.question.target.type === 'field' &&
            doubt.question.target.field === definition.key &&
            doubt.question.target.rows.some((at) => sameLocation(at, row.at)),
        )
      )
        continue;
      const field = fields.find((field) => field.id === definition.fieldId)!;
      const value = row.values[definition.key];
      const checked = cleanValue(value, field.type);
      if ((checked && !checked.certain) || (definition.required && (value === null || value === ''))) {
        const doubt = valueDoubt(
          file,
          base,
          definition.key,
          row.at,
          row.raw[definition.key] ?? String(value ?? ''),
          field.type === 'date'
            ? 'date'
            : ['number', 'currency', 'percent'].includes(field.type)
              ? 'number'
              : 'text',
        );
        reading.doubts = [...(reading.doubts ?? []), doubt];
      }
    }
  if (draft.reading === 'layout')
    for (const [field, column] of Object.entries(draft.rules.columns)) {
      if (
        !column.cleaners.some(
          (cleaner) =>
            cleaner.kind === 'date' &&
            cleaner.formats?.some((format) => format.startsWith('MM')) &&
            cleaner.formats.some((format) => format.startsWith('DD')),
        )
      )
        continue;
      const raw = reading.rows.map((row) => row.raw[field]).filter((value) => value !== undefined);
      const month = raw.map((value) => date(value, { formats: ['MM/DD/YYYY'] }).certain);
      const day = raw.map((value) => date(value, { formats: ['DD/MM/YYYY'] }).certain);
      const convention =
        raw.length && month.every(Boolean) && day.some((value) => !value)
          ? 'monthFirst'
          : raw.length && day.every(Boolean) && month.some((value) => !value)
            ? 'dayFirst'
            : null;
      if (!convention) continue;
      const definition = kind('numericDateOrder');
      const q = createQuestion(
        definition,
        {
          key: `${file.id}:numericDateOrder:${field}`,
          values: [{ type: 'text', value: raw[0]! }],
          form: {
            type: 'choices',
            choices: ['monthFirst', 'dayFirst'].map((id) => ({ id, messageId: `ingest.pipeline.${id}` })),
          },
          evidence: [{ file: file.id, column: field, examples: raw.slice(0, 3) }],
          target: { type: 'field', file: file.id, field, rows: reading.rows.map((row) => row.at) },
          exits: ['skipFile'],
        },
        { format: base.id },
      );
      const outcome = decide({
        item: { kind: definition, inputs: {} },
        rules: [],
        builtIns: [
          {
            id: 'ingest.study.fileDateOrder',
            source: 'file',
            kind: definition.id,
            scope: { type: 'table' },
            condition: { all: [] },
            answer: { type: 'choice', value: convention },
          },
        ],
        question: q,
        target: q.target,
        key: q.key,
        attempt: 'exhausted',
      });
      if (outcome.status === 'decided') assumption(q, outcome.response, outcome.ruleId!);
    }
  for (const doubt of reading.doubts ?? []) {
    const sender = file.senderId ? await worker.store.tables.readSender(file, file.senderId) : null;
    if (sender) doubt.item.sender = { id: sender.id, kind: sender.kind, value: sender.value };
    const decision = decide({
      item: doubt.item,
      builtIns: doubt.builtIns,
      rules: await worker.store.decisions.findRules(file, doubt.item),
      question: doubt.question,
      target: doubt.question.target,
      key: doubt.question.key,
      attempt: 'exhausted',
    });
    if (decision.status === 'decided' && decision.ruleId) {
      const answer = study.overrides[doubt.question.id] ?? decision.response;
      assumption(doubt.question, decision.response, decision.ruleId);
      const target = doubt.question.target;
      if (target.type === 'field' && answer.type === 'answer')
        for (const row of reading.rows)
          if (target.rows.some((at) => sameLocation(at, row.at)))
            row.values[target.field] = answeredValue(doubt, answer);
      continue;
    }
    const group = `${doubt.question.kind}:${doubt.question.target.type === 'field' ? doubt.question.target.field : ''}${doubt.item.kind.class === 'value' ? `:${doubt.item.value ?? ''}` : ''}`;
    const entries = groups.get(group) ?? [];
    entries.push(doubt);
    groups.set(group, entries);
  }
  for (const [group, doubts] of groups) {
    const first = doubts[0]!;
    const q = createQuestion(
      first.item.kind,
      {
        ...first.question,
        key: `${file.id}:${group}`,
        target:
          first.question.target.type === 'field'
            ? {
                ...first.question.target,
                rows: doubts.flatMap((doubt) =>
                  doubt.question.target.type === 'field' ? doubt.question.target.rows : [],
                ),
              }
            : first.question.target,
        evidence: first.question.evidence,
      },
      first.question.scopeContext,
    );
    const item: DecisionItem = first.item;
    if (item.kind.id === 'numericDateOrder' && first.question.target.type === 'field') {
      const field = first.question.target.field;
      const raw = reading.rows.map((row) => row.raw[field]).filter((value) => value !== undefined);
      const month = raw.map((value) => date(value, { formats: ['MM/DD/YYYY'] }).certain);
      const day = raw.map((value) => date(value, { formats: ['DD/MM/YYYY'] }).certain);
      const convention =
        month.every(Boolean) && day.some((value) => !value)
          ? 'monthFirst'
          : day.every(Boolean) && month.some((value) => !value)
            ? 'dayFirst'
            : null;
      if (convention)
        first.builtIns = [
          ...(first.builtIns ?? []),
          {
            id: 'ingest.study.fileDateOrder',
            source: 'file',
            kind: item.kind.id,
            scope: { type: 'table' },
            condition: { all: [] },
            answer: { type: 'choice', value: convention },
          },
        ];
    }
    const rules = await worker.store.decisions.findRules(file, item);
    const outcome = decide({
      item,
      builtIns: first.builtIns,
      rules,
      question: q,
      target: q.target,
      key: q.key,
      attempt: 'exhausted',
    });
    const answer =
      study.overrides[q.id] ?? (outcome.status === 'decided' ? outcome.response : await response(q));
    if (outcome.status === 'decided' && outcome.ruleId) assumption(q, outcome.response, outcome.ruleId);
    if (answer?.type === 'skipFile') return skipped();
    if (!answer) {
      open = true;
      continue;
    }
    for (const doubt of doubts) {
      const target = doubt.question.target;
      if (target.type !== 'field') continue;
      for (const row of reading.rows.filter((row) => target.rows.some((at) => sameLocation(at, row.at)))) {
        if (answer.type === 'answer') row.values[target.field] = answeredValue(doubt, answer);
        else {
          row.values[target.field] = null;
          row.reasons = [
            ...(row.reasons ?? []),
            {
              messageId: q.messageId,
              fieldKey: target.field,
              source: { kind: 'question', questionId: q.id },
            },
          ];
        }
      }
    }
    if (answer.type === 'answer' && answer.answer.type === 'choice' && q.kind === 'numericDateOrder') {
      if (draft.reading === 'layout')
        for (const column of q.target.type === 'field' && draft.rules.columns[q.target.field]
          ? [draft.rules.columns[q.target.field]!]
          : [])
          for (const cleaner of column.cleaners)
            if (cleaner.kind === 'date')
              cleaner.formats = [answer.answer.value === 'monthFirst' ? 'MM/DD/YYYY' : 'DD/MM/YYYY'];
      if (draft.reading === 'reader' && q.target.type === 'field') {
        const binding = draft.rules.bindings?.[q.target.field];
        if (binding?.kind === 'column')
          binding.dateFormats = [answer.answer.value === 'monthFirst' ? 'MM/DD/YYYY' : 'DD/MM/YYYY'];
      }
    }
  }
  for (const field of table.ingest!.fields.filter(
    (field) =>
      field.required &&
      reading.rows.length &&
      (requiresSource(field.key) || reading.rows.every((row) => !Object.hasOwn(row.values, field.key))),
  )) {
    const q = studyQuestion(
      file,
      'valueSource',
      `source:${field.key}`,
      choices(['fixed', 'lookup', 'email', 'person']),
      { type: 'field', file: file.id, field: field.key, rows: reading.rows.map((row) => row.at) },
    );
    const answer = await response(q);
    if (answer?.type === 'skipFile') return skipped();
    if (!answer) {
      open = true;
      continue;
    }
    let value: unknown = null;
    const supplied = study.sources[field.key];
    if (answer.type === 'answer') {
      if (supplied?.kind === 'fixed') value = supplied.value;
      else if (answer.answer.value === 'email' || supplied?.kind === 'emailSubject') {
        value = source.email?.subject ?? null;
        study.sources[field.key] = { kind: 'emailSubject' };
      } else if (supplied?.kind === 'lookup') {
        const heading = foundHeadings.find((entry) =>
          supplied.aliases.some((alias) => normalizeMarker(alias) === normalizeMarker(entry.heading)),
        );
        for (const row of reading.rows) {
          const cell =
            heading &&
            source.sheets?.find((sheet) => sheet.name === row.at.sheet)?.rows[(row.at.row ?? 1) - 1]?.[
              heading.index
            ];
          row.values[field.key] = supplied.entries[String(cell?.v ?? '')] ?? null;
        }
        continue;
      } else {
        const follow = studyQuestion(
          file,
          'sourceValue',
          `source-value:${field.key}`,
          { type: 'text' },
          q.target,
        );
        const fact = await response(follow);
        if (fact?.type === 'skipFile') return skipped();
        if (!fact) {
          open = true;
          continue;
        }
        if (fact.type === 'answer') value = fact.answer.value;
      }
    }
    for (const row of reading.rows) {
      row.values[field.key] = value;
      if (answer.type === 'unknown' || value === null)
        row.reasons = [
          ...(row.reasons ?? []),
          { messageId: q.messageId, fieldKey: field.key, source: { kind: 'question', questionId: q.id } },
        ];
    }
    if (
      draft.reading === 'layout' &&
      (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null)
    )
      draft.rules.constants = { ...draft.rules.constants, [field.key]: value };
    if (draft.reading === 'reader') {
      if (study.sources[field.key]?.kind === 'emailSubject')
        draft.rules.bindings = { ...draft.rules.bindings, [field.key]: { kind: 'emailSubject' } };
      else if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null
      )
        draft.rules.bindings = { ...draft.rules.bindings, [field.key]: { kind: 'fixed', value } };
    }
  }
  reading.doubts = [];
  if (draft.reading === 'reader')
    for (const [field, binding] of Object.entries(study.sources)) {
      const parsed = ReaderBindings.safeParse({ [field]: binding });
      if (parsed.success) draft.rules.bindings = { ...draft.rules.bindings, ...parsed.data };
    }
  study.reading = reading;
  if (open) return held();
  study.draft = draft;
  if (study.selectedFormatId) {
    let selected = await worker.store.tables.readFormat(file, study.selectedFormatId);
    if (selected && canonical(selected.rules) !== canonical(draft.rules)) {
      selected = await worker.store.fenced(claim, (db) =>
        worker.store.tables
          .inTransaction(db)
          .updateFormat({ ...file, userId: null }, selected!.id, selected!.revision, {
            ...draft,
            name: selected!.name,
            state: selected!.state,
            probationPassed: selected!.probationPassed,
          }),
      );
      const { recheckFormat } = await import('./validation.js');
      await recheckFormat(worker, file, selected.id, claim);
    }
    study.formatId = selected?.id ?? null;
    study.state = 'ready';
    study.messageId = null;
    await save();
    return { type: 'study', format: selected, reading };
  }
  const keep = studyQuestion(file, 'keepRules', 'keep', choices(['file', 'layout', 'sender']));
  const keepAnswer = await response(keep);
  if (keepAnswer?.type === 'skipFile') return skipped();
  if (keepAnswer?.type === 'unknown')
    for (const row of reading.rows)
      row.reasons = [
        ...(row.reasons ?? []),
        { messageId: keep.messageId, source: { kind: 'question', questionId: keep.id } },
      ];
  // The last choice can be made after reading.  Until then the rules belong only to this file.
  if (
    keepAnswer?.type === 'answer' &&
    keepAnswer.answer.type === 'choice' &&
    keepAnswer.answer.value !== 'file' &&
    !study.formatId &&
    !study.selectedFormatId
  ) {
    const savedAnswer = await worker.store.decisions.findAnswer(file, keep.id);
    const person = savedAnswer?.answeredBy
      ? await actorFor(pool, schemas, savedAnswer.answeredBy, file.orgId)
      : null;
    const access = person ? await liveAccess(worker.app, person, table.id) : null;
    if (!access?.schema) {
      study.approvalPending = true;
      if (!study.approvalNotified) {
        await worker.store.fenced(claim, async (db) => {
          const members = await query<{ user_id: string }>(
            db,
            sql`SELECT user_id FROM ${ident(schemas.app, 'memberships')} WHERE org_id = ${file.orgId}`,
          );
          for (const member of members.rows) {
            const candidate = await actorFor(db, schemas, member.user_id, file.orgId);
            if (!candidate) continue;
            const a = await liveAccess(worker.app, candidate, table.id, db);
            if (a.schema) {
              await notify(db, schemas, {
                orgId: file.orgId,
                recipientId: member.user_id,
                actorId: null,
                subjectId: file.id,
                kind: 'ingest.question',
                target: {
                  databaseId: table.databaseId,
                  tableId: table.id,
                  tableName: table.name,
                  reason: { messageKey: 'ingest.study.approval' },
                },
              });
              break;
            }
          }
          study.approvalNotified = true;
          await saveStudyInFence(db);
        });
      }
    } else if (await signatureSafe(worker, file, source, draft)) {
      await worker.store.fenced(claim, async (db) => {
        const format = await worker.store.tables
          .inTransaction(db)
          .createFormat(
            { ...file, userId: person!.userId },
            { ...draft, name: file.id, state: 'probation', probationPassed: 0 },
          );
        study.formatId = format.id;
        study.approvalPending = false;
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'ingest_rules')}
          SET document = jsonb_set(document, '{scope,format}', to_jsonb(${format.id}::text)), updated_at = now()
          WHERE org_id = ${file.orgId} AND table_id = ${file.tableId} AND document->'scope'->>'type' = 'format'
            AND document->'scope'->>'format' = ${base.id}`,
        );
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'ingest_formats')} SET study_file_id = ${file.id}, ignored_headings = ${JSON.stringify(study.ignored.filter((heading) => !study.fieldRequests.some((request) => normalizeMarker(request) === heading)))}::jsonb, unknown_sender_id = ${keepAnswer.answer.value === 'sender' ? file.senderId : null}, value_sources = ${JSON.stringify(study.sources)}::jsonb WHERE org_id = ${file.orgId} AND table_id = ${file.tableId} AND id = ${format.id}`,
        );
        await worker.store.tables.inTransaction(db).createExample(
          { ...file, userId: person!.userId },
          {
            formatId: format.id,
            fileId: file.id,
            own: true,
            expected: reading.rows.map((row) => ({ values: row.values })),
          },
        );

        await saveStudyInFence(db);
      });
    } else study.messageId = 'ingest.setup.signatureOverlap';
  }
  async function saveStudyInFence(db: Parameters<typeof worker.store.saveJob>[0]) {
    const { saveStudy } = await import('./store.js');
    await saveStudy(worker.store, file, file.id, study, db);
  }
  study.state = 'ready';
  if (study.messageId !== 'ingest.setup.signatureOverlap') study.messageId = null;
  await save();
  const saved = study.formatId ? await worker.store.tables.readFormat(file, study.formatId) : null;
  return { type: 'study', format: saved ?? temporaryFormat(file, draft), reading };
}
