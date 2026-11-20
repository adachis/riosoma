import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { newId } from '@riosoma/contracts';
import { ConfirmProvider, toast, toastQueue } from '@riosoma/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../../data';
import { useSessionEvents } from '../../../data/hooks';
import { FakeServer } from '../../../data/testing';
import type { DatabaseSession, SessionEvent } from '../../../data/types';
import { undoSkipped } from '../../../grid/view/actions';
import { seedTable } from '../../../grid/test-support';
import { i18n } from '../../../i18n';
import { serverMessage } from '../../../messages/useServerMessage';
import { CommandPalette } from '../../../palette/CommandPalette';
import { PaletteSourcesProvider } from '../../../palette/sources';
import { UndoHistoryPanel } from './UndoHistory';
import { UndoHistoryButton } from './UndoHistoryButton';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

const dispose: Array<() => void> = [];
beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
});
afterEach(() => {
  cleanup();
  for (const close of dispose.splice(0)) close();
  for (const shown of toastQueue.visibleToasts) toastQueue.close(shown.key);
  vi.unstubAllGlobals();
});

/** Toasts showing now, oldest first */
const toasts = () => toastQueue.visibleToasts.map((shown) => shown.content.title).reverse();

/** What the database screen does with the session's events, so refusals read as they do there. */
function EventToasts({ session }: { session: DatabaseSession }) {
  useSessionEvents(session, (event: SessionEvent) => {
    if (event.kind === 'rejected')
      toast.show({ title: serverMessage(i18n, event.messageKey, event.params), tone: 'danger' });
    else if (event.kind === 'undoSkipped') undoSkipped(event.skipped, event.pending);
  });
  return null;
}

const statusChoice = newId('choice');

/** A Tasks table with three records, and a session open on it. */
async function setup() {
  const server = new FakeServer();
  const fixture = seedTable(
    server,
    [
      { name: 'Name', type: 'text' },
      {
        name: 'Status',
        type: 'singleSelect',
        options: { choices: [{ id: statusChoice, name: 'Done', color: 'green' }] },
      },
      { name: 'Notes', type: 'text' },
    ],
    3,
    (index, [name]) => ({ [name!]: `Task ${index + 1}` }),
  );
  fixture.database.schema.tables[0]!.name = 'Tasks';
  const [name, status, notes] = fixture.ids as [string, string, string];
  const session = await openDatabase(fixture.databaseId, server.deps());
  dispose.push(() => session.close());
  const tableId = fixture.tableId;
  /** The actions these tests make, each as one person's change */
  const act = {
    cells: () =>
      session.run([
        {
          kind: 'record.update',
          tableId,
          records: [
            { id: fixture.recordId(0), values: { [name]: 'Renamed', [notes]: 'First' } },
            { id: fixture.recordId(1), values: { [notes]: 'Second' } },
          ],
        },
      ]),
    deleteField: () => session.run([{ kind: 'field.trash', fieldId: status }]),
    addRecords: () =>
      session.run([
        {
          kind: 'record.create',
          tableId,
          records: Array.from({ length: 12 }, () => ({ id: newId('record'), values: {} })),
        },
      ]),
  };
  const stored = (index: number, fieldId: string) =>
    fixture.database.rows(tableId).get(fixture.recordId(index))?.values[fieldId] ?? null;
  const undoRequests = () =>
    server.requests
      .filter((request) => /\/(undo|redo)$/.test(request.path))
      .map((request) => ({
        redo: request.path.endsWith('/redo'),
        groupId: (request.options.body as { groupId: string }).groupId,
      }));
  return { server, fixture, session, act, stored, undoRequests, ids: { name, status, notes } };
}

function renderPanel(session: DatabaseSession, children?: ReactNode) {
  const shell = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  return render(
    <I18nProvider i18n={shell}>
      <ConfirmProvider>
        <EventToasts session={session} />
        {children ?? <UndoHistoryPanel session={session} onClose={vi.fn()} />}
      </ConfirmProvider>
    </I18nProvider>,
  );
}

const undoList = () => screen.getByRole('listbox', { name: 'Changes to undo, newest first' });
const redoList = () => screen.queryByRole('listbox', { name: 'Changes to redo, next first' });
const labels = (list: HTMLElement | null) =>
  list
    ? within(list)
        .getAllByRole('option')
        .map((option) => option.querySelector('.rio-listbox-item__label')?.textContent)
    : [];

/** Waits until the server has every change, as undo does before it goes back. */
async function saved(session: DatabaseSession) {
  await waitFor(() => expect(session.saveState().status).toBe('saved'));
}

