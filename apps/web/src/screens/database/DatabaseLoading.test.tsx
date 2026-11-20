import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { newId } from '@riosoma/contracts';
import type * as DataHooks from '../../data/hooks';
import { SidebarSlot } from '../../shell/AppShell';
import { DatabaseScreen } from './DatabaseScreen';
import { json, renderSharing } from './share/testing';

vi.mock('../../data/hooks', async (original) => ({
  ...(await original<typeof DataHooks>()),
  useDatabaseSession: () => null,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('exposes a labeled loading group while database data is unavailable', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json([])),
  );
  const root = createRootRoute({ component: Outlet });
  const database = createRoute({
    getParentRoute: () => root,
    path: '$databaseId',
    component: DatabaseScreen,
  });
  const router = createRouter({
    routeTree: root.addChildren([database]),
    history: createMemoryHistory({ initialEntries: [`/${newId('database')}`] }),
  });
  const slot = document.createElement('div');
  document.body.append(slot);
  renderSharing(
    <SidebarSlot.Provider value={slot}>
      <RouterProvider router={router} />
    </SidebarSlot.Provider>,
  );
  try {
    const loading = await screen.findByRole('group', { name: 'Loading record' });
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/');
  } finally {
    slot.remove();
  }
});
