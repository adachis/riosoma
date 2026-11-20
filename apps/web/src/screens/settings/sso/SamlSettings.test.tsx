import { renderSettings as renderSharing } from '../testing';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastRegion, toastQueue } from '@riosoma/ui';
import {
  SamlMetadataSource,
  SamlProviderCreate,
  SsoProviderUpdate,
  type SamlCertificate,
  type SamlDraft,
  type SamlMetadata,
  type SsoProvider,
} from '@riosoma/contracts';
import { json, session } from '../../database/share/testing';
import { SsoSettings } from './SsoSettings';

const BASE = 'https://riosoma.example.test';

function riosoma(id: string) {
  const entityId = `${BASE}/api/auth/saml/${id}/metadata`;
  return {
    entityId,
    acsUrl: `${BASE}/api/auth/saml/${id}/acs`,
    metadataUrl: entityId,
    metadata: `<EntityDescriptor entityID="${entityId}"/>`,
  };
}

const DRAFT: SamlDraft = { id: 'SamlDraftId00001', serviceProvider: riosoma('SamlDraftId00001') };

/** A moment years away, so a key still has time left or ran out long ago on any day. */
const yearsAway = (years: number) => new Date(Date.now() + years * 365 * 86_400_000).toISOString();

const OKTA_CERTIFICATE: SamlCertificate = {
  pem: '-----BEGIN CERTIFICATE-----\nMIIBokta\n-----END CERTIFICATE-----\n',
  subject: 'CN=acme, OU=SSOProvider, O=Okta',
  expiresAt: yearsAway(5),
  fingerprint: 'AB:CD:EF',
};
const OLD_CERTIFICATE: SamlCertificate = {
  pem: '-----BEGIN CERTIFICATE-----\nMIIBold\n-----END CERTIFICATE-----\n',
  subject: 'CN=Old key',
  expiresAt: yearsAway(-2),
  fingerprint: '01:02:03',
};

const OKTA: SamlMetadata = {
  entityId: 'http://www.okta.com/exk1abc',
  ssoUrl: 'https://acme.okta.com/app/acme_riosoma/exk1abc/sso/saml',
  certificates: [OKTA_CERTIFICATE],
};

function samlProvider(overrides: Partial<SsoProvider> = {}): SsoProvider {
  return {
    id: 'OktaProvider0001',
    kind: 'saml',
    name: 'Okta',
    issuer: OKTA.entityId,
    tenant: null,
    clientId: '',
    hasSecret: false,
    allowedDomains: ['example.org'],
    autoCreate: false,
    linkByEmail: true,
    enabled: true,
    redirectUri: `${BASE}/api/auth/sso/callback`,
    createdAt: '2026-09-27T12:00:00.000Z',
    identities: 2,
    saml: {
      entityId: OKTA.entityId,
      ssoUrl: OKTA.ssoUrl,
      certificates: [OKTA_CERTIFICATE, OLD_CERTIFICATE],
      verifiesEmails: true,
      serviceProvider: riosoma('OktaProvider0001'),
    },
    ...overrides,
  };
}

function medium(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(iso));
}

