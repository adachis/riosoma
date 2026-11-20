import { describe, expect, it } from 'vitest';
import { keyCommand, letterKey, moveCell, searchCommand } from './keyboard.js';
import type { Motion } from './keyboard.js';
import { GRID_SHORTCUT_BINDINGS, gridShortcutEvent, shortcutCombos } from './shortcuts.js';

const key = (value: string, options: KeyboardEventInit = {}) =>
  new KeyboardEvent('keydown', { key: value, ...options });

it('runs registered palette keys through the grid handlers on both platforms', () => {
  for (const mac of [false, true]) {
    for (const binding of GRID_SHORTCUT_BINDINGS.filter((binding) =>
      [
        'grid.undo',
        'grid.redo',
        'grid.all',
        'grid.fillDown',
        'grid.fillRight',
        'grid.find',
        'grid.replace',
      ].includes(binding.id),
    )) {
      const event = gridShortcutEvent(binding.id, mac);
      if ('search' in binding) expect(searchCommand(event, mac)).toBe(binding.search);
      else if ('command' in binding) expect(keyCommand(event, mac)).toEqual({ kind: binding.command });
      expect(shortcutCombos(binding, mac).length).toBeGreaterThan(0);
    }
  }
});

for (const mac of [true, false]) {
  describe(mac ? 'macOS keys' : 'other platform keys', () => {
    const modifier = mac ? { metaKey: true } : { ctrlKey: true };
    it.each([
      ['ArrowLeft', 'left'],
      ['ArrowRight', 'right'],
      ['ArrowUp', 'up'],
      ['ArrowDown', 'down'],
      ['Home', 'home'],
      ['End', 'end'],
      ['PageUp', 'pageUp'],
      ['PageDown', 'pageDown'],
    ])('maps %s, extension, and jumps', (value, motion) => {
      for (const shiftKey of [false, true])
        for (const jump of [false, true]) {
          expect(keyCommand(key(value!, { shiftKey, ...(jump ? modifier : {}) }), mac)).toEqual({
            kind: 'move',
            motion,
            extend: shiftKey,
            jump,
          });
        }
    });
    it.each([
      ['Enter', 'edit'],
      ['F2', 'edit'],
      ['Escape', 'cancel'],
      ['Delete', 'clear'],
      ['Backspace', 'clear'],
      [' ', 'toggle'],
      ['ContextMenu', 'context'],
    ])('maps %s', (value, kind) => expect(keyCommand(key(value!), mac)).toEqual({ kind }));
    it('maps shifted actions and Tab wrapping', () => {
      expect(keyCommand(key(' ', { shiftKey: true }), mac)).toEqual({ kind: 'expand' });
      expect(keyCommand(key('F10', { shiftKey: true }), mac)).toEqual({ kind: 'context' });
      expect(keyCommand(key('Tab'), mac)).toEqual({
        kind: 'move',
        motion: 'next',
        extend: false,
        jump: false,
      });
      expect(keyCommand(key('Tab', { shiftKey: true }), mac)).toEqual({
        kind: 'move',
        motion: 'previous',
        extend: false,
        jump: false,
      });
    });
    it('maps selection and history using the layout, including German and Russian', () => {
      expect(keyCommand(key('a', modifier), mac)).toEqual({ kind: 'all' });
      expect(keyCommand(key('z', { ...modifier, code: 'KeyY' }), mac)).toEqual({ kind: 'undo' });
      expect(keyCommand(key('Z', { ...modifier, shiftKey: true, code: 'KeyY' }), mac)).toEqual({
        kind: 'redo',
      });
      expect(keyCommand(key('я', { ...modifier, code: 'KeyZ' }), mac)).toEqual({ kind: 'undo' });
      expect(keyCommand(key('Я', { ...modifier, shiftKey: true, code: 'KeyZ' }), mac)).toEqual({
        kind: 'redo',
      });
      expect(keyCommand(key('ф', { ...modifier, code: 'KeyA' }), mac)).toEqual({ kind: 'all' });
      expect(keyCommand(key('y', { ctrlKey: true, code: 'KeyZ' }), mac)).toEqual({ kind: 'redo' });
      expect(keyCommand(key('н', { ctrlKey: true, code: 'KeyY' }), mac)).toEqual({ kind: 'redo' });
      expect(keyCommand(key('a', mac ? { ctrlKey: true } : { metaKey: true }), mac)).toBeNull();
      expect(keyCommand(key('z', { ...modifier, altKey: true }), mac)).toBeNull();
    });
    it('leaves caret movement, clipboard shortcuts, undo, and composition to the editor', () => {
      for (const value of [
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'Home',
        'End',
        'PageUp',
        'PageDown',
        'Delete',
        'Backspace',
        ' ',
        'F2',
        'z',
        'y',
        'a',
        'c',
        'v',
        'x',
      ])
        expect(keyCommand(key(value, modifier), mac, true)).toBeNull();
      expect(keyCommand(key('Enter', { isComposing: true }), mac, true)).toBeNull();
      expect(keyCommand(key('Enter', { keyCode: 229 }), mac)).toBeNull();
      expect(keyCommand(key('Escape'), mac, true)).toEqual({ kind: 'cancel' });
      for (const shiftKey of [false, true]) {
        expect(keyCommand(key('Enter', { shiftKey }), mac, true)).toEqual({
          kind: 'commit',
          motion: shiftKey ? 'up' : 'down',
        });
        expect(keyCommand(key('Tab', { shiftKey }), mac, true)).toEqual({
          kind: 'commit',
          motion: shiftKey ? 'previous' : 'next',
        });
      }
      expect(keyCommand(key('Enter', modifier), mac, true, true)).toEqual({ kind: 'newline' });
      expect(keyCommand(key('Enter', { altKey: true }), mac, true, true)).toEqual({ kind: 'newline' });
      expect(keyCommand(key('Enter', modifier), mac, true, false)).toBeNull();
    });
  });
}

