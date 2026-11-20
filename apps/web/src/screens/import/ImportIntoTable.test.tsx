import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, getDefaultNormalizer, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CommandBatch,
  IMPORT_RECORDS_PAGE,
  ImportRecordsRequest,
  newId,
  type Command,
  type FieldMeta,
  type ImportRecordsPage,
  type RowData,
  type SessionInfo,
} from '@riosoma/contracts';
import { ApiError } from '../../api';
import type { DatabaseSession } from '../../data';
import { openDatabase } from '../../data/session';
import { FakeServer, type FakeFixture } from '../../data/testing';
import { celebrations, type Celebration } from '../../features/celebrations/engine';
import { sessionQuery } from '../../session';
import { ImportIntoTable } from './ImportIntoTable';

vi.mock('./workerClient', () => import('./testing'));

const sessions: DatabaseSession[] = [];
afterEach(() => {
  cleanup();
  for (const session of sessions.splice(0)) session.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const exact = { normalizer: getDefaultNormalizer({ collapseWhitespace: false }) };
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** The records endpoint an import matches against, answered from the fake server's rows. */
function importRecords(server: FakeServer, tableId: string, body: unknown): ImportRecordsPage {
  const request = ImportRecordsRequest.parse(body);
  const database = [...server.databases.values()].find((item) => item.records.has(tableId))!;
  const rows = database.rows(tableId);
  const order = rows.order();
  const ids = request.recordIds ?? Array.from({ length: order.total }, (_, index) => order.idAt(index)!);
  const start = Number(request.after ?? 0);
  const page = request.recordIds ? ids : ids.slice(start, start + IMPORT_RECORDS_PAGE);
  return {
    records: page.flatMap((id) => {
      const row = rows.get(id);
      return row
        ? [
            {
              id,
              values: Object.fromEntries(
                request.fieldIds.map((fieldId) => [fieldId, row.values[fieldId] ?? null]),
              ),
            },
          ]
        : [];
    }),
    next:
      !request.recordIds && start + IMPORT_RECORDS_PAGE < ids.length
        ? String(start + IMPORT_RECORDS_PAGE)
        : null,
  };
}

/** Sends the page's requests to the fake server, as the browser would send them to the real one. */
function connect(server: FakeServer, workbook?: () => Response) {
  const fetch = vi.fn(async (path: string, init: RequestInit = {}) => {
    if (path === '/api/imports/spreadsheet') return workbook ? workbook() : json({}, 404);
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const parts = new URL(path, 'http://localhost').pathname.split('/').filter(Boolean);
    try {
      if (parts[1] === 'tables' && parts[3] === 'import') return json(importRecords(server, parts[2]!, body));
      const method = (init.method ?? 'GET') as 'GET' | 'POST';
      return json(await server.http(path, { method, ...(body === undefined ? {} : { body }) }));
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.info }, error.status || 500);
      throw error;
    }
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

interface Setup {
  server: FakeServer;
  fixture: FakeFixture;
  session: DatabaseSession;
  onClose: ReturnType<typeof vi.fn>;
  rows(): RowData[];
  commands(): Command[];
}

/** Renders the dialog, with a query client holding the signed-in person when one is given. */
function show(session: DatabaseSession, tableId: string, onClose: () => void, client?: QueryClient) {
  const dialog = <ImportIntoTable session={session} tableId={tableId} onClose={onClose} />;
  render(
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      {client ? <QueryClientProvider client={client}>{dialog}</QueryClientProvider> : dialog}
    </I18nProvider>,
  );
}

async function mount(
  count = 3,
  prepare: (server: FakeServer, fixture: FakeFixture) => void = () => undefined,
  workbook?: () => Response,
  client?: QueryClient,
): Promise<Setup> {
  const server = new FakeServer();
  const fixture = server.createDatabase(count);
  prepare(server, fixture);
  const session = await openDatabase(fixture.databaseId, server.deps());
  sessions.push(session);
  const fetch = connect(server, workbook);
  const onClose = vi.fn();
  show(session, fixture.tableId, onClose, client);
  const table = server.database(fixture.databaseId).rows(fixture.tableId);
  return {
    server,
    fixture,
    session,
    onClose,
    rows: () => {
      const order = table.order();
      return Array.from({ length: order.total }, (_, index) => table.get(order.idAt(index)!)!);
    },
    commands: () =>
      fetch.mock.calls
        .filter(([path]) => String(path).endsWith('/commands'))
        .flatMap(([, init]) => CommandBatch.parse(JSON.parse(String(init?.body))).commands),
  };
}

async function upload(text: string, name = 'people.csv') {
  await userEvent.upload(
    screen.getByLabelText('Choose a CSV or Excel file', { selector: 'input' }),
    new File([text], name, { type: 'text/csv' }),
  );
  await waitFor(() => expect(screen.getByRole('table', { name: 'Preview' })).toBeDefined());
}

async function chooseKey(name: string) {
  await userEvent.click(screen.getByRole('button', { name: /Match records on/ }));
  await userEvent.click(screen.getByRole('option', { name }));
}

async function importNow() {
  const button = screen.getByRole('button', { name: 'Import' });
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  await userEvent.click(button);
  await screen.findByRole('button', { name: 'Done' });
}

function summary(): string[] {
  const section = screen.getByRole('region', { name: 'What the import will do' });
  return within(section)
    .getAllByRole('heading')
    .map((heading) => heading.textContent ?? '');
}

function report(): string[] {
  return [...screen.getByRole('status', { name: 'What the import did' }).querySelectorAll('p')].map(
    (line) => line.textContent ?? '',
  );
}

describe('importing into a table', () => {
  it('maps columns to fields by name, lets one be skipped, and adds every row without a key', async () => {
    const setup = await mount();
    await upload('NAME,Number,Extra\nAda,5,left out\nBea,6,left out');
    const headers = screen.getAllByRole('columnheader');
    expect(within(headers[0]!).getByRole('button', { name: /Import into/ }).textContent).toContain('Name');
    expect(within(headers[1]!).getByRole('button', { name: /Import into/ }).textContent).toContain('Number');
    // No field is called Extra, so it starts out skipped.
    expect(within(headers[2]!).getByRole('button', { name: /Import into/ }).textContent).toContain(
      'Don’t import',
    );
    await userEvent.click(within(headers[1]!).getByRole('button', { name: /Import into/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Don’t import' }));
    await waitFor(() =>
      expect(summary()).toEqual([
        '2 records to add',
        '0 records to update',
        '0 records already up to date',
        '0 rows skipped',
      ]),
    );
    expect(screen.getByText('Every row is added as a new record.')).toBeDefined();
    await importNow();
    expect(report()).toEqual(['Added 2 records.', 'Updated 0 records.']);
    const rows = setup.rows();
    expect(rows.map((row) => row.values[setup.fixture.textFieldId])).toEqual([
      'Record 1',
      'Record 2',
      'Record 3',
      'Ada',
      'Bea',
    ]);
    expect(rows[3]!.values[setup.fixture.numberFieldId]).toBeUndefined();
  });

  it('matches rows on a key and shows what it will add, update, leave alone, and skip', async () => {
    const setup = await mount();
    await upload('Name,Number\nRecord 1,0\nrecord 2,10\nNew one,3\nRecord 3,lots\n,4');
    await chooseKey('Name');
    await waitFor(() =>
      expect(summary()).toEqual([
        '1 record to add',
        '1 record to update',
        '1 record already up to date',
        '2 rows skipped',
      ]),
    );
    const section = screen.getByRole('region', { name: 'What the import will do' });
    expect(
      within(section)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Row 4: New one',
      'Row 3: record 2, changing Number',
      'Row 2: Record 1',
      'Row 5: Number “lots” isn’t a number.',
      'Row 6 has no Name.',
    ]);
    expect(
      screen.getByText(
        'A row whose Name a record already has updates that record.  The rest are added.',
        exact,
      ),
    ).toBeDefined();
    expect(screen.getByText('Empty cells leave a record’s value as it is.')).toBeDefined();
    await importNow();
    expect(report()).toEqual([
      'Added 1 record.',
      'Updated 1 record.',
      '1 record was already up to date.',
      'Skipped 2 rows.',
    ]);
    const rows = setup.rows();
    expect(
      rows.map((row) => [row.values[setup.fixture.textFieldId], row.values[setup.fixture.numberFieldId]]),
    ).toEqual([
      ['Record 1', 0],
      ['Record 2', 10],
      ['Record 3', 2],
      ['New one', 3],
    ]);
    // Only what changed is written, and the matched key isn't written again.
    const update = setup.commands().find((command) => command.kind === 'record.update');
    expect(update?.kind === 'record.update' && update.records).toEqual([
      { id: setup.fixture.recordId(1), values: { [setup.fixture.numberFieldId]: 10 } },
    ]);
  });

  it('reports repeated keys and keys several records share, and handles them as chosen', async () => {
    const setup = await mount(3, (server, fixture) => {
      server.remote(fixture.databaseId, [
        {
          kind: 'record.create',
          tableId: fixture.tableId,
          records: [
            {
              id: newId('record'),
              values: { [fixture.textFieldId]: 'record 1', [fixture.numberFieldId]: 50 },
            },
          ],
        },
      ]);
    });
    await upload('Name,Number\nRecord 1,7\nRecord 2,8\nRecord 2,9');
    await chooseKey('Name');
    const group = await screen.findByRole('radiogroup', { name: 'When a key repeats' });
    expect(group.textContent).toContain(
      '1 row repeats an earlier row’s key.  1 row matches more than one record.',
    );
    expect(screen.getByText('Row 2: Record 1 matches 2 records.')).toBeDefined();
    expect(screen.getByText('Row 4 repeats the key on row 3.')).toBeDefined();
    await userEvent.click(within(group).getByRole('radio', { name: /Stop, and import nothing/ }));
    expect(
      screen.getByText(
        'Nothing will be imported while keys repeat.  Fix them in the file, or let the first one win.',
        exact,
      ),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Import' }).hasAttribute('disabled')).toBe(true);
    await userEvent.click(within(group).getByRole('radio', { name: /The first one wins/ }));
    await importNow();
    expect(report()).toEqual(['Added 0 records.', 'Updated 2 records.', 'Skipped 1 row.']);
    // The oldest of the matching records is the one updated.
    expect(setup.rows().map((row) => row.values[setup.fixture.numberFieldId])).toEqual([7, 8, 2, 50]);
  });

  it('adds new options the way pasting does, and lists cells that don’t convert', async () => {
    const statusId = newId('field');
    const dueId = newId('field');
    const openId = newId('choice');
    const setup = await mount(2, (server, fixture) => {
      server.remote(fixture.databaseId, [
        {
          kind: 'field.create',
          tableId: fixture.tableId,
          field: {
            id: statusId,
            name: 'Status',
            type: 'singleSelect',
            options: { choices: [{ id: openId, name: 'Open', color: 'green' }] },
          },
        },
        { kind: 'field.create', tableId: fixture.tableId, field: { id: dueId, name: 'Due', type: 'date' } },
      ]);
    });
    await upload(
      'Name,Status,Number,Due\nRecord 1,open,1,2026-01-02\nRecord 2,Closed,,\nRecord 9,Closed,soon,never',
    );
    await chooseKey('Name');
    await waitFor(() =>
      expect(summary()).toEqual([
        '0 records to add',
        '2 records to update',
        '0 records already up to date',
        '1 row skipped',
      ]),
    );
    // Every cell of a skipped row that doesn't convert is listed.
    expect(screen.getByText('Row 4: Number “soon” isn’t a number.')).toBeDefined();
    expect(screen.getByText('Row 4: Due “never” isn’t a date.')).toBeDefined();
    await importNow();
    const commands = setup.commands();
    expect(commands.map((command) => command.kind)).toEqual(['field.update', 'record.update']);
    expect(new Set(commands.map((command) => command.groupId)).size).toBe(1);
    const status = setup.session.getSchema().fieldById.get(statusId) as Extract<
      FieldMeta,
      { type: 'singleSelect' }
    >;
    expect(status.options.choices.map((choice) => choice.name)).toEqual(['Open', 'Closed']);
    const closed = status.options.choices[1]!.id;
    expect(setup.rows().map((row) => row.values[statusId])).toEqual([openId, closed]);
    expect(setup.rows().map((row) => row.values[dueId] ?? null)).toEqual(['2026-01-02', null]);
  });

  it('writes in batches as one step, which Undo takes back whole', async () => {
    const setup = await mount(1_200);
    const lines = [
      'Name,Number',
      ...Array.from({ length: 1_200 }, (_, index) => `Record ${index + 1},${index + 1_000}`),
      ...Array.from({ length: 1_300 }, (_, index) => `Fresh ${index + 1},${index}`),
    ];
    await upload(lines.join('\n'));
    await chooseKey('Name');
    await waitFor(() =>
      expect(summary().slice(0, 2)).toEqual(['1,300 records to add', '1,200 records to update']),
    );
    await importNow();
    expect(report()).toEqual(['Added 1,300 records.', 'Updated 1,200 records.']);
    const commands = setup.commands();
    expect(
      commands.map((command) => [command.kind, 'records' in command ? command.records.length : 0]),
    ).toEqual([
      ['record.update', 1_000],
      ['record.update', 200],
      ['record.create', 1_000],
      ['record.create', 300],
    ]);
    expect(new Set(commands.map((command) => command.groupId)).size).toBe(1);
    expect(setup.rows()).toHaveLength(2_500);
    expect(setup.session.undoHistory().undo.map((entry) => entry.groupId)).toEqual([commands[0]!.groupId]);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('The import was undone.');
    const rows = setup.rows();
    expect(rows).toHaveLength(1_200);
    expect(rows.every((row, index) => row.values[setup.fixture.numberFieldId] === index)).toBe(true);
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(setup.session.canRedo()).toBe(true);
  });

  it('stops between batches when asked, and what it wrote can still be undone', async () => {
    const setup = await mount(0);
    let release: () => void = () => undefined;
    let held = false;
    setup.server.beforeRequest = async (request) => {
      if (!request.path.endsWith('/commands') || held) return;
      held = true;
      await new Promise<void>((resolve) => (release = resolve));
    };
    await upload(['Name', ...Array.from({ length: 2_500 }, (_, index) => `Person ${index}`)].join('\n'));
    const button = screen.getByRole('button', { name: 'Import' });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    await userEvent.click(button);
    await waitFor(() => expect(held).toBe(true));
    expect(screen.getByRole('progressbar', { name: 'Importing' })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    release();
    await screen.findByRole('button', { name: 'Done' });
    expect(report()).toEqual([
      'The import stopped before the end.',
      'Added 1,000 records.',
      'Updated 0 records.',
    ]);
    expect(setup.rows()).toHaveLength(1_000);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('The import was undone.');
    expect(setup.rows()).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(setup.onClose).toHaveBeenCalledOnce();
  });

  it('stops at a refused batch, says why, and offers Undo for what it wrote', async () => {
    const setup = await mount(0);
    let sent = 0;
    setup.server.afterRequest = async (request) => {
      if (request.path.endsWith('/commands') && ++sent === 1) setup.server.rejectNext('data.access.denied');
    };
    await upload(['Name', ...Array.from({ length: 1_500 }, (_, index) => `Person ${index}`)].join('\n'));
    await importNow();
    expect(screen.getByRole('alert').textContent).toBe(
      'The import stopped: You don’t have access to do that in this database.',
    );
    expect(report()).toEqual(['Added 1,000 records.', 'Updated 0 records.']);
    expect(setup.rows()).toHaveLength(1_000);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('The import was undone.');
    expect(setup.rows()).toHaveLength(0);
  });

  it('picks a sheet of a workbook and matches its typed values', async () => {
    const lines = [
      { sheet: 'Notes', position: 0 },
      [1, 'Note'],
      [2, 'Anything'],
      { rows: 2, total: 2 },
      { sheet: 'Scores', position: 1 },
      [1, 'Name', 'Number'],
      [2, 'Record 1', 0],
      [3, 'Record 2', 42.5],
      { rows: 3, total: 3 },
      { done: true },
    ];
    const setup = await mount(
      3,
      undefined,
      () => new Response(lines.map((line) => JSON.stringify(line)).join('\n')),
    );
    await userEvent.upload(
      screen.getByLabelText('Choose a CSV or Excel file', { selector: 'input' }),
      new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'scores.xlsx'),
    );
    await waitFor(() => expect(screen.getByRole('cell', { name: 'Anything' })).toBeDefined());
    await userEvent.click(screen.getByRole('button', { name: /Sheet/ }));
    await userEvent.click(screen.getByRole('option', { name: 'Scores' }));
    await waitFor(() => expect(screen.getByRole('cell', { name: '42.5' })).toBeDefined());
    await chooseKey('Name');
    await waitFor(() =>
      expect(summary()).toEqual([
        '0 records to add',
        '1 record to update',
        '1 record already up to date',
        '0 rows skipped',
      ]),
    );
    await importNow();
    expect(setup.rows().map((row) => row.values[setup.fixture.numberFieldId])).toEqual([0, 42.5, 2]);
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

  it('celebrates an import that comes in clean, and not a second one straight after', async () => {
    const client = signedIn();
    const outcomes = vi.spyOn(celebrations, 'celebrate');
    const setup = await mount(3, undefined, undefined, client);
    await upload('Name,Number\nAda,5\nBea,6');
    await importNow();
    expect(report()).toEqual(['Added 2 records.', 'Updated 0 records.']);
    expect(shown.map((celebration) => [celebration.name, celebration.key])).toEqual([
      ['importClean', setup.fixture.tableId],
    ]);

    cleanup();
    show(setup.session, setup.fixture.tableId, vi.fn(), client);
    await upload('Name,Number\nCy,7');
    await importNow();
    expect(report()).toEqual(['Added 1 record.', 'Updated 0 records.']);
    expect(shown).toHaveLength(1);
    // The quiet between celebrations holds the second one back.
    expect(outcomes.mock.results.map((result) => result.value)).toEqual(['shown', 'limited']);
  });

  it('doesn’t celebrate an import that skips a row', async () => {
    const outcomes = vi.spyOn(celebrations, 'celebrate');
    await mount(3, undefined, undefined, signedIn());
    await upload('Name,Number\nAda,5\nBea,lots');
    await importNow();
    expect(report()).toEqual(['Added 1 record.', 'Updated 0 records.', 'Skipped 1 row.']);
    expect(shown).toEqual([]);
    expect(outcomes).not.toHaveBeenCalled();
  });

  it('doesn’t celebrate an import where a key repeats', async () => {
    const outcomes = vi.spyOn(celebrations, 'celebrate');
    await mount(3, undefined, undefined, signedIn());
    await upload('Name,Number\nRecord 1,7\nRecord 1,8');
    await chooseKey('Name');
    await screen.findByText('Row 3 repeats the key on row 2.');
    await importNow();
    expect(report()).toEqual(['Added 0 records.', 'Updated 1 record.', 'Skipped 1 row.']);
    expect(shown).toEqual([]);
    expect(outcomes).not.toHaveBeenCalled();
  });

  it('doesn’t celebrate an import where a key matches more than one record', async () => {
    const outcomes = vi.spyOn(celebrations, 'celebrate');
    await mount(
      3,
      (server, fixture) => {
        server.remote(fixture.databaseId, [
          {
            kind: 'record.create',
            tableId: fixture.tableId,
            records: [{ id: newId('record'), values: { [fixture.textFieldId]: 'record 1' } }],
          },
        ]);
      },
      undefined,
      signedIn(),
    );
    await upload('Name,Number\nRecord 1,7');
    await chooseKey('Name');
    await screen.findByText('Row 2: Record 1 matches 2 records.');
    await importNow();
    // Nothing was skipped, so only the shared key keeps this import from counting as clean.
    expect(report()).toEqual(['Added 0 records.', 'Updated 1 record.']);
    expect(shown).toEqual([]);
    expect(outcomes).not.toHaveBeenCalled();
  });
});
