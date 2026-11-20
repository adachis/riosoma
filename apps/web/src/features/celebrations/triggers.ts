import type { Command, FieldMeta, RowData, ViewMeta } from '@riosoma/contracts';
import type { SchemaState } from '../../data/types';

/** Record counts that celebrate the first time a table reaches them */
export const RECORD_MILESTONES = [
  { count: 100, name: 'records100' },
  { count: 1000, name: 'records1000' },
] as const;

/** A board needs at least this many cards before finishing it celebrates */
export const KANBAN_MIN_CARDS = 5;

/** A checklist needs at least this many records before finishing it celebrates */
export const CHECKLIST_MIN_RECORDS = 10;

/** Beyond this many records, a view's checklist isn't read row by row */
export const CHECKLIST_MAX_RECORDS = 2000;

/** Whether a view shows every record of its table, so its count is the table's count. */
export function showsWholeTable(view: { config: Pick<ViewMeta['config'], 'filter'> }): boolean {
  const filter = view.config.filter;
  return !filter || filter.conditions.length === 0;
}

/** How many checkboxes the person's own commands just checked. */
export function checkedBoxes(commands: readonly Command[], schema: SchemaState): number {
  let checked = 0;
  for (const command of commands) {
    if (command.kind !== 'record.update') continue;
    for (const record of command.records)
      for (const [fieldId, value] of Object.entries(record.values))
        if (value === true && schema.fieldById.get(fieldId)?.type === 'checkbox') checked++;
  }
  return checked;
}

/**
 * The stack a board counts as done: the last choice of the field it stacks by, in the field's own
 * order, however the board arranges or hides its stacks.  A board stacked by person has none.
 */
export function doneStack(field: FieldMeta): string | null {
  return field.type === 'singleSelect' ? (field.options.choices.at(-1)?.id ?? null) : null;
}

/** Whether every record on a board, at least five of them, sits in its done stack. */
export function boardFinished(
  counts: ReadonlyMap<string, number>,
  done: string,
  minimum = KANBAN_MIN_CARDS,
): boolean {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total >= minimum && (counts.get(done) ?? 0) === total;
}

/**
 * Where a checkbox field stands in a view: `complete` once every record is checked, with the
 * records it holds, `open` while any isn't, with the ones that aren't, and `unknown` while some
 * records haven't loaded or the view is too small or too big to count.
 */
export type Checklist =
  | { state: 'complete'; records: ReadonlySet<string> }
  | { state: 'open'; unchecked: ReadonlySet<string> }
  | { state: 'unknown' };

export function readChecklist(
  rows: { rowCount(): number; getRow(index: number): RowData | undefined },
  fieldId: string,
): Checklist {
  const count = rows.rowCount();
  if (count < CHECKLIST_MIN_RECORDS || count > CHECKLIST_MAX_RECORDS) return { state: 'unknown' };
  const records = new Set<string>();
  const unchecked = new Set<string>();
  let unknown = false;
  for (let index = 0; index < count; index++) {
    const row = rows.getRow(index);
    if (!row) unknown = true;
    else if (row.values[fieldId] === true) records.add(row.id);
    else unchecked.add(row.id);
  }
  if (unchecked.size) return { state: 'open', unchecked };
  return unknown ? { state: 'unknown' } : { state: 'complete', records };
}

/** Whether a checklist finished because a record that was open in it is now checked. */
export function checkedOff(before: Checklist | undefined, after: Checklist): boolean {
  if (before?.state !== 'open' || after.state !== 'complete') return false;
  for (const id of before.unchecked) if (after.records.has(id)) return true;
  return false;
}
