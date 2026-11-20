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
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@riosoma/ui';
import type * as DataHooks from '../../data/hooks';
import type { DatabaseSession } from '../../data/types';
import { SidebarSlot } from '../../shell/AppShell';
import { DatabaseScreen } from './DatabaseScreen';
import {
  closeAll,
  everyBlock,
  interfaceFixture,
  PAGE_ID,
  type InterfaceFixture,
} from './interfaces/test-support';
import { paletteItems } from './screen/paletteItems';
import { json, renderSharing } from './share/testing';

const mounted = vi.hoisted(() => ({ session: null as DatabaseSession | null }));
vi.mock('../../data/hooks', async (original) => ({
  ...(await original<typeof DataHooks>()),
  useDatabaseSession: (id: string | null) => (id === mounted.session?.databaseId ? mounted.session : null),
}));
vi.mock('../../grid/GridView', () => ({ GridView: () => <div role="grid" aria-label="Grid" /> }));
vi.mock('./dashboards/echarts', () => ({
  mountChart: () => ({ update: () => undefined, resize: () => undefined, dispose: () => undefined }),
}));

const sessions: DatabaseSession[] = [];
beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json([])),
  );
});
afterEach(() => {
  cleanup();
  closeAll(sessions);
  mounted.session = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** The database routes as the app declares them, with the screen on the database route. */
async function mount(
  path: (setup: InterfaceFixture) => string,
  options: Parameters<typeof interfaceFixture>[0] = { blocks: everyBlock },
) {
  const setup = await interfaceFixture({
    ...options,
    pages: (ids) => [{ id: 'pageLater01', name: 'Later', blocks: [] }, ...(options.pages?.(ids) ?? [])],
  });
  sessions.push(setup.session);
  mounted.session = setup.session;
  const root = createRootRoute({ component: Outlet });
  const database = createRoute({
    getParentRoute: () => root,
    path: '$databaseId',
    component: DatabaseScreen,
  });
  const table = createRoute({ getParentRoute: () => database, path: '$tableId' });
  const view = createRoute({ getParentRoute: () => table, path: '$viewId' });
  const record = createRoute({ getParentRoute: () => view, path: '$recordId' });
  const face = createRoute({ getParentRoute: () => database, path: 'interfaces/$interfaceId' });
  const page = createRoute({
    getParentRoute: () => face,
    path: '$pageId',
    validateSearch: (search: Record<string, unknown>): { block?: string; record?: string } => ({
      ...(typeof search.block === 'string' ? { block: search.block } : {}),
      ...(typeof search.record === 'string' ? { record: search.record } : {}),
    }),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      database.addChildren([table.addChildren([view.addChildren([record])]), face.addChildren([page])]),
    ]),
    history: createMemoryHistory({ initialEntries: [path(setup)] }),
  });
  const slot = document.createElement('div');
  document.body.append(slot);
  renderSharing(
    <SidebarSlot.Provider value={slot}>
      <RouterProvider router={router} />
    </SidebarSlot.Provider>,
  );
  const sidebar = () => within(slot).getByRole('region', { name: 'Interfaces' });
  return { ...setup, router, sidebar };
}

