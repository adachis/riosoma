import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HomeCommand, newId } from '@riosoma/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { TemplateDatabaseForm } from './TemplateDatabaseForm';
import { renderHome } from './test-support';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

it('files a template in the current folder, retries a failed filing with the same database, and refreshes home', async () => {
  const folderId = newId('folder');
  window.history.replaceState(null, '', `/home/folders/${folderId}`);
  const databaseId = newId('database');
  const creations: Array<{ id: string }> = [];
  const moves: HomeCommand[] = [];
  let finish: (value: Response) => void = () => undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options: RequestInit) => {
      if (path === '/api/databases/from-template') {
        creations.push(JSON.parse(String(options.body)) as { id: string });
        return json({ database: { id: databaseId } });
      }
      if (path === '/api/home/commands') {
        moves.push(HomeCommand.parse(JSON.parse(String(options.body))));
        if (moves.length === 1)
          return json({ error: { code: 'unavailable', messageKey: 'errors.tryAgain' } }, 503);
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const onClose = vi.fn();
  renderHome(
    <QueryClientProvider client={client}>
      <TemplateDatabaseForm
        template={{
          id: 'reading-list',
          name: 'Reading list',
          description: '',
          color: 'blue',
          icon: 'book',
          tables: ['Books'],
          category: 'personal',
        }}
        onClose={onClose}
        onPendingChange={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Create' }));
  await screen.findByRole('alert');
  expect(navigate).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Name' }).hasAttribute('readonly')).toBe(true);
  window.history.replaceState(null, '', `/home/folders/${newId('folder')}`);
  await userEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(moves).toHaveLength(2));
  expect(creations).toHaveLength(1);
  expect(moves[1]!.action).toEqual({
    kind: 'database.move',
    databaseId,
    parentId: folderId,
    confirmedLosses: [],
  });
  expect(navigate).not.toHaveBeenCalled();
  await act(() => finish(json({ id: moves[1]!.id })));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: `/${databaseId}` }));
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['home'] });
  expect(onClose).toHaveBeenCalledOnce();
});

it.each([null, newId('folder')])(
  'keeps the starting destination %s when the address changes during template creation',
  async (folderId) => {
    window.history.replaceState(null, '', folderId ? `/home/folders/${folderId}` : '/');
    const databaseId = newId('database');
    let finish: (value: Response) => void = () => undefined;
    const moves: HomeCommand[] = [];
    const fetch = vi.fn(async (path: string, options: RequestInit) => {
      if (path === '/api/databases/from-template')
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      if (path === '/api/home/commands') {
        const command = HomeCommand.parse(JSON.parse(String(options.body)));
        moves.push(command);
        return json({ id: command.id });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetch);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHome(
      <QueryClientProvider client={client}>
        <TemplateDatabaseForm
          template={{
            id: 'reading-list',
            name: 'Reading list',
            description: '',
            color: 'blue',
            icon: 'book',
            tables: ['Books'],
            category: 'personal',
          }}
          onClose={vi.fn()}
          onPendingChange={vi.fn()}
        />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(fetch).toHaveBeenCalledOnce();
    window.history.replaceState(null, '', `/home/folders/${newId('folder')}`);
    await act(() => finish(json({ database: { id: databaseId } })));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: `/${databaseId}` }));
    expect(moves.map((command) => command.action)).toEqual(
      folderId ? [{ kind: 'database.move', databaseId, parentId: folderId, confirmedLosses: [] }] : [],
    );
  },
);

it('keeps the name editable after creation fails and sends the edited name on retry', async () => {
  const creations: Array<{ id: string; name: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_path: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body)) as { id: string; name: string };
      creations.push(body);
      return creations.length === 1
        ? json({ error: { code: 'unavailable', messageKey: 'errors.tryAgain' } }, 503)
        : json({ database: { id: body.id } });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderHome(
    <QueryClientProvider client={client}>
      <TemplateDatabaseForm
        template={{
          id: 'reading-list',
          name: 'Reading list',
          description: '',
          color: 'blue',
          icon: 'book',
          tables: ['Books'],
          category: 'personal',
        }}
        onClose={vi.fn()}
        onPendingChange={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Create' }));
  await screen.findByRole('alert');
  const name = screen.getByRole('textbox', { name: 'Name' });
  expect(name.hasAttribute('readonly')).toBe(false);
  await userEvent.clear(name);
  await userEvent.type(name, 'Revised reading list');
  await userEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  expect(creations).toEqual([
    expect.objectContaining({ name: 'Reading list' }),
    expect.objectContaining({ id: creations[0]!.id, name: 'Revised reading list' }),
  ]);
});
