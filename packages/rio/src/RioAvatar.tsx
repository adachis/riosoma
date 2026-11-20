import { i18n } from '@lingui/core';
import { t } from '@lingui/core/macro';
import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { RIO_MOODS, type RioMood } from './moods';
import './RioAvatar.css';
import { mascotUrl } from './mascot';

export interface RioAvatarProps {
  mood?: RioMood;
  size: number;
  autoNap?: boolean;
  napDelaySeconds?: number;
  onPoke?: () => void;
  scene?: boolean;
  motion?: 'auto' | 'reduce';
}

const reducedMotionQuery = '(prefers-reduced-motion: reduce)';
function subscribeMotion(notify: () => void) {
  const query = window.matchMedia(reducedMotionQuery);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
}
const readMotion = () => window.matchMedia(reducedMotionQuery).matches;
const serverMotion = () => false;
const subscribeLanguage = (notify: () => void) => i18n.on('change', notify);
const readLanguage = () => i18n.messages;

function moodName(mood: RioMood) {
  switch (mood) {
    case 'idle':
      return t({ id: 'rio.mood.idle', message: 'idle' });
    case 'thinking':
      return t({ id: 'rio.mood.thinking', message: 'thinking' });
    case 'happy':
      return t({ id: 'rio.mood.happy', message: 'happy' });
    case 'oops':
      return t({ id: 'rio.mood.oops', message: 'oops' });
    case 'napping':
      return t({ id: 'rio.mood.napping', message: 'napping' });
    case 'celebrating':
      return t({ id: 'rio.mood.celebrating', message: 'celebrating' });
  }
}

function avatarLabel(mood: string) {
  return t({ id: 'rio.avatar.label', message: `Rio, ${mood}` });
}

function Face({ mood }: { mood: RioMood }) {
  const happy = mood === 'happy' || mood === 'celebrating';
  const sleep = mood === 'napping';
  const normal = mood === 'idle' || mood === 'thinking';
  const mouth = {
    idle: undefined,
    thinking: 'M106 527 L162 522',
    happy: 'M86 518 Q134 556 182 518',
    celebrating: 'M78 512 Q134 590 190 512 Q134 526 78 512 Z',
    oops: 'M86 532 Q101 514 117 530 Q133 546 149 530 Q165 514 181 530',
  };
  return (
    <g className="rio-avatar__face" data-face={mood}>
      <g className={normal ? 'rio-avatar__blink' : undefined}>
        {[95, 176].map((x) =>
          happy || sleep ? (
            <path
              key={x}
              d={happy ? `M${x - 22} 469 Q${x} 436 ${x + 22} 469` : `M${x - 22} 456 Q${x} 478 ${x + 22} 456`}
              fill="none"
              stroke="var(--rio-surface)"
              strokeWidth="15"
              strokeLinecap="round"
            />
          ) : (
            <ellipse
              key={x}
              cx={x}
              cy="460"
              rx={normal ? 21.5 : 27}
              ry={normal ? 21.5 : 27}
              fill="var(--rio-surface)"
            />
          ),
        )}
      </g>
      {sleep ? (
        <ellipse cx="134" cy="530" rx="13" ry="10" fill="var(--rio-surface)" />
      ) : mood === 'idle' ? (
        <use href={`${mascotUrl}#mouth`} fill="var(--rio-surface)" />
      ) : (
        <path
          d={mouth[mood]}
          fill={mood === 'celebrating' ? 'var(--rio-surface)' : 'none'}
          stroke="var(--rio-surface)"
          strokeWidth="17"
          strokeLinecap="round"
        />
      )}
    </g>
  );
}

