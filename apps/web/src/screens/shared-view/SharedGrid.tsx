import type { ViewColors } from '../database/colors/paint';
import { useLayoutEffect, useRef } from 'react';
import {
  ROW_HEIGHT_PX,
  type FieldMeta,
  type RowData,
  type TableMeta,
  type ViewMeta,
} from '@riosoma/contracts';
import { createGroupedGrid, type GroupedGrid } from '../../grid/grouping/engine';
import { localeInfo } from '@riosoma/i18n';
import type { GridHost, GridSelection } from '../../../../../packages/grid-core/src/types';
import type { ViewRows } from '../../data/types';
import { gridColumns } from '../../grid/cells/columns';
import { describeCell } from '../../grid/cells/describe';
import { createHeaderRenderer } from '../../grid/cells/header';
import { createCellRenderer } from '../../grid/cells/renderers';
import { createRowHeaderRenderer } from '../../grid/cells/rowHeader';
import { copyCells } from '../../grid/clipboard/copy';
import { writeClipboard } from '../../grid/clipboard/write';
import type { FormatContext } from '../../grid/format';
import { loadRows, reportError, selectedRows, selectionRange } from '../../grid/view/actions';
import { i18n } from '../../i18n';
import { ViewPromptPill } from '../database/shell/ViewPromptPill';
import '../../grid/view/view.css';

/** Rows one copy may hold.  The download is there for more. */
const COPY_ROWS = 10_000;

export interface SharedGridProps {
  rows: ViewRows;
  table: TableMeta;
  view: ViewMeta;
  fields: readonly FieldMeta[];
  format: FormatContext;
  allowCopy: boolean;
  colors?: ViewColors;
  onSelect?(recordId: string): void;
  storageKey?: string;
  onExpand(recordId: string): void;
}

interface Engine {
  grid: GroupedGrid;
  update(next: SharedGridProps): void;
}

/**
 * The grid, read-only: the same engine and cells as the signed-in grid, so a million records
 * scroll the same way, with nothing to edit, no menus, and copying only when the link allows it.
 */
