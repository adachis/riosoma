/* The optional messages map supplies translated built-in labels without a runtime dependency.
 * VisibleRange describes the scrolling columns; frozen columns form a separate visible window.
 */
import './grid.css';
import { createDrag } from './drag.js';
import { createCellInteraction } from './cell-interaction.js';
import { createEditing } from './editing.js';
import { createFill } from './fill.js';
import { createInteraction } from './interaction.js';
import {
  frozenCount,
  inlineOffset,
  logicalPoint,
  prefixWidths,
  visibleColumns,
  visibleRows,
} from './layout.js';
import { createRenderer, element } from './render.js';
import { alignScroll, clamp, createScrollMap } from './scroll.js';
import { createSelectionState, sameCell } from './selection.js';
import type { CellRange, CellRef, GridApi, GridOptions, VisibleRange } from './types.js';

export function createGrid<Row>(container: HTMLElement, initial: GridOptions<Row>): GridApi<Row> {
  let options = { ...initial, columns: [...initial.columns] };
  const host = initial.host;
  const previousDirection = container.getAttribute('dir');
  const hadClass = container.classList.contains('rio-grid');
  container.classList.add('rio-grid');

  // The grid role sits on an element of its own that holds nothing but rows, since ARIA lets a
  // grid own only rows.  The keyboard's text box, the announcements, and the add-field button are
  // its siblings instead, laid over it in the same place.
  const table = element('div', 'rio-grid__table', 'grid');
  const header = element('div', 'rio-grid__header', 'rowgroup');
  // The scroll region owns the rows so an empty fixed table can focus it without breaking grid ownership.
  const scroller = element('div', 'rio-grid__scroller', 'rowgroup');
  const spacer = element('div', 'rio-grid__spacer');
  const viewport = element('div', 'rio-grid__viewport');
  const pinnedViewport = element('div', 'rio-grid__pinned', 'rowgroup');
  let pinnedHeight = 0;
  let pinnedScrollTop = 0;
  const input = element('textarea', 'rio-grid__input');
  input.rows = 1;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.tabIndex = 0;
  const indicator = element('div', 'rio-grid__drop-indicator');
  indicator.hidden = true;
  indicator.setAttribute('aria-hidden', 'true');
  spacer.append(viewport);
  scroller.append(spacer);
  const editorLayer = element('div', 'rio-grid__editors');
  const error = element('div', 'rio-grid__error');
  error.hidden = true;
  const live = element('div', 'rio-grid__live');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  const editorClip = element('div', 'rio-grid__editor-clip');
  editorClip.append(input, error);
  editorLayer.append(editorClip);
  // The footer sits under the rows and outside the scroller, so it stays put while they scroll.
  const footer = element('div', 'rio-grid__footer', 'rowgroup');
  footer.hidden = true;
  // The add-field button rides at the end of the header, clipped the way the header's scrolling
  // columns are, and comes first so it keeps its place before the rows in the tab order.
  const headerActions = element('div', 'rio-grid__header-actions');
  headerActions.hidden = true;
  table.append(header, pinnedViewport, scroller, footer);
  container.append(headerActions, table, editorLayer, live, indicator);

  let width = 0;
  let height = 0;
  let containerHeight = 0;
  let layoutPins = -1;
  let scrollX = 0;
  let scrollY = 0;
  let prefix = prefixWidths(options.columns);
  let frozen = frozenCount(options.frozenColumnCount, options.columns.length);
  let xMap = createScrollMap(0, 0);
  let yMap = createScrollMap(0, 0);
  let frame = 0;
  let destroyed = false;
  let geometryDirty = true;
  let nativeDirty = true;
  let nativeWriteX: number | null = null;
  let nativeWriteY: number | null = null;
  let pendingNativeX: number | null = null;
  let dropSlot: number | null = null;
  let pendingCell: { cell: Partial<CellRef>; align: 'nearest' | 'center' | 'start' } | null = null;
  let ensureTimer: ReturnType<typeof setTimeout> | undefined;
  let ensureKey = '';
  let active: CellRef | null = null;
  /** The footer cell the keyboard is on.  While it's set, no cell is active. */
  let footerCol: number | null = null;
  let announceTimer: ReturnType<typeof setTimeout> | undefined;
  const selection = createSelectionState((value) => {
    if (!sameCell(active, value.active)) {
      active = value.active && { ...value.active };
      // Choosing a cell, with the pointer or through the host, takes the keyboard out of the footer.
      if (active) footerCol = null;
      if (active) positionCell(active, 'nearest');
      positionInput();
      clearTimeout(announceTimer);
      live.textContent = '';
      if (active) {
        const cell = { ...active };
        announceTimer = setTimeout(() => {
          if (!destroyed) live.textContent = host.describeCell?.(cell) ?? '';
        }, 150);
      }
    }
    renderer.invalidate();
    schedule();
    host.onSelectionChange?.(value);
  });
  const pinnedCount = () => Math.min(host.frozenRows?.() ?? 0, options.rowCount);
  const rowTop = (row: number) =>
    row < pinnedCount()
      ? row * options.rowHeight - pinnedScrollTop
      : pinnedHeight + (row - pinnedCount()) * options.rowHeight - scrollY;
  const renderer = createRenderer<Row>(header, viewport, selection, footer, headerActions, pinnedViewport);

  function schedule() {
    if (!destroyed && !frame) frame = requestAnimationFrame(draw);
  }

  /** Puts the keyboard on a footer cell, or takes it off the footer, and says where it is. */
  function setFooter(col: number | null) {
    if (col === footerCol) return;
    footerCol = col;
    renderer.invalidateFooter();
    clearTimeout(announceTimer);
    live.textContent = '';
    if (col !== null) {
      positionCell({ col }, 'nearest');
      announceTimer = setTimeout(() => {
        if (!destroyed && footerCol === col) live.textContent = host.describeFooter?.(col) ?? '';
      }, 150);
    }
    schedule();
  }

  const footerHooks = {
    active: () => footerCol,
    enter(col: number) {
      if (!options.showFooter || !options.columns.length) return;
      const target = clamp(col, 0, options.columns.length - 1);
      // No cell is active meanwhile, so typing can't start editing one.
      selection.set({ active: null, range: null, rows: { kind: 'none' } });
      setFooter(target);
    },
    move(col: number) {
      if (footerCol !== null && options.columns.length) setFooter(clamp(col, 0, options.columns.length - 1));
    },
    /** Back to the last row, in the same column */
    leave() {
      const col = footerCol;
      if (col === null) return;
      setFooter(null);
      if (!options.rowCount) return;
      const cell = { row: options.rowCount - 1, col };
      selection.select(cell);
      reveal(cell);
    },
    activate(col: number) {
      if (!options.showFooter || !options.columns[col]) return;
      if (!renderer.footerCell(col)) {
        // Draw the column now, so a menu has its cell to open against.
        positionCell({ col }, 'nearest');
        cancelAnimationFrame(frame);
        draw();
      }
      host.onFooterActivate?.(col, renderer.footerCell(col) ?? footer);
    },
  };

  function rebuild() {
    layoutPins = pinnedCount();
    prefix = prefixWidths(options.columns);
    frozen = frozenCount(
      options.frozenColumnCount,
      options.columns.length,
      prefix,
      width - (options.rowHeaderWidth ?? 64),
    );
    xMap = createScrollMap(
      (options.rowHeaderWidth ?? 64) + prefix[prefix.length - 1]! + (options.showAddColumn ? 40 : 0),
      width,
    );
    yMap = createScrollMap(
      (options.rowCount - pinnedCount() + (options.showAddRow ? 1 : 0)) * options.rowHeight,
      height,
    );
    // A smaller viewport can receive a native scroll before its resize is observed.  The old
    // map cannot represent that offset, so apply it only after rebuilding the horizontal range.
    if (!nativeDirty && pendingNativeX !== null) scrollX = xMap.toContent(pendingNativeX);
    pendingNativeX = null;
    scrollX = clamp(scrollX, 0, xMap.contentRange);
    scrollY = clamp(scrollY, 0, yMap.contentRange);
    nativeDirty = true;
  }

  function windowRanges(margin: boolean) {
    const rowHeader = options.rowHeaderWidth ?? 64;
    const frozenWidth = prefix[frozen]!;
    return {
      rows: visibleRows(
        options.rowCount + (options.showAddRow ? 1 : 0),
        options.rowHeight,
        scrollY + pinnedCount() * options.rowHeight,
        height,
        margin ? 2 : 0,
      ),
      columns: visibleColumns(
        prefix,
        frozenWidth + scrollX,
        Math.max(0, width - rowHeader - frozenWidth),
        margin ? 1 : 0,
        frozen,
      ),
      frozenColumns: visibleColumns(prefix, 0, Math.max(0, width - rowHeader), margin ? 1 : 0, 0, frozen),
    };
  }

  function syncNative() {
    if (!nativeDirty) return;
    nativeDirty = false;
    const nextX = inlineOffset(xMap.toNative(scrollX), options.direction ?? 'ltr');
    const nextY = yMap.toNative(scrollY);
    if (nativeWriteX !== nextX) {
      nativeWriteX = nextX;
      scroller.scrollLeft = nextX;
    }
    if (nativeWriteY !== nextY) {
      nativeWriteY = nextY;
      scroller.scrollTop = nextY;
    }
  }

  function requestRows() {
    const pins = pinnedCount();
    const visible = visibleRows(
      options.rowCount,
      options.rowHeight,
      scrollY + pinnedCount() * options.rowHeight,
      height,
    );
    const margin = Math.max(20, visible.end - visible.start);
    const start = Math.max(0, visible.start - margin);
    const end = Math.min(options.rowCount, visible.end + margin);
    const key = `${pins}:${start}:${end}`;
    if (key === ensureKey) return;
    ensureKey = key;
    clearTimeout(ensureTimer);
    if (pins || start < end)
      ensureTimer = setTimeout(() => {
        ensureTimer = undefined;
        if (destroyed) return;
        if (pins && start > 0) host.ensureRows(0, pins);
        if (start < end) host.ensureRows(start, end);
      }, 60);
  }

  function draw() {
    frame = 0;
    if (destroyed) return;
    if (geometryDirty) {
      geometryDirty = false;
      rebuild();
      table.setAttribute('role', options.treegrid ? 'treegrid' : 'grid');
      table.setAttribute('aria-label', options.label);
      table.setAttribute('aria-multiselectable', 'true');
      table.setAttribute('aria-readonly', String(!!options.readOnly));
      if (options.rowCount === 0 && !options.showAddRow) {
        scroller.tabIndex = 0;
        scroller.setAttribute('aria-label', options.label);
      } else {
        scroller.removeAttribute('tabindex');
        scroller.removeAttribute('aria-label');
      }
      // The header, the records, the add-record row while there is one, and the footer
      table.setAttribute(
        'aria-rowcount',
        String(
          options.rowCount +
            1 +
            Number(options.columns.some((column) => column.group)) +
            (options.showAddRow ? 1 : 0) +
            (options.showFooter ? 1 : 0),
        ),
      );
      table.setAttribute('aria-colcount', String(options.columns.length));
      container.dir = options.direction ?? 'ltr';
      input.setAttribute('aria-label', options.label);
      header.style.blockSize = `${options.headerHeight ?? 32}px`;
      header.style.inlineSize = `${width}px`;
      pinnedHeight = Math.min(
        pinnedCount() * options.rowHeight,
        Math.max(
          0,
          (containerHeight -
            (options.headerHeight ?? 32) -
            (options.showFooter ? (options.footerHeight ?? 32) : 0)) *
            0.4,
        ),
      );
      pinnedViewport.hidden = !pinnedCount();
      pinnedViewport.style.insetBlockStart = `${options.headerHeight ?? 32}px`;
      pinnedViewport.style.blockSize = `${pinnedHeight}px`;
      pinnedViewport.style.inlineSize = `${width}px`;
      scroller.style.insetBlockStart = `${(options.headerHeight ?? 32) + pinnedHeight}px`;
      editorLayer.style.insetBlockStart = `${options.headerHeight ?? 32}px`;
      editorLayer.style.inlineSize = `${width}px`;
      editorLayer.style.blockSize = `${height + pinnedHeight}px`;
      // The rows end where the footer starts, and the scroller's new size redraws them.
      const footerHeight = options.showFooter ? (options.footerHeight ?? 32) : 0;
      footer.hidden = !options.showFooter;
      footer.style.blockSize = `${footerHeight}px`;
      footer.style.inlineSize = `${width}px`;
      scroller.style.insetBlockEnd = `${footerHeight}px`;
      spacer.style.inlineSize = `${xMap.nativeSize}px`;
      spacer.style.blockSize = `${yMap.nativeSize}px`;
      viewport.style.inlineSize = `${width}px`;
      viewport.style.blockSize = `${height}px`;
      if (pendingCell && height > 0 && width > 0) {
        const pending = pendingCell;
        pendingCell = null;
        positionCell(pending.cell, pending.align);
      }
    }
    syncNative();
    if (width > 0 && height > 0) {
      renderer.draw({
        options,
        width,
        height,
        scrollX,
        scrollY,
        prefix,
        frozen,
        footerActive: footerCol,
        ...windowRanges(true),
      });
      requestRows();
    }
    positionInput();
    fill.position();
    indicator.hidden = dropSlot === null;
    if (dropSlot !== null) {
      const x = (options.rowHeaderWidth ?? 64) + prefix[dropSlot]! - (dropSlot > frozen ? scrollX : 0);
      indicator.style.transform = `translateX(${inlineOffset(clamp(x, 0, width - 2), options.direction ?? 'ltr')}px)`;
    }
  }

  function positionInput() {
    const cell = selection.active();
    // The scrolling rows keep clear of the pane above them.  A pinned cell the pane cuts off, in part
    // or in whole, keeps its sink, editor, and error tip inside the pane instead of letting them cover
    // those rows, while one the pane shows in full keeps the room below it, where an error tip goes.
    let clip = `inset(${pinnedHeight}px 0px 0px 0px)`;
    if (cell && cell.row < pinnedCount()) {
      const top = rowTop(cell.row);
      clip =
        top < 0 || top + options.rowHeight > pinnedHeight ? `inset(0px 0px ${height}px 0px)` : 'inset(0px)';
    }
    editorClip.style.clipPath = clip;
    editor.position(
      cell && options.columns[cell.col]
        ? {
            inline: (options.rowHeaderWidth ?? 64) + prefix[cell.col]! - (cell.col >= frozen ? scrollX : 0),
            top: rowTop(cell.row),
            width: options.columns[cell.col]!.width,
            height: options.rowHeight,
          }
        : null,
    );
  }

  function positionCell(cell: Partial<CellRef>, align: 'nearest' | 'center' | 'start') {
    nativeDirty = true;
    if (
      cell.row !== undefined &&
      cell.row >= pinnedCount() &&
      options.rowCount + (options.showAddRow ? 1 : 0) > 0
    ) {
      const row = clamp(Math.floor(cell.row), 0, options.rowCount - (options.showAddRow ? 0 : 1));
      const inset = Math.max(0, (host.rowTree?.(row)?.level ?? 1) - 1) * options.rowHeight;
      scrollY = clamp(
        alignScroll(
          scrollY + inset,
          (row - pinnedCount()) * options.rowHeight,
          options.rowHeight,
          Math.max(options.rowHeight, height - inset),
          align,
        ) - inset,
        0,
        yMap.contentRange,
      );
    }
    if (cell.row !== undefined && cell.row < pinnedCount()) {
      pinnedScrollTop = clamp(
        alignScroll(pinnedScrollTop, cell.row * options.rowHeight, options.rowHeight, pinnedHeight, align),
        0,
        Math.max(0, pinnedCount() * options.rowHeight - pinnedHeight),
      );
      pinnedViewport.scrollTop = pinnedScrollTop;
    }
    if (cell.col !== undefined && options.columns.length > 0) {
      const col = clamp(Math.floor(cell.col), 0, options.columns.length - 1);
      if (col >= frozen) {
        const frozenWidth = prefix[frozen]!;
        const available = Math.max(0, width - (options.rowHeaderWidth ?? 64) - frozenWidth);
        scrollX = clamp(
          alignScroll(scrollX, prefix[col]! - frozenWidth, options.columns[col]!.width, available, align),
          0,
          xMap.contentRange,
        );
      }
    }
  }

  const events = new AbortController();
  function rememberNativeX(nativeX: number) {
    const logicalNative = inlineOffset(nativeX, options.direction ?? 'ltr');
    pendingNativeX = logicalNative > xMap.nativeRange + 1 ? logicalNative : null;
  }
  scroller.addEventListener(
    'scroll',
    () => {
      const nativeX = scroller.scrollLeft;
      const nativeY = scroller.scrollTop;
      rememberNativeX(nativeX);
      // Native offsets are rounded by some engines; that rounding must not erase fractional wheel input.
      if (nativeWriteX === null || Math.abs(nativeX - nativeWriteX) > 1) {
        scrollX = xMap.toContent(inlineOffset(nativeX, options.direction ?? 'ltr'));
      }
      if (nativeWriteY === null || Math.abs(nativeY - nativeWriteY) > 1) {
        scrollY = yMap.toContent(nativeY);
      }
      nativeWriteX = null;
      nativeWriteY = null;
      schedule();
    },
    { signal: events.signal, passive: true },
  );

  container.addEventListener(
    'wheel',
    (event) => {
      if (event.target instanceof Node && pinnedViewport.contains(event.target)) return;
      if (event.ctrlKey || event.defaultPrevented || (event.target === input && editor.isEditing())) return;
      if (
        xMap.scale === 1 &&
        yMap.scale === 1 &&
        event.target instanceof Node &&
        scroller.contains(event.target)
      )
        return;
      const unitX = event.deltaMode === 1 ? options.rowHeight : event.deltaMode === 2 ? width : 1;
      const unitY = event.deltaMode === 1 ? options.rowHeight : event.deltaMode === 2 ? height : 1;
      const dx = event.shiftKey && event.deltaX === 0 ? event.deltaY * unitX : event.deltaX * unitX;
      const dy = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY * unitY;
      const nextX = clamp(scrollX + inlineOffset(dx, options.direction ?? 'ltr'), 0, xMap.contentRange);
      const nextY = clamp(scrollY + dy, 0, yMap.contentRange);
      if (nextX === scrollX && nextY === scrollY) return;
      event.preventDefault();
      scrollX = nextX;
      scrollY = nextY;
      nativeDirty = true;
      schedule();
    },
    { signal: events.signal, passive: false },
  );

  const observer = new ResizeObserver(() => {
    // All size reads happen after layout, never in a scroll handler or drawing pass.
    const nextWidth = scroller.clientWidth;
    const nextHeight = scroller.clientHeight;
    const nextContainerHeight = container.clientHeight;
    if (nextWidth === width && nextHeight === height && nextContainerHeight === containerHeight) return;
    if (!nativeDirty) rememberNativeX(scroller.scrollLeft);
    containerHeight = nextContainerHeight;
    width = nextWidth;
    height = nextHeight;
    geometryDirty = true;
    schedule();
  });
  observer.observe(container);
  observer.observe(scroller);
  pinnedViewport.addEventListener(
    'scroll',
    () => {
      pinnedScrollTop = pinnedViewport.scrollTop;
      positionInput();
      fill.position();
    },
    { signal: events.signal, passive: true },
  );

  const interaction = createInteraction(container, {
    metrics: () => ({
      columns: options.columns,
      prefix,
      frozen,
      rowHeader: options.rowHeaderWidth ?? 64,
      scrollX,
      direction: options.direction ?? 'ltr',
    }),
    resize(index, width, final) {
      const column = options.columns[index];
      if (!column) return;
      options.columns = options.columns.map((item, col) => (col === index ? { ...item, width } : item));
      geometryDirty = true;
      rebuild();
      schedule();
      host.onColumnResize?.(column.id, width, final);
    },
    move(from, to) {
      const columns = [...options.columns];
      const [column] = columns.splice(from, 1);
      if (!column) return;
      columns.splice(to, 0, column);
      options.columns = columns;
      renderer.invalidate();
      geometryDirty = true;
      rebuild();
      schedule();
      host.onColumnMove?.(column.id, to);
    },
    indicator(slot) {
      dropSlot = slot;
      schedule();
    },
    activate: (index, anchor) => host.onHeaderActivate?.(index, anchor),
    add() {
      if (!options.readOnly) host.onAddRow?.();
    },
    addColumn() {
      if (options.showAddColumn && !options.readOnly) host.onAddColumn?.();
    },
  });

  function columnAt(x: number): number | null {
    if (!options.columns.length) return null;
    const rect = viewport.getBoundingClientRect();
    let inline =
      logicalPoint(x, rect.left, width, options.direction ?? 'ltr') - (options.rowHeaderWidth ?? 64);
    if (inline >= prefix[frozen]!) inline += scrollX;
    const col = visibleColumns(prefix, Math.max(0, inline), 1).start;
    return clamp(col, 0, options.columns.length - 1);
  }

  function hit(x: number, y: number, originRow?: number): CellRef | null {
    const col = columnAt(x);
    if (!options.rowCount || col === null) return null;
    const rect = viewport.getBoundingClientRect();
    if (originRow !== undefined && originRow >= pinnedCount()) y = Math.max(y, rect.top);
    return {
      row: clamp(
        Math.floor(
          (y < rect.top
            ? y - rect.top + pinnedHeight + pinnedScrollTop
            : y - rect.top + scrollY + pinnedCount() * options.rowHeight) / options.rowHeight,
        ),
        0,
        options.rowCount - 1,
      ),
      col,
    };
  }

  const dropHint = element('div', 'rio-grid__drag-hint');
  dropHint.hidden = true;
  container.append(dropHint);
  function bodyBounds() {
    const bounds = viewport.getBoundingClientRect();
    return new DOMRect(bounds.left, bounds.top - pinnedHeight, bounds.width, bounds.height + pinnedHeight);
  }
  const scrollBounds = () => viewport.getBoundingClientRect();
  const canScrollVertically = (originRow: number) => originRow >= pinnedCount();
  const drag = createDrag(container, {
    direction: () => options.direction ?? 'ltr',
    instructions: (kind, index) => host.dragMessage?.('start', kind, index) ?? options.label,
    focus: () => input.focus({ preventScroll: true }),
    bounds: bodyBounds,
    scrollBounds,
    scroll: scrollBy,
    canScrollVertically,
    reveal(kind, index) {
      positionCell(kind === 'row' ? { row: index } : { col: index }, 'nearest');
      schedule();
    },
    count: (kind) => (kind === 'row' ? options.rowCount : options.columns.length),
    hit(kind, x, y, from) {
      // Outside the grid there's no target, so the preview clears and a release cancels the move.
      // A column moves inside the header band, a record inside the rows and the pinned pane.
      const box = kind === 'column' ? header.getBoundingClientRect() : bodyBounds();
      if (x < box.left || x >= box.right || y < box.top || y >= box.bottom) return null;
      if (kind === 'column') return columnAt(x);
      const cell = hit(x, y, from);
      return cell?.row ?? null;
    },
    outside(kind, from) {
      dropSlot = null;
      const text = host.dragMessage?.('outside', kind, from) ?? '';
      dropHint.hidden = !text;
      dropHint.textContent = text;
      clearTimeout(announceTimer);
      live.textContent = text;
      schedule();
    },
    reason(kind, from, to) {
      if (kind === 'column')
        return host.columnDropReason
          ? host.columnDropReason(from, to)
          : options.readOnly || from < frozen !== to < frozen
            ? ''
            : null;
      return host.rowDropReason?.(from, to) ?? (options.readOnly || !host.onRowMove ? '' : null);
    },
    move(kind, from, to) {
      if (kind === 'column') {
        const columns = [...options.columns];
        const [column] = columns.splice(from, 1);
        if (!column) return;
        columns.splice(to, 0, column);
        options.columns = columns;
        renderer.invalidate();
        geometryDirty = true;
        rebuild();
        schedule();
        host.onColumnMove?.(column.id, to);
      } else host.onRowMove?.(from, to);
    },
    preview(kind, to, reason, from = 0) {
      dropSlot = kind === 'column' && reason === null && to !== null ? (to > from ? to + 1 : to) : null;
      dropHint.hidden = to === null;
      dropHint.textContent = reason || (to === null ? '' : (host.dragMessage?.('target', kind, to) ?? ''));
      schedule();
    },
    announce(state, kind, index, reason) {
      clearTimeout(announceTimer);
      live.textContent = reason ?? host.dragMessage?.(state, kind, index) ?? '';
    },
  });
  container.addEventListener(
    'keydown',
    (event) => {
      if (event.defaultPrevented) return;
      // Empty scroll regions need explicit arrow scrolling across browsers.
      if (
        event.target === scroller &&
        options.rowCount === 0 &&
        !options.showAddRow &&
        !event.isComposing &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      ) {
        event.preventDefault();
        scrollBy(event.key === 'ArrowLeft' ? -40 : 40, 0);
        return;
      }
      const heading =
        event.target instanceof HTMLElement && event.target.matches('[data-rio-column]')
          ? event.target
          : null;
      if (
        (event.target === input && !editor.isEditing() && event.altKey && event.key === 'ArrowUp') ||
        (heading && ['ArrowLeft', 'ArrowRight'].includes(event.key))
      ) {
        event.preventDefault();
        const delta = heading
          ? (event.key === 'ArrowLeft' ? -1 : 1) * (options.direction === 'rtl' ? -1 : 1)
          : 0;
        const col = clamp(
          (heading ? Number(heading.dataset.rioColumn) : (selection.active()?.col ?? 0)) + delta,
          0,
          options.columns.length - 1,
        );
        positionCell({ col }, 'nearest');
        cancelAnimationFrame(frame);
        draw();
        renderer.headerCell(col)?.focus({ preventScroll: true });
        return;
      }
      if (heading && event.key === 'ArrowUp') {
        const group = options.columns[Number(heading.dataset.rioColumn)]?.group;
        if (group) {
          event.preventDefault();
          renderer.groupButton(group.id)?.focus({ preventScroll: true });
        }
        return;
      }
      const groupButton =
        event.target instanceof HTMLElement && event.target.matches('[data-rio-column-group]')
          ? event.target
          : null;
      if (groupButton && (event.key === 'ArrowDown' || event.key === 'Escape')) {
        event.preventDefault();
        const col = Number(groupButton.parentElement?.getAttribute('aria-colindex')) - 1;
        renderer.headerCell(col)?.focus({ preventScroll: true });
        return;
      }
      if (heading && (event.key === 'ArrowDown' || event.key === 'Escape')) {
        event.preventDefault();
        input.focus({ preventScroll: true });
        return;
      }
      if (
        event.key !== 'Enter' ||
        !(event.target instanceof HTMLElement) ||
        !event.target.matches('[data-rio-column]')
      )
        return;
      event.preventDefault();
      host.onHeaderActivate?.(Number(event.target.dataset.rioColumn), event.target);
    },
    { signal: events.signal },
  );
  container.addEventListener(
    'click',
    (event) => {
      const button =
        event.target instanceof Element ? event.target.closest<HTMLElement>('[data-rio-column-group]') : null;
      if (button) host.onColumnGroupToggle?.(button.dataset.rioColumnGroup!);
      const heading =
        event.target instanceof Element ? event.target.closest<HTMLElement>('[data-rio-column]') : null;
      if (heading && !button && event.detail === 1)
        host.onHeaderActivate?.(Number(heading.dataset.rioColumn), heading);
    },
    { signal: events.signal },
  );

  function scrollBy(dx: number, dy: number) {
    scrollX = clamp(scrollX + inlineOffset(dx, options.direction ?? 'ltr'), 0, xMap.contentRange);
    scrollY = clamp(scrollY + dy, 0, yMap.contentRange);
    nativeDirty = true;
    schedule();
  }

  /** Where a column's cells start showing: frozen columns never scroll under anything. */
  function edge(col: number): number {
    return (options.rowHeaderWidth ?? 64) + (col >= frozen ? prefix[frozen]! : 0);
  }

  /** A block of cells in body pixels, from the start edge and the top of the first row. */
  function rangeRect(range: CellRange) {
    const x = (col: number) => (options.rowHeaderWidth ?? 64) + prefix[col]! - (col >= frozen ? scrollX : 0);
    const last = options.columns[range.end.col];
    if (!last || !options.columns[range.start.col]) return null;
    const inline = Math.max(x(range.start.col), edge(range.start.col));
    return {
      inline,
      top: rowTop(range.start.row),
      width: Math.max(0, x(range.end.col) + last.width - inline),
      height: rowTop(range.end.row) - rowTop(range.start.row) + options.rowHeight,
    };
  }

  function reveal(cell: CellRef, immediate = true) {
    positionCell(cell, 'nearest');
    if (immediate) {
      cancelAnimationFrame(frame);
      draw();
    } else schedule();
    return renderer.cell(cell);
  }

  const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const editor = createEditing(
    input,
    error,
    {
      options: () => options,
      active: selection.active,
      select: (cell) => selection.select(cell),
      reveal,
      move: (motion) => cells.move(motion),
      invalidate(cell) {
        renderer.invalidate(cell.row, cell.row + 1);
        // Echo only the committed cell now; full layout and neighboring cells stay batched.
        renderer.redrawCell(cell, options);
        schedule();
      },
      schedule,
    },
    mac,
  );
  const cells = createCellInteraction(
    container,
    input,
    selection,
    editor,
    {
      options: () => options,
      pageRows: () => Math.max(1, Math.floor(height / options.rowHeight)),
      reveal,
      bounds: bodyBounds,
      scrollBounds,
      canScrollVertically,
      hit,
      scroll: scrollBy,
      invalidate() {
        renderer.invalidate();
        schedule();
      },
      footer: footerHooks,
    },
    mac,
  );

  const fill = createFill(editorLayer, {
    options: () => options,
    range: selection.range,
    active: selection.active,
    hit,
    rect: rangeRect,
    edge,
    size: () => ({ width, height: height + pinnedHeight }),
    bounds: bodyBounds,
    scrollBounds,
    canScrollVertically,
    topEdge: (row) => (row < pinnedCount() ? 0 : pinnedHeight),
    bottomEdge: (row) => (row < pinnedCount() ? pinnedHeight : height + pinnedHeight),
    scroll: scrollBy,
    select(range, cell) {
      if (editor.stop(true)) selection.set({ active: cell, range, rows: { kind: 'none' } });
    },
    editing: editor.isEditing,
  });

  schedule();

  return {
    update(next, mapRow) {
      if (destroyed) return;
      if (next.columns || (next.rowCount !== undefined && !mapRow) || next.readOnly)
        editor.stop(false, false);
      else if (mapRow) editor.remapRow(mapRow);
      const changed = (key: keyof typeof next) => next[key] !== undefined && next[key] !== options[key];
      const pinsChanged = layoutPins !== pinnedCount();
      const columnsChanged =
        next.columns !== undefined &&
        (next.columns.length !== options.columns.length ||
          next.columns.some((column, index) => column !== options.columns[index]));
      // Rows show these: which records and columns sit where, the tree's levels, whether controls
      // inside a row can change anything, and the grid's shape, which is rare enough to redraw for.
      // The grid's name, its built-in labels, and its add and footer rows don't change a row, so
      // they, or settings that match what the grid has, leave the rows as they are.
      const rowsChanged =
        pinsChanged ||
        columnsChanged ||
        mapRow !== undefined ||
        (
          [
            'rowCount',
            'rowHeight',
            'headerHeight',
            'frozenColumnCount',
            'direction',
            'rowHeaderWidth',
            'treegrid',
            'readOnly',
          ] as const
        ).some(changed);
      const footerChanged = (['showFooter', 'footerHeight'] as const).some(changed);
      const geometryChanged =
        rowsChanged || footerChanged || (['showAddRow', 'showAddColumn', 'label'] as const).some(changed);
      options = { ...options, ...next, columns: [...(next.columns ?? options.columns)], host };
      if (mapRow) {
        const previous = selection.get();
        const cell = (value: CellRef | null): CellRef | null => {
          const row = value && mapRow(value.row);
          return value && row !== null ? { ...value, row } : null;
        };
        const start = cell(previous.range?.start ?? null);
        const end = cell(previous.range?.end ?? null);
        selection.set({
          active: cell(previous.active),
          range: start && end ? { start, end } : null,
          rows:
            previous.rows.kind === 'some'
              ? { kind: 'some', rows: new Set([...previous.rows.rows].flatMap((row) => mapRow(row) ?? [])) }
              : previous.rows,
        });
      }
      const current = selection.active();
      if (current && (!options.rowCount || !options.columns.length))
        selection.set({ active: null, range: null, rows: { kind: 'none' } });
      else if (current && (current.row >= options.rowCount || current.col >= options.columns.length))
        selection.select({
          row: Math.min(current.row, options.rowCount - 1),
          col: Math.min(current.col, options.columns.length - 1),
        });
      if (footerCol !== null && (!options.showFooter || !options.columns.length)) setFooter(null);
      else if (footerCol !== null && footerCol >= options.columns.length)
        setFooter(options.columns.length - 1);
      if (geometryChanged) {
        geometryDirty = true;
        ensureKey = '';
        rebuild();
      }
      if (rowsChanged) renderer.invalidate();
      else if (footerChanged) renderer.invalidateFooter();
      schedule();
    },
    rowsChanged(start, end) {
      if (destroyed) return;
      if (layoutPins !== pinnedCount()) geometryDirty = true;
      renderer.invalidate(start, end);
      const visible = windowRanges(true).rows;
      if (
        geometryDirty ||
        (start ?? 0) < pinnedCount() ||
        ((start ?? 0) < visible.end && (end ?? Infinity) > visible.start)
      )
        schedule();
    },
    runShortcut: (id) => cells.runShortcut(id),
    footerChanged() {
      if (destroyed || !options.showFooter) return;
      renderer.invalidateFooter();
      schedule();
    },
    scrollToCell(cell, align = 'nearest') {
      if (destroyed) return;
      if (width === 0 || height === 0) pendingCell = { cell: { ...cell }, align };
      else positionCell(cell, align);
      schedule();
    },
    getSelection: selection.get,
    setSelection(value) {
      if (!destroyed && editor.stop(true)) selection.set(value);
    },
    setDecorations(decorations) {
      if (destroyed) return;
      renderer.setDecorations(decorations);
      schedule();
    },
    startEditing(cell, initialText) {
      if (!destroyed) editor.start(cell, initialText);
    },
    stopEditing(commit) {
      if (!destroyed) editor.stop(commit);
    },
    isEditing: editor.isEditing,
    focus() {
      if (!destroyed) cells.focus();
    },
    getVisibleRange(): VisibleRange {
      const { rows, columns } = windowRanges(false);
      return {
        firstRow: Math.min(rows.start, options.rowCount),
        lastRow: Math.min(rows.end, options.rowCount),
        firstCol: columns.start,
        lastCol: columns.end,
      };
    },
    anchorRow: () =>
      clamp(Math.ceil(scrollY / options.rowHeight) + pinnedCount(), 0, Math.max(0, options.rowCount - 1)),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(frame);
      clearTimeout(ensureTimer);
      clearTimeout(announceTimer);
      editor.destroy();
      fill.destroy();
      cells.destroy();
      observer.disconnect();
      events.abort();
      interaction.destroy();
      drag.destroy();
      renderer.setDecorations([]);
      table.remove();
      headerActions.remove();
      editorLayer.remove();
      live.remove();
      indicator.remove();
      dropHint.remove();
      if (!hadClass) container.classList.remove('rio-grid');
      if (previousDirection === null) container.removeAttribute('dir');
      else container.setAttribute('dir', previousDirection);
    },
  };
}
