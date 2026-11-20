import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfileSettings } from './ProfileSettings';
import { renderSettings } from '../testing';
import { json, session } from '../../database/share/testing';
import type { PersonalProfile } from '@riosoma/contracts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/settings/profile');
});
const initial: PersonalProfile = {
  name: 'Ada',
  email: session.user.email,
  pictureUrl: null,
  managedFields: [],
  emailChangeAllowed: true,
  revision: '1'.repeat(64),
};
function start(managed = false) {
  let profile = {
    ...initial,
    ...(managed
      ? {
          managedFields: ['name', 'email', 'picture'] as PersonalProfile['managedFields'],
          emailChangeAllowed: false,
        }
      : {}),
  };
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/me/profile' && options?.method === 'PATCH') {
      const body = JSON.parse(String(options.body)) as { name?: string };
      profile = { ...profile, name: body.name ?? profile.name, revision: '2'.repeat(64) };
      return json({ eventId: '1', undoable: false, profile });
    }
    if (url === '/api/me/profile') return json(profile);
    if (url === '/api/auth/session')
      return json({ ...session, user: { ...session.user, name: profile.name } });
    if (url === '/api/me/profile/email') return json({ eventId: '2', undoable: false });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  renderSettings(<ProfileSettings />);
  return fetcher;
}

describe('personal profile settings', () => {
  it('discards and saves the display name through the shared bar and keeps email read-only', async () => {
    const fetcher = start();
    const user = userEvent.setup();
    const name = await screen.findByRole('textbox', { name: 'Display name' });
    const bar = screen.getByRole('region', { name: 'Save changes' });
    expect(screen.getByRole('textbox', { name: 'Email address' }).getAttribute('readonly')).toBe('');
    await user.clear(name);
    await user.type(name, 'New name');
    await user.click(within(bar).getByRole('button', { name: 'Discard' }));
    expect((name as HTMLInputElement).value).toBe('Ada');
    await user.clear(name);
    await user.type(name, 'New name');
    await user.click(within(bar).getByRole('button', { name: 'Save' }));
    expect(await within(bar).findByText('No unsaved changes')).toBeDefined();
    expect(fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH')?.[1]?.body).toBe(
      JSON.stringify({ revision: initial.revision, name: 'New name' }),
    );
  });

  it('explains managed fields and disables their controls', async () => {
    start(true);
    const name = await screen.findByRole('textbox', { name: 'Display name' });
    expect((name as HTMLInputElement).disabled).toBe(true);
    expect(screen.getAllByText('Your organization manages this field.')).toHaveLength(3);
    expect(
      (screen.getByRole('button', { name: 'Upload a profile picture' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Change email address' })).toBeNull();
  });

  it('requests an email link from a deep-linked review dialog without changing the saved address', async () => {
    window.history.replaceState({}, '', '/settings/profile?edit=email');
    const fetcher = start();
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'Change email address' });
    await user.type(within(dialog).getByRole('textbox', { name: 'New email address' }), 'new@example.test');
    await user.click(within(dialog).getByRole('button', { name: 'Send confirmation link' }));
    expect(await within(dialog).findByRole('status')).toHaveProperty(
      'textContent',
      'Check your new address for the confirmation link.',
    );
    expect(
      (screen.getByRole('textbox', { name: 'Email address', hidden: true }) as HTMLInputElement).value,
    ).toBe(initial.email);
    expect(fetcher.mock.calls.find(([url]) => url === '/api/me/profile/email')?.[1]?.body).toBe(
      JSON.stringify({ email: 'new@example.test' }),
    );
  });
});
