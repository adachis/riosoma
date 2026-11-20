import { GRID_SHORTCUT_BINDINGS, shortcutCombos } from '../../../../packages/grid-core/src/shortcuts';
import type { PlatformShortcutBinding } from '../../../../packages/grid-core/src/shortcuts';
export { shortcutCombos } from '../../../../packages/grid-core/src/shortcuts';
export type ShortcutId =
  | (typeof GRID_SHORTCUT_BINDINGS)[number]['id']
  | 'settings.save'
  | 'palette.open'
  | 'help.open'
  | 'undo.history'
  | 'feedback.open'
  | 'demo.stop'
  | 'reorder.pick'
  | 'reorder.pickEnter'
  | 'reorder.up'
  | 'reorder.down'
  | 'reorder.in'
  | 'reorder.out'
  | 'reorder.cancel'
  | 'reorder.upNow'
  | 'reorder.downNow'
  | 'views.moveLeft'
  | 'views.moveRight'
  | 'views.moveUp'
  | 'views.moveDown'
  | 'views.endUp'
  | 'views.endDown'
  | 'views.endLeft'
  | 'views.endRight'
  | 'views.dependencies';

export interface ShortcutBinding extends PlatformShortcutBinding {
  id: ShortcutId;
  /** The modifiers and key, with the key last, such as `Mod+Shift+K`. */
  combo: string;
  alternatives?: readonly string[];
  /** Keeps the shortcut available while a cell or field holds focus. */
  whileTyping?: boolean;
}

export const SHORTCUT_BINDINGS: readonly ShortcutBinding[] = [
  { id: 'help.open', combo: 'F1', whileTyping: true },
  ...GRID_SHORTCUT_BINDINGS,
  {
    id: 'settings.save',
    combo: 'Mod+S',
    whileTyping: true,
  },
  {
    id: 'views.moveLeft',
    combo: 'Alt+ArrowLeft',
  },
  {
    id: 'views.moveRight',
    combo: 'Alt+ArrowRight',
  },
  {
    id: 'views.moveUp',
    combo: 'Alt+ArrowUp',
  },
  {
    id: 'views.moveDown',
    combo: 'Alt+ArrowDown',
  },
  {
    id: 'views.endUp',
    combo: 'Alt+Shift+ArrowUp',
  },
  {
    id: 'views.endDown',
    combo: 'Alt+Shift+ArrowDown',
  },
  {
    id: 'views.endLeft',
    combo: 'Shift+ArrowLeft',
  },
  {
    id: 'views.endRight',
    combo: 'Shift+ArrowRight',
  },
  {
    id: 'views.dependencies',
    combo: 'Alt+D',
  },

  {
    id: 'palette.open',
    combo: 'Mod+K',
    // Getting out of a cell is exactly when someone reaches for the palette, so this one keeps
    // working while a field has focus.
    whileTyping: true,
  },
  {
    // Beside redo's Mod+Shift+Z.  The grid keeps its focus in a text field of its own, so this one
    // works while typing too.
    id: 'undo.history',
    combo: 'Mod+Alt+Z',
    whileTyping: true,
  },
  {
    // Something breaking mid-edit is exactly when someone wants to say so, so this one works while
    // typing too.  Holding two modifiers keeps it clear of anything a person types.
    id: 'feedback.open',
    combo: 'Mod+Alt+F',
    whileTyping: true,
  },
  {
    // Bound only while a "Show me" demo plays.  A demo can type into a field, so Escape has to
    // stop it from there too.
    id: 'demo.stop',
    combo: 'Escape',
    whileTyping: true,
  },
  // These keys are bound only to a focused reorder handle
  {
    id: 'reorder.pick',
    combo: 'Space',
  },
  {
    id: 'reorder.pickEnter',
    combo: 'Enter',
  },
  {
    id: 'reorder.up',
    combo: 'ArrowUp',
  },
  {
    id: 'reorder.down',
    combo: 'ArrowDown',
  },
  {
    id: 'reorder.in',
    combo: 'ArrowRight',
  },
  {
    id: 'reorder.out',
    combo: 'ArrowLeft',
  },
  {
    id: 'reorder.cancel',
    combo: 'Escape',
  },
  {
    id: 'reorder.upNow',
    combo: 'Alt+ArrowUp',
  },
  {
    id: 'reorder.downNow',
    combo: 'Alt+ArrowDown',
  },
];

const BINDINGS_BY_ID = new Map<string, ShortcutBinding>(
  SHORTCUT_BINDINGS.map((binding) => [binding.id, binding]),
);

