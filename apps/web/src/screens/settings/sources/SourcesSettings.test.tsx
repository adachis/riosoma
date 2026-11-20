import type { ReactNode } from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ToastRegion, toastQueue } from '@riosoma/ui';
import { failure, json, renderSharing, session } from '../../database/share/testing';
import type { SourceMeta } from '@riosoma/contracts';
import { SettingsScreen } from '../SettingsScreen';
import { canManageSources, SourcesSettings } from './SourcesSettings';
import { bigquerySource, mockSources } from './testing';

/** The stand-in server, with the calls it received. */
type Fetcher = Mock<(url: string, init?: RequestInit) => Promise<Response>>;

vi.mock('../AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('../LanguageSettings', () => ({ LanguageSettings: () => null }));
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: '/settings/sources', href: '/settings/sources' }),
  useNavigate: () => vi.fn(),
  useRouter: () => undefined,
  useParams: () => ({ section: 'sources' }),
  Link: ({ params, children }: { params: { section: string }; children: ReactNode }) => (
    <a href={`/settings/${params.section}`}>{children}</a>
  ),
}));

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function start(sources?: SourceMeta[]) {
  const api = mockSources(sources ? { sources } : {});
  const fetcher = vi.fn(api.handle);
  vi.stubGlobal('fetch', fetcher);
  renderSharing(
    <>
      <SourcesSettings />
      <ToastRegion />
    </>,
  );
  return { api, fetcher };
}

/** The requests a route received, with their parsed bodies. */
function calls(fetcher: Fetcher, method: string) {
  return fetcher.mock.calls
    .filter(([, init]) => (init?.method ?? 'GET') === method)
    .map(([url, init]) => ({
      url,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    }));
}

const INTRO = 'Connect databases and warehouses here, then sync their tables into any database.';

