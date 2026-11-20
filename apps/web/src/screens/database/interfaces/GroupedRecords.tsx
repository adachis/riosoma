import { useViewColors } from '../colors/useViewColors';
import { useLayoutEffect, useMemo } from 'react';
import type { GridGroupBoundary, RowData, ViewMeta } from '@riosoma/contracts';
import type { ViewRows, ViewRowsChange } from '../../../data/types';
import { SharedGrid } from '../../shared-view/SharedGrid';
import type { BlockContext } from './context';

class InterfaceRows implements ViewRows {
  private records: readonly RowData[] = [];
  private boundaries: readonly GridGroupBoundary[] = [];
  private listeners = new Set<(change: ViewRowsChange) => void>();
  constructor(
    readonly viewId: string,
    readonly tableId: string,
  ) {}
  rowCount = () => this.records.length;
  getRow = (index: number) => this.records[index];
  groups = () => this.boundaries;
  ensureRows() {}
  indexOf = (id: string) => this.records.findIndex((row) => row.id === id);
  prompts = () => ({ entered: 0, left: new Set<string>(), orderChanged: false });
  refresh = async () => ({ anchorIndex: null });
  loading = () => false;
  subscribe = (listener: (change: ViewRowsChange) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  close() {}
  update(records: readonly RowData[], boundaries: readonly GridGroupBoundary[]) {
    this.records = records;
    this.boundaries = boundaries;
    for (const listener of this.listeners) listener({ rows: 'all', count: true });
  }
}

/** Reuses the grid's headers for the interface's filtered, paged record list. */
export function GroupedRecords({
  rows,
  groups,
  view,
  context,
  fieldIds,
  onSelect,
}: {
  rows: readonly RowData[];
  groups: readonly GridGroupBoundary[];
  view: ViewMeta;
  context: BlockContext;
  fieldIds: readonly string[];
  onSelect(id: string): void;
}) {
  const { id, tableId } = view;
  const source = useMemo(() => new InterfaceRows(id, tableId), [id, tableId]);
  useLayoutEffect(() => source.update(rows, groups), [source, rows, groups]);
  const table = context.schema.tableById.get(view.tableId)!;
  const fields = context.schema.fields.get(table.id) ?? [];
  const colors = useViewColors(context.session, view, fields, context.format);
  const hiddenFieldIds = fields
    .filter((field) => field.id !== table.primaryFieldId && !fieldIds.includes(field.id))
    .map((field) => field.id);
  return (
    <SharedGrid
      rows={source}
      table={table}
      view={{ ...view, config: { ...view.config, hiddenFieldIds } }}
      fields={fields}
      format={context.format}
      allowCopy
      colors={colors}
      onExpand={onSelect}
      onSelect={onSelect}
      storageKey={`grid-groups:${context.session.userId}:${view.id}`}
    />
  );
}
