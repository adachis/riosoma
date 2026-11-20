import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { makeRouter } from './router';
import { sessionQuery, setupStatusQuery } from './session';
import { json, session } from './screens/database/share/testing';

vi.mock('./shell/AppShell', () => ({ AppShell: () => null }));
vi.mock('./shell/BootError', () => ({ BootError: () => null }));
vi.mock('./screens/SignInScreen', () => ({ SignInScreen: () => null }));
vi.mock('./screens/oauth/OAuthConsentScreen', () => ({ OAuthConsentScreen: () => null }));
afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([true, false])(
  'recovers authorization navigation through the network API when signed in is %s',
  async (signedIn) => {
    const request = ['request', 'x'.repeat(36)].join('');
    const state = crypto.randomUUID();
    const parameters = new URLSearchParams({
      client_id: 'a'.repeat(32),
      state,
      scope: 'schema.bases:read data.records:read',
      redirect_uri: 'https://client.example.test/callback',
    });
    const fetcher = vi.fn(async (path: string) => {
      expect(path).toBe(`/api/oauth/authorize?${parameters}`);
      return json({ request });
    });
    vi.stubGlobal('fetch', fetcher);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(setupStatusQuery.queryKey, { stage: 'ready', databaseManaged: false });
    queryClient.setQueryData(sessionQuery.queryKey, signedIn ? session : null);
    const router = makeRouter(queryClient);
    router.update({
      context: { queryClient },
      history: createMemoryHistory({ initialEntries: [`/oauth/authorize?${parameters}`] }),
    });
    await router.load();
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(signedIn ? '/oauth/consent' : '/sign-in'),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    if (signedIn) expect(router.state.location.search).toHaveProperty('request', request);
    else expect(router.state.location.search.next).toContain(`/oauth/consent?request=${request}`);
    queryClient.clear();
  },
);