function Extras() {
  return (
    <g className="rio-avatar__extras" fill="var(--rio-text)" aria-hidden="true">
      <g data-extra="thinking">
        {[
          [28, 330, 11],
          [-4, 284, 17],
          [-46, 222, 26],
        ].map(([x, y, r], i) => (
          <circle key={i} cx={x} cy={y} r={r} style={{ '--rio-part': i } as CSSProperties} />
        ))}
      </g>
      <path
        data-extra="oops"
        d="M-18 358 C-6 378 2 390 2 400 A20 20 0 0 1 -38 400 C-38 390 -30 378 -18 358 Z"
        fill="var(--rio-accent)"
      />
      <g data-extra="napping">
        {[0, 1, 2].map((i) => (
          <path
            key={i}
            d="M-30 280 h40 l-40 40 h40"
            fill="none"
            stroke="var(--rio-text)"
            strokeWidth="9"
            style={{ '--rio-part': i } as CSSProperties}
          />
        ))}
      </g>
      <g data-extra="celebrating">
        {Array.from({ length: 12 }, (_, i) => (
          <rect
            key={i}
            x={-65 + i * 60}
            y={-40 + (i % 3) * 55}
            width="22"
            height="10"
            rx="3"
            style={{ '--rio-part': i } as CSSProperties}
            fill={i % 2 ? 'var(--rio-accent)' : 'var(--rio-text)'}
          />
        ))}
      </g>
    </g>
  );
}

/** A single deadline sleeps with the tab or avatar, without frames or interval polling. */
function visibleDelay(root: HTMLSpanElement | null, callback: () => void, milliseconds: number) {
  let remaining = milliseconds;
  let started = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', update);
    root?.removeEventListener('rio-avatar-visibility', update);
  };
  const update = () => {
    if (timer !== undefined) {
      remaining = Math.max(0, remaining - (Date.now() - started));
      clearTimeout(timer);
      timer = undefined;
    }
    if (document.hidden || root?.dataset.offscreen === 'true') return;
    started = Date.now();
    timer = setTimeout(() => {
      cancel();
      callback();
    }, remaining);
  };
  document.addEventListener('visibilitychange', update);
  root?.addEventListener('rio-avatar-visibility', update);
  update();
  return cancel;
}

function BodyPose({ mood, reduced, children }: { mood: RioMood; reduced: boolean; children: ReactNode }) {
  const element = useRef<SVGGElement>(null);
  const blend = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const body = element.current;
    if (!body) return;
    const previous = body.dataset.bodyMood;
    const outgoing = getComputedStyle(body).transform;
    blend.current?.cancel();
    body.style.removeProperty('animation-play-state');
    body.dataset.bodyMood = mood;
    if (!previous || previous === mood || reduced || document.hidden || !body.animate) return;
    // Hold the next loop at its first pose until the outgoing pose has reached it.
    body.style.animationPlayState = 'paused';
    const incoming = getComputedStyle(body).transform;
    if (outgoing === incoming) {
      body.style.removeProperty('animation-play-state');
      return;
    }
    const transition = body.animate([{ transform: outgoing }, { transform: incoming }], {
      duration: 400,
      easing: 'ease-in-out',
    });
    blend.current = transition;
    void transition.finished.catch(() => {});
    transition.onfinish = () => {
      body.style.removeProperty('animation-play-state');
      transition.cancel();
      if (blend.current === transition) blend.current = null;
    };
  }, [mood, reduced]);
  useEffect(() => {
    const body = element.current;
    const root = body?.closest('.rio-avatar');
    const update = () => {
      if (document.hidden || root?.getAttribute('data-offscreen') === 'true') blend.current?.pause();
      else if (blend.current?.playState === 'paused') blend.current.play();
    };
    document.addEventListener('visibilitychange', update);
    root?.addEventListener('rio-avatar-visibility', update);
    return () => {
      blend.current?.cancel();
      document.removeEventListener('visibilitychange', update);
      root?.removeEventListener('rio-avatar-visibility', update);
    };
  }, []);
  return (
    <g ref={element} className="rio-avatar__body">
      {children}
    </g>
  );
}

