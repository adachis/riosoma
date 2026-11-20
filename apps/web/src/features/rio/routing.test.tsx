import { i18n } from '@lingui/core';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type * as DataHooks from '../../data/hooks';
import type { DatabaseSession } from '../../data/types';
import { openDatabase } from '../../data/session';
import { FakeServer } from '../../data/testing';
import { json, renderSharing, session } from '../../screens/database/share/testing';
import { RioAssistant } from './RioAssistant';
import { RioLauncher } from './RioLauncher';
import { setRioSelection } from './context';

const mounted = vi.hoisted(() => ({
  session: null as DatabaseSession | null,
  failedDatabase: null as string | null,
}));
vi.mock('../../data/hooks', async (original) => ({
  ...(await original<typeof DataHooks>()),
  useDatabaseSession: (id: string | null) => {
    if (id && id === mounted.failedDatabase) throw new Error('Database unavailable');
    return id === mounted.session?.databaseId ? mounted.session : null;
  },
}));
afterEach(() => {
  cleanup();
  mounted.session?.close();
  mounted.session = null;
  mounted.failedDatabase = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
});

it.each([false, true])('keeps an approval link closed after an explicit close (phone: %s)', async (phone) => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  window.history.replaceState(null, '', '#remote-approval=11111111-1111-4111-8111-111111111111');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/rio/active-conversation') return json({ conversation: { id: 'one' }, messages: [] });
      if (url.includes('/remote-approvals/'))
        return json({ status: 'succeeded', server: 'Outside', tool: 'inspect', arguments: {} });
      if (url.endsWith('/status'))
        return json({ enabled: true, paused: false, tiers: ['everyday'], autonomy: 'ask' });
      return json([]);
    }),
  );
  const root = createRootRoute({
    component: () => (
      <>
        <RioLauncher phone={phone} />
        <Outlet />
      </>
    ),
  });
  const home = createRoute({ getParentRoute: () => root, path: '/', component: () => null });
  const next = createRoute({ getParentRoute: () => root, path: '/gallery', component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([home, next]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const app = renderSharing(<RouterProvider router={router} />);
  const user = userEvent.setup();
  await screen.findByText('Finished');
  await user.click(screen.getByRole('button', { name: 'Close Rio' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Close Rio' })).toBeNull());
  await act(async () => {
    await router.navigate({ to: '/gallery' });
  });
  expect(screen.getByRole('button', { name: 'AI: Ask Rio' }).getAttribute('aria-expanded')).toBe('false');
  app.client.clear();
});

it('keeps Rio closed after the launcher opens it and the person navigates', async () => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/rio/active-conversation'
        ? json({ conversation: { id: 'one' }, messages: [] })
        : url.endsWith('/status')
          ? json({ enabled: true, paused: false, tiers: ['everyday'], autonomy: 'ask' })
          : json([]),
    ),
  );
  const root = createRootRoute({
    component: () => (
      <>
        <RioLauncher phone={false} />
        <Outlet />
      </>
    ),
  });
  const home = createRoute({ getParentRoute: () => root, path: '/', component: () => null });
  const next = createRoute({ getParentRoute: () => root, path: '/gallery', component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([home, next]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const app = renderSharing(<RouterProvider router={router} />);
  const user = userEvent.setup();

  await user.click(await screen.findByRole('button', { name: 'AI: Ask Rio' }));
  await user.click(await screen.findByRole('button', { name: 'Close Rio' }));
  await act(async () => {
    await router.navigate({ to: '/gallery' });
  });
  expect(screen.queryByRole('button', { name: 'Close Rio' })).toBeNull();
  expect(screen.getByRole('button', { name: 'AI: Ask Rio' }).getAttribute('aria-expanded')).toBe('false');
  await user.click(screen.getByRole('button', { name: 'AI: Ask Rio' }));
  expect(await screen.findByRole('button', { name: 'Close Rio' })).toBeTruthy();
  app.client.clear();
});

it('keeps the phone conversation and draft while its sheet yields to a plan preview', async () => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/rio/active-conversation')
        return json({
          conversation: { id: 'one' },
          messages: [
            {
              id: 'earlier',
              role: 'rio',
              blocks: [{ kind: 'text', text: '[Preview](/?rioPreview=plan-one)' }],
              createdAt: '2026-10-04T10:00:00Z',
            },
          ],
        });
      if (url.endsWith('/status'))
        return json({ enabled: true, paused: false, tiers: ['everyday'], autonomy: 'ask' });
      return json([]);
    }),
  );
  const root = createRootRoute({
    component: () => (
      <>
        <RioAssistant phone />
        <Outlet />
      </>
    ),
  });
  const home = createRoute({ getParentRoute: () => root, path: '/', component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([home]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const app = renderSharing(<RouterProvider router={router} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'AI: Ask Rio' }));
  const input = await screen.findByRole('textbox');
  await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
  await user.type(input, 'A draft to keep');
  await user.click(screen.getByRole('link', { name: 'Preview' }));
  await waitFor(() => expect(router.state.location.searchStr).toBe('?rioPreview=plan-one'));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rio' })).toBeNull());
  expect(screen.getByRole('button', { name: 'AI: Ask Rio' }).getAttribute('aria-expanded')).toBe('true');
  await act(async () => {
    await router.navigate({ href: '/' });
  });
  const returned = await screen.findByRole('textbox');
  expect((returned as HTMLTextAreaElement).value).toBe('A draft to keep');
  expect(document.querySelector('.rio-assistant__panel')?.getAttribute('data-conversation-id')).toBe('one');
  expect(screen.getByRole('link', { name: 'Preview' })).toBeDefined();
  app.client.clear();
});

it.each(['loading', 'unavailable'])(
  'keeps Rio usable on a phone when a linked database is %s',
  async (state) => {
    i18n.load('en-US', {});
    i18n.activate('en-US');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = new FakeServer();
    const f = server.createDatabase(1);
    mounted.failedDatabase = state === 'unavailable' ? f.databaseId : null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/rio/active-conversation'
          ? json({ conversation: { id: 'one' }, messages: [] })
          : url.endsWith('/status')
            ? json({ enabled: true, paused: false, tiers: ['everyday'], autonomy: 'ask' })
            : json([]),
      ),
    );
    const root = createRootRoute({ component: () => <RioAssistant phone initialOpen /> });
    const card = createRoute({
      getParentRoute: () => root,
      path: '/$databaseId/$tableId/$viewId/$recordId',
      component: () => null,
    });
    const router = createRouter({
      routeTree: root.addChildren([card]),
      history: createMemoryHistory({
        initialEntries: [`/${f.databaseId}/${f.tableId}/${f.viewId}/${f.recordId(0)}`],
      }),
    });
    const app = renderSharing(<RouterProvider router={router} />);
    expect(await screen.findByRole('dialog', { name: 'Rio' })).toBeDefined();
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false));
    app.client.clear();
  },
);

