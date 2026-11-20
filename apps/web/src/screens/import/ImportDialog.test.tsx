import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import {
  cleanup,
  fireEvent,
  getDefaultNormalizer,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { CommandBatch, DatabaseCreate, newId, type SessionInfo } from '@riosoma/contracts';
import { toast } from '@riosoma/ui';
import { celebrations, type Celebration } from '../../features/celebrations/engine';
import { sessionQuery } from '../../session';
import { setCsrfToken } from '../../api';
import { clientId, IndexedDbOutboxStore, openDatabase } from '../../data';
import { readHistoryStorage } from '../../data/history-storage';
import { FakeServer } from '../../data/testing';
import { ImportDialog } from './ImportDialog';
import { NewDatabaseFromFile } from './NewDatabaseFromFile';

vi.mock('./workerClient', () => import('./testing'));
const databaseId = newId('database');
/** Renders a dialog, with a query client holding the signed-in person when one is given. */
function mount(element: ReactElement, client?: QueryClient) {
  return render(
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      {client ? <QueryClientProvider client={client}>{element}</QueryClientProvider> : element}
    </I18nProvider>,
  );
}
async function upload(text = 'Name,Total,Note\nAda,12,hello\nBea,bad,world') {
  await userEvent.upload(
    screen.getByLabelText('Choose a CSV or Excel file', { selector: 'input' }),
    new File([text], 'data.csv', { type: 'text/csv' }),
  );
  await waitFor(() => expect(screen.getByRole('table', { name: 'Preview' })).toBeDefined());
  await ready();
}
async function ready() {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Import' }).hasAttribute('disabled')).toBe(false),
  );
}
/** A spreadsheet as the server answers it: each sheet's name, its rows, and its counts. */
function workbookLines(sheets: Array<{ name: string; rows: unknown[][]; total?: number }>): string {
  const lines = sheets.flatMap((sheet, position) => [
    { sheet: sheet.name, position },
    ...sheet.rows.map((cells, index) => [index + 1, ...cells]),
    { rows: sheet.rows.length, total: sheet.total ?? sheet.rows.length },
  ]);
  return `${[...lines, { done: true }].map((line) => JSON.stringify(line)).join('\n')}\n`;
}
const BOOK = workbookLines([
  {
    name: 'People',
    rows: [
      ['Name', 'Born'],
      ['Ada', { date: '1990-01-02' }],
    ],
  },
  { name: 'Empty', rows: [] },
  {
    name: 'Orders',
    rows: [
      ['Order', 'Total', 'Paid'],
      ['A-1', 12.5, true],
      ['A-2', 3, false],
    ],
  },
]);
async function uploadWorkbook() {
  await userEvent.upload(
    screen.getByLabelText('Choose a CSV or Excel file', { selector: 'input' }),
    new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'book.xlsx'),
  );
  await waitFor(() => expect(screen.getByRole('table', { name: 'Preview' })).toBeDefined());
  await ready();
}
function mockServer(workbook: () => Response = () => new Response(BOOK)) {
  const batches: CommandBatch[] = [];
  const fetch = vi.fn(async (path: string, init: RequestInit) => {
    if (path === '/api/imports/spreadsheet') return workbook();
    if (path === '/api/databases') return new Response('{}');
    if (path === '/api/auth/session') return new Response(JSON.stringify({ user: { id: newId('user') } }));
    if (path.includes('/undo-preview/')) return new Response(JSON.stringify({ creations: [] }));
    if (path.endsWith('/undo')) return new Response(JSON.stringify({ status: 'applied', skipped: 0 }));
    const batch = CommandBatch.parse(JSON.parse(String(init.body)));
    batches.push(batch);
    return new Response(
      JSON.stringify({ results: batch.commands.map((command) => ({ id: command.id, status: 'applied' })) }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, batches };
}
afterEach(() => {
  cleanup();
  setCsrfToken(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function syntheticSession() {
  const server = new FakeServer();
  const fixture = server.createDatabase(0);
  setCsrfToken(server.csrf);
  const deps = server.deps({ clientId: clientId() });
  const original = await openDatabase(fixture.databaseId, deps);
  vi.spyOn(IndexedDbOutboxStore.prototype, 'load').mockImplementation(server.outbox.load.bind(server.outbox));
  vi.stubGlobal(
    'WebSocket',
    vi.fn(function () {
      return server.webSocketFactory('');
    }),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (path: string, init: RequestInit = {}) =>
        new Response(
          JSON.stringify(
            await server.http(path, {
              method: init.method as 'GET' | 'POST',
              ...(init.body ? { body: JSON.parse(String(init.body)) } : {}),
            }),
          ),
        ),
    ),
  );
  return { server, fixture, deps, original };
}

describe('import dialog', () => {
  it('registers a newly imported table in session history and uses session Undo', async () => {
    const { server, fixture, original } = await syntheticSession();
    const adopt = vi.spyOn(original, 'adoptAction');
    const undo = vi.spyOn(original, 'undo');
    const notices = vi.spyOn(toast, 'show');
    try {
      mount(
        <ImportDialog
          databaseId={fixture.databaseId}
          session={original}
          onClose={vi.fn()}
          onDone={vi.fn()}
        />,
      );
      await upload('Name\nSynthetic');
      await userEvent.click(screen.getByRole('button', { name: 'Import' }));
      await waitFor(() => expect(notices).toHaveBeenCalled());
      const groupId = original.undoHistory().undo[0]!.groupId;
      expect(adopt).toHaveBeenCalledWith(groupId, { kind: 'table.create', name: 'data', count: 1 });
      expect(await server.http(`/api/databases/${fixture.databaseId}/undo-preview/${groupId}`)).toMatchObject(
        { creations: [{ kind: 'table', name: 'data', records: 1 }] },
      );
      notices.mock.calls.at(-1)![0].action!.onPress();
      await waitFor(() => expect(undo).toHaveBeenCalledWith(groupId));
      await userEvent.click(await screen.findByRole('button', { name: 'Move to trash' }));
      await waitFor(() => expect(original.undoHistory().redo[0]?.groupId).toBe(groupId));
      expect(server.database(fixture.databaseId).schema.tables.map((table) => table.name)).not.toContain(
        'data',
      );
    } finally {
      original.close();
    }
  });
  it.each(['closed', 'reopened'])(
    'undoes an import through its originating database after navigation with a %s session',
    async (state) => {
      const { server, fixture, deps, original } = await syntheticSession();
      let reopened: Awaited<ReturnType<typeof openDatabase>> | undefined;
      const notices = vi.spyOn(toast, 'show');
      try {
        const dialog = mount(
          <ImportDialog
            databaseId={fixture.databaseId}
            session={original}
            onClose={vi.fn()}
            onDone={vi.fn()}
          />,
        );
        await upload('Name\nSynthetic');
        await userEvent.click(screen.getByRole('button', { name: 'Import' }));
        await waitFor(() => expect(notices).toHaveBeenCalled());
        const action = notices.mock.calls.at(-1)![0].action!;
        const groupId = original.undoHistory().undo[0]!.groupId;
        dialog.unmount();
        original.close();
        if (state === 'reopened') reopened = await openDatabase(fixture.databaseId, deps);
        const schemas = server.requests.filter(({ path }) => path.endsWith('/schema')).length;
        action.onPress();
        await userEvent.click(await screen.findByRole('button', { name: 'Move to trash' }));
        await waitFor(() =>
          expect(
            server.requests.some(({ path }) => path === `/api/databases/${fixture.databaseId}/undo`),
          ).toBe(true),
        );
        await waitFor(() =>
          expect(readHistoryStorage(server.userId, fixture.databaseId, clientId()).redo[0]?.groupId).toBe(
            groupId,
          ),
        );
        expect(readHistoryStorage(server.userId, fixture.databaseId, clientId()).undo).toEqual([]);
        expect(server.database(fixture.databaseId).schema.tables.map((table) => table.name)).not.toContain(
          'data',
        );
        if (reopened) {
          expect(reopened.undoHistory().redo[0]?.groupId).toBe(groupId);
          expect(server.requests.filter(({ path }) => path.endsWith('/schema'))).toHaveLength(schemas);
          expect(await reopened.redo()).toEqual({ nothing: false, skipped: 0 });
          expect(server.database(fixture.databaseId).schema.tables.map((table) => table.name)).toContain(
            'data',
          );
        }
      } finally {
        original.close();
        reopened?.close();
      }
    },
  );
  it('reports when notification Undo changes nothing', async () => {
    const { fetch } = mockServer();
    const answer = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (path, init) =>
      path.endsWith('/undo')
        ? new Response(JSON.stringify({ status: 'nothing', skipped: 0 }))
        : answer(path, init),
    );
    const notices = vi.spyOn(toast, 'show');
    mount(<ImportDialog databaseId={databaseId} onClose={vi.fn()} onDone={vi.fn()} />);
    await upload('Name\nSynthetic');
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(notices).toHaveBeenCalled());
    const action = notices.mock.calls.at(-1)![0].action!;
    action.onPress();
    await waitFor(() =>
      expect(notices).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'The import could not be undone.' }),
      ),
    );
    expect(fetch).toHaveBeenCalled();
  });
  it('edits names and types, skips columns, changes the primary, and counts all misfits', async () => {
    const { batches } = mockServer();
    const onDone = vi.fn();
    const notices = vi.spyOn(toast, 'show');
    mount(<ImportDialog databaseId={databaseId} onClose={vi.fn()} onDone={onDone} />);
    await upload();
    const headers = screen.getAllByRole('columnheader');
    const name = within(headers[0]!).getByRole('textbox', { name: 'Field name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Person');
    await userEvent.click(within(headers[1]!).getByRole('button', { name: /Type/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Number' }));
    await waitFor(() => expect(screen.getByText('1 value won’t fit and will be left empty.')).toBeDefined());
    await userEvent.click(within(headers[2]!).getByRole('checkbox', { name: 'Import Note' }));
    await userEvent.click(screen.getByRole('button', { name: /Primary field/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Total' }));
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    const commands = batches.flatMap((batch) => batch.commands);
    const table = commands.find((command) => command.kind === 'table.create')!.table;
    expect(table.fields.map((field) => field.name)).toEqual(['Total', 'Person']);
    const records = commands.find((command) => command.kind === 'record.create')!.records;
    expect(records).toHaveLength(2);
    expect(records[1]!.values[table.fields[0]!.id]).toBeUndefined();
    expect(notices).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Imported 2 records.', description: '1 value was left empty.' }),
    );
    const action = notices.mock.calls.at(-1)![0].action!;
    action.onPress();
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(`/api/databases/${databaseId}/undo`, expect.anything()),
    );
  });
  it('rebuilds preview and generated names when the header is turned off', async () => {
    mockServer();
    mount(<ImportDialog databaseId={databaseId} onClose={vi.fn()} onDone={vi.fn()} />);
    await upload('A,B\nC,D');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Use the first row as field names' }));
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('textbox', { name: 'Field name' })
          .map((input) => (input as HTMLInputElement).value),
      ).toEqual(['Field 1', 'Field 2']),
    );
    expect(screen.getByRole('cell', { name: 'A' })).toBeDefined();
  });
  it('creates and opens a new database from a file', async () => {
    const { fetch } = mockServer();
    const onDone = vi.fn();
    mount(<NewDatabaseFromFile onClose={vi.fn()} onDone={onDone} />);
    expect(screen.getByRole('dialog', { name: 'New database from a CSV or Excel file' })).toBeDefined();
    await upload('Name\nAda');
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(fetch.mock.calls[0]![0]).toBe('/api/databases');
    const body = JSON.parse(String(fetch.mock.calls[0]![1].body)) as {
      id: string;
      table: { fields: unknown[] };
    };
    expect(onDone).toHaveBeenCalledWith(body.id);
    expect(body.table.fields).toHaveLength(1);
  });
  it('keeps the dialog open on rejection and explains the translated reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        const batch = CommandBatch.parse(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({
            results: batch.commands.map((command) => ({
              id: command.id,
              status: 'rejected',
              error: { code: 'forbidden', messageKey: 'data.access.denied', userFault: true },
            })),
          }),
        );
      }),
    );
    const onDone = vi.fn();
    mount(<ImportDialog databaseId={databaseId} onClose={vi.fn()} onDone={onDone} />);
    await upload('Name\nAda');
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('The import stopped: You don’t have access'),
    );
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Import' }).hasAttribute('disabled')).toBe(true);
  });
  it('waits for the active request when canceled and keeps a single Undo action', async () => {
    let release: (() => void) | undefined;
    const requests: CommandBatch[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        const batch = CommandBatch.parse(JSON.parse(String(init.body)));
        requests.push(batch);
        if (batch.commands[0]?.kind === 'record.create')
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return new Response(
          JSON.stringify({
            results: batch.commands.map((command) => ({ id: command.id, status: 'applied' })),
          }),
        );
      }),
    );
    const onClose = vi.fn();
    const onDone = vi.fn();
    const notices = vi.spyOn(toast, 'show');
    mount(<ImportDialog databaseId={databaseId} onClose={onClose} onDone={onDone} />);
    await upload('Name\n' + Array.from({ length: 2500 }, (_, i) => `Person ${i}`).join('\n'));
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(release).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
    release!();
    await waitFor(() =>
      expect(notices).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Imported 1,000 records.',
          action: expect.objectContaining({ label: 'Undo' }),
        }),
      ),
    );
    expect(requests).toHaveLength(2);
    expect(onDone).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('offers Undo for the applied portion when a later command is rejected', async () => {
    const requests: CommandBatch[] = [];
    const notices = vi.spyOn(toast, 'show');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_path: string, init: RequestInit) => {
        const batch = CommandBatch.parse(JSON.parse(String(init.body)));
        requests.push(batch);
        return new Response(
          JSON.stringify({
            results: batch.commands.map((command) => ({
              id: command.id,
              status: requests.length === 1 ? 'applied' : 'rejected',
              ...(requests.length === 1
                ? {}
                : { error: { code: 'forbidden', messageKey: 'data.access.denied', userFault: true } }),
            })),
          }),
        );
      }),
    );
    mount(<ImportDialog databaseId={databaseId} onClose={vi.fn()} onDone={vi.fn()} />);
    await upload('Name\nAda');
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(notices).toHaveBeenCalledWith(
      expect.objectContaining({ tone: 'danger', action: expect.objectContaining({ label: 'Undo' }) }),
    );
  });
  it('accepts file drops and reports unreadable CSV', async () => {
    mockServer();
    mount(<ImportDialog databaseId={databaseId} onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.drop(screen.getByText('Drop a CSV or Excel file here'), {
      dataTransfer: { files: [new File(['"broken'], 'broken.csv')] },
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This file couldn’t be read.'));
  });
  it('labels every input, traps keyboard focus, and allows keyboard editing and dismissal', async () => {
    mockServer();
    const onClose = vi.fn();
    mount(<ImportDialog databaseId={databaseId} onClose={onClose} onDone={vi.fn()} />);
    await upload('Name,Total\nAda,12');
    const dialog = screen.getByRole('dialog', { name: 'Import data.csv' });
    const field = screen.getAllByRole('textbox', { name: 'Field name' })[0]!;
    field.focus();
    await userEvent.keyboard('{Control>}a{/Control}Person');
    expect((field as HTMLInputElement).value).toBe('Person');
    const type = within(screen.getAllByRole('columnheader')[0]!).getByRole('button', { name: /Type/ });
    type.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('listbox')).toBeDefined();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(type));
    for (let i = 0; i < 20; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    screen.getByRole('button', { name: 'Help with Import data.csv' }).focus();
    await screen.findByRole('tooltip');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('importing a spreadsheet', () => {
  it('picks a sheet, keeping its numbers and true or false as they are', async () => {
    const { batches, fetch } = mockServer();
    const onDone = vi.fn();
    mount(<ImportDialog databaseId={databaseId} onClose={vi.fn()} onDone={onDone} />);
    await uploadWorkbook();
    const upload = fetch.mock.calls.find(([path]) => path === '/api/imports/spreadsheet')!;
    expect(upload[1]).toMatchObject({ method: 'POST', body: expect.any(File) });
    expect(screen.getByRole('cell', { name: 'Ada' })).toBeDefined();
    // An empty sheet has nothing to import, so it isn't offered.
    await userEvent.click(screen.getByRole('button', { name: /Sheet/ }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['People', 'Orders']);
    await userEvent.click(screen.getByRole('option', { name: 'Orders' }));
    await waitFor(() => expect(screen.getByRole('cell', { name: 'A-1' })).toBeDefined());
    await ready();
    const headers = screen.getAllByRole('columnheader');
    expect(within(headers[1]!).getByRole('button', { name: /Type/ }).textContent).toContain('Number');
    expect(within(headers[2]!).getByRole('button', { name: /Type/ }).textContent).toContain('Checkbox');
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    const commands = batches.flatMap((batch) => batch.commands);
    const table = commands.find((command) => command.kind === 'table.create')!.table;
    expect(table.name).toBe('Orders');
    const records = commands.find((command) => command.kind === 'record.create')!.records;
    expect(records.map((record) => record.values[table.fields[1]!.id])).toEqual([12.5, 3]);
    expect(records.map((record) => record.values[table.fields[2]!.id])).toEqual([true, false]);
  });

  it('starts a database with every sheet as a table of its own, in one action', async () => {
    const { batches, fetch } = mockServer();
    const onDone = vi.fn();
    mount(<NewDatabaseFromFile onClose={vi.fn()} onDone={onDone} />);
    await uploadWorkbook();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Import every sheet as its own table' }));
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    const request = fetch.mock.calls.find(([path]) => path === '/api/databases')!;
    const created = DatabaseCreate.parse(JSON.parse(String(request[1].body)));
    expect(onDone).toHaveBeenCalledWith(created.id);
    expect(created.name).toBe('book');
    expect(created.table.name).toBe('People');
    expect(created.table.fields.map((field) => [field.name, field.type])).toEqual([
      ['Name', 'text'],
      ['Born', 'date'],
    ]);
    const commands = batches.flatMap((batch) => batch.commands);
    expect(commands.map((command) => command.kind)).toEqual([
      'record.create',
      'table.create',
      'record.create',
    ]);
    expect(new Set(commands.map((command) => command.groupId)).size).toBe(1);
    const people = commands[0]!.kind === 'record.create' ? commands[0]!.records : [];
    expect(people.map((record) => record.values[created.table.fields[1]!.id])).toEqual(['1990-01-02']);
    const orders = commands[1]!.kind === 'table.create' ? commands[1]!.table : undefined;
    expect(orders?.name).toBe('Orders');
  });

  it('says when a sheet has more rows than can be imported', async () => {
    mockServer(
      () =>
        new Response(workbookLines([{ name: 'Big', rows: [['Name'], ['Ada'], ['Bea']], total: 250_000 }])),
    );
    mount(<ImportDialog databaseId={databaseId} onClose={vi.fn()} onDone={vi.fn()} />);
    await uploadWorkbook();
    expect(
      screen.getByText('Big has 250,000 rows.  Only the first 3 can be imported.', {
        normalizer: getDefaultNormalizer({ collapseWhitespace: false }),
      }),
    ).toBeDefined();
  });

  it('explains a spreadsheet the server can’t read', async () => {
    mockServer(
      () =>
        new Response(
          JSON.stringify({
            error: { code: 'validation_failed', messageKey: 'import.spreadsheet.legacy', userFault: true },
          }),
          { status: 422 },
        ),
    );
    mount(<ImportDialog databaseId={databaseId} onClose={vi.fn()} onDone={vi.fn()} />);
    await userEvent.upload(
      screen.getByLabelText('Choose a CSV or Excel file', { selector: 'input' }),
      new File(['old'], 'old.xls'),
    );
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'This is an older Excel file, or one with a password.  Save it as an .xlsx file without a password and try again.',
      ),
    );
    expect(screen.queryByRole('table', { name: 'Preview' })).toBeNull();
  });
});

describe('celebrating an import', () => {
  let shown: Celebration[] = [];
  let stop: () => void = () => undefined;
  beforeEach(() => {
    localStorage.clear();
    shown = [];
    stop = celebrations.subscribe((celebration) => shown.push(celebration));
  });
  afterEach(() => {
    stop();
    localStorage.clear();
  });

  function signedIn() {
    const client = new QueryClient();
    client.setQueryData(sessionQuery.queryKey, { user: { id: 'user-one' }, preferences: {} } as SessionInfo);
    return client;
  }
  async function importNow(onDone: ReturnType<typeof vi.fn>) {
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  }
  const sawNoTables = () =>
    celebrations.observe('firstTable', { userId: 'user-one', level: 'on', key: 'you', reached: false });

  it('celebrates an import that comes in clean, and not a second one straight after', async () => {
    const { batches } = mockServer();
    const client = signedIn();
    const outcomes = vi.spyOn(celebrations, 'celebrate');
    const tables = () =>
      batches
        .flatMap((batch) => batch.commands)
        .flatMap((command) => (command.kind === 'table.create' ? [command.table.id] : []));
    const onDone = vi.fn();
    mount(<ImportDialog databaseId={databaseId} onClose={vi.fn()} onDone={onDone} />, client);
    await upload('Name,Total\nAda,12\nBea,13');
    await importNow(onDone);
    expect(shown.map((celebration) => [celebration.name, celebration.key])).toEqual([
      ['importClean', tables()[0]],
    ]);

    cleanup();
    const again = vi.fn();
    mount(<ImportDialog databaseId={databaseId} onClose={vi.fn()} onDone={again} />, client);
    await upload('Name,Total\nCy,14');
    await importNow(again);
    expect(tables()).toHaveLength(2);
    expect(shown).toHaveLength(1);
    // The quiet between celebrations holds the second one back.
    expect(outcomes.mock.results.map((result) => result.value)).toEqual(['shown', 'limited']);
  });

  it('doesn’t celebrate an import that leaves values empty', async () => {
    mockServer();
    const outcomes = vi.spyOn(celebrations, 'celebrate');
    const onDone = vi.fn();
    mount(<ImportDialog databaseId={databaseId} onClose={vi.fn()} onDone={onDone} />, signedIn());
    await upload('Name,Total\nAda,12\nBea,bad');
    await userEvent.click(
      within(screen.getAllByRole('columnheader')[1]!).getByRole('button', { name: /Type/ }),
    );
    await userEvent.click(screen.getByRole('option', { name: 'Number' }));
    await waitFor(() => expect(screen.getByText('1 value won’t fit and will be left empty.')).toBeDefined());
    await ready();
    await importNow(onDone);
    expect(shown).toEqual([]);
    expect(outcomes).not.toHaveBeenCalled();
  });

  it('doesn’t count a table added to a database that already exists as the person’s first', async () => {
    mockServer();
    sawNoTables();
    const onDone = vi.fn();
    mount(<ImportDialog databaseId={databaseId} onClose={vi.fn()} onDone={onDone} />, signedIn());
    await upload('Name\nAda');
    await importNow(onDone);
    expect(shown.map((celebration) => celebration.name)).toEqual(['importClean']);
  });

  it('celebrates a new database’s first table when this device saw the person with none', async () => {
    mockServer();
    sawNoTables();
    const onDone = vi.fn();
    mount(<NewDatabaseFromFile onClose={vi.fn()} onDone={onDone} />, signedIn());
    await upload('Name\nAda');
    await importNow(onDone);
    // The first table is a large celebration, and the quiet after it holds back the clean import’s small one.
    expect(shown.map((celebration) => [celebration.name, celebration.key, celebration.cause])).toEqual([
      ['firstTable', 'you', 'you'],
    ]);
  });

  it('doesn’t celebrate a first table for someone this device never saw without one', async () => {
    const { fetch } = mockServer();
    const onDone = vi.fn();
    mount(<NewDatabaseFromFile onClose={vi.fn()} onDone={onDone} />, signedIn());
    await upload('Name\nAda');
    await importNow(onDone);
    const request = fetch.mock.calls.find(([path]) => path === '/api/databases')!;
    const created = DatabaseCreate.parse(JSON.parse(String(request[1].body)));
    expect(shown.map((celebration) => [celebration.name, celebration.key])).toEqual([
      ['importClean', created.table.id],
    ]);
  });
});
