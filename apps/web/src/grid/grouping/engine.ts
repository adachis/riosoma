import { msg } from '@lingui/core/macro';
import { faChevronDown, faChevronRight, faPlus } from '@fortawesome/free-solid-svg-icons';
import { avatarInitials } from '@riosoma/ui';
import { icon } from '../cells/dom';
import type { CellValue, FieldMeta, GridGroupBoundary, RowData } from '@riosoma/contracts';
import { createGrid } from '../../../../../packages/grid-core/src/grid';
import { GroupLayout } from '../../../../../packages/grid-core/src/group-layout';
import type {
  CellRef,
  GridApi,
  GridHost,
  GridOptions,
  GridSelection,
} from '../../../../../packages/grid-core/src/types';
import { i18n } from '../../i18n';
import { personLabel } from '../../data/people';
import { createCellRenderer } from '../cells/renderers';
import { readClipboard } from '../clipboard/read';
import type { FormatContext } from '../format';
import { selectionRange } from '../view/actions';
import { recordsText, spokenSummary, summaryValueText } from '../summary/text';
import { groupValueText } from './text';
import './groups.css';

type Line = { record: RowData; index: number } | { group: GridGroupBoundary };
export interface GroupingState {
  groups: readonly GridGroupBoundary[];
  fields: readonly FieldMeta[];
  format: FormatContext;
  enabled: boolean;
  storageKey: string;
  add?(group: GridGroupBoundary): void;
}
export interface GroupedGrid extends GridApi<RowData> {
  recordCell(cell: CellRef): CellRef | null;
  grouping(next: GroupingState): void;
  collapseGroups(collapsed: boolean): void;
  paste(selection: GridSelection, data: { text: string; html: string | null }): void;
}

