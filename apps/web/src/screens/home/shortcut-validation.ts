import { ShortcutTarget } from '@riosoma/contracts';

/** Dragged shortcut data is checked before it can become a home command. */
export function parseShortcutTarget(value: unknown): ShortcutTarget {
  return ShortcutTarget.parse(value);
}