export interface Combo {
  /** The key itself, lowercased. */
  key: string;
  /** The platform's primary modifier. */
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export function parseCombo(combo: string): Combo {
  const parts = combo.split('+').map((part) => part.trim().toLowerCase());
  const key = parts.pop() ?? '';
  return {
    key,
    mod: parts.includes('mod'),
    ctrl: parts.includes('ctrl'),
    alt: parts.includes('alt'),
    shift: parts.includes('shift'),
    meta: parts.includes('meta'),
  };
}

/** What this device calls the platform: Apple's keyboards print ⌘, everyone else's print Ctrl. */
export function isAppleDevice(
  device: { userAgent?: string; platform?: string } = globalThis.navigator ?? {},
): boolean {
  if (/mac|iphone|ipad|ipod/i.test(device.userAgent ?? '')) return true;
  // An agent can be vague about the device, and an iPad asking for desktop sites calls itself a
  // Mac, so the platform gets a say too.
  return /^mac/i.test(device.platform ?? '');
}

type Modifier = 'ctrl' | 'alt' | 'shift' | 'mod';

const APPLE_SYMBOLS: Record<Modifier, string> = {
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  mod: '⌘',
};
const WORDS: Record<Modifier, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  mod: 'Ctrl',
};
/** Apple prints ⌘ last; everyone else reads Ctrl first. */
const APPLE_ORDER: readonly Modifier[] = ['ctrl', 'alt', 'shift', 'mod'];
const WORD_ORDER: readonly Modifier[] = ['mod', 'ctrl', 'alt', 'shift'];

function keyText(key: string, written: string): string {
  if (key.length === 1) return key.toUpperCase();
  if (key === 'escape') return 'Esc';
  const arrows: Record<string, string> = { arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓' };
  if (arrows[key]) return arrows[key];
  return written
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * The combination as this device writes it: `⌘K` on an Apple device, `Ctrl+K` elsewhere.  Symbols
 * go in the order Apple's own keyboards print them, and words in the order people read them.
 */
export function comboText(combo: string, apple: boolean = isAppleDevice()): string {
  const parts = parseCombo(combo);
  const order = apple ? APPLE_ORDER : WORD_ORDER;
  const names = apple ? APPLE_SYMBOLS : WORDS;
  const held = order.filter((name) => parts[name]);
  const key = keyText(parts.key, combo.split('+').at(-1) ?? parts.key);
  if (apple) return `${held.map((name) => names[name]).join('')}${key}`;
  const words = held.map((name) => names[name]);
  return words.length === 0 ? key : `${words.join('+')}+${key}`;
}

/** The keys for a registered shortcut, or nothing when the id isn't one the app knows. */
export function shortcutKeyParts(id: string, apple: boolean = isAppleDevice()): string[] {
  const shortcut = BINDINGS_BY_ID.get(id);
  return shortcut ? shortcutCombos(shortcut, apple).map((combo) => comboText(combo, apple)) : [];
}

export function shortcutKeys(id: string, apple: boolean = isAppleDevice()): string {
  return shortcutKeyParts(id, apple).join(' / ');
}

/** Everything a dispatch needs from a keyboard event. */
export interface KeyState {
  key: string;
  /** The key's place on the keyboard, such as `KeyZ`, whatever it types */
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Whether an event is this combination.  `Mod` answers to either primary modifier: the keys are
 * shown the way this device writes them, and holding down the one a keyboard actually has is what
 * counts, whichever the operating system calls it primary.
 */
export function matchesCombo(event: KeyState, combo: string, apple: boolean = isAppleDevice()): boolean {
  const parts = parseCombo(combo);
  if (parts.mod) {
    if (!event.metaKey && !event.ctrlKey) return false;
  } else if (event.ctrlKey !== parts.ctrl || event.metaKey !== parts.meta) return false;
  if (event.altKey !== parts.alt) return false;
  if (event.shiftKey !== parts.shift) return false;
  if (parts.ctrl && !event.ctrlKey) return false;
  if (parts.meta && !event.metaKey) return false;
  if (event.key.toLowerCase() === parts.key) return true;
  // Option changes the letter an Apple keyboard types, so there the key's place counts.  Elsewhere
  // Ctrl and Alt together can be AltGr typing a letter of its own, which isn't a shortcut.
  return apple && parts.alt && /^[a-z]$/.test(parts.key) && event.code === `Key${parts.key.toUpperCase()}`;
}

const EDITABLE =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], [role="searchbox"], [role="gridcell"]';

/**
 * Whether the event came from somewhere that takes text: a field, a cell, or editable content.
 * A shortcut that doesn't ask for `whileTyping` never fires here, so it can't eat a key someone
 * meant for what they're writing.
 */
export function isTypingTarget(target: unknown): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  return target.closest(EDITABLE) !== null;
}
