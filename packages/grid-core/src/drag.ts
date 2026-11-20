import { TOUCH_DRAG_ACTIVATION } from '@riosoma/tokens';

/** Pointer and keyboard moves commit once, after a preview that never rearranges cells. */
export interface DragHooks {
  direction?(): 'ltr' | 'rtl';
  focus?(): void;
  bounds?(): DOMRect;
  scrollBounds?(): DOMRect;
  instructions?(kind: 'row' | 'column', index: number): string;
  scroll?(dx: number, dy: number): void;
  canScrollVertically?(originRow: number): boolean;
  reveal?(kind: 'row' | 'column', index: number): void;
  count(kind: 'row' | 'column'): number;
  /** The index a point drops on, or null outside the area a release still drops in */
  hit(kind: 'row' | 'column', x: number, y: number, originRow?: number): number | null;
  /** Says the pointer has left that area, so the hint can say a release now cancels */
  outside?(kind: 'row' | 'column', from: number): void;
  reason(kind: 'row' | 'column', from: number, to: number): string | null;
  move(kind: 'row' | 'column', from: number, to: number): void;
  preview(kind: 'row' | 'column', to: number | null, reason?: string | null, from?: number): void;
  announce(
    state: 'start' | 'target' | 'done' | 'cancel',
    kind: 'row' | 'column',
    index: number,
    reason?: string | null,
  ): void;
}

