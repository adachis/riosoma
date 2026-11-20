import { inlineOffset } from './layout.js';
import type { IndexRange } from './layout.js';
import { gridMessages } from './messages.js';
import type { createSelectionState } from './selection.js';
import type { CellDecoration, CellRenderContext, GridColumn, GridOptions } from './types.js';

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  role?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (role) node.setAttribute('role', role);
  return node;
}

function style(
  node: HTMLElement,
  property: 'inlineSize' | 'blockSize' | 'insetInlineStart' | 'transform' | 'visibility',
  value: string,
) {
  if (node.style[property] !== value) node.style[property] = value;
}

/**
 * Writes a button's label only when it changes.  Writing the same text still swaps in a new text
 * node, and Safari drops a click whose press landed on a text node that left the page before the
 * release.  A redraw between the two would lose that click.
 */
function text(node: HTMLElement, value: string) {
  if (node.textContent !== value) node.textContent = value;
}

function placeAfter(parent: HTMLElement, node: HTMLElement, previous: HTMLElement | null) {
  const next = previous ? previous.nextSibling : parent.firstChild;
  if (next !== node) parent.insertBefore(node, next);
}

interface CellView {
  node: HTMLDivElement;
  content: HTMLDivElement;
  comment: HTMLButtonElement | null;
  column: GridColumn | null;
  selected: boolean;
  active: boolean;
  visible: boolean;
}

/** Which band a row of cells is: the column headers, a record's row, or the footer. */
type BandKind = 'header' | 'row' | 'footer';

const BAND_CLASS: Record<BandKind, string> = {
  header: 'rio-grid__header-row',
  row: 'rio-grid__row',
  footer: 'rio-grid__footer-row',
};

const CELL_CLASS: Record<BandKind, string> = {
  header: 'rio-grid__header-cell',
  row: 'rio-grid__cell',
  footer: 'rio-grid__footer-cell',
};

const CELL_ROLE: Record<BandKind, string> = { header: 'columnheader', row: 'gridcell', footer: 'gridcell' };

interface Band {
  kind: BandKind;
  node: HTMLDivElement;
  heading: HTMLDivElement;
  frozen: HTMLDivElement;
  scrolling: HTMLDivElement;
  cells: Map<number, CellView>;
  pool: CellView[];
  dirty: boolean;
}

export interface RenderFrame<Row> {
  options: GridOptions<Row>;
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  prefix: readonly number[];
  frozen: number;
  rows: IndexRange;
  columns: IndexRange;
  frozenColumns: IndexRange;
  /** The footer cell the keyboard is on, or null while it's anywhere else */
  footerActive?: number | null;
}

interface DecorationView {
  decoration: CellDecoration;
  node: HTMLSpanElement | null;
}

/**
 * Draws the grid's rows into its row groups.  `headerActions` holds the add-field button, which
 * sits outside the grid, since a row can own only cells.
 */
