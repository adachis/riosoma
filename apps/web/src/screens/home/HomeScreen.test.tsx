import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DatabaseCreate, type DatabaseSummary, type HomeFolder, type SessionInfo } from '@riosoma/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { celebrations, type Celebration } from '../../features/celebrations/engine';
import { sessionQuery } from '../../session';
import { HomeScreen } from '../HomeScreen';
import { databaseSummary, renderHome } from './test-support';

const navigate = vi.hoisted(() => vi.fn());
const route = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => route,
  useNavigate: () => navigate,
  useSearch: () => ({}),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  route.pathname = '/';
  window.history.replaceState(null, '', '/');
});
function setup(session?: SessionInfo) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (session) client.setQueryData(sessionQuery.queryKey, session);
  return {
    client,
    ...renderHome(
      <QueryClientProvider client={client}>
        <HomeScreen />
      </QueryClientProvider>,
    ),
  };
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

it('points an empty demo My files list to shared files while keeping the toolbar available', async () => {
  route.pathname = '/home/my';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => json(path === '/api/home' ? { folders: [], databases: [] } : [])),
  );
  setup({
    user: { id: 'demo-member', name: 'Visitor', email: 'visitor@example.test', locale: 'en-US' },
    org: { id: 'org-test', name: 'Test', settings: {} },
    membership: { kind: 'member', adminRoles: [] },
    preferences: {},
    csrfToken: '',
    demo: true,
  });
  const heading = await screen.findByRole('heading', { name: 'Nothing here in the demo' });
  const empty = heading.parentElement!;
  const shared = within(empty).getByRole('link', { name: 'Shared with me' });
  expect(shared.getAttribute('href')).toBe('/home/shared');
  expect(within(empty).queryByRole('button', { name: /New database|Import from/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'New database' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'New folder' })).toBeDefined();
  expect(screen.getAllByRole('link', { name: 'My files' })[0]!.getAttribute('href')).toBe('/home/my');
  await userEvent.click(shared);
  expect(navigate).toHaveBeenCalledWith({ to: '/home/$section', params: { section: 'shared' } });
});

it('loads databases and opens a card', async () => {
  const database = databaseSummary();
  const fetch = vi.fn(async () => json([database]));
  vi.stubGlobal('fetch', fetch);
  setup();
  await userEvent.click(await screen.findByRole('link', { name: /Projects/ }));
  expect(fetch).toHaveBeenCalledWith('/api/databases', expect.objectContaining({ method: 'GET' }));
  expect(navigate).toHaveBeenCalledWith({ to: `/${database.id}` });
});

it.each([{ databases: [] }, { databases: [databaseSummary({ role: 'creator' })] }])(
  'hides database creation and import actions from guests',
  async ({ databases }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(databases)),
    );
    const { client } = setup({
      user: { id: 'guest-user', name: 'Guest', email: 'guest@example.test', locale: 'en-US' },
      org: { id: 'org-test', name: 'Test', settings: {} },
      membership: { kind: 'guest', adminRoles: [] },
      preferences: {},
      csrfToken: '',
    });
    await screen.findByRole('heading', { name: 'Databases', level: 1 });
    await waitFor(() => expect(client.getQueryState(['databases'])?.status).toBe('success'));
    expect(screen.queryByRole('button', { name: 'New database' })).toBeNull();
    expect(screen.queryByRole('button', { name: /New database from|Import from/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More for Projects' })).toBeNull();
  },
);

it.each(['reader', 'commenter', 'editor', 'creator', 'owner'] as const)(
  'offers database creation in a shared folder only when its %s role permits filing',
  async (role) => {
    const folder: HomeFolder = {
      id: 'shared-folder',
      name: 'Shared projects',
      parentId: null,
      ownerId: 'other-user',
      path: [],
      role,
      shared: true,
      trashed: false,
    };
    route.pathname = `/home/folders/${folder.id}`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => json(path === '/api/home' ? { folders: [folder], databases: [] } : [])),
    );
    setup({
      user: { id: 'member-user', name: 'Member', email: 'member@example.test', locale: 'en-US' },
      org: { id: 'org-test', name: 'Test', settings: {} },
      membership: { kind: 'member', adminRoles: [] },
      preferences: {},
      csrfToken: '',
    });
    await screen.findByRole('heading', { name: folder.name });
    const create = screen.queryByRole('button', { name: 'New database' });
    if (role === 'reader' || role === 'commenter') expect(create).toBeNull();
    else expect(create).not.toBeNull();
  },
);

