import { randomBytes } from 'node:crypto';
import type * as Router from '@tanstack/react-router';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SsoButton } from '@riosoma/contracts';
import { failure, json, renderSharing } from './database/share/testing';
import { SignInScreen } from './SignInScreen';

const route = vi.hoisted(() => ({ search: {} as { next?: string; error?: string } }));

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof Router>()),
  useNavigate: () => vi.fn(),
  useSearch: () => route.search,
}));

const google: SsoButton = { id: 'GoogleProvider01', kind: 'google', name: 'Google' };
const acme: SsoButton = { id: 'AcmeProvider0001', kind: 'oidc', name: 'Acme single sign-on' };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function start(providers: SsoButton[], search: { next?: string; error?: string } = {}) {
  route.search = search;
  const fetcher = vi.fn(async (url: string) => {
    if (url === '/api/auth/methods') return json({ password: true, link: false });
    if (url === '/api/auth/sso') return json(providers);
    if (url === '/api/auth/second-step') return json({ secondStep: null });
    if (url === '/api/auth/sign-in') return failure('auth.signIn.invalid', 401);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  renderSharing(<SignInScreen />, null);
  return fetcher;
}

describe('SignInScreen with single sign-on', () => {
  it('gives password recovery the shared keyboard focus treatment', async () => {
    start([]);
    await screen.findByRole('textbox', { name: 'Email address' });
    const user = userEvent.setup();
    screen.getByRole('button', { name: 'Sign in' }).focus();
    await user.tab();
    const recovery = screen.getByRole('link', { name: 'Forgot password' });
    expect(document.activeElement).toBe(recovery);
    expect(recovery.getAttribute('href')).toBe('/sign-in/forgot-password');
    expect(recovery.hasAttribute('data-focus-visible')).toBe(true);
  });

  it('lets a rejected sign-in link address be corrected and submitted again', async () => {
    route.search = {};
    const submitted: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        if (url === '/api/auth/methods') return json({ password: true, link: true, passkey: false });
        if (url === '/api/auth/sso') return json([]);
        if (url === '/api/auth/second-step') return json({ secondStep: null });
        const { email } = JSON.parse(String(options?.body));
        submitted.push(email);
        return submitted.length === 1
          ? json(
              {
                error: {
                  code: 'validation_failed',
                  messageKey: 'errors.validationFailed',
                  userFault: true,
                  fields: { email: 'validation.too_big' },
                },
              },
              422,
            )
          : json(null, 202);
      }),
    );
    renderSharing(<SignInScreen />, null);
    const user = userEvent.setup();
    const email = screen.getByLabelText('Email address');
    await user.type(email, 'reader@example.test');
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    await user.click(screen.getByRole('button', { name: 'Send link' }));
    await screen.findByText('This is too long.');
    await user.clear(email);
    await user.type(email, 'corrected@example.test');
    expect(email.getAttribute('aria-invalid')).not.toBe('true');
    await user.click(screen.getByRole('button', { name: 'Send link' }));
    await screen.findByRole('heading', { name: 'Check your email' });
    expect(submitted).toEqual(['reader@example.test', 'corrected@example.test']);
  });

  it('explains an oversized pasted password beside the field and clears the error on editing', async () => {
    route.search = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/auth/methods') return json({ password: true, link: false, passkey: false });
        if (url === '/api/auth/sso') return json([]);
        if (url === '/api/auth/second-step') return json({ secondStep: null });
        return json(
          {
            error: {
              code: 'validation_failed',
              messageKey: 'errors.validationFailed',
              userFault: true,
              fields: { password: 'validation.too_big' },
            },
          },
          422,
        );
      }),
    );
    renderSharing(<SignInScreen />, null);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email address'), 'ada@example.com');
    const password = screen.getByLabelText(/^Password/);
    await user.click(password);
    await user.paste('密碼 📚 كلمة مرور'.repeat(150));
    await user.keyboard('{Enter}');
    await screen.findByText('This is too long.');
    expect(password.getAttribute('aria-invalid')).toBe('true');
    await user.clear(password);
    await user.type(password, randomBytes(24).toString('base64url'));
    expect(password.getAttribute('aria-invalid')).not.toBe('true');
  });

  it('offers each provider above the other ways to sign in', async () => {
    start([google, acme], { next: '/settings/people?tab=1' });
    const first = await screen.findByRole('link', { name: 'Continue with Google' });
    expect(first.getAttribute('href')).toBe(
      '/api/auth/sso/GoogleProvider01/start?next=%2Fsettings%2Fpeople%3Ftab%3D1',
    );
    const second = screen.getByRole('link', { name: 'Continue with Acme single sign-on' });
    expect(second.getAttribute('href')).toBe(
      '/api/auth/sso/AcmeProvider0001/start?next=%2Fsettings%2Fpeople%3Ftab%3D1',
    );
    const email = screen.getByRole('textbox', { name: 'Email address' });
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(second.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('leaves the return address off when there is none', async () => {
    start([google]);
    const link = await screen.findByRole('link', { name: 'Continue with Google' });
    expect(link.getAttribute('href')).toBe('/api/auth/sso/GoogleProvider01/start');
  });

  it('shows no provider buttons when none are on', async () => {
    const fetcher = start([]);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/auth/sso', expect.anything()));
    expect(screen.getByRole('textbox', { name: 'Email address' })).toBeDefined();
    expect(screen.queryByRole('link', { name: /Continue with/ })).toBeNull();
  });

  it.each([
    ['sso.noAccount', 'There’s no account here for that sign-in.  Ask an administrator to invite you.'],
    ['sso.denied', 'The provider didn’t sign you in.  Try again, or use another way to sign in.'],
    ['sso.locked', 'Too many sign-in attempts.  Wait a few minutes and try again.'],
    ['sso.somethingNew', 'Something went wrong on the server.'],
  ])('explains %s in the banner', async (error, text) => {
    start([google], { error });
    expect((await screen.findByRole('alert')).textContent).toBe(text);
  });

  it('trades the returned message for the answer to the next attempt', async () => {
    start([google], { error: 'sso.deactivated' });
    const user = userEvent.setup();
    expect((await screen.findByRole('alert')).textContent).toContain('This account has been deactivated.');
    await user.type(screen.getByRole('textbox', { name: 'Email address' }), 'ada@example.com');
    await user.type(screen.getByLabelText(/^Password/), 'not the password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('That email address and password don’t match.'),
    );
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});
