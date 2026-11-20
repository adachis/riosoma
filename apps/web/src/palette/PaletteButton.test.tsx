import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { isAppleDevice, shortcutKeys } from '../shortcuts/registry';
import { PaletteButton } from './PaletteButton';

const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });

function view(element: ReactElement) {
  return render(element, {
    wrapper: ({ children }) => <I18nProvider i18n={i18n}>{children}</I18nProvider>,
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('is a quiet button named by Search and its visible keys', async () => {
  const onPress = vi.fn();
  view(<PaletteButton onPress={onPress} />);
  const button = screen.getByRole('button', { name: `Search ${shortcutKeys('palette.open')}` });
  expect(button.getAttribute('data-variant')).toBe('quiet');
  expect(button.getAttribute('aria-label')).toBe(`Search ${shortcutKeys('palette.open')}`);
  expect(button.querySelector('.rio-palette__label')?.textContent).toBe('Search');
  expect(button.querySelector('.rio-palette__keys')).not.toBeNull();
  expect(button.textContent).toContain(shortcutKeys('palette.open'));
  await userEvent.click(button);
  expect(onPress).toHaveBeenCalledOnce();
});

it('shows the keys the way this device writes them', () => {
  // Whatever this machine is, the button shows what the registry says for it.
  view(<PaletteButton onPress={() => undefined} />);
  const shown = screen
    .getByRole('button', { name: `Search ${shortcutKeys('palette.open')}` })
    .querySelector('.rio-palette__keys');
  expect(shown?.textContent).toBe(isAppleDevice() ? '⌘K' : 'Ctrl+K');
  expect(shown?.textContent).toBe(shortcutKeys('palette.open'));
});

it('shows ⌘K on an Apple device', () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
  );
  expect(isAppleDevice()).toBe(true);
  view(<PaletteButton onPress={() => undefined} />);
  expect(
    screen.getByRole('button', { name: `Search ${shortcutKeys('palette.open')}` }).textContent,
  ).toContain('⌘K');
});

it('includes the visible shortcut in its accessible name', () => {
  view(<PaletteButton onPress={() => undefined} />);
  expect(screen.getByRole('button', { name: `Search ${shortcutKeys('palette.open')}` })).toBeTruthy();
});