export function RioAvatar({
  mood = 'idle',
  size,
  autoNap = true,
  napDelaySeconds = 12,
  onPoke,
  scene = false,
  motion = 'auto',
}: RioAvatarProps) {
  const clipId = `${useId()}-clip`;
  const root = useRef<HTMLSpanElement>(null);
  const pokeTimeout = useRef<(() => void) | undefined>(undefined);
  const [state, setState] = useState({ source: mood, mood, interaction: 0 });
  // A controlled mood change supersedes both a nap and an in-flight poke reaction.
  if (state.source !== mood) setState({ source: mood, mood, interaction: state.interaction + 1 });
  const activeMood = state.source === mood ? state.mood : mood;
  const systemReduced = useSyncExternalStore(subscribeMotion, readMotion, serverMotion);
  useSyncExternalStore(subscribeLanguage, readLanguage, readLanguage);
  const reduced = motion === 'reduce' || systemReduced;

  useEffect(() => {
    pokeTimeout.current?.();
    return () => pokeTimeout.current?.();
  }, [mood]);

  useEffect(() => {
    if (!autoNap || activeMood !== 'idle') return;
    return visibleDelay(
      root.current,
      () => setState((value) => ({ ...value, mood: 'napping' })),
      Math.max(0, napDelaySeconds) * 1000,
    );
  }, [activeMood, autoNap, napDelaySeconds, state.interaction]);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const visibility = () => {
      element.dataset.hidden = String(document.hidden);
    };
    visibility();
    document.addEventListener('visibilitychange', visibility);
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? undefined
        : new IntersectionObserver((entries) => {
            for (const entry of entries)
              if (entry.target === element) {
                element.dataset.offscreen = String(!entry.isIntersecting);
                element.dispatchEvent(new Event('rio-avatar-visibility'));
              }
          });
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  function poke() {
    if (activeMood !== 'happy' && activeMood !== 'celebrating') {
      pokeTimeout.current?.();
      const sleeping = activeMood === 'napping';
      setState((value) => ({
        ...value,
        mood: sleeping ? 'oops' : 'happy',
        interaction: value.interaction + 1,
      }));
      pokeTimeout.current = visibleDelay(
        root.current,
        () => {
          // As in the prototype: a startled Rio settles to idle rather than back into oops.
          setState((value) => ({ ...value, mood: sleeping || activeMood === 'oops' ? 'idle' : activeMood }));
        },
        sleeping ? 1300 : 1600,
      );
    }
    onPoke?.();
  }

  const label = avatarLabel(moodName(activeMood));
  const artwork = (
    <svg
      viewBox="-110 -90 810 810"
      width={size}
      height={size}
      role={onPoke ? undefined : 'img'}
      aria-hidden={onPoke ? true : undefined}
      aria-label={onPoke ? undefined : label}
      className="rio-avatar__svg"
      data-scene={scene}
    >
      <defs>
        <clipPath id={clipId}>
          <circle cx="155" cy="507" r="160" />
        </clipPath>
        <mask id={`${clipId}-limbs`} maskUnits="userSpaceOnUse" x="-200" y="-200" width="1200" height="1200">
          <rect x="-200" y="-200" width="1200" height="1200" fill="white" />
          <circle cx="155" cy="507" r="157" fill="black" />
        </mask>
      </defs>
      {scene && <rect x="-110" y="-90" width="810" height="810" fill="var(--rio-bg)" />}
      <ellipse
        className="rio-avatar__shadow"
        cx="155"
        cy="672"
        rx="130"
        ry="14"
        fill="var(--rio-text)"
        opacity=".12"
      />
      <g className="rio-avatar__pose">
        <BodyPose mood={activeMood} reduced={reduced}>
          <g className="rio-avatar__limbs">
            <use href={`${mascotUrl}#body`} fill="var(--rio-text)" mask={`url(#${clipId}-limbs)`} />
            <g fill="var(--rio-surface)" className="rio-avatar__openings">
              {(['opening-top', 'opening-left', 'opening-right'] as const).map((id) => (
                <use key={id} href={`${mascotUrl}#${id}`} />
              ))}
            </g>
            <g fill="var(--rio-surface)">
              {Array.from({ length: 7 }, (_, i) => (
                <use key={i} href={`${mascotUrl}#highlight-${i + 1}`} />
              ))}
            </g>
          </g>
          <use href={`${mascotUrl}#body`} fill="var(--rio-text)" clipPath={`url(#${clipId})`} />
          {RIO_MOODS.map((face) => (
            <Face key={face} mood={face} />
          ))}
        </BodyPose>
      </g>
      <Extras />
    </svg>
  );

  return (
    <span
      ref={root}
      className="rio-avatar"
      data-mood={activeMood}
      data-motion={reduced ? 'reduce' : 'auto'}
      data-small={size <= 48}
      style={{ inlineSize: size, blockSize: size }}
    >
      {onPoke ? (
        <button
          type="button"
          className="rio-avatar__button"
          aria-label={t({ id: 'rio.avatar.poke', message: 'Rio' })}
          onClick={poke}
        >
          {artwork}
        </button>
      ) : (
        artwork
      )}
    </span>
  );
}
