import { Suspense, useEffect, useState } from 'react';
import type { RioAvatarProps } from '@riosoma/rio';
import { RestingAvatar } from '../../../../../packages/rio/src/RestingAvatar';
import { lazyFeature } from '../../shell/lazy';

const MovingAvatar = lazyFeature(() =>
  import('@riosoma/rio').then((module) => ({ default: module.RioAvatar })),
);

/** A nap or reaction is the first reason to request the companion's moving states. */
export function DeferredAvatar(props: RioAvatarProps) {
  const [state, setState] = useState({ source: props.mood, napping: false, active: false });
  const needsMotion = Boolean(props.mood && props.mood !== 'idle') || Boolean(props.onPoke);
  if (state.source !== props.mood || (needsMotion && !state.active))
    setState({ source: props.mood, napping: false, active: state.active || needsMotion });
  useEffect(() => {
    if (props.autoNap === false || state.active) return;
    let remaining = Math.max(0, props.napDelaySeconds ?? 12) * 1000;
    let started = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      if (timer !== undefined) {
        remaining = Math.max(0, remaining - (Date.now() - started));
        clearTimeout(timer);
        timer = undefined;
      }
      if (document.hidden) return;
      started = Date.now();
      timer = setTimeout(() => setState((value) => ({ ...value, napping: true, active: true })), remaining);
    };
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [props.autoNap, props.napDelaySeconds, state.active]);
  const resting = <RestingAvatar size={props.size} />;
  if (!state.active && !needsMotion) return resting;
  return (
    <Suspense fallback={resting}>
      <MovingAvatar
        {...props}
        mood={state.napping && (!props.mood || props.mood === 'idle') ? 'napping' : props.mood}
      />
    </Suspense>
  );
}