it('keeps a phone record link open for its card and returns to Rio on the full page', async () => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  const server = new FakeServer();
  const f = server.createDatabase(1);
  mounted.session = await openDatabase(f.databaseId, server.deps());
  const href = `/${f.databaseId}/${f.tableId}/${f.viewId}/${f.recordId(0)}`;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/rio/active-conversation')
        return json({
          conversation: { id: 'one' },
          messages: [
            {
              id: 'earlier',
              role: 'rio',
              blocks: [{ kind: 'text', text: `[Open record](${href})` }],
              createdAt: '2026-10-04T10:00:00Z',
            },
          ],
        });
      if (url.endsWith('/status'))
        return json({ enabled: true, paused: false, tiers: ['everyday'], autonomy: 'ask' });
      return json([]);
    }),
  );
  const root = createRootRoute({
    component: () => (
      <>
        <RioAssistant phone />
        <Outlet />
      </>
    ),
  });
  const appRoute = createRoute({ getParentRoute: () => root, id: 'app' });
  const home = createRoute({ getParentRoute: () => appRoute, path: '/', component: () => null });
  const card = createRoute({
    getParentRoute: () => appRoute,
    path: '/$databaseId/$tableId/$viewId/$recordId',
    component: () => null,
  });
  const full = createRoute({
    getParentRoute: () => card,
    path: 'page',
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([appRoute.addChildren([home, card.addChildren([full])])]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const app = renderSharing(<RouterProvider router={router} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'AI: Ask Rio' }));
  const input = await screen.findByRole('textbox');
  await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
  await user.type(input, 'A draft to keep');
  await user.click(screen.getByRole('link', { name: 'Open record' }));
  await waitFor(() => expect(router.state.location.pathname).toBe(href));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rio' })).toBeNull());
  expect(screen.getByRole('button', { name: 'AI: Ask Rio' }).getAttribute('aria-expanded')).toBe('true');
  await act(async () => {
    await router.navigate({ href: `${href}/page` });
  });
  expect(((await screen.findByRole('textbox')) as HTMLTextAreaElement).value).toBe('A draft to keep');
  expect(document.querySelector('.rio-assistant__panel')?.getAttribute('data-conversation-id')).toBe('one');
  app.client.clear();
});

