import { i18n } from '@lingui/core';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FieldSpec,
  TableSourceSettings,
  newId,
  type Command,
  type DatabaseRole,
  type DuplicateRecord,
  type Duplicates,
  type DuplicatesRequest,
  type FieldMeta,
} from '@riosoma/contracts';
import { ConfirmProvider, toast } from '@riosoma/ui';
import { openDatabase } from '../../../data/session';
import type { DatabaseSession } from '../../../data';
import { queuedSource } from '../../../data/source';
import { FakeServer } from '../../../data/testing';
import { renderShell, table } from '../shell/test-support';
import { TableSidebar } from '../shell/TableSidebar';
import { DuplicatesPanel } from './DuplicatesPanel';

const sessions: DatabaseSession[] = [];
beforeEach(() => {
  // Toasts are worded with the app's own translator.
  i18n.load('en-US', {});
  i18n.activate('en-US');
});
afterEach(() => {
  cleanup();
  for (const session of sessions.splice(0)) session.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

const PEOPLE = [
  { name: 'Ada Lovelace', email: 'ada@example.test', tag: 0 },
  { name: 'ada lovelace', email: null, tag: 1 },
  { name: 'Grace Hopper', email: 'grace@example.test', tag: null },
  { name: 'Grace Hopper', email: 'hopper@example.test', tag: 1 },
  { name: 'Linus', email: 'linus@example.test', tag: null },
];

/** People with two sets of duplicates: two spellings of Ada, and Grace twice. */
function people(server: FakeServer, options: { role?: DatabaseRole; synced?: boolean } = {}) {
  const base = server.createDatabase(0);
  const schema = server.database(base.databaseId).schema;
  const field = (name: string, spec: FieldSpec): FieldMeta => ({
    ...schema.fields[0]!,
    id: newId('field'),
    name,
    ...spec,
  });
  const choices = [
    { id: newId('choice'), name: 'Red', color: 'red' as const },
    { id: newId('choice'), name: 'Blue', color: 'blue' as const },
  ];
  const email = field('Email', FieldSpec.parse({ type: 'email' }));
  const tags = field('Tags', FieldSpec.parse({ type: 'multipleSelect', options: { choices } }));
  const tableMeta = schema.tables[0]!;
  const database = server.seed(
    {
      ...schema,
      database: { ...schema.database, role: options.role ?? 'owner' },
      tables: [
        {
          ...tableMeta,
          name: 'People',
          ...(options.synced
            ? {
                source: queuedSource(
                  TableSourceSettings.parse({
                    sourceId: 'src00000000000001',
                    select: { kind: 'object', object: { schema: 'public', name: 'People' } },
                    keyColumns: ['id'],
                  }),
                ),
              }
            : {}),
        },
      ],
      fields: [...schema.fields, email, tags],
    },
    new Map([
      [
        base.tableId,
        {
          count: PEOPLE.length,
          values: (index: number) => {
            const person = PEOPLE[index]!;
            return {
              [base.textFieldId]: person.name,
              [base.numberFieldId]: index,
              [email.id]: person.email,
              [tags.id]: person.tag === null ? null : [choices[person.tag]!.id],
            };
          },
        },
      ],
    ]),
  );
  const rows = database.rows(base.tableId);
  const ids = PEOPLE.map((_, index) => rows.id(index));
  const record = (index: number): DuplicateRecord => {
    const row = rows.get(ids[index]!)!;
    return {
      id: row.id,
      values: { [base.textFieldId]: row.values[base.textFieldId] ?? null },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  };
  const found = (changes: Partial<Duplicates> = {}): Duplicates => ({
    groups: [{ records: [record(0), record(1)] }, { records: [record(2), record(3)] }],
    fields: [{ fieldId: base.textFieldId, match: 'loose', method: 'loose' }],
    linked: {},
    total: 5,
    compared: 5,
    sampled: false,
    truncated: false,
    oversized: 0,
    timedOut: false,
    ms: 4,
    ...changes,
  });
  return { ...base, database, rows, ids, email, tags, choices, found };
}
type People = ReturnType<typeof people>;

async function mount(
  options: { role?: DatabaseRole; synced?: boolean; answer?: (f: People) => Duplicates } = {},
) {
  const server = new FakeServer();
  const f = people(server, options);
  const session = await openDatabase(f.databaseId, server.deps());
  sessions.push(session);
  const asked: DuplicatesRequest[] = [];
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    expect(path).toBe(`/api/tables/${f.tableId}/duplicates`);
    asked.push(JSON.parse(String(init?.body)) as DuplicatesRequest);
    return json(options.answer ? options.answer(f) : f.found());
  });
  vi.stubGlobal('fetch', fetch);
  const onClose = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  renderShell(
    <QueryClientProvider client={client}>
      <ConfirmProvider>
        <DuplicatesPanel session={session} tableId={f.tableId} onClose={onClose} />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
  const dialog = await screen.findByRole('dialog', { name: 'Find duplicates in People' });
  return { server, f, session, asked, dialog, onClose };
}

/** The merge commands the session sent, in order. */
function merges(server: FakeServer): Array<Extract<Command, { kind: 'record.merge' }>> {
  return server.requests
    .filter((request) => request.path.endsWith('/commands'))
    .flatMap((request) => (request.options.body as { commands: Command[] }).commands)
    .filter(
      (command): command is Extract<Command, { kind: 'record.merge' }> => command.kind === 'record.merge',
    );
}

const groupNamed = async (name: string) =>
  (await screen.findByRole('heading', { name, level: 3 })).closest('li')!;

async function search(dialog: HTMLElement) {
  await userEvent.click(within(dialog).getByRole('button', { name: 'Find duplicates' }));
  await within(dialog).findByText('2 sets of duplicates among 5 records');
}

describe('the duplicates panel', () => {
  it('opens from a table’s menu', async () => {
    const tables = [table('Orders'), table('People')];
    const onFindDuplicates = vi.fn();
    renderShell(
      <TableSidebar
        tables={tables}
        activeTableId={tables[0]!.id}
        hrefFor={(id) => `/database/${id}`}
        onNavigate={vi.fn()}
        canEdit
        onCreate={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onMove={vi.fn()}
        onFindLinks={vi.fn()}
        onFindDuplicates={onFindDuplicates}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'More for People' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Find duplicates' }));
    expect(onFindDuplicates).toHaveBeenCalledWith(tables[1]!.id);
  });

  it('compares the fields and matching people choose, and shows each set side by side', async () => {
    const { f, asked, dialog } = await mount();
    const fieldOf = (row: HTMLElement) => within(row).getByRole('button', { name: /Field to compare/ });
    const matchOf = (row: HTMLElement) => within(row).getByRole('button', { name: /How to match/ });
    const [first] = within(dialog).getAllByRole('listitem');
    expect(fieldOf(first!).textContent).toBe('Name');
    expect(matchOf(first!).textContent).toBe('Ignoring case and spacing');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Compare another field' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Compare another field' }));
    const rows = within(dialog).getAllByRole('listitem');
    expect(rows.map((row) => fieldOf(row).textContent)).toEqual(['Name', 'Email', 'Tags']);
    // Only text matches loosely or as similar text, so lists match exactly.
    expect(matchOf(rows[2]!).textContent).toBe('Exactly');
    expect(matchOf(rows[2]!).hasAttribute('disabled')).toBe(true);
    await userEvent.click(fieldOf(rows[2]!));
    await userEvent.click(await screen.findByRole('option', { name: 'Number' }));
    expect(fieldOf(within(dialog).getAllByRole('listitem')[2]!).textContent).toBe('Number');
    await userEvent.click(matchOf(rows[1]!));
    await userEvent.click(await screen.findByRole('option', { name: 'Similar text' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop comparing Number' }));
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(2);
    expect(within(dialog).queryByRole('button', { name: 'Compare another field' })).not.toBeNull();
    await search(dialog);
    expect(asked).toEqual([
      {
        fields: [
          { fieldId: f.textFieldId, match: 'loose' },
          { fieldId: f.email.id, match: 'similar' },
        ],
      },
    ]);
    const ada = await groupNamed('Ada Lovelace');
    expect(within(ada).getByText('2 records')).toBeDefined();
    const values = within(ada).getByRole('table');
    expect(
      within(values)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Record 1', 'Record 2']);
    const nameRowCells = within(within(values).getByRole('row', { name: /^Name/ })).getAllByRole('cell');
    expect(nameRowCells.map((cell) => cell.textContent)).toEqual(['Ada Lovelace', 'ada lovelace']);
    expect(await groupNamed('Grace Hopper')).toBeDefined();
  });

  it('reviews a set, keeps the record and values people pick, and merges it', async () => {
    const { server, f, dialog } = await mount();
    const notices = vi.spyOn(toast, 'show');
    await search(dialog);
    const ada = await groupNamed('Ada Lovelace');
    await userEvent.click(within(ada).getByRole('button', { name: 'Review' }));
    const keep = await within(ada).findByRole('radiogroup', { name: 'Record to keep' });
    expect(within(keep).getByRole('radio', { name: 'Record 1' })).toHaveProperty('checked', true);
    await userEvent.click(within(keep).getByRole('radio', { name: 'Record 2' }));
    // The kept record's empty email takes the other record's, and lists combine unless someone picks one.
    const email = within(ada).getByRole('radiogroup', { name: 'Email' });
    expect(within(email).getByRole('radio', { name: 'ada@example.test, record 1' })).toHaveProperty(
      'checked',
      true,
    );
    const tags = within(ada).getByRole('radiogroup', { name: 'Tags' });
    expect(within(tags).getByRole('radio', { name: 'Combine' })).toHaveProperty('checked', true);
    expect(within(tags).getByText('Blue, Red')).toBeDefined();
    await userEvent.click(within(tags).getByRole('radio', { name: 'Red, record 1' }));
    const name = within(ada).getByRole('radiogroup', { name: 'Name' });
    expect(within(name).getByRole('radio', { name: 'ada lovelace, record 2' })).toHaveProperty(
      'checked',
      true,
    );
    await userEvent.click(within(name).getByRole('radio', { name: 'Ada Lovelace, record 1' }));
    await userEvent.click(within(ada).getByRole('button', { name: 'Merge these records' }));
    expect(await within(ada).findByText('Merged')).toBeDefined();
    await waitFor(() =>
      expect(notices).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Merged 1 record into Ada Lovelace', action: expect.anything() }),
      ),
    );
    expect(merges(server)).toEqual([
      expect.objectContaining({
        kind: 'record.merge',
        tableId: f.tableId,
        recordId: f.ids[1],
        mergeIds: [f.ids[0]],
        choices: { [f.textFieldId]: f.ids[0], [f.tags.id]: f.ids[0] },
      }),
    ]);
    expect(f.rows.get(f.ids[0]!)).toBeUndefined();
    expect(f.rows.get(f.ids[1]!)!.values).toMatchObject({
      [f.textFieldId]: 'Ada Lovelace',
      [f.email.id]: 'ada@example.test',
      [f.tags.id]: [f.choices[0]!.id],
    });
    expect(
      within(dialog).getByText(
        'Merged 1 set of duplicates. 1 record went to the trash, where it stays for 30 days.',
      ),
    ).toBeDefined();
    // The other set is still there to merge.
    expect(within(dialog).getByRole('button', { name: 'Merge 1 set' })).toBeDefined();
  });

  it('skips sets, merges the rest with the defaults as one undoable step, and shows progress and a summary', async () => {
    const { server, f, session, dialog } = await mount();
    await search(dialog);
    const grace = await groupNamed('Grace Hopper');
    await userEvent.click(within(grace).getByRole('button', { name: 'Skip' }));
    expect(within(grace).getByText('Skipped')).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Merge 1 set' })).toBeDefined();
    await userEvent.click(within(grace).getByRole('button', { name: 'Include it again' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Merge all 2 sets' }));
    const question = await screen.findByRole('dialog', { name: 'Merge 2 sets of duplicates?' });
    expect(
      within(question).getByText(
        '2 records go to the trash, and their links and comments move to the records kept. You can undo this.',
      ),
    ).toBeDefined();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.beforeRequest = async (request) => {
      if (request.path.endsWith('/commands')) await held;
    };
    await userEvent.click(within(question).getByRole('button', { name: 'Merge them' }));
    const progress = await within(dialog).findByRole('progressbar', { name: 'Merging sets' });
    expect(progress.hasAttribute('aria-valuenow')).toBe(false);
    expect(within(dialog).queryByRole('button', { name: /^Merge all/ })).toBeNull();
    expect(within(await groupNamed('Grace Hopper')).getByText('Merging…')).toBeDefined();
    release();
    await within(dialog).findByText(
      'Merged 2 sets of duplicates. 2 records went to the trash, where they stay for 30 days.',
    );
    expect(within(dialog).queryByRole('progressbar')).toBeNull();
    expect(merges(server)).toEqual([
      expect.objectContaining({ recordId: f.ids[0], mergeIds: [f.ids[1]], choices: {} }),
      expect.objectContaining({ recordId: f.ids[2], mergeIds: [f.ids[3]], choices: {} }),
    ]);
    const commands = server.requests.filter((request) => request.path.endsWith('/commands'));
    const groups = new Set(
      commands.flatMap((request) =>
        (request.options.body as { commands: Command[] }).commands.map((command) => command.groupId),
      ),
    );
    expect(groups.size).toBe(1);
    expect(f.rows.get(f.ids[1]!)).toBeUndefined();
    expect(f.rows.get(f.ids[3]!)).toBeUndefined();
    expect(f.rows.get(f.ids[0]!)!.values[f.tags.id]).toEqual([f.choices[0]!.id, f.choices[1]!.id]);
    expect(within(dialog).queryByRole('button', { name: /^Merge/ })).toBeNull();
    // One undo puts every set back.
    await session.undo();
    await waitFor(() => expect(f.rows.get(f.ids[1]!)).toBeDefined());
    expect(f.rows.get(f.ids[3]!)).toBeDefined();
    expect(f.rows.get(f.ids[0]!)!.values[f.tags.id]).toEqual([f.choices[0]!.id]);
  });

  it('says how the table was compared, and what was left out', async () => {
    const { dialog } = await mount({
      answer: (f) =>
        f.found({
          fields: [{ fieldId: f.textFieldId, match: 'similar', method: 'normalized' }],
          sampled: true,
          total: 250_000,
          compared: 100_000,
          truncated: true,
          oversized: 3,
          timedOut: true,
        }),
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Find duplicates' }));
    await within(dialog).findByText('2 sets of duplicates among 100,000 records');
    for (const note of [
      'Similar text was compared ignoring case, spaces, and punctuation, since this server doesn’t have the pg_trgm extension.',
      'This table is large, so a sample of 100,000 of its 250,000 records was compared.',
      'Showing the largest 2 sets.',
      '3 sets were too large to be duplicates and were left out. Compare more fields to narrow them down.',
      'This took too long, so some duplicates may be missing. Try exact matching or fewer fields.',
    ])
      expect(within(dialog).getByText(note)).toBeDefined();
  });

  it('says so when there are no duplicates', async () => {
    const { dialog } = await mount({ answer: (f) => f.found({ groups: [] }) });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Find duplicates' }));
    expect(
      await within(dialog).findByText('No duplicates. Try other fields, or a looser way of matching.'),
    ).toBeDefined();
    expect(within(dialog).queryByRole('button', { name: /^Merge/ })).toBeNull();
  });

  it('lets readers look without merging, and explains why synced tables can’t merge', async () => {
    const reader = await mount({ role: 'reader' });
    await search(reader.dialog);
    expect(
      within(reader.dialog).getByText(
        'You can find duplicates here. Merging them needs permission to edit records.',
      ),
    ).toBeDefined();
    expect(within(reader.dialog).queryByRole('button', { name: /^Merge/ })).toBeNull();
    const ada = await groupNamed('Ada Lovelace');
    await userEvent.click(within(ada).getByRole('button', { name: 'Review' }));
    const keep = await within(ada).findByRole('radiogroup', { name: 'Record to keep' });
    expect(keep.getAttribute('aria-disabled')).toBe('true');
    expect(within(ada).queryByRole('button', { name: 'Merge these records' })).toBeNull();
    cleanup();

    const synced = await mount({ synced: true });
    await search(synced.dialog);
    expect(
      within(synced.dialog).getByText(
        'Records in this table come from its source, so duplicates can’t be merged here. Fix them in the source.',
      ),
    ).toBeDefined();
    expect(within(synced.dialog).queryByRole('button', { name: /^Merge/ })).toBeNull();
  });

  it('closes with Done', async () => {
    const { dialog, onClose } = await mount();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });
});
