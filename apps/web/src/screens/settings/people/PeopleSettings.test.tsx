import type { ReactNode } from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { avatarInitials, ToastRegion, toastQueue } from '@riosoma/ui';
import type { Invitation, Member } from '@riosoma/contracts';
import { SettingsScreen } from '../SettingsScreen';
import { canManagePeople, PeopleSettings } from './PeopleSettings';
import { failure, json, renderSharing, session } from '../../database/share/testing';

vi.mock('../AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('../LanguageSettings', () => ({ LanguageSettings: () => null }));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => undefined,
  useLocation: () => ({ pathname: '/settings/people', href: '/settings/people' }),
  useNavigate: () => vi.fn(),
  useParams: () => ({ section: 'people' }),
  Link: ({ params, children }: { params: { section: string }; children: ReactNode }) => (
    <a href={`/settings/${params.section}`}>{children}</a>
  ),
}));

const members: Member[] = [
  { id: 'ada', name: 'Ada', email: 'ada@example.com', kind: 'owner', adminRoles: [], deactivated: false },
  { id: 'sam', name: 'Sam', email: 'sam@example.com', kind: 'member', adminRoles: [], deactivated: false },
  { id: 'lee', name: 'Lee', email: 'lee@example.com', kind: 'guest', adminRoles: [], deactivated: true },
];
const invitation: Invitation = {
  id: 'invite_one',
  email: 'new@example.com',
  kind: 'member',
  invitedBy: 'Ada',
  createdAt: '2026-09-27T12:00:00Z',
  expiresAt: '2026-10-04T12:00:00Z',
};

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/settings/people');
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function start(pending: Invitation[] = [], people: Member[] = members, ready = Promise.resolve()) {
  let invitations = pending;
  let listed = people;
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    await ready;
    if (options?.method === 'DELETE' && url.startsWith('/api/org/members/')) {
      const id = decodeURIComponent(url.slice('/api/org/members/'.length));
      listed = listed.filter((member) => member.id !== id);
      return new Response(null, { status: 204 });
    }
    if (options?.method === 'POST') {
      invitations = [invitation];
      return json({ invited: invitations, alreadyMembers: ['ada@example.com'] });
    }
    if (options?.method === 'DELETE') {
      invitations = [];
      return new Response(null, { status: 204 });
    }
    if (url === '/api/org/members') return json(listed);
    if (url === '/api/org/invitations') return json(invitations);
    if (url === '/api/org/groups' || url === '/api/org/folders' || url === '/api/databases') return json([]);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  renderSharing(
    <>
      <PeopleSettings />
      <ToastRegion />
    </>,
  );
  return fetcher;
}

