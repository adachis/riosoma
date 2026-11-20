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
import { decodeWhere, newId } from '@riosoma/contracts';
import { toast } from '@riosoma/ui';
import type * as DataHooks from '../../data/hooks';
import type { DatabaseSession } from '../../data/types';
import { findAnchor } from '../../demos/actions';
import { DemoRunner } from '../../demos/runner';
import { loadDemo } from '../../demos/scripts';
import { SidebarSlot } from '../../shell/AppShell';
import { DatabaseScreen } from './DatabaseScreen';
import {
  DONE,
  closeAll,
  dashboardFixture,
  everyKind,
  type DashboardFixture,
} from './dashboards/test-support';
import { json, renderSharing } from './share/testing';

const mounted = vi.hoisted(() => ({ session: null as DatabaseSession | null, loading: false }));
vi.mock('../../data/hooks', async (original) => ({
  ...(await original<typeof DataHooks>()),
  useDatabaseSession: (id: string | null) =>
    !mounted.loading && id === mounted.session?.databaseId ? mounted.session : null,
}));
vi.mock('../../grid/GridView', () => ({
  GridView: () => <div role="grid" aria-label="Grid" data-anchor="grid" />,
}));
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
  mounted.loading = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** The database routes as the app declares them, with the screen on the database route. */
