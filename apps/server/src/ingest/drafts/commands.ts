import { randomUUID } from 'node:crypto';
import {
  AppError,
  type IngestDraftCommand,
  type IngestDraftRow,
  type IngestTableSettings,
} from '@riosoma/contracts';
import { pairValuesEqual, serializableValue, type ExampleRows } from '@riosoma/ingest';
import { ident, query, sql } from '@riosoma/db';
import type { CommandContext } from '../../data/commands/context.js';
import { validateOfferedPair } from '../../data/commands/ingest-setup.js';
import { loadFields } from '../../data/metadata.js';
import {
  inspectOriginal,
  loadOriginal,
  restoreOriginal,
  storeOriginal,
  type OriginalRow,
} from '../../data/files/originals.js';
import { requireEvidenceAccess, setupStore } from '../setup/evidence.js';
import { uploadBytes } from '../setup/sheets.js';
import { outputFingerprint } from '../setup/readiness.js';
import { pairFieldType } from '../pairs/index.js';
import { extractSource } from '../extract/index.js';
import { chooseChecks } from './checks.js';
import {
  draftResponse,
  hasActiveDraftClaim,
  listDrafts,
  readDraft,
  saveDraft,
  type DraftDocument,
} from './store.js';

const invalid = () => new AppError('validation_failed', 'ingest.tables.invalid');
const state = () => new AppError('conflict', 'ingest.drafts.state');

export async function matchingDraft(c: CommandContext, tableId: string, sha256: string, rows: ExampleRows) {
  const files = await setupStore(c).listFiles({ orgId: c.actor.orgId, tableId });
  for (const draft of await listDrafts(c, tableId)) {
    if (files.find((file) => file.id === draft.fileId)?.sha256 !== sha256) continue;
    const equal = (candidate: IngestDraftRow[]) =>
      candidate.length === rows.length &&
      rows.every((row, index) =>
        draft.fields.every((field) =>
          pairValuesEqual(row.values[field.key], candidate[index]!.values[field.key], field.type),
        ),
      );
    if (draft.state !== 'discarded' && (equal(draft.rows) || equal(draft.originalRows))) return draft;
  }
  return null;
}

function score(draft: DraftDocument) {
  draft.mismatches = [];
  for (const check of draft.checks ?? []) {
    check.passed = false;
    if (!Object.hasOwn(draft.answers, check.id)) continue;
    const row = draft.rows.find((row) => row.id === check.rowId);
    const field = draft.fields.find((field) => field.key === check.field);
    if (!row || !field) continue;
    const current = row.values[check.field] ?? null;
    const answer = draft.answers[check.id]!;
    check.passed = pairValuesEqual(answer, current, field.type);
    if (!check.passed)
      draft.mismatches.push({ checkId: check.id, rowId: check.rowId, field: check.field, answer, current });
  }
  for (const row of draft.rows)
    row.needsCorrection = draft.mismatches.some((mismatch) => mismatch.rowId === row.id);
}

async function selectChecks(c: CommandContext, draft: DraftDocument) {
  const store = setupStore(c);
  const file = await store.readFile({ ...c.actor, tableId: draft.tableId }, draft.fileId);
  const bytes = file && (await loadOriginal(c.db, c.schemas.app, c.fileConfig!, file));
  if (!file || !bytes) throw new AppError('conflict', 'ingest.drafts.inputUnavailable');
  const extracted = await extractSource(file.name, bytes);
  if (extracted.status !== 'extracted') throw new AppError('validation_failed', extracted.messageKey);
  const covered = new Set(
    (await listDrafts(c, draft.tableId))
      .filter((other) => other.formatId === draft.formatId && other.state === 'confirmed')
      .flatMap((other) => other.checks?.filter((check) => check.passed).map((check) => check.field) ?? []),
  );
  draft.checks = chooseChecks(draft.rows, draft.fields, covered, extracted.source, draft.checks ?? []);
  draft.answers = Object.fromEntries(
    Object.entries(draft.answers).filter(([id]) => draft.checks!.some((check) => check.id === id)),
  );
}

