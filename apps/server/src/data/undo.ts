import { refuseDemo } from '../demo/boundary.js';
import { isDeepStrictEqual } from 'node:util';
import { restoreNamedFunction } from './commands/named-functions.js';
import {
  checkCalendarRemoval,
  prepareCalendarEvent,
  reuseCalendarEvent,
} from './commands/calendar-events.js';
import {
  RemovalInProgress,
  attemptRemoval,
  claimRemoval,
  removalsOf,
} from '../automations/calendar-removals.js';
import { isSelect } from './select-options.js';
import { createHash } from 'node:crypto';
import { requireUnlockedRecords, setRecordLocks } from './record-locks.js';
import { validateRecords } from './commands/validation.js';
import { requireUnlockedTable } from './commands/schema-records.js';
import { prepareUnique } from './commands/unique.js';
import { dataStore } from './context.js';
import { changeUniqueIndex } from './physical/unique.js';
import {
  AppError,
  newId,
  choicesForRecord,
  UndoResult,
  isPrimaryType,
  sameValue,
  jsonEqual,
  type GridConfig,
  type CellValues,
  type ChangeBody,
  type Command,
  type UndoRequest,
  idsOf,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { revertAutomation } from '../automations/commands.js';
import { matchedBefore } from '../automations/triggers.js';
import type { Actor } from '../http/policy.js';
import { AccessScope } from './access.js';
import {
  bumpVersion,
  field,
  invalid,
  publicField,
  scopeOf,
  setTrashed,
  storedField,
  table,
  view,
  uniqueName,
  visibleField,
  type CommandContext,
  type Mutation,
  type Previous,
} from './commands/context.js';
import { applyFields, backupColumn, saveField, requireSchemaCells } from './commands/fields.js';
import { actionFor, applyCommand } from './commands/index.js';
import { checkedRows } from './commands/records.js';
import { chain, mirrorMatch, rematch } from './commands/matches.js';
import { requireOwnPublicFields } from './commands/public-pages.js';
import { reverseMove } from './commands/positions.js';
import { recordChange, runStored } from './commands/transaction.js';
import { reverseCommentMoves } from './dedupe/merge.js';
import { isAccessRefusal, writeGuard } from './permissions/enforce.js';
import { attachFiles } from './files/cells.js';
import { loadDatabase, loadField, loadFields, loadTable } from './metadata.js';
import { columnType, decodeValue, jsonValueExpr, selectExpr } from './physical/columns.js';
import { dropFieldIndexes } from './physical/indexes.js';
import {
  clearChoices,
  currentValues,
  fetchRowsById,
  updateRecords,
  type RecordInput,
} from './physical/records.js';
import type { StoredField } from './types.js';
import { majorCreations } from './undo-preview.js';

interface SavedChange {
  seq: string;
  command_id: string;
  body: ChangeBody;
  prev: Previous;
}

interface Reversed extends Mutation {
  skipped: number;
}

export async function reverseRecords(
  c: CommandContext,
  body: Extract<ChangeBody, { kind: 'record.updated' }>,
  prev: Previous,
): Promise<Reversed> {
  const count = body.records.reduce((n, row) => n + Object.keys(row.values).length, 0);
  const parent = await loadTable(c.db, c.schemas, body.tableId);
  if (!parent || parent.trashed || parent.databaseId !== c.databaseId) {
    return { body: { ...body, records: [] }, prev: { records: [] }, skipped: count };
  }
  const fields = await loadFields(c.db, c.schemas, [body.tableId]);
  const byId = new Map(fields.map((f) => [f.id, f]));
  const ids = body.records.map((r) => r.id);
  await query(
    c.db,
    sql`SELECT __rid FROM ${ident(c.schemas.data, body.tableId)}
    WHERE __id = ANY(${ids}::text[]) ORDER BY __rid FOR UPDATE`,
  );
  const current = await currentValues(c.db, c.schemas.data, body.tableId, fields, ids, true);
  // A cell in a field the person may no longer change, or in a record they may no longer see, is
  // skipped like one someone else has changed since.
  const scope = await scopeOf(c, body.tableId);
  const guard = writeGuard(c.db, c.schemas, scope, body.tableId, fields);
  // Parent and child values must be checked together after collecting the cells undo can restore.
  const cellGuard = writeGuard(
    c.db,
    c.schemas,
    scope,
    body.tableId,
    fields.map((field) =>
      (field.type === 'singleSelect' || field.type === 'multipleSelect') && field.options.cascade
        ? { ...field, options: { ...field.options, cascade: undefined } }
        : field,
    ),
  );
  const previous = new Map(prev.records?.map((r) => [r.id, r.values]));
  const previousOverrides = new Map(prev.records?.map((r) => [r.id, r.overrides]));
  const currentOverrides = new Map(
    (await fetchRowsById(c.db, c.schemas.data, body.tableId, fields, ids)).map((r) => [r.id, r.overrides]),
  );
  let skipped = 0;
  const rows: RecordInput[] = [];
  for (const row of body.records) {
    try {
      await guard.requireVisible([row.id]);
    } catch (error) {
      if (!isAccessRefusal(error)) throw error;
      skipped += Object.keys(row.values).length;
      continue;
    }
    const values: CellValues = {};
    const overrides: NonNullable<RecordInput['overrides']> = {};
    for (const [id, written] of Object.entries(row.values)) {
      const f = byId.get(id);
      const before = previous.get(row.id);
      const actual = current.get(row.id);
      // Links that now follow values keep following them.
      const matched = f?.type === 'link' && Boolean(f.options.match);
      if (
        !f ||
        matched ||
        !actual ||
        !before ||
        !Object.hasOwn(before, id) ||
        !sameValue(actual[id], written)
      ) {
        skipped += 1;
        continue;
      }
      if (
        row.overrides &&
        Object.hasOwn(row.overrides, id) &&
        JSON.stringify(currentOverrides.get(row.id)?.[id] ?? null) !==
          JSON.stringify(row.overrides[id] ?? null)
      ) {
        skipped += 1;
        continue;
      }
      try {
        const cell = { id: row.id, values: { [id]: before[id] } };
        await guard.requireEditable([cell]);
        const checked = await checkedRows(c, guard.visible, [cell], {
          restoreSignatures: true,
          computedOverrides: Boolean(row.overrides && Object.hasOwn(row.overrides, id)),
        });
        await cellGuard.requireValid(checked, true);
        values[id] = checked[0]!.values[id]!;
      } catch (error) {
        if (!(error instanceof AppError) || (error.code !== 'validation_failed' && !isAccessRefusal(error)))
          throw error;
        skipped += 1;
        continue;
      }
      if (row.overrides && Object.hasOwn(row.overrides, id))
        overrides[id] = previousOverrides.get(row.id)?.[id] ?? null;
    }
    if (Object.keys(values).length) rows.push({ id: row.id, values, overrides });
  }
  const matched = rows.length
    ? await matchedBefore(
        c,
        body.tableId,
        rows.map((row) => row.id),
      )
    : undefined;
  let kept = await guard.keepHiddenLinks(rows, true);
  for (const row of kept) {
    let dropped: boolean;
    do {
      dropped = false;
      const values = { ...current.get(row.id), ...row.values };
      for (const field of fields) {
        if ((field.type !== 'singleSelect' && field.type !== 'multipleSelect') || !field.options.cascade)
          continue;
        const parent = field.options.cascade.fieldId;
        if (!Object.hasOwn(row.values, field.id) && !Object.hasOwn(row.values, parent)) continue;
        const value = values[field.id];
        const selected = typeof value === 'string' ? [value] : idsOf(value ?? null);
        const allowed = new Set(choicesForRecord(field.options, values).map((choice) => choice.id));
        if (!selected.some((id) => !allowed.has(id))) continue;
        for (const id of [field.id, parent]) {
          if (!Object.hasOwn(row.values, id)) continue;
          delete row.values[id];
          if (row.overrides) delete row.overrides[id];
          skipped++;
          dropped = true;
        }
      }
    } while (dropped);
  }
  kept = kept.filter((row) => Object.keys(row.values).length);
  await guard.requireValid(kept, true);
  await attachFiles(c, body.tableId, fields, kept, { restoring: true });
  const { updated, linkChanges, linkPositions, matchChanges } = await guard.write(() =>
    updateRecords(
      c.db,
      c.schemas.data,
      body.tableId,
      fields,
      kept,
      c.actor.userId,
      prev.linkPositions,
      undefined,
      guard.unseen,
    ),
  );
  await guard.requireWithinRules(updated.map((row) => row.id));
  return {
    body: {
      kind: 'record.updated',
      tableId: body.tableId,
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
    additional: (async function* () {
      for (const body of linkChanges ?? []) yield { body, prev: {} };
      if (matchChanges) for await (const body of matchChanges) yield { body, prev: {} };
    })(),
    ...(matched ? { triggers: { matchedBefore: matched } } : {}),
    skipped,
  };
}

async function reverseChoiceCells(
  c: CommandContext,
  target: StoredField,
  cells: NonNullable<Previous['choiceCells']>,
) {
  if (!cells.length) return { changed: [], skipped: 0 };
  const result = await query<{ __id: string; value: unknown }>(
    c.db,
    sql`SELECT __id, ${selectExpr(target)} AS value
    FROM ${ident(c.schemas.data, target.tableId)} WHERE __id = ANY(${cells.map((cell) => cell.id)}::text[])
    ORDER BY __rid FOR UPDATE`,
  );
  const current = new Map(result.rows.map((r) => [r.__id, decodeValue(target, r.value)]));
  const changed: NonNullable<Previous['choiceCells']> = [];
  let skipped = 0;
  for (const cell of cells) {
    if (!current.has(cell.id) || !sameValue(current.get(cell.id), cell.written)) {
      skipped += 1;
      continue;
    }
    await query(
      c.db,
      sql`UPDATE ${ident(c.schemas.data, target.tableId)} SET
      ${ident(target.columnName)} = ${jsonValueExpr(target, sql`${JSON.stringify(cell.prev)}::jsonb`)},
      __updated_at = statement_timestamp(), __updated_by = ${c.actor.userId} WHERE __id = ${cell.id}`,
    );
    changed.push({ id: cell.id, prev: cell.written, written: cell.prev });
  }
  return { changed, skipped };
}

async function reverseField(
  c: CommandContext,
  body: Extract<ChangeBody, { kind: 'field.updated' | 'field.converted' }>,
  prev: Previous,
  request: UndoRequest,
): Promise<Reversed> {
  // A field the person can no longer see reads as gone, so its change is skipped.
  const before = storedField(await visibleField(c, body.field.id));
  const target = prev.field!;
  // Going back changes what the field holds as much as the change did.
  if (before.type !== target.type || !jsonEqual(before.options, target.options))
    await requireOwnPublicFields(c, [before]);
  if (body.kind === 'field.converted' || before.columnName !== target.columnName)
    await requireSchemaCells(c, before, 'convert');
  else if (
    prev.choiceCells?.length ||
    ((before.type === 'singleSelect' || before.type === 'multipleSelect') &&
      (target.type === 'singleSelect' || target.type === 'multipleSelect') &&
      before.options.choices.some((choice) => !target.options.choices.some((kept) => kept.id === choice.id)))
  )
    await requireSchemaCells(c, before, 'choices');
  const preservesSourceIds =
    before.columnName === target.columnName &&
    isSelect(before) &&
    isSelect(target) &&
    Boolean(before.options.source) !== Boolean(target.options.source);
  const removesChoices =
    !preservesSourceIds &&
    (before.type === 'singleSelect' || before.type === 'multipleSelect') &&
    (target.type === 'singleSelect' || target.type === 'multipleSelect') &&
    before.options.choices.some((choice) => !target.options.choices.some((other) => other.id === choice.id));
  if (before.columnName !== target.columnName || removesChoices)
    await requireUnlockedTable(
      c,
      before.tableId,
      sql`TRUE`,
      before.source?.sourceType === 'joined' ? before : undefined,
    );
  if (prev.choiceCells?.length)
    await requireUnlockedRecords(
      c,
      before.tableId,
      prev.choiceCells.map((cell) => cell.id),
    );
  const parent = await table(c, before.tableId);
  if (parent.primaryFieldId === target.id && !isPrimaryType(target.type)) invalid('data.field.primaryType');
  await uniqueName(c, 'field', target.tableId, target.name, target.id);
  if (before.columnName !== target.columnName) {
    if (columnType(target)) {
      const backup = await query(
        c.db,
        sql`SELECT column_name FROM ${ident(c.schemas.app, 'column_backups')}
        WHERE table_id = ${target.tableId} AND field_id = ${target.id} AND column_name = ${target.columnName}`,
      );
      if (!backup.rowCount) throw new AppError('not_found', 'errors.notFound');
    }
    await backupColumn(c, before);
    await query(
      c.db,
      sql`DELETE FROM ${ident(c.schemas.app, 'column_backups')}
      WHERE table_id = ${target.tableId} AND column_name = ${target.columnName}`,
    );
    await dropFieldIndexes(c.db, c.schemas, before.tableId, before.id);
  }
  await changeUniqueIndex(c.db, c.schemas, before, target);
  await saveField(c, target);
  const additional: Mutation[] = [];
  if (body.kind === 'field.converted') {
    for (const [value, trash] of [
      [before, true],
      [target, false],
    ] as const) {
      if (value.type !== 'link' || !value.options.inverseFieldId) continue;
      const mutation = await applyFields(
        c,
        {
          kind: trash ? 'field.trash' : 'field.restore',
          id: request.commandId,
          groupId: request.groupId,
          fieldId: value.options.inverseFieldId,
        },
        true,
      );
      mutation.prev.dependent = true;
      additional.push(mutation);
    }
  }
  const restored = await reverseChoiceCells(c, target, prev.choiceCells ?? []);
  const remaining =
    target.type === 'singleSelect' || target.type === 'multipleSelect'
      ? new Set(target.options.choices.map((choice) => choice.id))
      : new Set<string>();
  const removedChoiceIds =
    !preservesSourceIds && (before.type === 'singleSelect' || before.type === 'multipleSelect')
      ? before.options.choices.filter((choice) => !remaining.has(choice.id)).map((choice) => choice.id)
      : [];
  const cleared =
    body.kind === 'field.updated'
      ? await clearChoices(c.db, c.schemas.data, target.tableId, target, removedChoiceIds, c.actor.userId)
      : [];
  for (const cell of cleared) {
    const kept = idsOf(cell.prev).filter((id) => !removedChoiceIds.includes(id));
    const earlier = restored.changed.find((change) => change.id === cell.id);
    if (earlier) earlier.written = kept.length ? kept : null;
    else restored.changed.push({ ...cell, written: kept.length ? kept : null });
  }
  if (restored.changed.length)
    await validateRecords(
      c,
      target.tableId,
      await loadFields(c.db, c.schemas, [target.tableId]),
      restored.changed.map((cell) => ({ id: cell.id, values: {} })),
      true,
    );
  await bumpVersion(c, target.tableId);
  // Both sides of a link agree on what it follows, and links that follow values catch up with
  // them once everything they follow is back.
  const current = await field(c, target.id);
  if (current.type === 'link') additional.push(...(await mirrorMatch(c, current)));
  const matched = await rematch(c, target.id, false);
  const after = publicField(await field(c, target.id));
  return {
    body:
      body.kind === 'field.converted'
        ? { kind: 'field.converted', field: after }
        : { kind: 'field.updated', field: after, removedChoiceIds },
    prev: { field: before, choiceCells: restored.changed },
    skipped: restored.skipped,
    additional: chain(additional, matched),
  };
}

function unavailablePlacement(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.code === 'not_found' || isAccessRefusal(error) || error.messageKey === 'data.locks.viewLocked')
  );
}