export function createRenderer<Row>(
  header: HTMLElement,
  viewport: HTMLElement,
  selection: ReturnType<typeof createSelectionState>,
  footer?: HTMLElement,
  headerActions: HTMLElement = element('div', 'rio-grid__header-actions'),
  pinnedViewport?: HTMLElement,
) {
  const rows = new Map<number, Band>();
  const pool: Band[] = [];
  const headerBand = createBand('header');
  header.append(headerBand.node);
  const groupLayer = element('div', 'rio-grid__column-groups', 'row');
  groupLayer.setAttribute('aria-rowindex', '1');
  header.prepend(groupLayer);
  let groupsDirty = true;
  const groupSegments = new Map<
    string,
    {
      cell: HTMLElement;
      button: HTMLButtonElement;
      group?: GridColumn['group'];
      first?: number;
      last?: number;
      options?: GridOptions<Row>;
    }
  >();
  const footerBand = createBand('footer');
  footer?.append(footerBand.node);
  // Adding a record is a row of its own after the last record, with one cell across every column,
  // so the button inside it is somewhere a grid allows.
  const addRow = element('div', 'rio-grid__add-row', 'row');
  addRow.dataset.rioAddRow = '';
  addRow.hidden = true;
  const addCell = element('div', 'rio-grid__add-cell', 'gridcell');
  addCell.setAttribute('aria-colindex', '1');
  const add = element('button', 'rio-grid__add');
  text(add, '+');
  add.type = 'button';
  add.dataset.rioAdd = '';
  addCell.append(add);
  addRow.append(addCell);
  viewport.append(addRow);
  const addColumn = element('button', 'rio-grid__add-column');
  text(addColumn, '+');
  addColumn.type = 'button';
  addColumn.dataset.rioAddColumn = '';
  // Help's "Show me" demos point at the button by this name.
  addColumn.dataset.anchor = 'grid.field.add';
  headerActions.append(addColumn);
  let decorations = new Map<string, DecorationView[]>();
  let decorationTime = 0;
  let addIcon: GridOptions<Row>['host']['renderAddIcon'];

  function createBand(kind: BandKind): Band {
    const node = element('div', BAND_CLASS[kind], 'row');
    const heading = element('div', 'rio-grid__row-header', kind === 'row' ? 'rowheader' : undefined);
    if (kind !== 'row') heading.setAttribute('aria-hidden', 'true');
    const frozen = element('div', 'rio-grid__pane rio-grid__pane--frozen', 'presentation');
    const scrolling = element('div', 'rio-grid__pane', 'presentation');
    node.append(heading, frozen, scrolling);
    return { kind, node, heading, frozen, scrolling, cells: new Map(), pool: [], dirty: true };
  }

  function createCell(kind: BandKind): CellView {
    const node = element('div', CELL_CLASS[kind], CELL_ROLE[kind]);
    const content = element('div', 'rio-grid__content');
    node.append(content);
    if (kind === 'header') {
      node.tabIndex = -1;
      const handle = element('div', 'rio-grid__resize');
      handle.dataset.rioResize = '';
      handle.setAttribute('aria-hidden', 'true');
      node.append(handle);
    }
    const comment = kind === 'row' ? element('button', 'rio-grid__comment') : null;
    if (comment) {
      comment.type = 'button';
      comment.hidden = true;
      node.append(comment);
    }
    return { node, content, comment, column: null, selected: false, active: false, visible: false };
  }

  function drawBand(band: Band, frame: RenderFrame<Row>, rowIndex: number, rowVisible = true) {
    const { options, prefix, width, frozen, scrollX } = frame;
    const kind = band.kind;
    const direction = options.direction ?? 'ltr';
    const rowHeaderWidth = options.rowHeaderWidth ?? 64;
    const frozenWidth = prefix[frozen]!;
    const frozenVisibleWidth = Math.min(frozenWidth, Math.max(0, width - rowHeaderWidth));
    const scrollingStart = rowHeaderWidth + frozenVisibleWidth;
    style(band.node, 'inlineSize', `${width}px`);
    style(
      band.node,
      'blockSize',
      `${kind === 'header' ? (options.headerHeight ?? 32) : kind === 'footer' ? (options.footerHeight ?? 32) : options.rowHeight}px`,
    );
    style(band.heading, 'inlineSize', `${rowHeaderWidth}px`);
    style(band.frozen, 'insetInlineStart', `${rowHeaderWidth}px`);
    style(band.frozen, 'inlineSize', `${frozenVisibleWidth}px`);
    style(band.scrolling, 'insetInlineStart', `${scrollingStart}px`);
    style(band.scrolling, 'inlineSize', `${Math.max(0, width - scrollingStart)}px`);

    const indices: number[] = [];
    for (let col = frame.frozenColumns.start; col < frame.frozenColumns.end; col++) indices.push(col);
    for (let col = frame.columns.start; col < frame.columns.end; col++) indices.push(col);
    const wanted = new Set(indices);
    for (const [col, cell] of band.cells) {
      if (wanted.has(col)) continue;
      cell.node.remove();
      band.cells.delete(col);
      cell.column = null;
      band.pool.push(cell);
    }

    const row = kind === 'row' ? options.host.getRow(rowIndex) : undefined;
    const rowSelected = kind === 'row' && selection.rowSelected(rowIndex);
    if (band.dirty && kind === 'row') {
      band.node.className = `rio-grid__row${row !== undefined && options.host.rowClass ? ` ${options.host.rowClass(row, rowIndex) ?? ''}` : ''}`;
      const tree = options.host.rowTree?.(rowIndex);
      for (const [name, value] of Object.entries({
        'aria-level': tree?.level,
        'aria-expanded': tree?.expanded,
        'aria-label': tree?.label,
      })) {
        if (value === undefined) band.node.removeAttribute(name);
        else band.node.setAttribute(name, String(value));
      }
      band.node.toggleAttribute('data-selected', rowSelected);
      // The host replaces what it drew, so its buttons stay put while a press is under way.
      options.host.renderRowHeader(band.heading, rowIndex, row, rowSelected);
    }

    let previousFrozen: HTMLElement | null = null;
    let previousScrolling: HTMLElement | null = null;
    for (const col of indices) {
      const column = options.columns[col]!;
      let cell = band.cells.get(col);
      if (!cell) {
        cell = band.pool.pop() ?? createCell(kind);
        band.cells.set(col, cell);
      }
      const pane = col < frozen ? band.frozen : band.scrolling;
      const previous: HTMLElement | null = col < frozen ? previousFrozen : previousScrolling;
      placeAfter(pane, cell.node, previous);
      if (col < frozen) previousFrozen = cell.node;
      else previousScrolling = cell.node;
      const position = prefix[col]! - (col < frozen ? 0 : frozenWidth + scrollX);
      const paneWidth = col < frozen ? frozenVisibleWidth : Math.max(0, width - scrollingStart);
      const visible = rowVisible && position < paneWidth && position + column.width > 0;
      style(cell.node, 'transform', `translateX(${inlineOffset(position, direction)}px)`);
      style(cell.node, 'inlineSize', `${column.width}px`);
      const selected = kind === 'row' && selection.cellSelected({ row: rowIndex, col });
      const active =
        kind === 'row'
          ? selection.cellActive({ row: rowIndex, col })
          : kind === 'footer' && frame.footerActive === col;
      if (
        band.dirty ||
        cell.column !== column ||
        cell.selected !== selected ||
        cell.active !== active ||
        cell.visible !== visible
      ) {
        // A cell that showed another column starts empty.  The same column handed over as a new
        // object, as when the view's settings change, keeps what the host drew, so the host can
        // update it in place and a button pressed inside it is still there for the release.
        if (cell.column?.id !== column.id) {
          cell.content.replaceChildren();
          cell.content.className = 'rio-grid__content';
          cell.content.removeAttribute('style');
        }
        cell.node.setAttribute('aria-colindex', String(col + 1));
        cell.node.dataset.rioCol = String(col);
        cell.node.style.textAlign = column.align ?? 'start';
        cell.node.toggleAttribute('data-selected', selected || rowSelected);
        if (kind === 'row') cell.node.setAttribute('aria-selected', String(selected || rowSelected));
        cell.node.toggleAttribute('data-active', active);
        if (kind === 'header') {
          cell.node.dataset.rioColumn = String(col);
          cell.node.style.background = column.headerColor
            ? `var(--rio-aa-choice-${column.headerColor}-soft)`
            : '';
          cell.node.style.color = column.headerColor ? 'var(--rio-aa-choice-text)' : '';
          cell.node.toggleAttribute('data-grouped-column', Boolean(column.group));
          options.host.renderHeader(cell.content, column, col);
        } else if (kind === 'footer') {
          cell.node.dataset.rioFooter = String(col);
          const label = options.host.describeFooter?.(col) ?? '';
          if (label) cell.node.setAttribute('aria-label', label);
          else cell.node.removeAttribute('aria-label');
          if (options.host.renderFooter) options.host.renderFooter(cell.content, column, col);
          else cell.content.replaceChildren();
        } else {
          drawRowCell(cell, options, { row, rowIndex, column, colIndex: col, selected, active, visible });
        }
        cell.column = column;
        cell.selected = selected;
        cell.active = active;
        cell.visible = visible;
      }
      if (kind === 'row') drawDecorations(cell.node, rowIndex, col);
    }
    // Detached pools stay proportional to the current window after a container shrinks.
    band.pool.length = Math.min(band.pool.length, indices.length);
    band.dirty = false;
  }

  function drawRowCell(
    cell: CellView,
    options: GridOptions<Row>,
    context: Omit<CellRenderContext<Row>, 'row'> & { row: Row | undefined },
  ) {
    const { row, rowIndex, column, colIndex } = context;
    cell.node.dataset.rioRow = String(rowIndex);
    cell.node.toggleAttribute('data-loading', row === undefined);
    const label = row === undefined ? null : options.host.cellComment?.(row, column);
    if (cell.comment) {
      cell.comment.hidden = !label;
      cell.comment.setAttribute('aria-label', label ?? '');
      cell.comment.onclick = (event) => {
        event.stopPropagation();
        options.host.onCellComment?.({ row: rowIndex, col: colIndex });
      };
    }
    if (row === undefined) cell.content.replaceChildren();
    else options.host.renderCell(cell.content, { ...context, row });
  }

  function drawGroups(frame: RenderFrame<Row>) {
    const { options, prefix, frozen, scrollX, width } = frame;
    const rowHeader = options.rowHeaderWidth ?? 64;
    const wanted = new Set<string>();
    for (const [range, fixed] of [
      [frame.frozenColumns, true],
      [frame.columns, false],
    ] as const) {
      const edge = Math.min(width, rowHeader + (fixed ? 0 : prefix[frozen]!));
      const limit = fixed ? Math.min(width, rowHeader + prefix[frozen]!) : width;
      for (let col = range.start; col < range.end;) {
        const group = options.columns[col]?.group;
        if (!group) {
          col++;
          continue;
        }
        const first = col;
        while (col < range.end && options.columns[col]?.group?.id === group.id) col++;
        const start = Math.max(edge, rowHeader + prefix[first]! - (fixed ? 0 : scrollX));
        const end = Math.min(limit, rowHeader + prefix[col]! - (fixed ? 0 : scrollX));
        if (end <= start) continue;
        const key = `${fixed}:${group.id}`;
        wanted.add(key);
        let segment = groupSegments.get(key);
        if (!segment) {
          const cell = element('div', 'rio-grid__column-group-segment', 'columnheader');
          const button = element('button', 'rio-grid__column-group');
          button.type = 'button';
          button.tabIndex = -1;
          cell.append(button);
          groupLayer.append(cell);
          segment = { cell, button };
          groupSegments.set(key, segment);
        }
        const { cell, button } = segment;
        style(cell, 'insetInlineStart', `${start}px`);
        style(cell, 'inlineSize', `${end - start}px`);
        style(button, 'inlineSize', `${end - start}px`);
        if (
          groupsDirty ||
          segment.group !== group ||
          segment.first !== first ||
          segment.last !== col ||
          segment.options !== options
        ) {
          cell.setAttribute('aria-colindex', String(first + 1));
          cell.setAttribute('aria-colspan', String(col - first));
          button.dataset.rioColumnGroup = group.id;
          text(button, group.name);
          button.setAttribute('aria-expanded', String(!group.collapsed));
          button.disabled =
            !options.host.onColumnGroupToggle ||
            (options.host.columnDropReason?.(first, first) ?? null) !== null;
          button.style.background = group.color ? `var(--rio-aa-choice-${group.color}-soft)` : '';
          button.style.color = group.color ? 'var(--rio-aa-choice-text)' : '';
          Object.assign(segment, { group, first, last: col, options });
        }
      }
    }
    for (const [key, segment] of groupSegments) {
      if (wanted.has(key)) continue;
      segment.cell.remove();
      groupSegments.delete(key);
    }
    groupsDirty = false;
  }

  function drawDecorations(cell: HTMLElement, row: number, col: number) {
    const entries = decorations.get(`${row}:${col}`) ?? [];
    for (const old of cell.querySelectorAll('.rio-grid__decoration')) {
      if (!entries.some((entry) => entry.node === old)) old.remove();
    }
    for (const entry of entries) {
      if (!entry.node) {
        entry.node = element('span', `rio-grid__decoration rio-grid__decoration--${entry.decoration.kind}`);
        entry.node.setAttribute('aria-hidden', 'true');
        if (entry.decoration.kind === 'match')
          entry.node.toggleAttribute('data-current', entry.decoration.current);
        else entry.node.style.setProperty('--rio-grid-decoration-color', entry.decoration.color);
        if (entry.decoration.kind === 'presence') {
          const label = element('span', 'rio-grid__presence-label');
          label.textContent = entry.decoration.label;
          entry.node.append(label);
        }
      }
      if (entry.node.parentElement !== cell) {
        if (entry.decoration.kind === 'flash')
          entry.node.style.animationDelay = `${-(performance.now() - decorationTime)}ms`;
        cell.append(entry.node);
      }
    }
  }

  return {
    groupButton(id: string): HTMLButtonElement | null {
      return (
        [...groupSegments.values()].find(({ button }) => button.dataset.rioColumnGroup === id)?.button ?? null
      );
    },
    headerCell(col: number): HTMLElement | null {
      return headerBand.cells.get(col)?.node ?? null;
    },
    cell(cell: { row: number; col: number }): HTMLElement | null {
      return rows.get(cell.row)?.cells.get(cell.col)?.node ?? null;
    },
    /** Echo an edit without visiting other cells or recalculating the viewport. */
    redrawCell(ref: { row: number; col: number }, options: GridOptions<Row>) {
      const cell = rows.get(ref.row)?.cells.get(ref.col);
      const column = options.columns[ref.col];
      if (!cell || !column || cell.column?.id !== column.id) return;
      drawRowCell(cell, options, {
        row: options.host.getRow(ref.row),
        rowIndex: ref.row,
        column,
        colIndex: ref.col,
        selected: selection.cellSelected(ref),
        active: selection.cellActive(ref),
        visible: cell.visible,
      });
      drawDecorations(cell.node, ref.row, ref.col);
    },
    /** A footer cell's element, while its column is drawn */
    footerCell(col: number): HTMLElement | null {
      return footerBand.cells.get(col)?.node ?? null;
    },
    invalidate(start = 0, end = Infinity) {
      for (const [index, band] of rows) if (index >= start && index < end) band.dirty = true;
      if (start === 0 && end === Infinity) {
        headerBand.dirty = true;
        groupsDirty = true;
        footerBand.dirty = true;
      }
    },
    invalidateFooter() {
      footerBand.dirty = true;
    },
    setDecorations(next: readonly CellDecoration[]) {
      for (const entries of decorations.values()) for (const entry of entries) entry.node?.remove();
      decorations = new Map();
      decorationTime = performance.now();
      for (const decoration of next) {
        const key = `${decoration.row}:${decoration.col}`;
        const entries = decorations.get(key) ?? [];
        entries.push({ decoration: { ...decoration }, node: null });
        decorations.set(key, entries);
      }
    },
    draw(frame: RenderFrame<Row>) {
      if (frame.options.host.renderAddIcon !== addIcon) {
        addIcon = frame.options.host.renderAddIcon;
        addIcon?.(add);
        addIcon?.(addColumn);
      }

      drawBand(headerBand, frame, -1);
      drawGroups(frame);
      headerActions.hidden = !frame.options.showAddColumn;
      if (frame.options.showAddColumn) {
        // Laid over the header's scrolling columns, and clipped where they are, so the button never
        // slides under the frozen ones.
        const rowHeaderWidth = frame.options.rowHeaderWidth ?? 64;
        const start =
          rowHeaderWidth + Math.min(frame.prefix[frame.frozen]!, Math.max(0, frame.width - rowHeaderWidth));
        style(headerActions, 'insetInlineStart', `${start}px`);
        style(headerActions, 'inlineSize', `${Math.max(0, frame.width - start)}px`);
        style(headerActions, 'blockSize', `${frame.options.headerHeight ?? 32}px`);
        addColumn.setAttribute(
          'aria-label',
          frame.options.messages?.['grid.field.add'] ?? gridMessages['grid.field.add'],
        );
        addColumn.title = addColumn.getAttribute('aria-label') ?? '';
        addColumn.disabled = !!frame.options.readOnly;
        const offset = frame.prefix[frame.prefix.length - 1]! - frame.prefix[frame.frozen]! - frame.scrollX;
        // A partially clipped target cannot carry its icon or offer its full pointer area.
        style(
          addColumn,
          'visibility',
          offset < 0 || offset + (addColumn.offsetWidth || 40) > frame.width - start ? 'hidden' : '',
        );
        style(
          addColumn,
          'transform',
          `translateX(${inlineOffset(offset, frame.options.direction ?? 'ltr')}px)`,
        );
      }
      const headerRows = frame.options.columns.some((column) => column.group) ? 2 : 1;
      if (groupLayer.hidden !== (headerRows === 1)) groupLayer.hidden = headerRows === 1;
      headerBand.node.setAttribute('aria-rowindex', String(headerRows));
      const sticky =
        frame.options.host.stickyRows?.(
          Math.floor(frame.scrollY / frame.options.rowHeight) +
            (pinnedViewport ? (frame.options.host.frozenRows?.() ?? 0) : 0),
        ) ?? [];
      const pins = Math.min(frame.options.host.frozenRows?.() ?? 0, frame.options.rowCount);
      const wantedRows = new Set(sticky.map((line) => line.row));
      for (let index = 0; index < pins; index++) wantedRows.add(index);
      for (let index = frame.rows.start; index < Math.min(frame.options.rowCount, frame.rows.end); index++)
        wantedRows.add(index);
      const stickyByRow = new Map(sticky.map((line) => [line.row, line]));
      for (const [index, band] of rows) {
        if (wantedRows.has(index)) continue;
        band.node.remove();
        rows.delete(index);
        pool.push(band);
      }
      let previousRow: HTMLElement | null = null;
      let previousPin: HTMLElement | null = null;
      for (const index of [...wantedRows].sort((a, b) => a - b)) {
        let band = rows.get(index);
        if (!band) {
          band = pool.pop() ?? createBand('row');
          band.dirty = true;
          rows.set(index, band);
          (index < pins && pinnedViewport ? pinnedViewport : viewport).append(band.node);
          band.node.dataset.rioRow = String(index);
        }
        const rowIndex = String(index + headerRows + 1);
        if (band.node.getAttribute('aria-rowindex') !== rowIndex)
          band.node.setAttribute('aria-rowindex', rowIndex);
        if (index < pins && pinnedViewport) {
          placeAfter(pinnedViewport, band.node, previousPin);
          previousPin = band.node;
        } else {
          placeAfter(viewport, band.node, previousRow);
          previousRow = band.node;
        }
        const pinned = stickyByRow.get(index);
        const natural = (index - (pinnedViewport ? pins : 0)) * frame.options.rowHeight - frame.scrollY;
        const y =
          index < pins
            ? index * frame.options.rowHeight
            : pinned
              ? Math.min(
                  Math.max(
                    natural,
                    ((pinnedViewport ? 0 : pins) + pinned.level - 1) * frame.options.rowHeight,
                  ),
                  (pinned.end - 1 - (pinnedViewport ? pins : 0)) * frame.options.rowHeight - frame.scrollY,
                )
              : natural;
        band.node.style.zIndex = index < pins ? '12' : pinned ? String(10 - pinned.level) : '';
        band.node.toggleAttribute('data-pinned', index < pins);
        style(band.node, 'transform', `translateY(${y}px)`);
        drawBand(band, frame, index, index < pins || (y < frame.height && y + frame.options.rowHeight > 0));
      }
      pool.length = Math.min(pool.length, rows.size);
      const showAdd =
        frame.options.showAddRow &&
        frame.rows.end > frame.options.rowCount &&
        frame.rows.start <= frame.options.rowCount;
      addRow.hidden = !showAdd;
      if (showAdd) {
        placeAfter(viewport, addRow, previousRow);
        const addTop =
          (frame.options.rowCount - (pinnedViewport ? pins : 0)) * frame.options.rowHeight - frame.scrollY;
        style(addRow, 'transform', `translateY(${addTop}px)`);
        // Overscan keeps the row mounted, but a creation target needs its full visible height.
        style(
          addRow,
          'visibility',
          addTop >= 0 && addTop + frame.options.rowHeight <= frame.height ? '' : 'hidden',
        );
        style(addRow, 'blockSize', `${frame.options.rowHeight}px`);
        addRow.setAttribute('aria-rowindex', String(frame.options.rowCount + headerRows + 1));
        addCell.setAttribute('aria-colspan', String(Math.max(1, frame.options.columns.length)));
        const label = frame.options.messages?.['grid.addRow'] ?? gridMessages['grid.addRow'];
        add.setAttribute('aria-label', label);
        add.title = label;
        add.disabled = !!frame.options.readOnly;
      }
      if (footer && frame.options.showFooter) {
        // The header is the first row, the records and the add-record row follow it, and the
        // footer comes after them all.
        footerBand.node.setAttribute(
          'aria-rowindex',
          String(frame.options.rowCount + headerRows + (frame.options.showAddRow ? 2 : 1)),
        );
        drawBand(footerBand, frame, -1);
      }
    },
  };
}
