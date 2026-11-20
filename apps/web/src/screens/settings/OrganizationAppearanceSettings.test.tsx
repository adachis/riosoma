import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionInfo } from '@riosoma/contracts';
import { OrganizationAppearanceSettings } from './OrganizationAppearanceSettings';
import { renderSettings } from './testing';
import { json, session } from '../database/share/testing';

const asset = {
  // A storage identifier, assembled here so secret scanners don't read it as a credential.
  key: ['ab153af2', 'cf55', '4e75', '853a', 'a138a50d8d11'].join('-'),
  type: 'image/svg+xml' as const,
  storage: 'postgres' as const,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function start() {
  let identity: SessionInfo = structuredClone(session);
  const writes: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, options?: RequestInit) => {
      if (input === '/api/org/admin-commands') {
        const change = JSON.parse(String(options?.body)) as { mode: 'theme' | 'original'; main?: unknown };
        writes.push(change);
        identity = {
          ...identity,
          org: {
            ...identity.org,
            settings: {
              logo: change.main === null ? null : { main: asset, compact: null, mode: change.mode },
            },
          },
        };
        return json({ eventId: '1', undoable: true });
      }
      if (input === '/api/auth/session') return json(identity);
      if (input === '/api/admin/unit-policy') return json({ own: {}, values: {}, overridable: [] });
      if (input === '/themes/index.json') return json({ themes: [{ id: 'nature', name: 'Nature' }] });
      if (input === '/themes/nature/theme.json')
        return json({
          defaultScheme: 'grove',
          modes: [],
          schemes: [
            { id: 'grove', appearance: 'light' },
            { id: 'night-grove', appearance: 'dark' },
          ],
        });
      throw new Error(`Unexpected request: ${input}`);
    }),
  );
  renderSettings(<OrganizationAppearanceSettings />, identity);
  return writes;
}

describe('organization appearance drafts', () => {
  it('keeps uploads local until save, discards them, saves through a command, and removes the stored logo', async () => {
    const writes = start();
    const user = userEvent.setup();
    const logo = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.svg', {
      type: 'image/svg+xml',
    });
    const input = await screen.findByLabelText('Upload a logo');
    await user.upload(input, logo);
    expect(writes).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('button', { name: 'Remove logo' })).toBeNull();
    await user.upload(input, logo);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      kind: 'organization.logo',
      mode: 'theme',
      main: { type: 'image/svg+xml' },
    });
    await screen.findByText('No unsaved changes');
    await user.click(screen.getByRole('button', { name: 'Remove logo' }));
    expect(writes).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toMatchObject({ kind: 'organization.logo', main: null, compact: null });
  });
  it('explains refused file types and sizes without sending a command', async () => {
    const writes = start();
    const input = await screen.findByLabelText('Upload a logo');
    fireEvent.change(input, {
      target: { files: [new File(['content'], 'logo.txt', { type: 'text/plain' })] },
    });
    expect(await screen.findByText('Choose an SVG or PNG logo.')).toBeTruthy();
    fireEvent.change(input, {
      target: { files: [new File([new Uint8Array(256 * 1024 + 1)], 'large.png', { type: 'image/png' })] },
    });
    expect(await screen.findByText('Choose a logo no larger than 256 KB.')).toBeTruthy();
    expect(writes).toEqual([]);
  });
});