async function reverseFieldOrder(
  c: CommandContext,
  patch: NonNullable<Previous['viewFieldOrder']>,
  request: UndoRequest,
): Promise<Reversed> {
  const mutation = await applyCommand(c, {
    id: request.commandId,
    groupId: request.groupId,
    kind: 'view.update',
    viewId: patch.viewId,
    config: { fieldOrder: patch.fieldOrder },
  });
  return {
    ...mutation,
    prev: { viewFieldOrder: { viewId: patch.viewId, fieldOrder: mutation.prev.view!.config.fieldOrder } },
    skipped: 0,
  };
}

/** A copied column owns only its placement and formatting, so later view edits stay in place. */
async function reverseCopiedView(
  c: CommandContext,
  body: Extract<ChangeBody, { kind: 'view.updated' }>,
  prev: Previous,
  request: UndoRequest,
): Promise<Reversed> {
  const fieldId = prev.copyViewPlacement!.fieldId;
  const before = prev.view!.config;
  const current = (await view(c, body.view.id)).view.config;
  const config: Partial<GridConfig> = {};
  const order = current.fieldOrder.filter((id) => id !== fieldId);
  const index = before.fieldOrder.indexOf(fieldId);
  if (index >= 0) {
    const next = before.fieldOrder.slice(index + 1).find((id) => order.includes(id));
    const previous = before.fieldOrder
      .slice(0, index)
      .reverse()
      .find((id) => order.includes(id));
    order.splice(
      next ? order.indexOf(next) : previous ? order.indexOf(previous) + 1 : order.length,
      0,
      fieldId,
    );
  }
  config.fieldOrder =
    index < 0 &&
    jsonEqual(
      order,
      body.view.config.fieldOrder.filter((id) => id !== fieldId),
    )
      ? before.fieldOrder
      : order;
  function restore<T>(present: T[], target: T[], belongs: (item: T) => boolean): T[] {
    const result = present.filter((item) => !belongs(item));
    target.forEach((item, index) => {
      if (belongs(item)) result.splice(Math.min(index, result.length), 0, item);
    });
    return result;
  }
  const hidden = restore(current.hiddenFieldIds, before.hiddenFieldIds, (id) => id === fieldId);
  if (!jsonEqual(hidden, current.hiddenFieldIds)) config.hiddenFieldIds = hidden;
  const rules = restore(
    current.colorRules,
    before.colorRules,
    (rule) => rule.target === 'cell' && rule.condition.fieldId === fieldId,
  );
  if (!jsonEqual(rules, current.colorRules)) config.colorRules = rules;
  for (const key of ['colorScales', 'dataBars', 'iconSets'] as const) {
    const items = restore<{ fieldId: string }>(current[key], before[key], (item) => item.fieldId === fieldId);
    if (!jsonEqual(items, current[key])) config[key] = items as never[];
  }
  const mutation = await applyCommand(
    { ...c, copyViewPlacement: true },
    {
      id: request.commandId,
      groupId: request.groupId,
      kind: 'view.update',
      viewId: body.view.id,
      config,
    },
  );
  mutation.prev.copyViewPlacement = prev.copyViewPlacement;
  return { ...mutation, skipped: 0 };
}

