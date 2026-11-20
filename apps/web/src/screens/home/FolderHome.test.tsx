import { cleanup, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  DATABASE_ROLES,
  HomeCommand,
  newId,
  type HomeFolder,
  type HomeListing,
  type SessionInfo,
} from '@riosoma/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { SHORTCUT_DRAG_TYPE } from './shortcuts';
import { FolderHome } from './FolderHome';
import { databaseSummary, renderHome } from './test-support';
import type * as FolderData from './folders';
import { homeQuery } from './folders';
import { sessionQuery } from '../../session';
import { DatabaseCard } from './DatabaseCard';
import { HomeDragItem } from './HomeArrangement';
import { dragItem } from '../../test/sortable';

const route = vi.hoisted(() => ({ pathname: '/', navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useLocation: () => route, useNavigate: () => route.navigate }));
vi.mock('./folders', async (original) => ({
  ...(await original<typeof FolderData>()),
  useHomeRealtime: () => undefined,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  route.pathname = '/';
});
const maker = newId('user');
function folder(overrides: Partial<HomeFolder> = {}): HomeFolder {
  return {
    id: newId('folder'),
    name: 'Projects',
    parentId: null,
    ownerId: maker,
    path: [],
    role: 'owner',
    shared: false,
    trashed: false,
    ...overrides,
  };
}
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function setup(listing: HomeListing) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  client.setQueryData(homeQuery.queryKey, listing);
  client.setQueryData(sessionQuery.queryKey, {
    user: { id: maker },
    membership: { kind: 'member' },
  } as SessionInfo);
  const tree = () => (
    <QueryClientProvider client={client}>
      <FolderHome databases={[]}>
        {(databases) => (
          <ul aria-label="Databases">
            {databases.map((database) => (
              <HomeDragItem key={database.id} id={database.id} name={database.name} as="li">
                {database.name}
              </HomeDragItem>
            ))}
          </ul>
        )}
      </FolderHome>
    </QueryClientProvider>
  );
  const view = renderHome(tree());
  return {
    ...view,
    show(path: string) {
      route.pathname = path;
      view.rerender(tree());
    },
  };
}

it('keeps creation permissions while disabling actions until the initial folder layout settles', async () => {
  let complete!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, {
    user: { id: maker },
    membership: { kind: 'member' },
  } as SessionInfo);
  renderHome(
    <QueryClientProvider client={client}>
      <FolderHome databases={[]}>
        {(_databases, _onMove, canCreate, initialLoading) => (
          <button disabled={!canCreate || initialLoading} data-permitted={String(canCreate)}>
            Import database
          </button>
        )}
      </FolderHome>
    </QueryClientProvider>,
  );
  const action = screen.getByRole('button', { name: 'Import database' }) as HTMLButtonElement;
  expect(action.disabled).toBe(true);
  expect(action.dataset.permitted).toBe('true');
  complete(json({ folders: [folder()], databases: [] }));
  await waitFor(() => expect(action.disabled).toBe(false));
});

it('shows the requested files and accessible breadcrumbs at deep links', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ databases: [] })),
  );
  const parent = folder();
  const child = folder({ name: 'Drafts', parentId: parent.id, path: [parent.id] });
  const hidden = folder({ name: 'Trashed', trashed: true });
  const shared = folder({ name: 'Team files', ownerId: newId('user'), shared: true });
  const database = { ...databaseSummary(), name: 'Budget', parentId: child.id, owned: true, shared: false };
  const view = setup({ folders: [parent, child, hidden, shared], databases: [database] });
  expect(screen.getByRole('button', { name: 'Projects' })).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Drafts' })).toBeNull();
  expect(screen.queryByText('Budget')).toBeNull();
  view.show(`/home/folders/${child.id}`);
  const path = screen.getByRole('navigation', { name: 'Folder path' });
  expect(within(path).getByRole('link', { name: 'Projects' }).getAttribute('href')).toBe(
    `/home/folders/${parent.id}`,
  );
  expect(screen.getByText('Budget')).toBeDefined();
  view.show('/home/shared');
  expect(screen.getByRole('button', { name: 'Team files' })).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Projects' })).toBeNull();
  view.show('/home/trash');
  expect(screen.getByText('Trashed')).toBeDefined();
});

