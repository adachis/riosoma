import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionInfo } from '@riosoma/contracts';
import { toastQueue } from '@riosoma/ui';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from '../palette/CommandPalette';
import { PaletteSourcesProvider } from '../palette/sources';
import { HomeScreen } from '../screens/HomeScreen';
import { LevelSuggestion } from './LevelSuggestion';
import { personAt, preferencesServer, renderAtLevel } from './testing';
import { recordUse } from './uses';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: '/' }),
  useNavigate: () => navigate,
  useSearch: () => ({}),
}));

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Text as the page reads it: queries fold the two spaces after a sentence into one. */
const read = (text: string) => text.replace(/\s+/g, ' ');
const NOTE = read('This is an Advanced feature.  Show Advanced features?');
const SUGGESTION = read(
  'You’ve opened Advanced features several times this week.  Show them in your menus too?',
);

function Shell({ onOpenHelp }: { onOpenHelp(topic?: string): void }) {
  const [open, setOpen] = useState(false);
  return (
    <PaletteSourcesProvider>
      <LevelSuggestion />
      <button type="button" onClick={() => setOpen(true)}>
        Search
      </button>
      <CommandPalette
        isOpen={open}
        onClose={() => setOpen(false)}
        canManagePeople={false}
        canUseTokens
        onOpenHelp={onOpenHelp}
        onSignOut={() => {}}
      />
    </PaletteSourcesProvider>
  );
}

function setup(person: SessionInfo = personAt({ level: 'simple' })) {
  const server = preferencesServer(person);
  vi.stubGlobal('fetch', vi.fn(server.fetcher));
  const onOpenHelp = vi.fn();
  const view = renderAtLevel(<Shell onOpenHelp={onOpenHelp} />, person);
  const saves = () =>
    server.requests.filter((request) => request.url === '/api/me/preferences').map((request) => request.body);
  return { ...view, onOpenHelp, saves };
}

async function search(user: ReturnType<typeof userEvent.setup>, query: string) {
  await user.click(screen.getByRole('button', { name: 'Search' }));
  await user.type(await screen.findByRole('searchbox'), query);
}

/** The palette's own REST API command, an Advanced feature that no menu offers. */
async function openApi(user: ReturnType<typeof userEvent.setup>) {
  await search(user, 'rest api');
  await user.click(screen.getByRole('option', { name: 'Use the REST API' }));
}

describe('the palette and experience levels', () => {
  it('finds a feature Simple tidies away, and opens it with a note offering its level', async () => {
    const user = userEvent.setup();
    const { onOpenHelp, saves } = setup();
    await user.click(screen.getByRole('button', { name: 'Search' }));
    // Features wait for a query, so the first list stays short.
    expect(screen.queryByRole('option', { name: 'Use the REST API' })).toBeNull();
    await user.type(screen.getByRole('searchbox'), 'rest api');
    const features = within(screen.getByRole('listbox')).getByRole('group', { name: 'Features' });
    await user.click(within(features).getByRole('option', { name: 'Use the REST API' }));
    expect(onOpenHelp).toHaveBeenCalledExactlyOnceWith('rest-api');
    const note = await screen.findByText(NOTE);
    expect(note).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Show them' }));
    await waitFor(() => expect(saves()).toEqual([{ level: 'advanced' }]));
    // At Advanced the same feature opens without a word.
    await openApi(user);
    expect(onOpenHelp).toHaveBeenCalledTimes(2);
    expect(screen.queryAllByText(NOTE)).toHaveLength(0);
  });

  it('names the level of a Standard feature', async () => {
    const user = userEvent.setup();
    setup();
    await search(user, 'csv');
    await user.click(screen.getByRole('option', { name: 'New database from a CSV or Excel file' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/', search: { new: 'import' } });
    expect(
      await screen.findByText(read('This is a Standard feature.  Show Standard features?')),
    ).toBeDefined();
  });

  it('says nothing about a feature at the person’s level', async () => {
    const user = userEvent.setup();
    const { onOpenHelp } = setup(personAt({ level: 'advanced' }));
    await openApi(user);
    expect(onOpenHelp).toHaveBeenCalledOnce();
    expect(screen.queryByText(NOTE)).toBeNull();
  });

  it('opens a feature above a guest’s limit without offering a level they can’t have', async () => {
    const user = userEvent.setup();
    const { onOpenHelp } = setup(personAt({ kind: 'guest', settings: { guestLevel: 'simple' } }));
    await openApi(user);
    expect(onOpenHelp).toHaveBeenCalledOnce();
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(screen.queryByText(SUGGESTION)).toBeNull();
  });
});

describe('the suggestion to move up', () => {
  it('comes after the third use in a week, and never again once dismissed', async () => {
    const user = userEvent.setup();
    const { saves, unmount } = setup();
    await openApi(user);
    await openApi(user);
    expect(screen.queryByText(SUGGESTION)).toBeNull();
    await openApi(user);
    expect(await screen.findByText(SUGGESTION)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Show Advanced features' })).toBeDefined();

    const banner = screen.getByText(SUGGESTION).closest<HTMLElement>('.rio-level-suggestion')!;
    await user.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(SUGGESTION)).toBeNull();
    await waitFor(() => expect(saves()).toContainEqual({ levelSuggestion: 'dismissed' }));
    // More uses bring nothing back, in this visit or the next.
    for (let use = 0; use < 3; use += 1) await openApi(user);
    expect(screen.queryByText(SUGGESTION)).toBeNull();
    unmount();
    cleanup();
    setup(personAt({ level: 'simple', preferences: { levelSuggestion: 'dismissed' } }));
    expect(screen.queryByText(SUGGESTION)).toBeNull();
  });

  it('moves the person up when they take it', async () => {
    const now = Date.now();
    for (const hoursAgo of [1, 5, 30]) recordUse('usr_level_person', 'advanced', now - hoursAgo * 3_600_000);
    const user = userEvent.setup();
    const { saves } = setup();
    await user.click(await screen.findByRole('button', { name: 'Show Advanced features' }));
    await waitFor(() => expect(saves()).toEqual([{ level: 'advanced' }]));
    await waitFor(() => expect(screen.queryByText(SUGGESTION)).toBeNull());
  });

  it('shows on the home screen, which leaves imports out at Simple', async () => {
    const now = Date.now();
    for (const hoursAgo of [1, 2, 3]) recordUse('usr_level_person', 'advanced', now - hoursAgo * 3_600_000);
    const person = personAt({ level: 'simple' });
    vi.stubGlobal('fetch', vi.fn(preferencesServer(person).fetcher));
    renderAtLevel(<HomeScreen />, person);
    expect(await screen.findByText(SUGGESTION)).toBeDefined();
    await screen.findByRole('heading', { name: 'Databases' });
    expect(screen.getAllByRole('button', { name: 'New database' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'New database from a CSV or Excel file' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import from Airtable' })).toBeNull();
    act(() => undefined);
  });
});