/** Form edit history uses the same conditional reversal and access checks as record undo. */
export async function reverseRecordChange(
  c: CommandContext,
  body: Extract<
    ChangeBody,
    { kind: 'record.updated' | 'record.created' | 'record.trashed' | 'record.restored' }
  >,
  prev: Previous,
): Promise<Reversed> {
  return reverse(
    c,
    { seq: '', command_id: '', body, prev },
    {
      commandId: newId('command'),
      groupId: newId('action'),
      clientId: newId('client'),
    },
    false,
  );
}

async function reverse(
  c: CommandContext,
  saved: SavedChange,
  request: UndoRequest,
  trashingDatabase: boolean,
): Promise<Reversed> {
  const { body, prev } = saved;
  const base = { id: request.commandId, groupId: request.groupId };
  const foreignFields = async (trash: boolean): Promise<Mutation[]> => {
    const result: Mutation[] = [];
    const append = async (mutation: Mutation): Promise<void> => {
      const extra = mutation.additional;
      delete mutation.additional;
      mutation.prev.dependent = true;
      result.push(mutation);
      if (extra) for await (const item of extra) await append(item);
    };
    for (const id of prev.copyForeignFields ?? []) {
      const field = await loadField(c.db, c.schemas, id);
      const parent = field && (await loadTable(c.db, c.schemas, field.tableId));
      if (!parent || parent.orgId !== c.actor.orgId) throw new AppError('not_found', 'errors.notFound');
      const scope = new AccessScope(c.db, c.schemas, c.actor);
      await scope.require(parent.databaseId, 'editSchema');
      await append(
        await applyFields(
          { ...c, databaseId: parent.databaseId, scope },
          { ...base, kind: trash ? 'field.trash' : 'field.restore', fieldId: id },
        ),
      );
    }
    return result;
  };
  const apply = async (command: Command): Promise<Reversed> => {
    if (
      command.kind === 'table.trash' &&
      (trashingDatabase || prev.schemaCopy || (await loadTable(c.db, c.schemas, command.tableId))?.lineItems)
    ) {
      // Reversing database creation removes its first table in the same atomic operation.
      const before = await table(c, command.tableId, true);
      if (!prev.schemaCopy && !before.lineItems) await requireUnlockedTable(c, before.id);
      const additional = await foreignFields(true);
      await setTrashed(c, 'table', before.id, true);
      return {
        body: { kind: 'table.trashed', tableId: before.id },
        prev: {
          trashed: before.trashed,
          ...(prev.schemaCopy ? { schemaCopy: true } : {}),
          ...(prev.copyForeignFields ? { copyForeignFields: prev.copyForeignFields } : {}),
        },
        additional,
        skipped: 0,
      };
    }
    const mutation = await applyCommand(c, command);
    if (prev.schemaCopy) mutation.prev.schemaCopy = true;
    if (prev.copyForeignFields) {
      mutation.prev.copyForeignFields = prev.copyForeignFields;
      if (command.kind === 'table.restore')
        mutation.additional = chain(mutation.additional, await foreignFields(false));
    }
    const actual =
      'records' in mutation.body
        ? mutation.body.records.length
        : 'recordIds' in mutation.body
          ? mutation.body.recordIds.length
          : 0;
    return { ...mutation, skipped: 'recordIds' in command ? command.recordIds.length - actual : 0 };
  };
  switch (body.kind) {
    case 'automation.notified':
      return apply({
        ...base,
        kind: 'automation.notify',
        automationId: body.automationId,
        subjectId: body.subjectId,
        remove: body.created,
        notifications: prev.notifications!,
      });
    case 'automation.calendarEventChanged':
      return apply(calendarInverse(saved, request));
    case 'access.changed':
    case 'table.synced':
    case 'comment.created':
    case 'comment.updated':
    case 'comment.deleted':
      // Rule changes, syncs, and comments belong to no one's undo history.
      throw new AppError('conflict', 'errors.validationFailed');
    case 'comment.moved':
      // Comments a merge moved go back with it, though the comments themselves never undo.
      return reverseCommentMoves(c, body);
    case 'button.ran':
      return apply({
        ...base,
        kind: 'automation.cancelRun',
        automationId: body.automationId,
        runId: body.runId,
        canceled: true,
      });
    case 'automation.runCanceled':
      return apply({
        ...base,
        kind: 'automation.cancelRun',
        automationId: body.automationId,
        runId: body.runId,
        canceled: !body.canceled,
      });
    case 'automation.created':
      return apply({ ...base, kind: 'automation.trash', automationId: body.automation.id });
    case 'automation.trashed':
      return apply({
        ...base,
        kind: prev.trashed ? 'automation.trash' : 'automation.restore',
        automationId: body.automationId,
      });
    case 'automation.restored':
      return apply({
        ...base,
        kind: prev.trashed ? 'automation.trash' : 'automation.restore',
        automationId: body.automation.id,
      });
    case 'automation.updated': {
      // The draft comes back, and the published version too when the change being undone changed
      // it, so undoing a publish runs what ran before and undoing anything else never does.
      const target = prev.automation!;
      const republish =
        body.automation.version !== target.version || body.automation.publishedAt !== target.publishedAt;
      return { ...(await revertAutomation(c, target, republish)), skipped: 0 };
    }
    case 'namedFunction.changed':
      return { ...(await restoreNamedFunction(c, body.functionId, prev.namedFunction ?? null)), skipped: 0 };
    case 'record.locksChanged': {
      const changes: Mutation[] = [];
      for (const entry of prev.recordLocks ?? [])
        changes.push(
          await setRecordLocks(c, body.tableId, [entry.id], entry.reason !== null, entry.reason ?? ''),
        );
      const first = changes.shift();
      return first ? { ...first, additional: changes, skipped: 0 } : { body, prev: {}, skipped: 0 };
    }
    case 'record.updated':
      return reverseRecords(c, body, prev);
    case 'record.moved':
      return reverseMove(c, body, prev);
    case 'record.created':
    case 'record.restored': {
      if (prev.copiedRecords) {
        const ids = body.records.map((row) => row.id);
        const recordIds = ids.filter((id) => c.undoCopiedRecords?.get(body.tableId)?.has(id));
        const mutation = await apply({ ...base, kind: 'record.trash', tableId: body.tableId, recordIds });
        mutation.prev.copiedRecords = prev.copiedRecords.filter((row) => recordIds.includes(row.id));
        return { ...mutation, skipped: mutation.skipped + ids.length - recordIds.length };
      }
      return apply({
        ...base,
        kind: 'record.trash',
        tableId: body.tableId,
        recordIds: body.records.map((r) => r.id),
      });
    }
    case 'record.trashed':
      if (prev.copiedRecords) {
        const recordIds = body.recordIds.filter((id) => c.undoCopiedRecords?.get(body.tableId)?.has(id));
        const mutation = await apply({ ...base, kind: 'record.restore', tableId: body.tableId, recordIds });
        mutation.prev.copiedRecords = prev.copiedRecords.filter((row) => recordIds.includes(row.id));
        return { ...mutation, skipped: mutation.skipped + body.recordIds.length - recordIds.length };
      }
      return apply({ ...base, kind: 'record.restore', tableId: body.tableId, recordIds: body.recordIds });
    case 'database.created':
      return apply({ ...base, kind: 'database.trash' });
    case 'database.updated':
      if (prev.navigation)
        return apply({
          ...base,
          kind: 'database.navigation',
          change: { kind: 'restore', patch: prev.navigation },
        });
      return apply({ ...base, ...prev.database!, kind: 'database.update', id: base.id });
    case 'database.trashed':
    case 'database.restored':
      return apply({ ...base, kind: prev.trashed ? 'database.trash' : 'database.restore' });
    case 'table.created':
      return apply({ ...base, kind: 'table.trash', tableId: body.table.id });
    case 'table.trashed':
      return apply({ ...base, kind: prev.trashed ? 'table.trash' : 'table.restore', tableId: body.tableId });
    case 'table.restored':
      return apply({ ...base, kind: prev.trashed ? 'table.trash' : 'table.restore', tableId: body.table.id });
    case 'table.updated': {
      const target = prev.table!;
      const update = await apply({
        ...base,
        kind: 'table.update',
        tableId: target.id,
        ...(target.joined && !isDeepStrictEqual(target.joined, body.table.joined)
          ? { joined: target.joined }
          : {}),
        recordLock: target.recordLock ?? { condition: null, bypass: 'owners', reason: '' },
        name: target.name,
        description: target.description,
        ...(target.allowComputedOverrides !== undefined
          ? { allowComputedOverrides: target.allowComputedOverrides }
          : {}),
        ...(target.historyRetentionDays !== undefined
          ? { historyRetentionDays: target.historyRetentionDays }
          : {}),
      });
      if (target.source)
        await apply({
          ...base,
          kind: 'table.updateSource',
          tableId: target.id,
          settings: {
            everyMinutes: target.source.everyMinutes,
            allowOverrides: target.source.allowOverrides,
            holdAboveDeleteShare: target.source.holdAboveDeleteShare,
          },
        });
      const move = await apply({
        ...base,
        kind: 'table.move',
        tableId: target.id,
        position: target.position,
      });
      return { ...move, prev: update.prev };
    }
    case 'field.created': {
      const mutation = await apply({ ...base, kind: 'field.trash', fieldId: body.field.id });
      const views: Mutation[] = [];
      if (prev.schemaCopy && body.field.type === 'lineItems')
        views.push(await apply({ ...base, kind: 'table.trash', tableId: body.field.options.linkedTableId }));
      let skipped = mutation.skipped;
      for (const previous of prev.views ?? []) {
        // Placement is independent of the field's reversal when the view is unavailable.
        await query(c.db, sql`SAVEPOINT undo_placement`);
        try {
          views.push(
            await reverseFieldOrder(
              c,
              {
                viewId: previous.id,
                fieldOrder: previous.config.fieldOrder,
              },
              request,
            ),
          );
        } catch (error) {
          if (!unavailablePlacement(error)) throw error;
          await query(c.db, sql`ROLLBACK TO SAVEPOINT undo_placement`);
          skipped += 1;
        }
        await query(c.db, sql`RELEASE SAVEPOINT undo_placement`);
      }
      return { ...mutation, additional: chain(mutation.additional, views), skipped };
    }
    case 'field.trashed':
      return apply({ ...base, kind: prev.trashed ? 'field.trash' : 'field.restore', fieldId: body.fieldId });
    case 'field.restored':
      return apply({ ...base, kind: prev.trashed ? 'field.trash' : 'field.restore', fieldId: body.field.id });
    case 'field.updated':
    case 'field.converted':
      return reverseField(c, body, prev, request);
    case 'field.primarySet':
      return apply({
        ...base,
        kind: 'field.setPrimary',
        tableId: body.table.id,
        fieldId: prev.table!.primaryFieldId,
      });
    case 'view.created':
      return apply({ ...base, kind: 'view.trash', viewId: body.view.id });
    case 'view.trashed':
      return apply({ ...base, kind: prev.trashed ? 'view.trash' : 'view.restore', viewId: body.viewId });
    case 'view.restored':
      return apply({ ...base, kind: prev.trashed ? 'view.trash' : 'view.restore', viewId: body.view.id });
    case 'view.updated': {
      if (prev.copyViewPlacement) return reverseCopiedView(c, body, prev, request);
      if (prev.viewFieldOrder) return reverseFieldOrder(c, prev.viewFieldOrder, request);
      const target = prev.view!;
      // Unlock before restoring settings, and restore position before a possible relock.
      // Keep the state before all of these changes so redo reverses the whole operation.
      const unlock =
        body.view.config.locked && !target.config.locked
          ? await apply({
              ...base,
              kind: 'view.update',
              viewId: target.id,
              config: { locked: false },
            })
          : undefined;
      const move = await apply({ ...base, kind: 'view.move', viewId: target.id, position: target.position });
      const update = await apply({
        ...base,
        kind: 'view.update',
        viewId: target.id,
        name: target.name,
        config: target.config,
      });
      return { ...update, prev: unlock?.prev ?? move.prev };
    }
    case 'dashboard.created':
      return apply({ ...base, kind: 'dashboard.trash', dashboardId: body.dashboard.id });
    case 'dashboard.trashed':
      return apply({
        ...base,
        kind: prev.trashed ? 'dashboard.trash' : 'dashboard.restore',
        dashboardId: body.dashboardId,
      });
    case 'dashboard.restored':
      return apply({
        ...base,
        kind: prev.trashed ? 'dashboard.trash' : 'dashboard.restore',
        dashboardId: body.dashboard.id,
      });
    case 'dashboard.updated': {
      const target = prev.dashboard!;
      const update = await apply({
        ...base,
        kind: 'dashboard.update',
        dashboardId: target.id,
        name: target.name,
        config: target.config,
      });
      const move = await apply({
        ...base,
        kind: 'dashboard.move',
        dashboardId: target.id,
        position: target.position,
      });
      return { ...move, prev: update.prev };
    }
    case 'interface.created':
      return apply({ ...base, kind: 'interface.trash', interfaceId: body.interface.id });
    case 'interface.trashed':
      return apply({
        ...base,
        kind: prev.trashed ? 'interface.trash' : 'interface.restore',
        interfaceId: body.interfaceId,
      });
    case 'interface.restored':
      return apply({
        ...base,
        kind: prev.trashed ? 'interface.trash' : 'interface.restore',
        interfaceId: body.interface.id,
      });
    case 'interface.updated': {
      const target = prev.interface!;
      const update = await apply({
        ...base,
        kind: 'interface.update',
        interfaceId: target.id,
        name: target.name,
        pages: target.pages,
      });
      const move = await apply({
        ...base,
        kind: 'interface.move',
        interfaceId: target.id,
        position: target.position,
      });
      return { ...move, prev: update.prev };
    }
    case 'script.created':
      return apply({ ...base, kind: 'script.trash', scriptId: body.script.id });
    case 'script.trashed':
      return apply({
        ...base,
        kind: prev.trashed ? 'script.trash' : 'script.restore',
        scriptId: body.scriptId,
      });
    case 'script.restored':
      return apply({
        ...base,
        kind: prev.trashed ? 'script.trash' : 'script.restore',
        scriptId: body.script.id,
      });
    case 'script.updated': {
      const target = prev.script!;
      const update = await apply({
        ...base,
        kind: 'script.update',
        scriptId: target.id,
        name: target.name,
        description: target.description,
        source: target.source,
      });
      const move = await apply({
        ...base,
        kind: 'script.move',
        scriptId: target.id,
        position: target.position,
      });
      return { ...move, prev: update.prev };
    }
    case 'record.linksChanged':
      throw new Error('Link lists are restored through the edit that changed them');
  }
}

