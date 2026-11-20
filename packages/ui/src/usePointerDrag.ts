import { useEffect, useRef, type PointerEvent } from 'react';
import { TOUCH_DRAG_ACTIVATION } from '@riosoma/tokens';

/** Shared spatial gestures preview during movement and commit once on release. */
export function usePointerDrag(enabled: boolean) {
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  useEffect(() => {
    if (!enabled) stop.current?.();
  }, [enabled]);
  return (
    event: PointerEvent<HTMLElement>,
    handlers: {
      activateImmediately?: boolean;
      scrollElement?: HTMLElement | null;
      move(event: globalThis.PointerEvent): void;
      finish(event: globalThis.PointerEvent, activated: boolean): void;
      cancel(): void;
    },
  ) => {
    if (!enabled || event.button !== 0) return;
    event.stopPropagation();
    stop.current?.();
    const origin = { x: event.clientX, y: event.clientY };
    const held = event.pointerType === 'touch' || event.pointerType === 'pen';
    let activated = handlers.activateImmediately ?? false;
    let latest: globalThis.PointerEvent | undefined;
    let frame = 0;
    const scroll = () => {
      const element = handlers.scrollElement;
      if (activated && element && latest) {
        const rect = element.getBoundingClientRect();
        const dx = latest.clientX < rect.left + 32 ? -12 : latest.clientX > rect.right - 32 ? 12 : 0;
        const dy = latest.clientY < rect.top + 32 ? -12 : latest.clientY > rect.bottom - 32 ? 12 : 0;
        if (dx || dy) {
          const before = { x: element.scrollLeft, y: element.scrollTop };
          element.scrollBy(dx, dy);
          if (before.x !== element.scrollLeft || before.y !== element.scrollTop) handlers.move(latest);
        }
      }
      frame = requestAnimationFrame(scroll);
    };
    if (handlers.scrollElement) frame = requestAnimationFrame(scroll);
    const timer = held
      ? setTimeout(() => {
          activated = true;
        }, TOUCH_DRAG_ACTIVATION.delay)
      : undefined;
    const detach = () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('touchmove', touch);
      window.removeEventListener('keydown', key, true);
      stop.current = null;
    };
    const cancel = () => {
      detach();
      handlers.cancel();
    };
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      latest = next;
      const distance = Math.hypot(next.clientX - origin.x, next.clientY - origin.y);
      if (!activated) {
        if (held) {
          if (distance > TOUCH_DRAG_ACTIVATION.tolerance) cancel();
          return;
        }
        if (distance < 5) return;
        activated = true;
      }
      next.preventDefault();
      handlers.move(next);
    };
    const up = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      detach();
      handlers.finish(next, activated);
    };
    const touch = (next: TouchEvent) => {
      if (activated) next.preventDefault();
    };
    const key = (next: globalThis.KeyboardEvent) => {
      if (next.key !== 'Escape') return;
      next.preventDefault();
      next.stopPropagation();
      cancel();
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('touchmove', touch, { passive: false });
    window.addEventListener('keydown', key, true);
    stop.current = cancel;
  };
}
