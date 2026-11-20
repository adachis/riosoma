import {
  AppError,
  cellValue,
  checkCellValue,
  mergeText,
  prettyJson,
  type Command,
  type TextConflict,
  type TextMergeNotice,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { fetchRowsById, type RecordInput } from '../physical/records.js';
import { loadCollaborators, loadFields } from '../metadata.js';
import type { StoredField } from '../types.js';
import { scopeOf, type CommandContext } from './context.js';

/** A reviewed plan keeps the values it observed, so applying it later cannot erase a new edit. */
export async function captureTextBases(c: CommandContext, commands: Command[]): Promise<void> {
  for (const command of commands) {
    if (command.kind !== 'record.update') continue;
    const fields = (await loadFields(c.db, c.schemas, [command.tableId])).filter(
      (field) => field.type === 'longText' || field.type === 'json',
    );
    if (!fields.length) continue;
    const current = new Map(
      (
        await fetchRowsById(
          c.db,
          c.schemas.data,
          command.tableId,
          fields,
          command.records.map((row) => row.id),
        )
      ).map((row) => [row.id, row]),
    );
    for (const row of command.records) {
      const stored = current.get(row.id);
      if (!stored) continue;
      for (const field of fields) {
        if (!Object.hasOwn(row.values, field.id) || Object.hasOwn(row.baseValues ?? {}, field.id)) continue;
        row.baseValues = { ...row.baseValues, [field.id]: cellValue(stored, field) as string | null };
      }
    }
  }
}

/** Runs after visibility/editability checks and before validation, under the write transaction. */
export async function mergeTextEdits(
  c: CommandContext,
  command: Extract<Command, { kind: 'record.update' }>,
  fields: readonly StoredField[],
  rows: RecordInput[],
): Promise<TextMergeNotice[]> {
  const protectedRows = command.records.filter((row) => row.baseValues && Object.keys(row.baseValues).length);
  if (!protectedRows.length) return [];
  const ids = protectedRows.map((row) => row.id);
  // Source syncs also write physical rows, so hold their row locks until the merge is stored.
  await query(
    c.db,
    sql`SELECT __id FROM ${ident(c.schemas.data, command.tableId)} WHERE __id = ANY(${ids}::text[]) ORDER BY __rid FOR UPDATE`,
  );
  const textFields = fields.filter((field) => field.type === 'longText' || field.type === 'json');
  const current = new Map(
    (await fetchRowsById(c.db, c.schemas.data, command.tableId, textFields, ids)).map((row) => [row.id, row]),
  );
  const people = c.publicForm
    ? []
    : await loadCollaborators(c.db, c.schemas, c.actor.orgId, await scopeOf(c));
  const conflicts: TextConflict[] = [];
  const merged: TextMergeNotice[] = [];
  const positions = new Map<string, Map<string, number>>();
  for (const [index, row] of rows.entries()) {
    const cells = positions.get(row.id) ?? new Map<string, number>();
    for (const fieldId of Object.keys(row.values)) cells.set(fieldId, index);
    positions.set(row.id, cells);
  }
  for (const [index, sent] of command.records.entries()) {
    if (!sent.baseValues) continue;
    const row = rows[index];
    const stored = current.get(sent.id);
    if (!row || !stored) continue;
    for (const [fieldId, base] of Object.entries(sent.baseValues!)) {
      // Repeated IDs coalesce by cell in the physical write; only the surviving edit needs a merge.
      if (!Object.hasOwn(row.values, fieldId) || positions.get(sent.id)?.get(fieldId) !== index) continue;
      const field = textFields.find((field) => field.id === fieldId);
      if (!field) throw new AppError('validation_failed', 'data.textEdit.unsupported');
      const checkedBase = checkCellValue(field, base);
      if (!checkedBase.ok) throw new AppError('validation_failed', checkedBase.messageKey);
      const theirs = cellValue(stored, field) as string | null;
      const ours = row.values[fieldId] as string | null;
      if (theirs === checkedBase.value) continue;
      const format = (value: string | null) =>
        field.type === 'json' && value !== null ? prettyJson(value) : (value ?? '');
      const result = mergeText(
        format(checkedBase.value as string | null),
        format(theirs),
        format(ours),
        field.type === 'json' ? 'lines' : 'words',
      );
      // The latest change to this cell supplies attribution, even if another field changed later.
      const history = await query<{ actor_id: string | null; at: string }>(
        c.db,
        sql`
        SELECT change.actor_id, change.at FROM ${ident(c.schemas.app, 'record_changes')} ref
        JOIN ${ident(c.schemas.app, 'changes')} change ON change.database_id = ref.database_id AND change.seq = ref.seq
        WHERE ref.database_id = ${c.databaseId} AND ref.table_id = ${command.tableId} AND ref.record_id = ${sent.id}
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(change.body -> 'records', '[]'::jsonb)) item
            WHERE item ->> 'id' = ${sent.id} AND item -> 'values' ? ${fieldId})
        ORDER BY change.seq DESC LIMIT 1`,
      );
      const author = history.rows[0]?.actor_id ?? stored.updatedBy;
      const metadata = {
        tableId: command.tableId,
        recordId: sent.id,
        fieldId,
        updatedBy: c.publicForm ? null : author,
        updatedAt: history.rows[0]?.at ?? stored.updatedAt,
        name: people.find((person) => person.id === author)?.name ?? null,
      };
      const candidate = result.clean
        ? checkCellValue(field, result.text === '' ? null : result.text)
        : undefined;
      if (result.clean && candidate?.ok) {
        row.values[fieldId] = candidate.value;
        merged.push({ ...metadata, value: candidate.value as string | null });
      } else {
        conflicts.push({
          ...metadata,
          base: checkedBase.value as string | null,
          ours,
          theirs,
          proposal: result.clean ? result.text : result.proposal,
        });
      }
    }
  }
  // One command is atomic: no cell, history entry, or dependent mutation survives a conflict.
  if (conflicts.length) throw new AppError('conflict', 'data.textEdit.conflict', { conflicts });
  return merged;
}
