import { useEffect, type RefObject } from 'react';
import type { FieldMeta, TableMeta, ViewMeta } from '@riosoma/contracts';
import { useSchema } from '../../data/hooks';
import { viewRowsKey } from '../../data/state';
import type { DatabaseSession, ViewRows } from '../../data/types';
import { gridColumns } from '../../grid/cells/columns';
import { playSound } from './sounds';
import {
  RECORD_MILESTONES,
  checkedBoxes,
  checkedOff,
  readChecklist,
  showsWholeTable,
  type Checklist,
} from './triggers';
import { useCelebrations, useSignedIn } from './useCelebrations';

/** How recently the person's own command must have changed a table for a milestone to count as theirs */
const OWN_CHANGE_MS = 5000;

/**
 * Follows an open database: a soft tick for each checkbox the person checks.  Having a database to
 * open also puts their first table behind them, since a first table they made themselves celebrated
 * as they made it, and any other way in (an import, a share, a restore) isn't one to celebrate.
 */
export function useSessionCelebrations(session: DatabaseSession | null): void {
  const signedIn = useSignedIn();
  const { retire } = useCelebrations();
  useEffect(() => {
    if (!session) return;
    retire('firstTable', 'you');
    return session.subscribeCommands?.((commands) => {
      if (checkedBoxes(commands, session.getSchema()) > 0) playSound('tick', signedIn()?.preferences);
    });
  }, [session, signedIn, retire]);
}

/**
 * Follows a grid view for its milestones: its table reaching 100 and 1,000 records, while the
 * view shows the whole table, and a checkbox field in it becoming checked on every record.
 */
export function useGridCelebrations({
  session,
  rows,
  table,
  view,
  fields,
  container,
}: {
  session: DatabaseSession;
  rows: ViewRows;
  table: TableMeta;
  view: ViewMeta;
  fields: readonly FieldMeta[];
  container: RefObject<HTMLElement | null>;
}): void {
  const { observe, celebrate } = useCelebrations();
  const schema = useSchema(session);
  // A view narrowed by its filter or by a record rule doesn't count the whole table.
  const whole = showsWholeTable(view) && !schema?.access.limitedTables.has(table.id);
  // The filter and sorts decide which records the rows hold.  A change to them starts every count
  // over, and rows read under anything else are about to be read again.
  const settings = viewRowsKey(view.config);
  const columns = gridColumns(view, fields, table.primaryFieldId, table).map((column) => column.id);
  const types = new Map(fields.map((field) => [field.id, field.type]));
  // Plain strings, so the watch restarts only when what it watches changes.
  const columnList = columns.join(' ');
  const checkboxList = columns.filter((id) => types.get(id) === 'checkbox').join(' ');
  const tableId = table.id;
  const viewId = view.id;
  useEffect(() => {
    const columns = columnList.split(' ');
    const checkboxes = checkboxList ? checkboxList.split(' ') : [];
    let lastCheck = Number.NEGATIVE_INFINITY;
    let lastAdd = Number.NEGATIVE_INFINITY;
    let stopped = false;
    const unsubscribeCommands = session.subscribeCommands?.((commands) => {
      const own = commands.filter((command) => 'tableId' in command && command.tableId === tableId);
      if (checkedBoxes(own, session.getSchema()) > 0) lastCheck = performance.now();
      if (own.some((command) => command.kind === 'record.create' || command.kind === 'record.restore'))
        lastAdd = performance.now();
    });
    // The person's own command lands just after its rows change, so whose change it was is decided
    // once it has.
    const byWhom = (since: () => number): 'you' | 'others' =>
      performance.now() - since() < OWN_CHANGE_MS ? 'you' : 'others';
    const later = (task: () => void) =>
      queueMicrotask(() => {
        if (!stopped) task();
      });
    const lists = new Map<string, Checklist>();
    let counted = -1;
    const addRow = () => container.current?.querySelector('[data-rio-add-row]') ?? container.current;
    const header = (fieldId: string) =>
      container.current?.querySelector(`[data-rio-column="${columns.indexOf(fieldId)}"]`) ??
      container.current;
    const check = () => {
      if (rows.loading()) return;
      // Rows read before the filter or sort last changed still hold the old view's records, so
      // nothing is seen until they're read again, and then it's seen fresh.
      const read = rows.settings?.();
      if (!read || viewRowsKey(read) !== settings) {
        counted = -1;
        lists.clear();
        return;
      }
      const count = rows.rowCount();
      if (whole && count !== counted) {
        counted = count;
        const anchor = addRow();
        for (const milestone of RECORD_MILESTONES)
          if (count < milestone.count) observe(milestone.name, tableId, false);
          else later(() => observe(milestone.name, tableId, true, { anchor, cause: byWhom(() => lastAdd) }));
      }
      for (const fieldId of checkboxes) {
        const list = readChecklist(rows, fieldId);
        if (list.state === 'unknown') continue;
        const before = lists.get(fieldId);
        lists.set(fieldId, list);
        // Only a record that was open and is now checked finishes a checklist, not one that left.
        if (!checkedOff(before, list)) continue;
        later(() =>
          celebrate('checklistComplete', `${viewId}:${fieldId}`, {
            anchor: header(fieldId),
            cause: byWhom(() => lastCheck),
          }),
        );
      }
    };
    check();
    const unsubscribe = rows.subscribe(check);
    return () => {
      stopped = true;
      unsubscribe();
      unsubscribeCommands?.();
    };
  }, [
    session,
    rows,
    tableId,
    viewId,
    whole,
    settings,
    columnList,
    checkboxList,
    container,
    observe,
    celebrate,
  ]);
}