describe('PeopleSettings', () => {
  it('shows a named loading state until the initial form data is ready', async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    start([], members, ready);
    try {
      expect(screen.getByRole('progressbar', { name: 'Loading people' })).toBeDefined();
      expect(screen.queryByRole('textbox', { name: 'Email addresses' })).toBeNull();
    } finally {
      release();
    }
    await screen.findByRole('textbox', { name: 'Email addresses' });
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('ada@example.com')).toBeDefined();
  });

  it.each([
    { kind: 'owner' as const, adminRoles: [], visible: true },
    { kind: 'member' as const, adminRoles: ['people'], visible: true },
    { kind: 'member' as const, adminRoles: ['security'], visible: false },
    { kind: 'guest' as const, adminRoles: [], visible: false },
  ])('gates the People navigation for $kind with $adminRoles', async ({ kind, adminRoles, visible }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json([])),
    );
    renderSharing(<SettingsScreen />, { ...session, membership: { kind, adminRoles } });
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const link = within(nav).queryByRole('link', { name: 'People' });
    expect(Boolean(link)).toBe(visible);
    if (visible) {
      expect(link?.getAttribute('href')).toBe('/settings/people');
      await screen.findByText('No one is waiting to join.');
    } else expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('lists identities, membership kinds, and deactivation', async () => {
    start();
    await screen.findByText('ada@example.com');
    for (const member of members)
      expect(
        screen.getByRole('img', {
          name: `${avatarInitials(member.name, 'en-US')}: ${member.deactivated ? `${member.name} (deactivated)` : member.name}`,
        }),
      ).toBeDefined();
    expect(within(screen.getByText('ada@example.com').closest('li')!).getByText('Owner')).toBeDefined();
    expect(screen.getAllByText('Deactivated').length).toBeGreaterThan(0);
    expect(screen.getByText('No one is waiting to join.')).toBeDefined();
  });

  it('counts invalid addresses as typed and enforces the batch limit', async () => {
    start();
    const user = userEvent.setup();
    const input = await screen.findByRole('textbox', { name: 'Email addresses' });
    await user.type(input, 'good@example.com, broken wrong');
    expect(screen.getByText('2 addresses aren’t valid.')).toBeDefined();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('button', { name: 'Invite' }).hasAttribute('disabled')).toBe(true);
    await user.clear(input);
    await user.type(input, 'broken');
    expect(screen.getByText('1 address isn’t valid.')).toBeDefined();
    await user.clear(input);
    await user.click(input);
    await user.paste(Array.from({ length: 51 }, (_, index) => `person${index}@example.com`).join(' '));
    expect(screen.getByText('Invite up to 50 people at a time.')).toBeDefined();
  });

  it('normalizes and deduplicates addresses, invites guests, and toasts skipped members', async () => {
    const fetcher = start();
    const user = userEvent.setup();
    await user.type(
      await screen.findByRole('textbox', { name: 'Email addresses' }),
      ' NEW@example.com, ada@example.com\nnew@example.com ',
    );
    screen.getByRole('button', { name: /Invite as/ }).focus();
    await user.keyboard('{Enter}');
    (await screen.findByRole('listbox')).focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    await screen.findByText('Invited 1 person');
    expect(screen.getByText('Already members: ada@example.com')).toBeDefined();
    const request = fetcher.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(JSON.parse(request?.[1]?.body as string)).toEqual({
      emails: ['new@example.com', 'ada@example.com'],
      kind: 'guest',
    });
    expect((screen.getByRole('textbox', { name: 'Email addresses' }) as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByText('new@example.com')).toBeDefined();
  });

  it('revokes only after confirmation and supports canceling', async () => {
    const fetcher = start([invitation]);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Revoke the invitation to new@example.com?' }),
    );
    let dialog = screen.getByRole('dialog', { name: 'Revoke the invitation to new@example.com?' });
    expect(within(dialog).getByText('The link in their email stops working.')).toBeDefined();
    expect(fetcher.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Revoke the invitation to new@example.com?' }));
    dialog = screen.getByRole('dialog');
    within(dialog).getByRole('button', { name: 'Revoke' }).focus();
    await user.keyboard('{Enter}');
    await screen.findByText('No one is waiting to join.');
    expect(fetcher.mock.calls.find(([, options]) => options?.method === 'DELETE')?.[0]).toBe(
      '/api/org/invitations/invite_one',
    );
  });

  it('keeps a failed revocation open and displays the server message', async () => {
    const fetcher = start([invitation]);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Revoke the invitation to new@example.com?' }),
    );
    fetcher.mockResolvedValueOnce(failure('errors.adminOnly', 403));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Only an administrator can do that.');
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('preserves an invitation draft after a server error', async () => {
    const fetcher = start();
    await screen.findByText('ada@example.com');
    await userEvent.type(screen.getByRole('textbox', { name: 'Email addresses' }), 'new@example.com');
    fetcher.mockResolvedValueOnce(failure('errors.adminOnly', 403));
    await userEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Only an administrator can do that.');
    expect((screen.getByRole('textbox', { name: 'Email addresses' }) as HTMLTextAreaElement).value).toBe(
      'new@example.com',
    );
  });

  it('removes a deactivated managed account only after confirming', async () => {
    const managed: Member[] = [
      ...members,
      {
        id: 'kim',
        name: 'Kim',
        email: 'kim@example.com',
        kind: 'member',
        adminRoles: [],
        deactivated: true,
        managed: 'scim',
        profile: { userName: 'kim@example.com' },
      },
      {
        id: 'pat',
        name: 'Pat',
        email: 'pat@example.com',
        kind: 'member',
        adminRoles: [],
        deactivated: false,
        managed: 'scim',
      },
    ];
    const fetcher = start([], managed);
    const user = userEvent.setup();
    for (const name of ['Ada', 'Lee', 'Pat']) {
      await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
      expect(screen.queryByRole('menuitem', { name: /^Remove account(?: |$)/ })).toBeNull();
      await user.keyboard('{Escape}');
    }
    await user.click(screen.getByRole('button', { name: 'Actions for Kim' }));
    await user.click(await screen.findByRole('menuitem', { name: /^Remove account(?: |$)/ }));
    const dialog = screen.getByRole('dialog', { name: 'Remove the account for Kim?' });
    expect(dialog.textContent).toContain('This can’t be undone.');
    expect(dialog.textContent).toContain('each database only they own goes to the organization’s owner');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(fetcher.mock.calls.some(([url]) => String(url).startsWith('/api/org/members/'))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Actions for Kim' }));
    await user.click(await screen.findByRole('menuitem', { name: /^Remove account(?: |$)/ }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove account' }));
    await screen.findByText('Removed the account for Kim');
    await waitFor(() => expect(screen.queryByRole('img', { name: 'K: Kim (deactivated)' })).toBeNull());
    expect(
      fetcher.mock.calls.find(
        ([url, options]) => options?.method === 'DELETE' && url === '/api/org/members/kim',
      ),
    ).toBeDefined();
  });

  it('keeps a refused removal open and says why', async () => {
    const fetcher = start(
      [],
      [
        ...members,
        {
          id: 'kim',
          name: 'Kim',
          email: 'kim@example.com',
          kind: 'member',
          adminRoles: [],
          deactivated: true,
          managed: 'scim',
        },
      ],
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for Kim' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /^Remove account(?: |$)/ }));
    fetcher.mockResolvedValueOnce(failure('people.remove.active', 409));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove account' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Only a deactivated account can be removed.',
    );
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('permits People administrators and denies direct access to ordinary members', async () => {
    expect(canManagePeople(session)).toBe(true);
    expect(canManagePeople({ ...session, membership: { kind: 'member', adminRoles: ['people'] } })).toBe(
      true,
    );
    expect(canManagePeople(null)).toBe(false);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    renderSharing(<PeopleSettings />, {
      ...session,
      membership: { kind: 'member', adminRoles: ['security'] },
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Only an administrator'));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
