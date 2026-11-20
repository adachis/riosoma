import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { newId, type AirtableImport } from '@riosoma/contracts';
import { usePaletteCommands } from '../../palette/commands';
import { HomeScreen } from '../HomeScreen';
import { reportPending } from '../import/airtable/pending';
import { databaseSummary, renderHome } from './test-support';

const navigate = vi.hoisted(() => vi.fn());
const search = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: '/' }),
  useNavigate: () => navigate,
  useSearch: () => search.current,
}));

const DATABASE = newId('database');
const JOB = `job${'H'.repeat(14)}`;
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

function job(overrides: Partial<AirtableImport>): AirtableImport {
  return {
    id: JOB,
    baseId: `app${'L'.repeat(14)}`,
    name: 'Launch plan',
    databaseId: DATABASE,
    state: 'running',
    progress: { phase: 'records', tables: 2, tablesDone: 1, records: 10, files: 0, table: 'Tasks' },
    version: 1,
    error: null,
    report: null,
    createdAt: '2026-09-27T12:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

let recent: AirtableImport[] = [];
beforeEach(() => {
  search.current = {};
  recent = [];
  i18n.load('en-US', {});
  i18n.activate('en-US');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (path === '/api/trash') return json({ databases: [] });
      if (path === '/api/imports/airtable') return json({ imports: recent });
      if (path.startsWith(`/api/imports/airtable/${JOB}?since=`))
        return json(
          job({
            state: 'finished',
            version: 2,
            report: { tables: 2, fields: 4, records: 12, views: 2, files: 0, items: [] },
            finishedAt: '2026-09-27T12:05:00.000Z',
          }),
        );
      return json([databaseSummary()]);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderHome(
    <QueryClientProvider client={client}>
      <HomeScreen />
    </QueryClientProvider>,
  );
}

describe('importing from Airtable, from home', () => {
  it('opens from the home screen’s new database actions', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('button', { name: 'Import from Airtable' }));
    expect(await screen.findByRole('dialog', { name: 'Import from Airtable' })).toBeDefined();
  });

  it('opens for ?new=airtable, which the palette sends', async () => {
    search.current = { new: 'airtable' };
    setup();
    expect(await screen.findByRole('dialog', { name: 'Import from Airtable' })).toBeDefined();
  });

  it('opens the new database with its report', async () => {
    const user = userEvent.setup();
    recent = [job({})];
    search.current = { new: 'airtable' };
    setup();
    await screen.findByRole('dialog', { name: 'Imported Launch plan' });
    await user.click(screen.getByRole('button', { name: 'Open database' }));
    expect(navigate).toHaveBeenCalledWith({ to: `/${DATABASE}` });
    expect(reportPending(DATABASE)).toBe(true);
    expect(screen.queryByRole('dialog', { name: 'Imported Launch plan' })).toBeNull();
  });
});

describe('the palette', () => {
  it('offers importing a base from Airtable', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <I18nProvider i18n={i18n}>{children}</I18nProvider>
    );
    const { result } = renderHook(
      () =>
        usePaletteCommands({
          canManagePeople: false,
          canUseTokens: true,
          onOpenHelp: vi.fn(),
          onSignOut: vi.fn(),
        }),
      { wrapper },
    );
    const command = result.current.find((item) => item.id === 'importAirtable');
    expect(command?.label).toBe('Import a base from Airtable');
    command!.run();
    expect(navigate).toHaveBeenCalledWith({ to: '/', search: { new: 'airtable' } });
  });
});