async function mount(path: (setup: DashboardFixture) => string, tiles = everyKind, withSession = true) {
  const setup = await dashboardFixture({ tiles });
  sessions.push(setup.session);
  mounted.session = withSession ? setup.session : null;
  const root = createRootRoute({ component: Outlet });
  const database = createRoute({
    getParentRoute: () => root,
    path: '$databaseId',
    component: DatabaseScreen,
  });
  const table = createRoute({ getParentRoute: () => database, path: '$tableId' });
  const view = createRoute({ getParentRoute: () => table, path: '$viewId' });
  const record = createRoute({ getParentRoute: () => view, path: '$recordId' });
  const dashboard = createRoute({ getParentRoute: () => database, path: 'dashboards/$dashboardId' });
  const router = createRouter({
    routeTree: root.addChildren([
      database.addChildren([table.addChildren([view.addChildren([record])]), dashboard]),
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
  const sidebar = () => within(slot).getByRole('region', { name: 'Dashboards' });
  return { ...setup, router, sidebar };
}

const commands = (setup: DashboardFixture) =>
  setup.server.requests
    .filter((request) => request.path.endsWith('/commands'))
    .flatMap((request) => (request.options.body as { commands: Array<{ kind: string }> }).commands);

it.each(['view', 'dashboard', 'round trip', 'unmount'])(
  'keeps later navigation after delayed view creation (%s)',
  async (destination) => {
    const setup = await mount(
      (setup) => `/${setup.fixture.databaseId}/${setup.fixture.tableId}/${setup.fixture.viewId}`,
    );
    await screen.findByRole('grid');
    const address = setup.router.state.location.pathname;
    const existing = newId('view');
    await act(async () => {
      await setup.session.run([
        {
          kind: 'view.create',
          view: {
            id: existing,
            tableId: setup.fixture.tableId,
            name: 'Other view',
            type: 'grid',
            config: {},
          },
        },
      ]).done;
    });
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    setup.server.beforeRequest = async (request) => {
      if (request.path.endsWith('/commands')) await held;
    };
    const runs = vi.spyOn(setup.session, 'run');
    await userEvent.click(screen.getByRole('button', { name: 'Add view' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Gallery' }));
    const action = runs.mock.results.at(-1)!.value;
    await act(async () => {
      if (destination === 'unmount') cleanup();
      else {
        await setup.router.navigate({
          to:
            destination === 'dashboard'
              ? `/${setup.fixture.databaseId}/dashboards/${setup.dashboard.id}`
              : `/${setup.fixture.databaseId}/${setup.fixture.tableId}/${existing}`,
        });
        if (destination === 'round trip') await setup.router.navigate({ to: address });
      }
    });
    const selected = setup.router.state.location.pathname;
    await act(async () => {
      release!();
      await action.done;
    });
    expect(
      setup.session
        .getSchema()
        .views.get(setup.fixture.tableId)!
        .some((view) => view.type === 'gallery'),
    ).toBe(true);
    expect(setup.router.state.location.pathname).toBe(selected);
  },
);

it('keeps the current view after the server rejects creating another view', async () => {
  const setup = await mount(
    (setup) => `/${setup.fixture.databaseId}/${setup.fixture.tableId}/${setup.fixture.viewId}`,
  );
  await screen.findByRole('grid');
  const existing = newId('view');
  await act(async () => {
    await setup.session.run([
      {
        kind: 'view.create',
        view: {
          id: existing,
          tableId: setup.fixture.tableId,
          name: 'Existing view',
          type: 'grid',
          config: {},
        },
      },
    ]).done;
    await setup.router.navigate({ to: `/${setup.fixture.databaseId}/${setup.fixture.tableId}/${existing}` });
  });
  const address = setup.router.state.location.pathname;
  const before = commands(setup).length;
  setup.server.rejectNext();
  await userEvent.click(screen.getByRole('button', { name: 'Add view' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Gallery' }));
  await waitFor(() => expect(commands(setup).length).toBeGreaterThan(before));
  await waitFor(() => expect(setup.router.state.location.pathname).toBe(address));
  expect(screen.getByRole('grid')).toBeTruthy();
});

it('gives the loading placeholder a named group while the database is unavailable', async () => {
  const root = createRootRoute({ component: Outlet });
  const database = createRoute({
    getParentRoute: () => root,
    path: '$databaseId',
    component: DatabaseScreen,
  });
  const router = createRouter({
    routeTree: root.addChildren([database]),
    history: createMemoryHistory({ initialEntries: ['/dbAAAAAAAAAAAAAA'] }),
  });
  const slot = document.createElement('div');
  document.body.append(slot);
  renderSharing(
    <SidebarSlot.Provider value={slot}>
      <RouterProvider router={router} />
    </SidebarSlot.Provider>,
  );
  const placeholder = await screen.findByLabelText('Loading record');
  expect(placeholder.getAttribute('role')).toBe('group');
  expect(placeholder.getAttribute('aria-busy')).toBe('true');
});

it('labels the pending database frame as a busy group', async () => {
  mounted.loading = true;
  await mount((setup) => `/${setup.fixture.databaseId}/${setup.fixture.tableId}/${setup.fixture.viewId}`);
  expect((await screen.findByRole('group', { name: 'Loading record' })).getAttribute('aria-busy')).toBe(
    'true',
  );
});

it('names the busy database frame while its session is loading', async () => {
  await mount(
    (setup) => `/${setup.fixture.databaseId}/${setup.fixture.tableId}/${setup.fixture.viewId}`,
    () => [],
    false,
  );
  const loading = await screen.findByRole('group', { name: 'Loading record' });
  expect(loading.getAttribute('aria-busy')).toBe('true');
  expect(screen.queryByRole('grid')).toBeNull();
  expect(screen.getByRole('link', { name: 'Home' })).toBeDefined();
});

describe('demos in the database screen', () => {
  it('plays the synced-table demo and points home for favorites without the default shell navigation', async () => {
    const setup = await mount(
      (setup) => `/${setup.fixture.databaseId}/${setup.fixture.tableId}/${setup.fixture.viewId}`,
    );
    await screen.findByRole('grid');
    const path = setup.router.state.location.pathname;
    const script = (await loadDemo('synced-tables'))!;
    const said: string[] = [];
    const runner = new DemoRunner(script, {
      document,
      narrate: (line) => {
        said.push(line.text);
        return { done: Promise.resolve('ended'), stop: () => undefined };
      },
      stopNarration: () => undefined,
      sandbox: { begin: () => undefined, reset: () => undefined, end: () => undefined },
      say: (id) => id,
      lang: 'en-US',
      reducedMotion: () => true,
      aboveLevel: false,
      timing: { find: 0, beat: 0, gap: 0 },
    });
    try {
      await act(() => runner.start());
      await waitFor(() => expect(runner.getState().status).toBe('ended'));
      expect(runner.getState().outcome).toBe('finished');
      expect(said).toEqual(script.steps.map((step) => step.say));
      expect(commands(setup)).toEqual([]);
      expect(setup.router.state.location.pathname).toBe(path);
      const favorites = (await loadDemo('trash-and-favorites'))!.steps.at(-1)!;
      expect(findAnchor(document, favorites.anchor)).toBe(screen.getByRole('link', { name: 'Home' }));
    } finally {
      await act(() => runner.stop());
    }
  });
});

describe('dashboards in the database screen', () => {
  it('opens a dashboard from its deep link, with the sidebar showing where you are', async () => {
    const setup = await mount((setup) => `/${setup.fixture.databaseId}/dashboards/${setup.dashboard.id}`);
    expect(await screen.findByRole('heading', { level: 2, name: 'Operations' })).toBeDefined();
    expect(screen.queryByRole('grid')).toBeNull();
    const link = within(setup.sidebar()).getByRole('link', { name: 'Operations' });
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(link.getAttribute('href')).toBe(`/${setup.fixture.databaseId}/dashboards/${setup.dashboard.id}`);
    expect(screen.getByRole('link', { name: 'Table' }).hasAttribute('aria-current')).toBe(false);
    await waitFor(() => expect(document.title).toBe('Operations – Database'));
    expect(setup.router.state.location.pathname).toBe(
      `/${setup.fixture.databaseId}/dashboards/${setup.dashboard.id}`,
    );
  });

  it('sends a link to a missing dashboard to the first table, and says so', async () => {
    const notices = vi.spyOn(toast, 'show');
    const setup = await mount((setup) => `/${setup.fixture.databaseId}/dashboards/dsh00000000000000`);
    await waitFor(() =>
      expect(setup.router.state.location.pathname).toBe(
        `/${setup.fixture.databaseId}/${setup.fixture.tableId}/${setup.fixture.viewId}`,
      ),
    );
    expect(await screen.findByRole('grid')).toBeDefined();
    expect(notices).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: 'That link pointed to something that no longer exists, so here’s the closest match.',
      }),
    );
  });

  it('adds a dashboard from the sidebar and opens it', async () => {
    const setup = await mount(
      (setup) => `/${setup.fixture.databaseId}/${setup.fixture.tableId}/${setup.fixture.viewId}`,
    );
    await screen.findByRole('grid');
    await userEvent.click(within(setup.sidebar()).getByRole('button', { name: 'Add a dashboard' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Untitled dashboard' })).toBeDefined();
    const created = setup.session.getSchema().dashboards.find((item) => item.name === 'Untitled dashboard')!;
    expect(created.position).toBe(1);
    expect(setup.router.state.location.pathname).toBe(
      `/${setup.fixture.databaseId}/dashboards/${created.id}`,
    );
    expect(screen.getByText(/^This dashboard is empty\./)).toBeDefined();
    await waitFor(() => expect(commands(setup).map((command) => command.kind)).toContain('dashboard.create'));
    await userEvent.click(within(setup.sidebar()).getByRole('link', { name: 'Operations' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Operations' })).toBeDefined();
  });

  it('leaves a deleted dashboard for the table without a notice, and undo brings it back', async () => {
    const notices = vi.spyOn(toast, 'show');
    const setup = await mount((setup) => `/${setup.fixture.databaseId}/dashboards/${setup.dashboard.id}`);
    await screen.findByRole('heading', { level: 2, name: 'Operations' });
    await userEvent.click(within(setup.sidebar()).getByRole('button', { name: 'More for Operations' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete dashboard' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete dashboard' }));
    await waitFor(() =>
      expect(setup.router.state.location.pathname).toBe(
        `/${setup.fixture.databaseId}/${setup.fixture.tableId}/${setup.fixture.viewId}`,
      ),
    );
    expect(await screen.findByRole('grid')).toBeDefined();
    expect(within(setup.sidebar()).queryByRole('link', { name: 'Operations' })).toBeNull();
    expect(notices).not.toHaveBeenCalled();
    await waitFor(() => expect(commands(setup).map((command) => command.kind)).toContain('dashboard.trash'));
    await act(async () => {
      await setup.session.undo();
    });
    expect(await within(setup.sidebar()).findByRole('link', { name: 'Operations' })).toBeDefined();
  });

  it('reopens the records behind a chart from the address, and opens them in a narrowed grid view', async () => {
    const setup = await mount(
      (setup) => `/${setup.fixture.databaseId}/dashboards/${setup.dashboard.id}?drill=tileChart01:t${DONE}`,
    );
    const sheet = await screen.findByRole('dialog', { name: 'Status is Done, 2 records' });
    await act(async () => {
      await setup.session.run([
        {
          kind: 'view.update',
          viewId: setup.fixture.viewId,
          config: { dataBars: [{ fieldId: setup.fixture.numberFieldId, color: 'blue' }] },
        },
      ]).done;
    });
    const ranges: Array<string | null> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        if (path.includes('/ranges?')) {
          ranges.push(new URL(path, 'http://localhost').searchParams.get('where'));
          return json({ ranges: [{ fieldId: setup.fixture.numberFieldId, min: 1, max: 3 }] });
        }
        return json([]);
      }),
    );
    await userEvent.click(within(sheet).getByRole('link', { name: 'Open in Grid' }));
    await waitFor(() =>
      expect(setup.router.state.location.pathname).toBe(
        `/${setup.fixture.databaseId}/${setup.fixture.tableId}/${setup.fixture.viewId}`,
      ),
    );
    const where = (setup.router.state.location.search as { where?: string }).where!;
    expect(decodeWhere(where)).toMatchObject({ conjunction: 'and' });
    expect(await screen.findByRole('grid')).toBeDefined();
    expect(
      screen.getByText(/^This view shows only the records behind part of a dashboard chart\./),
    ).toBeDefined();
    await waitFor(() =>
      expect(
        setup.server.requests.some(
          (request) =>
            request.path.includes('/rows?') &&
            new URL(request.path, 'http://localhost').searchParams.get('where') === where,
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(ranges).toEqual([where]));
    await userEvent.click(screen.getByRole('button', { name: 'Show all records' }));
    await waitFor(() =>
      expect((setup.router.state.location.search as { where?: string }).where).toBeUndefined(),
    );
    await waitFor(() => expect(ranges).toEqual([where, null]));
    expect(screen.queryByText(/^This view shows only the records behind/)).toBeNull();
  });

  it('renames and reorders dashboards from the sidebar', async () => {
    const setup = await mount((setup) => `/${setup.fixture.databaseId}/dashboards/${setup.dashboard.id}`);
    await screen.findByRole('heading', { level: 2, name: 'Operations' });
    await userEvent.click(within(setup.sidebar()).getByRole('button', { name: 'Add a dashboard' }));
    await screen.findByRole('heading', { level: 2, name: 'Untitled dashboard' });
    await userEvent.click(
      within(setup.sidebar()).getByRole('button', { name: 'More for Untitled dashboard' }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = await screen.findByRole('textbox', { name: 'Rename' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Hiring{Enter}');
    expect(await screen.findByRole('heading', { level: 2, name: 'Hiring' })).toBeDefined();
    within(setup.sidebar()).getByRole('link', { name: 'Hiring' }).focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(
      within(setup.sidebar())
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Hiring', 'Operations']);
    await waitFor(() =>
      expect(commands(setup).map((command) => command.kind)).toEqual([
        'dashboard.create',
        'dashboard.update',
        'dashboard.move',
        'database.navigation',
      ]),
    );
  });
});
