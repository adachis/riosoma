import { renderSettings as renderSharing } from '../testing';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { CredentialCommand, CredentialStatus } from '@riosoma/contracts';
import { json } from '../../database/share/testing';
import { CredentialSettings } from './CredentialSettings';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('previews a move, confirms it, and exposes interrupted work for resumption', async () => {
  const commands: CredentialCommand[] = [];
  let status: CredentialStatus = {
    profile: 'database',
    keyId: 'instance',
    revision: 0,
    cacheSeconds: 300,
    failedProfiles: [],
    jobs: [],
    profiles: [{ id: 'primary', kind: 'vault', wrapping: true }],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/preview')) return json({ count: 2, profile: 'primary', revision: 0 });
      if (init?.method === 'POST') {
        const command = JSON.parse(String(init.body)) as CredentialCommand;
        commands.push(command);
        status = {
          ...status,
          profile: 'primary',
          revision: 1,
          jobs: [
            { id: command.id, kind: 'move', state: 'failed', processed: 1, error: 'credentials.unavailable' },
          ],
        };
      }
      return json(status);
    }),
  );
  renderSharing(<CredentialSettings />);
  const user = userEvent.setup();
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Credential storage' }), 'primary');
  await user.click(screen.getByRole('button', { name: 'Preview move' }));
  const dialog = await screen.findByRole('dialog', { name: 'Move credentials?' });
  expect(commands).toHaveLength(0);
  expect(dialog.textContent).toContain('2 credentials');
  await user.click(within(dialog).getByRole('button', { name: 'Move credentials' }));
  expect(commands).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Processed 1 credentials')).toBeDefined();
  expect(commands[0]).toMatchObject({ kind: 'move', profile: 'primary', revision: 0 });
  await user.click(screen.getByRole('button', { name: 'Resume' }));
  expect(commands[1]).toMatchObject({ kind: 'resume', jobId: commands[0]!.id });
});
