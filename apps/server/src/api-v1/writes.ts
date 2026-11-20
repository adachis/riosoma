import { parseTimeOfDay, parseMultiCurrency } from '@riosoma/contracts';
import { isSelect, sourceChoices } from '../data/select-options.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AppError,
  ChoiceId,
  LIMITS,
  RecordsWrite,
  RecordId,
  cellValue,
  checkCellValue,
  checkComputedOverride,
  isOverrideType,
  fieldDefault,
  isComputedType,
  sameValue,
  isDateOnly,
  minifyJson,
  newId,
  parseLocationText,
  splitDateRangeText,
  type CellValue,
  type RecordsQuery,
  type RecordsMove,
  type Collaborator,
  type RowData,
  type TextMergeNotice,
} from '@riosoma/contracts';
import { z } from 'zod';
import type { Queryable } from '@riosoma/db';
import { runCommands } from '../data/commands/index.js';
import { loadCollaborators } from '../data/metadata.js';
import { fieldLocked } from '../data/permissions/enforce.js';
import { cellError, recordError } from '../data/value-errors.js';
import type { StoredField } from '../data/types.js';
import type { Actor } from '../http/policy.js';
import { parse } from '../http/validate.js';
import { readsLive } from '../sources/live.js';
import { AttachmentAddresses } from './attachments.js';
import { invalid, notFound, responseRecords, rowsById, tableAccess, type TableAccess } from './reads.js';

function valueError(field: StoredField, key: string, value?: unknown): never {
  throw new AppError('validation_failed', key, {
    params: {
      field: field.name,
      ...(typeof value === 'string' && !value.includes('rio_pat_') ? { value } : {}),
    },
  });
}

/** A date from text as `typecast` reads one, shaped the way the field keeps it, or null when it isn't one. */
function typecastDate(text: string, includeTime: boolean): string | null {
  if (isDateOnly(text)) return includeTime ? `${text}T00:00:00.000Z` : text;
  // Requiring an explicit offset prevents the server's local zone from changing an import.
  if (/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(text) && Number.isFinite(Date.parse(text))) {
    const instant = new Date(text).toISOString();
    return includeTime ? instant : instant.slice(0, 10);
  }
  return null;
}

