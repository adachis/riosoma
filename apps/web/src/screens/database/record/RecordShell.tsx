import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLingui } from '@lingui/react/macro';
import { LAYOUT } from '@riosoma/tokens';
import { Dialog, Modal } from '@riosoma/ui';

export type RecordLayout = 'card' | 'panel' | 'page';

/** All layouts keep the same body and commands, with focus owned by the shell. */
export function RecordShell({
  layout,
  titleId,
  wide,
  onClose,
  children,
}: {
  layout: RecordLayout;
  titleId: string;
  wide: boolean;
  onClose(): void;
  children: ReactNode;
}) {
  const { t } = useLingui();
  const region = useRef<HTMLElement>(null);
  const escapeInPicker = useRef(false);
  const [width, setWidth] = useState<number>(LAYOUT.dockWidth);
  const [minimum, setMinimum] = useState<number>(LAYOUT.dockWidth);
  const [maximum, setMaximum] = useState<number>(LAYOUT.dockWidth * 2);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const clamp = (value: number) => Math.min(maximum, Math.max(minimum, value));
  useEffect(() => {
    if (layout !== 'panel') return;
    const resize = () => {
      const available = region.current?.closest('.rio-record-workspace')?.clientWidth || window.innerWidth;
      // An open conversation can leave less space than the preferred panel width.
      const lower = Math.min(LAYOUT.dockWidth, available);
      const limit = Math.max(lower, Math.min(LAYOUT.dockWidth * 2, available / 2));
      setMinimum(lower);
      setMaximum(limit);
      setWidth((current) => Math.min(limit, Math.max(lower, current)));
    };
    resize();
    const observer = new ResizeObserver(resize);
    const workspace = region.current?.closest('.rio-record-workspace');
    if (workspace) observer.observe(workspace);
    window.addEventListener('resize', resize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [layout]);
  useEffect(() => {
    if (layout === 'card') return;
    const opener = document.activeElement;
    const surface = region.current;
    surface?.focus();
    return () => {
      // The grid or another control may already have taken focus as the record closes.
      if (
        opener instanceof HTMLElement &&
        opener.isConnected &&
        (document.activeElement === document.body || surface?.contains(document.activeElement))
      )
        opener.focus({ preventScroll: true });
    };
  }, [layout]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const surface =
      layout === 'card'
        ? document.getElementById(titleId)?.closest<HTMLElement>('.rio-record-card')
        : region.current;
    if (!viewport || !surface) return;
    const overlay = surface.closest<HTMLElement>('.rio-record-overlay');
    let frame = 0;
    const resize = () => {
      frame = 0;
      // Phone keyboards can shrink and pan the visible area without resizing the layout viewport.
      const bottom = viewport.offsetTop + viewport.height;
      if (overlay) {
        overlay.style.setProperty('--rio-record-viewport-height', `${viewport.height}px`);
        overlay.style.setProperty('--rio-record-viewport-top', `${viewport.offsetTop}px`);
      } else {
        surface.style.setProperty(
          '--rio-record-viewport-height',
          `${Math.max(0, bottom - surface.getBoundingClientRect().top)}px`,
        );
      }
      const body = surface.querySelector<HTMLElement>('.rio-record-card__body');
      const focused = document.activeElement;
      if (!body || !(focused instanceof HTMLElement) || !body.contains(focused)) return;
      const field = focused.getBoundingClientRect();
      const bounds = body.getBoundingClientRect();
      const top = Math.max(bounds.top, viewport.offsetTop);
      const end = Math.min(bounds.bottom, bottom);
      if (field.bottom > end) body.scrollTop += field.bottom - end;
      else if (field.top < top) body.scrollTop -= top - field.top;
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    };
    schedule();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    surface.addEventListener('focusin', schedule);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      surface.removeEventListener('focusin', schedule);
      (overlay ?? surface).style.removeProperty('--rio-record-viewport-height');
      overlay?.style.removeProperty('--rio-record-viewport-top');
    };
  }, [layout, titleId]);

  if (layout === 'card')
    return (
      <Modal
        isOpen
        isDismissable
        overlayClassName="rio-record-overlay"
        className={`rio-record-card${wide ? ' rio-record-card--wide' : ''}`}
        onOpenChange={(open) => !open && onClose()}
      >
        <Dialog hideCloseButton aria-labelledby={titleId}>
          {children}
        </Dialog>
      </Modal>
    );

  return (
    <section
      ref={region}
      role="region"
      aria-labelledby={titleId}
      tabIndex={-1}
      className={`rio-record-surface rio-record-surface--${layout}`}
      style={{ '--rio-record-width': `${width}px` } as CSSProperties}
      onKeyDownCapture={(event) => {
        escapeInPicker.current =
          event.key === 'Escape' &&
          event.target instanceof Element &&
          Boolean(event.target.closest('[aria-expanded="true"]'));
      }}
      onKeyDown={(event) => {
        // Expanded controls and portaled pickers get the first chance to handle Escape.
        if (
          event.key === 'Escape' &&
          !event.defaultPrevented &&
          !escapeInPicker.current &&
          event.currentTarget.contains(event.target as Node)
        ) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {layout === 'panel' && (
        <div
          className="rio-record-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={t({ id: 'record.resize', message: 'Resize record panel' })}
          aria-valuemin={minimum}
          aria-valuemax={maximum}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={(event) => {
            drag.current = { x: event.clientX, width };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            const rtl = document.documentElement.dir === 'rtl';
            setWidth(clamp(drag.current.width + (event.clientX - drag.current.x) * (rtl ? 1 : -1)));
          }}
          onPointerUp={(event) => {
            drag.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 16 : 4;
            const grow = document.documentElement.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
            if (event.key === 'Home') setWidth(minimum);
            else if (event.key === 'End') setWidth(maximum);
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
              setWidth(clamp(width + (event.key === grow ? step : -step)));
            else return;
            event.preventDefault();
          }}
        />
      )}
      <div className="rio-dialog">{children}</div>
    </section>
  );
}