afterEach(() => {
  cleanup();
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A fake server for the SAML settings, with a hook to answer metadata requests differently. */
function start(
  listed: SsoProvider[] = [],
  metadata: (source: SamlMetadataSource) => Response = () => json(OKTA),
  identity = session,
) {
  let providers = listed;
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET';
    const body: unknown = options?.body ? JSON.parse(String(options.body)) : undefined;
    if (url === '/api/admin/sso' && method === 'GET') return json(providers);
    if (url === '/api/admin/sso/saml/new') return json(DRAFT);
    if (url === '/api/admin/sso/saml/metadata') return metadata(SamlMetadataSource.parse(body));
    if (url === '/api/admin/sso' && method === 'POST') {
      const input = SamlProviderCreate.parse(body);
      const created = samlProvider({
        id: input.id ?? 'ServerMadeId0001',
        name: input.name,
        issuer: input.saml.entityId,
        allowedDomains: input.allowedDomains,
        autoCreate: input.autoCreate,
        linkByEmail: input.linkByEmail,
        enabled: input.enabled,
        identities: 0,
        saml: {
          entityId: input.saml.entityId,
          ssoUrl: input.saml.ssoUrl,
          certificates: [OKTA_CERTIFICATE],
          verifiesEmails: input.saml.verifiesEmails,
          serviceProvider: riosoma(input.id ?? 'ServerMadeId0001'),
        },
      });
      providers = [...providers, created];
      return json(created);
    }
    const id = url.slice('/api/admin/sso/'.length);
    if (method === 'PATCH') {
      const { saml, ...rest } = SsoProviderUpdate.parse(body);
      providers = providers.map((entry) =>
        entry.id === id && entry.saml
          ? { ...entry, ...rest, saml: { ...entry.saml, ...saml, certificates: entry.saml.certificates } }
          : entry,
      );
      return json(providers.find((entry) => entry.id === id));
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

async function openSaml(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Add a provider' }));
  const dialog = await screen.findByRole('dialog', { name: 'Add a provider' });
  await user.click(within(dialog).getByRole('radio', { name: 'SAML identity provider' }));
  await within(dialog).findByRole('heading', { name: 'Riosoma’s details' });
  return dialog;
}

function value(scope: HTMLElement, name: string): string {
  return (within(scope).getByRole('textbox', { name }) as HTMLInputElement).value;
}

describe('SAML settings', () => {
  it('adds a SAML identity provider from its metadata address', async () => {
    const fetcher = start();
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const dialog = await openSaml(user);

    // Riosoma's details come first, ready to copy into the identity provider.
    const entityId = within(dialog).getByRole('textbox', { name: 'Entity ID' }) as HTMLInputElement;
    expect(entityId.value).toBe(DRAFT.serviceProvider.entityId);
    expect(entityId.hasAttribute('readonly')).toBe(true);
    expect(value(dialog, 'Assertion Consumer Service URL')).toBe(DRAFT.serviceProvider.acsUrl);
    await user.click(within(dialog).getByRole('button', { name: 'Copy entity ID' }));
    await screen.findByText('Copied');
    await user.click(within(dialog).getByRole('button', { name: 'Copy ACS URL' }));
    expect(writeText.mock.calls).toEqual([[DRAFT.serviceProvider.entityId], [DRAFT.serviceProvider.acsUrl]]);

    const files: Blob[] = [];
    const names: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((file) => {
      files.push(file as Blob);
      return 'blob:metadata';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    await user.click(within(dialog).getByRole('button', { name: 'Download Riosoma’s metadata' }));
    expect(names).toEqual(['riosoma-saml-SamlDraftId00001.xml']);
    expect(await files[0]!.text()).toBe(DRAFT.serviceProvider.metadata);

    // Then the identity provider's details, loaded from its metadata.
    const load = within(dialog).getByRole('button', { name: 'Load metadata' });
    expect(load.hasAttribute('disabled')).toBe(true);
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Metadata URL or XML' }),
      'https://acme.okta.com/app/exk1abc/sso/saml/metadata',
    );
    await user.click(load);
    await within(dialog).findByText('Filled in the identity provider’s details from its metadata.');
    expect(sent(fetcher, 'POST', '/api/admin/sso/saml/metadata')).toEqual([
      { url: 'https://acme.okta.com/app/exk1abc/sso/saml/metadata' },
    ]);
    expect(value(dialog, 'Identity provider’s entity ID')).toBe(OKTA.entityId);
    expect(value(dialog, 'Sign-in URL')).toBe(OKTA.ssoUrl);
    expect(value(dialog, 'Signing certificates')).toBe(OKTA_CERTIFICATE.pem.trim());
    const list = within(dialog).getByRole('list', { name: 'Certificates in use' });
    expect(list.textContent).toBe(
      `CN=acme, OU=SSOProvider, O=Okta, expires ${medium(OKTA_CERTIFICATE.expiresAt)}`,
    );

    await user.type(within(dialog).getByRole('textbox', { name: 'Button label' }), 'Okta');
    await user.click(
      within(dialog).getByRole('checkbox', { name: 'This identity provider verifies email addresses' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent(fetcher, 'POST', '/api/admin/sso')).toEqual([
      {
        kind: 'saml',
        id: 'SamlDraftId00001',
        name: 'Okta',
        saml: {
          entityId: OKTA.entityId,
          ssoUrl: OKTA.ssoUrl,
          certificates: [OKTA_CERTIFICATE.pem.trim()],
          verifiesEmails: true,
        },
        allowedDomains: [],
        autoCreate: false,
        linkByEmail: true,
        enabled: true,
      },
    ]);
    const saved = (await screen.findByRole('button', { name: 'Okta' })).closest('.rio-sso__provider')!;
    expect(saved.textContent).toContain('SAML identity provider');
  });

  it('reads pasted metadata, and says what’s wrong with metadata it can’t use', async () => {
    const fetcher = start([], (source) =>
      'xml' in source && source.xml.includes('broken')
        ? json(
            {
              error: {
                code: 'validation_failed',
                messageKey: 'sso.saml.metadata.incomplete',
                userFault: true,
                fields: { xml: 'sso.saml.metadata.incomplete' },
              },
            },
            422,
          )
        : json(OKTA),
    );
    const user = userEvent.setup();
    const dialog = await openSaml(user);
    const source = within(dialog).getByRole('textbox', { name: 'Metadata URL or XML' });
    await user.click(source);
    await user.paste('<EntityDescriptor broken/>');
    await user.click(within(dialog).getByRole('button', { name: 'Load metadata' }));
    expect(
      await within(dialog).findByText(
        'The metadata needs a signing certificate and an HTTP-Redirect sign-in URL.  Enter them by hand instead.',
        { normalizer: (text) => text },
      ),
    ).toBeDefined();
    expect(value(dialog, 'Identity provider’s entity ID')).toBe('');

    await user.clear(source);
    await user.click(source);
    await user.paste('<md:EntityDescriptor entityID="http://www.okta.com/exk1abc"/>');
    expect(within(dialog).queryByText(/The metadata needs/)).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Load metadata' }));
    await within(dialog).findByText('Filled in the identity provider’s details from its metadata.');
    expect(sent(fetcher, 'POST', '/api/admin/sso/saml/metadata')).toEqual([
      { xml: '<EntityDescriptor broken/>' },
      { xml: '<md:EntityDescriptor entityID="http://www.okta.com/exk1abc"/>' },
    ]);
    expect(value(dialog, 'Identity provider’s entity ID')).toBe(OKTA.entityId);
  });

  it('needs a label, the identity provider’s details, and a certificate, and shows the server’s objections', async () => {
    const fetcher = start();
    const user = userEvent.setup();
    const dialog = await openSaml(user);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getAllByText('This is required.')).toHaveLength(4);
    expect(sent(fetcher, 'POST', '/api/admin/sso')).toEqual([]);

    await user.type(within(dialog).getByRole('textbox', { name: 'Button label' }), 'Acme');
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Identity provider’s entity ID' }),
      'urn:acme:idp',
    );
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Sign-in URL' }),
      'http://idp.example.test/sso',
    );
    const certificates = within(dialog).getByRole('textbox', { name: 'Signing certificates' });
    await user.click(certificates);
    await user.paste('-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----');
    fetcher.mockResolvedValueOnce(
      json(
        {
          error: {
            code: 'validation_failed',
            messageKey: 'errors.validationFailed',
            userFault: true,
            fields: {
              'saml.ssoUrl': 'sso.saml.url.https',
              'saml.certificates.0': 'sso.saml.certificate.privateKey',
            },
          },
        },
        422,
      ),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Use an address that starts with https://.')).toBeDefined();
    expect(
      within(dialog).getByText(
        'That includes a private key, which should never leave your identity provider.  Paste only the certificate.',
        { normalizer: (text) => text },
      ),
    ).toBeDefined();
    expect(screen.getByRole('dialog', { name: 'Add a provider' })).toBeDefined();
  });

  it('keeps a new provider’s ID when the dialog closes before it’s saved', async () => {
    const fetcher = start();
    const user = userEvent.setup();
    let dialog = await openSaml(user);
    expect(value(dialog, 'Entity ID')).toBe(DRAFT.serviceProvider.entityId);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    dialog = await openSaml(user);
    expect(value(dialog, 'Entity ID')).toBe(DRAFT.serviceProvider.entityId);
    expect(fetcher.mock.calls.filter(([url]) => url === '/api/admin/sso/saml/new')).toHaveLength(1);
  });

  it('edits a SAML provider and lists its certificates', async () => {
    const fetcher = start([samlProvider()]);
    const user = userEvent.setup();
    const panel = (await screen.findByRole('button', { name: 'Okta' })).closest('.rio-sso__provider')!;
    expect(panel.textContent).toContain('SAML identity provider');
    expect(within(panel as HTMLElement).getByText('2 people')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Okta' }));
    expect(value(document.body, 'Entity ID')).toBe(riosoma('OktaProvider0001').entityId);
    expect(value(document.body, 'Assertion Consumer Service URL')).toBe(riosoma('OktaProvider0001').acsUrl);
    expect(value(document.body, 'Identity provider’s entity ID')).toBe(OKTA.entityId);
    expect(
      Array.from(
        screen.getByRole('list', { name: 'Certificates in use' }).querySelectorAll('li'),
        (item) => item.textContent,
      ),
    ).toEqual([
      `CN=acme, OU=SSOProvider, O=Okta, expires ${medium(OKTA_CERTIFICATE.expiresAt)}`,
      `CN=Old key, expired ${medium(OLD_CERTIFICATE.expiresAt)}`,
    ]);
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'This identity provider verifies email addresses',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);

    const ssoUrl = screen.getByRole('textbox', { name: 'Sign-in URL' });
    await user.clear(ssoUrl);
    await user.type(ssoUrl, 'https://acme.okta.com/app/acme_riosoma/exk1abc/sso/saml2');
    // Typing in the certificates means the list no longer says what's in the field.
    await user.type(screen.getByRole('textbox', { name: 'Signing certificates' }), ' ');
    expect(screen.queryByRole('list', { name: 'Certificates in use' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(fetcher, 'PATCH')).toHaveLength(1));
    expect(sent(fetcher, 'PATCH')).toEqual([
      {
        name: 'Okta',
        saml: {
          entityId: OKTA.entityId,
          ssoUrl: 'https://acme.okta.com/app/acme_riosoma/exk1abc/sso/saml2',
          certificates: [`${OKTA_CERTIFICATE.pem.trim()}\n${OLD_CERTIFICATE.pem.trim()}`],
          verifiesEmails: true,
        },
        allowedDomains: ['example.org'],
        autoCreate: false,
        linkByEmail: true,
        enabled: true,
      },
    ]);
    expect(fetcher.mock.calls.find(([, options]) => options?.method === 'PATCH')?.[0]).toBe(
      '/api/admin/sso/OktaProvider0001',
    );
    // Saved, the list shows what the server read from the field.
    expect(await screen.findByRole('list', { name: 'Certificates in use' })).toBeDefined();
  });

  it('shows a Security admin the identity provider’s details without offering to change them', async () => {
    const stored = samlProvider();
    start([{ ...stored, saml: { ...stored.saml!, verifiesEmails: false } }], undefined, {
      ...session,
      membership: { kind: 'member', adminRoles: ['security'] },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Okta' }));
    expect(screen.queryByRole('textbox', { name: 'Metadata URL or XML' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load metadata' })).toBeNull();
    for (const name of ['Identity provider’s entity ID', 'Sign-in URL', 'Signing certificates'])
      expect(screen.getByRole('textbox', { name }).hasAttribute('readonly'), name).toBe(true);
    expect(screen.getByRole('textbox', { name: 'Button label' }).hasAttribute('readonly')).toBe(false);
    // Trust that is off stays off, and linking that is on can still be turned off.
    expect(
      screen.getByRole('checkbox', { name: 'This identity provider verifies email addresses' }),
    ).toHaveProperty('disabled', true);
    expect(
      screen.getByRole('checkbox', { name: 'Link to existing accounts with the same verified email' }),
    ).toHaveProperty('disabled', false);
  });
});
