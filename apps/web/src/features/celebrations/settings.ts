import type { Preferences } from '@riosoma/contracts';
import type { CelebrationLevel } from './engine';

export type SoundLevel = 'off' | 'quiet' | 'normal';

/** Celebrations are on until someone turns them down. */
export function celebrationLevel(preferences: Preferences | undefined): CelebrationLevel {
  return preferences?.celebrations ?? 'on';
}

/** Sounds are off until someone turns them on. */
export function soundLevel(preferences: Preferences | undefined): SoundLevel {
  return preferences?.soundLevel ?? 'off';
}

/** Whether the person picked a sound level themselves, rather than living with the default */
export function soundChosen(preferences: Preferences | undefined): boolean {
  return preferences?.soundLevel !== undefined;
}

const REDUCED = '(prefers-reduced-motion: reduce)';

/** The system's reduced motion setting, unless the person set motion for Riosoma on its own. */
export function reducedMotion(preferences: Preferences | undefined): boolean {
  if (preferences?.motion === 'reduce') return true;
  if (preferences?.motion === 'full') return false;
  return systemReducedMotion();
}

export function systemReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && Boolean(window.matchMedia?.(REDUCED)?.matches);
  } catch {
    return false;
  }
}
