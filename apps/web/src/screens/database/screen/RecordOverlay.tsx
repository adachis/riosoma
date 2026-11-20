import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { roleAllows, type FieldMeta, type RowData } from '@riosoma/contracts';
import type { DatabaseSession, ViewRows } from '../../../data/types';
import type { FormatContext } from '../../../grid/format';
import { loadRows, optionAction, reportError } from '../../../grid/view/actions';
import { RecordCard, type RecordCardProps } from '../record/RecordCard';
import type { ViewColors } from '../colors/paint';

export function RecordOverlay({
  layout,
  onLayoutChange,
  fullPageHref,
  onOpenRecord,
  session,
  rows,
  recordId,
  tableId,
  viewId,
  fields,
  primaryFieldId,
  format,
  colors,
  onNavigate,
  onClose,
  onMissing,
}: {
  layout?: RecordCardProps['layout'];
  onLayoutChange?: RecordCardProps['onLayoutChange'];
  fullPageHref?: string;
  onOpenRecord?: RecordCardProps['onOpenRecord'];
  session: DatabaseSession;
  rows: ViewRows;
  recordId: string;
  tableId: string;
  viewId?: string;
  fields: readonly FieldMeta[];
  primaryFieldId: string;
  format: FormatContext;
  /** The view's conditional colors, which the card marks beside each field */
  colors?: ViewColors;
  onNavigate(id: string): void;
  onClose(): void;
  onMissing(): void;
}) {
  const [loaded, setLoaded] = useState<{ id: string; row: RowData | null }>({
    id: recordId,
    row: session.cachedRecord(tableId, recordId) ?? null,
  });
  const options = useMemo(() => optionAction(session), [session]);
  useEffect(() => {
    let canceled = false;
    const read = async () => {
      try {
        const row = await session.getRecord(tableId, recordId);
        if (canceled) return;
        if (!row) onMissing();
        else setLoaded({ id: recordId, row });
      } catch (error) {
        if (!canceled) reportError(error);
      }
    };
    void read();
    const unsubscribe = session.subscribeRecords(tableId, (ids) => {
      if (ids.has(recordId)) void read();
    });
    return () => {
      canceled = true;
      unsubscribe();
    };
  }, [session, tableId, recordId, onMissing]);
  const position = useMemo(
    () => ({
      subscribe: (listener: () => void) => rows.subscribe(listener),
      get: () => `${rows.indexOf(recordId)}:${rows.rowCount()}`,
    }),
    [rows, recordId],
  );
  const [index = -1, total = 0] = useSyncExternalStore(position.subscribe, position.get, position.get)
    .split(':')
    .map(Number);
  async function adjacent(next: number) {
    const abort = new AbortController();
    await loadRows(rows, next, next + 1, abort.signal);
    const row = rows.getRow(next);
    if (row) onNavigate(row.id);
  }
  return (
    <RecordCard
      viewId={viewId}
      layout={layout}
      onLayoutChange={onLayoutChange}
      fullPageHref={fullPageHref}
      onOpenRecord={onOpenRecord}
      session={session}
      fields={fields}
      primaryFieldId={primaryFieldId}
      row={loaded.id === recordId ? loaded.row : (session.cachedRecord(tableId, recordId) ?? null)}
      format={format}
      colors={colors}
      readOnly={!roleAllows(session.role(), 'editRecords')}
      canEditOptions={roleAllows(session.role(), 'editSchema')}
      position={index < 0 ? null : { index, total }}
      onChange={(fieldId, value) => {
        try {
          options.apply(tableId, recordId, fieldId, value);
        } catch (error) {
          reportError(error);
        }
      }}
      onAddOption={options.add}
      onPrevious={
        index > 0
          ? () => {
              void adjacent(index - 1).catch(reportError);
            }
          : undefined
      }
      onNext={
        index >= 0 && index < total - 1
          ? () => {
              void adjacent(index + 1).catch(reportError);
            }
          : undefined
      }
      onClose={onClose}
    />
  );
}
