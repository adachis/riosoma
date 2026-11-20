import { useEffect, useRef } from 'react';
import {
  isAppleDevice,
  isTypingTarget,
  matchesCombo,
  shortcutCombos,
  SHORTCUT_BINDINGS as SHORTCUTS,
  type ShortcutId,
} from './runtime';

export type ShortcutHandler = (event: KeyboardEvent) => void;

/**
 * Every shortcut the app knows fires through one window listener, so a page never ends up with a
 * listener per component and a key can't be claimed twice by accident.
 *
 * The listener is on the way down rather than the way up: a cell editor keeps keys from travelling
 * past it, which is exactly where ⌘K has to keep working.
 */
const handlers = new Map<ShortcutId, Set<ShortcutHandler>>();
let attached = false;

function dispatch(event: KeyboardEvent) {
  // Something that saw the key first already claimed it.
  if (event.defaultPrevented) return;
  for (const shortcut of SHORTCUTS) {
    const bound = handlers.get(shortcut.id);
    if (!bound || bound.size === 0) continue;
    if (!shortcutCombos(shortcut, isAppleDevice()).some((combo) => matchesCombo(event, combo))) continue;
    if (!shortcut.whileTyping && isTypingTarget(event.target)) continue;
    // The browser has its own idea about some of these combinations; the app's shortcut wins.
    event.preventDefault();
    for (const handler of [...bound]) handler(event);
  }
}

function attach() {
  if (attached || typeof window === 'undefined') return;
  window.addEventListener('keydown', dispatch, true);
  attached = true;
}

function detach() {
  if (!attached || typeof window === 'undefined') return;
  window.removeEventListener('keydown', dispatch, true);
  attached = false;
}

/**
 * Binds a handler to a registered shortcut while the calling component is mounted.  The handler
 * may be a new function on every render; the binding itself doesn't move.
 */
export function useShortcut(id: ShortcutId, handler: ShortcutHandler): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    const bound: ShortcutHandler = (event) => latest.current(event);
    const set = handlers.get(id) ?? new Set<ShortcutHandler>();
    handlers.set(id, set);
    set.add(bound);
    attach();
    return () => {
      set.delete(bound);
      if (set.size === 0) handlers.delete(id);
      if (handlers.size === 0) detach();
    };
  }, [id]);
}
