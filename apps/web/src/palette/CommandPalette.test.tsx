import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { newId, type DatabaseSummary, type SessionInfo } from '@riosoma/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useShortcut } from '../shortcuts/useShortcut';
import { CommandPalette } from './CommandPalette';
import { clearRecent, rememberPlace } from './recent';
import { PaletteSourcesProvider, usePaletteItems } from './sources';
import type { PaletteItem } from './types';
import { sessionQuery } from '../session';
import { shortcutKeys } from '../shortcuts/registry';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

function database(name: string): DatabaseSummary {
  return {
    id: newId('database'),
    name,
    icon: null,
    color: 'blue',
    role: 'owner',
    updatedAt: '2026-09-27T09:00:00Z',
    favorite: false,
    openedAt: null,
  };
}

/** What a database screen offers: its tables and views, each with the path that opens it. */
function screenItems(databaseId: string, databaseName: string): PaletteItem[] {
  const tableId = newId('table');
  const viewId = newId('view');
  return [
    {
      id: tableId,
      group: 'tables',
      label: 'Tasks',
      secondary: databaseName,
      path: `/${databaseId}/${tableId}`,
    },
    {
      id: viewId,
      group: 'views',
      label: 'This week',
      secondary: `Tasks · ${databaseName}`,
      path: `/${databaseId}/${tableId}/${viewId}`,
    },
  ];
}

/** Stands in for a screen: it offers its places while it is mounted, and nothing once it isn't. */
function Offers({ items }: { items: readonly PaletteItem[] }) {
  usePaletteItems('screen', items);
  return null;
}

interface HarnessProps {
  items: readonly PaletteItem[];
  canManagePeople: boolean;
  canUseTokens: boolean;
  onOpenHelp: () => void;
  onSendFeedback: () => void;
  onSignOut: () => void;
}

function Harness({
  items,
  canManagePeople,
  canUseTokens,
  onOpenHelp,
  onSendFeedback,
  onSignOut,
}: HarnessProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [screenOpen, setScreenOpen] = useState(true);
  // The shell binds the shortcut; the palette is what it opens.
  useShortcut('palette.open', () => setIsOpen(true));
  return (
    <PaletteSourcesProvider>
      {screenOpen ? <Offers items={items} /> : null}
      <button type="button" aria-label="Search" onClick={() => setIsOpen(true)}>
        Search
      </button>
      <button type="button" onClick={() => setScreenOpen((open) => !open)}>
        close screen
      </button>
      <input aria-label="cell" />
      <CommandPalette
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        canManagePeople={canManagePeople}
        canUseTokens={canUseTokens}
        onOpenHelp={onOpenHelp}
        onSendFeedback={onSendFeedback}
        onSignOut={onSignOut}
      />
    </PaletteSourcesProvider>
  );
}

interface SetupOptions {
  databases?: DatabaseSummary[];
  items?: PaletteItem[];
  canManagePeople?: boolean;
  canUseTokens?: boolean;
}

interface Setup {
  user: ReturnType<typeof userEvent.setup>;
  databases: DatabaseSummary[];
  items: PaletteItem[];
  onOpenHelp: ReturnType<typeof vi.fn>;
  onSendFeedback: ReturnType<typeof vi.fn>;
  onSignOut: ReturnType<typeof vi.fn>;
}

function setup(options: SetupOptions = {}): Setup {
  const databases = options.databases ?? [database('Projects')];
  const items = options.items ?? screenItems(databases[0]!.id, databases[0]!.name);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(databases)),
  );
  const onOpenHelp = vi.fn();
  const onSendFeedback = vi.fn();
  const onSignOut = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (options.canUseTokens === false)
    client.setQueryData(sessionQuery.queryKey, (): SessionInfo => ({
      user: { id: 'guest-user', name: 'Guest', email: 'guest@example.test', locale: 'en-US' },
      org: { id: 'org-test', name: 'Test', settings: {} },
      membership: { kind: 'guest', adminRoles: [] },
      preferences: {},
      csrfToken: '',
    }));
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={i18n}>
        <Harness
          items={items}
          canManagePeople={options.canManagePeople ?? false}
          canUseTokens={options.canUseTokens ?? true}
          onOpenHelp={onOpenHelp}
          onSendFeedback={onSendFeedback}
          onSignOut={onSignOut}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), databases, items, onOpenHelp, onSendFeedback, onSignOut };
}