/** A value from the API in the form the field keeps, adding select options to `changed` with `typecast`. */
export function incoming(
  field: StoredField,
  value: unknown,
  typecast: boolean,
  people: Collaborator[],
  changed: Set<string>,
  current: CellValue = null,
): unknown {
  if (value === null || value === undefined) return null;
  if (field.type === 'singleSelect' || field.type === 'multipleSelect') {
    const held = typeof current === 'string' ? [current] : Array.isArray(current) ? [...current] : [];
    const choice = (name: unknown) => {
      if (typeof name !== 'string') return valueError(field, 'data.value.unknownChoice');
      if (name === '' && field.type === 'singleSelect') return null;
      if (field.options.source && ChoiceId.safeParse(name).success) return name;
      const matches = field.options.choices.filter((c) => c.name === name);
      let option = matches[0];
      if (field.options.source) {
        const index = held.findIndex((id) => matches.some((choice) => choice.id === id));
        if (index >= 0) return held.splice(index, 1)[0];
        if (matches.length > 1) return valueError(field, 'data.select.ambiguousLabel', name);
      }
      if (!option) {
        if (!typecast || field.options.source || field.options.cascade)
          return valueError(field, 'data.value.unknownChoice', name);
        option = { id: newId('choice'), name, color: 'gray' };
        field.options.choices.push(option);
        changed.add(field.id);
      }
      return option.id;
    };
    if (field.type === 'singleSelect') return choice(value);
    if (!Array.isArray(value)) return valueError(field, 'data.value.notList');
    return value.map(choice);
  }
  if (field.type === 'user') {
    const entries = Array.isArray(value) ? value : [value];
    return entries.map((item: unknown) => {
      const identifier =
        typeof item === 'string'
          ? item
          : item && typeof item === 'object'
            ? 'id' in item
              ? item.id
              : 'email' in item
                ? item.email
                : undefined
            : undefined;
      const person = people.find(
        (p) =>
          p.id === identifier ||
          (typeof identifier === 'string' && p.email.toLowerCase() === identifier.toLowerCase()),
      );
      return person?.id ?? valueError(field, 'data.user.unknown');
    });
  }
  if (field.type === 'attachment' && Array.isArray(value))
    return value.map((item: unknown) =>
      typeof item === 'string'
        ? item
        : item && typeof item === 'object' && 'id' in item
          ? item.id
          : valueError(field, 'data.file.unknown'),
    );
  if (field.type === 'barcode' && value && typeof value === 'object' && 'text' in value) return value.text;
  // Any JSON value.  With `typecast`, text that holds JSON is read as that JSON.
  if (field.type === 'json')
    return typecast && typeof value === 'string' && minifyJson(value) !== null
      ? value
      : JSON.stringify(value);
  if (typecast && field.type === 'multiCurrency' && typeof value === 'number')
    return { code: field.options.code, amount: value };
  if (typecast && typeof value === 'string') {
    const text = value.trim();
    if (field.type === 'dateRange') {
      const [start, end] = splitDateRangeText(text).map((part) =>
        typecastDate(part, field.options.includeTime),
      );
      if (start && end) return { start, end };
    }
    if (field.type === 'time') return parseTimeOfDay(text) ?? value;
    if (field.type === 'multiCurrency') return parseMultiCurrency(text, field.options.code) ?? value;
    if (field.type === 'location') return parseLocationText(text) ?? value;
    if (
      ['number', 'currency', 'percent', 'duration', 'rating'].includes(field.type) &&
      /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)
    )
      return Number(text);
    if (field.type === 'checkbox' && /^(true|false|1|0)$/i.test(text)) return /^(true|1)$/i.test(text);
    if (field.type === 'date') return typecastDate(text, field.options.includeTime) ?? value;
  }
  return value;
}

/** A table the actor may edit records in, or the error that says why not. */
export async function writeAccess(
  app: FastifyInstance,
  request: FastifyRequest,
  tableId: string,
): Promise<TableAccess> {
  const access = await tableAccess(app, request, tableId);
  await access.scope.require(access.table.databaseId, 'editRecords');
  return access;
}

/**
 * Runs commands through the command bus as the app does, all in one undo group, one at a time so
 * the first refusal stops the rest.
 */
export function commandsFor(
  app: FastifyInstance,
  actor: Actor,
  databaseId: string,
  groupId: string,
  transaction?: Queryable,
) {
  const clientId = newId('client');
  return async (command: Record<string, unknown>) => {
    const result = await runCommands(
      app,
      actor,
      databaseId,
      { clientId, commands: [{ ...command, id: newId('command'), groupId }] },
      transaction,
    );
    const failure = result.results.find((r) => r.status === 'rejected');
    if (failure) {
      const error = failure.error!;
      throw new AppError(error.code, error.messageKey, {
        ...(error.params ? { params: error.params } : {}),
        ...(error.fields ? { fields: error.fields } : {}),
        ...(error.issues ? { issues: error.issues } : {}),
        ...(error.conflicts ? { conflicts: error.conflicts } : {}),
      });
    }
    return result.results[0]!;
  };
}