/** The engine keeps display coordinates while every record operation keeps snapshot coordinates. */
export function createGroupedGrid(
  node: HTMLElement,
  initial: GridOptions<RowData>,
  initialGroups: GroupingState,
): GroupedGrid {
  let options = initial;
  let state = initialGroups;
  const host = initial.host;
  const t = i18n._.bind(i18n);
  let collapsed = new Set<string>();
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(state.storageKey) ?? '[]');
    if (Array.isArray(saved))
      collapsed = new Set(saved.filter((key): key is string => typeof key === 'string'));
  } catch {
    /* Storage can be unavailable in private browsing. */
  }
  let layout = new GroupLayout(state.enabled ? state.groups : [], options.rowCount, collapsed);
  let treegrid = state.enabled;
  let groupsByKey = new Map(state.groups.map((group) => [group.key, group]));
  // One map and one renderer for the engine's life.  The renderer remembers what it drew in each
  // cell, so a new one would draw every chip again, and each change to a record hands over new
  // lists of fields and a new format even when the fields are the same.  The map is changed in
  // place, and the format is read when a chip draws.
  const fields = new Map(state.fields.map((field) => [field.id, field]));
  const chips = createCellRenderer({
    fieldsById: fields,
    get format() {
      return state.format;
    },
    rowHeight: 'short',
  });
  function label(group: GridGroupBoundary): string {
    const id = Object.keys(group.values).at(-1);
    const field = id ? fields.get(id) : undefined;
    const value = id ? group.values[id] : null;
    return groupValueText(field, value, state.format, t);
  }
  const spoken = (group: GridGroupBoundary) => {
    const id = Object.keys(group.values).at(-1);
    const field = id ? fields.get(id) : undefined;
    const value = id ? group.values[id] : null;
    let name = label(group);
    // A person chip draws its initials beside the name, so the spoken name says them too.
    if (field && value != null && ['user', 'createdBy', 'lastModifiedBy'].includes(field.type)) {
      const person = state.format.collaborators.get(String(value));
      const shown = personLabel(person, String(value));
      name = `${avatarInitials(person?.name ?? shown, state.format.locale)}: ${shown}`;
    }
    const count = recordsText(group.count, t);
    return t(msg({ id: 'grid.group.description', message: `${name}, ${count}` }));
  };
  const recordCell = (cell: CellRef): CellRef | null => {
    const row = layout.recordAt(cell.row);
    return row === null ? null : { row, col: cell.col };
  };
  function displayCell(cell: CellRef, reveal = false): CellRef | null {
    let row = layout.rowAt(cell.row);
    if (row === null && reveal) {
      for (const group of state.groups)
        if (cell.row >= group.start && cell.row < group.start + group.count) collapsed.delete(group.key);
      rebuild();
      row = layout.rowAt(cell.row);
    }
    return row === null ? null : { row, col: cell.col };
  }
  const none = (): GridSelection => ({ active: null, range: null, rows: { kind: 'none' } });
  function recordSelection(selection: GridSelection): GridSelection {
    const active = selection.active ? recordCell(selection.active) : null;
    let range = null;
    if (selection.range) {
      let first = selection.range.start.row,
        last = selection.range.end.row;
      while (first <= last && layout.recordAt(first) === null) first++;
      while (last >= first && layout.recordAt(last) === null) last--;
      if (first <= last) {
        const start = recordCell({ ...selection.range.start, row: first })!;
        const end = recordCell({ ...selection.range.end, row: last })!;
        // A range across hidden records must never edit records the person cannot see.
        const hidden = layout.lines.some(
          ({ group, expanded }) => !expanded && group.start > start.row && group.start <= end.row,
        );
        if (!hidden) range = { start, end };
      }
    }
    const rows =
      selection.rows.kind === 'some'
        ? {
            kind: 'some' as const,
            rows: new Set([...selection.rows.rows].flatMap((row) => layout.recordAt(row) ?? [])),
          }
        : selection.rows;
    return { active, range, rows };
  }
  /**
   * Lays the groups out again and passes options on.  `redraw` draws every row again, which a
   * change of groups, records, or what's collapsed needs.  Options alone leave that to the grid,
   * which draws again only for the ones that change what rows show.
   */
  function rebuild(nextOptions: Partial<Omit<GridOptions<Line>, 'host'>> = {}, redraw = true) {
    const previous = layout;
    const next = new GroupLayout(state.enabled ? state.groups : [], options.rowCount, collapsed);
    const changed =
      previous.count !== next.count ||
      previous.lines.length !== next.lines.length ||
      previous.segments.length !== next.segments.length ||
      previous.lines.some((line, index) => {
        const other = next.lines[index]!;
        return (
          line.row !== other.row ||
          line.end !== other.end ||
          line.group.key !== other.group.key ||
          line.group.level !== other.group.level ||
          line.expanded !== other.expanded
        );
      }) ||
      previous.segments.some((segment, index) => {
        const other = next.segments[index]!;
        return segment.row !== other.row || segment.start !== other.start || segment.length !== other.length;
      });
    layout = next;
    if (changed || treegrid !== state.enabled) {
      const headers = new Map(next.lines.map((line) => [line.group.key, line.row]));
      grid.update({ ...nextOptions, rowCount: next.count, treegrid: state.enabled }, (row) => {
        const record = previous.recordAt(row);
        return record !== null
          ? next.rowAt(record)
          : (headers.get(previous.headers.get(row)?.group.key ?? '') ?? null);
      });
      treegrid = state.enabled;
    } else if (Object.keys(nextOptions).length) grid.update(nextOptions);
    if (redraw) grid.rowsChanged();
  }
  function save() {
    try {
      localStorage.setItem(state.storageKey, JSON.stringify([...collapsed]));
    } catch {
      /* Collapse still works without storage. */
    }
  }
  function collapse(key: string, value: boolean) {
    if (value) collapsed.add(key);
    else collapsed.delete(key);
    save();
    rebuild();
    const header = layout.lines.find((line) => line.group.key === key);
    if (header) {
      const cell = { row: header.row, col: 0 };
      grid.setSelection({ active: cell, range: { start: cell, end: cell }, rows: { kind: 'none' } });
      grid.focus();
    }
  }
  /** What a group row drew into a cell, kept so a redraw can change it in place */
  interface GroupCell {
    toggle?: {
      button: HTMLButtonElement;
      arrow: HTMLSpanElement;
      value: HTMLSpanElement;
      count: HTMLSpanElement;
      /** Whether the value holds choice chips, which mark the element itself, or plain text */
      chips: boolean;
    };
    add?: HTMLButtonElement;
    summary?: HTMLSpanElement;
  }
  const groupCells = new WeakMap<HTMLElement, GroupCell>();
  function span(className?: string): HTMLSpanElement {
    const node = document.createElement('span');
    if (className) node.className = className;
    return node;
  }
  /**
   * Changes a label without replacing its text node.  Safari drops a click whose press landed on a
   * text node that left the page before the release, and a new count can arrive in between.
   */
  function setLabel(node: HTMLElement, value: string) {
    const only = node.childNodes.length === 1 ? node.firstChild : null;
    if (only instanceof Text) {
      if (only.data !== value) only.data = value;
    } else if (node.textContent !== value) node.textContent = value;
  }
  /** Leaves `el` holding exactly `nodes`, in order, moving only the ones out of place. */
  function arrange(el: HTMLElement, nodes: readonly HTMLElement[]) {
    nodes.forEach((node, index) => {
      const current = el.childNodes[index] ?? null;
      if (current !== node) el.insertBefore(node, current);
    });
    while (el.childNodes.length > nodes.length) el.lastChild!.remove();
  }
  function drawGroup(
    el: HTMLElement,
    group: GridGroupBoundary,
    column: GridOptions<RowData>['columns'][number],
    col: number,
  ) {
    el.className = 'rio-grid__content rio-grid-group-cell';
    let cell = groupCells.get(el);
    if (!cell) {
      cell = {};
      groupCells.set(el, cell);
    }
    // Each control and label stays in place across redraws, and only what differs changes, so a
    // control with keyboard focus keeps it and a press under way still ends in a click.
    const nodes: HTMLElement[] = [];
    if (col === 0) {
      if (!cell.toggle) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'rio-grid-group-toggle';
        const arrow = span();
        arrow.setAttribute('aria-hidden', 'true');
        const value = span('rio-grid-group-value');
        const count = span('rio-grid-group-count');
        // The gap between value and count is visual only, so a space keeps the spoken name's
        // words apart in the text a screen reader's check reads.
        button.append(arrow, value, button.ownerDocument.createTextNode(' '), count);
        cell.toggle = { button, arrow, value, count, chips: false };
      }
      const { button, arrow, count } = cell.toggle;
      button.style.paddingInlineStart = `calc(var(--rio-space-3) * ${group.level - 1})`;
      button.setAttribute('aria-label', spoken(group));
      button.setAttribute('aria-expanded', String(!collapsed.has(group.key)));
      button.onclick = () => collapse(group.key, !collapsed.has(group.key));
      button.onkeydown = (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        collapse(group.key, event.key === 'ArrowLeft');
      };
      const disclosure = collapsed.has(group.key) ? 'closed' : 'open';
      if (arrow.dataset.disclosure !== disclosure) {
        arrow.replaceChildren(icon(document, disclosure === 'closed' ? faChevronRight : faChevronDown));
        arrow.dataset.disclosure = disclosure;
      }
      const id = Object.keys(group.values).at(-1)!;
      const field = fields.get(id);
      const asChips = Boolean(
        field &&
        group.values[id] !== null &&
        ['singleSelect', 'multipleSelect', 'user', 'createdBy', 'lastModifiedBy', 'link'].includes(
          field.type,
        ),
      );
      if (asChips !== cell.toggle.chips) {
        // Chips leave a title and classes on the element they draw into, so the other kind of
        // value starts from a new one.
        const fresh = span('rio-grid-group-value');
        cell.toggle.value.replaceWith(fresh);
        Object.assign(cell.toggle, { value: fresh, chips: asChips });
      }
      const { value } = cell.toggle;
      if (field && asChips) {
        const record: RowData = {
          id: '',
          values: group.values as Record<string, CellValue>,
          createdAt: field.type === 'createdTime' ? String(group.values[id] ?? '') : '',
          createdBy: field.type === 'createdBy' ? String(group.values[id] ?? '') : null,
          updatedAt: field.type === 'lastModifiedTime' ? String(group.values[id] ?? '') : '',
          updatedBy: field.type === 'lastModifiedBy' ? String(group.values[id] ?? '') : null,
        };
        chips(value, {
          row: record,
          rowIndex: group.start,
          column: { ...column, id },
          colIndex: col,
          selected: false,
          active: false,
        });
      } else setLabel(value, label(group));
      setLabel(count, recordsText(group.count, t));
      nodes.push(button);
      if (state.add && !options.readOnly) {
        if (!cell.add) {
          cell.add = document.createElement('button');
          cell.add.type = 'button';
          cell.add.className = 'rio-grid-group-add';
          cell.add.append(icon(document, faPlus));
        }
        const add = cell.add;
        const name = label(group);
        add.setAttribute('aria-label', t(msg({ id: 'grid.group.add', message: `Add record in ${name}` })));
        add.title = add.getAttribute('aria-label') ?? '';
        add.onclick = () => {
          if (collapsed.has(group.key)) collapse(group.key, false);
          state.add?.(group);
        };
        nodes.push(add);
      }
    }
    const field = fields.get(column.id);
    const summary = group.summaries[column.id];
    if (field && summary) {
      cell.summary ??= span('rio-grid-group-summary');
      const text = summaryValueText(field, summary, state.format);
      setLabel(cell.summary, text);
      cell.summary.setAttribute('aria-label', spokenSummary(field, summary.kind, text, 'ready', t));
      nodes.push(cell.summary);
    }
    arrange(el, nodes);
  }
  function paste(selection: GridSelection, data: { text: string; html: string | null }) {
    if (state.enabled) {
      const range = selectionRange(selection, options.rowCount, options.columns.length);
      if (!range) return;
      const height = Math.max(readClipboard(data).length, range.end.row - range.start.row + 1);
      // The controller pastes into consecutive snapshot rows, including rows beyond the selection.
      if (
        state.groups.some(
          (group) =>
            collapsed.has(group.key) &&
            group.start < range.start.row + height &&
            group.start + group.count > range.start.row,
        )
      )
        return;
    }
    host.paste?.(selection, data);
  }
  const drop = (from: number, to: number) => {
    const source = layout.recordAt(from);
    const header = layout.headers.get(to);
    const record = layout.recordAt(to);
    const group =
      header?.group ??
      [...state.groups]
        .reverse()
        .find((item) => record !== null && record >= item.start && record < item.start + item.count);
    return { source, record: record ?? group?.start ?? -1, group };
  };
  const mapped: GridHost<Line> = {
    renderAddIcon:
      host.renderAddIcon ?? ((element) => element.replaceChildren(icon(element.ownerDocument, faPlus))),
    frozenRows: host.frozenRows,
    columnDropReason: host.columnDropReason,
    dragMessage(status, kind, index) {
      const group = kind === 'row' && status === 'target' ? layout.headers.get(index)?.group : undefined;
      if (group) {
        const name = label(groupsByKey.get(group.key)!);
        return t(msg({ id: 'grid.drag.groupTarget', message: `Move into ${name}` }));
      }
      return host.dragMessage?.(status, kind, index) ?? '';
    },
    onColumnGroupToggle: host.onColumnGroupToggle,
    rowDropReason(from, to) {
      const target = drop(from, to);
      return target.source === null
        ? ''
        : (host.rowDropReason?.(target.source, target.record, target.group?.key) ?? null);
    },
    onRowMove(from, to) {
      const target = drop(from, to);
      if (target.source !== null) host.onRowMove?.(target.source, target.record, target.group?.key);
    },
    getRow(index) {
      const header = layout.headers.get(index);
      if (header) return { group: groupsByKey.get(header.group.key)! };
      const source = layout.recordAt(index);
      const record = source === null ? undefined : host.getRow(source);
      return record && source !== null ? { record, index: source } : undefined;
    },
    ensureRows(start, end) {
      for (const range of layout.recordRanges(start, end)) host.ensureRows(range.start, range.end);
    },
    renderCell(el, context) {
      if ('group' in context.row) drawGroup(el, context.row.group, context.column, context.colIndex);
      else {
        el.className = 'rio-grid__content';
        host.renderCell(el, { ...context, row: context.row.record, rowIndex: context.row.index });
      }
    },
    cellComment: (line, column) =>
      'group' in line ? null : (host.cellComment?.(line.record, column) ?? null),
    onCellComment: (cell) => {
      const source = recordCell(cell);
      if (source) host.onCellComment?.(source);
    },
    renderHeader: host.renderHeader,
    renderFooter: host.renderFooter,
    describeFooter: host.describeFooter,
    onFooterActivate: host.onFooterActivate,
    renderRowHeader(el, index, line, selected) {
      if (line && 'group' in line) el.replaceChildren();
      else host.renderRowHeader(el, layout.recordAt(index) ?? index, line?.record, selected);
    },
    rowClass: (line, index) =>
      'group' in line ? 'rio-grid-group' : (host.rowClass?.(line.record, layout.recordAt(index)!) ?? null),
    rowTree(index) {
      if (!state.enabled) return undefined;
      const header = layout.headers.get(index);
      return header
        ? {
            level: header.group.level,
            expanded: header.expanded,
            label: spoken(groupsByKey.get(header.group.key)!),
          }
        : {
            level:
              (state.groups[0] ? Math.max(...state.groups.slice(0, 3).map((group) => group.level)) : 0) + 1,
          };
    },
    stickyRows: (first) =>
      layout.sticky(first).map((line) => ({ row: line.row, level: line.group.level, end: line.end })),
    canEditRow: (index) => layout.recordAt(index) !== null,
    canStartEdit(cell) {
      const source = recordCell(cell);
      return source !== null && host.canStartEdit?.(source) !== false;
    },
    onRowKey(index, event) {
      const header = layout.headers.get(index);
      if (!header) return false;
      if (
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowRight' ||
        event.key === 'Enter' ||
        event.key === ' '
      ) {
        collapse(
          header.group.key,
          event.key === 'ArrowLeft' || (event.key !== 'ArrowRight' && header.expanded),
        );
        return true;
      }
      return false;
    },
    editText: (line, column) => ('record' in line ? host.editText(line.record, column) : ''),
    commitText: (cell, text) => {
      const source = recordCell(cell);
      return source ? host.commitText(source, text) : null;
    },
    openEditor: (request) => {
      const source = recordCell(request.cell);
      return source && 'record' in request.row
        ? (host.openEditor?.({ ...request, cell: source, row: request.row.record }) ?? (() => {}))
        : () => {};
    },
    toggle: (cell) => {
      const source = recordCell(cell);
      if (source) host.toggle?.(source);
    },
    copy: (selection) => host.copy?.(recordSelection(selection)) ?? null,
    paste: (selection, data) => {
      if (!state.enabled) {
        paste(selection, data);
        return;
      }
      const mapped = recordSelection(selection);
      if (selection.range && !mapped.range) return;
      paste(mapped, data);
    },
    clear: (selection) => host.clear?.(recordSelection(selection)),
    fill: (request) => {
      const source = recordSelection({ ...none(), range: request.source }).range;
      const target = request.target ? recordSelection({ ...none(), range: request.target }).range : null;
      if (source && (!request.target || target)) host.fill?.({ ...request, source, target });
    },
    onFind: host.onFind,
    describeCell: (cell) => {
      const header = layout.headers.get(cell.row);
      const source = recordCell(cell);
      if (header && cell.col > 0) {
        const group = groupsByKey.get(header.group.key)!;
        const field = fields.get(options.columns[cell.col]?.id ?? '');
        const summary = field && group.summaries[field.id];
        if (field && summary)
          return spokenSummary(
            field,
            summary.kind,
            summaryValueText(field, summary, state.format),
            'ready',
            t,
          );
      }
      return header
        ? spoken(groupsByKey.get(header.group.key)!)
        : source
          ? (host.describeCell?.(source) ?? '')
          : '';
    },
    onSelectionChange: (selection) => host.onSelectionChange?.(recordSelection(selection)),
    onExpandRow: (index) => {
      const source = layout.recordAt(index);
      if (source !== null) host.onExpandRow?.(source);
    },
    onColumnResize: host.onColumnResize,
    onColumnMove: host.onColumnMove,
    onHeaderActivate: host.onHeaderActivate,
    onContextMenu: (target, point) => {
      if (target.kind === 'cell') {
        const cell = recordCell(target.cell);
        if (cell) host.onContextMenu?.({ ...target, cell }, point);
        else host.onContextMenu?.({ kind: 'header', col: 0 }, point);
      } else if (target.kind === 'rowHeader') {
        const row = layout.recordAt(target.row);
        if (row !== null) host.onContextMenu?.({ ...target, row }, point);
      } else host.onContextMenu?.(target, point);
    },
    onAddRow: host.onAddRow,
    onAddColumn: host.onAddColumn,
    onUndo: host.onUndo,
    onRedo: host.onRedo,
  };
  const grid = createGrid(node, {
    ...options,
    host: mapped,
    rowCount: layout.count,
    treegrid: state.enabled,
  });
  return {
    paste,
    recordCell,
    update(next) {
      options = { ...options, ...next };
      const { rowCount: _rowCount, ...rest } = next;
      // A record count means the records may have changed, so every row draws again, as it does
      // whenever the layout moves.
      rebuild(rest, next.rowCount !== undefined);
    },
    grouping(next) {
      const previous = state;
      state = next;
      groupsByKey = new Map(state.groups.map((group) => [group.key, group]));
      if (next.fields !== previous.fields) {
        fields.clear();
        for (const field of next.fields) fields.set(field.id, field);
      }
      rebuild();
    },
    collapseGroups(value) {
      collapsed = new Set(value ? state.groups.map((group) => group.key) : []);
      save();
      rebuild();
    },
    rowsChanged: () => grid.rowsChanged(),
    isRowHidden: (row) => layout.rowAt(row) === null,
    footerChanged: () => grid.footerChanged(),
    scrollToCell(cell, align) {
      const target = cell.row === undefined ? cell : displayCell({ row: cell.row, col: cell.col ?? 0 }, true);
      if (target) grid.scrollToCell(target, align);
    },
    getSelection: () => recordSelection(grid.getSelection()),
    setSelection(selection) {
      const active = selection.active ? displayCell(selection.active, true) : null;
      const start = selection.range ? displayCell(selection.range.start) : null;
      const end = selection.range ? displayCell(selection.range.end) : null;
      const rows =
        selection.rows.kind === 'some'
          ? {
              kind: 'some' as const,
              rows: new Set([...selection.rows.rows].flatMap((row) => layout.rowAt(row) ?? [])),
            }
          : selection.rows;
      grid.setSelection({ active, range: start && end ? { start, end } : null, rows });
    },
    setDecorations: (marks) =>
      grid.setDecorations(
        marks.flatMap((mark) => {
          const row = layout.rowAt(mark.row);
          return row === null ? [] : [{ ...mark, row }];
        }),
      ),
    startEditing(cell, text) {
      const target = cell ? displayCell(cell, true) : undefined;
      if (target !== null) grid.startEditing(target, text);
    },
    stopEditing: (commit) => grid.stopEditing(commit),
    isEditing: () => grid.isEditing(),
    focus: () => grid.focus(),
    runShortcut: (id) => grid.runShortcut?.(id),
    getVisibleRange() {
      const range = grid.getVisibleRange();
      const records = layout.recordRanges(range.firstRow, range.lastRow);
      return {
        ...range,
        firstRow: records[0]?.start ?? 0,
        lastRow: records.at(-1)?.end ?? 0,
      };
    },
    anchorRow() {
      const row = grid.anchorRow();
      return layout.recordAt(row) ?? layout.headers.get(row)?.group.start ?? 0;
    },
    destroy: () => grid.destroy(),
  };
}
