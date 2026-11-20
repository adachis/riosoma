import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AutomationConfig } from '@riosoma/contracts';
import { toastQueue } from '@riosoma/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as DataHooks from '../data/hooks';
import type { DatabaseSession } from '../data/types';
import { databaseFixture, make, mountDatabase, offered } from './database-testing';
import { PLACE_KEYS } from './features';
import { personAt } from './testing';

const holder = vi.hoisted(() => ({ session: null as DatabaseSession | null }));
vi.mock('../data/hooks', async (original) => ({
  ...(await original<typeof DataHooks>()),
  useDatabaseSession: (id: string | null) => (id === holder.session?.databaseId ? holder.session : null),
}));
vi.mock('../grid/GridView', () => ({ GridView: () => <div role="grid" aria-label="Grid" /> }));

const sessions: DatabaseSession[] = [];
afterEach(() => {
  cleanup();
  sessions.splice(0).forEach((session) => session.close());
  holder.session = null;
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** Mounting the whole screen is slow on a busy machine, so these tests get longer than most. */
const SLOW = { timeout: 60_000 };
const read = (text: string) => text.replace(/\s+/g, ' ');

/** A database with an automation, as a person at Simple sees it */
async function fixture() {
  const opened = await databaseFixture(({ database, databaseId, tableId }) => {
    database.schema.automations = [
      make.automation(databaseId, AutomationConfig.parse({ trigger: { kind: 'recordCreated', tableId } })),
    ];
  });
  sessions.push(opened.session);
  return opened;
}

const placesOffered = () =>
  new Set([...offered.rows, ...offered.commands].flatMap((row) => (row.place ? [row.place] : [])));

async function search(query: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Search' }));
  await user.type(await screen.findByRole('searchbox'), query);
  return user;
}

describe('the palette’s registrations', () => {
  it('offer every registered entry, through the screens that own each one, at Simple', SLOW, async () => {
    const seen = new Set<string>();
    const opened = await fixture();
    const person = personAt({ level: 'simple' });
    // A table's grid with a record open: the database, the view, the record card, and the palette.
    mountDatabase(opened, holder, {
      person,
      answers: { sources: true },
      path: `/${opened.databaseId}/${opened.tableId}/${opened.viewId}/${opened.recordId(0)}`,
    });
    await waitFor(() => {
      for (const place of ['databaseSidebar:sql', 'recordMenu:signatures', 'addTable:sync'])
        expect(placesOffered(), place).toContain(place);
    });
    placesOffered().forEach((place) => seen.add(place));
    cleanup();

    // The automation's own screen.
    const automation = opened.session.getSchema().automations[0]!;
    mountDatabase(opened, holder, { person, path: `/${opened.databaseId}/automations/${automation.id}` });
    await screen.findByRole('button', { name: /When/ }, { timeout: 20_000 });
    await waitFor(() => expect(placesOffered()).toContain('triggerPicker:webhook'));
    placesOffered().forEach((place) => seen.add(place));

    expect([...seen].sort()).toEqual([...PLACE_KEYS].sort());
  });

  it('open the database’s webhooks at Simple, with a note offering Advanced', SLOW, async () => {
    const opened = await fixture();
    mountDatabase(opened, holder, { person: personAt({ level: 'simple' }) });
    await screen.findByRole('button', { name: 'Database settings' });
    const user = await search('webhooks');
    const features = within(screen.getByRole('listbox')).getByRole('group', { name: 'Features' });
    await user.click(within(features).getByRole('option', { name: 'Webhooks' }));
    expect(await screen.findByRole('dialog', { name: 'Webhooks' })).toBeDefined();
    expect(
      await screen.findByText(read('This is an Advanced feature.  Show Advanced features?')),
    ).toBeDefined();
  });

  it('import into the open table at Simple', SLOW, async () => {
    const opened = await fixture();
    mountDatabase(opened, holder, { person: personAt({ level: 'simple' }) });
    await screen.findByRole('button', { name: 'More for Tasks' });
    const user = await search('import into');
    await user.click(screen.getByRole('option', { name: /^Import into this table/ }));
    expect(await screen.findByRole('dialog', { name: /Import into Tasks/ })).toBeDefined();
  });

  it('start an automation from a webhook at Standard, which its trigger menu leaves out', SLOW, async () => {
    const opened = await fixture();
    const automation = opened.session.getSchema().automations[0]!;
    mountDatabase(opened, holder, {
      person: personAt({ level: 'standard' }),
      path: `/${opened.databaseId}/automations/${automation.id}`,
    });
    const when = await screen.findByRole('button', { name: /When/ }, { timeout: 20_000 });
    await userEvent.click(when);
    expect(screen.queryByRole('option', { name: 'Another app calls a webhook' })).toBeNull();
    await userEvent.keyboard('{Escape}');
    const user = await search('webhook');
    await user.click(screen.getByRole('option', { name: 'When: Another app calls a webhook' }));
    await waitFor(() => expect(when.textContent).toContain('Another app calls a webhook'));
  });

  it('start a new AI field at Simple', SLOW, async () => {
    const opened = await fixture();
    mountDatabase(opened, holder, { person: personAt({ level: 'simple' }) });
    await screen.findByRole('button', { name: 'Add view' });
    const user = await search('new field ai');
    await user.click(screen.getByRole('option', { name: /^New field: AI/ }));
    const dialog = await screen.findByRole('dialog', { name: /field/i });
    expect(within(dialog).getByRole('button', { name: /Type/ }).textContent).toContain('AI');
  });
});
