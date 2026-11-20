import { StrictMode, type ReactNode } from 'react';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentCsrfToken, setCsrfToken } from '../../api';
import { sessionQuery } from '../../session';
import { JoinScreen } from './JoinScreen';
import { failure, json, renderSharing, session } from '../database/share/testing';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
const token = 'a'.repeat(32);
const preview = {
  orgName: 'Garden',
  email: 'ada@example.com',
  invitedByName: 'Sam',
  level: { start: 'standard', highest: 'advanced' },
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  setCsrfToken(null);
  window.history.replaceState(null, '', '/');
});

function openLink(value = token) {
  window.history.replaceState({ kept: true }, '', `/join?source=mail#token=${value}`);
  return renderSharing(
    <StrictMode>
      <JoinScreen />
    </StrictMode>,
    null,
  );
}

describe('JoinScreen', () => {
  it('clears the fragment, previews, accepts with the keyboard, stores the session, and goes home', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(preview)).mockResolvedValueOnce(json(session));
    vi.stubGlobal('fetch', fetcher);
    const { client } = openLink();
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?source=mail');
    expect(window.history.state).toEqual({ kept: true });
    await screen.findByRole('heading', { name: 'Join Garden' });
    expect(screen.getByText('Sam invited ada@example.com.')).toBeDefined();
    expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/auth/invitations/${token}`);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Your name' }), ' Ada ');
    // Past the level, which starts where the organization says, to the Join button.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /^Standard/ }));
    await user.tab();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/' }));
    expect(JSON.parse(fetcher.mock.calls[1]?.[1].body as string)).toEqual({
      token,
      name: 'Ada',
      locale: 'en-US',
    });
    expect(client.getQueryData(sessionQuery.queryKey)).toEqual(session);
    expect(currentCsrfToken()).toBe(session.csrfToken);
  });

  it('sends someone who owes a second step to the sign-in page to finish there', async () => {
    const secondStep = {
      stage: 'setup',
      methods: ['authenticator'],
      email: 'ada@example.com',
      expiresAt: '2026-09-27T12:10:00.000Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(json(preview)).mockResolvedValueOnce(json({ secondStep })),
    );
    const { client } = openLink();
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Your name' }), 'Ada');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/sign-in' }));
    expect(client.getQueryData(['auth', 'second-step'])).toEqual({ secondStep });
    expect(client.getQueryData(sessionQuery.queryKey)).toBeNull();
    expect(currentCsrfToken()).toBeNull();
  });

  it('accepts for an address that already has an account from that account’s own session', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(preview))
      .mockResolvedValueOnce(failure('share.invite.signInFirst', 403))
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json(session));
    vi.stubGlobal('fetch', fetcher);
    const { client } = openLink();
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Your name' }), 'Ada');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/' }));
    expect(fetcher.mock.calls.map((call) => call[0] as string)).toEqual([
      `/api/auth/invitations/${token}`,
      '/api/auth/invitations/accept',
      '/api/auth/session',
      '/api/auth/invitations/accept',
    ]);
    // The second request carries the session's token, which the first could not.
    expect(new Headers(fetcher.mock.calls[1]?.[1].headers as HeadersInit).get('x-csrf-token')).toBeNull();
    expect(new Headers(fetcher.mock.calls[3]?.[1].headers as HeadersInit).get('x-csrf-token')).toBe(
      session.csrfToken,
    );
    expect(client.getQueryData(sessionQuery.queryKey)).toEqual(session);
  });

  it('asks someone who is not signed in to the existing account to sign in first', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(preview))
      .mockResolvedValueOnce(failure('share.invite.signInFirst', 403))
      .mockResolvedValueOnce(failure('errors.signInRequired', 401));
    vi.stubGlobal('fetch', fetcher);
    openLink();
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Your name' }), 'Ada');
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect((await screen.findByRole('alert')).textContent).toContain('already has an account');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each(['', 'short', `${token}!`])(
    'rejects a missing or malformed token without fetching: %s',
    async (value) => {
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      openLink(value);
      expect(screen.getByRole('alert').textContent).toContain('expired, was revoked, or was already used');
      expect(screen.getByRole('link', { name: 'Go to sign-in' }).getAttribute('href')).toBe('/sign-in');
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('handles a used link and a new link opened in the same tab', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(failure('auth.link.invalid', 404))
        .mockResolvedValueOnce(json({ ...preview, invitedByName: null })),
    );
    openLink();
    await screen.findByRole('alert');
    act(() => {
      window.history.replaceState(null, '', `/join#token=${'b'.repeat(32)}`);
      window.dispatchEvent(new Event('hashchange'));
    });
    await screen.findByText('You were invited as ada@example.com.');
    expect(window.location.hash).toBe('');
  });

  it('handles a link used between preview and acceptance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(json(preview)).mockResolvedValueOnce(failure('auth.link.invalid', 410)),
    );
    openLink();
    await userEvent.type(await screen.findByRole('textbox', { name: 'Your name' }), 'Ada');
    await userEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'expired, was revoked, or was already used',
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('sends a level chosen while joining, and none when the person keeps where they start', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(preview)).mockResolvedValueOnce(json(session));
    vi.stubGlobal('fetch', fetcher);
    openLink();
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Your name' }), 'Ada');
    const levels = screen.getByRole('radiogroup', { name: 'How much to show' });
    expect(screen.getAllByRole('radio').map((radio) => (radio as HTMLInputElement).value)).toEqual([
      'simple',
      'standard',
      'advanced',
    ]);
    expect((screen.getByRole('radio', { name: /^Standard/ }) as HTMLInputElement).checked).toBe(true);
    expect(levels).toBeDefined();
    await user.click(screen.getByRole('radio', { name: /^Simple/ }));
    await user.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/' }));
    expect(JSON.parse(fetcher.mock.calls[1]?.[1].body as string)).toMatchObject({ level: 'simple' });
  });

  it('offers a guest only the levels the organization allows guests', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(json({ ...preview, level: { start: 'simple', highest: 'standard' } })),
    );
    openLink();
    await screen.findByRole('radiogroup', { name: 'How much to show' });
    expect(screen.getAllByRole('radio').map((radio) => (radio as HTMLInputElement).value)).toEqual([
      'simple',
      'standard',
    ]);
    expect((screen.getByRole('radio', { name: /^Simple/ }) as HTMLInputElement).checked).toBe(true);
  });

  it('asks nothing about levels when a guest can only have Simple', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(json({ ...preview, level: { start: 'simple', highest: 'simple' } })),
    );
    openLink();
    await screen.findByRole('heading', { name: 'Join Garden' });
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('allows retrying an unavailable preview instead of calling the link expired', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(json(preview)),
    );
    openLink();
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'Join Garden' });
  });
});
