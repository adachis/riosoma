import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { APP_CATALOG, type ConnectionsView, type SourceCreate } from '@riosoma/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../api';
import type * as ApiModule from '../../../api';
import { CONNECTIONS_CHANNEL, connectionStore } from '../../../files/pickers/api';
import { patchTreeWalkerPreviousNode } from '../../../../../../packages/ui/src/test/tree-walker';
import { TEST_APP_MESSAGES } from './app-catalog.test-support';
import { SourceDialog } from './SourceDialog';
import { sourceMeta } from './testing';

vi.mock('../../../api', async (original) => ({ ...(await original<typeof ApiModule>()), api: vi.fn() }));
patchTreeWalkerPreviousNode();
let view: ConnectionsView;
beforeEach(() => {
  connectionStore.reset();
  view = {
    providers: [
      {
        provider: 'github',
        available: true,
        account: {
          id: 'own-account',
          name: 'Example account',
          email: null,
          connectedAt: '2026-01-01T00:00:00.000Z',
          needsReconnect: false,
        },
      },
    ],
  };
  vi.mocked(api).mockImplementation(async (url) => {
    if (url === '/api/connections') return view as never;
    if (url.endsWith('/test')) return { ok: true, steps: [] } as never;
    return sourceMeta({
      kind: 'app',
      connection: { kind: 'app', app: 'github', settings: { connectionId: 'own-account' } },
      secrets: [],
    }) as never;
  });
});
afterEach(() => {
  cleanup();
  connectionStore.reset();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  localStorage.clear();
});

