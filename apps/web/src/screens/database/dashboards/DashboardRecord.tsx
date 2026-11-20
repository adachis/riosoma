import { useEffect, useMemo, useState } from 'react';
import { roleAllows, type RowData } from '@riosoma/contracts';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import type { FormatContext } from '../../../grid/format';
import { optionAction, reportError } from '../../../grid/view/actions';
import { useSession } from '../../../session';
import { useSavePreferences } from '../../settings/usePreferences';
import { RecordCard } from '../record/RecordCard';

export interface DashboardRecordProps {
  session: DatabaseSession;
  schema: SchemaState;
  tableId: string;
  recordId: string;
  format: FormatContext;
  onOpenRecord(tableId: string, recordId: string): void;
  onMissing(): void;
  onClose(): void;
}

/** A record opened from a records tile, over the dashboard, where it can be read and edited. */
export function DashboardRecord({
  session,
  schema,
  tableId,
  recordId,
  format,
  onOpenRecord,
  onMissing,
  onClose,
}: DashboardRecordProps) {
  const person = useSession();
  const preferences = useSavePreferences();
  const [loaded, setLoaded] = useState<{ id: string; row: RowData | null }>(() => ({
    id: recordId,
    row: session.cachedRecord(tableId, recordId) ?? null,
  }));
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
  const table = schema.tableById.get(tableId);
  if (!table) return null;
  return (
    <RecordCard
      layout={person?.preferences.recordLayout ?? 'card'}
      onLayoutChange={(recordLayout) => preferences.mutate({ recordLayout }, { onError: reportError })}
      session={session}
      fields={schema.fields.get(tableId) ?? []}
      primaryFieldId={table.primaryFieldId}
      row={loaded.id === recordId ? loaded.row : (session.cachedRecord(tableId, recordId) ?? null)}
      format={format}
      readOnly={!roleAllows(session.role(), 'editRecords')}
      canEditOptions={roleAllows(session.role(), 'editSchema')}
      position={null}
      onOpenRecord={onOpenRecord}
      onChange={(fieldId, value) => {
        try {
          options.apply(tableId, recordId, fieldId, value);
        } catch (error) {
          reportError(error);
        }
      }}
      onAddOption={options.add}
      onClose={onClose}
    />
  );
}
