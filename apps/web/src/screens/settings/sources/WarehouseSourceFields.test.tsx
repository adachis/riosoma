import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { renderSharing } from '../../database/share/testing';
import { SourcesSettings } from './SourcesSettings';
import { mockSources } from './testing';

let history: ReturnType<typeof createBrowserHistory> | undefined;
afterEach(() => {
  cleanup();
  history?.destroy();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});

it.each(['redshift', 'athena', 'duckdb-file'])(
  'opens help from %s with the keyboard and preserves the unsaved source',
  async (kind) => {
    window.history.replaceState(null, '', `/settings/sources?source=new&kind=${kind}`);
    history = createBrowserHistory();
    const root = createRootRoute({ component: Outlet });
    const route = createRoute({
      getParentRoute: () => root,
      path: '/settings/sources',
      validateSearch: (search: Record<string, unknown>) => search,
      component: SourcesSettings,
    });
    const router = createRouter({ routeTree: root.addChildren([route]), history });
    vi.stubGlobal('fetch', vi.fn(mockSources().handle));
    renderSharing(<RouterProvider router={router} />);
    const user = userEvent.setup();
    const name = await screen.findByRole('textbox', { name: 'Name' });
    await user.type(name, 'Unsaved warehouse');
    const region = screen.queryByRole('textbox', { name: 'Region' });
    if (region) {
      await user.clear(region);
      await user.type(region, 'us-west-2');
    }
    const secret = screen.queryByLabelText('Secret access key', { exact: true });
    const value = ['temporary', Math.random().toString(36)].join('-');
    if (secret) await user.type(secret, value);
    screen.getByRole('link', { name: 'Connection help' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        source: 'new',
        kind,
        help: 'warehouse-sources',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a data source' })).toBeNull());
    await act(async () => {
      await router.navigate({
        to: '.',
        search: (previous: Record<string, unknown>) => {
          const { help: _help, ...rest } = previous;
          return rest;
        },
      });
    });
    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveProperty('value', 'Unsaved warehouse');
    if (region) expect(screen.getByRole('textbox', { name: 'Region' })).toHaveProperty('value', 'us-west-2');
    if (secret)
      expect(screen.getByLabelText('Secret access key', { exact: true })).toHaveProperty('value', value);
    expect(window.location.search).not.toContain(value);
    expect(window.location.search).not.toContain('help=');
    expect(router.state.location.search).toMatchObject({ source: 'new', kind });
  },
);