export interface RecordsToSave {
  /**
   * New records, or changes to the existing records each one names by ID.  `withoutId` creates the
   * records that name no ID and changes the rest, as an upsert does.
   */
  create: boolean | 'withoutId';
  /** Clears the editable fields a record leaves out */
  replace?: boolean;
  typecast: boolean;
  /** Writes AI fields too, which otherwise refuse writes the way computed fields do */
  overrideAiFields?: boolean;
  records: ReadonlyArray<{
    id?: string | undefined;
    fields: Record<string, unknown>;
    baseFields?: Record<string, unknown>;
  }>;
  onMerged?: (notices: TextMergeNotice[]) => void;
  /** The visible field a value's key names, throwing when there isn't one */
  field: (key: string) => StoredField;
  /** Takes attachments as `{ url, filename }` items too, downloading each one before anything is written */
  addresses?: boolean;
  /** Fields `typecast` applies to whatever the request says, as for fields a caller sends as text */
  typecastFields?: (field: StoredField) => boolean;
  /** Fields this caller can't write, which a replace leaves as they are.  `field` refuses them. */
  readOnly?: (field: StoredField) => boolean;
}

/** Whether writing `next` leaves a field holding what it holds now, or would hold if left out. */
function unchanged(field: StoredField, current: CellValue, next: unknown): boolean {
  const checked = checkCellValue(field, next);
  return checked.ok && sameValue(checked.value as CellValue, current);
}

/** Prepares values and requires every updated record to exist and be visible before a write or proposal. */
export async function prepareRecords(app: FastifyInstance, access: TableAccess, input: RecordsToSave) {
  const { actor, table, fields, pool, schemas } = access;
  const people = await loadCollaborators(pool, schemas, actor.orgId, access.scope);
  const changed = new Set<string>();
  const addresses = new AttachmentAddresses(app, actor);
  // A replace leaves managed fields, such as payment results, as they are: only Riosoma writes them.
  const writable = (field: StoredField) =>
    !isComputedType(field.type) && !field.managed && (!field.ai || Boolean(input.overrideAiFields));
  const names = new Map<StoredField, Set<string>>();
  for (const record of input.records)
    for (const [key, value] of Object.entries(record.fields)) {
      const field = input.field(key);
      if (!isSelect(field) || !field.options.source) continue;
      const sent = names.get(field) ?? new Set<string>();
      for (const item of Array.isArray(value) ? value : [value])
        if (typeof item === 'string' && !ChoiceId.safeParse(item).success) sent.add(item);
      names.set(field, sent);
    }
  for (const [field, sent] of names)
    if (isSelect(field) && sent.size) {
      const choices = await sourceChoices(pool, schemas, access.scope, field, { names: [...sent] });
      field.options = {
        ...field.options,
        choices: [
          ...new Map([...field.options.choices, ...choices].map((choice) => [choice.id, choice])).values(),
        ],
      };
    }
  const sentIds = input.records.flatMap((record) => (record.id ? [record.id] : []));
  if (new Set(sentIds).size !== sentIds.length) throw invalid();
  const updating = input.records.filter(
    (record) => input.create === false || (input.create === 'withoutId' && record.id),
  );
  if (updating.some((record) => !record.id)) throw invalid();
  const existing = updating.length
    ? await rowsById(
        access,
        updating.map((record) => record.id!),
      )
    : [];
  if (existing.length !== updating.length) throw notFound();
  const before = new Map(existing.map((row) => [row.id, row]));
  const records = input.records.map((record, index) => {
    const create = input.create === 'withoutId' ? !record.id : input.create;
    const recordId = record.id ?? newId('record');
    if (!create && !record.id) throw invalid();
    const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    if (input.replace)
      for (const field of fields) if (writable(field) && !input.readOnly?.(field)) values[field.id] = null;
    // Where a field may be named either way, two keys can name the same one.
    const named = new Set<string>();
    for (const [key, value] of Object.entries(record.fields)) {
      const field = input.field(key);
      if (named.has(field.id)) throw invalid();
      named.add(field.id);
      try {
        // A model fills in an AI field, so a write to one is refused unless it asks to override.
        if (field.ai && !input.overrideAiFields) valueError(field, 'data.value.aiField');
        const typecast = input.typecast || (input.typecastFields?.(field) ?? false);
        const converted =
          input.addresses && field.type === 'attachment' && Array.isArray(value)
            ? addresses.cell(field, recordId, index, value)
            : incoming(
                field,
                value,
                typecast,
                people,
                changed,
                before.get(recordId) ? cellValue(before.get(recordId)!, field) : null,
              );
        const checked =
          !create && table.allowComputedOverrides && isOverrideType(field.type)
            ? checkComputedOverride(field, converted)
            : checkCellValue(field, converted);
        if (!checked.ok) valueError(field, checked.messageKey);
        values[field.id] = checked.value;
      } catch (error) {
        if (error instanceof AppError) throw cellError(error, field, recordId, index);
        throw error;
      }
    }
    const baseValues: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(record.baseFields ?? {})) {
      const field = input.field(key);
      if (field.type !== 'longText' && field.type !== 'json')
        throw new AppError('validation_failed', 'data.textEdit.unsupported');
      const checked = checkCellValue(
        field,
        incoming(field, value, input.typecast || (input.typecastFields?.(field) ?? false), people, new Set()),
      );
      if (!checked.ok) throw cellError(checked.messageKey, field, recordId, index);
      baseValues[field.id] = checked.value as string | null;
    }
    return { id: recordId, values, create, named, ...(record.baseFields ? { baseValues } : {}) };
  });
  if (new Set(records.map((r) => r.id)).size !== records.length) throw invalid();
  // A value that leaves a field as it is changes nothing, so it needn't be one the caller may edit.
  // A replace names every field, and a locked one it would leave empty, or a record read and sent
  // back whole, shouldn't be refused over fields it doesn't change.  A new record holds nothing yet.
  // A table read live from its source may hold something else there by now, so it keeps them all.
  // A new record keeps an empty value the caller sent for a field with a default, which the
  // default would otherwise fill.
  const byId = new Map(fields.map((field) => [field.id, field]));
  if (!readsLive(table))
    for (const record of records) {
      const row = before.get(record.id);
      for (const [id, value] of Object.entries(record.values)) {
        const field = byId.get(id);
        if (!field || !unchanged(field, row ? cellValue(row, field) : null, value)) continue;
        if (record.create && record.named.has(id) && fieldDefault(field) && !input.readOnly?.(field))
          continue;
        delete record.values[id];
      }
    }
  return { records: records.map(({ named: _named, ...record }) => record), changed, addresses };
}