function calendarInverse(
  saved: SavedChange,
  request: UndoRequest,
): Extract<Command, { kind: 'automation.calendarEvent' }> {
  if (saved.body.kind !== 'automation.calendarEventChanged' || !saved.prev.calendarEvent)
    throw new AppError('conflict', 'errors.conflict');
  return {
    id: `cmd${createHash('sha256').update(`${saved.command_id}:${saved.seq}:inverse`).digest('hex').slice(0, 14)}`,
    groupId: request.groupId,
    kind: 'automation.calendarEvent',
    automationId: saved.body.automationId,
    event: saved.prev.calendarEvent,
    accountId: saved.prev.calendarAccountId,
    eventId: saved.body.eventId,
    remove: saved.body.created,
  };
}

async function changesToReverse(
  c: Pick<CommandContext, 'db' | 'schemas' | 'databaseId'>,
  request: UndoRequest,
  direction: 'undo' | 'redo',
): Promise<SavedChange[]> {
  const link = direction === 'undo' ? 'redo_of' : 'undo_of';
  const latest = await query<{ command_id: string; seq: string }>(
    c.db,
    sql`SELECT command_id, seq FROM ${ident(c.schemas.app, 'changes')}
    WHERE database_id = ${c.databaseId} AND ${ident(link)} = ${request.groupId} ORDER BY seq DESC LIMIT 1`,
  );
  const cycle = latest.rows[0];
  const result = await query<SavedChange>(
    c.db,
    sql`SELECT seq, command_id, body, prev FROM ${ident(c.schemas.app, 'changes')}
    WHERE database_id = ${c.databaseId} AND group_id = ${request.groupId}
      AND ${
        cycle
          ? sql`(command_id = ${cycle.command_id} OR (seq > ${cycle.seq} AND undo_of IS NULL AND redo_of IS NULL))`
          : sql`undo_of IS NULL AND redo_of IS NULL`
      }
    ORDER BY seq DESC`,
  );
  return result.rows;
}

