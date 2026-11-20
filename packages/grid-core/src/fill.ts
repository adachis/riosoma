import { element } from './render.js';
import type { CellRange, CellRef, FillDirection, FillRequest, GridOptions } from './types.js';

/** Where a block of cells sits in the body, in pixels from its start edge and top. */
export interface CellRect {
  inline: number;
  top: number;
  width: number;
  height: number;
}

export interface FillHooks<Row> {
  options(): GridOptions<Row>;
  /** The selected block, read on every frame, so it mustn't copy a row selection */
  range(): CellRange | null;
  active(): CellRef | null;
  /** The cell under a viewport point, clamped into the grid */
  hit(x: number, y: number, originRow?: number): CellRef | null;
  /** Where a range's cells are drawn, or null when none of it is on screen */
  rect(range: CellRange): CellRect | null;
  /** Where a column's cells start showing: after the row headers, and after frozen columns for the rest */
  edge(col: number): number;
  topEdge?(row: number): number;
  /** Where a row's cells stop showing, which for a pinned row is the bottom of its own pane */
  bottomEdge?(row: number): number;
  /** The body's size, for keeping the handle and outline inside it */
  size(): { width: number; height: number };
  bounds(): DOMRect;
  scrollBounds?(): DOMRect;
  scroll(dx: number, dy: number): void;
  canScrollVertically?(originRow: number): boolean;
  /** Selects the filled block once a drag lands */
  select(range: CellRange, active: CellRef): void;
  editing(): boolean;
}

/** How long a second tap may wait and still count as a double tap. */
const DOUBLE_TAP_MS = 350;
/** How far the pointer moves before a press on the handle becomes a drag. */
const DRAG_SLOP = 4;

function union(a: CellRange, b: CellRange): CellRange {
  return {
    start: { row: Math.min(a.start.row, b.start.row), col: Math.min(a.start.col, b.start.col) },
    end: { row: Math.max(a.end.row, b.end.row), col: Math.max(a.end.col, b.end.col) },
  };
}

/**
 * The block a drag to `cell` fills next to `source`, along whichever axis the pointer has gone
 * further past the source, or null while it's still inside.  Columns count in column order, so
 * `right` means later columns in both directions of text.
 */
export function dragTarget(
  source: CellRange,
  cell: CellRef,
): { target: CellRange; direction: FillDirection } | null {
  const below = cell.row - source.end.row;
  const above = source.start.row - cell.row;
  const after = cell.col - source.end.col;
  const before = source.start.col - cell.col;
  const rows = Math.max(below, above, 0);
  const cols = Math.max(after, before, 0);
  if (rows === 0 && cols === 0) return null;
  if (rows >= cols) {
    return below > 0
      ? {
          direction: 'down',
          target: {
            start: { row: source.end.row + 1, col: source.start.col },
            end: { row: cell.row, col: source.end.col },
          },
        }
      : {
          direction: 'up',
          target: {
            start: { row: cell.row, col: source.start.col },
            end: { row: source.start.row - 1, col: source.end.col },
          },
        };
  }
  return after > 0
    ? {
        direction: 'right',
        target: {
          start: { row: source.start.row, col: source.end.col + 1 },
          end: { row: source.end.row, col: cell.col },
        },
      }
    : {
        direction: 'left',
        target: {
          start: { row: source.start.row, col: cell.col },
          end: { row: source.end.row, col: source.start.col - 1 },
        },
      };
}

/**
 * Ctrl+D and Ctrl+R, as spreadsheets have them: the first row (or column) of the selection is
 * copied into the rest of it, and a selection one row tall (or one column wide) copies the row
 * above (or the column before) into itself.
 */
