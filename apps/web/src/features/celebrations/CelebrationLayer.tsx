import { preloadImport } from '../../asset-recovery';
import type { AnimationClock } from './confetti-animation';
import { useEffect, useRef, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { Preferences } from '@riosoma/contracts';
import { toast, toastQueue } from '@riosoma/ui';
import { useSession } from '../../session';
import { rioReact, type RioReaction } from '../rio/reactions';
import type { Box } from './confetti-particles';
import { celebrations as appEngine, type Celebration, type CelebrationEngine } from './engine';
import type { CelebrationSize } from './registry';
import { reducedMotion } from './settings';
import { playSound, sounds as appSounds, type SoundName, type SoundPlayer } from './sounds';
import { useKonami } from './surprises';
import './CelebrationLayer.css';

/** The theme's accent colors, which the confetti is made of */
const COLOR_TOKENS = [
  '--rio-accent',
  '--rio-success',
  '--rio-info',
  '--rio-warning',
  '--rio-link',
  '--rio-focus',
];

const RIO: Record<CelebrationSize, RioReaction> = {
  small: { kind: 'mood', mood: 'happy', seconds: 1.2 },
  medium: { kind: 'mood', mood: 'happy', seconds: 2 },
  large: { kind: 'mood', mood: 'celebrating', seconds: 3 },
};

const CHIME: Record<CelebrationSize, SoundName> = { small: 'chime', medium: 'rise', large: 'rise' };

/** Anything that takes typing.  Confetti never draws over the one that has focus. */
const EDITABLE =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]';

function boxOf(element: Element | null | undefined, margin = 0): Box | null {
  if (!element || !element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return {
    left: rect.left - margin,
    top: rect.top - margin,
    width: rect.width + margin * 2,
    height: rect.height + margin * 2,
  };
}

/** The field being edited, if any, with a little room around it. */
export function editingBox(): Box | null {
  const active = document.activeElement;
  return active instanceof Element && active.matches(EDITABLE) ? boxOf(active, 4) : null;
}

/** Resolves the accent tokens to colors a canvas can paint with, through the element's styles. */
function themeColors(probe: HTMLElement): string[] {
  const colors = new Set<string>();
  for (const token of COLOR_TOKENS) {
    probe.style.color = `var(${token})`;
    const color = getComputedStyle(probe).color;
    if (color) colors.add(color);
  }
  probe.style.color = '';
  return [...colors];
}

export interface CelebrationLayerProps {
  engine?: CelebrationEngine;
  player?: SoundPlayer;
  clock?: AnimationClock;
}

interface Run {
  id: number;
  celebration: Celebration;
}

/**
 * Where celebrations happen: one overlay above the page that never takes a click and never moves
 * anything, drawn only while a celebration runs.  It also plays the error tone, and listens for
 * the Konami code.  Mounted once, in the app's shell.
 */
export function CelebrationLayer({ engine = appEngine, player = appSounds, clock }: CelebrationLayerProps) {
  const { i18n } = useLingui();
  const session = useSession();
  const preferences = useRef<Preferences | undefined>(session?.preferences);
  useEffect(() => {
    preferences.current = session?.preferences;
  });
  const [run, setRun] = useState<Run | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const runs = useRef(0);

  useEffect(
    () =>
      engine.subscribe((celebration) => {
        const settings = preferences.current;
        const line = i18n._(celebration.line);
        if (celebration.cause === 'you') playSound(CHIME[celebration.size], settings, player);
        // At reduced motion, and on a tab nobody is looking at, a quiet toast is the whole moment.
        if (reducedMotion(settings) || document.hidden) {
          toast.show({ title: line, tone: 'success' });
          return;
        }
        rioReact(RIO[celebration.size]);
        if (celebration.size === 'large') toast.show({ title: line, tone: 'success' });
        setRun({ id: ++runs.current, celebration });
      }),
    [engine, i18n, player],
  );

  useEffect(() => {
    const element = canvas.current;
    if (!run || !element) return;
    const context = element.getContext('2d');
    const width = window.innerWidth;
    const height = window.innerHeight;
    const scale = Math.min(2, window.devicePixelRatio || 1);
    element.width = Math.round(width * scale);
    element.height = Math.round(height * scale);
    const colors = probe.current ? themeColors(probe.current) : [];
    // A small celebration with nothing to sparkle on sparkles on Rio.
    const anchor =
      boxOf(run.celebration.anchor) ??
      (run.celebration.size === 'small' ? boxOf(document.querySelector('.rio-assistant__trigger')) : null);
    let canceled = false;
    let stop: (() => void) | undefined;
    const onDone = () => setRun((current) => (current?.id === run.id ? null : current));
    void preloadImport(() => import('./confetti-animation'))
      .then(({ animate, draw, particlesFor }) => {
        if (canceled) return;
        stop = animate({
          particles: particlesFor(run.celebration.size, anchor, { width, height }, colors),
          clock,
          render: (list) => {
            if (!context) return;
            const clear = editingBox();
            draw(context, list, clear ? [clear] : [], { width, height, scale });
          },
          onDone,
        });
      })
      .catch(onDone);
    return () => {
      canceled = true;
      stop?.();
    };
  }, [run, clock]);

  // A new error toast brings the low tone, when the person has sounds on.
  useEffect(() => {
    const heard = new Set(toastQueue.visibleToasts.map((item) => item.key));
    return toastQueue.subscribe(() => {
      const visible = toastQueue.visibleToasts;
      for (const item of visible) {
        if (heard.has(item.key)) continue;
        heard.add(item.key);
        if (item.content.tone === 'danger') playSound('low', preferences.current, player);
      }
      for (const key of heard) if (!visible.some((item) => item.key === key)) heard.delete(key);
    });
  }, [player]);

  useKonami(() => {
    rioReact(reducedMotion(preferences.current) ? RIO.small : { kind: 'dance' });
  });

  return (
    <div className="rio-celebrations" aria-hidden="true" style={{ pointerEvents: 'none' }}>
      <span ref={probe} className="rio-celebrations__probe" />
      {run ? (
        <canvas
          key={run.id}
          ref={canvas}
          className="rio-celebrations__canvas"
          data-size={run.celebration.size}
          style={{ pointerEvents: 'none' }}
        />
      ) : null}
    </div>
  );
}
