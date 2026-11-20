import { keyboardFill } from './fill.js';
import { keyCommand, moveCell, platformModifier, searchCommand } from './keyboard.js';
import { gridShortcutEvent, type GridShortcutId } from './shortcuts.js';
import type { Motion } from './keyboard.js';
import type { createEditing } from './editing.js';
import { sameCell } from './selection.js';
import type { createSelectionState } from './selection.js';
import type { CellRef, ContextTarget, GridOptions } from './types.js';

/** The footer row, which the keyboard reaches with the down arrow from the last row. */
export interface FooterHooks {
  /** The footer cell the keyboard is on, or null */
  active(): number | null;
  enter(col: number): void;
  move(col: number): void;
  /** Back up to the last row, in the same column */
  leave(): void;
  activate(col: number): void;
}

interface CellHooks<Row> {
  options(): GridOptions<Row>;
  pageRows(): number;
  reveal(cell: CellRef, immediate?: boolean): HTMLElement | null;
  hit(x: number, y: number, originRow?: number): CellRef | null;
  bounds(): DOMRect;
  scrollBounds?(): DOMRect;
  scroll(dx: number, dy: number): void;
  canScrollVertically?(originRow: number): boolean;
  invalidate(): void;
  footer?: FooterHooks;
}

export function createCellInteraction<Row>(
  container: HTMLElement,
  input: HTMLTextAreaElement,
  selection: ReturnType<typeof createSelectionState>,
  editor: ReturnType<typeof createEditing<Row>>,
  hooks: CellHooks<Row>,
  mac: boolean,
) {
  const events = new AbortController();
  const listener = { signal: events.signal };
  let drag: { id: number; x: number; y: number; row: boolean; originRow: number } | null = null;
  let dragFrame = 0;
  let touch: {
    id: number;
    x: number;
    y: number;
    target: ContextTarget;
    moved: boolean;
    long: boolean;
  } | null = null;
  let longTimer: ReturnType<typeof setTimeout> | undefined;
  let lastTap: { cell: CellRef; time: number } | null = null;

  /** The footer column under the pointer, or null anywhere else. */
  function footerTarget(target: EventTarget | null): number | null {
    if (!(target instanceof Element) || !hooks.footer) return null;
    const cell = target.closest<HTMLElement>('[data-rio-footer]');
    const col = cell ? Number(cell.dataset.rioFooter) : NaN;
    return Number.isInteger(col) && hooks.options().columns[col] ? col : null;
  }

  function targetOf(target: EventTarget | null): ContextTarget {
    if (!(target instanceof Element)) return { kind: 'empty' };
    // Footer cells and the add-record row's cell are grid cells too, but they belong to no record.
    if (target.closest('[data-rio-footer], [data-rio-add-row]')) return { kind: 'empty' };
    const cell = target.closest<HTMLElement>('[role="gridcell"]');
    if (cell)
      return { kind: 'cell', cell: { row: Number(cell.dataset.rioRow), col: Number(cell.dataset.rioCol) } };
    const header = target.closest<HTMLElement>('[data-rio-column]');
    if (header) return { kind: 'header', col: Number(header.dataset.rioColumn) };
    const row = target.closest('[role="rowheader"]')?.closest<HTMLElement>('[data-rio-row]');
    return row ? { kind: 'rowHeader', row: Number(row.dataset.rioRow) } : { kind: 'empty' };
  }

  function focus() {
    if (
      !selection.active() &&
      (hooks.footer?.active() ?? null) === null &&
      hooks.options().rowCount &&
      hooks.options().columns.length
    )
      selection.select({ row: 0, col: 0 });
    editor.focus();
  }

  /** Keys while the keyboard is on the footer: along it, back up to the rows, or open a cell. */
  function footerKey(event: KeyboardEvent, footer: FooterHooks, col: number) {
    const options = hooks.options();
    const command = keyCommand(event, mac);
    if (!command) {
      // Typing has nowhere to go in the footer.
      if ([...event.key].length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey)
        event.preventDefault();
      return;
    }
    event.preventDefault();
    const last = options.columns.length - 1;
    switch (command.kind) {
      case 'move': {
        // `right` means toward later columns in a left-to-right layout, and earlier ones otherwise.
        const rtl = options.direction === 'rtl';
        const steps = { left: rtl ? 1 : -1, right: rtl ? -1 : 1, next: 1, previous: -1 } as const;
        switch (command.motion) {
          case 'up':
          case 'pageUp':
            footer.leave();
            break;
          case 'home':
            footer.move(0);
            break;
          case 'end':
            footer.move(last);
            break;
          case 'left':
          case 'right':
          case 'next':
          case 'previous': {
            const step = steps[command.motion];
            footer.move(command.jump ? (step < 0 ? 0 : last) : col + step);
            break;
          }
          // The footer is the last row, so down stays put.
          case 'down':
          case 'pageDown':
            break;
        }
        break;
      }
      case 'edit':
      case 'toggle':
      case 'context':
        footer.activate(col);
        break;
      case 'cancel':
        footer.leave();
        break;
      case 'undo':
        if (!options.readOnly) options.host.onUndo?.();
        break;
      case 'redo':
        if (!options.readOnly) options.host.onRedo?.();
        break;
      default:
        break;
    }
  }

  function move(motion: Motion, extend = false, jump = false) {
    const options = hooks.options();
    if (!options.rowCount || !options.columns.length) return;
    const from = (extend ? selection.extent() : selection.active()) ?? { row: 0, col: 0 };
    const cell = moveCell(
      from,
      motion,
      options.rowCount,
      options.columns.length,
      hooks.pageRows(),
      options.direction === 'rtl',
      jump,
    );
    selection.select(cell, extend);
    // Navigation needs the scroll position, while its visual selection can draw on the next frame.
    hooks.reveal(cell, false);
  }

  function selectTarget(target: ContextTarget, extend = false, toggle = false) {
    if (target.kind === 'cell') selection.select(target.cell, extend);
    else if (target.kind === 'rowHeader')
      selection.selectRow(
        target.row,
        extend ? 'extend' : toggle ? 'toggle' : 'replace',
        hooks.options().rowCount,
      );
  }

  function context(target: ContextTarget, x: number, y: number) {
    if (!editor.stop(true)) return;
    if (
      target.kind === 'cell' &&
      !selection.cellSelected(target.cell) &&
      !selection.rowSelected(target.cell.row)
    )
      selectTarget(target);
    else if (target.kind === 'rowHeader' && !selection.rowSelected(target.row)) selectTarget(target);
    focus();
    hooks.options().host.onContextMenu?.(target, { x, y });
  }

  function toggle(cell: CellRef) {
    const options = hooks.options();
    if (!options.readOnly && options.columns[cell.col]?.toggle) {
      options.host.toggle?.(cell);
      hooks.invalidate();
    }
  }

  function extendDrag() {
    if (!drag) return;
    const bounds = hooks.bounds();
    const x = Math.max(bounds.left, Math.min(bounds.right - 1, drag.x));
    const y = Math.max(bounds.top, Math.min(bounds.bottom - 1, drag.y));
    const cell = hooks.hit(x, y, drag.originRow);
    if (!cell) return;
    if (drag.row) selection.selectRow(cell.row, 'extend', hooks.options().rowCount);
    else selection.select(cell, true);
  }

  function autoScroll() {
    dragFrame = 0;
    if (!drag) return;
    const bounds = hooks.scrollBounds?.() ?? hooks.bounds();
    const speed = (point: number, start: number, end: number) =>
      point < start + 28
        ? -Math.min(32, (start + 28 - point) / 2)
        : point > end - 28
          ? Math.min(32, (point - end + 28) / 2)
          : 0;
    const dx = drag.row ? 0 : speed(drag.x, bounds.left, bounds.right);
    const dy =
      hooks.canScrollVertically?.(drag.originRow) === false ? 0 : speed(drag.y, bounds.top, bounds.bottom);
    if (dx || dy) {
      hooks.scroll(dx, dy);
      extendDrag();
    }
    dragFrame = requestAnimationFrame(autoScroll);
  }

  container.ownerDocument.addEventListener(
    'pointerdown',
    (event) => {
      if (!input.hasAttribute('data-editing') || event.target === input) return;
      if (!editor.stop(true, false)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    { ...listener, capture: true },
  );

  container.addEventListener(
    'pointerdown',
    (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.target === input) return;
      if (event.target instanceof Element && event.target.closest('button, input, textarea, select, a'))
        return;
      // A press on a footer cell keeps the focus in the grid, and the click that follows opens it.
      if (event.pointerType !== 'touch' && footerTarget(event.target) !== null) {
        event.preventDefault();
        return;
      }
      const target = targetOf(event.target);
      if (target.kind !== 'cell' && target.kind !== 'rowHeader') return;
      if (event.pointerType === 'touch') {
        touch = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          target,
          moved: false,
          long: false,
        };
        clearTimeout(longTimer);
        longTimer = setTimeout(() => {
          if (!touch || touch.moved) return;
          touch.long = true;
          context(touch.target, touch.x, touch.y);
        }, 500);
        return;
      }
      if (!editor.stop(true)) return;
      selectTarget(target, event.shiftKey, platformModifier(event, mac));
      focus();
      event.preventDefault();
      if (target.kind === 'cell' && !event.shiftKey) toggle(target.cell);
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        row: target.kind === 'rowHeader',
        originRow: target.kind === 'cell' ? target.cell.row : target.row,
      };
      container.setPointerCapture(event.pointerId);
      dragFrame = requestAnimationFrame(autoScroll);
    },
    listener,
  );

  container.addEventListener(
    'pointermove',
    (event) => {
      if (touch?.id === event.pointerId && Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 8) {
        touch.moved = true;
        clearTimeout(longTimer);
      }
      if (!drag || drag.id !== event.pointerId) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
      extendDrag();
    },
    listener,
  );

  function finishPointer(event: PointerEvent, canceled: boolean) {
    if (drag?.id === event.pointerId) {
      drag = null;
      cancelAnimationFrame(dragFrame);
      if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
    }
    if (touch?.id !== event.pointerId) return;
    const finished = touch;
    touch = null;
    clearTimeout(longTimer);
    if (canceled || finished.moved || finished.long || !editor.stop(true)) return;
    selectTarget(finished.target);
    focus();
    if (finished.target.kind === 'cell') {
      const cell = finished.target.cell;
      toggle(cell);
      if (lastTap && sameCell(lastTap.cell, cell) && performance.now() - lastTap.time < 350) {
        editor.start(cell);
        lastTap = null;
      } else lastTap = { cell, time: performance.now() };
    }
  }
  container.addEventListener('pointerup', (event) => finishPointer(event, false), listener);
  container.addEventListener('pointercancel', (event) => finishPointer(event, true), listener);
  container.addEventListener('lostpointercapture', (event) => finishPointer(event, true), listener);
  container.addEventListener(
    'mousedown',
    (event) => {
      if (event.button !== 0 || event.target === input) return;
      if (event.target instanceof Element && event.target.closest('button, input, textarea, select, a'))
        return;
      const target = targetOf(event.target);
      // The compatibility mouse press after a touch tap must not move grid focus to the page.
      if (target.kind === 'cell' || target.kind === 'rowHeader') event.preventDefault();
    },
    listener,
  );
  container.addEventListener(
    'dblclick',
    (event) => {
      if (event.target === input) return;
      // Pointer capture can retarget dblclick to the container after a selection gesture.
      const target = targetOf(container.ownerDocument.elementFromPoint(event.clientX, event.clientY));
      if (target.kind === 'cell') {
        event.preventDefault();
        editor.start(target.cell);
      }
    },
    listener,
  );
  container.addEventListener(
    'contextmenu',
    (event) => {
      if (event.target === input && editor.isEditing()) return;
      event.preventDefault();
      const col = footerTarget(event.target);
      if (col !== null) openFooter(col);
      else context(targetOf(event.target), event.clientX, event.clientY);
    },
    listener,
  );

  /** A click, tap, or right-click on a footer cell puts the keyboard there and opens it. */
  function openFooter(col: number) {
    if (!hooks.footer || !editor.stop(true)) return;
    hooks.footer.enter(col);
    editor.focus();
    hooks.footer.activate(col);
  }

  input.addEventListener('focus', focus, listener);
  container.addEventListener(
    'click',
    (event) => {
      if (!(event.target instanceof Element)) return;
      const col = footerTarget(event.target);
      if (col !== null) {
        openFooter(col);
        return;
      }
      const action = event.target.closest<HTMLElement>('[data-action]')?.dataset.action;
      const target = targetOf(event.target);
      if (target.kind !== 'rowHeader' || !editor.stop(true)) return;
      if (action === 'select') {
        selection.selectRow(target.row, 'toggle', hooks.options().rowCount);
        // Focusing the input must not replace a row-only selection with the first cell.
        editor.focus();
      } else if (action === 'expand') hooks.options().host.onExpandRow?.(target.row);
    },
    listener,
  );
  input.addEventListener(
    'keydown',
    (event) => {
      const search = searchCommand(event, mac);
      const onFind = hooks.options().host.onFind;
      // The grid's own find takes over from the browser's only while the grid has the focus.
      if (search && onFind) {
        event.preventDefault();
        if (editor.stop(true)) onFind(search);
        return;
      }
      if (editor.ownsKeys()) {
        editor.keyDown(event);
        return;
      }
      if (event.isComposing || event.keyCode === 229) return;
      const footerCol = hooks.footer?.active() ?? null;
      if (hooks.footer && footerCol !== null) {
        footerKey(event, hooks.footer, footerCol);
        return;
      }
      const options = hooks.options();
      const active = selection.active();
      if (active && options.host.onRowKey?.(active.row, event)) {
        event.preventDefault();
        return;
      }
      const command = keyCommand(event, mac);
      if (command && !(command.kind === 'toggle' && active && !options.columns[active.col]?.toggle)) {
        event.preventDefault();
        switch (command.kind) {
          case 'move':
            // Down from the last row, or from an empty grid, goes on to the footer.
            if (
              hooks.footer &&
              options.showFooter &&
              command.motion === 'down' &&
              !command.extend &&
              !command.jump &&
              (!options.rowCount || active?.row === options.rowCount - 1)
            )
              hooks.footer.enter(active?.col ?? 0);
            else move(command.motion, command.extend, command.jump);
            break;
          case 'edit':
            editor.start();
            break;
          case 'cancel':
            selection.collapse();
            break;
          case 'all':
            selection.selectAll(options.rowCount, options.columns.length);
            break;
          case 'clear':
            if (!options.readOnly) {
              options.host.clear?.(selection.get());
              hooks.invalidate();
            }
            break;
          case 'toggle':
            if (active) toggle(active);
            break;
          case 'fillDown':
          case 'fillRight': {
            const request = keyboardFill(
              selection.get().range,
              command.kind === 'fillDown' ? 'down' : 'right',
            );
            if (!options.readOnly && request) {
              options.host.fill?.(request);
              hooks.invalidate();
            }
            break;
          }
          case 'expand':
            if (active) options.host.onExpandRow?.(active.row);
            break;
          case 'undo':
            if (!options.readOnly) {
              options.host.onUndo?.();
              hooks.invalidate();
            }
            break;
          case 'redo':
            if (!options.readOnly) {
              options.host.onRedo?.();
              hooks.invalidate();
            }
            break;
          case 'context': {
            if (!active) break;
            const rect = hooks.reveal(active)?.getBoundingClientRect();
            if (rect) context({ kind: 'cell', cell: active }, rect.left, rect.bottom);
            break;
          }
        }
        return;
      }
      if ([...event.key].length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (active && options.columns[active.col]?.edit === 'custom') {
          event.preventDefault();
          editor.start(active, event.key);
        } else if (!editor.start(active, '')) event.preventDefault();
      }
    },
    listener,
  );

  function copy(event: ClipboardEvent, cut: boolean) {
    if (editor.isEditing()) return;
    event.preventDefault();
    const options = hooks.options();
    if (cut && options.readOnly) return;
    const data = options.host.copy?.(selection.get());
    if (!data || !event.clipboardData) return;
    event.clipboardData.setData('text/plain', data.text);
    if (data.html !== undefined) event.clipboardData.setData('text/html', data.html);
    if (cut) {
      options.host.clear?.(selection.get());
      hooks.invalidate();
    }
  }
  input.addEventListener('copy', (event) => copy(event, false), listener);
  input.addEventListener('cut', (event) => copy(event, true), listener);
  input.addEventListener(
    'paste',
    (event) => {
      if (editor.isEditing()) return;
      event.preventDefault();
      const options = hooks.options();
      if (options.readOnly || !event.clipboardData) return;
      options.host.paste?.(selection.get(), {
        text: event.clipboardData.getData('text/plain'),
        html: event.clipboardData.types.includes('text/html')
          ? event.clipboardData.getData('text/html')
          : null,
      });
      hooks.invalidate();
    },
    listener,
  );

  return {
    move,
    focus,
    runShortcut(id: GridShortcutId) {
      focus();
      input.dispatchEvent(gridShortcutEvent(id, mac));
    },
    destroy() {
      events.abort();
      clearTimeout(longTimer);
      cancelAnimationFrame(dragFrame);
      if (drag && container.hasPointerCapture(drag.id)) container.releasePointerCapture(drag.id);
      drag = null;
      touch = null;
    },
  };
}
