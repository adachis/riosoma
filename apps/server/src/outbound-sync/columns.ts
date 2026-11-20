import { type SyncOutColumn, type SyncOutWrite } from '@riosoma/contracts';
import type { ColumnPlan, OutsideColumn, OutsideTable } from './destination.js';

/**
 * Lining the view's field plans up with the columns a table already has.  This is a pure function,
 * so the preview and a run reconcile the same way.  It never calls the destination: a run adds the
 * queued columns and the key column itself.
 *
 * The rules, in order, for each plan:
 *  - the field's own column from the last run, when it is still there and can still be written,
 *  - else a column with the same name that no other plan holds and that the value fits into,
 *  - else a new column, when adding columns is on,
 *  - else the field is skipped.
 * A column whose name matches but that can't be written is skipped, never made again under a name
 * that is taken.  A field that stopped being sent keeps its column, with its cells cleared.  Every
 * other column is left alone.
 */

export const SYNC_OUT_KEY_COLUMN_LC = 'riosoma record id';

export type ColumnOutcome =
  | { action: 'match'; plan: ColumnPlan; column: OutsideColumn; write: SyncOutWrite }
  | { action: 'create'; plan: ColumnPlan; name: string }
  | { action: 'skip'; plan: ColumnPlan; reason: 'syncOut.skip.noColumn' | 'syncOut.skip.readOnly' };

export interface RetiredColumn {
  entry: SyncOutColumn;
  column: OutsideColumn;
}

export interface Reconciliation {
  /** One outcome per field plan, in view order */
  columns: ColumnOutcome[];
  /** A field that is no longer sent but whose column is still there, so its cells are cleared */
  retired: RetiredColumn[];
  /** The key column, matched when it is there and a writable text column, else to be made */
  key: { action: 'match'; column: OutsideColumn } | { action: 'create' } | { action: 'blocked' };
  /** Outside columns no plan holds, by name.  They are never read, written, or removed. */
  untouched: string[];
}

export interface ReconcileInput {
  plans: readonly ColumnPlan[];
  keyPlan: ColumnPlan;
  mapping: readonly SyncOutColumn[];
  table: OutsideTable;
  keyColumnId: string | null;
  createColumns: boolean;
  columnNameLength: number;
  fit(plan: ColumnPlan, column: OutsideColumn): SyncOutWrite | null;
}

function cut(name: string, length: number): string {
  return [...name.trim()].slice(0, length).join('');
}

function norm(name: string): string {
  return name.trim().toLowerCase();
}

export function reconcileColumns(input: ReconcileInput): Reconciliation {
  const { table, columnNameLength, fit } = input;
  const byId = new Map(table.columns.map((column) => [column.id, column]));
  const claimed = new Set<string>();

  // The key column first, so a field can't take it by name.
  let key: Reconciliation['key'];
  const keyById = input.keyColumnId ? byId.get(input.keyColumnId) : undefined;
  if (keyById) {
    key = { action: 'match', column: keyById };
    claimed.add(keyById.id);
  } else {
    const named = table.columns.find((column) => norm(column.name) === SYNC_OUT_KEY_COLUMN_LC);
    if (named) {
      // Adopt a column by the key's name only when it is a writable text column.
      key =
        fit(input.keyPlan, named) === 'typed' ? { action: 'match', column: named } : { action: 'blocked' };
      if (key.action === 'match') claimed.add(named.id);
    } else {
      key = { action: 'create' };
    }
  }

  // Names already taken, so a new column's name is unique against every column and every new one.
  const taken = new Set(table.columns.map((column) => norm(column.name)));
  const uniqueName = (base: string): string => {
    const start = cut(base, columnNameLength);
    if (!taken.has(norm(start))) {
      taken.add(norm(start));
      return start;
    }
    for (let n = 2; ; n += 1) {
      const suffix = ` (${n})`;
      const candidate = cut(base, columnNameLength - suffix.length) + suffix;
      if (!taken.has(norm(candidate))) {
        taken.add(norm(candidate));
        return candidate;
      }
    }
  };

  const columns: ColumnOutcome[] = [];
  for (const plan of input.plans) {
    const prior = input.mapping.find((entry) => entry.fieldId === plan.fieldId);
    const priorColumn = prior && byId.get(prior.columnId);
    if (priorColumn && !claimed.has(priorColumn.id)) {
      const write = fit(plan, priorColumn);
      if (write) {
        claimed.add(priorColumn.id);
        columns.push({ action: 'match', plan, column: priorColumn, write });
        continue;
      }
      columns.push({ action: 'skip', plan, reason: 'syncOut.skip.readOnly' });
      continue;
    }
    const target = cut(plan.name, columnNameLength);
    const named = table.columns.find(
      (column) => !claimed.has(column.id) && norm(column.name) === norm(target),
    );
    if (named) {
      const write = fit(plan, named);
      if (write) {
        claimed.add(named.id);
        columns.push({ action: 'match', plan, column: named, write });
      } else {
        // A name match the service won't write, such as a formula column, is skipped, not remade.
        columns.push({ action: 'skip', plan, reason: 'syncOut.skip.readOnly' });
      }
      continue;
    }
    if (input.createColumns) columns.push({ action: 'create', plan, name: uniqueName(plan.name) });
    else columns.push({ action: 'skip', plan, reason: 'syncOut.skip.noColumn' });
  }

  const planFieldIds = new Set(input.plans.map((plan) => plan.fieldId));
  const retired: RetiredColumn[] = [];
  for (const entry of input.mapping) {
    if (planFieldIds.has(entry.fieldId)) continue;
    const column = byId.get(entry.columnId);
    if (column && !claimed.has(column.id)) {
      retired.push({ entry, column });
      claimed.add(column.id);
    }
  }

  const untouched = table.columns.filter((column) => !claimed.has(column.id)).map((column) => column.name);

  return { columns, retired, key, untouched };
}
