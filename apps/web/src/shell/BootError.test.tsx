import { I18nProvider } from '@lingui/react';
import { i18n } from '@lingui/core';
import { QueryClient, onlineManager } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { setupStatusQuery, sessionQuery } from '../session';
import { BootError } from './BootError';

afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

it('retries the failed route loader after the connection returns', async () => {
  let connected = false;
  const load = vi.fn(() => {
    if (!connected) throw new Error('Connection unavailable');
  });
  const root = createRootRoute({ component: Outlet, errorComponent: BootError, beforeLoad: load });
  const route = createRoute({ getParentRoute: () => root, path: '/', component: () => <main /> });
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory() });
  render(
    <I18nProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nProvider>,
  );
  await screen.findByRole('heading', { name: "Riosoma can't reach its server" });
  connected = true;
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByRole('main');
  expect(load).toHaveBeenCalledTimes(2);
});

it.each([
  { name: 'setup', load: (client: QueryClient) => client.fetchQuery(setupStatusQuery) },
  { name: 'session', load: (client: QueryClient) => client.fetchQuery(sessionQuery) },
])('lets startup report an offline $name request', async ({ load }) => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Connection unavailable'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: 2, retryDelay: 0, gcTime: 0 } } });
  onlineManager.setOnline(false);
  const result = load(client).catch(() => null);
  try {
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(await result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    onlineManager.setOnline(true);
    client.clear();
    await result;
  }
});
