import { renderSettings as renderSharing } from '../testing';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScimAdministration, ScimDomainVerification } from '@riosoma/contracts';
import { json, session } from '../../database/share/testing';
import { ScimSettings } from './ScimSettings';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(initial: Partial<ScimAdministration> = {}, domains: ScimDomainVerification[] = []) {
  const secret = [crypto.randomUUID(), crypto.randomUUID()].join('');
  let state: ScimAdministration = {
    baseUrl: `${window.location.origin}/scim/v2`,
    settings: { dryRun: false, deleteAction: 'suspend' },
    tokens: [],
    unmanaged: [],
    ...initial,
  };
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET';
    if (url === '/api/admin/sso') return json([]);
    if (url === '/api/admin/scim/domains') return json(domains);
    if (url === '/api/admin/scim' && method === 'GET') return json(state);
    if (url === '/api/admin/scim' && method === 'PUT') {
      state = { ...state, settings: JSON.parse(String(options?.body)) as ScimAdministration['settings'] };
      return json(state.settings);
    }
    if (url === '/api/admin/scim/tokens' && method === 'POST') {
      const name = (JSON.parse(String(options?.body)) as { name: string }).name;
      const token = {
        id: crypto.randomUUID(),
        name,
        createdBy: { id: 'usr00000000000001', name: 'Owner' },
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      };
      state = { ...state, tokens: [token] };
      return json({ ...token, token: secret });
    }
    if (method === 'DELETE' && url.startsWith('/api/admin/scim/tokens/')) {
      state = {
        ...state,
        tokens: state.tokens.map((token) => ({ ...token, revokedAt: new Date().toISOString() })),
      };
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  const rendered = renderSharing(<ScimSettings />);
  return { secret, fetcher, ...rendered };
}

describe('provisioning settings', () => {
  it('shows a new token once without keeping the secret in query or mutation results', async () => {
    const { secret, client } = setup();
    const name = await screen.findByRole('textbox', { name: 'Token name' });
    await userEvent.type(name, 'Identity directory');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByRole('textbox', { name: 'SCIM token' }) as HTMLInputElement).value).toBe(
      secret,
    );
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain(secret);
    expect(
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.data),
      ),
    ).not.toContain(secret);
    await userEvent.click(within(dialog).getByRole('button', { name: 'I saved the token' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByDisplayValue(secret)).toBeNull();
    expect(await screen.findByText('Never used')).toBeDefined();
  });

  it('saves dry run and confirms token revocation in an application dialog', async () => {
    const { fetcher } = setup();
    await userEvent.click(await screen.findByRole('checkbox', { name: /Dry run/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          ([url, options]) =>
            url === '/api/admin/scim' &&
            options?.method === 'PUT' &&
            JSON.parse(String(options.body)).dryRun === true,
        ),
      ).toBe(true),
    );
    await userEvent.type(screen.getByRole('textbox', { name: 'Token name' }), 'Directory');
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }));
    await userEvent.click(await screen.findByRole('button', { name: 'I saved the token' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke this provisioning token?' });
    expect(fetcher.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('Revoked')).toBeDefined();
  });

  it('names each token’s creator and says a token stops when its creator leaves', async () => {
    setup({
      tokens: [
        {
          id: 'first',
          name: 'Entra',
          createdBy: { id: 'usr00000000000002', name: 'Robin Security' },
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          revokedAt: null,
        },
        {
          id: 'second',
          name: 'Okta',
          createdBy: null,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          revokedAt: new Date().toISOString(),
        },
      ],
    });
    expect(await screen.findByText('Created by Robin Security')).toBeDefined();
    expect(screen.getByText('Its creator’s account was removed')).toBeDefined();
    expect(document.body.textContent).toContain(
      'A token stops working when the person who created it is suspended or removed',
    );
  });

  it('lists the members provisioning doesn’t manage', async () => {
    setup({ unmanaged: [{ id: 'usr00000000000003', name: 'Sam Invited', email: 'sam@example.test' }] });
    const section = (await screen.findByRole('heading', { name: 'People outside provisioning' })).closest(
      'section',
    )!;
    expect(within(section).getByText('Sam Invited')).toBeDefined();
    expect(within(section).getByText('sam@example.test')).toBeDefined();
    cleanup();
    setup();
    expect(
      await screen.findByText('Provisioning manages every member except the organization’s owner.'),
    ).toBeDefined();
  });

  it('warns about a verified domain whose daily checks are failing', async () => {
    setup({}, [
      {
        providerId: 'AbCdEfGhIjKlMnOp',
        domain: 'example.test',
        recordName: '_riosoma-sso.example.test',
        recordValue: 'challenge',
        verifiedAt: new Date().toISOString(),
        checkedAt: new Date().toISOString(),
        failedChecks: 2,
      },
    ]);
    expect(await screen.findByText('The last 2 daily checks couldn’t find the record.')).toBeDefined();
  });

  it('refuses a person who lacks the Security role before fetching provisioning data', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    renderSharing(<ScimSettings />, { ...session, membership: { kind: 'member', adminRoles: ['people'] } });
    expect(screen.getByRole('alert').textContent).toContain('Only an administrator');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
