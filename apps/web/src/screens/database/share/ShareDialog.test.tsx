import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Grant, Member, Principal, SetGrant, SharingInvitations } from '@riosoma/contracts';
import { ShareDialog } from './ShareDialog';
import { failure, json, renderSharing } from './testing';

const ada = { kind: 'user' as const, id: 'ada', name: 'Ada', email: 'ada@example.com' };
const sam = { kind: 'user' as const, id: 'sam', name: 'Sam', email: 'sam@example.com' };
const members: Member[] = [ada, sam].map((person) => ({
  ...person,
  kind: 'member',
  adminRoles: [],
  deactivated: false,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function start(canManage = true, invitationPolicy: Partial<SharingInvitations> = {}) {
  let grants: Grant[] = [{ principal: ada, role: 'owner' }];
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/org/members') return json(members);
    if (url.endsWith('/invitations'))
      return json({
        allowed: true,
        administratorsOnly: false,
        domains: [],
        kind: 'guest',
        mailAvailable: true,
        pending: [],
        ...invitationPolicy,
      });
    if (url !== '/api/databases/db_test/grants') throw new Error(`Unexpected request: ${url}`);
    if (options?.method === 'PUT' || options?.method === 'DELETE') {
      const body = JSON.parse(options.body as string) as SetGrant;
      const same = (principal: Principal) =>
        principal.kind === body.principal.kind &&
        (principal.kind === 'org' || (body.principal.kind === 'user' && principal.id === body.principal.id));
      grants = grants.filter((grant) => !same(grant.principal));
      if (options.method === 'PUT') {
        const principal =
          body.principal.kind === 'org'
            ? { kind: 'org' as const, name: 'Garden' }
            : body.principal.id === ada.id
              ? ada
              : sam;
        grants.push({ principal, role: body.role });
      }
      return new Response(null, { status: 204 });
    }
    return json(grants);
  });
  vi.stubGlobal('fetch', fetcher);
  const onClose = vi.fn();
  renderSharing(
    <ShareDialog databaseId="db_test" databaseName="Projects" canManage={canManage} onClose={onClose} />,
  );
  return { fetcher, onClose };
}

async function choose(label: RegExp, role: string) {
  await userEvent.click(screen.getByRole('button', { name: label }));
  await userEvent.click(
    screen.getByRole('option', {
      name: (accessibleName) => accessibleName === role || accessibleName.startsWith(`${role} `),
    }),
  );
}

describe('ShareDialog', () => {
  it.each([{ domains: [] }, { domains: ['allowed.test'] }])(
    'explains disabled sharing before administrator and domain restrictions: %j',
    async ({ domains }) => {
      start(true, { allowed: false, administratorsOnly: true, refusal: 'membersOnly', domains });
      const input = await screen.findByRole('combobox', { name: 'Add people' });
      await waitFor(() => expect(input.hasAttribute('disabled')).toBe(false));
      await userEvent.type(input, 'new@example.test');
      expect(await screen.findByText(/Sharing is limited to members\./)).toBeDefined();
      expect(screen.queryByText('Sharing with new people is limited to People administrators.')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Invite and share' })).toBeNull();
    },
  );

  it('labels inherited grants whose folder is private without exposing a name or controls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json([
          {
            principal: ada,
            role: 'owner',
            inheritedFrom: { kind: 'folder' },
          },
        ]),
      ),
    );
    renderSharing(
      <ShareDialog databaseId="db_test" databaseName="Projects" canManage={false} onClose={vi.fn()} />,
    );
    expect(await screen.findByText("From a folder you can't see")).toBeDefined();
    expect(screen.queryByRole('button', { name: /Ada/ })).toBeNull();
    await userEvent.keyboard('{Escape}');
  });

  it('shows access a folder gives as read-only, naming the folder', async () => {
    const inherited: Grant = {
      principal: { kind: 'group', id: 'grp_ops', name: 'Operators' },
      role: 'editor',
      inheritedFrom: { kind: 'folder', id: 'fol_quarterly', name: 'Quarterly' },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        json(url === '/api/databases/db_test/grants' ? [{ principal: ada, role: 'owner' }, inherited] : []),
      ),
    );
    renderSharing(<ShareDialog databaseId="db_test" databaseName="Projects" canManage onClose={vi.fn()} />);
    expect(await screen.findByText('From the folder Quarterly')).toBeDefined();
    expect(screen.getByText('Operators')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Operators/ })).toBeNull();
  });

  it('lists grants and adds a person by searching email and selecting with the keyboard', async () => {
    const { fetcher } = start();
    expect(await screen.findByRole('dialog', { name: 'Share Projects' })).toBeDefined();
    await screen.findByRole('img', { name: 'A: Ada' });
    expect(screen.getByText('ada@example.com')).toBeDefined();
    const input = screen.getByRole('combobox', { name: 'Add people' });
    await waitFor(() => expect(input.hasAttribute('disabled')).toBe(false));
    await userEvent.type(input, 'sam@');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(document.activeElement).toBe(input);
    await userEvent.keyboard('{ArrowDown}');
    expect(input.getAttribute('aria-activedescendant')).toBeTruthy();
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('img', { name: 'S: Sam' });
    const saved = fetcher.mock.calls.find(([, options]) => options?.method === 'PUT');
    expect(JSON.parse(saved?.[1]?.body as string)).toEqual({
      principal: { kind: 'user', id: 'sam' },
      role: 'editor',
    });
    expect((input as HTMLInputElement).value).toBe('');
    await userEvent.type(input, 'Sam');
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('shows role descriptions and saves a person’s new role', async () => {
    const { fetcher } = start();
    await screen.findByText('ada@example.com');
    await userEvent.click(screen.getByRole('button', { name: /Ada \(ada@example.com\)/ }));
    for (const description of [
      'Can do everything, including sharing and deleting',
      'Can change tables, fields, and views',
      'Can add and change records',
      'Can view and comment',
      'Can view',
    ])
      expect(screen.getByText(description, { exact: true })).toBeDefined();
    await userEvent.click(screen.getByRole('option', { name: /^Creator(?: |$)/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Ada \(ada@example.com\)/ }).textContent).toContain(
        'Creator',
      ),
    );
    const saved = fetcher.mock.calls.find(([, options]) => options?.method === 'PUT');
    expect(JSON.parse(saved?.[1]?.body as string)).toEqual({
      principal: { kind: 'user', id: 'ada' },
      role: 'creator',
    });
  });

  it('sets and clears access for everyone and never offers organization Owner', async () => {
    const { fetcher } = start();
    await screen.findByText('ada@example.com');
    await userEvent.click(screen.getByRole('button', { name: /Everyone in Garden/ }));
    expect(screen.queryByRole('option', { name: /^Owner(?: |$)/ })).toBeNull();
    await userEvent.click(screen.getByRole('option', { name: /^Reader(?: |$)/ }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Everyone in Garden/ }).textContent).toContain('Reader'),
    );
    await choose(/Everyone in Garden/, 'No access');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Everyone in Garden/ }).textContent).toContain('No access'),
    );
    const changes = fetcher.mock.calls
      .filter(([, options]) => options?.method !== 'GET')
      .map(([, options]) => ({ method: options?.method, body: JSON.parse(options?.body as string) }));
    expect(changes).toEqual([
      { method: 'PUT', body: { principal: { kind: 'org' }, role: 'reader' } },
      { method: 'DELETE', body: { principal: { kind: 'org' } } },
    ]);
  });

  it('removes a person', async () => {
    const { fetcher } = start();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Ada' }));
    await waitFor(() => expect(screen.queryByText('ada@example.com')).toBeNull());
    const removed = fetcher.mock.calls.find(([, options]) => options?.method === 'DELETE');
    expect(JSON.parse(removed?.[1]?.body as string)).toEqual({ principal: { kind: 'user', id: 'ada' } });
  });

  it('shows server failures and preserves the saved grant', async () => {
    const { fetcher } = start();
    await screen.findByText('ada@example.com');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Add people' }).hasAttribute('disabled')).toBe(false),
    );
    fetcher.mockResolvedValueOnce(failure('errors.adminOnly', 403));
    await choose(/Ada \(ada@example.com\)/, 'Reader');
    expect((await screen.findByRole('alert')).textContent).toContain('Only an administrator can do that.');
    expect(screen.getByRole('button', { name: /Ada \(ada@example.com\)/ }).textContent).toContain('Owner');
  });

  it('keeps demo refusals from leaving a blank danger banner when a sharing control is used', async () => {
    const { fetcher } = start();
    await screen.findByText('ada@example.com');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Add people' }).hasAttribute('disabled')).toBe(false),
    );
    fetcher.mockResolvedValueOnce(failure('demo.readOnly', 403));
    await choose(/Ada \(ada@example.com\)/, 'Reader');
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(true),
    );
    expect(document.querySelector('.rio-banner[data-variant="danger"]')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: /Ada \(ada@example.com\)/ }).textContent).toContain('Owner');
  });

  it('is read-only without management permission and closes with Escape', async () => {
    const { fetcher, onClose } = start(false);
    await screen.findByText('ada@example.com');
    expect(screen.getByText('Owner')).toBeDefined();
    expect(screen.getByText('No access')).toBeDefined();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove|Everyone in|Ada/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDefined();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/databases/db_test/grants']);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});
