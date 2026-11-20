import { useEffect, useSyncExternalStore } from 'react';
import type { ThemeChoice } from '@riosoma/tokens';

/**
 * A theme that something on screen shows in place of the person's own, for as long as it's on
 * screen: a database that forces its theme while it's open.  The shell's theme follows it and
 * goes back to the person's own the moment it's gone.  The newest one wins, and one that leaves
 * after another took its place leaves that one alone.
 */
let current: { owner: symbol; choice: ThemeChoice } | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The theme shown in place of the person's own right now, or null. */
export function themeOverride(): ThemeChoice | null {
  return current?.choice ?? null;
}

/** Shows `choice` in place of the person's own theme while the calling component is on screen. */
export function useThemeOverride(choice: ThemeChoice | null): void {
  const key = choice ? [choice.theme, choice.scheme ?? '', choice.mode ?? ''].join('|') : '';
  useEffect(() => {
    if (!key) return;
    const [theme = '', scheme, mode] = key.split('|');
    const owner = Symbol('theme override');
    current = { owner, choice: { theme, scheme: scheme || undefined, mode: mode || undefined } };
    emit();
    return () => {
      if (current?.owner !== owner) return;
      current = null;
      emit();
    };
  }, [key]);
}

/** The theme shown in place of the person's own, kept current. */
export function useOverriddenTheme(): ThemeChoice | null {
  return useSyncExternalStore(subscribe, themeOverride, themeOverride);
}
