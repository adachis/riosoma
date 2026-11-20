import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  comboText,
  isAppleDevice,
  isTypingTarget,
  matchesCombo,
  parseCombo,
  shortcutFor,
  shortcutKeys,
} from './registry';
import { useShortcut } from './useShortcut';

afterEach(cleanup);

function Harness() {
  const [opens, setOpens] = useState(0);
  useShortcut('palette.open', () => setOpens((count) => count + 1));
  return (
    <div>
      <input aria-label="cell" />
      <textarea aria-label="notes" />
      <div role="gridcell" aria-label="grid cell" tabIndex={0} />
      <button type="button">Save</button>
      <output data-testid="opens">{opens}</output>
    </div>
  );
}

const opens = () => Number(screen.getByTestId('opens').textContent);
const keys = (...pressed: string[]) => userEvent.keyboard(pressed.join(''));

describe('the shortcut registry', () => {
  it('writes a combination once and shows it the way each device writes it', () => {
    expect(comboText('Mod+K', true)).toBe('⌘K');
    expect(comboText('Mod+K', false)).toBe('Ctrl+K');
    expect(comboText('Mod+Shift+P', true)).toBe('⇧⌘P');
    expect(comboText('Mod+Shift+P', false)).toBe('Ctrl+Shift+P');
    expect(comboText('Ctrl+Alt+Enter', true)).toBe('⌃⌥Enter');
    expect(comboText('Enter', false)).toBe('Enter');
    expect(comboText('Mod+Escape', false)).toBe('Ctrl+Esc');
  });

  it('shows a registered shortcut by id, and nothing for one the app doesn’t have', () => {
    expect(shortcutKeys('palette.open', true)).toBe('⌘K');
    expect(shortcutKeys('palette.open', false)).toBe('Ctrl+K');
    expect(shortcutKeys('nothing.bound', true)).toBe('');
    expect(shortcutKeys('feedback.open', true)).toBe('⌥⌘F');
    expect(shortcutKeys('feedback.open', false)).toBe('Ctrl+Alt+F');
  });

  it('names every shortcut, so a help sheet can list them', () => {
    expect(shortcutFor('palette.open')?.label).toEqual({
      id: 'shortcuts.palette',
      message: 'Open search and commands',
    });
    expect(shortcutFor('palette.open')?.whileTyping).toBe(true);
  });

  it('reads the platform off the browser', () => {
    expect(isAppleDevice({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })).toBe(true);
    expect(isAppleDevice({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' })).toBe(true);
    expect(isAppleDevice({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe(false);
    expect(isAppleDevice({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe(false);
    // An iPad asking for desktop sites reports a Mac platform and a vague agent.
    expect(isAppleDevice({ userAgent: 'Mozilla/5.0', platform: 'MacIntel' })).toBe(true);
    expect(isAppleDevice({})).toBe(false);
  });

  it('answers to either primary modifier and to nothing else', () => {
    const event = (over: Partial<Parameters<typeof matchesCombo>[0]> = {}) => ({
      key: 'k',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...over,
    });
    expect(matchesCombo(event({ metaKey: true }), 'Mod+K')).toBe(true);
    expect(matchesCombo(event({ ctrlKey: true }), 'Mod+K')).toBe(true);
    expect(matchesCombo(event(), 'Mod+K')).toBe(false);
    expect(matchesCombo(event({ metaKey: true, shiftKey: true }), 'Mod+K')).toBe(false);
    expect(matchesCombo(event({ metaKey: true, altKey: true }), 'Mod+K')).toBe(false);
    expect(matchesCombo(event({ metaKey: true, key: 'j' }), 'Mod+K')).toBe(false);
    expect(matchesCombo(event({ metaKey: true, shiftKey: true }), 'Mod+Shift+K')).toBe(true);
    expect(parseCombo('Mod+Shift+K')).toEqual({
      key: 'k',
      mod: true,
      ctrl: false,
      alt: false,
      shift: true,
      meta: false,
    });
  });

  it('opens the undo history with Option on an Apple keyboard, and leaves AltGr letters alone elsewhere', () => {
    const event = { key: 'Ω', code: 'KeyZ', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false };
    expect(shortcutKeys('undo.history', true)).toBe('⌥⌘Z');
    expect(shortcutKeys('undo.history', false)).toBe('Ctrl+Alt+Z');
    expect(matchesCombo(event, 'Mod+Alt+Z', true)).toBe(true);
    const other = { ...event, metaKey: false, ctrlKey: true };
    expect(matchesCombo({ ...other, key: 'z' }, 'Mod+Alt+Z', false)).toBe(true);
    expect(matchesCombo({ ...other, key: 'ż' }, 'Mod+Alt+Z', false)).toBe(false);
  });

  it('knows where someone is typing', () => {
    render(<Harness />);
    expect(isTypingTarget(screen.getByRole('textbox', { name: 'cell' }))).toBe(true);
    expect(isTypingTarget(screen.getByRole('textbox', { name: 'notes' }))).toBe(true);
    expect(isTypingTarget(screen.getByRole('gridcell'))).toBe(true);
    expect(isTypingTarget(screen.getByRole('button', { name: 'Save' }))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget('not an element')).toBe(false);
  });
});

describe('useShortcut', () => {
  it('runs alternate registered grid keys through the shared dispatcher', async () => {
    let redone = 0;
    function Redo() {
      useShortcut('grid.redo', () => {
        redone++;
      });
      return <button type="button">Redo</button>;
    }
    render(<Redo />);
    screen.getByRole('button', { name: 'Redo' }).focus();
    await keys('{Control>}y{/Control}');
    expect(redone).toBe(1);
  });
  it('fires on ⌘K and Ctrl+K from the page, and ignores a plain K', async () => {
    render(<Harness />);
    await keys('{Meta>}k{/Meta}');
    expect(opens()).toBe(1);
    await keys('{Control>}k{/Control}');
    expect(opens()).toBe(2);
    // The key on its own is someone typing, not a shortcut.
    await keys('k');
    expect(opens()).toBe(2);
    await keys('{Meta>}j{/Meta}');
    expect(opens()).toBe(2);
  });

  it('still fires while someone types in a field or a cell', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const cell = screen.getByRole('textbox', { name: 'cell' });
    await user.click(cell);
    await user.keyboard('abc');
    expect((cell as HTMLInputElement).value).toBe('abc');
    expect(opens()).toBe(0);
    await keys('{Meta>}k{/Meta}');
    expect(opens()).toBe(1);
    // The palette takes the key but not the text: the field keeps what was typed.
    expect((cell as HTMLInputElement).value).toBe('abc');
  });

  it('binds while the component is mounted and lets go when it isn’t', async () => {
    const { unmount } = render(<Harness />);
    await keys('{Meta>}k{/Meta}');
    expect(opens()).toBe(1);
    unmount();
    await keys('{Meta>}k{/Meta}');
    // Nothing is listening now, and nothing threw.
    render(<Harness />);
    expect(opens()).toBe(0);
    await keys('{Meta>}k{/Meta}');
    expect(opens()).toBe(1);
  });

  it('calls the newest handler without binding again', async () => {
    function Counting() {
      const [step, setStep] = useState(1);
      const [total, setTotal] = useState(0);
      useShortcut('palette.open', () => setTotal((value) => value + step));
      return (
        <div>
          <button type="button" onClick={() => setStep(10)}>
            bigger
          </button>
          <output data-testid="total">{total}</output>
        </div>
      );
    }
    render(<Counting />);
    await keys('{Meta>}k{/Meta}');
    expect(screen.getByTestId('total').textContent).toBe('1');
    await userEvent.click(screen.getByRole('button', { name: 'bigger' }));
    await keys('{Meta>}k{/Meta}');
    expect(screen.getByTestId('total').textContent).toBe('11');
  });

  it('still fires where something else keeps keys from travelling', async () => {
    // A cell editor stops every key from going past it, which is where ⌘K still has to work.
    function Editor() {
      const [opens, setOpens] = useState(0);
      useShortcut('palette.open', () => setOpens((count) => count + 1));
      return (
        <div onKeyDown={(event) => event.stopPropagation()}>
          <input aria-label="editor" />
          <output data-testid="editor-opens">{opens}</output>
        </div>
      );
    }
    render(<Editor />);
    const user = userEvent.setup();
    const editor = screen.getByRole('textbox', { name: 'editor' });
    await user.click(editor);
    await user.keyboard('abc');
    await keys('{Meta>}k{/Meta}');
    expect(screen.getByTestId('editor-opens').textContent).toBe('1');
    expect((editor as HTMLInputElement).value).toBe('abc');
  });

  it('leaves a key alone once something that saw it first has claimed it', async () => {
    const swallow = (event: Event) => event.preventDefault();
    window.addEventListener('keydown', swallow, true);
    try {
      render(<Harness />);
      await keys('{Meta>}k{/Meta}');
      expect(opens()).toBe(0);
    } finally {
      window.removeEventListener('keydown', swallow, true);
    }
    await keys('{Meta>}k{/Meta}');
    expect(opens()).toBe(1);
  });
});

it('registers view movement and dependency shortcuts with platform labels', () => {
  expect(shortcutKeys('views.dependencies', true)).toBe('⌥D');
  expect(shortcutKeys('views.dependencies', false)).toBe('Alt+D');
  expect(shortcutKeys('views.moveLeft', true)).toBe('⌥←');
  expect(shortcutKeys('views.moveDown', false)).toBe('Alt+↓');
});

it('keeps shared reorder and view movement shortcuts registered together', () => {
  for (const id of [
    'reorder.pick',
    'reorder.pickEnter',
    'reorder.up',
    'reorder.down',
    'reorder.in',
    'reorder.out',
    'reorder.cancel',
    'reorder.upNow',
    'reorder.downNow',
    'views.moveLeft',
    'views.moveRight',
    'views.moveUp',
    'views.moveDown',
    'views.endUp',
    'views.endDown',
    'views.endLeft',
    'views.endRight',
    'views.dependencies',
  ] as const) {
    expect(shortcutFor(id)?.id).toBe(id);
  }
  expect(shortcutKeys('views.moveRight', false)).toBe('Alt+→');
  expect(shortcutKeys('views.moveUp', true)).toBe('⌥↑');
});
