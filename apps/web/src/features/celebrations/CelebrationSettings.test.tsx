import { renderSettings } from '../../screens/settings/testing';
import { json, session } from '../../screens/database/share/testing';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Preferences } from '@riosoma/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CelebrationSettings } from './CelebrationSettings';

const state = vi.hoisted(() => ({ preferences: {} as Preferences, mutate: vi.fn() }));

function setup(preferences: Preferences = {}) {
  state.preferences = preferences;
  state.mutate.mockClear();
  const player = { play: vi.fn(() => true), stop: vi.fn() };
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    const patch = JSON.parse(String(init?.body ?? '{}'));
    state.mutate(patch);
    state.preferences = { ...state.preferences, ...patch };
    return json(state.preferences);
  });
  renderSettings(<CelebrationSettings player={player} />, { ...session, preferences });
  return { player, user: userEvent.setup() };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('celebration and sound settings', () => {
  it('starts with celebrations on and sounds off', () => {
    setup();
    const celebrations = screen.getByRole('radiogroup', { name: 'Celebrations' });
    const sounds = screen.getByRole('radiogroup', { name: 'Sounds' });
    expect(celebrations.querySelector('input:checked')?.getAttribute('value')).toBe('on');
    expect(sounds.querySelector('input:checked')?.getAttribute('value')).toBe('off');
  });

  it('shows what the person saved', () => {
    setup({ celebrations: 'quieter', soundLevel: 'normal' });
    expect(screen.getByRole('radio', { name: /Quieter/ })).toHaveProperty('checked', true);
    expect(screen.getByRole('radio', { name: 'Normal' })).toHaveProperty('checked', true);
  });

  it('saves each choice with the person’s other preferences', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('radio', { name: /Quieter/ }));
    expect(state.mutate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.mutate).toHaveBeenLastCalledWith({ celebrations: 'quieter' }));
    await user.click(screen.getAllByRole('radio', { name: 'Off' })[0]!);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.mutate).toHaveBeenLastCalledWith({ celebrations: 'off' }));
    await user.click(screen.getByRole('radio', { name: 'Quiet' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.mutate).toHaveBeenLastCalledWith({ soundLevel: 'quiet' }));
  });

  it('previews each sound, quietly while sounds are off', async () => {
    const { user, player } = setup();
    for (const name of ['Checked box', 'Small celebration', 'Big celebration', 'Error'])
      await user.click(screen.getByRole('button', { name }));
    expect(player.play.mock.calls).toEqual([
      ['tick', 'quiet'],
      ['chime', 'quiet'],
      ['rise', 'quiet'],
      ['low', 'quiet'],
    ]);
  });

  it('previews at the level the person chose', async () => {
    const { user, player } = setup({ soundLevel: 'normal' });
    await user.click(screen.getByRole('button', { name: 'Small celebration' }));
    expect(player.play).toHaveBeenCalledWith('chime', 'normal');
  });
});
