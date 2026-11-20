import { useEffect, useRef, useState, type ReactNode, type PointerEvent } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Button, Text } from '@riosoma/ui';
import { faUpDownLeftRight, faExpand } from '@fortawesome/free-solid-svg-icons';
import { fitWindow, readWindowPreference, type WindowPosition } from './window-position';

const POSITION_KEY = 'rio-docs-window-position';
const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

export function DocsWindow({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  const [preference] = useState(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(POSITION_KEY);
    } catch {
      /* Storage can be unavailable. */
    }
    return readWindowPreference(saved, viewport());
  });
  const [position, setPosition] = useState(() => fitWindow(preference, viewport()));
  const desktop = useRef(preference);
  const gesture = useRef<{ start: WindowPosition; x: number; y: number; resize: boolean } | null>(null);
  const save = (next: WindowPosition) => {
    if (window.innerWidth <= 767) return;
    desktop.current = next;
    try {
      localStorage.setItem(POSITION_KEY, JSON.stringify(next));
    } catch {
      /* The window remains usable without storage. */
    }
  };
  useEffect(() => {
    const resize = () => setPosition(fitWindow(desktop.current, viewport()));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const begin = (event: PointerEvent<HTMLElement>, resize = false) => {
    if (event.button !== 0 || window.innerWidth <= 767) return;
    if (!resize && (event.target as Element).closest('button')) return;
    gesture.current = { start: position, x: event.clientX, y: event.clientY, resize };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    setPosition(
      fitWindow(
        current.resize
          ? { ...current.start, width: current.start.width + dx, height: current.start.height + dy }
          : { ...current.start, x: current.start.x + dx, y: current.start.y + dy },
        viewport(),
      ),
    );
  };
  const end = () => {
    if (gesture.current) save(position);
    gesture.current = null;
  };
  const keyboard = (event: React.KeyboardEvent, resize: boolean) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0;
    const dy = event.key === 'ArrowUp' ? -16 : event.key === 'ArrowDown' ? 16 : 0;
    const next = fitWindow(
      resize
        ? { ...position, width: position.width + dx, height: position.height + dy }
        : { ...position, x: position.x + dx, y: position.y + dy },
      viewport(),
    );
    setPosition(next);
    save(next);
  };
  return (
    <section
      className="rio-docs-window"
      aria-label={t({ id: 'docs.window', message: 'Documentation window' })}
      style={{ left: position.x, top: position.y, width: position.width, height: position.height }}
    >
      <header
        className="rio-docs-window__bar"
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => {
          if (gesture.current) setPosition(gesture.current.start);
          gesture.current = null;
        }}
      >
        <Text>{t({ id: 'docs.documentation', message: 'Documentation' })}</Text>
        <Button
          variant="quiet"
          size="sm"
          icon={faUpDownLeftRight}
          aria-label={t({ id: 'docs.window.move', message: 'Move documentation window with arrow keys' })}
          onKeyDown={(event) => keyboard(event, false)}
        />
        <Button
          variant="quiet"
          size="sm"
          icon={faExpand}
          aria-label={t({ id: 'docs.window.resize', message: 'Resize documentation window with arrow keys' })}
          onKeyDown={(event) => keyboard(event, true)}
        />
      </header>
      {children}
      <div
        className="rio-docs-window__resize"
        aria-hidden="true"
        onPointerDown={(event) => begin(event, true)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => {
          if (gesture.current) setPosition(gesture.current.start);
          gesture.current = null;
        }}
      />
    </section>
  );
}
