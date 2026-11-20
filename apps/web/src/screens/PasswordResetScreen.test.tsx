import { randomBytes } from 'node:crypto';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type * as Router from '@tanstack/react-router';
import { json, renderSharing } from './database/share/testing';
import { ForgotPasswordScreen, PasswordResetScreen } from './PasswordResetScreen';

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof Router>()),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});

it.each([
  ['request', ForgotPasswordScreen],
  ['redemption', PasswordResetScreen],
] as const)('keeps recovery navigation visible to keyboard users on %s', async (step, RecoveryScreen) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ enabled: true, email: true })),
  );
  renderSharing(<RecoveryScreen />, null);
  if (step === 'request') await screen.findByLabelText('Email address');
  const back = screen.getByRole('link', { name: 'Back to sign-in' });
  const user = userEvent.setup();
  back.focus();
  await user.tab();
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(back);
  expect(back.getAttribute('href')).toBe('/sign-in');
  expect(back.hasAttribute('data-focus-visible')).toBe(true);
});

it.each([true, false])(
  'explains both recovery paths without email when reset is enabled %s',
  async (enabled) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ enabled, email: false })),
    );
    renderSharing(<ForgotPasswordScreen />, null);
    await screen.findByText(/Email is not set up on this server/);
    expect(screen.queryByLabelText('Email address')).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to sign-in' }).getAttribute('href')).toBe('/sign-in');
    if (!enabled) expect(screen.getByText(/Your organization has turned password reset off/)).toBeDefined();
  },
);

it('keeps the reset token in memory, permits paste, and refuses very long passwords without truncating', async () => {
  const token = randomBytes(32).toString('base64url');
  window.history.replaceState({ kept: true }, '', `/sign-in/reset#token=${token}`);
  const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => json(undefined, 204));
  vi.stubGlobal('fetch', fetcher);
  renderSharing(<PasswordResetScreen />, null);
  expect(window.location.hash).toBe('');
  expect(window.history.state).toEqual({ kept: true });
  const user = userEvent.setup();
  const input = screen.getByLabelText('New password', { exact: true });
  await user.click(input);
  await user.paste('x'.repeat(1025));
  expect((input as HTMLInputElement).value.length).toBe(1025);
  expect(screen.getByRole('button', { name: 'Change password' }).hasAttribute('disabled')).toBe(true);
  await user.clear(input);
  const password = `new password ${randomBytes(18).toString('base64url')}`;
  await user.paste(password);
  await user.click(screen.getByRole('button', { name: 'Change password' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const options = fetcher.mock.calls[0]![1] as RequestInit;
  expect(JSON.parse(options.body as string)).toEqual({ token, password });
  await screen.findByText(/Your password changed, and every earlier session ended/);
});
