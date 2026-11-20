import type { Level } from './levels.js';

export const LEVELS = ['simple', 'standard', 'advanced'] as const;

/** Where members start when nobody has chosen otherwise */
export const DEFAULT_LEVEL: Level = 'standard';
/** Where guests start, whatever the organization's default */
export const GUEST_LEVEL: Level = 'simple';

/** How far up a level is, so levels compare as numbers. */
export function levelRank(level: Level): number {
  return LEVELS.indexOf(level);
}

/** Whether someone at `level` sees what `needed` offers. */
export function reaches(level: Level, needed: Level): boolean {
  return levelRank(level) >= levelRank(needed);
}

/** The lower of two levels. */
export function lowerLevel(left: Level, right: Level): Level {
  return levelRank(left) <= levelRank(right) ? left : right;
}

/** The higher of two levels. */
export function higherLevel(left: Level, right: Level): Level {
  return levelRank(left) >= levelRank(right) ? left : right;
}

/** The organization's choices, as they sit in its settings. */
export interface OrgLevelSettings {
  /** Where members and owners start until they choose.  Absent reads as Standard. */
  defaultLevel?: Level;
  /** The highest level a guest can choose.  Absent reads as Advanced, so no limit. */
  guestLevel?: Level;
}

export interface LevelsFor {
  /** The level the person works at now */
  level: Level;
  /** The highest they can choose */
  highest: Level;
  /** Where they start before choosing, and where "use the default" puts them */
  start: Level;
  /** Whether the level is the person's own choice rather than a default */
  chosen: boolean;
}

/**
 * The level someone works at.  Their own choice wins, then where people of their kind start: the
 * organization's default for members and owners, and Simple for guests.  A guest never goes above
 * the highest level the organization allows guests, even with a choice made before it was set.
 */
export function levelsFor(
  kind: 'owner' | 'member' | 'guest',
  settings: OrgLevelSettings | undefined,
  choice: Level | undefined,
): LevelsFor {
  const highest = kind === 'guest' ? (settings?.guestLevel ?? 'advanced') : 'advanced';
  const start = lowerLevel(
    kind === 'guest' ? GUEST_LEVEL : (settings?.defaultLevel ?? DEFAULT_LEVEL),
    highest,
  );
  return { level: lowerLevel(choice ?? start, highest), highest, start, chosen: choice !== undefined };
}