export function SharedGrid(props: SharedGridProps) {
  const container = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const latest = useRef(props);
  const { rows } = props;
  useLayoutEffect(() => {
    latest.current = props;
  });

  useLayoutEffect(() => {
    const node = container.current;
    if (!node) return;
    const abort = new AbortController();
    const t = i18n._.bind(i18n);
    let state = latest.current;
    let columns = gridColumns(state.view, state.fields, state.table.primaryFieldId, state.table);
    let byId = new Map(state.fields.map((field) => [field.id, field]));
    const renderers = () => ({
      cell: createCellRenderer({
        fieldsById: byId,
        format: state.format,
        colors: state.colors,
        rowHeight: state.view.config.rowHeight,
      }),
      header: createHeaderRenderer({ fieldsById: byId, primaryFieldId: state.table.primaryFieldId, t }),
    });
    let draw = renderers();
    const rowHeader = createRowHeaderRenderer({ t });
    const shown = () => columns.flatMap((column) => byId.get(column.id) ?? []);

    function copied(selection: GridSelection): { text: string; html: string } | null {
      const count = rows.rowCount();
      const range = selectionRange(selection, count, columns.length);
      if (!range) return null;
      const fields = shown();
      const indices = selectedRows(selection, count).slice(0, COPY_ROWS);
      const cells =
        selection.rows.kind === 'none'
          ? copyCells(range, fields, (index) => rows.getRow(index)!, state.format)
          : indices.flatMap((index) =>
              copyCells(
                { start: { row: index, col: 0 }, end: { row: index, col: fields.length - 1 } },
                fields,
                (position) => rows.getRow(position)!,
                state.format,
              ),
            );
      return writeClipboard(cells);
    }

    const host: GridHost<RowData> = {
      frozenRows: () => rows.pinnedCount?.() ?? 0,
      getRow: (index) => rows.getRow(index),
      ensureRows: (start, end) => rows.ensureRows(start, end),
      renderCell: (el, context) => draw.cell(el, context),
      renderHeader: (el, column, index) => {
        draw.header(el, column, index);
        // Nothing opens from a heading here, so it neither offers a menu nor draws the arrow for one.
        el.querySelector('.rio-cell-header__chevron')?.remove();
        (el.parentElement?.getAttribute('role') === 'columnheader' ? el.parentElement : el).removeAttribute(
          'aria-haspopup',
        );
      },
      renderRowHeader: rowHeader,
      rowClass: (row) => (rows.prompts().left.has(row.id) ? 'rio-grid-row-left' : null),
      editText: () => '',
      commitText: () => null,
      copy(selection) {
        if (!latest.current.allowCopy) return null;
        const count = rows.rowCount();
        const indices = selectedRows(selection, count).slice(0, COPY_ROWS);
        if (indices.every((index) => rows.getRow(index))) return copied(selection);
        // Rows that haven't loaded yet load first, then go to the clipboard on their own.
        const first = indices[0] ?? 0;
        void loadRows(rows, first, (indices.at(-1) ?? first) + 1, abort.signal)
          .then(async () => {
            const data = copied(selection);
            if (data) await navigator.clipboard.writeText(data.text);
          })
          .catch((error: unknown) => {
            if (!abort.signal.aborted) reportError(error);
          });
        return null;
      },
      describeCell: (cell) => {
        const row = rows.getRow(cell.row);
        const field = byId.get(columns[cell.col]?.id ?? '');
        return row && field ? describeCell(field, row, cell.row, state.format, t) : '';
      },
      onSelectionChange(selection) {
        const row = selection.active ? rows.getRow(selection.active.row) : undefined;
        if (row) latest.current.onSelect?.(row.id);
      },
      onExpandRow: (index) => {
        void loadRows(rows, index, index + 1, abort.signal)
          .then(() => {
            const row = rows.getRow(index);
            if (row) latest.current.onExpand(row.id);
          })
          .catch(() => undefined);
      },
    };

    const grouping = () => ({
      enabled: state.view.config.groups.length > 0,
      groups: rows.groups?.() ?? [],
      fields: state.fields,
      format: state.format,
      storageKey: state.storageKey ?? `grid-groups:public:${state.view.id}`,
    });
    const grid = createGroupedGrid(
      node,
      {
        host,
        columns,
        rowCount: rows.rowCount(),
        rowHeight: ROW_HEIGHT_PX[state.view.config.rowHeight],
        frozenColumnCount: state.view.config.frozenFieldCount,
        headerHeight: state.view.config.columnGroups.length ? 56 : 32,
        label: state.view.name,
        direction: localeInfo(state.format.locale).dir,
        readOnly: true,
        showAddRow: false,
        showAddColumn: false,
      },
      grouping(),
    );
    let count = rows.rowCount();
    const unsubscribe = rows.subscribe((change) => {
      grid.grouping(grouping());
      if (count !== rows.rowCount()) {
        count = rows.rowCount();
        grid.update({ rowCount: count });
      }
      if (Array.isArray(change.rows)) grid.rowsChanged(change.rows[0], change.rows[1]);
      else grid.rowsChanged();
    });
    engine.current = {
      grid,
      update(next) {
        state = next;
        grid.grouping(grouping());
        byId = new Map(next.fields.map((field) => [field.id, field]));
        const previous = columns;
        columns = gridColumns(next.view, next.fields, next.table.primaryFieldId, next.table);
        draw = renderers();
        grid.update({
          label: next.view.name,
          direction: localeInfo(next.format.locale).dir,
          rowHeight: ROW_HEIGHT_PX[next.view.config.rowHeight],
          frozenColumnCount: next.view.config.frozenFieldCount,
          headerHeight: next.view.config.columnGroups.length ? 56 : 32,
          ...(JSON.stringify(previous) !== JSON.stringify(columns) ? { columns } : {}),
        });
        grid.rowsChanged();
      },
    };
    return () => {
      abort.abort();
      unsubscribe();
      grid.destroy();
      engine.current = null;
    };
  }, [rows]);

  useLayoutEffect(() => {
    engine.current?.update(props);
  }, [props]);

  // A refresh keeps the first row on screen where it was.
  useLayoutEffect(() => {
    rows.onSyncRefresh?.(async () => {
      const current = engine.current;
      if (!current) return;
      const result = await rows.refresh(rows.getRow(current.grid.anchorRow())?.id);
      if (engine.current !== current || result.anchorIndex === null) return;
      current.grid.update({ rowCount: rows.rowCount() });
      current.grid.scrollToCell({ row: result.anchorIndex }, 'start');
    });
    return () => rows.onSyncRefresh?.(undefined);
  });

  return (
    <div className="rio-grid-view">
      <div ref={container} className="rio-grid-view__engine" />
      <ViewPromptPill
        prompts={rows.prompts()}
        onRefresh={() => {
          void rows.refresh().catch(reportError);
        }}
      />
    </div>
  );
}
