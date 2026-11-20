import { SettingsTestPage } from '../screens/settings/testing';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toastQueue } from '@riosoma/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionQuery } from '../session';
import { FieldTypePicker } from '../screens/database/fields/FieldTypePicker';
import { LevelSettings } from './LevelSettings';
import { personAt, preferencesServer, renderAtLevel } from './testing';
import type { SessionInfo } from '@riosoma/contracts';

afterEach(() => {
  cleanup();
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  vi.unstubAllGlobals();
});

function setup(person: SessionInfo) {
  const server = preferencesServer(person);
  vi.stubGlobal('fetch', vi.fn(server.fetcher));
  return {
    ...renderAtLevel(
      <SettingsTestPage>
        <LevelSettings />
      </SettingsTestPage>,
      person,
    ),
    requests: server.requests,
  };
}

const radios = () =>
  screen.getAllByRole('radio').map((radio) => ({
    value: (radio as HTMLInputElement).value,
    checked: (radio as HTMLInputElement).checked,
  }));

describe('choosing a level', () => {
  it('starts members at Standard and saves a new choice from the page bar', async () => {
    const user = userEvent.setup();
    const { requests, client } = setup(personAt());
    expect(radios()).toEqual([
      { value: 'default', checked: true },
      { value: 'simple', checked: false },
      { value: 'standard', checked: false },
      { value: 'advanced', checked: false },
    ]);
    expect(document.body.textContent).toContain('Currently Standard.');
    await user.click(screen.getByRole('radio', { name: /^Advanced/ }));
    expect(requests.filter((request) => request.method === 'PATCH')).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(requests).toContainEqual({
        url: '/api/me/preferences',
        method: 'PATCH',
        body: { level: 'advanced' },
      }),
    );
    expect(client.getQueryData<SessionInfo>(sessionQuery.queryKey)?.preferences.level).toBe('advanced');
    expect((screen.getByRole('radio', { name: /^Advanced/ }) as HTMLInputElement).checked).toBe(true);
    // Only owners and people admins see the organization's choices.
    expect(screen.queryByRole('heading', { name: 'For the organization' })).toBeNull();
  });

  it('starts members at the organization’s default until they choose', () => {
    setup(personAt({ settings: { defaultLevel: 'simple' } }));
    expect(radios().find((radio) => radio.checked)?.value).toBe('default');
    expect(document.body.textContent).toContain('Currently Simple.');
    cleanup();
    setup(personAt({ settings: { defaultLevel: 'simple' }, level: 'advanced' }));
    expect(radios().find((radio) => radio.checked)?.value).toBe('advanced');
  });

  it('goes back to following the organization’s default, and keeps following it', async () => {
    const user = userEvent.setup();
    const { requests, client } = setup(personAt({ settings: { defaultLevel: 'simple' }, level: 'advanced' }));
    await user.click(screen.getByRole('radio', { name: /^Use the organization default/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(requests).toContainEqual({ url: '/api/me/preferences', method: 'PATCH', body: { level: null } }),
    );
    await waitFor(() =>
      expect(client.getQueryData<SessionInfo>(sessionQuery.queryKey)?.preferences).not.toHaveProperty(
        'level',
      ),
    );
    expect(radios().find((radio) => radio.checked)?.value).toBe('default');
    // Choosing the level the default gives is a choice of its own, which a new default leaves alone.
    await user.click(screen.getByRole('radio', { name: /^Simple/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(requests).toContainEqual({
        url: '/api/me/preferences',
        method: 'PATCH',
        body: { level: 'simple' },
      }),
    );
    expect(radios().find((radio) => radio.checked)?.value).toBe('simple');
  });

  it('starts guests at Simple, and offers them no level above the organization’s limit', () => {
    setup(personAt({ kind: 'guest', settings: { defaultLevel: 'advanced', guestLevel: 'standard' } }));
    expect(radios()).toEqual([
      { value: 'default', checked: true },
      { value: 'simple', checked: false },
      { value: 'standard', checked: false },
    ]);
    expect(document.body.textContent).toContain('Currently Simple.');
    cleanup();
    // A choice made before the limit was lowered is held to it.
    setup(personAt({ kind: 'guest', level: 'advanced', settings: { guestLevel: 'standard' } }));
    expect(radios().find((radio) => radio.checked)?.value).toBe('standard');
  });

  it('tidies a guest’s pickers to the organization’s limit', async () => {
    const guest = personAt({ kind: 'guest', level: 'advanced', settings: { guestLevel: 'simple' } });
    renderAtLevel(<FieldTypePicker value="text" onChange={() => {}} />, guest);
    await userEvent.click(screen.getByRole('button', { name: /Type/ }));
    expect(screen.queryByRole('option', { name: 'Formula' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Checkbox' })).toBeDefined();
  });
});

describe('the organization’s levels', () => {
  it('lets an owner set the default level and the highest level for guests', async () => {
    const user = userEvent.setup();
    const { requests, client } = setup(personAt({ kind: 'owner' }));
    expect(screen.getByRole('heading', { name: 'For the organization' })).toBeDefined();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.hasAttribute('disabled') || save.getAttribute('aria-disabled') === 'true').toBe(true);
    await user.click(screen.getByRole('button', { name: /Default level for members/ }));
    await user.click(screen.getByRole('option', { name: 'Simple' }));
    await user.click(screen.getByRole('button', { name: /Highest level for guests/ }));
    await user.click(screen.getByRole('option', { name: 'Standard' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(requests).toContainEqual({
        url: '/api/admin/levels',
        method: 'PUT',
        body: { defaultLevel: 'simple', guestLevel: 'standard' },
      }),
    );
    await waitFor(() =>
      expect(client.getQueryData<SessionInfo>(sessionQuery.queryKey)?.org.settings).toMatchObject({
        defaultLevel: 'simple',
        guestLevel: 'standard',
      }),
    );
    // The owner hasn't chosen a level of their own, so the new default applies to them too.
    await waitFor(() => expect(document.body.textContent).toContain('Currently Simple.'));
    expect(radios().find((radio) => radio.checked)?.value).toBe('default');
    expect(await screen.findByText('Saved the organization’s levels')).toBeDefined();
  });

  it('lets an admin with the People role set them too', () => {
    setup(personAt({ adminRoles: ['people'] }));
    expect(screen.getByRole('heading', { name: 'For the organization' })).toBeDefined();
  });

  it('edits only the organization’s own levels, whatever applies to the admin in their unit', async () => {
    const user = userEvent.setup();
    const admin: SessionInfo = {
      ...personAt({ adminRoles: ['people'], settings: { defaultLevel: 'standard', guestLevel: 'advanced' } }),
      hasUnits: true,
      effectiveSettings: { defaultLevel: 'advanced', guestLevel: 'simple' },
    };
    const { requests } = setup(admin);
    // The admin's own start follows their unit.
    expect(document.body.textContent).toContain('Currently Advanced.');
    await user.click(screen.getByRole('button', { name: /Default level for members/ }));
    await user.click(screen.getByRole('option', { name: 'Simple' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    // Saving one field leaves the other as the organization had it.
    await waitFor(() =>
      expect(requests).toContainEqual({
        url: '/api/admin/levels',
        method: 'PUT',
        body: { defaultLevel: 'simple', guestLevel: 'advanced' },
      }),
    );
  });

  it('isn’t offered to someone who administers people only in a unit', () => {
    setup({
      ...personAt(),
      hasUnits: true,
      membership: {
        kind: 'member',
        adminRoles: [],
        unitAdminGrants: [{ unitId: 'oun_unit', roles: ['people'] }],
      },
    });
    expect(screen.queryByRole('heading', { name: 'For the organization' })).toBeNull();
  });
});
