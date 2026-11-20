import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { SessionInfo, ThemePick } from '@riosoma/contracts';
import { toast } from '@riosoma/ui';
import type { ThemeIndexEntry, ThemeManifest } from '@riosoma/tokens';
import type { DatabaseSession } from '../../data/types';
import { themes } from '../../preferences';
import { renderSharing, session } from '../../screens/database/share/testing';
import { useAppliedTheme } from '../../shell/useAppliedTheme';
import { DatabaseThemeDialog, useDatabaseTheme } from './DatabaseTheme';
import { themeOverride, useThemeOverride } from './override';

/**
 * A database's forced theme on screen: showing it while the database is open, giving the person's
 * own theme back on leaving, keeping to the organization's list, and the owner's dialog.
 */

const entry = (id: string, name: string, defaultScheme: string): ThemeIndexEntry => ({
  id,
  name,
  css: 'theme.css',
  manifest: 'theme.json',
  defaultScheme,
  schemeCount: 2,
  modes: [],
});
const INDEX = [entry('nature', 'Nature', 'grove'), entry('bauhaus', 'Bauhaus', 'werkbund'), entry('kawaii', 'Kawaii', 'peachy')];
const MANIFESTS: Record<string, ThemeManifest> = {
  nature: manifest('nature', 'Nature', ['grove', 'lagoon']),
  bauhaus: manifest('bauhaus', 'Bauhaus', ['werkbund', 'midnight']),
  kawaii: manifest('kawaii', 'Kawaii', ['peachy', 'bubblegum']),
};

function manifest(id: string, name: string, schemes: string[]): ThemeManifest {
  return {
    id,
    name,
    css: 'theme.css',
    defaultScheme: schemes[0]!,
    schemes: schemes.map((scheme) => ({
      id: scheme,
      name: scheme[0]!.toUpperCase() + scheme.slice(1),
      appearance: 'light' as const,
    })),
    modes: [],
    defaultMode: null,
    surfaces: [],
  };
}

const limited = (allowed: string[]): SessionInfo => ({
  ...session,
  org: { ...session.org, settings: { allowedThemes: allowed } },
});

let apply: MockInstance<typeof themes.apply>;
beforeEach(() => {
  apply = vi.spyOn(themes, 'apply').mockResolvedValue({ theme: 'nature', scheme: 'grove' });
  vi.spyOn(themes, 'list').mockResolvedValue(INDEX);
  vi.spyOn(themes, 'manifest').mockImplementation(async (id) => MANIFESTS[id]!);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The signed-in shell with a database that can open and close, as moving between screens does. */
function Shell({ identity, theme }: { identity: SessionInfo; theme: ThemePick | null }) {
  useAppliedTheme(identity);
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen((value) => !value)}>
        {open ? 'Leave the database' : 'Open the database'}
      </button>
      {open ? <OpenDatabase databaseId="dbs00000000000001" theme={theme} /> : null}
    </>
  );
}

function OpenDatabase({ databaseId, theme }: { databaseId: string; theme: ThemePick | null }) {
  const shown = useDatabaseTheme(databaseId, theme);
  return <main data-database-theme={shown?.id}>Database</main>;
}

