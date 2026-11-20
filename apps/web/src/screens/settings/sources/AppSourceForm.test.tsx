import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { APP_CATALOG, type SourceCreate } from '@riosoma/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../api';
import type * as ApiModule from '../../../api';
import { sourceMeta } from './testing';
import { SourceDialog } from './SourceDialog';
import { TEST_APP_CATALOG, TEST_APP_MESSAGES } from './app-catalog.test-support';
import { patchTreeWalkerPreviousNode } from '../../../../../../packages/ui/src/test/tree-walker';

vi.mock('../../../api', async (original) => ({
  ...(await original<typeof ApiModule>()),
  api: vi.fn(),
}));
patchTreeWalkerPreviousNode();
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

function start(props: Partial<Parameters<typeof SourceDialog>[0]> = {}) {
  const onSaved = vi.fn();
  const i18n = setupI18n({
    locale: 'en-US',
    messages: { 'en-US': { ...TEST_APP_MESSAGES, 'sources.app.refreshToken': 'Refresh token' } },
  });
  render(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
        <SourceDialog appCatalog={TEST_APP_CATALOG} onSaved={onSaved} onClose={vi.fn()} {...props} />
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { user: userEvent.setup(), onSaved };
}

async function fillGarden(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('option', { name: 'Garden Forms' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Garden data' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Workspace code' }), { target: { value: 'GARDEN' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Account address' }), {
    target: { value: 'https://garden.example.com' },
  });
  await user.click(screen.getByRole('button', { name: /Region/ }));
  await user.click(screen.getByRole('option', { name: 'east' }));
  fireEvent.change(screen.getByLabelText('Key', { selector: 'input' }), {
    target: { value: ['stand', 'in', 'key'].join('-') },
  });
}

function keyedApp(index: number) {
  const app = TEST_APP_CATALOG[index]!;
  if (!app.secret) throw new Error('Expected a keyed app');
  return app;
}

describe('catalog app sources', () => {
  it('shows ordered password fields with their own labels and help and sends every required secret', async () => {
    const app = {
      ...keyedApp(2),
      additionalSecrets: [
        {
          name: 'refreshToken' as const,
          labelMessageId: 'sources.app.refreshToken',
          helpMessageId: 'sources.app.fixture.keyHelp',
        },
      ],
    };
    const { user } = start({ appCatalog: [app] });
    await user.click(screen.getByRole('option', { name: app.name }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Records' } });
    const key = screen.getByLabelText('Key', { selector: 'input' });
    const refresh = screen.getByLabelText('Refresh token', { selector: 'input' });
    expect(key.getAttribute('type')).toBe('password');
    expect(refresh.getAttribute('type')).toBe('password');
    expect(Boolean(key.compareDocumentPosition(refresh) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(screen.getAllByText('Use a key with read access.')).toHaveLength(2);
    fireEvent.change(key, { target: { value: 'fixture-key' } });
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(refresh, { target: { value: 'fixture-refresh' } });
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);
    vi.mocked(api).mockResolvedValueOnce({
      ok: false,
      steps: [
        {
          step: 'authenticate',
          status: 'failed',
          ms: 0,
          messageKey: 'sources.app.secretMissing',
          params: { fieldMessageId: 'sources.app.refreshToken' },
        },
      ],
    });
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Enter Refresh token before testing or syncing.')).toBeDefined();
    const sent = vi.mocked(api).mock.calls.at(-1)?.[1]?.body as SourceCreate;
    expect(Boolean(sent.secrets?.password && sent.secrets.refreshToken)).toBe(true);
    vi.mocked(api).mockResolvedValueOnce({
      ok: false,
      steps: [
        {
          step: 'authenticate',
          status: 'failed',
          ms: 0,
          messageKey: 'sources.app.keyInvalid',
          params: { keyUrl: app.keyUrl },
        },
      ],
    });
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText(/This key does not look like this app’s key/);
    expect(
      within(screen.getByRole('region', { name: 'Test connection' }))
        .getByRole('link', { name: 'Create a key' })
        .getAttribute('href'),
    ).toBe(app.keyUrl);
  });

  it('keeps each saved secret independently when only one is replaced', async () => {
    const app = {
      ...keyedApp(2),
      additionalSecrets: [
        {
          name: 'refreshToken' as const,
          labelMessageId: 'sources.app.refreshToken',
          helpMessageId: 'sources.app.fixture.keyHelp',
        },
      ],
    };
    const connection = { kind: 'app' as const, app: app.id, settings: {} };
    const saved = sourceMeta({ kind: 'app', connection, secrets: ['password', 'refreshToken'] });
    const { user, onSaved } = start({ appCatalog: [app], source: { ...saved, connection } });
    expect(screen.queryByLabelText('Key', { selector: 'input' })).toBeNull();
    expect(screen.queryByLabelText('Refresh token', { selector: 'input' })).toBeNull();
    await user.click(screen.getAllByRole('button', { name: 'Replace' })[1]!);
    fireEvent.change(screen.getByLabelText('Refresh token', { selector: 'input' }), {
      target: { value: 'fixture-replacement' },
    });
    vi.mocked(api).mockResolvedValueOnce(saved);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const sent = vi.mocked(api).mock.calls.at(-1)?.[1]?.body as { secrets?: Record<string, string> };
    expect(Object.keys(sent.secrets ?? {})).toEqual(['refreshToken']);
  });

  it('lists every real app and every injected app by its untranslated name in the Apps group', () => {
    start({ appCatalog: APP_CATALOG });
    for (const app of APP_CATALOG) expect(screen.getByRole('option', { name: app.name })).toBeDefined();
    expect(screen.getByRole('group', { name: 'Apps' })).toBeDefined();
    cleanup();
    start();
    for (const app of TEST_APP_CATALOG) expect(screen.getByRole('option', { name: app.name })).toBeDefined();
    expect(screen.getByRole('option', { name: 'Garden Forms' }).querySelector('svg')).not.toBeNull();
  });

  it('filters the catalog by app name, including a list longer than eight apps', async () => {
    const catalog = Array.from({ length: 3 }, (_, index) =>
      TEST_APP_CATALOG.map((app) => ({ ...app, id: `${app.id}-${index}`, name: `${app.name} ${index}` })),
    ).flat();
    const { user } = start({ appCatalog: catalog });
    await user.type(screen.getByRole('searchbox', { name: 'Filter sources' }), 'Harbor');
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.queryByRole('option', { name: 'Garden Forms 0' })).toBeNull();
  });

  it('renders labels, help, required fields, and live validation for every catalog setting kind', async () => {
    const { user } = start();
    await user.click(screen.getByRole('option', { name: 'Garden Forms' }));
    const code = screen.getByRole('textbox', { name: 'Workspace code' });
    expect(code.getAttribute('aria-required')).toBe('true');
    expect(screen.getByText('Use two to six uppercase letters.')).toBeDefined();
    expect(screen.getByText('Choose the region that holds your records.')).toBeDefined();
    expect(screen.getByRole('textbox', { name: 'Optional code' }).getAttribute('aria-required')).not.toBe(
      'true',
    );
    expect(code.getAttribute('aria-invalid')).toBe('true');
    for (const value of ['lower', 'TOOLONG', 'AB\u007f']) {
      fireEvent.change(code, { target: { value } });
      expect(code.getAttribute('aria-invalid'), value).toBe('true');
    }
    fireEvent.change(code, { target: { value: 'AB' } });
    expect(code.getAttribute('aria-invalid')).not.toBe('true');
    const address = screen.getByRole('textbox', { name: 'Account address' });
    for (const value of [
      'http://garden.example.com',
      'https://example.com.evil.test',
      'https://garden.example.com/path',
      'https://user@garden.example.com',
      'https://garden.example.com:444',
      'https://garden.example.com?x=1',
      'https://garden.example.com#part',
    ]) {
      fireEvent.change(address, { target: { value } });
      expect(address.getAttribute('aria-invalid'), value).toBe('true');
    }
    fireEvent.change(address, { target: { value: 'https://garden.example.com/' } });
    expect(address.getAttribute('aria-invalid')).not.toBe('true');
    const note = screen.getByRole('textbox', { name: 'Optional code' });
    fireEvent.change(note, { target: { value: '12345' } });
    expect(note.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(note, { target: { value: '' } });
    expect(note.getAttribute('aria-invalid')).not.toBe('true');
    const choice = screen.getByRole('button', { name: /Region/ });
    expect(choice.closest('.rio-select')?.querySelector('.rio-sources__app-required')).not.toBeNull();
    expect(choice.closest('.rio-select')?.hasAttribute('data-invalid')).toBe(true);
    await user.click(choice);
    expect(
      screen.getAllByRole('option').filter((option) => ['east', 'west'].includes(option.textContent ?? '')),
    ).toHaveLength(2);
    await user.click(screen.getByRole('option', { name: 'west' }));
    expect(choice.closest('.rio-select')?.hasAttribute('data-invalid')).toBe(false);
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
  });

  it('keeps the setting name on a catalog choice list with more than ten options', async () => {
    const regions = Array.from({ length: 12 }, (_, index) => `region-${index + 1}`);
    const catalog = TEST_APP_CATALOG.map((app) => ({
      ...app,
      settings: app.settings.map((setting) =>
        setting.type === 'choice' ? { ...setting, values: regions } : setting,
      ),
    }));
    const { user } = start({ appCatalog: catalog });
    await user.click(screen.getByRole('option', { name: 'Garden Forms' }));
    await user.click(screen.getByRole('button', { name: /Region/ }));
    const list = screen.getByRole('listbox', { name: /Region/ });
    expect(list.getAttribute('aria-label')).toBe('Region');
    expect(within(list).getAllByRole('option')).toHaveLength(12);
    await user.click(within(list).getByRole('option', { name: regions[11] }));
    expect(screen.getByRole('button', { name: /Region/ }).textContent).toContain(regions[11]);
  });

  it.each(TEST_APP_CATALOG)(
    'opens $name’s catalog key page in a new tab with its secret guidance',
    async (app) => {
      const { user } = start();
      await user.click(screen.getByRole('option', { name: app.name }));
      const link = screen.getByRole('link', { name: 'Create a key' });
      expect(link.getAttribute('href')).toBe(app.keyUrl);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
      expect(screen.getByText('Use a key with read access.')).toBeDefined();
      expect(screen.getByLabelText('Key', { selector: 'input' }).getAttribute('type')).toBe('password');
    },
  );

  it('can clear an optional catalog choice without making the source invalid', async () => {
    const { user } = start();
    await user.click(screen.getByRole('option', { name: 'Harbor CRM' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Harbor data' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Account address' }), {
      target: { value: 'https://reader.harbor.example' },
    });
    fireEvent.change(screen.getByLabelText('Key', { selector: 'input' }), { target: { value: 'stand-in' } });
    await user.click(screen.getByRole('button', { name: /Region/ }));
    await user.click(screen.getByRole('option', { name: 'east' }));
    await user.click(screen.getByRole('button', { name: /Region/ }));
    await user.click(screen.getByRole('option', { name: 'No value' }));
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false);
  });

  it('rejects a saved choice outside the catalog’s allowed values before save', () => {
    const connection = {
      kind: 'app' as const,
      app: 'garden',
      settings: { workspace: 'AB', address: 'https://garden.example.com', region: 'north' },
    };
    const saved = sourceMeta({ kind: 'app', connection, secrets: ['apiKey'] });
    start({ source: { ...saved, connection } });
    expect(
      screen
        .getByRole('button', { name: /Region/ })
        .closest('.rio-select')
        ?.hasAttribute('data-invalid'),
    ).toBe(true);
    expect(screen.getByText('Check the app setting and its allowed values.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true);
  });

  it('keeps a saved key when its replacement is empty', async () => {
    const connection = { kind: 'app' as const, app: 'orchard', settings: {} };
    const saved = sourceMeta({ kind: 'app', connection, secrets: ['password'] });
    const { user, onSaved } = start({ source: { ...saved, connection } });
    await user.click(screen.getByRole('button', { name: 'Replace' }));
    vi.mocked(api).mockResolvedValueOnce(saved);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(vi.mocked(api).mock.calls.at(-1)?.[1]?.body).not.toHaveProperty('secrets');
  });

  it('clears settings, secrets, and test results on app change and preserves source details', async () => {
    const { user } = start();
    await fillGarden(user);
    vi.mocked(api).mockResolvedValueOnce({ ok: true, steps: [] });
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText('Connected.');
    await user.click(screen.getByRole('option', { name: 'Harbor CRM' }));
    expect((screen.getByRole('textbox', { name: 'Account address' }) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Key', { selector: 'input' }) as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('Connected.')).toBeNull();
    await user.click(screen.getByRole('option', { name: 'Garden Forms' }));
    expect((screen.getByRole('textbox', { name: 'Workspace code' }) as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: /Region/ }).textContent).toContain('Choose a value');
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Garden data');
  });

  it.each(['replace', 'remove'] as const)(
    'keeps a saved app fixed, hides its key, and can %s it',
    async (action) => {
      const connection = {
        kind: 'app' as const,
        app: 'garden',
        settings: { workspace: 'AB', address: 'https://garden.example.com', region: 'east' },
      };
      const saved = sourceMeta({ kind: 'app', connection, secrets: ['apiKey'] });
      const { user, onSaved } = start({ source: { ...saved, connection } });
      expect(screen.queryByRole('listbox', { name: 'What do you want to connect?' })).toBeNull();
      expect(screen.getByText('Garden Forms')).toBeDefined();
      expect(screen.queryByLabelText('Key', { selector: 'input' })).toBeNull();
      expect((screen.getByRole('textbox', { name: 'Workspace code' }) as HTMLInputElement).value).toBe('AB');
      if (action === 'replace') {
        await user.click(screen.getByRole('button', { name: 'Replace' }));
        fireEvent.change(screen.getByLabelText('Key', { selector: 'input' }), {
          target: { value: 'replacement' },
        });
      } else await user.click(screen.getByRole('button', { name: 'Remove' }));
      vi.mocked(api).mockResolvedValueOnce(saved);
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(vi.mocked(api).mock.calls.at(-1)?.[1]?.body).toMatchObject({
        connection,
        secrets: { apiKey: action === 'replace' ? 'replacement' : null },
      });
    },
  );

  it('tests the catalog connection and renders app-specific failure advice', async () => {
    const { user } = start();
    await fillGarden(user);
    vi.mocked(api).mockResolvedValueOnce({
      ok: false,
      steps: [{ step: 'authenticate', status: 'failed', ms: 2, messageKey: 'sources.app.authenticate' }],
    });
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    const report = await screen.findByRole('region', { name: 'Test connection' });
    expect(within(report).getByText(/The app could not verify the key/)).toBeDefined();
    const sent = vi.mocked(api).mock.calls.at(-1)?.[1]?.body as SourceCreate;
    expect(sent.connection).toEqual({
      kind: 'app',
      app: 'garden',
      settings: { workspace: 'GARDEN', address: 'https://garden.example.com', region: 'east' },
    });
    expect(sent.secrets?.apiKey).toBeTruthy();
  });
});
