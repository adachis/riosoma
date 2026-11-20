import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeScreen } from '../HomeScreen';
import { databaseSummary, renderHome } from './test-support';

const navigate = vi.hoisted(() => vi.fn());
/** What the address asks for, which the palette sets and Home clears again. */
const search = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: '/' }),
  useNavigate: () => navigate,
  useSearch: () => search.current,
}));

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  search.current = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (path === '/api/trash') return json({ databases: [] });
      // The template list is its own thing; the new database form is what these tests are after.
      if (path === '/api/templates') return json([]);
      return json([databaseSummary()]);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  search.current = {};
});

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // A fresh element each time, so a rerender is a rerender rather than React seeing the same one.
  const tree = () => (
    <QueryClientProvider client={client}>
      <HomeScreen />
    </QueryClientProvider>
  );
  const view = renderHome(tree());
  return { ...view, again: () => view.rerender(tree()) };
}

/** The call that cleans the address, and what it keeps while doing it. */
function cleared(): Record<string, unknown> {
  const call = navigate.mock.calls.map(([argument_]) => argument_).find((value) => value.to === '.');
  expect(call).toBeDefined();
  expect(call.replace).toBe(true);
  return call.search({ new: 'database', trash: '1', help: 'themes' }) as Record<string, unknown>;
}

describe('the palette’s commands on the home screen', () => {
  it('opens the new database dialog for ?new=database', async () => {
    search.current = { new: 'database' };
    setup();
    expect(await screen.findByRole('dialog', { name: 'New database' })).toBeDefined();
    expect(screen.queryByRole('dialog', { name: 'New database from a CSV or Excel file' })).toBeNull();
    expect(cleared()).toEqual({ help: 'themes' });
  });

  it('opens the import for ?new=import', async () => {
    search.current = { new: 'import' };
    setup();
    expect(
      await screen.findByRole('dialog', { name: 'New database from a CSV or Excel file' }),
    ).toBeDefined();
    expect(cleared()).toEqual({ help: 'themes' });
  });

  it('opens the deleted databases for ?trash=1', async () => {
    search.current = { trash: '1' };
    setup();
    expect(await screen.findByRole('dialog', { name: 'Deleted databases' })).toBeDefined();
    expect(cleared()).toEqual({ help: 'themes' });
  });

  it('opens both when the address asks for both', async () => {
    search.current = { new: 'database', trash: '1' };
    setup();
    expect(await screen.findByRole('dialog', { name: 'Deleted databases' })).toBeDefined();
    expect(cleared()).toEqual({ help: 'themes' });
  });

  it('leaves the address alone when it asks for nothing', async () => {
    setup();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('answers the same command again once the address is clean', async () => {
    const user = userEvent.setup();
    search.current = { new: 'database' };
    const view = setup();
    await screen.findByRole('dialog', { name: 'New database' });
    navigate.mockClear();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    // The address was cleaned, so the next ask is a new one rather than a repeat.
    search.current = {};
    view.again();
    search.current = { new: 'import' };
    view.again();
    await screen.findByRole('dialog', { name: 'New database from a CSV or Excel file' });
    expect(cleared()).toEqual({ help: 'themes' });
  });

  it('ignores an ask it doesn’t know', async () => {
    search.current = { new: 'whatever', trash: 'yes' };
    setup();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