it.each(DATABASE_ROLES)('offers database moves only to owners for the %s role', async (role) => {
  const onMove = vi.fn();
  const database = databaseSummary({ role });
  renderHome(
    <DatabaseCard database={database} href={`/db/${database.id}`} onOpen={vi.fn()} onMove={onMove} />,
  );
  const link = screen.getByRole('link', { name: /Projects/ });
  expect(link.parentElement?.getAttribute('draggable')).toBeNull();
  const menu = screen.queryByRole('button', { name: 'More for Projects' });
  if (role === 'owner') {
    await userEvent.click(menu!);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to…' }));
    expect(onMove).toHaveBeenCalledOnce();
  } else expect(menu).toBeNull();
});

it('shows deleted databases beside folders on the Trash page', async () => {
  const deleted = folder({ name: 'Old files', trashed: true });
  const database = { ...databaseSummary({ name: 'Old budget' }), trashedAt: new Date().toISOString() };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ databases: [database] })),
  );
  route.pathname = '/home/trash';
  setup({ folders: [deleted], databases: [] });
  expect(screen.getByText('Old files')).toBeDefined();
  expect(await screen.findByRole('button', { name: 'Restore Old budget' })).toBeDefined();
  expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('creates a nested folder with the keyboard through the command bus', async () => {
  const parent = folder();
  const listing = { folders: [parent], databases: [] };
  route.pathname = `/home/folders/${parent.id}`;
  const commands: HomeCommand[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options: RequestInit) => {
      if (path === '/api/home/commands') {
        commands.push(HomeCommand.parse(JSON.parse(String(options.body))));
        return json({ id: commands[0]!.id });
      }
      return json(listing);
    }),
  );
  setup(listing);
  await userEvent.click(screen.getByRole('button', { name: 'New folder' }));
  await userEvent.type(await screen.findByRole('textbox', { name: 'Folder name' }), 'Drafts{Enter}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(commands).toHaveLength(1);
  expect(commands[0]!.action).toMatchObject({ kind: 'folder.create', name: 'Drafts', parentId: parent.id });
});

it('shows a folder made while the listing was still being read', async () => {
  const made = folder({ name: 'Private planning' });
  const commands: HomeCommand[] = [];
  const held: Array<(value: Response) => void> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options: RequestInit) => {
      if (path === '/api/home/commands') {
        commands.push(HomeCommand.parse(JSON.parse(String(options.body))));
        return json({ id: commands[0]!.id });
      }
      if (path === '/api/home') {
        // Until the folder exists, the listing read stays open, as a slow one on a busy install
        // does, and every read after it answers with the new folder in it.
        if (!commands.length)
          return new Promise<Response>((settle) => {
            held.push(settle);
          });
        return json({ folders: [made], databases: [] } satisfies HomeListing);
      }
      return json({ databases: [] });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(sessionQuery.queryKey, {
    user: { id: maker },
    membership: { kind: 'member' },
  } as SessionInfo);
  renderHome(
    <QueryClientProvider client={client}>
      <FolderHome databases={[]}>{() => null}</FolderHome>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(held).toHaveLength(1));
  await userEvent.click(screen.getByRole('button', { name: 'New folder' }));
  await userEvent.type(
    await screen.findByRole('textbox', { name: 'Folder name' }),
    'Private planning{Enter}',
  );
  await waitFor(() => expect(commands).toHaveLength(1));
  // The read that was already running answers from before the folder existed, so what it brings
  // cannot be the last word on the listing.
  held[0]!(json({ folders: [], databases: [] } satisfies HomeListing));
  expect(await screen.findByRole('button', { name: 'Private planning' })).toBeDefined();
});