async function runUndoStored(
  app: FastifyInstance,
  actor: Actor,
  databaseId: string,
  request: UndoRequest,
  direction: 'undo' | 'redo',
  preparationError?: AppError,
  preparedCalendar?: CommandContext['preparedCalendar'],
): Promise<UndoResult> {
  refuseDemo(actor);
  return runStored<UndoResult>(
    app,
    actor,
    databaseId,
    {
      commandId: request.commandId,
      groupId: request.groupId,
      long: true,
      duplicate(value) {
        const stored = UndoResult.safeParse(value);
        if (!stored.success) throw new AppError('conflict', 'errors.conflict');
        return stored.data;
      },
      rejected: (error) => ({ status: 'rejected', skipped: 0, error: error.toBody().error }),
    },
    async (c) => {
      if (preparationError) throw preparationError;
      c.preparedCalendar = preparedCalendar;
      c.undoCommandId = request.commandId;
      const database = await loadDatabase(c.db, c.schemas, databaseId);
      if (database)
        await new AccessScope(c.db, c.schemas, actor).require(databaseId, 'read', { includeTrashed: true });
      else {
        const history = await query(
          c.db,
          sql`SELECT 1 FROM ${ident(c.schemas.app, 'changes')}
          WHERE database_id = ${databaseId} AND org_id = ${actor.orgId} AND actor_id = ${actor.userId}
          AND group_id = ${request.groupId} LIMIT 1`,
        );
        if (!history.rowCount) throw new AppError('not_found', 'errors.notFound');
      }
      const groups = await query<{ actor_id: string; state: 'done' | 'undone' }>(
        c.db,
        sql`SELECT actor_id, state
      FROM ${ident(c.schemas.app, 'undo_groups')} WHERE group_id = ${request.groupId} AND database_id = ${databaseId}`,
      );
      const group = groups.rows[0];
      if (!group) throw new AppError('not_found', 'errors.notFound');
      if (group.actor_id !== actor.userId) throw new AppError('forbidden', 'data.access.denied');
      if (database) {
        // A redo's inverse may have another kind, so authorize the original history in both directions.
        const kinds = await query<{ kind: ChangeBody['kind'] }>(
          c.db,
          sql`
          SELECT DISTINCT body->>'kind' AS kind FROM ${ident(c.schemas.app, 'changes')}
          WHERE database_id = ${databaseId} AND group_id = ${request.groupId}
          AND undo_of IS NULL AND redo_of IS NULL AND NOT COALESCE((prev->>'dependent')::boolean, false)
        `,
        );
        const scope = new AccessScope(c.db, c.schemas, actor);
        for (const action of new Set(kinds.rows.map(({ kind }) => actionFor(kind))))
          await scope.require(databaseId, action, { includeTrashed: true });
      }
      if (group.state === (direction === 'undo' ? 'undone' : 'done'))
        return { status: 'nothing', skipped: 0 };
      const creations = await majorCreations(c.db, c.schemas, databaseId, request.groupId);
      if (direction === 'undo' && creations.length && request.confirmedMajorCreation !== true)
        throw new AppError('conflict', 'data.undo.majorCreationConfirmationRequired');
      let originals = await changesToReverse(c, request, direction);
      if (direction === 'undo' && creations.length) {
        // Trashing the parent preserves its current contents, including other people's work,
        // exactly like a manual deletion.  Redo restores the parent with those contents intact.
        const databaseCreation = creations.some(({ body }) => body.kind === 'database.created');
        const tableIds = new Set(
          creations.flatMap(({ body }) => (body.kind === 'table.created' ? [body.table.id] : [])),
        );
        const containedTableIds = new Set(tableIds);
        const inverseFieldIds = new Set<string>();
        for (const { body } of originals)
          if (
            (body.kind === 'table.created' || body.kind === 'table.restored') &&
            body.table.lineItems &&
            tableIds.has(body.table.lineItems.parentTableId)
          )
            containedTableIds.add(body.table.id);
        for (const { body, prev } of originals) {
          if (
            (body.kind !== 'table.created' && body.kind !== 'table.restored') ||
            !containedTableIds.has(body.table.id)
          )
            continue;
          for (const field of body.fields)
            if ((field.type === 'link' || field.type === 'lineItems') && field.options.inverseFieldId)
              inverseFieldIds.add(field.options.inverseFieldId);
          for (const id of prev.copyForeignFields ?? []) inverseFieldIds.add(id);
        }
        originals = originals.filter(({ body, prev }) => {
          if (databaseCreation) return body.kind.startsWith('database.') && body.kind !== 'database.updated';
          if (body.kind === 'table.created' || body.kind === 'table.restored')
            return tableIds.has(body.table.id);
          const fieldId = 'fieldId' in body ? body.fieldId : 'field' in body ? body.field.id : undefined;
          if (fieldId && inverseFieldIds.has(fieldId)) return false;
          const tableId =
            'tableId' in body
              ? body.tableId
              : 'field' in body
                ? body.field.tableId
                : 'view' in body
                  ? body.view.tableId
                  : (prev.field?.tableId ?? prev.view?.tableId);
          return !tableId || !containedTableIds.has(tableId);
        });
        originals = originals.map((original) => {
          if (
            (original.body.kind !== 'table.created' && original.body.kind !== 'table.restored') ||
            !tableIds.has(original.body.table.id)
          )
            return original;
          // Ordinary table trash retains paired fields and owned children for restoration.
          const prev = { ...original.prev };
          delete prev.schemaCopy;
          delete prev.copyForeignFields;
          return { ...original, prev };
        });
      }
      if (direction === 'undo') {
        const createdFields = new Set(
          originals.flatMap(({ body, prev }) =>
            body.kind === 'field.created' && !prev.dependent ? [body.field.id] : [],
          ),
        );
        const childCreations: SavedChange[] = [];
        originals = originals.filter((original) => {
          const { body } = original;
          if (
            body.kind === 'table.created' &&
            body.table.lineItems &&
            createdFields.has(body.table.lineItems.parentFieldId)
          ) {
            childCreations.push(original);
            return false;
          }
          return true;
        });
        // Reverse the owning field and its pair while the child table is still available.
        originals.push(...childCreations);
      }
      // Check the whole copy before its own paired-link inverses update any copied row's timestamp.
      const unchangedCopies = new Map<string, Set<string>>();
      const childCopies: Array<{ tableId: string; parentTableId: string; id: string; parentId: string }> = [];
      for (const original of originals) {
        if (!original.prev.copiedRecords || !('tableId' in original.body) || !database) continue;
        const tableId = original.body.tableId;
        const parent = await loadTable(c.db, c.schemas, tableId);
        if (!parent || parent.trashed || parent.databaseId !== databaseId) continue;
        const scope = await scopeOf(c, tableId);
        const saved = original.prev.copiedRecords;
        if (parent.lineItems)
          for (const row of saved)
            if (row.parentId)
              childCopies.push({
                tableId,
                parentTableId: parent.lineItems.parentTableId,
                id: row.id,
                parentId: row.parentId,
              });
        const unchanged = await query<{ id: string }>(
          c.db,
          sql`
          SELECT r.__id AS id FROM ${ident(c.schemas.data, tableId)} r
          JOIN unnest(${saved.map((row) => row.id)}::text[], ${saved.map((row) => row.updatedAt)}::text[]) AS copied(id, at)
            ON copied.id = r.__id AND copied.at = r.__updated_at::text
          WHERE (${scope.recordPredicate(tableId, 'r', { trashedParents: direction === 'redo' })}) ORDER BY r.__rid FOR UPDATE OF r`,
        );
        const ids = unchangedCopies.get(tableId) ?? new Set<string>();
        for (const row of unchanged.rows) ids.add(row.id);
        unchangedCopies.set(tableId, ids);
      }
      // A retained parent keeps its children, and an edited child keeps its copied parent visible.
      for (const child of childCopies)
        if (!unchangedCopies.get(child.tableId)?.has(child.id))
          unchangedCopies.get(child.parentTableId)?.delete(child.parentId);
      for (const child of childCopies)
        if (!unchangedCopies.get(child.parentTableId)?.has(child.parentId))
          unchangedCopies.get(child.tableId)?.delete(child.id);
      c.undoCopiedRecords = unchangedCopies;
      const trashingDatabase = originals.some(
        ({ body, prev }) =>
          body.kind === 'database.created' ||
          ((body.kind === 'database.trashed' || body.kind === 'database.restored') && prev.trashed),
      );
      const mutations: Reversed[] = [];
      let skipped = 0;
      for (const original of originals) {
        if (original.body.kind.startsWith('comment.') && original.body.kind !== 'comment.moved') continue;
        // The other side of a link edit follows from the edit itself, so reversing that restores it.
        if (original.body.kind === 'record.linksChanged' || original.prev.dependent) continue;
        const missed =
          'recordIds' in original.body
            ? original.body.recordIds.length
            : 'records' in original.body
              ? original.body.records.length
              : 1;
        if (!database) {
          skipped += missed;
          continue;
        }
        await query(c.db, sql`SAVEPOINT undo_item`);
        try {
          mutations.push(await reverse(c, original, request, trashingDatabase));
        } catch (error) {
          // What the person can no longer see or change is skipped, like what's gone.
          if (
            original.prev.viewFieldOrder
              ? !unavailablePlacement(error)
              : !(error instanceof AppError) || (error.code !== 'not_found' && !isAccessRefusal(error))
          )
            throw error;
          await query(c.db, sql`ROLLBACK TO SAVEPOINT undo_item`);
          skipped += missed;
        }
        await query(c.db, sql`RELEASE SAVEPOINT undo_item`);
      }
      // Without an inverse, advancing history would make the next reversal fall back to the original.
      const state = mutations.length ? (direction === 'undo' ? 'undone' : 'done') : group.state;
      if (mutations.length)
        await query(
          c.db,
          sql`UPDATE ${ident(c.schemas.app, 'undo_groups')} SET state = ${state},
      updated_at = statement_timestamp() WHERE group_id = ${request.groupId}`,
        );
      let seq: number | undefined;
      let changed = false;
      for (const mutation of mutations)
        if (mutation.prev.copiedRecords && 'tableId' in mutation.body) {
          const body = mutation.body;
          const ids =
            'records' in body ? body.records.map((row) => row.id) : 'recordIds' in body ? body.recordIds : [];
          const parents = new Map(mutation.prev.copiedRecords.map((row) => [row.id, row.parentId]));
          mutation.prev.copiedRecords = (
            await query<{ id: string; updatedAt: string }>(
              c.db,
              sql`
            SELECT __id AS id, __updated_at::text AS "updatedAt" FROM ${ident(c.schemas.data, body.tableId)}
            WHERE __id = ANY(${ids}::text[])`,
            )
          ).rows.map((row) => ({
            ...row,
            ...(parents.get(row.id) ? { parentId: parents.get(row.id) } : {}),
          }));
        }
      for (const mutation of mutations) {
        const body = mutation.body;
        changed ||=
          body.kind === 'comment.moved'
            ? body.comments.length > 0
            : !body.kind.startsWith('record.') ||
              ('records' in body
                ? body.records.length > 0
                : 'recordIds' in body && body.recordIds.length > 0);
        seq = await recordChange(c, mutation, {
          commandId: request.commandId,
          groupId: request.groupId,
          clientId: request.clientId,
          ...(direction === 'undo' ? { undoOf: request.groupId } : { redoOf: request.groupId }),
        });
      }
      return {
        status: changed ? 'applied' : 'nothing',
        state,
        skipped: mutations.reduce((n, mutation) => n + mutation.skipped, skipped),
        ...(seq === undefined ? {} : { seq }),
      };
    },
  );
}