/** Creates or changes records in one undo group, and returns their IDs. */
export async function saveRecords(
  app: FastifyInstance,
  access: TableAccess,
  groupId: string,
  input: RecordsToSave,
): Promise<string[]> {
  const { table, fields } = access;
  const { records, changed, addresses } = await prepareRecords(app, access, input);
  if (addresses.size) {
    // Nothing is downloaded for a write that couldn't land.
    const downloaded = addresses.fields();
    if (downloaded.some((field) => !access.scope.canEditField(table.id, field))) throw fieldLocked();
    await addresses.fetch(table.id);
    for (const record of records)
      for (const field of downloaded)
        if (Object.hasOwn(record.values, field.id))
          record.values[field.id] = addresses.resolve(record.values[field.id]);
  }
  const run = commandsFor(app, access.actor, access.table.databaseId, groupId);
  try {
    for (const id of changed) {
      const field = fields.find((f) => f.id === id)!;
      await run({ kind: 'field.update', fieldId: id, options: field.options });
    }
    for (const create of [true, false]) {
      const batch = records.flatMap(({ id, values, baseValues, create: made }) =>
        made === create ? [{ id, values, ...(!create && baseValues ? { baseValues } : {}) }] : [],
      );
      for (let i = 0; i < batch.length; i += LIMITS.recordsPerCommand) {
        const result = await run({
          kind: create ? 'record.create' : 'record.update',
          tableId: table.id,
          records: batch.slice(i, i + LIMITS.recordsPerCommand),
        });
        if (Array.isArray(result.output?.textMerges))
          input.onMerged?.(result.output.textMerges as TextMergeNotice[]);
      }
    }
  } catch (error) {
    await addresses.discard();
    throw recordError(error, (recordId) => records.findIndex((record) => record.id === recordId));
  }
  return records.map((r) => r.id);
}

