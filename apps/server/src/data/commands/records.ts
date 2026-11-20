import { guardLineWrite, replaceLineRows } from './line-items.js';
import { ingestCapability } from '../../ingest/tables/capability.js';
import { retainedIngestText } from '../../ingest/write/check.js';
import { setRecordLocks } from '../record-locks.js';
import { clearOverrideEdits, inboundEdits, overrideEdits } from '../../sources/overrides.js';
import { readsLive } from '../../sources/live.js';
import { beforeLiveUpdate } from '../../sources/live-commands.js';
import {
  AppError,
  checkCellValue,
  checkComputedOverride,
  isOverrideType,
  idsOf,
  isSignatureValue,
  jsonEqual,
  unanswered,
  visibleFormQuestions,
  RecordId,
  type Command,
  type CellValues,
  type FormQuestion,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { refusePricedChanges } from '../../payments/store.js';
import { attachFiles } from '../files/cells.js';
import { loadField, loadFields } from '../metadata.js';
import { requireLinkLimits } from '../link-limits.js';
import {
  insertRecords,
  fetchRowsById,
  updateRecords,
  trashRecords,
  restoreRecords,
  currentValues,
  type RecordInput,
} from '../physical/records.js';
import { linkVisibilityChanges, replaceLinks } from '../physical/links.js';
import { matchedLinks, MatchRefresh } from '../physical/matches.js';
import type { StoredField } from '../types.js';
import { badViewSetting } from '../view-settings.js';
import { writeGuard } from '../permissions/enforce.js';
import { cellError } from '../value-errors.js';
import { invalid, scopeOf, table, type CommandContext, type Mutation } from './context.js';
import { fillDefaults } from './defaults.js';
import { formQuestions, requireFormAnswers } from './forms.js';
import { chain } from './matches.js';
import { mergeTextEdits } from './text-edits.js';

/** Merges and moves have their own modules, since they reach beyond the records' values. */
type RecordCommand = Exclude<
  Extract<Command, { kind: `record.${string}` }>,
  {
    kind:
      | 'record.merge'
      | 'record.move'
      | 'record.generateDocument'
      | 'record.attachFromUrl'
      | 'record.duplicate';
  }
>;

/** Links that follow matching values change only with the values, never by hand. */
function refuseMatched(
  fields: readonly StoredField[],
  records: ReadonlyArray<{ values: Record<string, unknown> }>,
): void {
  const matched = new Set(
    fields.filter((field) => field.type === 'link' && field.options.match).map((field) => field.id),
  );
  if (!matched.size) return;
  for (const record of records)
    if (Object.keys(record.values).some((id) => matched.has(id))) invalid('data.link.matched');
}

async function* linkMutations(
  changes: AsyncIterable<Mutation['body']> | undefined,
): AsyncGenerator<Mutation> {
  if (changes) for await (const body of changes) yield { body, prev: {} };
}

export async function checkedRows(
  c: CommandContext,
  fields: StoredField[],
  rows: Array<{ id: string; values: Record<string, unknown> }>,
  options: {
    restoreSignatures?: boolean;
    computedOverrides?: boolean;
    currentSignatures?: ReadonlyMap<string, CellValues>;
  } = {},
): Promise<RecordInput[]> {
  const byId = new Map(fields.map((f) => [f.id, f]));
  // New signatures belong to their writer, while history retains the original signer and time.
  const signer = c.publicForm ? null : c.actor.userId || null;
  const signedAt = new Date().toISOString();
  const checkedRows = rows.map((row, index) => ({
    id: RecordId.parse(row.id),
    values: Object.fromEntries(
      Object.entries(row.values).map(([id, input]) => {
        const field = byId.get(id);
        if (!field) return invalid('data.field.unknown');
        // Only its signer makes a signature, so no routine writes one, even in a plan its owner
        // approved.
        if (field.type === 'signature' && c.actor.routine) return invalid('routines.changes.signature');
        let checked =
          options.computedOverrides && isOverrideType(field.type)
            ? checkComputedOverride(field, input)
            : checkCellValue(field, input);
        // Invalid text remains available for review only through the internal ingest grant.
        if (
          !checked.ok &&
          c.ingestCapability === ingestCapability &&
          c.origin?.kind === 'ingest' &&
          field.ingest?.role === 'data'
        ) {
          const retained = retainedIngestText(field, input);
          if (retained?.ok) checked = retained;
        }
        if (!checked.ok) throw cellError(checked.messageKey, field, row.id, index);
        if (!options.restoreSignatures && field.type === 'signature' && isSignatureValue(checked.value)) {
          const previous = options.currentSignatures?.get(row.id)?.[id];
          // Prefilled signatures retain their stored metadata, regardless of submitted metadata.
          if (
            isSignatureValue(previous) &&
            previous.name === checked.value.name &&
            jsonEqual(previous.drawing, checked.value.drawing)
          )
            return [id, previous];
          return [id, { ...checked.value, signedBy: signer, signedAt }];
        }
        return [id, checked.value];
      }),
    ),
  }));
  const userFields = fields.filter((field) => field.type === 'user');
  const userIds = new Set(
    checkedRows.flatMap((row) => userFields.flatMap((field) => idsOf(row.values[field.id] ?? null))),
  );
  if (userIds.size) {
    const members = await (await scopeOf(c)).organizationMemberIds();
    for (const [index, row] of checkedRows.entries())
      for (const field of userFields)
        if (idsOf(row.values[field.id] ?? null).some((id) => !members.has(id)))
          throw cellError('data.user.unknown', field, row.id, index);
  }
  return checkedRows;
}

export async function applyRecords(c: CommandContext, command: RecordCommand): Promise<Mutation> {
  const parent = await table(c, command.tableId, command.kind === 'record.restore');
  const parents = await guardLineWrite(c, parent, command);
  const nested: Array<{ field: Extract<StoredField, { type: 'lineItems' }>; id: string; rows: unknown[] }> =
    [];
  if (command.kind === 'record.create' || command.kind === 'record.update') {
    const fields = await loadFields(c.db, c.schemas, [command.tableId]);
    const previous =
      command.kind === 'record.update'
        ? await currentValues(
            c.db,
            c.schemas.data,
            command.tableId,
            fields.filter((field) => field.type === 'lineItems'),
            command.records.map((row) => row.id),
            true,
          )
        : new Map();
    const records = command.records.map((row) => {
      const values = { ...row.values };
      for (const field of fields) {
        const value = values[field.id];
        if (
          field.type !== 'lineItems' ||
          c.lineItemsJunction ||
          !Array.isArray(value) ||
          (value.length > 0 && !value.some((item) => typeof item !== 'string'))
        )
          continue;
        nested.push({ field, id: row.id, rows: value });
        values[field.id] = previous.get(row.id)?.[field.id] ?? [];
      }
      return { ...row, values };
    });
    command = { ...command, records };
  }
  if (nested.length)
    c.lineItemsAnswers = new Map(
      nested.map((item) => [
        item.id,
        Object.fromEntries(
          nested.filter((line) => line.id === item.id).map((line) => [line.field.id, line.rows]),
        ),
      ]),
    );
  c.lineParents = parents;
  const mutation = await applyRecordCells(c, command);
  const extra = mutation.additional;
  mutation.additional = chain(
    extra,
    (async function* () {
      for (const item of nested) yield* replaceLineRows(c, item.field, item.id, item.rows);
    })(),
  );
  return mutation;
}

async function applyRecordCells(c: CommandContext, command: RecordCommand): Promise<Mutation> {
  const { db, schemas, actor } = c;
  const tableId = command.tableId;
  let grant = c.managedWrite;
  // The payment service records what Stripe reported even for a record or table in the trash.
  const parent = await table(c, tableId, Boolean(grant));
  // A webhook's posts add and change its own synced tables' records, as the table's person.
  const inbound = Boolean(
    parent.source &&
    c.actor.source &&
    parent.source.sourceKind === 'webhook' &&
    c.actor.source.id === parent.source.sourceId,
  );
  if (
    (parent.source || parent.joined) &&
    (command.kind === 'record.trash' ||
      command.kind === 'record.restore' ||
      (command.kind === 'record.create' && !inbound))
  )
    throw new AppError('forbidden', 'sources.syncedReadOnly');
  const fields = await loadFields(db, schemas, [tableId]);
  const stored = fields.filter((field) => field.type !== 'formula');
  // Field and record rules: people change only fields they see and may edit, in records they see.
  let guard = writeGuard(db, schemas, await scopeOf(c, tableId), tableId, fields, grant);
  if (command.kind === 'record.create' || command.kind === 'record.update')
    refuseMatched(fields, command.records);
  switch (command.kind) {
    case 'record.setLock':
      return setRecordLocks(c, tableId, command.recordIds, command.locked, command.reason);
    case 'record.create': {
      // A public submission always answers its form, and what it adds belongs to no person.
      if (c.publicForm && !command.formViewId) badViewSetting('formViewId');
      const author = c.publicForm ? null : actor.userId || null;
      const questions = command.formViewId
        ? await formQuestions(c, command.formViewId, tableId, fields, command.records)
        : [];
      await guard.requireEditable(command.records);
      const rows = await guard.keepHiddenLinks(
        await checkedRows(c, guard.visible, command.records, { restoreSignatures: c.copyCellMetadata }),
        false,
      );
      // An empty checkbox waits for its default, while false is an explicit answer.
      if (command.formViewId) {
        const boxes = fields.filter((field) => field.type === 'checkbox');
        for (const [index, row] of rows.entries())
          for (const field of boxes)
            if (unanswered(command.records[index]!.values[field.id])) delete row.values[field.id];
      }
      // Synced and joined tables hold what their sources give them, so their records take no default.
      if (!parent.source && !parent.joined)
        await fillDefaults(c, stored, command.records, rows, {
          form: Boolean(command.formViewId),
          timeZone: command.timeZone,
        });
      requireAnswers(c, questions, rows, command.records);
      await guard.requireValid(
        answerRows(c, rows),
        false,
        c.publicForm ? questions.map((question) => question.fieldId) : undefined,
      );
      if (c.prepareRecordCreate) {
        await c.prepareRecordCreate(rows);
        grant = c.managedWrite;
        guard = writeGuard(db, schemas, await scopeOf(c, tableId), tableId, fields, grant);
        await guard.requireValid(
          rows,
          false,
          c.publicForm ? questions.map((question) => question.fieldId) : undefined,
        );
      }
      const ids = rows.map((r) => r.id);
      if (new Set(ids).size !== ids.length) invalid('data.record.exists');
      const existing = await query(
        db,
        sql`SELECT __id FROM ${ident(schemas.data, tableId)} WHERE __id = ANY(${ids}::text[])`,
      );
      if (existing.rowCount) invalid('data.record.exists');
      await attachFiles(c, tableId, fields, rows);
      await guard.write(() =>
        insertRecords(
          db,
          schemas.data,
          tableId,
          stored,
          rows,
          author,
          c.simulation ? rows.map(() => c.simulation!.rid()) : undefined,
          grant,
        ),
      );
      for (const [id, owner] of c.lineParents ?? [])
        await query(
          db,
          sql`UPDATE ${ident(schemas.data, tableId)} SET __parent_id = ${owner} WHERE __id = ${id}`,
        );
      const limitChecks: Array<() => Promise<void>> = [];
      const changes = await replaceLinks(db, schemas.data, stored, rows, author, [], limitChecks);
      // New records link to their matches, including through record IDs and auto numbers.
      const refresh = new MatchRefresh(db, schemas.data, author);
      for (const link of matchedLinks(fields)) await refresh.refresh(link, sql`t.__id = ANY(${ids}::text[])`);
      for (const check of limitChecks) await check();
      // A record someone adds has to be one their rules let them see.
      if (!c.publicForm) await guard.requireWithinRules(ids);
      const records = await fetchRowsById(db, schemas.data, tableId, stored, ids);
      return {
        additional: chain(
          changes.map((body) => ({ body, prev: {} })),
          linkMutations(refresh.changes()),
        ),
        body: { kind: 'record.created', tableId, records },
        prev: {},
      };
    }
    case 'record.clearOverrides':
    case 'record.update': {
      const requested = command.records.map((record) => record.id);
      if (
        c.publicForm &&
        (!c.publicFormEdit || requested.length !== 1 || requested[0] !== c.publicFormEdit.recordId)
      )
        throw new AppError('forbidden', 'forms.edit.invalid');
      // The payment service writing only the fields and records its grant names isn't a person's
      // change, so no person's record rules apply to it.
      const service =
        command.kind === 'record.update' &&
        Boolean(grant) &&
        command.records.every(
          (record) =>
            grant!.recordIds.has(record.id) &&
            Object.keys(record.values).every((id) => grant!.fieldIds.has(id)),
        );
      if (!service) await guard.requireVisible(requested);
      // A live table's source values come in first, so overrides and history record them.
      if (readsLive(parent)) await beforeLiveUpdate(c, parent, command, fields);
      if (command.kind === 'record.update') await guard.requireEditable(command.records);
      const signatureFields =
        c.publicFormEdit && command.kind === 'record.update'
          ? guard.visible.filter(
              (field) => field.type === 'signature' && command.records.some((row) => field.id in row.values),
            )
          : [];
      const currentSignatures = signatureFields.length
        ? await currentValues(db, schemas.data, tableId, signatureFields, requested)
        : undefined;
      let rows =
        command.kind === 'record.clearOverrides'
          ? await clearOverrideEdits(c, command, guard.visible)
          : await guard.keepHiddenLinks(
              await checkedRows(c, guard.visible, command.records, {
                computedOverrides: parent.allowComputedOverrides,
                restoreSignatures: c.copyCellMetadata,
                currentSignatures,
              }),
              true,
            );
      if (command.kind === 'record.clearOverrides') await guard.requireEditable(rows);
      const merged =
        command.kind === 'record.update' ? await mergeTextEdits(c, command, guard.visible, rows) : [];
      const editQuestions = c.publicFormEdit
        ? await formQuestions(c, c.publicFormEdit.viewId, tableId, fields, rows)
        : undefined;
      if (editQuestions) requireAnswers(c, editQuestions, rows);
      // A paid form charged for the response as it was answered, so its link can't reprice it.
      if (c.publicFormEdit) await refusePricedChanges(c, tableId, fields, rows);
      if (
        (parent.source || parent.joined || parent.allowComputedOverrides) &&
        command.kind === 'record.update'
      )
        rows = inbound
          ? await inboundEdits(c, tableId, fields, rows)
          : await overrideEdits(c, tableId, fields, rows, {
              // Every field of a joined table comes from an input, so its pins are a source's kind.
              synced: parent.joined ? true : (parent.source?.allowOverrides ?? false),
              computed: parent.allowComputedOverrides === true,
            });
      await guard.requireValid(
        answerRows(c, rows),
        true,
        editQuestions
          ? visibleFormQuestions(editQuestions, rows[0]!.values).map((question) => question.fieldId)
          : undefined,
      );
      await attachFiles(c, tableId, fields, rows);
      const { updated, missing, linkChanges, linkPositions, matchChanges } = await guard.write(() =>
        updateRecords(
          db,
          schemas.data,
          tableId,
          fields,
          rows,
          c.publicForm ? null : actor.userId,
          [],
          grant,
          guard.unseen,
        ),
      );
      if (missing.length === rows.length) invalid('data.record.missing');
      // A change can't move a record out of what its maker's rules let them see.
      if (!service) await guard.requireWithinRules(updated.map((row) => row.id));
      return {
        body: {
          kind: 'record.updated',
          tableId,
          records: updated.map(({ prev: _prev, prevOverrides: _overrides, ...row }) => row),
        },
        prev: {
          records: updated.map(({ id, prev, prevOverrides }) => ({
            id,
            values: prev,
            ...(prevOverrides ? { overrides: prevOverrides } : {}),
          })),
          ...(linkPositions?.length ? { linkPositions } : {}),
        },
        additional: chain(
          linkChanges?.map((body) => ({ body, prev: {} })),
          linkMutations(matchChanges),
        ),
        ...(merged.length ? { output: { textMerges: merged } } : {}),
      };
    }
    case 'record.trash': {
      await guard.requireVisible(command.recordIds);
      await guard.requireUnlocked(command.recordIds, { links: true, conditionalCopies: c.undoCopiedRecords });
      const recordIds = await trashRecords(db, schemas.data, tableId, command.recordIds, actor.userId);
      const changes = await linkVisibilityChanges(db, schemas, tableId, fields, recordIds);
      return {
        body: { kind: 'record.trashed', tableId, recordIds },
        prev: {},
        additional: changes.map((body) => ({ body, prev: {} })),
      };
    }
    case 'record.restore': {
      await guard.requireVisible(command.recordIds, { trashed: true });
      await guard.requireUnlocked(command.recordIds, { links: true, conditionalCopies: c.undoCopiedRecords });
      await guard.requireValid(
        command.recordIds.map((id) => ({ id, values: {} })),
        true,
      );
      const records = await guard.write(() =>
        restoreRecords(db, schemas.data, tableId, stored, command.recordIds),
      );
      const restoredIds = records.map((record) => record.id);
      // The links that come back have to sit inside their limits, for the links the person can
      // see.  One they can't see is no change of theirs, and refusing over it would name a field
      // hidden from them and say which of its linked records the limit keeps out.
      const scope = await scopeOf(c, tableId);
      for (const field of stored)
        if (!guard.unseen.has(field.id)) await requireLinkLimits(db, schemas.data, field, restoredIds);
      const changes = await linkVisibilityChanges(db, schemas, tableId, fields, restoredIds);
      // Restoring a target also revives its paired and one-way incoming links.
      for (const change of changes) {
        const field = await loadField(db, schemas, change.fieldId);
        if (field) await scope.ensureTable(field.tableId);
        if (field && scope.visibleFields(field.tableId, [field]).length)
          await requireLinkLimits(
            db,
            schemas.data,
            field,
            change.records.map((record) => record.id),
            field,
            undefined,
            restoredIds,
          );
      }
      return {
        body: { kind: 'record.restored', tableId, records },
        prev: {},
        additional: changes.map((body) => ({ body, prev: {} })),
      };
    }
  }
}

function answerRows<T extends { id: string; values: Record<string, unknown> }>(
  c: CommandContext,
  rows: readonly T[],
): T[] {
  return rows.map((row) => ({ ...row, values: { ...row.values, ...c.lineItemsAnswers?.get(row.id) } }));
}

function requireAnswers<T extends { id: string; values: Record<string, unknown> }>(
  c: CommandContext,
  questions: readonly FormQuestion[],
  rows: readonly T[],
  submitted: readonly T[] = rows,
): void {
  const answers = answerRows(c, rows);
  requireFormAnswers(questions, answers, answerRows(c, submitted));
  // Hidden questions lose their defaults in the stored rows as well as the answer preview.
  for (const [index, row] of rows.entries())
    for (const id of Object.keys(row.values))
      if (!Object.hasOwn(answers[index]!.values, id)) delete row.values[id];
}
