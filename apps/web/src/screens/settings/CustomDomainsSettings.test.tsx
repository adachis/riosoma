import { renderSettings as renderSharing } from './testing';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CustomDomain } from '@riosoma/contracts';
import { json, session } from '../database/share/testing';
import { CustomDomainsSettings } from './CustomDomainsSettings';

const PATH = '/api/admin/custom-domains';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('custom domain settings', () => {
  it('adds all page kinds, displays DNS records, verifies, and confirms removal', async () => {
    let domains: CustomDomain[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === PATH && init?.method === 'POST') {
        const input = JSON.parse(String(init.body)) as { host: string; kinds: CustomDomain['kinds'] };
        domains = [
          {
            id: 'domain',
            ...input,
            checkedAt: null,
            verifiedAt: null,
            recordName: `_riosoma-public.${input.host}`,
            recordValue: ['challenge', 'value'].join('-'),
            target: 'app.example.test',
            targetType: 'CNAME',
          },
        ];
        return json(domains[0]);
      }
      if (url.endsWith('/verify')) {
        domains = domains.map((domain) => ({ ...domain, verifiedAt: new Date().toISOString() }));
        return json(domains[0]);
      }
      if (init?.method === 'DELETE') {
        domains = [];
        return new Response(null, { status: 204 });
      }
      return json(domains);
    });
    vi.stubGlobal('fetch', fetcher);
    renderSharing(<CustomDomainsSettings />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Host name' }), 'forms.example.test');
    await user.click(screen.getByRole('button', { name: 'Add domain' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      ((await screen.findByRole('textbox', { name: 'TXT record name' })) as HTMLInputElement).value,
    ).toBe('_riosoma-public.forms.example.test');
    expect((screen.getByRole('textbox', { name: 'Routing record target' }) as HTMLInputElement).value).toBe(
      'app.example.test',
    );
    // Sites stay off until someone turns them on, since a site takes the whole domain.
    expect(domains[0]?.kinds).toEqual(['forms', 'views', 'bookings', 'signing']);
    expect((screen.getAllByRole('checkbox', { name: 'Sites' })[0] as HTMLInputElement).checked).toBe(false);
    const save = screen.getByRole('button', { name: /^Save$/ });
    const forms = screen.getAllByRole('checkbox', { name: 'Forms' });
    for (const checkbox of forms) {
      await user.click(checkbox);
      expect(save).toHaveProperty('disabled', false);
      await user.click(checkbox);
      expect(save).toHaveProperty('disabled', true);
    }
    await user.click(screen.getByRole('button', { name: 'Verify domain' }));
    expect(await screen.findByText('Verified')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Remove domain' }));
    expect(domains).toHaveLength(1);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove domain' }));
    await waitFor(() => expect(domains).toHaveLength(0));
  });

  it('refuses settings to a member without the Integrations role', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    renderSharing(<CustomDomainsSettings />, {
      ...session,
      membership: { kind: 'member', adminRoles: ['security'] },
    });
    expect((await screen.findByRole('alert')).textContent).toContain('Only an administrator');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