describe('interfaces in the database screen', () => {
  it('opens a page with a picked record from its deep link, with the sidebar showing where you are', async () => {
    const setup = await mount(
      (setup) =>
        `/${setup.fixture.databaseId}/interfaces/${setup.value.id}/${PAGE_ID}?block=blkRecords01&record=${setup.fixture.recordId(2)}`,
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'Front desk' })).toBeDefined();
    const details = screen.getByRole('article', { name: 'Details' });
    expect(((await within(details).findByRole('textbox', { name: 'Name' })) as HTMLInputElement).value).toBe(
      'Record 3',
    );
    expect(screen.queryByRole('grid')).toBeNull();
    const link = within(setup.sidebar()).getByRole('link', { name: 'Front desk' });
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(link.getAttribute('href')).toBe(`/${setup.fixture.databaseId}/interfaces/${setup.value.id}`);
    expect(screen.getByRole('link', { name: 'Table' }).hasAttribute('aria-current')).toBe(false);
    await waitFor(() => expect(document.title).toBe('Front desk – Database'));
    // Other pages are a tab away, each with its own link.
    const pages = screen.getByRole('navigation', { name: 'Pages' });
    expect(within(pages).getByRole('link', { name: 'Requests' }).getAttribute('aria-current')).toBe('page');
    await userEvent.click(within(pages).getByRole('link', { name: 'Later' }));
    await waitFor(() =>
      expect(setup.router.state.location.pathname).toBe(
        `/${setup.fixture.databaseId}/interfaces/${setup.value.id}/pageLater01`,
      ),
    );
    expect(await screen.findByText(/^This page is empty\./)).toBeDefined();
  });

  it('opens an interface’s first page, and sends links to missing pages and interfaces to what’s there', async () => {
    const notices = vi.spyOn(toast, 'show');
    const setup = await mount(
      (setup) => `/${setup.fixture.databaseId}/interfaces/${setup.value.id}/pageGone01`,
    );
    expect(await screen.findByRole('article', { name: 'Queue' })).toBeDefined();
    await waitFor(() =>
      expect(setup.router.state.location.pathname).toBe(
        `/${setup.fixture.databaseId}/interfaces/${setup.value.id}/${PAGE_ID}`,
      ),
    );
    expect(notices).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: 'That link pointed to something that no longer exists, so here’s the closest match.',
      }),
    );
    cleanup();
    notices.mockClear();
    const missing = await mount((setup) => `/${setup.fixture.databaseId}/interfaces/itf00000000000000`);
    await waitFor(() =>
      expect(missing.router.state.location.pathname).toBe(
        `/${missing.fixture.databaseId}/${missing.fixture.tableId}/${missing.fixture.viewId}`,
      ),
    );
    expect(await screen.findByRole('grid')).toBeDefined();
    expect(notices).toHaveBeenCalledOnce();
  });

  it('adds an interface from the sidebar and opens its first page', async () => {
    const setup = await mount(
      (setup) => `/${setup.fixture.databaseId}/${setup.fixture.tableId}/${setup.fixture.viewId}`,
    );
    await screen.findByRole('grid');
    await userEvent.click(within(setup.sidebar()).getByRole('button', { name: 'Add an interface' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Untitled interface' })).toBeDefined();
    const created = setup.session.getSchema().interfaces.find((item) => item.name === 'Untitled interface')!;
    expect(created.position).toBe(1);
    expect(created.pages).toEqual([{ id: expect.any(String), name: 'Page 1', blocks: [] }]);
    expect(setup.router.state.location.pathname).toBe(
      `/${setup.fixture.databaseId}/interfaces/${created.id}`,
    );
    expect(screen.getByText(/^This page is empty\./)).toBeDefined();
    await waitFor(() =>
      expect(setup.commands().map((command) => command.kind)).toContain('interface.create'),
    );
  });

  it('leaves a deleted interface for the table without a notice, and undo brings it back', async () => {
    const notices = vi.spyOn(toast, 'show');
    const setup = await mount((setup) => `/${setup.fixture.databaseId}/interfaces/${setup.value.id}`);
    await screen.findByRole('heading', { level: 2, name: 'Front desk' });
    await userEvent.click(within(setup.sidebar()).getByRole('button', { name: 'More for Front desk' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete interface' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete interface' }));
    await waitFor(() =>
      expect(setup.router.state.location.pathname).toBe(
        `/${setup.fixture.databaseId}/${setup.fixture.tableId}/${setup.fixture.viewId}`,
      ),
    );
    expect(await screen.findByRole('grid')).toBeDefined();
    await waitFor(() =>
      expect(within(setup.sidebar()).queryByRole('link', { name: 'Front desk' })).toBeNull(),
    );
    expect(notices).not.toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'That link pointed to something that no longer exists, so here’s the closest match.',
      }),
    );
    await waitFor(() => expect(setup.commands().map((command) => command.kind)).toContain('interface.trash'));
    await act(async () => {
      await setup.session.undo();
    });
    expect(await within(setup.sidebar()).findByRole('link', { name: 'Front desk' })).toBeDefined();
  });

  it('shows interfaces to readers without the controls, and offers them in the palette', async () => {
    const setup = await mount((setup) => `/${setup.fixture.databaseId}/interfaces/${setup.value.id}`, {
      blocks: everyBlock,
      role: 'reader',
    });
    await screen.findByRole('heading', { level: 2, name: 'Front desk' });
    expect(within(setup.sidebar()).queryByRole('button', { name: 'Add an interface' })).toBeNull();
    await userEvent.click(within(setup.sidebar()).getByRole('button', { name: 'More for Front desk' }));
    expect(screen.getByRole('menuitem', { name: 'Add shortcut to home' })).toBeDefined();
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete interface' })).toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Edit interface' })).toBeNull();
    const items = paletteItems(setup.session.getSchema(), setup.fixture.databaseId, i18n);
    expect(items.find((item) => item.group === 'interfaces')).toMatchObject({
      id: setup.value.id,
      label: 'Front desk',
      secondary: 'Database',
      path: `/${setup.fixture.databaseId}/interfaces/${setup.value.id}`,
    });
  });
});