export function keyboardFill(range: CellRange | null, direction: 'down' | 'right'): FillRequest | null {
  if (!range) return null;
  if (direction === 'down') {
    if (range.end.row > range.start.row)
      return {
        source: { start: range.start, end: { row: range.start.row, col: range.end.col } },
        target: { start: { row: range.start.row + 1, col: range.start.col }, end: range.end },
        direction,
        copy: true,
      };
    if (range.start.row === 0) return null;
    return {
      source: {
        start: { row: range.start.row - 1, col: range.start.col },
        end: { row: range.start.row - 1, col: range.end.col },
      },
      target: range,
      direction,
      copy: true,
    };
  }
  if (range.end.col > range.start.col)
    return {
      source: { start: range.start, end: { row: range.end.row, col: range.start.col } },
      target: { start: { row: range.start.row, col: range.start.col + 1 }, end: range.end },
      direction,
      copy: true,
    };
  if (range.start.col === 0) return null;
  return {
    source: {
      start: { row: range.start.row, col: range.start.col - 1 },
      end: { row: range.end.row, col: range.start.col - 1 },
    },
    target: range,
    direction,
    copy: true,
  };
}

interface Drag {
  pointer: number;
  source: CellRange;
  active: CellRef;
  startX: number;
  startY: number;
  x: number;
  y: number;
  moved: boolean;
  fill: { target: CellRange; direction: FillDirection } | null;
}

/**
 * The fill handle: a small square at the end corner of the selected block.  Dragging it with a
 * mouse, pen, or finger outlines the block it will fill, and letting go asks the host to fill it.
 * A double click or double tap asks the host to fill down as far as the next column's records go.
 * The grid only reports where, and the host decides the values.
 */