/** Restoring a unique rule prepares its index before entering the undo transaction. */
export async function runUndo(
  app: FastifyInstance,
  actor: Actor,
  databaseId: string,
  request: UndoRequest,
  direction: 'undo' | 'redo',
): Promise<UndoResult> {
  const { pool, schemas } = dataStore(app.ctx);
  const prepared: Array<NonNullable<Awaited<ReturnType<typeof prepareUnique>>>> = [];
  let preparationError: AppError | undefined;
  const preparedCalendar: NonNullable<CommandContext['preparedCalendar']> = new Map();
  let result: UndoResult;
  try {
    try {
      const database = await loadDatabase(pool, schemas, databaseId);
      if (database) {
        await new AccessScope(pool, schemas, actor).require(databaseId, 'read', { includeTrashed: true });
        const group = await query<{ actor_id: string; state: string }>(
          pool,
          sql`SELECT actor_id, state
          FROM ${ident(schemas.app, 'undo_groups')} WHERE database_id = ${databaseId} AND group_id = ${request.groupId}`,
        );
        if (
          group.rows[0]?.actor_id === actor.userId &&
          group.rows[0].state === (direction === 'undo' ? 'done' : 'undone')
        ) {
          const changes = await changesToReverse({ db: pool, schemas, databaseId }, request, direction);
          if (
            direction === 'undo' &&
            request.confirmedMajorCreation !== true &&
            (await majorCreations(pool, schemas, databaseId, request.groupId)).length
          )
            throw new AppError('conflict', 'data.undo.majorCreationConfirmationRequired');
          const seen = new Set<string>();
          const previous = await query(
            pool,
            sql`SELECT id FROM ${ident(schemas.app, 'commands')} WHERE id = ${request.commandId}`,
          );
          if (!previous.rowCount)
            for (const saved of changes) {
              if (saved.body.kind !== 'automation.calendarEventChanged') continue;
              const command = calendarInverse(saved, request);
              const c = { db: pool, schemas, actor, databaseId, appContext: app.ctx };
              try {
                preparedCalendar.set(
                  command.id,
                  command.remove
                    ? await checkCalendarRemoval(c, command)
                    : ((await reuseCalendarEvent(c, command)) ?? (await prepareCalendarEvent(c, command))),
                );
              } catch (error) {
                // An event the person's calendar refuses is skipped, and the rest of the group goes back.
                // One a worker is removing right now refuses the whole redo, which can be tried again.
                if (!(error instanceof AppError) || error instanceof RemovalInProgress) throw error;
                preparedCalendar.set(command.id, null);
              }
            }
          for (const { body, prev } of changes) {
            if (body.kind !== 'field.updated' || !prev.field || seen.has(prev.field.id)) continue;
            seen.add(prev.field.id);
            const preparation = await prepareUnique(app, actor, databaseId, {
              kind: 'field.update',
              fieldId: prev.field.id,
              options: prev.field.options,
            });
            if (preparation) prepared.push(preparation);
            if (preparation?.error) throw preparation.error;
          }
        }
      }
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      preparationError = error;
    }
    result = await runUndoStored(
      app,
      actor,
      databaseId,
      request,
      direction,
      preparationError,
      preparedCalendar,
    );
  } finally {
    for (const preparation of prepared.reverse()) await preparation.finish();
  }
  if (result.status === 'rejected') return result;
  // The undo is saved, so its calendar removals go now.  Any that fail for a while wait for the
  // worker, and any the calendar refuses count as skipped, with a notification saying why.
  const mine = { orgId: actor.orgId, userId: actor.userId, commandId: request.commandId };
  for (let tried = 0; tried < INLINE_REMOVALS; tried++) {
    const row = await claimRemoval(app, mine);
    if (!row || !(await attemptRemoval(app, actor, row))) break;
  }
  const { pending, failed } = await removalsOf(app, mine);
  return {
    ...result,
    skipped: result.skipped + failed,
    ...(pending ? { pending } : {}),
  };
}

/** The most calendar removals an undo tries before answering, which the worker carries on from */
const INLINE_REMOVALS = 10;