it('creates a contract-valid localized database, invalidates the list, and navigates', async () => {
  const bodies: unknown[] = [];
  const fetch = vi.fn(async (_path: string, options: RequestInit) => {
    if (options.method === 'POST') {
      const body: unknown = JSON.parse(String(options.body));
      bodies.push(body);
      const parsed = DatabaseCreate.parse(body);
      return json({ database: { id: parsed.id } });
    }
    return json([]);
  });
  vi.stubGlobal('fetch', fetch);
  const { client, i18n } = setup();
  await screen.findByRole('heading', { name: 'No databases yet' });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  act(() => {
    i18n.load('fr', {
      'home.default.database': 'Base sans titre',
      'home.default.table': 'Tableau 1',
      'home.default.view': 'Grille',
      'home.default.name': 'Nom',
      'home.default.notes': 'Remarques',
      'home.default.status': 'Statut',
      'home.default.todo': 'À faire',
      'home.default.inProgress': 'En cours',
      'home.default.done': 'Terminé',
    });
    i18n.activate('fr');
  });
  await userEvent.click(screen.getByRole('button', { name: 'New database' }));
  expect(((await screen.findByRole('textbox')) as HTMLInputElement).value).toBe('Base sans titre');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox')));
  await userEvent.keyboard('Projets{Enter}');
  await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  const payload = DatabaseCreate.parse(bodies[0]);
  expect(payload.name).toBe('Projets');
  expect(payload.table.name).toBe('Tableau 1');
  expect(payload.table.view.name).toBe('Grille');
  expect(payload.table.fields.map((field) => field.name)).toEqual(['Nom', 'Remarques', 'Statut']);
  expect(payload.table.records).toHaveLength(3);
  expect(navigate).toHaveBeenCalledWith({ to: `/${payload.id}` });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['databases'] });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it.each([null, 'private-folder'])(
  'keeps the starting destination %s when the address changes during blank creation',
  async (parentId) => {
    window.history.replaceState(null, '', parentId ? `/home/folders/${parentId}` : '/');
    let finish: (value: Response) => void = () => undefined;
    let databaseId = '';
    const moves: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, options: RequestInit) => {
        if (path === '/api/databases' && options.method === 'POST') {
          databaseId = DatabaseCreate.parse(JSON.parse(String(options.body))).id;
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        }
        if (path === '/api/home/commands') {
          const body = JSON.parse(String(options.body)) as { id: string; action: unknown };
          moves.push(body.action);
          return json({ id: body.id });
        }
        return json([]);
      }),
    );
    setup();
    await screen.findByRole('heading', { name: 'No databases yet' });
    await userEvent.click(screen.getByRole('button', { name: 'New database' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Create' }));
    await waitFor(() => expect(databaseId).not.toBe(''));
    window.history.replaceState(null, '', '/home/folders/shared-folder');
    await act(() => finish(json({ database: { id: databaseId } })));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: `/${databaseId}` }));
    expect(moves).toEqual(
      parentId ? [{ kind: 'database.move', databaseId, parentId, confirmedLosses: [] }] : [],
    );
  },
);

it('keeps the typed name and shows the server message after a failed create, allowing retry', async () => {
  let attempts = 0;
  const fetch = vi.fn(async (_path: string, options: RequestInit) => {
    if (options.method !== 'POST') return json([]);
    attempts++;
    if (attempts === 1)
      return json({ error: { code: 'forbidden', messageKey: 'data.access.denied', userFault: true } }, 403);
    const payload = DatabaseCreate.parse(JSON.parse(String(options.body)));
    return json({ database: { id: payload.id } });
  });
  vi.stubGlobal('fetch', fetch);
  setup();
  await screen.findByRole('heading', { name: 'No databases yet' });
  await userEvent.click(screen.getByRole('button', { name: 'New database' }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox')));
  await userEvent.keyboard('Budget{Enter}');
  expect((await screen.findByRole('alert')).textContent).toContain(
    'You don’t have access to do that in this database.',
  );
  expect(screen.getByRole('dialog', { name: 'New database' })).toBeDefined();
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Budget');
  expect(navigate).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
});

it('shows translated server errors when the list fails', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      json({ error: { code: 'unavailable', messageKey: 'errors.unavailable', userFault: false } }, 503),
    ),
  );
  setup();
  expect((await screen.findByRole('alert')).textContent).toContain(
    'The server is busy.  Try again in a moment.',
  );
  expect(screen.queryByText('No databases yet')).toBeNull();
});