describe('data sources settings', () => {
  it('shows a credential outage on its source while keeping healthy sources editable', async () => {
    const affected = {
      ...bigquerySource,
      id: 'srcUnavailable',
      name: 'Affected',
      credentialError: 'credentials.unavailable' as const,
    };
    start([bigquerySource, affected]);
    const name = await screen.findByText('Affected');
    expect(within(name.closest('tr')!).getByRole('status').textContent).toBe(
      'The credential vault is unavailable.  This connection is paused until access is restored.',
    );
    expect(screen.getByRole('button', { name: `Edit ${bigquerySource.name}` })).not.toHaveProperty(
      'disabled',
      true,
    );
  });

  it.each([
    { kind: 'owner' as const, adminRoles: [], visible: true },
    { kind: 'member' as const, adminRoles: ['data_sources'], visible: true },
    { kind: 'member' as const, adminRoles: ['people'], visible: false },
    { kind: 'guest' as const, adminRoles: [], visible: false },
  ])(
    'shows the section to $kind with $adminRoles only when allowed',
    async ({ kind, adminRoles, visible }) => {
      const fetcher = vi.fn(async () => json([]));
      vi.stubGlobal('fetch', fetcher);
      renderSharing(<SettingsScreen />, { ...session, membership: { kind, adminRoles } });
      const nav = screen.getByRole('navigation', { name: 'Settings sections' });
      const link = within(nav).queryByRole('link', { name: 'Data sources' });
      expect(Boolean(link)).toBe(visible);
      if (visible) {
        expect(link?.getAttribute('href')).toBe('/settings/sources');
        expect(screen.getByRole('heading', { level: 1, name: 'Data sources' })).toBeDefined();
        await screen.findByText(INTRO);
      } else {
        expect(screen.queryByText(INTRO)).toBeNull();
        expect(screen.queryByRole('button', { name: 'Add a data source' })).toBeNull();
      }
    },
  );

  it('lets owners and Data Sources admins in, and keeps everyone else out', () => {
    expect(canManageSources(session)).toBe(true);
    expect(
      canManageSources({ ...session, membership: { kind: 'member', adminRoles: ['data_sources'] } }),
    ).toBe(true);
    expect(canManageSources({ ...session, membership: { kind: 'member', adminRoles: ['ai'] } })).toBe(false);
    expect(canManageSources(null)).toBe(false);

    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    renderSharing(<SourcesSettings />, {
      ...session,
      membership: { kind: 'member', adminRoles: ['people'] },
    });
    // Nobody without the role may even ask for the list.
    expect(fetcher).not.toHaveBeenCalled();
    waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Only an administrator'));
  });

  it('lists every column for each source', async () => {
    start();
    const table = await screen.findByRole('table');
    for (const header of ['Name', 'Kind', 'Where', 'Who can use it', 'Last test', 'Synced tables']) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeDefined();
    }

    const warehouse = within(table).getByRole('row', { name: /Warehouse/ });
    expect(within(warehouse).getByRole('rowheader').textContent).toContain('Nightly copy of the warehouse');
    expect(within(warehouse).getByText('PostgreSQL')).toBeDefined();
    expect(within(warehouse).getByText('db.example.com')).toBeDefined();
    expect(within(warehouse).getByText('analytics')).toBeDefined();
    expect(within(warehouse).getByText('Anyone who can add tables')).toBeDefined();
    expect(within(warehouse).getByText('Passed 3 hours ago')).toBeDefined();
    expect(within(warehouse).getByText('3')).toBeDefined();
    expect(within(warehouse).getByRole('button', { name: 'Edit Warehouse' })).toBeDefined();
    expect(within(warehouse).getByRole('button', { name: 'Delete Warehouse' })).toBeDefined();

    const events = within(table).getByRole('row', { name: /Events/ });
    expect(within(events).getByText('BigQuery')).toBeDefined();
    expect(within(events).getByText('garden-analytics')).toBeDefined();
    expect(within(events).getByText('Data Sources admins')).toBeDefined();
    expect(within(events).getByText('Failed 2 days ago')).toBeDefined();
    expect(within(events).getByText('0')).toBeDefined();

    const notebook = within(table).getByRole('row', { name: /Notebook/ });
    expect(within(notebook).getByText('MotherDuck')).toBeDefined();
    expect(within(notebook).getByText('notes')).toBeDefined();
    expect(within(notebook).getByText('Never tested')).toBeDefined();
    expect(within(notebook).getByText('1')).toBeDefined();
  });

  it('explains sources and offers the first one when there are none', async () => {
    start([]);
    await screen.findByText('No data sources yet.');
    expect(screen.getByText(INTRO)).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Add a data source' })).toHaveLength(1);
  });

  it('deletes a source only after it is confirmed', async () => {
    const { api, fetcher } = start();
    await screen.findByRole('table');
    const events = screen.getByRole('row', { name: /Events/ });
    await userEvent.click(within(events).getByRole('button', { name: 'Delete Events' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Events?' });
    expect(within(dialog).getByText('People can no longer sync from it.')).toBeDefined();
    expect(calls(fetcher, 'DELETE')).toEqual([]);

    // Canceling leaves everything as it was.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('row', { name: /Events/ })).toBeDefined();

    await userEvent.click(
      within(screen.getByRole('row', { name: /Events/ })).getByRole('button', { name: 'Delete Events' }),
    );
    const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' });
    confirm.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('row', { name: /Events/ })).toBeNull());
    expect(calls(fetcher, 'DELETE')).toEqual([{ url: `/api/sources/${bigquerySource.id}`, body: undefined }]);
    expect(api.sources().map((source) => source.id)).not.toContain(bigquerySource.id);
  });

  it('keeps the question open and shows why a source in use can’t go', async () => {
    const { api, fetcher } = start();
    api.fail.delete = failure('sources.inUse', 409);
    await screen.findByRole('table');
    await userEvent.click(
      within(screen.getByRole('row', { name: /Warehouse/ })).getByRole('button', {
        name: 'Delete Warehouse',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Delete Warehouse?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'Synced tables still use this source.  Delete them first.',
      ),
    );
    expect(screen.getByRole('dialog', { name: 'Delete Warehouse?' })).toBeDefined();
    expect(screen.getByRole('row', { name: /Warehouse/ })).toBeDefined();
    expect(calls(fetcher, 'DELETE')).toHaveLength(1);
  });

  it('says when the list itself couldn’t be read', async () => {
    const fetcher = vi.fn(mockSources().handle);
    fetcher.mockResolvedValueOnce(failure('errors.adminOnly', 403));
    vi.stubGlobal('fetch', fetcher);
    renderSharing(<SourcesSettings />);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Only an administrator can do that.'),
    );
    expect(screen.queryByRole('table')).toBeNull();
  });
});
