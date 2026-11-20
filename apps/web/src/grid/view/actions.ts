import '../../messages/useServerMessage';
import { reportError } from '../../messages/reportError';
import { msg, plural } from '@lingui/core/macro';
import { isComputedType, LIMITS, newId, type CellValue, type FieldMeta } from '@riosoma/contracts';
import { toast } from '@riosoma/ui';
import type { GridSelection, CellRange } from '../../../../../packages/grid-core/src/types';
import type { CommandInput, DatabaseSession, ViewRows } from '../../data/types';
import { i18n } from '../../i18n';

export { reportError } from '../../messages/reportError';

export async function undoAction(session: DatabaseSession, redo = false, groupId?: string): Promise<void> {
  try {
    const result = await (redo ? session.redo() : session.undo(groupId));
    // The session emits undoSkipped once, including when undo comes from a toast.
    if (!result.nothing && !result.skipped && !result.pending)
      toast.show({
        tone: 'info',
        title: i18n._(
          redo
            ? msg({ id: 'grid.redone', message: 'Redone' })
            : msg({ id: 'grid.undone', message: 'Undone' }),
        ),
      });
  } catch (error) {
    reportError(error);
  }
}

export function undoSkipped(count: number, pending = 0): void {
  if (count)
    toast.show({
      tone: 'info',
      title: i18n._(
        msg({
          id: 'grid.undoSkipped',
          message: plural(count, {
            one: '# change was skipped because the data or your permissions changed.',
            other: '# changes were skipped because the data or your permissions changed.',
          }),
        }),
      ),
    });
  // The undo is saved, and the server keeps trying to remove the events from the calendar.
  if (pending)
    toast.show({
      tone: 'info',
      title: i18n._(
        msg({
          id: 'grid.undoPending',
          message: plural(pending, {
            one: '# calendar event wasn’t removed yet.  Riosoma will keep trying.',
            other: '# calendar events weren’t removed yet.  Riosoma will keep trying.',
          }),
        }),
      ),
    });
}

export function undoToast(session: DatabaseSession, title: string, groupId?: string): void {
  toast.show({
    title,
    tone: 'success',
    action: {
      label: i18n._(msg({ id: 'grid.undo', message: 'Undo' })),
      onPress: () => {
        void undoAction(session, false, groupId);
      },
    },
  });
}

export function selectedRows(selection: GridSelection, count: number): number[] {
  if (selection.rows.kind === 'all') return Array.from({ length: count }, (_, index) => index);
  if (selection.rows.kind === 'some')
    return [...selection.rows.rows].filter((index) => index < count).sort((a, b) => a - b);
  const range = selection.range;
  return range
    ? Array.from({ length: range.end.row - range.start.row + 1 }, (_, index) => range.start.row + index)
    : selection.active
      ? [selection.active.row]
      : [];
}

export function selectionRange(selection: GridSelection, count: number, columns: number): CellRange | null {
  if (selection.range) return selection.range;
  const rows = selectedRows(selection, count);
  return rows.length
    ? { start: { row: rows[0]!, col: 0 }, end: { row: rows.at(-1)!, col: columns - 1 } }
    : null;
}

/** Wait for paging notifications; unmount and failed paging must not leave an action hanging. */
export function loadRows(rows: ViewRows, start: number, end: number, signal: AbortSignal): Promise<void> {
  end = Math.min(end, rows.rowCount());
  const ready = () => {
    for (let index = start; index < end; index++) if (!rows.getRow(index)) return false;
    return true;
  };
  if (signal.aborted) return Promise.reject(new DOMException('', 'AbortError'));
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      unsubscribe();
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new DOMException('', 'AbortError'));
    const unsubscribe = rows.subscribe(() => {
      if (ready()) finish();
    });
    const timer = setTimeout(() => finish(new Error('data.rows.timeout')), 30_000);
    signal.addEventListener('abort', abort, { once: true });
    rows.ensureRows(start, end);
    if (ready()) finish();
  });
}

export function recordCommands(
  kind: 'record.update',
  tableId: string,
  records: { id: string; values: Record<string, CellValue> }[],
): CommandInput[] {
  const commands: CommandInput[] = [];
  for (let start = 0; start < records.length; start += LIMITS.recordsPerCommand)
    commands.push({ kind, tableId, records: records.slice(start, start + LIMITS.recordsPerCommand) });
  return commands;
}

/** Stage choices until a value is applied, so creating a choice and using it undo together. */
export function optionAction(session: DatabaseSession) {
  const staged = new Map<string, FieldMeta>();
  return {
    add(fieldId: string, name: string): string {
      const field = staged.get(fieldId) ?? session.getSchema().fieldById.get(fieldId);
      if (field?.type !== 'singleSelect' && field?.type !== 'multipleSelect')
        throw new Error('field.select.required');
      const existing = field.options.choices.find(
        (choice) => choice.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
      );
      if (existing) return existing.id;
      const id = newId('choice');
      staged.set(fieldId, {
        ...field,
        options: {
          ...field.options,
          choices: [...field.options.choices, { id, name: name.trim(), color: 'blue' }],
        },
      });
      return id;
    },
    apply(tableId: string, recordId: string, fieldId: string, value: CellValue): void {
      const field = staged.get(fieldId);
      const commands: CommandInput[] = field
        ? [{ kind: 'field.update', fieldId, options: field.options }]
        : [];
      commands.push({
        kind: 'record.update',
        tableId,
        records: [{ id: recordId, values: { [fieldId]: value } }],
      });
      session.run(commands);
      staged.delete(fieldId);
    },
  };
}

export function emptyValues(fields: readonly FieldMeta[]): Record<string, CellValue> {
  return Object.fromEntries(
    fields
      .filter((field) => !isComputedType(field.type))
      .map((field) => [field.id, field.type === 'checkbox' ? false : null]),
  );
}