export function createDrag(container: HTMLElement, hooks: DragHooks) {
  const holder = document.createElement('span');
  holder.className = 'rio-grid__drag-focus';
  holder.tabIndex = -1;
  holder.setAttribute('role', 'application');
  container.append(holder);
  const events = new AbortController();
  const listener = { signal: events.signal, capture: true };
  let gesture: {
    kind: 'row' | 'column';
    from: number;
    to: number;
    pointer?: number;
    x: number;
    y: number;
    active: boolean;
    /** Whether the pointer is where a release cancels, so the hint isn't written every move */
    out: boolean;
    anchor: HTMLElement;
  } | null = null;
  let suppressClick = false;
  let frame = 0;
  let focusing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function target(node: EventTarget | null) {
    if (!(node instanceof Element) || node.closest('[data-rio-resize], [data-rio-column-group]')) return null;
    const row = node.closest<HTMLElement>('[data-rio-drag-row]');
    if (row)
      return {
        kind: 'row' as const,
        from: Number(row.closest<HTMLElement>('[data-rio-row]')?.dataset.rioRow),
        anchor: row,
      };
    const column = node.closest<HTMLElement>('[data-rio-column]');
    return column
      ? { kind: 'column' as const, from: Number(column.dataset.rioColumn), anchor: column }
      : null;
  }
  function start() {
    if (!gesture) return;
    gesture.active = true;
    if (gesture.pointer !== undefined) container.setPointerCapture(gesture.pointer);
    else {
      holder.setAttribute(
        'aria-label',
        hooks.instructions?.(gesture.kind, gesture.from) ?? gesture.anchor.getAttribute('aria-label') ?? '',
      );
      focusing = true;
      holder.focus({ preventScroll: true });
      focusing = false;
    }
    if (gesture.pointer !== undefined && hooks.bounds && hooks.scroll)
      frame = requestAnimationFrame(autoScroll);
    hooks.announce('start', gesture.kind, gesture.from, hooks.reason(gesture.kind, gesture.from, gesture.to));
  }
  function finish(cancel: boolean, restoreFocus = true) {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    frame = 0;
    const done = gesture;
    gesture = null;
    if (!done) return;
    hooks.preview(done.kind, null);
    if (done.pointer !== undefined && container.hasPointerCapture(done.pointer))
      container.releasePointerCapture(done.pointer);
    if (!done.active) return;
    if (restoreFocus && done.pointer === undefined) {
      const source = done.anchor.isConnected ? target(done.anchor) : null;
      if (source?.kind === done.kind && source.from === done.from) done.anchor.focus({ preventScroll: true });
      else hooks.focus?.();
    }
    suppressClick = done.pointer !== undefined;
    const reason = hooks.reason(done.kind, done.from, done.to);
    if (!cancel && reason === null && done.from !== done.to) hooks.move(done.kind, done.from, done.to);
    hooks.announce(cancel ? 'cancel' : 'done', done.kind, done.to, reason);
  }
  function preview(to: number) {
    if (!gesture) return;
    // Coming back inside says where the move would land again, even on the same index it left.
    const returning = gesture.out;
    gesture.out = false;
    if (to === gesture.to && !returning) return;
    gesture.to = to;
    const reason = hooks.reason(gesture.kind, gesture.from, to);
    hooks.preview(gesture.kind, to, reason, gesture.from);
    hooks.announce('target', gesture.kind, to, reason);
  }
  /** The pointer is where a release cancels: no target, and the hint says so once. */
  function left() {
    if (!gesture || gesture.out) return;
    gesture.out = true;
    hooks.outside?.(gesture.kind, gesture.from);
  }
  /** Follows the pointer to its target, or out of the grid, where a release cancels the move. */
  function track(x: number, y: number) {
    if (!gesture) return;
    gesture.x = x;
    gesture.y = y;
    const to = hooks.hit(gesture.kind, x, y, gesture.from);
    if (to === null) left();
    else preview(to);
  }
  function autoScroll() {
    frame = 0;
    if (!gesture?.active || gesture.pointer === undefined || !hooks.bounds || !hooks.scroll) return;
    const bounds = hooks.bounds();
    const scrollBounds = hooks.scrollBounds?.() ?? bounds;
    const speed = (point: number, start: number, end: number) =>
      point < start + 28
        ? -Math.min(32, (start + 28 - point) / 2)
        : point > end - 28
          ? Math.min(32, (point - end + 28) / 2)
          : 0;
    const dx = gesture.kind === 'column' ? speed(gesture.x, bounds.left, bounds.right) : 0;
    const dy =
      gesture.kind === 'row' && hooks.canScrollVertically?.(gesture.from) !== false
        ? speed(gesture.y, scrollBounds.top, scrollBounds.bottom)
        : 0;
    // What the pointer is on is asked again unclamped, so scrolling past the grid's edge keeps the
    // preview clear of a target the pointer isn't over.
    if (dx || dy) {
      hooks.scroll(dx, dy);
      track(gesture.x, gesture.y);
    }
    frame = requestAnimationFrame(autoScroll);
  }
  container.ownerDocument.addEventListener(
    'pointerdown',
    () => {
      finish(true, false);
      suppressClick = false;
    },
    listener,
  );
  container.addEventListener(
    'focusout',
    (event) => {
      if (
        !focusing &&
        gesture?.pointer === undefined &&
        !(event.relatedTarget instanceof Node && container.contains(event.relatedTarget))
      )
        finish(true, false);
    },
    listener,
  );
  container.ownerDocument.defaultView?.addEventListener(
    'blur',
    (event) => {
      if (event.target === container.ownerDocument.defaultView) finish(true, false);
    },
    listener,
  );
  container.addEventListener(
    'click',
    (event) => {
      if (suppressClick) {
        event.preventDefault();
        event.stopImmediatePropagation();
        suppressClick = false;
      }
    },
    listener,
  );
  container.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0 || event.defaultPrevented) return;
      const found = target(event.target);
      if (!found) return;
      gesture = {
        ...found,
        to: found.from,
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        active: false,
        out: false,
      };
      if (event.pointerType === 'touch') timer = setTimeout(start, TOUCH_DRAG_ACTIVATION.delay);
      event.stopPropagation();
    },
    listener,
  );
  container.addEventListener(
    'pointermove',
    (event) => {
      if (!gesture || gesture.pointer !== event.pointerId) return;
      if (!gesture.active) {
        if (
          Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) <
          (event.pointerType === 'touch' ? TOUCH_DRAG_ACTIVATION.tolerance : 5)
        )
          return;
        if (event.pointerType === 'touch') {
          finish(true);
          return;
        }
        start();
      }
      event.preventDefault();
      track(event.clientX, event.clientY);
    },
    listener,
  );
  container.addEventListener(
    'pointerup',
    (event) => {
      if (gesture?.pointer !== event.pointerId) return;
      const active = gesture.active;
      // A release outside the grid cancels rather than dropping on its nearest edge, which is the
      // only way a touch, with no Escape to press, can back out of a move.
      const dropped = !active || hooks.hit(gesture.kind, event.clientX, event.clientY, gesture.from) !== null;
      finish(!dropped);
      if (active) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    listener,
  );
  container.addEventListener(
    'pointercancel',
    (event) => {
      if (event.pointerId === gesture?.pointer) finish(true);
    },
    listener,
  );
  container.addEventListener(
    'lostpointercapture',
    (event) => {
      if (event.target === container && event.pointerId === gesture?.pointer) finish(true);
    },
    listener,
  );
  container.ownerDocument.addEventListener(
    'keydown',
    (event) => {
      if (gesture?.pointer === undefined || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish(true);
    },
    listener,
  );
  container.addEventListener(
    'keydown',
    (event) => {
      if (gesture?.pointer === undefined && gesture && event.target !== holder) return;
      if (gesture && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
        return;
      }
      if (!gesture) {
        const found = target(event.target);
        if (!found || event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        gesture = { ...found, to: found.from, x: 0, y: 0, active: false, out: false };
        start();
        return;
      }
      if (gesture.pointer !== undefined) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
        return;
      }
      const delta =
        gesture.kind === 'row'
          ? event.key === 'ArrowUp'
            ? -1
            : event.key === 'ArrowDown'
              ? 1
              : 0
          : event.key === 'ArrowLeft'
            ? -1
            : event.key === 'ArrowRight'
              ? 1
              : 0;
      if (delta) {
        event.preventDefault();
        event.stopPropagation();
        preview(
          Math.max(
            0,
            Math.min(
              hooks.count(gesture.kind) - 1,
              gesture.to +
                delta *
                  (gesture.kind === 'column' && (hooks.direction?.() ?? container.dir) === 'rtl' ? -1 : 1),
            ),
          ),
        );
        hooks.reveal?.(gesture.kind, gesture.to);
      }
    },
    listener,
  );
  return {
    destroy() {
      finish(true);
      events.abort();
      holder.remove();
    },
  };
}