const starterTemplates = [
  {
    id: 'project-tracker',
    name: 'Project tracker',
    description: 'Track projects and tasks.',
    icon: 'list-check',
    color: 'blue',
    tables: ['Projects', 'Tasks'],
  },
  {
    id: 'sales-pipeline',
    name: 'Sales pipeline',
    description: 'Track opportunities.',
    icon: 'handshake',
    color: 'green',
    tables: ['Companies', 'Contacts', 'Deals'],
  },
  {
    id: 'content-calendar',
    name: 'Content calendar',
    description: 'Plan publishing.',
    icon: 'calendar-days',
    color: 'purple',
    tables: ['Posts', 'Channels'],
  },
  {
    id: 'event-planning',
    name: 'Event planning',
    description: 'Plan events.',
    icon: 'champagne-glasses',
    color: 'pink',
    tables: ['Events', 'Guests', 'Vendors'],
  },
  {
    id: 'inventory',
    name: 'Inventory',
    description: 'Manage stock.',
    icon: 'boxes-stacked',
    color: 'orange',
    tables: ['Products', 'Suppliers', 'Orders'],
  },
  {
    id: 'reading-list',
    name: 'Reading list',
    description: 'Track reading.',
    icon: 'book-open',
    color: 'teal',
    tables: ['Books', 'Authors'],
  },
];

