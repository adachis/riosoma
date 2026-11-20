import { useEffect, useState } from 'react';
import { idsOf, type FieldMeta, type CellValue, type LineItemValue } from '@riosoma/contracts';
import type { DatabaseSession, CommandInput } from '../data';
import type { FormatContext } from '../grid/format';
import { LineItemsInput } from './LineItemsInput';

export function LineItemsEditor({
  field,
  recordId,
  value,
  session,
  format,
  readOnly,
}: {
  field: Extract<FieldMeta, { type: 'lineItems' }>;
  recordId: string;
  value: CellValue;
  session?: DatabaseSession;
  format: FormatContext;
  readOnly?: boolean;
}) {
  const [rows, setRows] = useState<LineItemValue[]>([]);
  const [loading, setLoading] = useState(true);
  const ids = idsOf(value).join(',');
  useEffect(() => {
    if (!session) return;
    let active = true;
    let revision = 0;
    async function load() {
      const current = ++revision;
      const linked = idsOf(
        session!.cachedRecord(field.tableId, recordId)?.values[field.id] ?? ids.split(',').filter(Boolean),
      ).join(',');
      const records = await Promise.all(
        linked
          .split(',')
          .filter(Boolean)
          .map((id) => session!.getRecord(field.options.linkedTableId, id)),
      );
      if (active && current === revision) {
        setRows(records.flatMap((row) => (row ? [{ id: row.id, values: row.values }] : [])));
        setLoading(false);
      }
    }
    void load();
    const unsubscribe = session.subscribeRecords(field.options.linkedTableId, () => {
      void load();
    });
    const unsubscribeParent = session.subscribeRecords(field.tableId, () => {
      void load();
    });
    return () => {
      active = false;
      unsubscribe();
      unsubscribeParent();
    };
  }, [session, field.options.linkedTableId, field.tableId, field.id, recordId, ids]);
  function save(next: LineItemValue[]) {
    if (!session || readOnly || loading) return;
    const known = new Map(rows.map((row) => [row.id, row]));
    const commands: CommandInput[] = [];
    for (const row of next) {
      const old = known.get(row.id);
      if (!old)
        commands.push({
          kind: 'record.create',
          tableId: field.options.linkedTableId,
          records: [{ id: row.id, values: { ...row.values, [field.options.inverseFieldId!]: [recordId] } }],
        });
      else {
        const values = Object.fromEntries(
          field.options.columns
            .filter(
              (column) => JSON.stringify(old.values[column.id]) !== JSON.stringify(row.values[column.id]),
            )
            .map((column) => [column.id, row.values[column.id] ?? null]),
        );
        if (Object.keys(values).length)
          commands.push({
            kind: 'record.update',
            tableId: field.options.linkedTableId,
            records: [{ id: row.id, values }],
          });
      }
    }
    const removed = rows.filter((row) => !next.some((item) => item.id === row.id)).map((row) => row.id);
    if (removed.length)
      commands.push({ kind: 'record.trash', tableId: field.options.linkedTableId, recordIds: removed });
    if (rows.map((row) => row.id).join(',') !== next.map((row) => row.id).join(','))
      commands.push({
        kind: 'record.update',
        tableId: field.tableId,
        records: [{ id: recordId, values: { [field.id]: next.map((row) => row.id) } }],
      });
    if (commands.length) {
      setRows(next);
      session.run(commands);
    }
  }
  return (
    <LineItemsInput
      session={session}
      field={field}
      rows={rows}
      format={format}
      readOnly={readOnly || loading || !session}
      onChange={save}
    />
  );
}
