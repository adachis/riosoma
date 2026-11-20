/** A place the palette has opened, kept so the next one starts with somewhere to go. */
export interface RecentPlace {
  id: string;
  kind: 'databases' | 'tables' | 'views';
  label: string;
  secondary?: string;
  /** Only same-origin paths are remembered, so a stale or edited value can't point elsewhere. */
  path: string;
}

export const RECENT_LIMIT = 5;

const KEY = 'rio.recentPlaces';
const KINDS: readonly RecentPlace['kind'][] = ['databases', 'tables', 'views'];

// Storage can be turned off or full.  The list then lives for as long as this page does, which is
// enough for a palette that is opened and closed in one sitting.
let inMemory: RecentPlace[] = [];

function isRecentPlace(value: unknown): value is RecentPlace {
  if (typeof value !== 'object' || value === null) return false;
  const place = value as Record<string, unknown>;
  return (
    typeof place.id === 'string' &&
    typeof place.label === 'string' &&
    typeof place.path === 'string' &&
    place.path.startsWith('/') &&
    !place.path.startsWith('//') &&
    KINDS.includes(place.kind as RecentPlace['kind']) &&
    (place.secondary === undefined || typeof place.secondary === 'string')
  );
}

/** The remembered places, newest first.  Never throws, whatever storage does. */
export function readRecent(): RecentPlace[] {
  let stored: string | null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    // Storage off: the copy from this visit is all there is.
    return [...inMemory];
  }
  if (stored === null) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentPlace).slice(0, RECENT_LIMIT);
  } catch {
    // Something else wrote this key, or the value was cut off mid-save.
    return [];
  }
}

/**
 * Puts a place at the front of the list and drops the one that falls off the end.  The returned
 * list is what the palette shows next.
 */
export function rememberPlace(place: RecentPlace): RecentPlace[] {
  const next = [place, ...readRecent().filter((item) => item.path !== place.path)].slice(0, RECENT_LIMIT);
  inMemory = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage off: the in-memory copy above carries the rest of this visit.
  }
  return next;
}

/** Forgets every place. */
export function clearRecent(): void {
  inMemory = [];
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored, nothing to remove.
  }
}
