import { LEVELS, levelRank, lowerLevel, type Level } from '@riosoma/contracts';

/**
 * The features above someone's level that they opened through the palette lately, which is what
 * the quiet suggestion to move up counts.  They stay in this browser: the suggestion is a
 * convenience, and missing one costs nothing.  Its dismissal is what has to last, so that goes
 * with the person's preferences instead.
 */
export interface LevelUse {
  /** The level of the feature that was opened */
  level: Level;
  /** When, in milliseconds since the epoch */
  at: number;
}

/** How far back uses count */
export const USE_WINDOW_MS = 7 * 86_400_000;
/** How many uses in that window bring the suggestion */
export const USES_TO_SUGGEST = 3;
/** Enough to fill the window many times over, so a busy week can't grow the list without end */
const MAX_USES = 50;

const key = (personId: string) => `rio.levelUses.${personId}`;

function isUse(value: unknown): value is LevelUse {
  if (typeof value !== 'object' || value === null) return false;
  const { level, at } = value as Record<string, unknown>;
  return (LEVELS as readonly unknown[]).includes(level) && typeof at === 'number' && Number.isFinite(at);
}

/** The uses from the last week.  Storage that is off or holds something else reads as none. */
export function readUses(personId: string, now: number = Date.now()): LevelUse[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key(personId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isUse).filter((use) => now - use.at < USE_WINDOW_MS) : [];
  } catch {
    return [];
  }
}

/** Remembers one more use, and returns the week's uses with it. */
export function recordUse(personId: string, level: Level, now: number = Date.now()): LevelUse[] {
  const uses = [...readUses(personId, now), { level, at: now }].slice(-MAX_USES);
  try {
    localStorage.setItem(key(personId), JSON.stringify(uses));
  } catch {
    // Storage off: the use still counts for this visit.
  }
  return uses;
}

/**
 * The level to suggest, or null for none.  Three uses above the person's level in a week bring
 * it, and it offers the highest level they reached for that they're allowed, so one yes covers
 * what they were looking for.
 */
export function suggestedLevel(
  uses: readonly LevelUse[],
  current: Level,
  highest: Level,
  now: number = Date.now(),
): Level | null {
  const above = uses.filter(
    (use) => now - use.at < USE_WINDOW_MS && levelRank(use.level) > levelRank(current),
  );
  if (above.length < USES_TO_SUGGEST) return null;
  const reached = above.reduce<Level>(
    (top, use) => (levelRank(use.level) > levelRank(top) ? use.level : top),
    current,
  );
  const target = lowerLevel(reached, highest);
  return levelRank(target) > levelRank(current) ? target : null;
}