/**
 * Moves records to the trash in one undo group.  `describe` runs first, while the records can
 * still be read, and its result is returned.
 */
export async function trashRecords<T>(
  app: FastifyInstance,
  access: TableAccess,
  ids: string[],
  groupId: string,
  describe: (rows: RowData[]) => Promise<T>,
  timeZone?: string,
): Promise<T> {
  const rows = await rowsById(access, ids, timeZone);
  if (new Set(ids).size !== rows.length) throw notFound();
  const response = await describe(rows);
  const run = commandsFor(app, access.actor, access.table.databaseId, groupId);
  for (let i = 0; i < ids.length; i += LIMITS.recordsPerCommand)
    await run({
      kind: 'record.trash',
      tableId: access.table.id,
      recordIds: ids.slice(i, i + LIMITS.recordsPerCommand),
    });
  return response;
}

export async function writeRecords(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  tableId: string,
  output: RecordsQuery,
) {
  const access = await writeAccess(app, request, tableId);
  const groupId = newId('action');
  reply.header('x-undo-group-id', groupId);
  if (request.method === 'DELETE') {
    const raw = parse(z.record(z.string(), z.unknown()), request.query);
    const ids = parse(
      z.array(RecordId).min(1).max(1_000),
      typeof raw.records === 'string' ? [raw.records] : raw.records,
    );
    return trashRecords(
      app,
      access,
      ids,
      groupId,
      (rows) => responseRecords(access, rows, output),
      output.timeZone,
    );
  }
  const input = parse(RecordsWrite, request.body);
  const textMerges: TextMergeNotice[] = [];
  const ids = await saveRecords(app, access, groupId, {
    create: request.method === 'POST',
    replace: request.method === 'PUT',
    typecast: input.typecast,
    overrideAiFields: input.overrideAiFields,
    records: input.records,
    onMerged: (notices) => textMerges.push(...notices),
    field: (key) => {
      const field = access.fields.find((f) => (input.fieldKey === 'id' ? f.id : f.name) === key);
      if (!field) throw new AppError('validation_failed', 'data.field.unknown');
      return field;
    },
    addresses: true,
  });
  const fresh = await tableAccess(app, request, tableId);
  const rows = await rowsById(fresh, ids, output.timeZone);
  const rawQuery = parse(z.record(z.string(), z.unknown()), request.query);
  const response = await responseRecords(fresh, rows, {
    ...output,
    fieldKey: rawQuery.fieldKey === undefined ? input.fieldKey : output.fieldKey,
  });
  return { ...response, ...(textMerges.length ? { textMerges } : {}) };
}

export async function setLocks(
  app: FastifyInstance,
  request: FastifyRequest,
  tableId: string,
  recordIds: string[],
  locked: boolean,
  reason: string,
) {
  const access = await writeAccess(app, request, tableId);
  const groupId = newId('action');
  await commandsFor(
    app,
    access.actor,
    access.table.databaseId,
    groupId,
  )({ kind: 'record.setLock', tableId, recordIds, locked, reason });
  return { recordIds, locked, undoGroupId: groupId };
}

export async function moveRecords(
  app: FastifyInstance,
  request: FastifyRequest,
  tableId: string,
  input: RecordsMove,
) {
  const access = await writeAccess(app, request, tableId);
  const groupId = newId('action');
  await commandsFor(
    app,
    access.actor,
    access.table.databaseId,
    groupId,
  )({ kind: 'record.move', tableId, ...input });
  return { recordIds: input.recordIds, viewId: input.viewId, undoGroupId: groupId };
}