describe('the undo history', () => {
  it('marks major creations, keeps them when asked, and confirms before moving them to redo', async () => {
    const { session, undoRequests } = await setup();
    const created = session.run([
      {
        kind: 'table.create',
        table: {
          id: newId('table'),
          name: 'Projects',
          fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
          view: { id: newId('view'), name: 'Grid' },
        },
      },
    ]);
    await created.done;
    renderPanel(session);
    const entry = within(undoList()).getByRole('option');
    expect(within(entry).getByText('Asks first')).toBeDefined();
    await userEvent.click(entry);
    await userEvent.click(await screen.findByRole('button', { name: 'Keep it' }));
    expect(undoRequests()).toEqual([]);
    await userEvent.click(entry);
    await userEvent.click(await screen.findByRole('button', { name: 'Move to trash' }));
    await waitFor(() => expect(session.undoHistory().redo[0]?.groupId).toBe(created.groupId));
    expect(within(redoList()!).queryByText('Asks first')).toBeNull();
  });
  it('lists the person’s own changes, newest first and in plain words, with when they were made', async () => {
    const { server, fixture, session, act, ids } = await setup();
    act.cells();
    act.deleteField();
    act.addRecords();
    // Someone else's change is theirs to undo.
    server.remote(fixture.databaseId, [
      {
        kind: 'record.update',
        tableId: fixture.tableId,
        records: [{ id: fixture.recordId(2), values: { [ids.notes]: 'Theirs' } }],
      },
    ]);
    renderPanel(session);
    expect(await screen.findByRole('dialog', { name: 'Undo history' })).toBeDefined();
    expect(labels(undoList())).toEqual([
      'Added 12 records to Tasks',
      'Deleted the Status field',
      'Changed 3 cells in Tasks',
    ]);
    const newest = within(undoList()).getAllByRole('option')[0]!;
    expect(within(newest).getByText('just now')).toBeDefined();
    expect(redoList()).toBeNull();
  });

  it('undoes a change and everything after it, newest first, once asked, and lists them for redo', async () => {
    const { session, act, stored, undoRequests, ids } = await setup();
    const cells = act.cells();
    const field = act.deleteField();
    const records = act.addRecords();
    await saved(session);
    renderPanel(session);
    await userEvent.click(await screen.findByRole('option', { name: /^Changed 3 cells in Tasks(?: |$)/ }));
    const ask = await screen.findByRole('dialog', { name: 'Undo 3 changes?' });
    expect(
      within(ask).getByText('This undoes “Changed 3 cells in Tasks” and the 2 changes you made after it.'),
    ).toBeDefined();
    await userEvent.click(within(ask).getByRole('button', { name: 'Undo 3 changes' }));
    await waitFor(() => expect(redoList()).not.toBeNull());
    await waitFor(() =>
      expect(labels(redoList())).toEqual([
        'Changed 3 cells in Tasks',
        'Deleted the Status field',
        'Added 12 records to Tasks',
      ]),
    );
    expect(undoRequests()).toEqual([
      { redo: false, groupId: records.groupId },
      { redo: false, groupId: field.groupId },
      { redo: false, groupId: cells.groupId },
    ]);
    expect(stored(0, ids.name)).toBe('Task 1');
    expect(stored(0, ids.notes)).toBeNull();
    expect(screen.getByText('Nothing to undo yet.')).toBeDefined();
    await waitFor(() => expect(toasts()).toContain('Undid 3 changes'));

    // Redo puts back as far as the chosen change, in the order they were made.
    await userEvent.click(screen.getByRole('option', { name: /^Deleted the Status field(?: |$)/ }));
    const again = await screen.findByRole('dialog', { name: 'Redo 2 changes?' });
    await userEvent.click(within(again).getByRole('button', { name: 'Redo 2 changes' }));
    await waitFor(() => expect(labels(redoList())).toEqual(['Added 12 records to Tasks']));
    expect(labels(undoList())).toEqual(['Deleted the Status field', 'Changed 3 cells in Tasks']);
    expect(undoRequests().slice(3)).toEqual([
      { redo: true, groupId: cells.groupId },
      { redo: true, groupId: field.groupId },
    ]);
    expect(stored(0, ids.name)).toBe('Renamed');
  });

  it('undoes the newest change without asking, and nothing when the question is turned down', async () => {
    const { session, act, undoRequests } = await setup();
    act.cells();
    act.deleteField();
    await saved(session);
    renderPanel(session);
    await userEvent.click(await screen.findByRole('option', { name: /^Changed 3 cells in Tasks(?: |$)/ }));
    const ask = await screen.findByRole('dialog', { name: 'Undo 2 changes?' });
    await userEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Undo 2 changes?' })).toBeNull());
    expect(undoRequests()).toEqual([]);
    await userEvent.click(screen.getByRole('option', { name: /^Deleted the Status field(?: |$)/ }));
    await waitFor(() => expect(labels(redoList())).toEqual(['Deleted the Status field']));
    expect(screen.queryByRole('dialog', { name: /^Undo \d/ })).toBeNull();
    expect(labels(undoList())).toEqual(['Changed 3 cells in Tasks']);
  });

  it('leaves cells someone else changed since, and says how many, with the usual message', async () => {
    const { server, fixture, session, act, stored, ids } = await setup();
    act.cells();
    await saved(session);
    server.remote(fixture.databaseId, [
      {
        kind: 'record.update',
        tableId: fixture.tableId,
        records: [{ id: fixture.recordId(1), values: { [ids.notes]: 'Theirs' } }],
      },
    ]);
    renderPanel(session);
    await userEvent.click(await screen.findByRole('option', { name: /^Changed 3 cells in Tasks(?: |$)/ }));
    await waitFor(() => expect(labels(redoList())).toEqual(['Changed 3 cells in Tasks']));
    await waitFor(() =>
      expect(toasts()).toContain('1 change was skipped because the data or your permissions changed.'),
    );
    expect(stored(1, ids.notes)).toBe('Theirs');
    expect(stored(0, ids.notes)).toBeNull();
  });

  it('says when calendar events the undo took back are still waiting to be removed', async () => {
    const { server, session, act } = await setup();
    act.cells();
    await saved(session);
    server.pendNextUndo(2);
    renderPanel(session);
    await userEvent.click(await screen.findByRole('option', { name: /^Changed 3 cells in Tasks(?: |$)/ }));
    await waitFor(() => expect(labels(redoList())).toEqual(['Changed 3 cells in Tasks']));
    await waitFor(() =>
      expect(toasts()).toContain('2 calendar events weren’t removed yet.  Riosoma will keep trying.'),
    );
    expect(toasts().some((title) => /skipped/.test(String(title)))).toBe(false);
  });

  it('stops at a change the server refuses to undo, with its message, and leaves the rest', async () => {
    const { server, session, act, undoRequests } = await setup();
    const cells = act.cells();
    const field = act.deleteField();
    const records = act.addRecords();
    await saved(session);
    renderPanel(session);
    server.afterRequest = async (request) => {
      // The second undo, of the deleted field, conflicts with a field made since.
      if (request.path.endsWith('/undo') && undoRequests().length === 1)
        server.refuseNextUndo('data.field.nameTaken');
    };
    await userEvent.click(await screen.findByRole('option', { name: /^Changed 3 cells in Tasks(?: |$)/ }));
    await userEvent.click(
      within(await screen.findByRole('dialog', { name: 'Undo 3 changes?' })).getByRole('button', {
        name: 'Undo 3 changes',
      }),
    );
    await waitFor(() => expect(toasts()).toContain(serverMessage(i18n, 'data.field.nameTaken')));
    await waitFor(() => expect(labels(redoList())).toEqual(['Added 12 records to Tasks']));
    expect(labels(undoList())).toEqual(['Deleted the Status field', 'Changed 3 cells in Tasks']);
    expect(undoRequests().map((request) => request.groupId)).toEqual([records.groupId, field.groupId]);
    expect(undoRequests().map((request) => request.groupId)).not.toContain(cells.groupId);
    expect(toasts()).toContain('Undid 1 change');
  });

  it('opens from its button, from Ctrl+Alt+Z, and from the palette', async () => {
    const { session } = await setup();
    // An open palette lists the person's databases, which this test has none of.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('[]', { headers: { 'content-type': 'application/json' } })),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Screen() {
      const [palette, setPalette] = useState(false);
      return (
        <QueryClientProvider client={client}>
          <PaletteSourcesProvider>
            <UndoHistoryButton session={session} />
            <button type="button" onClick={() => setPalette(true)}>
              test.palette
            </button>
            <CommandPalette
              isOpen={palette}
              onClose={() => setPalette(false)}
              canManagePeople={false}
              canUseTokens
              onOpenHelp={vi.fn()}
              onSignOut={vi.fn()}
            />
          </PaletteSourcesProvider>
        </QueryClientProvider>
      );
    }
    renderPanel(session, <Screen />);
    const close = async () => {
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Undo history' })).toBeNull());
    };
    await userEvent.click(screen.getByRole('button', { name: 'Undo history' }));
    expect(await screen.findByRole('dialog', { name: 'Undo history' })).toBeDefined();
    await close();
    await userEvent.keyboard('{Control>}{Alt>}z{/Alt}{/Control}');
    expect(await screen.findByRole('dialog', { name: 'Undo history' })).toBeDefined();
    await close();
    await userEvent.click(screen.getByRole('button', { name: 'test.palette' }));
    const palette = await screen.findByRole('dialog', { name: 'Search and commands' });
    await userEvent.click(within(palette).getByRole('option', { name: /^Undo history(?: |$)/ }));
    expect(await screen.findByRole('dialog', { name: 'Undo history' })).toBeDefined();
  });
});
