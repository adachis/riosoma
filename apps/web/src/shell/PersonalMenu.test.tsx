import { cleanup, screen, waitFor } from '@testing-library/react';
import { randomUUID } from 'node:crypto';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { renderSharing, session } from '../screens/database/share/testing';
import { PersonalMenu } from './PersonalMenu';
import { settingsReturn, withSettingsReturn } from './settings-return';

afterEach(cleanup);

it('shows the person and every personal action, and restores keyboard focus', async () => {
  const user = userEvent.setup();
  const settings = vi.fn();
  renderSharing(
    <PersonalMenu
      user={session.user}
      signingOut={false}
      onSettings={settings}
      onAppearance={vi.fn()}
      onShortcuts={vi.fn()}
      onHelp={vi.fn()}
      onFeedback={vi.fn()}
      onSignOut={vi.fn()}
    />,
  );
  const trigger = screen.getByRole('button', { name: /: Personal menu$/ });
  trigger.focus();
  await user.keyboard('{ArrowDown}');
  await screen.findByRole('menu');
  expect(screen.getByText(session.user.name)).toBeTruthy();
  expect(screen.getByText(session.user.email)).toBeTruthy();
  for (const name of ['Settings', 'Appearance', 'Keyboard shortcuts', 'Help', 'Send feedback', 'Sign out']) {
    expect(screen.getByRole('menuitem', { name })).toBeTruthy();
  }
  await user.click(screen.getByRole('menuitem', { name: 'Settings' }));
  expect(settings).toHaveBeenCalledOnce();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it('keeps a database return address with its view, query, and record fragment', () => {
  expect(settingsReturn('/dbExample/table/view?help=rio#record')).toBe(
    '/dbExample/table/view?help=rio#record',
  );
});

it('preserves a destination query and fragment when adding a settings return address', () => {
  expect(withSettingsReturn('/admin/connections/ai/remote-tools?server=one#keys', '/db/table/view')).toBe(
    '/admin/connections/ai/remote-tools?server=one&returnTo=%2Fdb%2Ftable%2Fview#keys',
  );
  expect(withSettingsReturn('/settings/appearance', undefined)).toBe('/settings/appearance');
});

const externalHost = `${randomUUID()}.test`;

it.each([
  `https://${externalHost}`,
  `//${externalHost}`,
  `/\\${externalHost}`,
  '/api/auth/session',
  '/settings',
  '/admin/security',
])('rejects an unsafe or recursive settings return address %s', (address) => {
  expect(settingsReturn(address)).toBe('/');
});

it('includes the visible initials before the personal menu label', () => {
  renderSharing(
    <PersonalMenu
      user={{ ...session.user, name: 'Ada Lovelace' }}
      signingOut={false}
      onSettings={vi.fn()}
      onAppearance={vi.fn()}
      onShortcuts={vi.fn()}
      onHelp={vi.fn()}
      onFeedback={vi.fn()}
      onSignOut={vi.fn()}
    />,
  );
  const trigger = screen.getByRole('button', { name: 'AL: Personal menu' });
  expect(trigger.textContent).toBe('AL');
});