it.each([false, true])(
  'updates the page context and keeps reply links and the active stream open (phone: %s)',
  async (phone) => {
    i18n.load('en-US', {});
    i18n.activate('en-US');
    const server = new FakeServer();
    const f = server.createDatabase(1);
    mounted.session = await openDatabase(f.databaseId, server.deps());
    setRioSelection(mounted.session, f.viewId, async () => ({
      recordIds: [f.recordId(0)],
      fieldIds: [f.textFieldId],
    }));
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/rio/active-conversation')
        return json({
          conversation: { id: 'one' },
          messages: [
            {
              id: 'earlier',
              role: 'rio',
              blocks: [{ kind: 'text', text: '[Home](/)' }],
              createdAt: '2026-10-04T10:00:00Z',
            },
          ],
        });
      if (url.endsWith('/status'))
        return json({ enabled: true, paused: false, tiers: ['everyday'], autonomy: 'ask' });
      if (url.endsWith('/messages')) {
        signal = init?.signal ?? undefined;
        return new Response(new ReadableStream<Uint8Array>(), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (url.endsWith('/conversations')) return json(init?.method === 'POST' ? { id: 'one' } : []);
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const root = createRootRoute({
      component: () => (
        <>
          <RioAssistant phone={phone} />
          <Outlet />
        </>
      ),
    });
    const database = createRoute({
      getParentRoute: () => root,
      path: '/$databaseId/$tableId/$viewId/$recordId',
      component: () => null,
    });
    const home = createRoute({ getParentRoute: () => root, path: '/', component: () => null });
    const router = createRouter({
      routeTree: root.addChildren([database, home]),
      history: createMemoryHistory({
        initialEntries: [`/${f.databaseId}/${f.tableId}/${f.viewId}/${f.recordId(0)}`],
      }),
    });
    const app = renderSharing(<RouterProvider router={router} />, {
      ...session,
      preferences: { ...session.preferences, recordLayout: 'panel' },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'AI: Ask Rio' }));
    const input = await screen.findByRole('textbox');
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
    await user.type(input, 'Explain the selection{Enter}');
    await waitFor(() => expect(signal).toBeDefined());
    const request = fetcher.mock.calls.find(([url]) => url.endsWith('/messages'))!;
    expect(JSON.parse(request[1]!.body as string).context).toEqual({
      databaseId: f.databaseId,
      tableId: f.tableId,
      viewId: f.viewId,
      recordId: f.recordId(0),
      recordIds: [f.recordId(0)],
      fieldIds: [f.textFieldId],
    });
    await user.click(screen.getByRole('link', { name: 'Home' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(signal?.aborted).toBe(false);
    expect(screen.getByRole('textbox')).toBeDefined();
    expect(screen.getByText('Explain the selection')).toBeDefined();
    expect(document.querySelector('.rio-assistant__panel')?.getAttribute('data-conversation-id')).toBe('one');
    expect(screen.getByText('Now in Home')).toBeDefined();
    app.client.clear();
  },
);
