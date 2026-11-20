import { i18n } from '@lingui/core';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type * as DataHooks from '../../data/hooks';
import type { DatabaseSession } from '../../data';
import { openDatabase } from '../../data/session';
import { preview, source, syncedFixture } from '../../data/testing/synced';
import { SidebarSlot } from '../../shell/AppShell';
import { DatabaseScreen } from './DatabaseScreen';
import { json, renderSharing } from './share/testing';

const mounted = vi.hoisted(() => ({ session: null as DatabaseSession | null }));
vi.mock('../../data/hooks', async (original) => ({
  ...(await original<typeof DataHooks>()),
  useDatabaseSession: () => mounted.session,
}));
vi.mock('../../grid/GridView', () => ({ GridView: () => <div role="grid" aria-label="Grid" /> }));

afterEach(() => {
  cleanup();
  mounted.session?.close();
  mounted.session = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it('keeps the source wizard and chosen fields when the sidebar moves to a phone menu', async () => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (path === '/api/sources') return json([source]);
      if (path.endsWith('/objects'))
        return json([{ schema: 'public', name: 'People', type: 'table', rowEstimate: 1 }]);
      if (path.endsWith('/preview')) return json(preview);
      return json([]);
    }),
  );
  const { server, fixture } = syncedFixture();
  mounted.session = await openDatabase(fixture.databaseId, server.deps());
  const root = createRootRoute({ component: Outlet });
  const database = createRoute({
    getParentRoute: () => root,
    path: '$databaseId',
    component: DatabaseScreen,
  });
  const table = createRoute({ getParentRoute: () => database, path: '$tableId' });
  const view = createRoute({ getParentRoute: () => table, path: '$viewId' });
  const router = createRouter({
    routeTree: root.addChildren([database.addChildren([table.addChildren([view])])]),
    history: createMemoryHistory({
      initialEntries: [`/${fixture.databaseId}/${fixture.tableId}/${fixture.viewId}`],
    }),
  });
  const slot = document.createElement('div');
  document.body.append(slot);
  const element = (target: HTMLElement | null) => (
    <SidebarSlot.Provider value={target}>
      <RouterProvider router={router} />
    </SidebarSlot.Provider>
  );
  let move: (target: HTMLElement | null) => void = () => undefined;
  function Frame() {
    const [target, setTarget] = useState<HTMLElement | null>(slot);
    move = setTarget;
    return element(target);
  }
  renderSharing(<Frame />);
  await screen.findByRole('grid');
  await userEvent.click(screen.getByRole('button', { name: 'Add a table' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /^Sync from a data source(?: |$)/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Sync from a data source' });
  await userEvent.click(within(dialog).getByRole('button', { name: /Choose a data source/ }));
  await userEvent.click(screen.getByRole('option', { name: /^Warehouse(?: |$)/ }));
  await waitFor(() =>
    expect(within(dialog).getByRole('button', { name: 'Next' }).hasAttribute('disabled')).toBe(false),
  );
  await userEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
  await userEvent.click(within(dialog).getByRole('option', { name: /^People(?: |$)/ }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
  const nameGroup = await within(dialog).findByRole('group', { name: 'name' });
  const name = within(nameGroup).getByRole('textbox', { name: 'Field name' });
  await userEvent.clear(name);
  await userEvent.type(name, 'Vessel');
  await act(async () => move(null));
  expect(screen.getByRole('dialog', { name: 'Sync from a data source' })).toBe(dialog);
  expect((within(nameGroup).getByRole('textbox', { name: 'Field name' }) as HTMLInputElement).value).toBe(
    'Vessel',
  );
  const phoneSlot = document.createElement('div');
  document.body.append(phoneSlot);
  await act(async () => move(phoneSlot));
  expect(screen.getByRole('dialog', { name: 'Sync from a data source' })).toBe(dialog);
  expect((within(nameGroup).getByRole('textbox', { name: 'Field name' }) as HTMLInputElement).value).toBe(
    'Vessel',
  );
});
