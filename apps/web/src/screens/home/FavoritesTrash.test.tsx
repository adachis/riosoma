import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CommandBatch } from '@riosoma/contracts';
import { ToastRegion, toastQueue } from '@riosoma/ui';
import { afterEach, expect, it, vi } from 'vitest';
import { HomeScreen } from '../HomeScreen';
import { databaseSummary, renderHome } from './test-support';

const location = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => location,
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
}));
afterEach(() => {
  location.pathname = '/';
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <HomeScreen />
      <ToastRegion />
    </QueryClientProvider>
  );
  const view = renderHome(tree());
  return {
    show(pathname: string) {
      location.pathname = pathname;
      view.rerender(tree());
    },
  };
}
it('lists favorites, recent databases, and My files, and stars without navigating', async () => {
  const favorite = databaseSummary({ name: 'Starred', favorite: true, openedAt: new Date().toISOString() });
  const recent = Array.from({ length: 10 }, (_, n) =>
    databaseSummary({
      name: `Recent ${n}`,
      openedAt: new Date(Date.now() - (n + 1) * 86_400_000).toISOString(),
    }),
  );
  const old = databaseSummary({
    name: 'Old',
    openedAt: new Date(Date.now() - 31 * 86_400_000).toISOString(),
  });
  const all = [favorite, ...recent, old];
  const fetch = vi.fn(async (path: string, options: RequestInit) => {
    if (options.method === 'PUT') {
      const database = all.find((database) => path.includes(database.id))!;
      database.favorite = (JSON.parse(String(options.body)) as { favorite: boolean }).favorite;
      return json({ favorite: database.favorite });
    }
    if (path === '/api/home')
      return json({
        folders: [],
        databases: all.map((database) => ({ ...database, owned: true, shared: false, parentId: null })),
      });
    return json(all);
  });
  vi.stubGlobal('fetch', fetch);
  const view = setup();
  await screen.findByRole('link', { name: /Starred/ });
  expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
    'My files',
    'Databases',
  ]);
  expect(
    screen.getAllByRole('link').filter((link) => link.classList.contains('rio-database-card')),
  ).toHaveLength(12);
  view.show('/home/recent');
  expect(
    screen
      .getAllByRole('link')
      .filter((link) => link.classList.contains('rio-database-card'))
      .map((link) => link.textContent),
  ).toEqual([favorite, ...recent.slice(0, 7)].map((database) => expect.stringContaining(database.name)));
  view.show('/home/favorites');
  expect(
    screen.getAllByRole('link').filter((link) => link.classList.contains('rio-database-card')),
  ).toHaveLength(1);
  const remove = screen.getByRole('button', { name: 'Remove from favorites' });
  remove.focus();
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(screen.queryByRole('link', { name: /Starred/ })).toBeNull());
  view.show('/');
  await userEvent.click(screen.getAllByRole('button', { name: 'Add to favorites' })[0]!);
  view.show('/home/favorites');
  await screen.findByRole('link', { name: /Starred/ });
  expect(fetch).toHaveBeenCalledWith(
    `/api/databases/${favorite.id}/favorite`,
    expect.objectContaining({ method: 'PUT', body: JSON.stringify({ favorite: true }) }),
  );
});

it('opens deleted databases and restores with a valid database.restore command', async () => {
  const database = {
    ...databaseSummary({ name: 'Deleted project' }),
    trashedAt: new Date(Date.now() - 86_400_000).toISOString(),
  };
  let restored = false;
  const commands: CommandBatch[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options: RequestInit) => {
      if (path.endsWith('/commands')) {
        const batch = CommandBatch.parse(JSON.parse(String(options.body)));
        commands.push(batch);
        restored = true;
        return json({
          results: batch.commands.map((command) => ({ id: command.id, status: 'applied', seq: 1 })),
        });
      }
      if (path === '/api/trash') return json({ databases: restored ? [] : [database] });
      return json(restored ? [database] : []);
    }),
  );
  setup();
  await screen.findByRole('heading', { name: 'No databases yet' });
  await userEvent.click(screen.getByRole('button', { name: 'Trash' }));
  await screen.findByRole('dialog', { name: 'Deleted databases' });
  await userEvent.click(await screen.findByRole('button', { name: 'Restore Deleted project' }));
  await screen.findByText('Nothing has been deleted.');
  expect(commands[0]!.commands[0]!.kind).toBe('database.restore');
  await userEvent.keyboard('{Escape}');
  expect(await screen.findByRole('link', { name: /Deleted project/ })).toBeDefined();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Trash' }));
});

it('shows one unlabeled list when nothing is starred or recent', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json([databaseSummary({ name: 'Plain' })])),
  );
  setup();
  await screen.findByRole('link', { name: /Plain/ });
  expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
    'My files',
    'Databases',
  ]);
  expect(screen.queryByRole('region', { name: 'All databases' })).toBeNull();
});

it('lets an owner delete a database after confirming, and Undo brings it back', async () => {
  const owned = databaseSummary({ name: 'Budget' });
  const shared = databaseSummary({ name: 'Shared with me', role: 'editor' });
  let trashed = false;
  const commands: CommandBatch[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options: RequestInit) => {
      if (path.endsWith('/commands')) {
        const batch = CommandBatch.parse(JSON.parse(String(options.body)));
        commands.push(batch);
        trashed = batch.commands[0]!.kind === 'database.trash';
        return json({
          results: batch.commands.map((command) => ({ id: command.id, status: 'applied', seq: 1 })),
        });
      }
      return json(trashed ? [shared] : [owned, shared]);
    }),
  );
  setup();
  await screen.findByRole('link', { name: /Budget/ });
  expect(screen.queryByRole('button', { name: 'More for Shared with me' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'More for Budget' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete database' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete Budget?' });
  expect(dialog.textContent).toContain('You can restore it from the trash for 30 days.');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete database' }));
  await waitFor(() => expect(screen.queryByRole('link', { name: /Budget/ })).toBeNull());
  expect(commands[0]!.commands[0]!.kind).toBe('database.trash');
  await screen.findByText('Deleted Budget');
  await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(commands[1]?.commands[0]!.kind).toBe('database.restore'));
  expect(await screen.findByRole('link', { name: /Budget/ })).toBeDefined();
});