export function createFill<Row>(layer: HTMLElement, hooks: FillHooks<Row>) {
  const handle = element('div', 'rio-grid__fill-handle');
  handle.setAttribute('aria-hidden', 'true');
  handle.hidden = true;
  const outline = element('div', 'rio-grid__fill-outline');
  outline.setAttribute('aria-hidden', 'true');
  outline.hidden = true;
  layer.append(outline, handle);
  const events = new AbortController();
  const listener = { signal: events.signal };
  let drag: Drag | null = null;
  let frame = 0;
  let lastTap = -Infinity;

  function place(node: HTMLElement, rect: CellRect) {
    // Clamped just past the body's edges, so a block taller than the screen keeps its sides off it.
    const { width, height } = hooks.size();
    const top = Math.max(rect.top, -8);
    const bottom = Math.min(rect.top + rect.height, height + 8);
    const start = Math.max(rect.inline, -8);
    const end = Math.min(rect.inline + rect.width, width + 8);
    node.style.insetInlineStart = `${start}px`;
    node.style.insetBlockStart = `${top}px`;
    node.style.inlineSize = `${Math.max(0, end - start)}px`;
    node.style.blockSize = `${Math.max(0, bottom - top)}px`;
  }

  function position() {
    const options = hooks.options();
    const range = drag?.source ?? hooks.range();
    const rect = range && hooks.rect(range);
    const { width, height } = hooks.size();
    const corner = rect && { inline: rect.inline + rect.width, top: rect.top + rect.height };
    // A pinned pane the person has scrolled keeps its handle and its outline inside itself, so
    // neither covers the scrolling rows below the block they've scrolled out of.
    const inside =
      !!range &&
      !!corner &&
      corner.top >= (hooks.topEdge?.(range.end.row) ?? 0) &&
      corner.top <= (hooks.bottomEdge?.(range.end.row) ?? height);
    const visible =
      !options.readOnly &&
      !!options.host.fill &&
      !hooks.editing() &&
      inside &&
      !!corner &&
      !!range &&
      corner.inline > hooks.edge(range.end.col) &&
      corner.inline <= width;
    handle.hidden = !visible;
    if (visible && corner) {
      handle.style.insetInlineStart = `${corner.inline}px`;
      handle.style.insetBlockStart = `${corner.top}px`;
    }
    const fill = drag?.fill;
    const block = drag && fill && inside ? hooks.rect(union(drag.source, fill.target)) : null;
    outline.hidden = !block;
    if (block) place(outline, block);
  }

  function track(x: number, y: number) {
    if (!drag) return;
    drag.x = x;
    drag.y = y;
    drag.moved ||= Math.abs(x - drag.startX) + Math.abs(y - drag.startY) >= DRAG_SLOP;
    if (!drag.moved) return;
    const bounds = hooks.bounds();
    const cell = hooks.hit(
      Math.max(bounds.left, Math.min(bounds.right - 1, x)),
      Math.max(bounds.top, Math.min(bounds.bottom - 1, y)),
      drag.source.start.row,
    );
    drag.fill = cell ? dragTarget(drag.source, cell) : null;
    position();
  }

  function autoScroll() {
    frame = 0;
    if (!drag) return;
    if (drag.moved) {
      const bounds = hooks.scrollBounds?.() ?? hooks.bounds();
      const speed = (point: number, start: number, end: number) =>
        point < start + 28
          ? -Math.min(32, (start + 28 - point) / 2)
          : point > end - 28
            ? Math.min(32, (point - end + 28) / 2)
            : 0;
      const dx = speed(drag.x, bounds.left, bounds.right);
      const dy =
        hooks.canScrollVertically?.(drag.source.start.row) === false
          ? 0
          : speed(drag.y, bounds.top, bounds.bottom);
      if (dx || dy) {
        hooks.scroll(dx, dy);
        track(drag.x, drag.y);
      }
    }
    frame = requestAnimationFrame(autoScroll);
  }

  function finish(event: PointerEvent | null, canceled: boolean) {
    const finished = drag;
    if (!finished || (event && event.pointerId !== finished.pointer)) return;
    drag = null;
    cancelAnimationFrame(frame);
    frame = 0;
    if (handle.hasPointerCapture(finished.pointer)) handle.releasePointerCapture(finished.pointer);
    position();
    if (canceled) return;
    const host = hooks.options().host;
    if (!finished.moved) {
      // Two presses on the handle without a drag fill down, as a double click does in a spreadsheet.
      const now = performance.now();
      if (now - lastTap < DOUBLE_TAP_MS) {
        lastTap = -Infinity;
        host.fill?.({ source: finished.source, target: null, direction: 'down', copy: !!event?.altKey });
      } else lastTap = now;
      return;
    }
    lastTap = -Infinity;
    if (!finished.fill) return;
    host.fill?.({
      source: finished.source,
      target: finished.fill.target,
      direction: finished.fill.direction,
      copy: !!event?.altKey,
    });
    hooks.select(union(finished.source, finished.fill.target), finished.active);
  }

  handle.addEventListener(
    'pointerdown',
    (event) => {
      const range = hooks.range();
      const active = hooks.active();
      // The grid underneath must not start a selection from this press.
      event.preventDefault();
      event.stopPropagation();
      if (event.button !== 0 || drag || !range || !active) return;
      if (hooks.options().readOnly || hooks.editing()) return;
      drag = {
        pointer: event.pointerId,
        source: range,
        active,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        moved: false,
        fill: null,
      };
      handle.setPointerCapture(event.pointerId);
      frame = requestAnimationFrame(autoScroll);
    },
    listener,
  );
  handle.addEventListener(
    'pointermove',
    (event) => {
      if (drag?.pointer === event.pointerId) track(event.clientX, event.clientY);
    },
    listener,
  );
  handle.addEventListener('pointerup', (event) => finish(event, false), listener);
  handle.addEventListener('pointercancel', (event) => finish(event, true), listener);
  handle.addEventListener('lostpointercapture', (event) => finish(event, true), listener);
  layer.ownerDocument.addEventListener(
    'keydown',
    (event) => {
      if (drag && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(null, true);
      }
    },
    { ...listener, capture: true },
  );

  return {
    position,
    dragging: () => drag !== null,
    destroy() {
      events.abort();
      cancelAnimationFrame(frame);
      drag = null;
      handle.remove();
      outline.remove();
    },
  };
}
