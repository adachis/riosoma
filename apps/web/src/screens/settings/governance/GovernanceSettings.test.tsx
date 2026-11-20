import { renderSettings as renderSharing } from '../testing';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ClassificationRules, RETENTION_DEFAULTS, type GovernanceView } from '@riosoma/contracts';
import { json, session } from '../../database/share/testing';
import { GovernanceSettings } from './GovernanceSettings';

const route = vi.hoisted(() => ({
  search: {} as { database?: string },
  navigate: vi.fn(),
  pathname: '/admin/security/retention/legalHold',
}));
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => route.search,
  useNavigate: () => route.navigate,
  useRouter: () => undefined,
  useLocation: () => ({ pathname: route.pathname, href: route.pathname }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  route.search = {};
  route.navigate.mockReset();
});
const view: GovernanceView = {
  databases: [],
  names: {},
  labels: [],
  assignments: [],
  policy: {},
  effective: RETENTION_DEFAULTS,
  legalHold: false,
};

it('creates labels with explicit rules and offers undo', async () => {
  let current = structuredClone(view);
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/databases') return json([]);
    if (options?.method === 'POST') {
      const command = JSON.parse(String(options.body));
      if (command.action?.kind === 'classification.labels')
        current = { ...current, labels: command.action.labels };
      return json({ id: command.id, status: 'applied' });
    }
    return json(current);
  });
  vi.stubGlobal('fetch', fetcher);
  renderSharing(<GovernanceSettings mode="classification" />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Add label' }));
  await user.type(screen.getByRole('textbox', { name: 'Label name' }), 'Restricted');
  await user.click(screen.getByRole('checkbox', { name: 'No export or download' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('button', { name: 'Undo last change' });
  expect(current.labels).toHaveLength(1);
  expect(current.labels[0]?.rules.noExport).toBe(true);
  expect(current.labels[0]?.rules.noProviders).toBe(false);
});

it('saves database retention and a legal hold from a deep link', async () => {
  route.search = { database: 'db12345678901234' };
  const actions: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/databases') return json([{ id: route.search.database, name: 'Review' }]);
      if (url.endsWith('/schema')) return json({ database: { name: 'Review' }, tables: [], fields: [] });
      if (options?.method === 'POST') {
        const command = JSON.parse(String(options.body));
        actions.push(command.action);
        return json({ id: command.id, status: 'applied' });
      }
      return json(view);
    }),
  );
  renderSharing(<GovernanceSettings mode="retention" />);
  const user = userEvent.setup();
  const trash = await screen.findByRole('group', { name: 'Trash' });
  await user.selectOptions(within(trash).getByRole('combobox', { name: 'Keep for' }), 'days');
  const days = within(trash).getByRole('spinbutton', { name: 'Number of days' });
  await user.clear(days);
  await user.type(days, '60');
  await user.click(screen.getByRole('checkbox', { name: 'Legal hold—stop all purging for this database' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(actions).toEqual([
      {
        kind: 'retention.set',
        databaseId: route.search.database,
        policy: { trashDays: 60 },
        legalHold: true,
      },
    ]),
  );
});

it('reveals legal hold scope selection at an unscoped search destination and preserves the target', async () => {
  const database = { id: 'db12345678901234', name: 'Review' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ ...view, databases: [database] })),
  );
  const app = renderSharing(<GovernanceSettings mode="retention" />);
  const scope = await screen.findByRole('combobox', { name: 'Database for legal hold' });
  expect(scope.closest<HTMLElement>('[data-setting-id]')?.dataset.settingId).toBe('legalHold');
  expect(
    screen.queryByRole('checkbox', { name: 'Legal hold—stop all purging for this database' }),
  ).toBeNull();
  await userEvent.setup().selectOptions(scope, database.id);
  const destination = route.navigate.mock.calls.at(-1)?.[0];
  expect(destination.to).toBe(route.pathname);
  expect(destination.search({ other: 'kept' })).toEqual({ other: 'kept', database: database.id });
  app.client.clear();
});

it('blocks a direct link for someone without Security administration', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  renderSharing(<GovernanceSettings mode="classification" />, {
    ...session,
    membership: { kind: 'member', adminRoles: [] },
  });
  expect((await screen.findByRole('alert')).textContent).toContain('Only an administrator');
  expect(fetcher).not.toHaveBeenCalled();
});

it('limits labels to twelve and retains their rule controls', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/databases'
        ? json([])
        : json({
            ...view,
            labels: Array.from({ length: 12 }, (_, index) => ({
              id: String(index),
              name: String(index),
              description: '',
              color: 'blue',
              rules: ClassificationRules.parse({}),
            })),
          }),
    ),
  );
  renderSharing(<GovernanceSettings mode="classification" />);
  expect((await screen.findByRole('button', { name: 'Add label' })).hasAttribute('disabled')).toBe(true);
  expect(screen.getAllByRole('checkbox', { name: 'Mask for guests' })).toHaveLength(12);
});

it('classifies an ungranted database using Security metadata without reading its schema', async () => {
  route.search = { database: 'db12345678901234' };
  const current = {
    ...view,
    databases: [{ id: route.search.database, name: 'Private records' }],
    names: { [route.search.database!]: 'Private records' },
    assignments: [{ target: { kind: 'database', databaseId: route.search.database }, labelId: null }],
  };
  const fetcher = vi.fn(async (url: string) =>
    url.startsWith('/api/admin/governance')
      ? json(current)
      : json({ error: { code: 'not_found', messageKey: 'errors.notFound' } }, 404),
  );
  vi.stubGlobal('fetch', fetcher);
  renderSharing(<GovernanceSettings mode="classification" />, {
    ...session,
    membership: { kind: 'member', adminRoles: ['security'] },
  });
  expect(await screen.findByRole('combobox', { name: 'Database: Private records' })).toBeTruthy();
  expect(screen.getByRole('option', { name: 'Private records' })).toBeTruthy();
  expect(fetcher.mock.calls.every(([url]) => url.startsWith('/api/admin/governance'))).toBe(true);
});
