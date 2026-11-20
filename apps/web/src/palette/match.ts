import { GROUP_ORDER, type PaletteEntry, type PaletteGroup } from './types';

/** How many rows a group shows while filtering, so one crowded group can't push the rest away. */
export const GROUP_CAP = 8;

/** A match in a row's second line counts, but never beats a match in its own label. */
const SECONDARY_PENALTY = 400;

/** Characters that start a new word inside a name. */
const WORD_EDGE = /[\s\-_./\\·]/;

export interface PaletteSection {
  group: PaletteGroup;
  entries: PaletteEntry[];
}

/**
 * A simple fuzzy match: every character of the query has to turn up in order, and how well they
 * line up decides the rank.  Lower scores come first and `null` means no match at all.
 *
 * A name that starts with the query beats one that merely contains it, a match at the start of a
 * word inside the name beats one buried in the middle of a word, and an earlier match beats a
 * later one.  Skipped characters count a little against a match, so a name spelled the way it was
 * typed stays on top.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const haystack = text.toLowerCase();
  let from = 0;
  let first = -1;
  let words = 0;
  let gaps = 0;
  for (const char of needle) {
    const at = haystack.indexOf(char, from);
    if (at < 0) return null;
    const previous = at > 0 ? haystack[at - 1] : undefined;
    if (at === 0 || (previous !== undefined && WORD_EDGE.test(previous))) words += 1;
    if (first < 0) first = at;
    else if (at > from) gaps += 1;
    from = at + 1;
  }
  const base = haystack.startsWith(needle) ? 0 : words > 0 ? 100 : 200;
  return base + first * 4 + gaps * 6 - words * 25;
}

/** The best match for a row across its label and its second line, or null when neither matches. */
export function entryScore(query: string, entry: Pick<PaletteEntry, 'label' | 'secondary'>): number | null {
  const label = fuzzyScore(query, entry.label);
  const secondary = entry.secondary === undefined ? null : fuzzyScore(query, entry.secondary);
  if (label === null && secondary === null) return null;
  const scores = [
    ...(label === null ? [] : [label]),
    ...(secondary === null ? [] : [secondary + SECONDARY_PENALTY]),
  ];
  return Math.min(...scores);
}

/**
 * The rows to show, grouped and ranked.  With nothing typed every row is kept in the order its
 * group gave it; while typing, each group is filtered and ranked on its own and cut off at `cap`.
 * A group with nothing to show leaves the list out, so no empty headers.
 */
export function selectGroups(
  query: string,
  entries: readonly PaletteEntry[],
  cap: number = GROUP_CAP,
): PaletteSection[] {
  const filtering = query.trim().length > 0;
  const sections: PaletteSection[] = [];
  for (const group of GROUP_ORDER) {
    const inGroup = entries.filter((entry) => entry.group === group);
    if (inGroup.length === 0) continue;
    if (!filtering) {
      sections.push({ group, entries: inGroup });
      continue;
    }
    const matched = inGroup
      .map((entry) => ({
        entry,
        // Settings already match translated keywords and help, including words in any order.
        score:
          group === 'settings' ? (entryScore(query, entry) ?? SECONDARY_PENALTY) : entryScore(query, entry),
      }))
      .filter((candidate): candidate is { entry: PaletteEntry; score: number } => candidate.score !== null)
      .sort((left, right) => left.score - right.score)
      .slice(0, cap)
      .map((candidate) => candidate.entry);
    if (matched.length > 0) sections.push({ group, entries: matched });
  }
  return sections;
}