it('requires a named access review before a keyboard move and excludes descendant destinations', async () => {
  const parent = folder();
  const child = folder({ name: 'Drafts', parentId: parent.id, path: [parent.id] });
  const listing = { folders: [parent, child], databases: [] };
  const commands: HomeCommand[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options: RequestInit) => {
      if (path === '/api/home/move-preview') return json([{ id: 'person:resource', name: 'Morgan Vale' }]);
      if (path === '/api/home/commands') {
        commands.push(HomeCommand.parse(JSON.parse(String(options.body))));
        return json({ id: commands[0]!.id });
      }
      return json(listing);
    }),
  );
  setup(listing);
  await userEvent.click(screen.getByRole('button', { name: 'More for Projects' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Move to…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Move Projects' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
  expect(await within(dialog).findByText('Morgan Vale')).toBeDefined();
  expect(commands).toHaveLength(0);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm move' }));
  await waitFor(() => expect(commands).toHaveLength(1));
  expect(commands[0]!.action).toEqual({
    kind: 'folder.move',
    folderId: parent.id,
    parentId: null,
    confirmedLosses: ['person:resource'],
  });
});

it('locks the destination while a move preview or command is pending', async () => {
  const parent = folder();
  const listing = { folders: [parent], databases: [] };
  let finishPreview: (value: Response) => void = () => undefined;
  let finishMove: (value: Response) => void = () => undefined;
  const commands: HomeCommand[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options: RequestInit) => {
      if (path === '/api/home/move-preview')
        return new Promise<Response>((resolve) => {
          finishPreview = resolve;
        });
      if (path === '/api/home/commands') {
        commands.push(HomeCommand.parse(JSON.parse(String(options.body))));
        return new Promise<Response>((resolve) => {
          finishMove = resolve;
        });
      }
      return json(listing);
    }),
  );
  setup(listing);
  await userEvent.click(screen.getByRole('button', { name: 'More for Projects' }));
  await userEvent.click(screen.getByRole('menuitem', { name: 'Move to…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Move Projects' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
  const destination = within(dialog).getByRole('button', { name: /Destination/ }) as HTMLButtonElement;
  expect(destination.disabled).toBe(true);
  finishPreview(json([{ id: 'person:resource', name: 'Morgan Vale' }]));
  await within(dialog).findByText('Morgan Vale');
  expect(destination.disabled).toBe(false);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm move' }));
  await waitFor(() => expect(commands).toHaveLength(1));
  expect(destination.disabled).toBe(true);
  finishMove(json({ id: commands[0]!.id }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('filters a tag deep link across folders and databases while keeping private styling explicit', () => {
  const taggedFolder = folder({ name: 'Tagged folder' });
  const otherFolder = folder({ name: 'Other folder' });
  const data = { ...databaseSummary(), parentId: otherFolder.id, owned: true, shared: false };
  const tagId = newId('tag');
  route.pathname = `/home/tags/${tagId}`;
  setup({
    folders: [taggedFolder, otherFolder],
    databases: [data],
    tags: [{ id: tagId, name: 'Launch', color: '#ff3b30', visibility: 'private', owned: true }],
    tagLinks: [
      { tagId, resource: { kind: 'folder', id: taggedFolder.id } },
      { tagId, resource: { kind: 'database', id: data.id } },
    ],
  });
  expect(screen.getByRole('heading', { name: 'Launch' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Tagged folder' })).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Other folder' })).toBeNull();
  expect(within(screen.getByRole('list', { name: 'Databases' })).getByText(data.name)).toBeDefined();
  expect(screen.getAllByText('Private').length).toBeGreaterThan(0);
});

it('shows unavailable aliases without manufacturing a name or destination', () => {
  setup({
    folders: [],
    databases: [],
    shortcuts: [{ id: newId('shortcut'), parentId: null, owned: true, trashed: false, available: false }],
  });
  const list = screen.getByRole('list', { name: 'Shortcuts' });
  expect(within(list).getByText('Unavailable shortcut')).toBeDefined();
  expect(within(list).queryByRole('link')).toBeNull();
});

it('offers root and Trash destinations without treating navigation filters as folders', () => {
  setup({ folders: [], databases: [] });
  for (const name of ['Shared with me', 'Recent', 'Favorites']) {
    expect(screen.getByRole('link', { name }).closest('[data-sortable-parent]')).toBeNull();
  }
  expect(
    screen
      .getAllByRole('link', { name: 'My files' })[0]!
      .closest('[data-sortable-parent]')
      ?.getAttribute('data-sortable-parent'),
  ).toBe('$root');
  expect(
    screen
      .getByRole('link', { name: 'Trash' })
      .closest('[data-sortable-parent]')
      ?.getAttribute('data-sortable-parent'),
  ).toBe('$trash');
});

it.each(['card', 'sidebar'])('files a native shortcut into the destination %s', async (targetKind) => {
  const destination = folder();
  const commands: HomeCommand[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/home/commands') {
        commands.push(HomeCommand.parse(JSON.parse(String(options?.body))));
        return json({ id: commands.at(-1)!.id });
      }
      return json({ folders: [destination], databases: [] });
    }),
  );
  setup({ folders: [destination], databases: [] });
  const target = { kind: 'view', id: newId('view') };
  fireEvent.drop(screen.getByRole(targetKind === 'card' ? 'button' : 'link', { name: 'Projects' }), {
    dataTransfer: { types: [SHORTCUT_DRAG_TYPE], getData: () => JSON.stringify(target) },
  });
  await waitFor(() => expect(commands).toHaveLength(1));
  expect(commands[0]!.action).toMatchObject({ kind: 'shortcut.create', parentId: destination.id, target });
});

it('clears the selection on navigation', async () => {
  const a = folder();
  const b = folder({ name: 'Planning' });
  const view = setup({ folders: [a, b], databases: [] });
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select Projects' }));
  view.show('/home/recent');
  view.show('/');
  expect((screen.getByRole('checkbox', { name: 'Select Projects' }) as HTMLInputElement).checked).toBe(false);
});

it.each(['recent', 'shared', 'tags'])(
  'refuses in-list filing in %s for pointer and immediate moves',
  async (section) => {
    const parent = folder();
    const tagId = newId('tag');
    const openedAt = Date.now();
    // Recent sorts newest first; ArrowDown must target another item rather than the list boundary.
    const databases = ['Alpha', 'Beta'].map((name, index) => ({
      ...databaseSummary({ name }),
      id: newId('database'),
      parentId: parent.id,
      owned: true,
      shared: true,
      openedAt: new Date(openedAt - index * 1_000).toISOString(),
    }));
    const listing: HomeListing = {
      folders: [parent],
      databases,
      tags: [{ id: tagId, name: 'Launch', color: '#ff3b30', visibility: 'private', owned: true }],
      tagLinks: databases.map(({ id }) => ({ tagId, resource: { kind: 'database' as const, id } })),
    };
    const commands: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        if (url === '/api/home/commands') commands.push(JSON.parse(String(options?.body)));
        return json(listing);
      }),
    );
    route.pathname = `/home/${section}${section === 'tags' ? `/${tagId}` : ''}`;
    setup(listing);
    const handle = screen.getByRole('button', { name: 'Move Alpha' });
    handle.focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(commands).toEqual([]);
    expect(document.querySelector('.rio-sortable-refusal')?.textContent).toContain('Drop on a folder');
    await dragItem(handle, screen.getByRole('button', { name: 'Move Beta' }), 0.85, () => {
      expect(document.querySelector('.rio-sortable-refusal')?.textContent).toContain('Drop on a folder');
    });
    expect(commands).toEqual([]);
  },
);