it('lists template cards, creates the selected template, and opens it', async () => {
  let body: { id: string; templateId: string; name: string } | undefined;
  const fetch = vi.fn(async (path: string, options: RequestInit) => {
    if (path === '/api/templates') return json(starterTemplates);
    if (path === '/api/databases/from-template' && options.method === 'POST') {
      body = JSON.parse(String(options.body)) as typeof body;
      return json({ database: { id: body!.id } });
    }
    return json([]);
  });
  vi.stubGlobal('fetch', fetch);
  const { client } = setup();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  await screen.findByRole('heading', { name: 'No databases yet' });
  await userEvent.click(screen.getByRole('button', { name: 'New database' }));
  for (const template of starterTemplates) {
    const card = await screen.findByRole('button', { name: new RegExp(template.name) });
    expect(card.textContent).toContain(template.description);
    expect(card.textContent).toContain(`${template.tables.length} tables`);
    expect(card.textContent).toContain(template.tables.join(', '));
    expect(card.querySelector('.rio-database-icon')?.getAttribute('style')).toContain(template.color);
  }
  await userEvent.click(screen.getByRole('button', { name: /Project tracker/ }));
  expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Project tracker');
  await userEvent.clear(screen.getByRole('textbox'));
  await userEvent.type(screen.getByRole('textbox'), 'Launch plan');
  await userEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: `/${body!.id}` }));
  expect(body).toEqual({
    id: expect.stringMatching(/^db[0-9A-Za-z]{14}$/),
    templateId: 'project-tracker',
    name: 'Launch plan',
  });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['databases'] });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('preserves the template request ID across a failed request and prevents dismissal or duplicate creation while pending', async () => {
  const bodies: Array<{ id: string }> = [];
  let finish: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, options: RequestInit) => {
      if (path === '/api/templates') return Promise.resolve(json(starterTemplates));
      if (options.method === 'POST') {
        bodies.push(JSON.parse(String(options.body)) as { id: string });
        if (bodies.length === 1)
          return Promise.resolve(
            json({ error: { code: 'unavailable', messageKey: 'errors.unavailable', userFault: false } }, 503),
          );
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      return Promise.resolve(json([]));
    }),
  );
  setup();
  await screen.findByRole('heading', { name: 'No databases yet' });
  await userEvent.click(screen.getByRole('button', { name: 'New database' }));
  await userEvent.click(await screen.findByRole('button', { name: /Reading list/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Create' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Try again');
  await userEvent.click(screen.getByRole('button', { name: 'Create' }));
  expect((await within(screen.getByRole('dialog')).findByRole('status')).textContent).toBe(
    'Creating Reading list',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Create' }));
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await userEvent.keyboard('{Escape}');
  expect(screen.getByRole('dialog')).toBeDefined();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect((screen.getByRole('button', { name: 'Start from scratch' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Start from scratch' }));
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Reading list');
  await act(async () => {
    finish!(json({ database: { id: bodies[0]!.id } }));
  });
  await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
});

it('switches back from a template and creates a blank database with the original name', async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options: RequestInit) => {
      if (path === '/api/templates') return json(starterTemplates);
      if (options.method === 'POST') {
        expect(path).toBe('/api/databases');
        const body = DatabaseCreate.parse(JSON.parse(String(options.body)));
        bodies.push(body);
        return json({ database: { id: body.id } });
      }
      return json([]);
    }),
  );
  setup();
  await screen.findByRole('heading', { name: 'No databases yet' });
  await userEvent.click(screen.getByRole('button', { name: 'New database' }));
  await userEvent.clear(screen.getByRole('textbox'));
  await userEvent.type(screen.getByRole('textbox'), 'Personal notes');
  await userEvent.click(await screen.findByRole('button', { name: /Inventory/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Start from scratch' }));
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Personal notes');
  await userEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  expect(bodies).toHaveLength(1);
  expect(DatabaseCreate.parse(bodies[0]).table.records).toHaveLength(3);
});

describe('the first table celebration', () => {
  let shown: Celebration[] = [];
  let stop: () => void = () => undefined;
  beforeEach(() => {
    shown = [];
    stop = celebrations.subscribe((celebration) => shown.push(celebration));
  });
  afterEach(() => {
    stop();
    localStorage.clear();
  });

  /** A signed-in person whose home screen lists `databases`, which the test changes as it goes. */
  function signedIn(databases: { list: DatabaseSummary[] }) {
    const person = { user: { id: 'user-one' }, preferences: {} } as SessionInfo;
    const fetch = vi.fn(async (path: string, options: RequestInit) => {
      if (path === '/api/auth/session') return json(person);
      if (path === '/api/templates') return json(starterTemplates);
      if (
        options.method === 'POST' &&
        (path === '/api/databases' || path === '/api/databases/from-template')
      ) {
        const { id } = JSON.parse(String(options.body)) as { id: string };
        databases.list = [...databases.list, databaseSummary({ id, name: 'Mine' })];
        return json({ database: { id }, tables: [{ id: 'tbl00000000000001' }] });
      }
      return json(databases.list);
    });
    vi.stubGlobal('fetch', fetch);
    const rendered = setup();
    rendered.client.setQueryData(sessionQuery.queryKey, person);
    return rendered;
  }

  async function createBlank(name: string) {
    await userEvent.click(screen.getByRole('button', { name: 'New database' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox')));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.keyboard(`${name}{Enter}`);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  }

  it('celebrates a first table made with New database, once', async () => {
    const databases = { list: [] as DatabaseSummary[] };
    const { client } = signedIn(databases);
    await screen.findByRole('heading', { name: 'No databases yet' });
    await createBlank('Garden');
    expect(shown.map((celebration) => [celebration.name, celebration.cause])).toEqual([
      ['firstTable', 'you'],
    ]);
    await act(() => client.invalidateQueries({ queryKey: ['databases'] }));
    await createBlank('Orchard');
    expect(shown).toHaveLength(1);
  });

  it('celebrates a first table made from a template', async () => {
    const databases = { list: [] as DatabaseSummary[] };
    signedIn(databases);
    await screen.findByRole('heading', { name: 'No databases yet' });
    await userEvent.click(screen.getByRole('button', { name: 'New database' }));
    await userEvent.click(await screen.findByRole('button', { name: /Project tracker/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(shown.map((celebration) => celebration.name)).toEqual(['firstTable']);
  });

  it('is used up when a database arrives another way, such as an import or a share', async () => {
    const databases = { list: [] as DatabaseSummary[] };
    const { client } = signedIn(databases);
    await screen.findByRole('heading', { name: 'No databases yet' });
    // A base brought over from elsewhere, restored, or shared lands in the list.
    databases.list = [databaseSummary({ role: 'editor' })];
    await act(() => client.invalidateQueries({ queryKey: ['databases'] }));
    await screen.findByRole('link', { name: /Projects/ });
    await createBlank('Garden');
    expect(shown).toEqual([]);
  });

  it('waits for the person’s own new database rather than using it up while it’s being made', async () => {
    const databases = { list: [] as DatabaseSummary[] };
    const { client } = signedIn(databases);
    await screen.findByRole('heading', { name: 'No databases yet' });
    await userEvent.click(screen.getByRole('button', { name: 'New database' }));
    // Someone shares a database while the dialog is open, and the list reads it.
    databases.list = [databaseSummary({ role: 'editor' })];
    await act(() => client.invalidateQueries({ queryKey: ['databases'] }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox')));
    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.keyboard('Garden{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(shown.map((celebration) => celebration.name)).toEqual(['firstTable']);
  });
});

it('waits for the folder layout before exposing database drag sources', async () => {
  const database = { ...databaseSummary(), parentId: null, owned: true, shared: false };
  let complete!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) =>
      path === '/api/home'
        ? new Promise<Response>((resolve) => {
            complete = resolve;
          })
        : Promise.resolve(json([])),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['databases'], [database]);
  client.setQueryData(sessionQuery.queryKey, {
    user: { id: 'owner' },
    membership: { kind: 'member' },
    preferences: {},
  } as SessionInfo);
  renderHome(
    <QueryClientProvider client={client}>
      <HomeScreen />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(complete).toBeTypeOf('function'));
  expect(screen.queryByRole('link', { name: /Projects/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Move Projects' })).toBeNull();
  const folder: HomeFolder = {
    id: 'folder',
    name: 'Destination',
    parentId: null,
    ownerId: 'owner',
    path: [],
    role: 'owner',
    shared: false,
    trashed: false,
  };
  await act(async () => complete(json({ folders: [folder], databases: [database] })));
  expect(await screen.findByRole('button', { name: 'Destination' })).toBeDefined();
  const source = await screen.findByRole('link', { name: /Projects/ });
  expect(source.closest('[data-sortable-id]')?.getAttribute('data-sortable-id')).toBe(database.id);
});