it('maps fill down and fill right to Ctrl everywhere and to Cmd on a Mac', () => {
  for (const mac of [true, false]) {
    expect(keyCommand(key('d', { ctrlKey: true }), mac)).toEqual({ kind: 'fillDown' });
    expect(keyCommand(key('r', { ctrlKey: true }), mac)).toEqual({ kind: 'fillRight' });
    expect(keyCommand(key('в', { ctrlKey: true, code: 'KeyD' }), mac)).toEqual({ kind: 'fillDown' });
    expect(keyCommand(key('d', { ctrlKey: true, shiftKey: true }), mac)).toBeNull();
    expect(keyCommand(key('d', { ctrlKey: true, altKey: true }), mac)).toBeNull();
    expect(keyCommand(key('d', { ctrlKey: true }), mac, true)).toBeNull();
  }
  expect(keyCommand(key('d', { metaKey: true }), true)).toEqual({ kind: 'fillDown' });
  expect(keyCommand(key('r', { metaKey: true }), true)).toEqual({ kind: 'fillRight' });
  expect(keyCommand(key('d', { metaKey: true }), false)).toBeNull();
});

it('maps find to Ctrl+F or Cmd+F and replace to Ctrl+H or Cmd+Shift+H', () => {
  expect(searchCommand(key('f', { ctrlKey: true }), false)).toBe('find');
  expect(searchCommand(key('f', { metaKey: true }), true)).toBe('find');
  expect(searchCommand(key('а', { metaKey: true, code: 'KeyF' }), true)).toBe('find');
  expect(searchCommand(key('f', { metaKey: true }), false)).toBeNull();
  expect(searchCommand(key('f', { ctrlKey: true }), true)).toBeNull();
  expect(searchCommand(key('F', { ctrlKey: true, shiftKey: true }), false)).toBeNull();
  expect(searchCommand(key('h', { ctrlKey: true }), false)).toBe('replace');
  expect(searchCommand(key('H', { metaKey: true, shiftKey: true }), true)).toBe('replace');
  expect(searchCommand(key('h', { metaKey: true }), true)).toBeNull();
  expect(searchCommand(key('h', { ctrlKey: true, shiftKey: true }), false)).toBeNull();
  expect(searchCommand(key('f', { ctrlKey: true, isComposing: true }), false)).toBeNull();
  expect(searchCommand(key('f', { ctrlKey: true, altKey: true }), false)).toBeNull();
});

it('uses the character over the physical key whenever it is a Latin letter', () => {
  expect(letterKey({ key: 'y', code: 'KeyZ' })).toBe('y');
  expect(letterKey({ key: 'я', code: 'KeyZ' })).toBe('z');
  expect(letterKey({ key: 'Enter', code: 'Enter' })).toBe('');
});

it.each<[Motion, { row: number; col: number }]>([
  ['left', { row: 5, col: 1 }],
  ['right', { row: 5, col: 3 }],
  ['up', { row: 4, col: 2 }],
  ['down', { row: 6, col: 2 }],
  ['home', { row: 5, col: 0 }],
  ['end', { row: 5, col: 3 }],
  ['pageUp', { row: 2, col: 2 }],
  ['pageDown', { row: 8, col: 2 }],
  ['next', { row: 5, col: 3 }],
  ['previous', { row: 5, col: 1 }],
])('moves %s', (motion, expected) => {
  expect(moveCell({ row: 5, col: 2 }, motion, 10, 4, 3)).toEqual(expected);
});

it('clamps edges, wraps Tab, jumps across a million rows, and mirrors RTL arrows', () => {
  const first = { row: 0, col: 0 };
  const last = { row: 999_999, col: 19 };
  for (const motion of ['left', 'up', 'home', 'pageUp', 'previous'] as const)
    expect(moveCell(first, motion, 1_000_000, 20, 15)).toEqual(first);
  for (const motion of ['right', 'down', 'end', 'pageDown', 'next'] as const)
    expect(moveCell(last, motion, 1_000_000, 20, 15)).toEqual(last);
  expect(moveCell(first, 'end', 1_000_000, 20, 15, false, true)).toEqual(last);
  expect(moveCell(last, 'home', 1_000_000, 20, 15, false, true)).toEqual(first);
  expect(moveCell(first, 'down', 1_000_000, 20, 15, false, true)).toEqual({ row: 999_999, col: 0 });
  expect(moveCell(last, 'up', 1_000_000, 20, 15, false, true)).toEqual({ row: 0, col: 19 });
  expect(moveCell({ row: 2, col: 19 }, 'next', 10, 20, 3)).toEqual({ row: 3, col: 0 });
  expect(moveCell({ row: 3, col: 0 }, 'previous', 10, 20, 3)).toEqual({ row: 2, col: 19 });
  expect(moveCell(first, 'left', 10, 20, 3, true)).toEqual({ row: 0, col: 1 });
  expect(moveCell({ row: 0, col: 1 }, 'right', 10, 20, 3, true)).toEqual(first);
  expect(moveCell(first, 'left', 10, 20, 3, true, true)).toEqual({ row: 0, col: 19 });
  expect(moveCell(last, 'right', 1_000_000, 20, 3, true, true)).toEqual({ row: 999_999, col: 0 });
  expect(moveCell(first, 'next', 0, 0, 0)).toEqual(first);
});