it.each(['Trash', 'Shared with me', 'Recent', 'Favorites'])(
  'refuses native shortcut drops on %s without filing in the current folder',
  async (name) => {
    const parent = folder();
    route.pathname = `/home/folders/${parent.id}`;
    const commands: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        if (url === '/api/home/commands') commands.push(JSON.parse(String(options?.body)));
        return json({ folders: [parent], databases: [] });
      }),
    );
    setup({ folders: [parent], databases: [] });
    const dataTransfer = {
      types: [SHORTCUT_DRAG_TYPE],
      dropEffect: 'copy',
      getData: () => JSON.stringify({ kind: 'view', id: newId('view') }),
    };
    const target = screen.getByRole('link', { name });
    const over = createEvent.dragOver(target, { dataTransfer });
    expect(fireEvent(target, over)).toBe(true);
    expect((over as DragEvent).dataTransfer?.dropEffect).toBe('none');
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() => expect(commands).toEqual([]));
  },
);

it('windows tag navigation and keeps its final tag reachable by keyboard', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const tags = Array.from({ length: 48 }, (_, index) => ({
    id: `tag-${index}`,
    name: `Window tag ${index}`,
    color: '#007aff',
    visibility: 'private' as const,
    owned: true,
  }));
  setup({ folders: [], databases: [], tags });
  const navigation = screen.getByRole('navigation', { name: 'Files' });
  expect(within(navigation).getAllByRole('link', { name: /Window tag/ }).length).toBeLessThan(20);
  const collection = within(navigation).getByRole('list', { name: 'Tags' });
  collection.focus();
  await userEvent.keyboard('{End}');
  const last = within(navigation).getByRole('link', { name: /Window tag 47/ });
  expect(document.activeElement).toBe(last);
  await userEvent.click(last);
  expect(route.navigate).toHaveBeenLastCalledWith({ to: '/home/tags/tag-47' });
  sessionStorage.clear();
});
