/** Grid handlers and shortcut help share the same keys, including alternate keys for an action. */
export const GRID_SHORTCUT_BINDINGS = [
  { id: 'grid.moveLeft', combo: 'ArrowLeft', motion: 'left' },
  { id: 'grid.moveRight', combo: 'ArrowRight', motion: 'right' },
  { id: 'grid.moveUp', combo: 'ArrowUp', motion: 'up' },
  { id: 'grid.moveDown', combo: 'ArrowDown', motion: 'down' },
  { id: 'grid.home', combo: 'Home', motion: 'home' },
  { id: 'grid.end', combo: 'End', motion: 'end' },
  { id: 'grid.pageUp', combo: 'PageUp', motion: 'pageUp' },
  { id: 'grid.pageDown', combo: 'PageDown', motion: 'pageDown' },
  { id: 'grid.edit', combo: 'Enter', alternatives: ['F2'], command: 'edit' },
  { id: 'grid.cancel', combo: 'Escape', command: 'cancel' },
  { id: 'grid.clear', combo: 'Delete', alternatives: ['Backspace'], command: 'clear' },
  { id: 'grid.toggle', combo: 'Space', command: 'toggle' },
  { id: 'grid.expand', combo: 'Shift+Space', command: 'expand' },
  { id: 'grid.context', combo: 'ContextMenu', alternatives: ['Shift+F10'], command: 'context' },
  { id: 'grid.undo', combo: 'Mod+Z', command: 'undo' },
  { id: 'grid.redo', combo: 'Mod+Shift+Z', alternatives: ['Ctrl+Y'], command: 'redo' },
  { id: 'grid.all', combo: 'Mod+A', command: 'all' },
  { id: 'grid.fillDown', combo: 'Mod+D', appleAlternatives: ['Ctrl+D'], command: 'fillDown' },
  { id: 'grid.fillRight', combo: 'Mod+R', appleAlternatives: ['Ctrl+R'], command: 'fillRight' },
  { id: 'grid.find', combo: 'Mod+F', search: 'find', whileTyping: true },
  { id: 'grid.replace', combo: 'Ctrl+H', appleCombo: 'Mod+Shift+H', search: 'replace', whileTyping: true },
] as const;

export type GridShortcutId = (typeof GRID_SHORTCUT_BINDINGS)[number]['id'];

/** Palette actions send the registered keys through the same grid handler as a keyboard. */
export function gridShortcutEvent(id: GridShortcutId, apple: boolean): KeyboardEvent {
  const binding = GRID_SHORTCUT_BINDINGS.find((binding) => binding.id === id)!;
  const combo = shortcutCombos(binding, apple)[0]!;
  const parts = combo.toLowerCase().split('+');
  parts.pop();
  const key = combo.split('+').at(-1)!;
  const mod = parts.includes('mod');
  return new KeyboardEvent('keydown', {
    key: key === 'Space' ? ' ' : key,
    ctrlKey: parts.includes('ctrl') || (mod && !apple),
    metaKey: parts.includes('meta') || (mod && apple),
    shiftKey: parts.includes('shift'),
    altKey: parts.includes('alt'),
    bubbles: true,
    cancelable: true,
  });
}

export interface PlatformShortcutBinding {
  combo: string;
  alternatives?: readonly string[];
  appleCombo?: string;
  appleAlternatives?: readonly string[];
}

/** Platform exceptions stay beside the binding so help and handlers cannot drift. */
export function shortcutCombos(binding: PlatformShortcutBinding, apple: boolean): readonly string[] {
  return [
    apple ? (binding.appleCombo ?? binding.combo) : binding.combo,
    ...(apple ? (binding.appleAlternatives ?? binding.alternatives ?? []) : (binding.alternatives ?? [])),
  ];
}
