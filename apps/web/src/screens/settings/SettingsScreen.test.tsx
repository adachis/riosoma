import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { json, renderSharing } from '../database/share/testing';
import { SettingsScreen } from './SettingsScreen';

const pending = vi.hoisted(() => new Promise<never>(() => {}));
vi.mock('./LanguageSettings', () => ({
  LanguageSettings: () => {
    throw pending;
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('refreshes an unedited file limit after returning from a pending settings section', async () => {
  let limit: number | null = null;
  let reads = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    if (url === '/api/org/files') {
      reads++;
      return json({ maxUploadBytes: limit, revision: String(limit ?? 0).padStart(64, '0') });
    }
    return json({ new: 0 });
  });
  const root = createRootRoute({ component: Outlet });
  const app = createRoute({ getParentRoute: () => root, id: 'app', component: Outlet });
  const settings = createRoute({
    getParentRoute: () => app,
    path: 'settings/$section',
    component: SettingsScreen,
  });
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([settings])]),
    history: createMemoryHistory({ initialEntries: ['/settings/files'] }),
  });
  const rendered = renderSharing(<RouterProvider router={router} />);
  const input = await screen.findByRole('textbox', { name: 'Maximum upload size (bytes)' });
  expect((input as HTMLInputElement).value).toBe('');
  expect(reads).toBe(1);

  await act(async () => router.navigate({ to: '/settings/$section', params: { section: 'language' } }));
  await screen.findByRole('heading', { name: 'Language', level: 1 });
  limit = 1024;
  await act(async () => router.navigate({ to: '/settings/$section', params: { section: 'files' } }));
  await waitFor(() => {
    const refreshed = screen.getByRole('textbox', { name: 'Maximum upload size (bytes)' });
    expect((refreshed as HTMLInputElement).value).toBe('1024');
  });
  expect(reads).toBe(2);
  rendered.client.clear();
});

it('keeps the database return address while its screen waits to load', async () => {
  vi.stubGlobal('fetch', async () => json({ new: 0 }));
  let release!: () => void;
  const loading = new Promise<void>((resolve) => {
    release = resolve;
  });
  const root = createRootRoute({ component: Outlet });
  const app = createRoute({ getParentRoute: () => root, id: 'app', component: Outlet });
  const settings = createRoute({
    getParentRoute: () => app,
    path: 'settings/$section',
    component: SettingsScreen,
  });
  const database = createRoute({
    getParentRoute: () => app,
    path: '$databaseId/$tableId/$viewId',
    beforeLoad: () => loading,
    component: () => <div data-testid="returned-database" />,
  });
  const history = createMemoryHistory({ initialEntries: ['/settings/levels'] });
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([settings, database])]),
    history,
  });
  renderSharing(<RouterProvider router={router} />);
  await screen.findByRole('heading', { name: 'Experience level', level: 1 });
  await act(async () => {
    void router.navigate({
      to: '/$databaseId/$tableId/$viewId',
      params: { databaseId: 'database', tableId: 'table', viewId: 'view' },
    });
  });
  expect(history.location.pathname).toBe('/database/table/view');
  await act(async () => {
    release();
  });
  await screen.findByTestId('returned-database');
  expect(history.location.pathname).toBe('/database/table/view');
});