const dialog = () => screen.getByRole('dialog', { name: 'Search and commands' });
const field = () => screen.getByRole('searchbox');
const list = () => screen.getByRole('listbox');
const option = (name: string) => screen.getByRole('option', { name });
const options = () => screen.getAllByRole('option');
/** The row keys, which say both what a row is and which group it came from. */
const keys = () => options().map((node) => node.getAttribute('data-key'));
const group = (name: string) => within(list()).getByRole('group', { name });
const groups = () =>
  within(list())
    .queryAllByRole('group')
    .map((node) => node.querySelector('header')?.textContent ?? '');
const keysIn = (name: string) =>
  within(group(name))
    .getAllByRole('option')
    .map((node) => node.getAttribute('data-key'));

/** Opens the palette with ⌘K and waits for its rows. */
async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Meta>}k{/Meta}');
  const panel = await screen.findByRole('dialog', { name: 'Search and commands' });
  // The commands are always there; the databases only turn up once there is something to search.
  await screen.findByRole('option', { name: 'Go home' });
  return panel;
}

beforeEach(() => {
  navigate.mockClear();
  clearRecent();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearRecent();
  localStorage.clear();
});

describe('opening', () => {
  it('opens on ⌘K and Ctrl+K, from the page and from inside a field, and not on a plain K', async () => {
    const { user } = setup();
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.keyboard('{Meta>}k{/Meta}');
    expect(dialog()).toBeDefined();
    // The field takes focus, so a query can start straight away.
    await waitFor(() => expect(document.activeElement).toBe(field()));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();

    const cell = screen.getByRole('textbox', { name: 'cell' });
    await user.click(cell);
    await user.keyboard('k');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((cell as HTMLInputElement).value).toBe('k');
    await user.keyboard('{Meta>}k{/Meta}');
    expect(dialog()).toBeDefined();
    await user.keyboard('{Escape}');
    await user.keyboard('{Control>}k{/Control}');
    expect(dialog()).toBeDefined();
    // The palette borrows the key, not the text: the cell keeps what was typed.
    expect((cell as HTMLInputElement).value).toBe('k');
  });

  it('opens from the header button', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(dialog()).toBeDefined();
  });

  it('names the dialog and says what the field searches', async () => {
    const { user } = setup();
    await open(user);
    expect(field().getAttribute('aria-label')).toBe('Search databases, tables, views, and commands');
    expect(field().getAttribute('placeholder')).toBe('Search databases, tables, views, and commands');
  });
});

