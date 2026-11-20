import { randomBytes } from 'node:crypto';
import type * as Router from '@tanstack/react-router';
import { cleanup, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { json, renderSharing, session } from './database/share/testing';
import { SignInLinkScreen } from './SignInLinkScreen';

const route = vi.hoisted(() => ({ navigate: vi.fn(), next: '/settings/appearance?theme=nature#colors' }));
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof Router>()),
  useNavigate: () => route.navigate,
  useSearch: () => ({ next: route.next }),
}));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it.each([false, true])(
  'retains the return address when the link needs a second step: %s',
  async (secondStep) => {
    const token = randomBytes(24).toString('base64url');
    window.history.replaceState(
      { retained: true },
      '',
      `/sign-in/link?next=${encodeURIComponent(route.next)}#token=${token}`,
    );
    const step = { stage: 'verify', email: session.user.email, methods: ['recovery'] };
    const fetcher = vi.fn(async (_input: string) => json(secondStep ? { secondStep: step } : session));
    vi.stubGlobal('fetch', fetcher);
    renderSharing(<SignInLinkScreen />, null);
    await waitFor(() =>
      expect(route.navigate).toHaveBeenCalledWith(
        secondStep ? { to: '/sign-in', search: { next: route.next } } : { to: route.next },
      ),
    );
    const requests = fetcher.mock.calls.map(([input]) => input);
    expect(requests.filter((input) => input === '/api/auth/link/redeem')).toHaveLength(1);
    expect(
      requests.every((input) => ['/api/auth/link/redeem', '/brand/riosoma-wordmark.svg'].includes(input)),
    ).toBe(true);
    expect(new URLSearchParams(window.location.search).get('next')).toBe(route.next);
    expect(window.location.hash).toBe('');
    expect(window.history.state).toEqual({ retained: true });
  },
);
