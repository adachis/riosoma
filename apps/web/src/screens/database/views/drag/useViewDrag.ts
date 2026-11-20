import {
  createElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useLingui } from '@lingui/react/macro';
import type { Refusal } from './rules';
import { TOUCH_DRAG_ACTIVATION } from '@riosoma/tokens';
import './drag.css';

export const DRAG_THRESHOLDS = {
  touchPressMs: TOUCH_DRAG_ACTIVATION.delay,
  touchTolerancePx: TOUCH_DRAG_ACTIVATION.tolerance,
  pointerDistancePx: 5,
} as const;
export const PRESS_MS = DRAG_THRESHOLDS.touchPressMs;
/** How close to a scroller's edge the pointer has to be before it scrolls, and the fastest it goes. */
const SCROLL_EDGE_PX = 40;
const SCROLL_STEP_PX = 16;
export interface DragPoint {
  clientX: number;
  clientY: number;
}
/**
 * What a held drag scrolls: one node, or several from the outside in.  A list lets a view keep the
 * edges to itself while an inner target, such as a day's time drop targets, scrolls in between.
 */
export type ScrollTarget = HTMLElement | null | Array<HTMLElement | null | undefined>;
interface Gesture {
  move(point: DragPoint): void;
  drop(point: DragPoint): void;
  finish?(): void;
  pan?(origin: DragPoint, point: DragPoint): void;
  scroll?: ScrollTarget | ((point: DragPoint) => ScrollTarget);
  /** Sticky parts of a scroller, such as a chart's header, that are not drop targets */
  scrollInsets?: Partial<Record<'left' | 'right' | 'top' | 'bottom', number>>;
}

/** How fast a scroller moves at a pointer, from nothing in the middle to a step at its edge. */
function edgeSpeed(at: number, low: number, high: number): number {
  if (at < low + SCROLL_EDGE_PX) return -Math.min(SCROLL_STEP_PX, (low + SCROLL_EDGE_PX - at) / 3);
  if (at > high - SCROLL_EDGE_PX) return Math.min(SCROLL_STEP_PX, (at - high + SCROLL_EDGE_PX) / 3);
  return 0;
}

/** Keep the drawn snapshot stable until release or navigation to a different range. */
export function useHeld<T>(value: T, holding: boolean, range?: string): T {
  const [held, setHeld] = useState({ holding, value, range });
  if (holding !== held.holding) setHeld({ holding, value, range });
  return holding && held.holding && range === held.range ? held.value : value;
}