describe('what it shows', () => {
  it('shows recent places, the open database’s tables, and the commands with nothing typed', async () => {
    rememberPlace({ id: 'db_a', kind: 'databases', label: 'Budget', path: '/db_a' });
    rememberPlace({
      id: 'view_a',
      kind: 'views',
      label: 'This month',
      secondary: 'Tasks · Projects',
      path: '/db_a/tbl_a/view_a',
    });
    const { user, items } = setup();
    await open(user);
    expect(groups()).toEqual(['Recent', 'Tables', 'Commands']);
    expect(keys()).toEqual([
      'recent:view_a',
      'recent:db_a',
      items[0]!.id,
      'cmd:home',
      'cmd:newDatabase',
      'cmd:import',
      'cmd:importAirtable',
      'cmd:importNocodb',
      'cmd:importBaserow',
      'cmd:importGrist',
      'cmd:importTeable',
      'cmd:importSeatable',
      'cmd:importClickup',
      'cmd:importAsana',
      'cmd:importNotion',
      'cmd:importMonday',
      'cmd:importSmartsheet',
      'cmd:trash',
      'cmd:appearance',
      'cmd:language',
      'cmd:levels',
      'cmd:help',
      'cmd:feedback',
      'cmd:signOut',
    ]);
    // The second line a place was remembered with comes back with it.
    expect(option('This month Tasks · Projects').textContent).toContain('Tasks · Projects');
    // A view and the databases wait for a query, so the first list stays short.
    expect(screen.queryByRole('option', { name: 'This week Tasks · Projects' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Projects' })).toBeNull();
  });

  it('shows at most five recent places, newest first', async () => {
    for (const name of ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'])
      rememberPlace({ id: name, kind: 'databases', label: name, path: `/${name}` });
    const { user } = setup();
    await open(user);
    expect(
      within(group('Recent'))
        .getAllByRole('option')
        .map((node) => node.textContent),
    ).toEqual(['Seven', 'Six', 'Five', 'Four', 'Three']);
  });

  it('searches every group once something is typed', async () => {
    const { user, databases, items } = setup();
    await open(user);
    await user.type(field(), 'e');
    expect(groups()).toEqual(['Databases', 'Tables', 'Views', 'Features', 'Commands']);
    expect(keysIn('Databases')).toEqual([databases[0]!.id]);
    expect(keysIn('Tables')).toEqual([items[0]!.id]);
    expect(keysIn('Views')).toEqual([items[1]!.id]);
    // The features a level can tidy away wait for a query, like the views.
    expect(keysIn('Features')).toEqual(['cmd:tokens', 'cmd:api', 'cmd:mcp']);
    // Every command but Sign out holds an ‘e’, and a group shows its best eight.
    expect(keysIn('Commands')).toHaveLength(8);
    expect(keysIn('Commands')).not.toContain('cmd:signOut');
  });

  it('offers personal access tokens only to people who can hold them, as settings does', async () => {
    const guest = setup({ canUseTokens: false });
    await open(guest.user);
    await guest.user.type(field(), 'tokens');
    expect(screen.queryByRole('option', { name: 'Personal access tokens' })).toBeNull();
    await guest.user.clear(field());
    await guest.user.type(field(), 'New database');
    expect(screen.queryByRole('option', { name: 'New database' })).toBeNull();
    cleanup();
    const member = setup({ canUseTokens: true });
    await open(member.user);
    await member.user.type(field(), 'tokens');
    expect(option('Personal access tokens')).toBeDefined();
  });

  it('names the database a table belongs to, and the table and database a view belongs to', async () => {
    const { user } = setup();
    await open(user);
    await user.type(field(), 'tasks');
    expect(option('Tasks Projects').textContent).toContain('Projects');
    expect(option('This week Tasks · Projects').textContent).toContain('Tasks · Projects');
  });

  it('ranks the closest match first', async () => {
    const { user } = setup({
      databases: [database('Old projects'), database('Projects'), database('Budget')],
    });
    await open(user);
    await user.type(field(), 'proj');
    expect(
      within(group('Databases'))
        .getAllByRole('option')
        .map((node) => node.textContent),
    ).toEqual(['Projects', 'Old projects']);
    expect(screen.queryByRole('option', { name: 'Budget' })).toBeNull();
  });

  it('caps each group at eight rows', async () => {
    const many = Array.from({ length: 12 }, (_, index) => database(`Zebra ${index}`));
    const { user } = setup({ databases: many });
    await open(user);
    await user.type(field(), 'zebra');
    expect(within(group('Databases')).getAllByRole('option')).toHaveLength(8);
  });

  it('says so when nothing matches', async () => {
    const { user } = setup();
    await open(user);
    await user.type(field(), 'zzz');
    expect(screen.queryAllByRole('option')).toEqual([]);
    expect(screen.getByText('Nothing matches “zzz”.')).toBeDefined();
  });

  it('offers a screen’s places only while the screen is open', async () => {
    const { user, items } = setup();
    await open(user);
    expect(option('Tasks Projects')).toBeDefined();
    // The click is fired rather than pointed, since a press outside a modal dismisses it.
    fireEvent.click(screen.getByRole('button', { name: 'close screen' }));
    expect(keys()).not.toContain(items[0]!.id);
    expect(screen.queryByRole('option', { name: 'Tasks Projects' })).toBeNull();
    // The commands are the palette's own, so they outlive any screen.
    expect(option('Go home')).toBeDefined();
  });
});

describe('the keyboard', () => {
  it('moves the active row with the arrow keys without moving focus out of the field', async () => {
    const { user, items } = setup();
    await open(user);
    await user.type(field(), 'tasks');
    // 'Tasks' matches on its label and 'This week' on its second line, so both are here.
    expect(keys()).toEqual([items[0]!.id, items[1]!.id]);
    // The first row starts out active, so Enter has something to open before any arrow moves.
    expect(field().getAttribute('aria-activedescendant')).toBe(option('Tasks Projects').id);
    await user.keyboard('{ArrowDown}');
    expect(field().getAttribute('aria-activedescendant')).toBe(option('This week Tasks · Projects').id);
    expect(document.activeElement).toBe(field());
    await user.keyboard('{ArrowUp}');
    expect(field().getAttribute('aria-activedescendant')).toBe(option('Tasks Projects').id);
    // The top is the end of the road, not a loop back around to the bottom.
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(field().getAttribute('aria-activedescendant')).toBe(option('Tasks Projects').id);
    await user.keyboard('{End}');
    expect(field().getAttribute('aria-activedescendant')).toBe(option('This week Tasks · Projects').id);
    await user.keyboard('{Home}');
    expect(field().getAttribute('aria-activedescendant')).toBe(option('Tasks Projects').id);
    // Typing keeps working while the arrows do the moving.
    await user.keyboard('s');
    expect((field() as HTMLInputElement).value).toBe('taskss');
  });

  it('opens the active row with Enter and the row under the pointer with a click', async () => {
    const { user, items } = setup();
    await open(user);
    await user.type(field(), 'tasks');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(navigate).toHaveBeenCalledWith({ to: items[1]!.path });
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.keyboard('{Meta>}k{/Meta}');
    await screen.findByRole('option', { name: 'Go home' });
    navigate.mockClear();
    await user.click(option('Tasks Projects'));
    expect(navigate).toHaveBeenCalledWith({ to: items[0]!.path });
  });

  it('opens the first match with Enter when no arrow has moved', async () => {
    const { user, databases } = setup();
    await open(user);
    await user.type(field(), 'proj');
    await user.keyboard('{Enter}');
    expect(navigate).toHaveBeenCalledWith({ to: `/${databases[0]!.id}` });
  });

  it('closes on Escape and puts focus back where it was', async () => {
    const { user } = setup();
    const trigger = screen.getByRole('button', { name: 'Search' });
    await user.click(trigger);
    await screen.findByRole('option', { name: 'Go home' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('puts focus back in the cell the palette was called from', async () => {
    const { user } = setup();
    const cell = screen.getByRole('textbox', { name: 'cell' });
    await user.click(cell);
    await user.keyboard('{Meta>}k{/Meta}');
    await screen.findByRole('option', { name: 'Go home' });
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(cell);
  });

  it('leaves on Escape even with something typed, and starts clean next time', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('option', { name: 'Go home' });
    await user.type(field(), 'proj');
    expect((field() as HTMLInputElement).value).toBe('proj');
    await user.keyboard('{Escape}');
    // Escape leaves rather than spending itself on clearing the query.
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.keyboard('{Meta>}k{/Meta}');
    await screen.findByRole('option', { name: 'Go home' });
    expect((field() as HTMLInputElement).value).toBe('');
  });
});

describe('recent places', () => {
  it('remembers what it opens and offers it first next time', async () => {
    const { user, databases } = setup();
    await open(user);
    await user.type(field(), 'proj');
    await user.keyboard('{Enter}');
    expect(navigate).toHaveBeenCalledWith({ to: `/${databases[0]!.id}` });
    expect(JSON.parse(localStorage.getItem('rio.recentPlaces') ?? '[]')).toEqual([
      { id: databases[0]!.id, kind: 'databases', label: 'Projects', path: `/${databases[0]!.id}` },
    ]);

    await user.keyboard('{Meta>}k{/Meta}');
    await screen.findByRole('group', { name: 'Recent' });
    expect(keys()).toContain(`recent:${databases[0]!.id}`);
    expect(
      within(group('Recent'))
        .getAllByRole('option')
        .map((node) => node.textContent),
    ).toEqual(['Projects']);
    // The newest place is the row Enter opens, so going back is two keys.
    navigate.mockClear();
    await user.keyboard('{Enter}');
    expect(navigate).toHaveBeenCalledWith({ to: `/${databases[0]!.id}` });
    // Opening a place from Recent remembers the place, not the row it was shown in.
    expect(JSON.parse(localStorage.getItem('rio.recentPlaces') ?? '[]')).toEqual([
      { id: databases[0]!.id, kind: 'databases', label: 'Projects', path: `/${databases[0]!.id}` },
    ]);
  });

  it('still works when storage throws', async () => {
    const denied = () => {
      throw new Error('denied');
    };
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied, removeItem: denied });
    const { user, databases } = setup();
    await open(user);
    await user.type(field(), 'proj');
    await user.keyboard('{Enter}');
    expect(navigate).toHaveBeenCalledWith({ to: `/${databases[0]!.id}` });
    // Opening again works the same, with or without anywhere to keep the list.
    await user.keyboard('{Meta>}k{/Meta}');
    await screen.findByRole('option', { name: 'Tasks Projects' });
    expect(dialog()).toBeDefined();
  });
});

describe('commands', () => {
  const destinations: Array<[string, Record<string, unknown>]> = [
    ['Go home', { to: '/' }],
    ['New database', { to: '/', search: { new: 'database' } }],
    ['New database from a CSV or Excel file', { to: '/', search: { new: 'import' } }],
    ['Open the trash', { to: '/', search: { trash: '1' } }],
    ['Change theme and color scheme', { to: '/settings/$section', params: { section: 'appearance' } }],
    ['Change language', { to: '/settings/$section', params: { section: 'language' } }],
  ];
  for (const [label, expected] of destinations) {
    it(`sends “${label}” where it belongs`, async () => {
      const { user } = setup();
      await open(user);
      await user.click(option(label));
      expect(navigate).toHaveBeenCalledWith(expected);
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  }

  it('offers Manage people only to those who can', async () => {
    const nobody = setup();
    await open(nobody.user);
    expect(screen.queryByRole('option', { name: 'Manage people' })).toBeNull();
    cleanup();

    const { user } = setup({ canManagePeople: true });
    await open(user);
    await user.click(option('Manage people'));
    expect(navigate).toHaveBeenCalledWith({ to: '/settings/$section', params: { section: 'people' } });
  });

  it('asks the shell to open help and to sign out', async () => {
    const { user, onOpenHelp, onSignOut } = setup();
    await open(user);
    await user.click(option('Open help'));
    expect(onOpenHelp).toHaveBeenCalledOnce();
    await user.keyboard('{Meta>}k{/Meta}');
    await screen.findByRole('option', { name: 'Sign out' });
    await user.click(option('Sign out'));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it('asks the shell to open feedback, over whatever page the person is on', async () => {
    const { user, onSendFeedback } = setup();
    await open(user);
    await user.click(option('Send feedback'));
    expect(onSendFeedback).toHaveBeenCalledOnce();
  });

  it('finds a command by a word from the middle of it', async () => {
    const { user } = setup();
    await open(user);
    await user.type(field(), 'csv');
    expect(keys()).toEqual(['cmd:import']);
  });
});

describe('the palette’s background', () => {
  it('grows roots behind the list while “rhizome” is typed, and never takes the typing', async () => {
    const { user } = setup();
    await open(user);
    expect(within(dialog()).queryByTestId('palette-roots')).toBeNull();
    await user.type(field(), 'Rhizome');
    const roots = within(dialog()).getByTestId('palette-roots');
    expect(roots.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).toBe(field());
    await user.type(field(), 's');
    expect(field()).toHaveProperty('value', 'Rhizomes');
    expect(within(dialog()).queryByTestId('palette-roots')).toBeNull();
  });
});

it('includes a command shortcut and a place description in their accessible names', async () => {
  const { user } = setup({
    items: [
      {
        id: 'shortcut-place',
        group: 'tables',
        label: 'Tasks',
        secondary: 'Projects',
        shortcut: 'palette.open',
        path: '/db/table',
      },
    ],
  });
  await open(user);
  const item = screen.getByRole('option', { name: `Tasks ${shortcutKeys('palette.open')} Projects` });
  expect(item.textContent).toContain(shortcutKeys('palette.open'));
  expect(item.textContent).toContain('Projects');
});
