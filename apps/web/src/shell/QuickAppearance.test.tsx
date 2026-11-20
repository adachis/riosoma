import type { ThemeManifest } from '@riosoma/tokens';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { json, renderSharing, session } from '../screens/database/share/testing';
import { themes } from '../preferences';
import { sessionQuery } from '../session';
import { useThemeOverride } from '../features/themes/override';
import { QuickAppearance } from './QuickAppearance';

function manifest(id: string): ThemeManifest {
  return {
    id,
    name: id,
    css: 'theme.css',
    defaultScheme: 'light',
    defaultMode: null,
    schemes: [
      { id: 'light', name: 'Light', appearance: 'light' },
      { id: 'dark', name: 'Dark', appearance: 'dark' },
    ],
    modes: [],
    surfaces: [],
  };
}

function mockThemes() {
  vi.spyOn(themes, 'list').mockResolvedValue(
    ['nature', 'bauhaus'].map((id) => ({
      id,
      name: id,
      css: 'theme.css',
      manifest: 'theme.json',
      defaultScheme: 'light',
      schemeCount: 2,
      modes: [],
    })),
  );
  vi.spyOn(themes, 'manifest').mockImplementation(async (id) => manifest(id));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('applies a quick scheme change optimistically and saves through personal preferences', async () => {
  mockThemes();
  let release!: (value: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const rendered = renderSharing(<QuickAppearance onClose={vi.fn()} />, {
    ...session,
    preferences: { theme: 'nature', scheme: 'light' },
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /Color scheme/ }));
  await user.click(await screen.findByRole('option', { name: 'Dark' }));
  await waitFor(() =>
    expect(rendered.client.getQueryData<typeof session>(sessionQuery.queryKey)?.preferences.scheme).toBe(
      'dark',
    ),
  );
  expect(fetch).toHaveBeenCalledWith('/api/me/preferences', expect.objectContaining({ method: 'PATCH' }));
  release(json({ theme: 'nature', scheme: 'dark' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Color scheme/ }).hasAttribute('disabled')).toBe(false),
  );
});

it('explains a forced theme and keeps personal choices editable', async () => {
  mockThemes();
  function DatabaseAppearance() {
    useThemeOverride({ theme: 'bauhaus', scheme: 'light' });
    return <QuickAppearance onClose={vi.fn()} />;
  }
  renderSharing(<DatabaseAppearance />);
  expect(await screen.findByRole('note')).toHaveProperty(
    'textContent',
    'This database uses a fixed theme.  Your appearance changes apply when you leave it.',
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Theme/ }).hasAttribute('disabled')).toBe(false),
  );
});