function start(
  source?: Parameters<typeof SourceDialog>[0]['source'],
  appCatalog = APP_CATALOG.filter((app) => app.id === 'github'),
) {
  const onSaved = vi.fn();
  const i18n = setupI18n({
    locale: 'en-US',
    messages: {
      'en-US': {
        ...TEST_APP_MESSAGES,
        'sources.app.xero.organization': 'Organization',
        'sources.app.xero.organizationHelp': 'Choose an organization shared by your account.',
        'sources.app.account': 'Connected account',
        'sources.app.chooseAccount': 'Choose an account',
        'sources.app.connectAccount': 'Connect',
        'sources.app.connectAnother': 'Connect another account',
        'sources.app.providerUnavailable':
          'Unavailable.  Ask an admin to set up or enable this provider under Settings, Integrations, using the callback address shown there.',
        'sources.app.accountReconnect': 'Connect this account again before testing or syncing.',
      },
    },
  });
  render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
        <SourceDialog source={source} appCatalog={appCatalog} onSaved={onSaved} onClose={vi.fn()} />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { user: userEvent.setup(), onSaved };
}
async function choose(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('option', { name: 'GitHub' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Project data' } });
}

describe('app source connected accounts', () => {
  it('lists the person’s account by name and sends only its ID when testing and saving', async () => {
    const { user, onSaved } = start();
    await choose(user);
    await user.click(await screen.findByRole('button', { name: /Connected account/ }));
    await user.click(screen.getByRole('option', { name: 'Example account' }));
    expect(screen.queryByLabelText('Key', { selector: 'input' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    const tested = vi.mocked(api).mock.calls.find(([url]) => url === '/api/sources/test')?.[1]
      ?.body as SourceCreate;
    expect(tested.connection).toEqual({
      kind: 'app',
      app: 'github',
      settings: { connectionId: 'own-account' },
    });
    expect(tested.secrets).toEqual({});
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const saved = vi.mocked(api).mock.calls.find(([url]) => url === '/api/sources')?.[1]
      ?.body as SourceCreate;
    expect(saved.secrets).toEqual({});
    expect(saved.connection).toEqual(tested.connection);
  });

  it('connects through the Files popup flow, refreshes accounts, and selects the newly connected account', async () => {
    view.providers[0]!.account = null;
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    const { user } = start();
    await choose(user);
    await user.click(await screen.findByRole('button', { name: 'Connect' }));
    expect(open.mock.calls[0]?.[0]).toBe('/api/oauth/start/github?next=%2Fconnected%2Fgithub');
    view.providers[0]!.account = {
      id: 'new-account',
      name: 'New account',
      email: null,
      connectedAt: '2026-01-01T00:00:00.000Z',
      needsReconnect: false,
    };
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: CONNECTIONS_CHANNEL,
        newValue: JSON.stringify({ id: 'connected-event', provider: 'github', ok: true }),
      }),
    );
    expect(await screen.findByText('New account')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Connect another account' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(vi.mocked(api).mock.calls.some(([url]) => url === '/api/sources')).toBe(true));
    const saved = vi.mocked(api).mock.calls.find(([url]) => url === '/api/sources')?.[1]
      ?.body as SourceCreate;
    expect(saved.connection).toMatchObject({ settings: { connectionId: 'new-account' } });
  });

  it('tests a saved source connected by another person while requiring an owned account to save', async () => {
    const connection = {
      kind: 'app' as const,
      app: 'github',
      settings: { connectionId: 'other-account', connectedBy: 'Other person' },
    };
    const source = sourceMeta({ kind: 'app', connection, secrets: [] });
    const { user } = start({ ...source, connection });
    const test = screen.getByRole('button', { name: 'Test connection' });
    await waitFor(() => expect(test.hasAttribute('disabled')).toBe(false));
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    await user.click(test);
    await waitFor(() =>
      expect(vi.mocked(api)).toHaveBeenCalledWith(`/api/sources/${source.id}/test`, { method: 'POST' }),
    );
    expect(vi.mocked(api).mock.calls.some(([url]) => url === '/api/sources/test')).toBe(false);
    await user.click(screen.getByRole('button', { name: /Connected account/ }));
    await user.click(screen.getByRole('option', { name: 'Example account' }));
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);
  });

  it('keeps a keyed app ready to save when an earlier account refresh finishes', async () => {
    const { user, onSaved } = start(
      undefined,
      APP_CATALOG.filter((app) => ['github', 'hubspot'].includes(app.id)),
    );
    await choose(user);
    await screen.findByRole('button', { name: /Connected account/ });
    let finishRefresh!: (view: ConnectionsView) => void;
    const refresh = new Promise<ConnectionsView>((resolve) => {
      finishRefresh = resolve;
    });
    vi.mocked(api).mockReturnValueOnce(refresh as never);
    fireEvent(
      window,
      new StorageEvent('storage', {
        key: CONNECTIONS_CHANNEL,
        newValue: JSON.stringify({ id: 'delayed-account', provider: 'github', ok: true }),
      }),
    );
    await user.click(screen.getByRole('option', { name: 'HubSpot' }));
    fireEvent.change(screen.getByLabelText('Key', { selector: 'input' }), {
      target: { value: ['stand', 'in', 'key'].join('-') },
    });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(false);
    await act(async () => {
      finishRefresh(view);
      await connectionStore.load();
    });
    expect(save.hasAttribute('disabled')).toBe(false);
    await user.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const saved = vi.mocked(api).mock.calls.find(([url]) => url === '/api/sources')?.[1]
      ?.body as SourceCreate;
    expect(saved.connection).toEqual({ kind: 'app', app: 'hubspot', settings: {} });
  });

  it.each(['github', 'box'])(
    'discards an earlier account selection after switching to another app using %s',
    async (provider) => {
      const github = APP_CATALOG.find((app) => app.id === 'github')!;
      if (!github.connect) throw new Error('Expected a connecting app');
      const { user } = start(undefined, [
        github,
        { ...github, id: 'account-fixture', name: 'Account fixture', connect: { provider } },
      ]);
      view.providers.push({ ...view.providers[0]!, provider: 'box' });
      await choose(user);
      await screen.findByRole('button', { name: /Connected account/ });
      let finishRefresh!: (view: ConnectionsView) => void;
      const refresh = new Promise<ConnectionsView>((resolve) => {
        finishRefresh = resolve;
      });
      vi.mocked(api).mockReturnValueOnce(refresh as never);
      fireEvent(
        window,
        new StorageEvent('storage', {
          key: CONNECTIONS_CHANNEL,
          newValue: JSON.stringify({ id: 'delayed-account', provider: 'github', ok: true }),
        }),
      );
      await user.click(screen.getByRole('option', { name: 'Account fixture' }));
      const save = screen.getByRole('button', { name: 'Save' });
      expect(save.hasAttribute('disabled')).toBe(true);
      await act(async () => {
        finishRefresh(view);
        await connectionStore.load();
      });
      expect(save.hasAttribute('disabled')).toBe(true);
      expect(screen.getByRole('button', { name: /Connected account/ }).textContent).toContain(
        'Choose an account',
      );
    },
  );

  it.each(['unconfigured', 'disabled'])(
    'explains admin setup and blocks saving when the provider is %s',
    async () => {
      view.providers[0]!.available = false;
      const { user } = start();
      await choose(user);
      expect(await screen.findByText(/Unavailable.*Settings, Integrations/)).toBeDefined();
      expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
      expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
      expect(screen.queryByLabelText('Key', { selector: 'input' })).toBeNull();
    },
  );
});

describe('accounting source setup', () => {
  it.each([1, 3])(
    'offers %i Xero organizations and selects the only organization automatically',
    async (count) => {
      view.providers = [
        {
          provider: 'xero',
          available: true,
          account: {
            id: 'xero-account',
            name: 'Accounting account',
            email: null,
            connectedAt: '2026-01-01T00:00:00.000Z',
            needsReconnect: false,
            settingChoices: {
              tenantId: Array.from({ length: count }, (_, i) => ({
                value: `organization-${i + 1}`,
                label: `Company ${i + 1}`,
              })),
            },
          },
        },
      ];
      const { user } = start(
        undefined,
        APP_CATALOG.filter((app) => app.id === 'xero'),
      );
      await user.click(screen.getByRole('option', { name: 'Xero' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
        target: { value: 'Accounting data' },
      });
      await user.click(await screen.findByRole('button', { name: /Connected account/ }));
      await user.click(screen.getByRole('option', { name: 'Accounting account' }));
      const organization = await screen.findByRole('button', { name: /Organization/ });
      if (count === 1) await waitFor(() => expect(organization.textContent).toContain('Company 1'));
      else {
        expect(organization.textContent).not.toContain('Company 1');
        await user.click(organization);
        for (let i = 1; i <= count; i++)
          expect(screen.getByRole('option', { name: `Company ${i}` })).toBeTruthy();
        await user.click(screen.getByRole('option', { name: 'Company 3' }));
      }
      await user.click(screen.getByRole('button', { name: 'Test connection' }));
      const tested = vi.mocked(api).mock.calls.find(([url]) => url === '/api/sources/test')?.[1]
        ?.body as SourceCreate;
      expect(tested.connection).toEqual({
        kind: 'app',
        app: 'xero',
        settings: { connectionId: 'xero-account', tenantId: `organization-${count}` },
      });
      expect(tested.secrets).toEqual({});
    },
  );

  it('preserves a saved Xero organization while the account list loads', async () => {
    view.providers = [
      {
        provider: 'xero',
        available: true,
        account: {
          id: 'xero-account',
          name: 'Accounting account',
          email: null,
          connectedAt: '2026-01-01T00:00:00.000Z',
          needsReconnect: false,
          settingChoices: {
            tenantId: [
              { value: 'organization-1', label: 'Company 1' },
              { value: 'organization-2', label: 'Company 2' },
            ],
          },
        },
      },
    ];
    const connection = {
      kind: 'app' as const,
      app: 'xero',
      settings: { connectionId: 'xero-account', tenantId: 'organization-2' },
    };
    start(
      { ...sourceMeta({ kind: 'app', secrets: [], connection }), connection },
      APP_CATALOG.filter((app) => app.id === 'xero'),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Organization/ }).textContent).toContain('Company 2'),
    );
  });
});
