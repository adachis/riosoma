import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { type HomeListing, type SessionInfo } from '@riosoma/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { makeRouter } from './router';
import { sessionQuery, setupStatusQuery } from './session';
import { homeQuery } from './screens/home/folders';
import { databaseSummary } from './screens/home/test-support';

const session: SessionInfo = {
  user: { id: 'visitor', name: 'Visitor', email: 'visitor@example.test', locale: 'en-US' },
  org: { id: 'organization', name: 'Example', settings: {} },
  membership: { kind: 'member', adminRoles: [] },
  preferences: {},
  csrfToken: '',
  demo: true,
};
const shared = { ...databaseSummary(), parentId: null, owned: false, shared: true };
const listing: HomeListing = { folders: [], databases: [shared] };

afterEach(() => vi.unstubAllGlobals());

async function land(path: string, files = listing, demo = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(setupStatusQuery.queryKey, { stage: 'ready', databaseManaged: false });
  client.setQueryData(sessionQuery.queryKey, (): SessionInfo => ({ ...session, demo }));
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify(files), { headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetcher);
  const router = makeRouter(client);
  const history = createMemoryHistory({ initialEntries: ['/previous', path] });
  router.update({ history, context: { queryClient: client } });
  await router.load();
  return { router, history, client, fetcher };
}

it.each(['/', '/home'])(
  'lands a demo visitor on shared files from %s and replaces the address',
  async (path) => {
    const { router, history, client, fetcher } = await land(path);
    expect(router.state.location.pathname).toBe('/home/shared');
    expect(history.location.pathname).toBe('/home/shared');
    expect(client.getQueryData(homeQuery.queryKey)).toEqual(listing);
    expect(fetcher).toHaveBeenCalledOnce();
    history.back();
    expect(history.location.pathname).toBe('/previous');
  },
);

it.each(['/', '/home'])('keeps a demo member with an owned database on %s', async (path) => {
  const { router } = await land(path, {
    ...listing,
    databases: [shared, { ...shared, id: 'owned-database', owned: true }],
  });
  expect(router.state.location.pathname).toBe(path);
});

it('keeps a requested home action and help topic when landing on shared files', async () => {
  const { router } = await land('/?new=database&help=home');
  expect(router.state.location.pathname).toBe('/home/shared');
  expect(router.state.location.search).toEqual({ new: 'database', help: 'home' });
});

it('counts owned folders and shortcuts as files, but ignores trashed ones', async () => {
  const folder = {
    id: 'folder',
    name: 'My folder',
    parentId: null,
    ownerId: session.user.id,
    path: [],
    role: 'owner' as const,
    shared: false,
    trashed: false,
  };
  expect((await land('/', { ...listing, folders: [folder] })).router.state.location.pathname).toBe('/');
  const shortcut = { id: 'shortcut', parentId: null, owned: true, available: false, trashed: false };
  expect((await land('/', { ...listing, shortcuts: [shortcut] })).router.state.location.pathname).toBe('/');
  expect(
    (
      await land('/', {
        ...listing,
        folders: [{ ...folder, trashed: true }],
        shortcuts: [{ ...shortcut, trashed: true }],
      })
    ).router.state.location.pathname,
  ).toBe('/home/shared');
});

it.each(['/', '/home'])('keeps %s when no shared files exist', async (path) => {
  const { router } = await land(path, { folders: [], databases: [] });
  expect(router.state.location.pathname).toBe(path);
});

it('opens shared folders when no databases exist', async () => {
  const { router } = await land('/', {
    folders: [
      {
        id: 'shared-folder',
        name: 'Team',
        parentId: null,
        ownerId: 'other',
        path: [],
        role: 'reader',
        shared: true,
        trashed: false,
      },
    ],
    databases: [],
  });
  expect(router.state.location.pathname).toBe('/home/shared');
});

it.each(['/', '/home', '/home/my', '/home/shared'])(
  'preserves a real session at %s without a landing read',
  async (path) => {
    const { router, fetcher } = await land(path, listing, false);
    expect(router.state.location.pathname).toBe(path);
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it.each(['/home/my', '/home/shared', '/home/recent'])(
  'preserves a demo visitor’s explicit section at %s',
  async (path) => {
    const { router, fetcher } = await land(path);
    expect(router.state.location.pathname).toBe(path);
    expect(fetcher).not.toHaveBeenCalled();
  },
);
