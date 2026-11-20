import { useLingui } from '@lingui/react/macro';
import { useCallback, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { LAYOUT } from '@riosoma/tokens';

const KEY = 'rio.sidebarWidth';

function clamp(n: number): number {
  return Math.min(LAYOUT.sidebarMax, Math.max(LAYOUT.sidebarMin, Math.round(n)));
}

export function useSidebarWidth(): [number, (w: number) => void] {
  const [width, setWidth] = useState(() => {
    try {
      return clamp(Number(localStorage.getItem(KEY)) || LAYOUT.sidebarMin);
    } catch {
      return LAYOUT.sidebarMin;
    }
  });
  const set = useCallback((w: number) => {
    const next = clamp(w);
    setWidth(next);
    try {
      localStorage.setItem(KEY, String(next));
    } catch {
      // Not remembered, still applied.
    }
  }, []);
  return [width, set];
}

/** A drag handle on the sidebar's edge that also works with the arrow keys. */
export function SidebarResizer({ width, onChange }: { width: number; onChange: (w: number) => void }) {
  const { t } = useLingui();
  const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const startX = e.clientX;
    const startWidth = width;
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (ev: globalThis.PointerEvent) =>
      onChange(startWidth + (rtl ? startX - ev.clientX : ev.clientX - startX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 16 : 4;
    const grow = rtl ? 'ArrowLeft' : 'ArrowRight';
    const shrink = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === grow) onChange(width + step);
    else if (e.key === shrink) onChange(width - step);
    else if (e.key === 'Home') onChange(LAYOUT.sidebarMin);
    else if (e.key === 'End') onChange(LAYOUT.sidebarMax);
    else return;
    e.preventDefault();
  };

  return (
    <div
      className="rio-sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t({ id: 'shell.resizeSidebar', message: 'Resize sidebar' })}
      aria-valuemin={LAYOUT.sidebarMin}
      aria-valuemax={LAYOUT.sidebarMax}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
