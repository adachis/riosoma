import { QueryClient } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { toastQueue } from '@riosoma/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as DataHooks from '../../../data/hooks';
import type { DatabaseSession } from '../../../data/types';
import { makeRouter } from '../../../router';
import { DatabaseScreen } from '../DatabaseScreen';
import { automationHref } from '../screen/routes';
import {
  automationFixture,
  automationMeta,
  bridgeFetch,
  renderWithProviders,
  type AutomationFixture,
} from './test-support';

const mounted = vi.hoisted(() => ({ session: null as DatabaseSession | null }));
vi.mock('../../../data/hooks', async (original) => ({
  ...(await original<typeof DataHooks>()),
  useDatabaseSession: (id: string | null) => (id === mounted.session?.databaseId ? mounted.session : null),
}));

const fixtures: AutomationFixture[] = [];
afterEach(() => {
  cleanup();
  fixtures.splice(0).forEach((fixture) => fixture.session.close());
  mounted.session = null;
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  vi.unstubAllGlobals();
});

describe('the app’s routes', () => {
  it('send /<database>/automations/<automation> to the automation, not a table', () => {
    const router = makeRouter(new QueryClient());
    const matches = router.matchRoutes('/db00000000000001/automations/aut00000000000001');
    const last = matches.at(-1)!;
    expect(last.routeId).toBe('/app/$databaseId/automations/$automationId');
    expect(last.params).toMatchObject({ databaseId: 'db00000000000001', automationId: 'aut00000000000001' });
    expect(last.params).not.toHaveProperty('tableId');
    const table = router.matchRoutes('/db00000000000001/tbl00000000000001/viw00000000000001').at(-1)!;
    expect(table.params).toMatchObject({ tableId: 'tbl00000000000001', viewId: 'viw00000000000001' });
  });
});

async function open(path: (fixture: AutomationFixture, automationId: string) => string) {
  const fixture = await automationFixture({
    automations: ({ databaseId, tasks }) => [
      automationMeta(databaseId, 'Follow up', { trigger: { kind: 'recordCreated', tableId: tasks.id } }),
    ],
  });
  fixtures.push(fixture);
  mounted.session = fixture.session;
  vi.stubGlobal('fetch', bridgeFetch(fixture.server));
  const automationId = fixture.session.getSchema().automations[0]!.id;
  // The same shape as the app: the database screen reads every ID below it.
  const root = createRootRoute({ component: Outlet });
  const database = createRoute({
    getParentRoute: () => root,
    path: '$databaseId',
    component: DatabaseScreen,
  });
  const automation = createRoute({ getParentRoute: () => database, path: 'automations/$automationId' });
  const table = createRoute({ getParentRoute: () => database, path: '$tableId' });
  const view = createRoute({ getParentRoute: () => table, path: '$viewId' });
  const router = createRouter({
    routeTree: root.addChildren([database.addChildren([automation, table.addChildren([view])])]),
    history: createMemoryHistory({ initialEntries: [path(fixture, automationId)] }),
  });
  renderWithProviders(<RouterProvider router={router} />);
  return { fixture, router, automationId };
}

describe('deep links', () => {
  it('open the automation’s screen', async () => {
    await open((fixture, automationId) => automationHref(fixture.databaseId, automationId));
    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveProperty('value', 'Follow up');
    expect(screen.getByRole('switch', { name: 'Off' })).toBeDefined();
    expect(screen.getByRole('region', { name: 'When' })).toBeDefined();
    await waitFor(() => expect(document.title).toBe('Follow up – Database'));
  });

  it('send a link to a missing automation to the database’s first view, and say so', async () => {
    const { fixture, router } = await open((fixture) =>
      automationHref(fixture.databaseId, 'aut00000000000009'),
    );
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/${fixture.databaseId}/${fixture.tasks.id}/${fixture.tasks.viewId}`,
      ),
    );
    expect(toastQueue.visibleToasts.map((toast) => toast.content.title)).toContain(
      'That link pointed to something that no longer exists, so here’s the closest match.',
    );
  });
});
