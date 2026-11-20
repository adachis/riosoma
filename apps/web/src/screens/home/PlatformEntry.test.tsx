import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { usePaletteCommands } from '../../palette/commands';
import { HomeScreen } from '../HomeScreen';
import { databaseSummary, renderHome } from './test-support';

const navigate = vi.hoisted(() => vi.fn());
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
  i18n.load('en-US', {});
  i18n.activate('en-US');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (path === '/api/trash') return json({ databases: [] });
      if (/^\/api\/imports\/[a-z]+$/.test(path)) return json({ imports: [] });
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

describe('importing from other tools, from home', () => {
  it('offers every other tool in the import menu', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('button', { name: 'Import from another tool' }));
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual([
      'NocoDB',
      'Baserow',
      'Grist',
      'Teable',
      'SeaTable',
      'ClickUp',
      'Asana',
      'Notion',
      'monday.com',
      'Smartsheet',
    ]);
    await user.click(screen.getByRole('menuitem', { name: 'Baserow' }));
    expect(await screen.findByRole('dialog', { name: 'Import from Baserow' })).toBeDefined();
  });

  it('opens for ?new=teable, which the palette sends', async () => {
    search.current = { new: 'teable' };
    setup();
    expect(await screen.findByRole('dialog', { name: 'Import from Teable' })).toBeDefined();
  });

  it('opens for ?new=seatable, which the palette sends', async () => {
    search.current = { new: 'seatable' };
    setup();
    expect(await screen.findByRole('dialog', { name: 'Import from SeaTable' })).toBeDefined();
  });

  it('opens for ?new=grist, which the palette sends', async () => {
    search.current = { new: 'grist' };
    setup();
    expect(await screen.findByRole('dialog', { name: 'Import from Grist' })).toBeDefined();
  });

  it.each([
    ['clickup', 'ClickUp'],
    ['asana', 'Asana'],
  ])('opens for ?new=%s, which the palette sends', async (platform, product) => {
    search.current = { new: platform };
    setup();
    expect(await screen.findByRole('dialog', { name: `Import from ${product}` })).toBeDefined();
  });
});

describe('the palette', () => {
  it('offers importing from each tool', () => {
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
    const labels = Object.fromEntries(result.current.map((item) => [item.id, item.label]));
    expect(labels).toMatchObject({
      importNocodb: 'Import a base from NocoDB',
      importBaserow: 'Import a database from Baserow',
      importGrist: 'Import a document from Grist',
      importTeable: 'Import a base from Teable',
      importSeatable: 'Import a base from SeaTable',
      importClickup: 'Import lists from ClickUp',
      importAsana: 'Import projects from Asana',
      importNotion: 'Import a database from Notion',
      importMonday: 'Import a board from monday.com',
      importSmartsheet: 'Import a sheet from Smartsheet',
    });
    result.current.find((item) => item.id === 'importGrist')!.run();
    expect(navigate).toHaveBeenCalledWith({ to: '/', search: { new: 'grist' } });
    for (const platform of ['clickup', 'asana']) {
      result.current
        .find((item) => item.id === `import${platform[0]!.toUpperCase()}${platform.slice(1)}`)!
        .run();
      expect(navigate).toHaveBeenLastCalledWith({ to: '/', search: { new: platform } });
    }
  });
});
