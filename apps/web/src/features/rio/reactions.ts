import type { RioMood } from '@riosoma/rio';

/**
 * How the rest of the app asks Rio to react without reaching into the assistant: a mood for a few
 * seconds, after which Rio goes back to whatever it was doing, or a short dance.
 */
export type RioReaction = { kind: 'mood'; mood: RioMood; seconds: number } | { kind: 'dance' };

/** How long a dance lasts, which the stylesheet's dance keyframes match */
export const RIO_DANCE_MS = 2400;

const listeners = new Set<(reaction: RioReaction) => void>();

/** Asks Rio to react.  Nothing happens when no assistant is on the page. */
export function rioReact(reaction: RioReaction): void {
  for (const listener of listeners) listener(reaction);
}

export function subscribeRioReactions(listener: (reaction: RioReaction) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