export function useViewDrag() {
  const { t } = useLingui();
  const [holding, setHolding] = useState(false);
  const [active, setActive] = useState(false);
  const [notice, setNotice] = useState({ message: '', nonce: 0 });
  const status = notice.message;
  function setStatus(message: string) {
    setNotice((current) => ({ message, nonce: current.nonce + 1 }));
  }
  const [point, setPoint] = useState<DragPoint>({ clientX: 0, clientY: 0 });
  const cleanup = useRef<(() => void) | null>(null);
  const refreshTarget = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (active) refreshTarget.current?.();
  }, [active]);
  const marked = useRef<HTMLElement | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => () => cleanup.current?.(), []);
  const reasons: Record<Refusal, string> = {
    access: t({ id: 'views.drag.access', message: 'You do not have access to move this record.' }),
    record: t({ id: 'views.drag.recordLocked', message: 'This record is locked.' }),
    field: t({ id: 'views.drag.fieldLocked', message: 'This field is locked or restricted.' }),
    computed: t({ id: 'views.drag.computed', message: 'This field is calculated and cannot be changed.' }),
    source: t({ id: 'views.drag.source', message: 'The Data Source controls this value or order.' }),
    sorted: t({ id: 'views.drag.sorted', message: 'Remove the sort to arrange records by hand.' }),
    view: t({ id: 'views.drag.viewLocked', message: 'This view is locked.' }),
  };
  const canceled = t({ id: 'views.drag.canceled', message: 'Move canceled.' });
  const instructions = t({
    id: 'views.drag.instructions',
    message: 'Drag to move.  On a touch screen, press briefly before dragging.  Escape cancels.',
  });
  function mark(node: HTMLElement | null, message: string, refused = false, side?: 'before' | 'after') {
    if (marked.current !== node) {
      marked.current?.removeAttribute('data-rio-drop');
      marked.current?.removeAttribute('data-rio-drop-reason');
      marked.current?.removeAttribute('data-rio-drop-side');
    }
    marked.current = node;
    node?.setAttribute('data-rio-drop', refused ? 'refused' : 'ready');
    node?.setAttribute('data-rio-drop-reason', message);
    if (side && !refused) node?.setAttribute('data-rio-drop-side', side);
    else node?.removeAttribute('data-rio-drop-side');
    setNotice((current) => (current.message === message ? current : { message, nonce: current.nonce + 1 }));
  }
  function start(event: ReactPointerEvent, gesture: Gesture) {
    if (event.button !== 0) return;
    cleanup.current?.();
    suppressClick.current = false;
    setStatus('');
    const origin = { clientX: event.clientX, clientY: event.clientY };
    let point = origin;
    let dragging = false;
    let frame = 0;
    refreshTarget.current = () => {
      if (dragging) gesture.move(point);
    };
    const touch = event.pointerType === 'touch' || event.pointerType === 'pen';
    const activate = () => {
      dragging = true;
      suppressClick.current = true;
      setActive(true);
      setPoint(point);
      setStatus(
        t({ id: 'views.drag.pickedUp', message: 'Picked up.  Choose a target, or press Escape to cancel.' }),
      );
      gesture.move(point);
      frame = requestAnimationFrame(scroll);
    };
    setHolding(true);
    const press = touch ? setTimeout(activate, PRESS_MS) : undefined;
    const scroll = () => {
      const offered = typeof gesture.scroll === 'function' ? gesture.scroll(point) : gesture.scroll;
      const nodes = (Array.isArray(offered) ? offered : [offered]).filter(
        (node): node is HTMLElement => node instanceof HTMLElement,
      );
      const inset = gesture.scrollInsets;
      // The first node that can move wins, so an outer view keeps its own edges even where an
      // inner target covers them, and an inner target with no room left hands the pointer on.
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        const beforeX = node.scrollLeft;
        const beforeY = node.scrollTop;
        node.scrollLeft += edgeSpeed(
          point.clientX,
          rect.left + (inset?.left ?? 0),
          rect.right - (inset?.right ?? 0),
        );
        node.scrollTop += edgeSpeed(
          point.clientY,
          rect.top + (inset?.top ?? 0),
          rect.bottom - (inset?.bottom ?? 0),
        );
        if (node.scrollLeft !== beforeX || node.scrollTop !== beforeY) {
          gesture.move(point);
          break;
        }
      }
      frame = requestAnimationFrame(scroll);
    };
    const finish = () => {
      clearTimeout(press);
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', lost);
      document.removeEventListener('visibilitychange', lost);
      window.removeEventListener('touchmove', hold);
      window.removeEventListener('contextmenu', menu);
      marked.current?.removeAttribute('data-rio-drop');
      marked.current?.removeAttribute('data-rio-drop-reason');
      marked.current?.removeAttribute('data-rio-drop-side');
      marked.current = null;
      cleanup.current = null;
      refreshTarget.current = null;
      setHolding(false);
      setActive(false);
      gesture.finish?.();
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      if ((event.pointerType === 'mouse' || event.pointerType === 'pen') && next.buttons === 0) {
        lost();
        return;
      }
      point = next;
      const distance = Math.hypot(point.clientX - origin.clientX, point.clientY - origin.clientY);
      if (!dragging) {
        if (touch) {
          if (distance > DRAG_THRESHOLDS.touchTolerancePx) {
            if (gesture.pan) {
              finish();
              gesture.pan(origin, point);
            } else cancel();
          }
          return;
        }
        if (distance < DRAG_THRESHOLDS.pointerDistancePx) return;
        activate();
      }
      next.preventDefault();
      setPoint(point);
      gesture.move(point);
    };
    const up = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      finish();
      if (dragging) {
        setStatus('');
        gesture.drop(next);
      }
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
    };
    const cancel = (next?: PointerEvent) => {
      if (next && next.pointerId !== event.pointerId) return;
      finish();
      if (dragging) setStatus(canceled);
      if (!dragging || next?.type === 'pointercancel') {
        suppressClick.current = false;
        return;
      }
      // Escape must suppress the carried pointer's click, then allow keyboard activation again.
      const release = (next: PointerEvent) => {
        if (next.pointerId !== event.pointerId) return;
        window.removeEventListener('pointerup', release);
        cleanup.current = null;
        setTimeout(() => {
          suppressClick.current = false;
        }, 0);
      };
      window.addEventListener('pointerup', release);
      cleanup.current = () => window.removeEventListener('pointerup', release);
    };
    const lost = () => {
      finish();
      suppressClick.current = false;
      if (dragging) setStatus(canceled);
    };
    const key = (next: KeyboardEvent) => {
      if (next.key === 'Escape') {
        next.preventDefault();
        cancel();
        next.stopPropagation();
      }
    };
    const hold = (next: TouchEvent) => {
      if (dragging && next.cancelable) next.preventDefault();
    };
    const menu = (next: Event) => {
      if (touch) next.preventDefault();
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, { capture: true });
    window.addEventListener('blur', lost);
    document.addEventListener('visibilitychange', lost);
    window.addEventListener('touchmove', hold, { passive: false });
    window.addEventListener('contextmenu', menu);
    cleanup.current = finish;
  }
  const feedback = active
    ? createElement(
        'div',
        {
          className: 'rio-view-drag-feedback',
          style: {
            left: Math.max(8, Math.min(point.clientX + 12, window.innerWidth - 240)),
            top: Math.min(point.clientY + 24, window.innerHeight - 72),
          },
          'aria-hidden': true,
        },
        status,
      )
    : null;
  const announcement = createElement('span', { key: notice.nonce }, status);
  return {
    feedback,
    announcement,
    holding,
    active,
    status,
    setStatus,
    start,
    mark,
    reasons,
    instructions,
    suppressClick,
  };
}
