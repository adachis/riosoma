import { renderSettings as renderSharing } from '../testing';
import type { ReactNode } from 'react';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Member } from '@riosoma/contracts';
import { ToastRegion, toastQueue } from '@riosoma/ui';
import { failure, json, session } from '../../database/share/testing';
import { PeopleSettings } from '../people/PeopleSettings';
import { canResetSecondSteps } from '../people/ResetSecondSteps';
import { SettingsScreen } from '../SettingsScreen';
import { SignInPolicySettings } from './SignInPolicySettings';

vi.mock('../AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('../LanguageSettings', () => ({ LanguageSettings: () => null }));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => undefined,
  useLocation: () => ({ pathname: '/settings/sign-in-policy', href: '/settings/sign-in-policy' }),
  useNavigate: () => vi.fn(),
  useParams: () => ({ section: 'sign-in-policy' }),
  Link: ({ params, children }: { params: { section: string }; children: ReactNode }) => (
    <a href={`/settings/${params.section}`}>{children}</a>
  ),
}));

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/settings/people');
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the sign-in policy', () => {
  it.each([
    { kind: 'owner' as const, adminRoles: [], visible: true },
    { kind: 'member' as const, adminRoles: ['security'], visible: true },
    { kind: 'member' as const, adminRoles: ['people'], visible: false },
    { kind: 'guest' as const, adminRoles: [], visible: false },
  ])('is in the Security area for $kind with $adminRoles', async ({ kind, adminRoles, visible }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ policy: 'off' })),
    );
    renderSharing(<SettingsScreen />, { ...session, membership: { kind, adminRoles } });
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(Boolean(within(nav).queryByRole('link', { name: 'Sign-in policy' }))).toBe(visible);
    if (visible)
      expect(await screen.findByRole('radiogroup', { name: 'Who needs a second step' })).toBeDefined();
    else expect((await screen.findByRole('alert')).textContent).toContain('Only an administrator');
  });

  it('saves who needs a second step', async () => {
    let policy = 'admins';
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') policy = (JSON.parse(String(init.body)) as { policy: string }).policy;
      return json({ policy });
    });
    vi.stubGlobal('fetch', fetcher);
    renderSharing(
      <>
        <SignInPolicySettings />
        <ToastRegion />
      </>,
    );
    const group = await screen.findByRole('radiogroup', { name: 'Who needs a second step' });
    expect(
      (within(group).getByRole('radio', { name: /Owners and admins/ }) as HTMLInputElement).checked,
    ).toBe(true);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled')).toBe(true);
    const user = userEvent.setup();
    await user.click(within(group).getByRole('radio', { name: /Everyone/ }));
    await user.click(save);
    expect(await screen.findByText('Saved the sign-in policy')).toBeDefined();
    expect(fetcher).toHaveBeenCalledWith(
      '/api/admin/mfa/policy',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ policy: 'everyone' }) }),
    );
  });
});

describe('resetting second steps from the People page', () => {
  const members: Member[] = [
    {
      id: 'user_ada',
      name: 'Ada',
      email: 'ada@example.com',
      kind: 'owner',
      adminRoles: [],
      deactivated: false,
    },
    {
      id: 'user_sam',
      name: 'Sam',
      email: 'sam@example.com',
      kind: 'member',
      adminRoles: [],
      deactivated: false,
    },
    {
      id: 'user_kim',
      name: 'Kim',
      email: 'kim@example.com',
      kind: 'owner',
      adminRoles: [],
      deactivated: false,
    },
    {
      id: 'user_lee',
      name: 'Lee',
      email: 'lee@example.com',
      kind: 'guest',
      adminRoles: [],
      deactivated: true,
    },
  ];

  function start(reset: () => Response = () => new Response(null, { status: 204 })) {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/org/members') return json(members);
      if (url === '/api/org/invitations') return json([]);
      if (url === '/api/org/groups' || url === '/api/org/folders' || url === '/api/databases')
        return json([]);
      if (init?.method === 'DELETE' && url.startsWith('/api/admin/mfa/people/')) return reset();
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

  it('offers owners a reset for everyone else who can sign in', async () => {
    const fetcher = start();
    await screen.findByText('Sam');
    const user = userEvent.setup();
    for (const name of ['Ada', 'Lee']) {
      await user.click(screen.getByRole('button', { name: `Actions for ${name}` }));
      expect(screen.queryByRole('menuitem', { name: 'Reset second steps' })).toBeNull();
      await user.keyboard('{Escape}');
    }
    await user.click(screen.getByRole('button', { name: 'Actions for Kim' }));
    expect(await screen.findByRole('menuitem', { name: 'Reset second steps' })).toBeDefined();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Actions for Sam' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Reset second steps' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reset the second steps for Sam?' });
    expect(dialog.textContent).toContain(
      'Their passkeys, authenticator app, and recovery codes stop working.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Reset' }));
    expect(await screen.findByText('Reset the second steps for Sam')).toBeDefined();
    expect(fetcher).toHaveBeenCalledWith(
      '/api/admin/mfa/people/user_sam',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('shows why a reset was refused', async () => {
    start(() => failure('mfa.reset.owner', 403));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Kim' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Reset second steps' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reset the second steps for Kim?' });
    await user.click(within(dialog).getByRole('button', { name: 'Reset' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Only an owner can reset another owner’s second steps.',
    );
  });

  it('leaves the reset to owners and Security admins, and owners to owners', () => {
    const [ada, sam, kim] = members as [Member, Member, Member];
    const security = {
      ...session,
      user: { ...session.user, id: 'user_zed' },
      membership: { kind: 'member' as const, adminRoles: ['people', 'security'] },
    };
    const people = { ...security, membership: { kind: 'member' as const, adminRoles: ['people'] } };
    expect(canResetSecondSteps(security, sam)).toBe(true);
    expect(canResetSecondSteps(security, kim)).toBe(false);
    expect(canResetSecondSteps(people, sam)).toBe(false);
    expect(canResetSecondSteps(session, ada)).toBe(false);
    expect(canResetSecondSteps(null, sam)).toBe(false);
  });
});
