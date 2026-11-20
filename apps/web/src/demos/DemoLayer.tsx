import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useLingui } from '@lingui/react/macro';
import {
  faBackwardStep,
  faForwardStep,
  faPause,
  faPlay,
  faVolumeHigh,
  faVolumeXmark,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { Button, Toolbar } from '@riosoma/ui';
import { useShortcut } from '../shortcuts/useShortcut';
import type { DemoRunner } from './runner';
import './demo.css';

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Room around the outline, so it never sits on the control's own border */
const PADDING = 4;
const GAP = 12;
const MARGIN = 16;
/** Below this width the card always waits at the foot of the screen */
const NARROW = 600;

function same(a: Box | null, b: Box | null): boolean {
  return (
    a === b ||
    (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height)
  );
}

/** Follows an element's place on screen, frame by frame, as the page scrolls and moves. */
function useBox(target: Element | null): Box | null {
  const [measured, setMeasured] = useState<{ target: Element; box: Box | null } | null>(null);
  useEffect(() => {
    if (!target) return;
    let frame = 0;
    let last: Box | null | undefined;
    const measure = () => {
      const rect = target.getBoundingClientRect();
      const next =
        target.isConnected && (rect.width > 0 || rect.height > 0)
          ? {
              top: Math.round(rect.top - PADDING),
              left: Math.round(rect.left - PADDING),
              width: Math.round(rect.width + 2 * PADDING),
              height: Math.round(rect.height + 2 * PADDING),
            }
          : null;
      if (last === undefined || !same(next, last)) {
        last = next;
        setMeasured({ target, box: next });
      }
      frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return measured && measured.target === target ? measured.box : null;
}

/**
 * Where the card goes: below the control, above it, or beside it, and otherwise at the foot of the
 * screen, where it covers the least.  Beside comes first for an item in a menu or list, so the card
 * never hides the items around it.
 */
function placeCard(
  box: Box | null,
  card: { width: number; height: number },
  besideFirst: boolean,
): Box | null {
  if (!box || typeof window === 'undefined') return null;
  const { innerWidth: width, innerHeight: height } = window;
  if (width < NARROW || !card.height) return null;
  const size = { width: card.width, height: card.height };
  const left = Math.min(Math.max(MARGIN, box.left), Math.max(MARGIN, width - card.width - MARGIN));
  const top = Math.min(Math.max(MARGIN, box.top), Math.max(MARGIN, height - card.height - MARGIN));
  const below = box.top + box.height + GAP + card.height + MARGIN <= height;
  const above = box.top - GAP - card.height >= MARGIN;
  const right = box.left + box.width + GAP + card.width + MARGIN <= width;
  const leftSide = box.left - GAP - card.width >= MARGIN;
  const places: Array<[boolean, () => Box]> = [
    [below, () => ({ top: box.top + box.height + GAP, left, ...size })],
    [above, () => ({ top: box.top - GAP - card.height, left, ...size })],
    [right, () => ({ top, left: box.left + box.width + GAP, ...size })],
    [leftSide, () => ({ top, left: box.left - GAP - card.width, ...size })],
  ];
  const order = besideFirst ? [...places.slice(2), ...places.slice(0, 2)] : places;
  const place = order.find(([fits]) => fits);
  return place ? place[1]() : null;
}

export interface DemoLayerProps {
  runner: DemoRunner;
  muted: boolean;
  reducedMotion: boolean;
  onMute(muted: boolean): void;
  onReady?(): void;
}

/**
 * The demo on screen: an outline around the control each step points at, and beside it a card with
 * the step's caption and the controls to pause, step back or forward, mute, and stop.  The layer
 * sits in the app's top layer, so it stays readable and reachable over dialogs.
 */
export function DemoLayer({ runner, muted, reducedMotion, onMute, onReady }: DemoLayerProps) {
  const { t } = useLingui();
  const state = useSyncExternalStore(runner.subscribe, runner.getState, runner.getState);
  const box = useBox(state.target);
  const card = useRef<HTMLElement>(null);
  const first = useRef<HTMLDivElement>(null);
  const ready = useRef(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = card.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const next = { width: element.offsetWidth, height: element.offsetHeight };
      setSize((previous) =>
        previous.width === next.width && previous.height === next.height ? previous : next,
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Lazy controls must own focus before the runner opens another surface.
  useEffect(() => {
    if (ready.current) return;
    ready.current = true;
    first.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus({ preventScroll: true });
    onReady?.();
  }, [onReady]);
  useShortcut('demo.stop', () => {
    if (!runner.dispatching) void runner.stop();
  });

  const placed = placeCard(box, size, Boolean(state.target?.closest('[role="menu"], [role="listbox"]')));
  const paused = state.status === 'paused';
  const last = state.index >= state.total - 1;
  const step = state.index + 1;
  const total = state.total;
  return createPortal(
    <div
      className="rio-demo-layer"
      data-demo-layer=""
      data-react-aria-top-layer=""
      data-motion={reducedMotion ? 'reduced' : undefined}
    >
      {box ? (
        <div
          className="rio-demo-highlight"
          aria-hidden="true"
          style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
        />
      ) : null}
      <section
        ref={card}
        className="rio-demo-card"
        aria-label={t({ id: 'demos.region', message: 'Demo' })}
        data-docked={placed ? undefined : ''}
        style={placed ? { top: placed.top, left: placed.left } : undefined}
      >
        <p className="rio-demo-card__step">{t({ id: 'demos.step', message: `Step ${step} of ${total}` })}</p>
        <p className="rio-demo-card__caption" aria-live="polite" aria-atomic="true">
          {state.caption}
        </p>
        <div ref={first}>
          <Toolbar
            className="rio-demo-card__controls"
            density="compact"
            aria-label={t({ id: 'demos.controls', message: 'Demo controls' })}
          >
            <Button
              size="sm"
              icon={faBackwardStep}
              isDisabled={state.index === 0}
              onPress={() => void runner.back()}
            >
              {t({ id: 'demos.back', message: 'Back' })}
            </Button>
            <Button
              size="sm"
              icon={paused ? faPlay : faPause}
              onPress={() => (paused ? runner.resume() : runner.pause())}
            >
              {paused ? t({ id: 'demos.play', message: 'Play' }) : t({ id: 'demos.pause', message: 'Pause' })}
            </Button>
            <Button size="sm" icon={faForwardStep} onPress={() => void runner.next()}>
              {last ? t({ id: 'demos.finish', message: 'Finish' }) : t({ id: 'demos.next', message: 'Next' })}
            </Button>
            <Button
              size="sm"
              icon={muted ? faVolumeXmark : faVolumeHigh}
              // Pressed while the demo speaks.  Narration starts off until the person turns it on.
              aria-pressed={!muted}
              onPress={() => onMute(!muted)}
            >
              {t({ id: 'demos.narration', message: 'Narration' })}
            </Button>
            <Button size="sm" variant="quiet" icon={faXmark} onPress={() => void runner.stop()}>
              {t({ id: 'demos.stop', message: 'Stop' })}
            </Button>
          </Toolbar>
        </div>
      </section>
    </div>,
    document.body,
  );
}
