import { renderSettings as renderSharing } from '../testing';
import type { ReactNode } from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastRegion, toastQueue } from '@riosoma/ui';
import {
  OidcProviderCreate,
  SsoProviderUpdate,
  type SessionInfo,
  type SsoProvider,
  type SsoTestResult,
} from '@riosoma/contracts';
import { failure, json, session } from '../../database/share/testing';
import { SettingsScreen } from '../SettingsScreen';
import { canManageSso, SsoSettings } from './SsoSettings';

vi.mock('../AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('../LanguageSettings', () => ({ LanguageSettings: () => null }));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => undefined,
  useLocation: () => ({ pathname: '/settings/sso', href: '/settings/sso' }),
  useNavigate: () => vi.fn(),
  useParams: () => ({ section: 'sso' }),
  Link: ({ params, children }: { params: { section: string }; children: ReactNode }) => (
    <a href={`/settings/${params.section}`}>{children}</a>
  ),
}));

const CALLBACK = 'https://riosoma.example.test/api/auth/sso/callback';
const FOUND: SsoTestResult = {
  ok: true,
  discovered: {
    issuer: 'https://accounts.google.com',
    authorizationEndpoint: 'https://x.test/auth',
    pkce: true,
  },
};

function provider(overrides: Partial<SsoProvider> = {}): SsoProvider {
  return {
    id: 'AcmeProvider0001',
    kind: 'oidc',
    name: 'Acme',
    issuer: 'https://idp.example.test/realms/acme',
    tenant: null,
    clientId: 'acme-client',
    hasSecret: true,
    allowedDomains: ['example.org'],
    autoCreate: false,
    linkByEmail: true,
    enabled: true,
    redirectUri: CALLBACK,
    createdAt: '2026-09-27T12:00:00.000Z',
    identities: 3,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SECURITY: SessionInfo = { ...session, membership: { kind: 'member', adminRoles: ['security'] } };

function start(listed: SsoProvider[] = [], tested: SsoTestResult = FOUND, identity = session) {
  let providers = listed;
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET';
    const body: unknown = options?.body ? JSON.parse(String(options.body)) : undefined;
    if (url === '/api/admin/sso' && method === 'GET') return json(providers);
    if (url === '/api/admin/sso/test') return json(tested);
    if (url === '/api/admin/sso' && method === 'POST') {
      const input = OidcProviderCreate.parse(body);
      const { clientSecret: _secret, issuer: _issuer, tenant, ...rest } = input;
      const created = provider({ ...rest, id: 'GoogleProvider01', tenant: tenant || null, identities: 0 });
      providers = [...providers, created];
      return json(created);
    }
    const id = url.slice('/api/admin/sso/'.length);
    if (method === 'PATCH') {
      const { clientSecret: _secret, tenant, saml: _saml, ...rest } = SsoProviderUpdate.parse(body);
      providers = providers.map((entry) =>
        entry.id === id
          ? { ...entry, ...rest, ...(tenant === undefined ? {} : { tenant: tenant || null }) }
          : entry,
      );
      return json(providers.find((entry) => entry.id === id));
    }
    if (method === 'DELETE') {
      providers = providers.filter((entry) => entry.id !== id);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  renderSharing(
    <>
      <SsoSettings />
      <ToastRegion />
    </>,
    identity,
  );
  return fetcher;
}

type Fetcher = ReturnType<typeof start>;

function sent(fetcher: Fetcher, method: string, url?: string): unknown[] {
  return fetcher.mock.calls
    .filter(([path, options]) => (options?.method ?? 'GET') === method && (!url || path === url))
    .map(([, options]) => JSON.parse(String(options?.body ?? 'null')));
}

async function openAdd(user: ReturnType<typeof userEvent.setup>, kind: string) {
  await user.click(await screen.findByRole('button', { name: 'Add a provider' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add a provider' });
  await user.click(within(dialog).getByRole('radio', { name: kind }));
  return dialog;
}

describe('SsoSettings', () => {
  it.each([
    { kind: 'owner' as const, adminRoles: [], visible: true },
    { kind: 'member' as const, adminRoles: ['security'], visible: true },
    { kind: 'member' as const, adminRoles: ['people', 'ai'], visible: false },
    { kind: 'guest' as const, adminRoles: [], visible: false },
  ])('shows the section to $kind with $adminRoles: $visible', async ({ kind, adminRoles, visible }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json([])),
    );
    renderSharing(<SettingsScreen />, { ...session, membership: { kind, adminRoles } });
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const link = within(nav).queryByRole('link', { name: 'Single sign-on' });
    expect(Boolean(link)).toBe(visible);
    expect(canManageSso({ ...session, membership: { kind, adminRoles } })).toBe(visible);
    if (visible) {
      expect(link?.getAttribute('href')).toBe('/settings/sso');
      // Only the owner is offered a new provider, and everyone else is told why.
      if (kind === 'owner')
        expect(await screen.findByRole('button', { name: 'Add a provider' })).toBeDefined();
      else {
        expect(await screen.findByText(/^Only an owner can add a provider/)).toBeDefined();
        expect(screen.queryByRole('button', { name: 'Add a provider' })).toBeNull();
      }
    }
  });

  it('turns away people without the Security role before asking the server', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    renderSharing(<SsoSettings />, { ...session, membership: { kind: 'member', adminRoles: ['people'] } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Only an administrator'));
    expect(screen.queryByRole('button', { name: 'Add a provider' })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(canManageSso(null)).toBe(false);
  });

  it('lists each provider with its kind, status, and how many people use it', async () => {
    start([
      provider(),
      provider({
        id: 'GoogleProvider01',
        kind: 'google',
        name: 'Google Workspace',
        enabled: false,
        identities: 1,
      }),
    ]);
    expect(
      await screen.findByText(
        'Let people sign in with an account they already have, like Google or Microsoft.',
      ),
    ).toBeDefined();
    const acme = (await screen.findByRole('button', { name: 'Acme' })).closest('.rio-sso__provider')!;
    expect(acme.textContent).toContain('Another OpenID Connect provider');
    expect(within(acme as HTMLElement).getByText('On')).toBeDefined();
    expect(within(acme as HTMLElement).getByText('3 people')).toBeDefined();
    const google = screen.getByRole('button', { name: 'Google Workspace' }).closest('.rio-sso__provider')!;
    expect(within(google as HTMLElement).getByText('Google')).toBeDefined();
    expect(within(google as HTMLElement).getByText('Off')).toBeDefined();
    expect(within(google as HTMLElement).getByText('1 person')).toBeDefined();
  });

  it('adds Google with only a client ID and secret, after testing it', async () => {
    const fetcher = start();
    // user-event puts its own clipboard in place, so the spy goes on after it.
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await user.click(await screen.findByRole('button', { name: 'Add a provider' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a provider' });
    // Kind comes first: nothing else is asked until one is chosen.
    expect(within(dialog).queryByRole('textbox', { name: 'Client ID' })).toBeNull();
    await user.click(within(dialog).getByRole('radio', { name: 'Google' }));
    expect((within(dialog).getByRole('textbox', { name: 'Button label' }) as HTMLInputElement).value).toBe(
      'Google',
    );
    expect(within(dialog).queryByRole('textbox', { name: 'Issuer URL' })).toBeNull();
    expect(within(dialog).queryByRole('textbox', { name: 'Tenant ID or domain' })).toBeNull();

    const callback = within(dialog).getByRole('textbox', {
      name: 'Callback address to register with the provider',
    }) as HTMLInputElement;
    expect(callback.value).toBe(`${window.location.origin}/api/auth/sso/callback`);
    expect(callback.hasAttribute('readonly')).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Copy' }));
    await screen.findByText('Copied');
    expect(writeText).toHaveBeenCalledWith(callback.value);

    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    await within(dialog).findByText('Found the provider.');
    expect(sent(fetcher, 'POST', '/api/admin/sso/test')).toEqual([{ issuer: 'https://accounts.google.com' }]);

    await user.type(within(dialog).getByRole('textbox', { name: 'Client ID' }), 'google-client');
    await user.type(within(dialog).getByLabelText(/^Client secret/), 's3cret value');
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Email domains that may create accounts' }),
      'Example.org, acme.test example.org',
    );
    await user.click(
      within(dialog).getByRole('checkbox', { name: 'Create accounts for new people from these domains' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent(fetcher, 'POST', '/api/admin/sso')).toEqual([
      {
        kind: 'google',
        name: 'Google',
        clientId: 'google-client',
        clientSecret: 's3cret value',
        allowedDomains: ['example.org', 'acme.test'],
        autoCreate: true,
        linkByEmail: true,
        enabled: true,
      },
    ]);
    expect(await screen.findByRole('button', { name: 'Google' })).toBeDefined();
  });

  it('asks Microsoft for an optional tenant and tests the issuer it makes', async () => {
    const fetcher = start([provider()], { ok: false, messageKey: 'sso.test.unreachable' });
    const user = userEvent.setup();
    const dialog = await openAdd(user, 'Microsoft Entra ID');
    const tenant = within(dialog).getByRole('textbox', { name: 'Tenant ID or domain' });
    expect(dialog.textContent).toContain('Leave empty to allow any work or school account.');
    // With a provider on the list, the address comes from the server.
    expect(
      (
        within(dialog).getByRole('textbox', {
          name: 'Callback address to register with the provider',
        }) as HTMLInputElement
      ).value,
    ).toBe(CALLBACK);
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Couldn’t reach that address.  Check the issuer URL, and that this server can reach it.',
    );
    await user.type(tenant, 'contoso.onmicrosoft.com');
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(sent(fetcher, 'POST', '/api/admin/sso/test')).toHaveLength(2));
    expect(sent(fetcher, 'POST', '/api/admin/sso/test')).toEqual([
      { issuer: 'https://login.microsoftonline.com/organizations/v2.0' },
      { issuer: 'https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0' },
    ]);
  });

  it('needs an issuer, a label, and the client for another OpenID Connect provider', async () => {
    const fetcher = start();
    const user = userEvent.setup();
    const dialog = await openAdd(user, 'Another OpenID Connect provider');
    expect((within(dialog).getByRole('textbox', { name: 'Button label' }) as HTMLInputElement).value).toBe(
      '',
    );
    expect(within(dialog).getByRole('button', { name: 'Test' }).hasAttribute('disabled')).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getAllByText('This is required.')).toHaveLength(4);
    await user.type(within(dialog).getByRole('textbox', { name: 'Issuer URL' }), 'not a web address');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByText('Check the format of this.')).toBeDefined();
    expect(sent(fetcher, 'POST', '/api/admin/sso')).toEqual([]);

    const issuer = within(dialog).getByRole('textbox', { name: 'Issuer URL' });
    await user.clear(issuer);
    await user.type(issuer, 'https://idp.example.test/realms/acme');
    await user.type(within(dialog).getByRole('textbox', { name: 'Button label' }), 'Acme');
    await user.type(within(dialog).getByRole('textbox', { name: 'Client ID' }), 'acme-client');
    await user.type(within(dialog).getByLabelText(/^Client secret/), 'acme secret');
    await user.click(
      within(dialog).getByRole('checkbox', {
        name: 'Link to existing accounts with the same verified email',
      }),
    );
    await user.click(within(dialog).getByRole('switch', { name: 'Show on the sign-in page' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent(fetcher, 'POST', '/api/admin/sso')).toEqual([
      {
        kind: 'oidc',
        name: 'Acme',
        issuer: 'https://idp.example.test/realms/acme',
        clientId: 'acme-client',
        clientSecret: 'acme secret',
        allowedDomains: [],
        autoCreate: false,
        linkByEmail: false,
        enabled: false,
      },
    ]);
  });

  it('edits a provider and keeps the stored secret unless it is replaced', async () => {
    const fetcher = start([provider()]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Acme' }));
    const secret = screen.getByRole('group', { name: 'Client secret' });
    expect(within(secret).getByText('Stored')).toBeDefined();
    expect(screen.queryByLabelText(/^Client secret/, { selector: 'input' })).toBeNull();
    expect(
      (screen.getByRole('textbox', { name: 'Email domains that may create accounts' }) as HTMLInputElement)
        .value,
    ).toBe('example.org');
    const label = screen.getByRole('textbox', { name: 'Button label' });
    await user.clear(label);
    await user.type(label, 'Acme sign-in');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Acme sign-in' });
    expect(sent(fetcher, 'PATCH')).toEqual([
      {
        name: 'Acme sign-in',
        clientId: 'acme-client',
        allowedDomains: ['example.org'],
        autoCreate: false,
        linkByEmail: true,
        enabled: true,
        issuer: 'https://idp.example.test/realms/acme',
      },
    ]);
    expect(fetcher.mock.calls.find(([, options]) => options?.method === 'PATCH')?.[0]).toBe(
      '/api/admin/sso/AcmeProvider0001',
    );

    await user.click(
      within(screen.getByRole('group', { name: 'Client secret' })).getByRole('button', { name: 'Replace' }),
    );
    await user.type(screen.getByLabelText(/^Client secret/, { selector: 'input' }), 'a new secret');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(fetcher, 'PATCH')).toHaveLength(2));
    expect(sent(fetcher, 'PATCH')[1]).toMatchObject({ clientSecret: 'a new secret' });
    // Saved, the secret is stored again and never shown.
    expect(await screen.findByText('Stored')).toBeDefined();
  });

  it('shows a Security admin what the owner set and saves the rest', async () => {
    const fetcher = start([provider()], FOUND, SECURITY);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Acme' }));
    for (const name of ['Issuer URL', 'Client ID'])
      expect(screen.getByRole('textbox', { name }).hasAttribute('readonly'), name).toBe(true);
    expect(
      within(screen.getByRole('group', { name: 'Client secret' })).getByRole('button', { name: 'Replace' }),
    ).toHaveProperty('disabled', true);
    expect(screen.getByRole('textbox', { name: 'Button label' }).hasAttribute('readonly')).toBe(false);
    // Linking that is on can be turned off, and once it is off only the owner turns it back on.
    const linking = screen.getByRole('checkbox', {
      name: 'Link to existing accounts with the same verified email',
    });
    expect(linking).toHaveProperty('disabled', false);
    await user.click(linking);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(fetcher, 'PATCH')).toHaveLength(1));
    expect(sent(fetcher, 'PATCH')[0]).toMatchObject({
      issuer: 'https://idp.example.test/realms/acme',
      clientId: 'acme-client',
      linkByEmail: false,
    });
    expect(sent(fetcher, 'PATCH')[0]).not.toHaveProperty('clientSecret');
    await waitFor(() => expect(linking).toHaveProperty('disabled', true));
  });

  it('asks for the secret again before moving to a new issuer, and checks domains', async () => {
    const fetcher = start([provider()]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Acme' }));
    const issuer = screen.getByRole('textbox', { name: 'Issuer URL' });
    await user.clear(issuer);
    await user.type(issuer, 'https://login.example.test');
    expect(screen.queryByRole('group', { name: 'Client secret' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      screen.getByText('Enter the client secret again.  A stored secret is never sent to a new issuer.', {
        normalizer: (text) => text,
      }),
    ).toBeDefined();
    const domains = screen.getByRole('textbox', { name: 'Email domains that may create accounts' });
    await user.clear(domains);
    await user.type(domains, 'example.org not_a_domain');
    await user.type(screen.getByLabelText(/^Client secret/, { selector: 'input' }), 'the new secret');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Check the format of this.')).toBeDefined();
    expect(sent(fetcher, 'PATCH')).toEqual([]);

    await user.clear(domains);
    fetcher.mockResolvedValueOnce(failure('errors.adminOnly', 403));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Only an administrator can do that.');
  });

  it('deletes a provider only after confirming', async () => {
    const fetcher = start([provider()]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Acme' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    let dialog = await screen.findByRole('dialog', { name: 'Delete Acme?' });
    expect(dialog.textContent).toContain('People who sign in with it will need another way to sign in.');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fetcher.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    dialog = await screen.findByRole('dialog', { name: 'Delete Acme?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Acme' })).toBeNull());
    expect(fetcher.mock.calls.find(([, options]) => options?.method === 'DELETE')?.[0]).toBe(
      '/api/admin/sso/AcmeProvider0001',
    );
  });
});

it('reconciles normalized labels after a successful page save', async () => {
  start([provider()]);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Acme' }));
  const field = await screen.findByRole('textbox', { name: 'Button label' });
  await user.clear(field);
  await user.type(field, '  New name  ');
  const bar = within(screen.getByRole('region', { name: 'Save changes' }));
  await user.click(bar.getByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(bar.getByRole('status').textContent).toBe('No unsaved changes'));
  expect(field).toHaveProperty('value', 'New name');
});