describe('a database that forces its theme', () => {
  it('shows its theme while open, never remembers it, and gives the person’s own theme back on leaving', async () => {
    const identity: SessionInfo = { ...session, preferences: { theme: 'kawaii', scheme: 'bubblegum' } };
    renderSharing(<Shell identity={identity} theme={{ id: 'bauhaus', scheme: 'midnight' }} />, identity);
    await waitFor(() =>
      expect(apply).toHaveBeenLastCalledWith(
        { theme: 'bauhaus', scheme: 'midnight', mode: undefined },
        { remember: false },
      ),
    );
    expect(screen.getByRole('main').dataset.databaseTheme).toBe('bauhaus');
    expect(themeOverride()).toEqual({ theme: 'bauhaus', scheme: 'midnight', mode: undefined });

    await userEvent.click(screen.getByRole('button', { name: 'Leave the database' }));
    await waitFor(() =>
      expect(apply).toHaveBeenLastCalledWith({ theme: 'kawaii', scheme: 'bubblegum', mode: undefined }),
    );
    expect(themeOverride()).toBeNull();
  });

  it('keeps the person’s own theme, with a note once, when their organization doesn’t allow the database’s', async () => {
    const note = vi.spyOn(toast, 'show');
    const identity = limited(['nature', 'kawaii']);
    renderSharing(<Shell identity={identity} theme={{ id: 'bauhaus', scheme: 'midnight' }} />, identity);
    await waitFor(() =>
      expect(apply).toHaveBeenLastCalledWith({ theme: 'nature', scheme: 'grove', mode: undefined }),
    );
    expect(apply).not.toHaveBeenCalledWith(expect.objectContaining({ theme: 'bauhaus' }), expect.anything());
    expect(screen.getByRole('main').dataset.databaseTheme).toBeUndefined();
    await waitFor(() => expect(note).toHaveBeenCalledTimes(1));
    expect(note.mock.calls[0]![0]).toMatchObject({ tone: 'info' });

    // Coming back to the same database doesn't say it again.
    await userEvent.click(screen.getByRole('button', { name: 'Leave the database' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open the database' }));
    await act(async () => {});
    expect(note).toHaveBeenCalledTimes(1);
  });

  it('lets the newest screen win and leaves another screen’s theme alone when an older one leaves', () => {
    function Both({ first }: { first: boolean }) {
      return (
        <>
          {first ? <Override choice={{ theme: 'bauhaus', scheme: 'midnight' }} /> : null}
          <Override choice={{ theme: 'kawaii', scheme: 'peachy' }} />
        </>
      );
    }
    function Override({ choice }: { choice: { theme: string; scheme: string } }) {
      useThemeOverride(choice);
      return null;
    }
    const view = renderSharing(<Both first />);
    expect(themeOverride()).toMatchObject({ theme: 'kawaii' });
    view.rerender(<Both first={false} />);
    expect(themeOverride()).toMatchObject({ theme: 'kawaii' });
    view.unmount();
    expect(themeOverride()).toBeNull();
  });
});

async function choose(label: RegExp, option: string) {
  await userEvent.click(screen.getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

describe('the database theme dialog', () => {
  function open(theme: ThemePick | null, identity: SessionInfo = session) {
    const run = vi.fn(() => ({ done: Promise.resolve({ applied: 1, rejected: 0 }) }));
    const onClose = vi.fn();
    renderSharing(
      <DatabaseThemeDialog
        session={{ run } as unknown as DatabaseSession}
        theme={theme}
        onClose={onClose}
      />,
      identity,
    );
    return { run, onClose };
  }

  it('forces a theme at its own default scheme, changes the scheme, and goes back to each person’s own', async () => {
    const { run, onClose } = open(null);
    const dialog = await screen.findByRole('dialog', { name: 'Database theme' });
    expect(within(dialog).getByRole('button', { name: /Theme for everyone/ }).textContent).toContain(
      'Each person’s own theme',
    );
    // No color scheme until there's a theme to have one.
    expect(within(dialog).queryByRole('button', { name: /Color scheme/ })).toBeNull();
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: /Theme for everyone/ })).not.toHaveProperty(
        'disabled',
        true,
      ),
    );
    await choose(/Theme for everyone/, 'Bauhaus');
    expect(run).toHaveBeenLastCalledWith([
      { kind: 'database.update', theme: { id: 'bauhaus', scheme: 'werkbund' } },
    ]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('changes the scheme of the forced theme and stops forcing it', async () => {
    const { run } = open({ id: 'bauhaus', scheme: 'werkbund' });
    await screen.findByRole('button', { name: /Color scheme/ });
    await choose(/Color scheme/, 'Midnight');
    expect(run).toHaveBeenLastCalledWith([
      { kind: 'database.update', theme: { id: 'bauhaus', scheme: 'midnight' } },
    ]);
    await choose(/Theme for everyone/, 'Each person’s own theme');
    expect(run).toHaveBeenLastCalledWith([{ kind: 'database.update', theme: null }]);
  });

  it('offers only the themes the organization allows, and says why a forced one outside them isn’t shown', async () => {
    open({ id: 'bauhaus', scheme: 'midnight' }, limited(['nature', 'kawaii']));
    const note = await screen.findByRole('note');
    expect(note.textContent).toContain('doesn’t allow this theme anymore');
    const trigger = screen.getByRole('button', { name: /Theme for everyone/ });
    expect(trigger.getAttribute('aria-describedby') ?? '').toContain(note.id);
    await userEvent.click(trigger);
    const options = (await screen.findAllByRole('option')).map((option) => option.textContent);
    // The forced theme still shows, so the list says what's picked, but nothing else outside the list.
    expect(options).toEqual(['Each person’s own theme', 'Nature', 'Bauhaus', 'Kawaii']);
    await userEvent.keyboard('{Escape}');
  });
});
