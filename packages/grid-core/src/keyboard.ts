import { clamp } from './scroll.js';
import { GRID_SHORTCUT_BINDINGS, shortcutCombos } from './shortcuts.js';
import type { PlatformShortcutBinding } from './shortcuts.js';
import type { CellRef } from './types.js';

export type Motion =
  'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'pageUp' | 'pageDown' | 'next' | 'previous';
export type KeyCommand =
  | { kind: 'move'; motion: Motion; extend: boolean; jump: boolean }
  | {
      kind:
        | 'edit'
        | 'cancel'
        | 'clear'
        | 'toggle'
        | 'expand'
        | 'all'
        | 'undo'
        | 'redo'
        | 'context'
        | 'newline'
        | 'fillDown'
        | 'fillRight';
    }
  | { kind: 'commit'; motion: 'up' | 'down' | 'next' | 'previous' };

export function platformModifier(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>, mac: boolean) {
  return mac ? event.metaKey : event.ctrlKey;
}

export function letterKey(event: Pick<KeyboardEvent, 'key' | 'code'>): string {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  return /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : '';
}

function matchesBinding(event: KeyboardEvent, binding: PlatformShortcutBinding, mac: boolean): boolean {
  return shortcutCombos(binding, mac).some((combo) => {
    const parts = combo.toLowerCase().split('+');
    const key = parts.pop();
    const mod = parts.includes('mod');
    const ctrl = parts.includes('ctrl') || (mod && !mac);
    const meta = parts.includes('meta') || (mod && mac);
    return (
      event.ctrlKey === ctrl &&
      event.metaKey === meta &&
      event.altKey === parts.includes('alt') &&
      event.shiftKey === parts.includes('shift') &&
      (event.key.toLowerCase() === key || letterKey(event) === key)
    );
  });
}

/**
 * Ctrl+F (Cmd+F on a Mac) finds, and Ctrl+H (Cmd+Shift+H, since Cmd+H hides the app) replaces.
 * These work while a cell is being edited too, so they're read apart from the other keys.
 */
export function searchCommand(event: KeyboardEvent, mac: boolean): 'find' | 'replace' | null {
  if (event.isComposing || event.keyCode === 229 || event.altKey) return null;
  const binding = GRID_SHORTCUT_BINDINGS.find(
    (binding) => 'search' in binding && matchesBinding(event, binding, mac),
  );
  return binding && 'search' in binding ? binding.search : null;
}

export function keyCommand(
  event: KeyboardEvent,
  mac: boolean,
  editing = false,
  multiline = false,
): KeyCommand | null {
  if (event.isComposing || event.keyCode === 229) return null;
  const modifier = platformModifier(event, mac);
  const key = event.key;
  if (editing) {
    if (key === 'Escape') return { kind: 'cancel' };
    if (key === 'Enter') {
      if (multiline && (event.altKey || modifier)) return { kind: 'newline' };
      if (!event.altKey && !event.ctrlKey && !event.metaKey)
        return { kind: 'commit', motion: event.shiftKey ? 'up' : 'down' };
    }
    if (key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey)
      return { kind: 'commit', motion: event.shiftKey ? 'previous' : 'next' };
    return null;
  }
  if (event.altKey) return null;
  const modified = GRID_SHORTCUT_BINDINGS.find(
    (binding) =>
      'command' in binding &&
      binding.combo.includes('+') &&
      (matchesBinding(event, binding, mac) ||
        // Selection and Ctrl+Y have always tolerated Shift without changing their action.
        (event.shiftKey &&
          (binding.command === 'all' || binding.command === 'redo') &&
          matchesBinding(
            {
              key: event.key,
              code: event.code,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              altKey: event.altKey,
              shiftKey: false,
            } as KeyboardEvent,
            binding,
            mac,
          ))),
  );
  if (modified && 'command' in modified) return { kind: modified.command };
  const context = GRID_SHORTCUT_BINDINGS.find((binding) => binding.id === 'grid.context');
  if (
    context &&
    (key === context.combo ||
      context.alternatives.some((alternative) => alternative === `${event.shiftKey ? 'Shift+' : ''}${key}`))
  )
    return { kind: 'context' };
  if ((event.metaKey || event.ctrlKey) && !modifier) return null;
  const motion = GRID_SHORTCUT_BINDINGS.find((binding) => 'motion' in binding && binding.combo === key);
  if (motion && 'motion' in motion)
    return { kind: 'move', motion: motion.motion, extend: event.shiftKey, jump: modifier };
  if (modifier) return null;
  if (key === 'Tab')
    return { kind: 'move', motion: event.shiftKey ? 'previous' : 'next', extend: false, jump: false };
  const combo = `${event.shiftKey ? 'Shift+' : ''}${key === ' ' ? 'Space' : key}`;
  const action = GRID_SHORTCUT_BINDINGS.find(
    (binding) =>
      'command' in binding &&
      (binding.combo === combo ||
        ('alternatives' in binding && binding.alternatives.some((alternative) => alternative === combo))),
  );
  // Shift keeps the existing edit, cancel, and clear behavior when it is not part of the binding.
  const plain =
    action ??
    GRID_SHORTCUT_BINDINGS.find(
      (binding) =>
        'command' in binding &&
        ['edit', 'cancel', 'clear'].includes(binding.command) &&
        (binding.combo === key ||
          ('alternatives' in binding && binding.alternatives.some((alternative) => alternative === key))),
    );
  if (plain && 'command' in plain) return { kind: plain.command };
  return null;
}

export function moveCell(
  cell: CellRef,
  motion: Motion,
  rows: number,
  columns: number,
  page: number,
  rtl = false,
  jump = false,
): CellRef {
  if (!rows || !columns) return { row: 0, col: 0 };
  let { row, col } = cell;
  if (rtl && (motion === 'left' || motion === 'right')) motion = motion === 'left' ? 'right' : 'left';
  switch (motion) {
    case 'left':
      col = jump ? 0 : col - 1;
      break;
    case 'right':
      col = jump ? columns - 1 : col + 1;
      break;
    case 'up':
      row = jump ? 0 : row - 1;
      break;
    case 'down':
      row = jump ? rows - 1 : row + 1;
      break;
    case 'home':
      col = 0;
      if (jump) row = 0;
      break;
    case 'end':
      col = columns - 1;
      if (jump) row = rows - 1;
      break;
    case 'pageUp':
      row -= Math.max(1, page);
      break;
    case 'pageDown':
      row += Math.max(1, page);
      break;
    case 'next':
    case 'previous': {
      const index = clamp(row * columns + col + (motion === 'next' ? 1 : -1), 0, rows * columns - 1);
      row = Math.floor(index / columns);
      col = index % columns;
      break;
    }
  }
  return { row: clamp(row, 0, rows - 1), col: clamp(col, 0, columns - 1) };
}