export async function applyDraftCommand(
  c: CommandContext,
  command: IngestDraftCommand,
  settings: IngestTableSettings,
  outsideWrites: OriginalRow[],
  keepDays: number | 'forever',
): Promise<Record<string, unknown>> {
  await requireEvidenceAccess(c, command.tableId);
  const store = setupStore(c);
  const context = { ...c.actor, tableId: command.tableId };
  if (command.kind === 'ingest.draft.start') {
    const format = await store.readFormat(context, command.formatId);
    if (!format) throw new AppError('not_found', 'errors.notFound');
    const examples = await store.listExamples(context);
    if (
      !examples.some((example) => example.formatId === command.formatId && example.own && example.confirmedAt)
    )
      throw new AppError('validation_failed', 'ingest.drafts.needsOwn');
    const input = {
      name: command.file.name,
      bytes: uploadBytes(command.file),
      statedType: command.file.mediaType,
    };
    const checked = await inspectOriginal(c.db, c.schemas.app, c.fileConfig!, c.actor.orgId, input);
    const extracted = await extractSource(input.name, input.bytes);
    if (extracted.status !== 'extracted') throw new AppError('validation_failed', extracted.messageKey);
    const files = await store.listFiles(context);
    if (
      examples.some((example) => files.find((file) => file.id === example.fileId)?.sha256 === checked.sha256)
    )
      throw new AppError('validation_failed', 'ingest.drafts.sameFile');
    const existing = (await listDrafts(c, command.tableId)).find(
      (draft) => files.find((file) => file.id === draft.fileId)?.sha256 === checked.sha256,
    );
    const activeClaim = existing && (await hasActiveDraftClaim(c, command.tableId, existing.id));
    if (
      existing &&
      ((!['failed', 'discarded'].includes(existing.state) &&
        (existing.state !== 'drafting' || activeClaim)) ||
        existing.formatId !== command.formatId)
    )
      throw new AppError('conflict', 'ingest.drafts.sameFile');
    if (activeClaim) throw new AppError('conflict', 'ingest.drafts.finishing');
    const fields = await loadFields(c.db, c.schemas, [command.tableId]);
    let fileId = existing?.fileId;
    if (!fileId) {
      const file = await store.createFile(context, {
        origin: 'drop',
        name: input.name,
        mediaType: checked.type,
        sha256: checked.sha256,
        sizeBytes: input.bytes.length,
        storedFile: null,
        expiresAt: null,
      });
      fileId = file.id;
      const original = await storeOriginal(
        c.db,
        c.schemas.app,
        c.fileConfig!,
        { ...context, fileId },
        input,
        (row) => outsideWrites.push(row),
      );
      await store.updateFile(context, fileId, {
        storedFile: original.id,
        formatId: command.formatId,
        checks: { safety: checked.safety },
        state: 'held',
        holdReason: 'ingest.drafts.input',
      });
    } else {
      const file = files.find((file) => file.id === fileId)!;
      if (!(await loadOriginal(c.db, c.schemas.app, c.fileConfig!, file))) {
        const original = await restoreOriginal(
          c.db,
          c.schemas.app,
          c.fileConfig!,
          { ...context, fileId },
          input,
          (row) => outsideWrites.push(row),
        );
        await store.updateFile(context, fileId, {
          storedFile: original.id,
          expiresAt: null,
          originalExpiredAt: null,
          notes: file.notes.filter((note) => note.messageId !== 'ingest.pipeline.originalExpired'),
        });
      } else await store.updateFile(context, fileId, { expiresAt: null });
    }
    const draft: DraftDocument = {
      id: existing?.id ?? randomUUID(),
      tableId: command.tableId,
      formatId: command.formatId,
      fileId,
      revision: existing ? existing.revision + 1 : 0,
      state: 'drafting',
      failure: null,
      rows: [],
      originalRows: [],
      checks: null,
      answers: {},
      corrections: [],
      mismatches: [],
      readerChecks: existing?.readerChecks ?? {},
      outputHash: outputFingerprint(settings, fields),
      fields: settings.fields.map((definition) => ({
        ...definition,
        name: fields.find((field) => field.id === definition.fieldId)?.name ?? definition.key,
        type: pairFieldType(fields.find((field) => field.id === definition.fieldId) ?? { type: 'text' }),
      })),
    };
    await saveDraft(c, draft, !existing);
    return { draft: draftResponse(draft, true) };
  }
  const draft = await readDraft(c, command.tableId, command.draftId);
  if (draft.revision !== command.revision) throw new AppError('conflict', 'ingest.tables.stale');
  if (command.kind === 'ingest.draft.discard') {
    if (draft.state === 'confirmed' || draft.state === 'discarded') throw state();
    draft.state = 'discarded';
    draft.rows = [];
    draft.originalRows = [];
    draft.checks = null;
    draft.answers = {};
    draft.corrections = [];
    draft.mismatches = [];
    await query(
      c.db,
      sql`UPDATE ${ident(c.schemas.app, 'ingest_files')} SET expires_at =
      ${keepDays === 'forever' ? sql`NULL` : sql`received_at + ${keepDays} * interval '24 hours'`}
      WHERE org_id = ${c.actor.orgId} AND table_id = ${command.tableId} AND id = ${draft.fileId} AND NOT is_example`,
    );
  } else {
    if (draft.state !== 'ready') throw state();
    const fields = await loadFields(c.db, c.schemas, [command.tableId]);
    if (draft.outputHash !== outputFingerprint(settings, fields))
      throw new AppError('conflict', 'ingest.drafts.outputChanged');
    if (command.kind === 'ingest.draft.correct') {
      const previousRows = draft.rows;
      const ids = new Set<string>();
      draft.rows = command.rows.map((offered) => {
        const before = offered.id ? previousRows.find((row) => row.id === offered.id) : undefined;
        if (offered.id && !before) throw invalid();
        const id = offered.id ?? randomUUID();
        if (
          ids.has(id) ||
          (!before && !offered.at) ||
          Object.keys(offered.values).some((key) => !draft.fields.some((field) => field.key === key))
        )
          throw invalid();
        ids.add(id);
        const corrected = new Set(before?.corrected ?? []);
        for (const field of draft.fields) {
          if (!before || !pairValuesEqual(before.values[field.key], offered.values[field.key], field.type)) {
            corrected.add(field.key);
            draft.corrections.push({
              rowId: id,
              field: field.key,
              before: serializableValue(before?.values[field.key]),
              after: serializableValue(offered.values[field.key]),
            });
          }
        }
        return {
          id,
          values: offered.values,
          at: before?.at ?? offered.at!,
          doubts: before?.doubts ?? [],
          corrected: [...corrected],
          needsCorrection: false,
        };
      });
      for (const removed of previousRows.filter((row) => !ids.has(row.id)))
        for (const field of draft.fields)
          draft.corrections.push({
            rowId: removed.id,
            field: field.key,
            before: serializableValue(removed.values[field.key]),
            after: null,
          });
      if (
        draft.checks &&
        (draft.rows.length !== previousRows.length || previousRows.some((row) => !ids.has(row.id)))
      )
        await selectChecks(c, draft);
      score(draft);
    } else if (command.kind === 'ingest.draft.checks') {
      if (!draft.checks) {
        await selectChecks(c, draft);
      } else return { revision: draft.revision, checks: draft.checks };
    } else if (command.kind === 'ingest.draft.answer') {
      const check = draft.checks?.find((check) => check.id === command.checkId);
      if (!check) throw new AppError('not_found', 'errors.notFound');
      if (
        !draft.rows.some((row) => row.id === check.rowId) ||
        !draft.fields.some((field) => field.key === check.field)
      )
        throw new AppError('validation_failed', 'ingest.drafts.checksRequired');
      const value =
        command.answer.kind === 'choice' ? check.choices[command.answer.index] : command.answer.value;
      if (value === undefined) throw invalid();
      draft.answers[check.id] = value;
      score(draft);
      draft.revision++;
      await saveDraft(c, draft);
      return {
        revision: draft.revision,
        checkId: check.id,
        passed: check.passed,
        needsCorrection: !check.passed,
        ...(!check.passed ? { messageId: 'ingest.drafts.mismatch' } : {}),
      };
    } else if (command.kind === 'ingest.draft.confirm') {
      score(draft);
      const minimum = Math.min(5, draft.rows.length * draft.fields.length);
      const checkedCells = new Set(draft.checks?.map((check) => JSON.stringify([check.rowId, check.field])));
      if (
        !draft.checks?.length ||
        checkedCells.size < minimum ||
        draft.checks.some((check) => !check.passed) ||
        draft.mismatches.length
      )
        throw new AppError('validation_failed', 'ingest.drafts.checksRequired');
      const file = await store.readFile(context, draft.fileId);
      const bytes = file && (await loadOriginal(c.db, c.schemas.app, c.fileConfig!, file));
      if (!file || !bytes) throw new AppError('conflict', 'ingest.drafts.inputUnavailable');
      const extracted = await extractSource(file.name, bytes);
      if (extracted.status !== 'extracted') throw new AppError('validation_failed', extracted.messageKey);
      const expected = draft.rows.map(({ values }) => ({ values }));
      const findings = await validateOfferedPair(
        c,
        { ...command, formatId: draft.formatId },
        settings,
        { rows: expected, own: false },
        file.sha256,
        extracted.source,
      );
      const example = await store.createExample(context, {
        formatId: draft.formatId,
        fileId: draft.fileId,
        expected,
        own: false,
        confirmedFindings: findings.filter((finding) => !finding.blocks),
      });
      await store.saveFormatChecks(context, draft.formatId, {});
      draft.state = 'confirmed';
      draft.revision++;
      await saveDraft(c, draft);
      return { draft: draftResponse(draft, true), example, findings };
    }
  }
  draft.revision++;
  await saveDraft(c, draft);
  return command.kind === 'ingest.draft.checks'
    ? { revision: draft.revision, checks: draft.checks }
    : { draft: draftResponse(draft, true) };
}
