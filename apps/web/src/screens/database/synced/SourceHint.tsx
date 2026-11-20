import { useEffect, useState, type RefObject } from 'react';
import { Tooltip, TooltipTrigger } from '@riosoma/ui';

/** The grid keeps DOM cells outside React; delegate their hover and keyboard focus to one tooltip. */
export function SourceHint({ container }: { container: RefObject<HTMLElement | null> }) {
  const [hint, setHint] = useState<{ anchor: HTMLElement; text: string }>();
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    let frame = 0;
    const show = (element: Element | null) => {
      const anchor = element?.closest<HTMLElement>('[data-synced-description]');
      const text = anchor?.dataset.syncedDescription;
      setHint((previous) => {
        if (!anchor || !text || anchor.hasAttribute('data-loading')) return undefined;
        return previous?.anchor === anchor && previous.text === text ? previous : { anchor, text };
      });
    };
    const hover = (event: PointerEvent) => show(event.target instanceof Element ? event.target : null);
    const hide = () => setHint(undefined);
    const focus = (event?: Event) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        show(
          event?.target instanceof Element && event.target.closest('[role=columnheader]')
            ? event.target
            : root.querySelector('[data-active]'),
        ),
      );
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
      else focus();
    };
    root.addEventListener('pointerover', hover);
    // An edit can add a description while the pointer stays inside the same DOM cell.
    root.addEventListener('pointermove', hover);
    root.addEventListener('pointerleave', hide);
    root.addEventListener('focusin', focus);
    root.addEventListener('focusout', hide);
    root.addEventListener('keyup', key);
    root.addEventListener('wheel', hide);
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener('pointerover', hover);
      root.removeEventListener('pointermove', hover);
      root.removeEventListener('pointerleave', hide);
      root.removeEventListener('focusin', focus);
      root.removeEventListener('focusout', hide);
      root.removeEventListener('keyup', key);
      root.removeEventListener('wheel', hide);
    };
  }, [container]);
  return hint ? (
    <TooltipTrigger
      isOpen
      onOpenChange={(open) => {
        if (!open) setHint(undefined);
      }}
    >
      <Tooltip triggerRef={{ current: hint.anchor }}>{hint.text}</Tooltip>
    </TooltipTrigger>
  ) : null;
}
