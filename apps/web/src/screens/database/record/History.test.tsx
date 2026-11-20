import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FieldMeta, newId, type HistoryEntry, type HistoryPage } from '@riosoma/contracts';
import { openDatabase } from '../../../data';
import type { DatabaseSession, Http } from '../../../data';
import { FakeServer } from '../../../data/testing';
import { settle } from '../../../data/testing/relational';
import type { FormatContext } from '../../../grid/format';
import { HistoryPanel } from './History';

const sessions: DatabaseSession[] = [];
afterEach(() => {
  cleanup();
  for (const session of sessions.splice(0)) session.close();
});

const MINUTE = 60_000;
/** Stands in for the signed-in person, whose ID only the server knows. */
const ME = 'me';
const SAM = 'usr00000000000002';
const GONE = 'usr99999999999999';

const format: FormatContext = {
  locale: 'en-US',
  timeZone: 'UTC',
  collaborators: new Map(),
};

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * MINUTE).toISOString();
}

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    seq: 1,
    at: ago(30),
    actorId: ME,
    kind: 'updated',
    changes: [],
    ...overrides,
  };
}

interface Fields {
  text: string;
  number: string;
  done: string;
}
type Pages = (HistoryPage & { cursor?: string | null })[];

interface Mounted {
  server: FakeServer;
  session: DatabaseSession;
  requested: string[];
  fields: Fields;
}

/** History comes from the server's change log, so a test hands the panel the pages it wants. */
async function mount(build: Pages | ((fields: Fields) => Pages)): Promise<Mounted> {
  const server = new FakeServer();
  const fixture = server.createDatabase(3);
  const database = server.database(fixture.databaseId);
  database.schema.collaborators = [
    { id: server.userId, name: 'Alex Rivera', email: 'alex@example.test' },
    { id: SAM, name: 'Sam Lee', email: 'sam@example.test' },
  ];
  const done = FieldMeta.parse({
    ...database.schema.fields[0]!,
    id: newId('field'),
    name: 'Done',
    type: 'checkbox',
    options: {},
  });
  database.schema.fields = [...database.schema.fields, done];
  const fields: Fields = { text: fixture.textFieldId, number: fixture.numberFieldId, done: done.id };
  const byCursor = new Map<string | null, HistoryPage>();
  const requested: string[] = [];
  for (const page of typeof build === 'function' ? build(fields) : build) {
    const { cursor = null, ...rest } = page;
    byCursor.set(cursor, {
      ...rest,
      entries: rest.entries.map((item) => ({
        ...item,
        actorId: item.actorId === ME ? server.userId : item.actorId,
      })),
    });
  }
  const http: Http = async <T,>(path: string, options?: Parameters<Http>[1]): Promise<T> => {
    if (path.includes('/history')) {
      requested.push(path);
      const cursor = new URL(path, 'http://localhost').searchParams.get('cursor');
      return (byCursor.get(cursor) ?? { entries: [], next: null }) as T;
    }
    return server.http<T>(path, options);
  };
  const session = await openDatabase(fixture.databaseId, server.deps({ http }));
  sessions.push(session);
  await settle();
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  render(
    <I18nProvider i18n={i18n}>
      <HistoryPanel
        session={session}
        tableId={fixture.tableId}
        recordId={fixture.recordId(0)}
        format={format}
      />
    </I18nProvider>,
  );
  await waitFor(() => expect(requested).toHaveLength(1));
  // Recording a request can precede the panel's state update
  await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
  return {
    server,
    session,
    requested,
    fields,
  };
}

describe('reading a record’s history', () => {
  it('clears history and refetches even when the access reload cannot refresh the grid', async () => {
    const { server, session, fields } = await mount((fields) => [
      {
        entries: [
          entry({ changes: [{ fieldId: fields.text, before: 'Private before', after: 'Private after' }] }),
        ],
        next: null,
      },
    ]);
    const view = session.openView([...session.getSchema().viewById.keys()][0]!);
    await act(async () => {
      await settle();
    });
    vi.spyOn(view, 'refresh').mockRejectedValue(new Error('disconnected'));
    const history = vi.spyOn(session, 'history').mockResolvedValue({ entries: [], next: null });
    await act(async () => {
      const database = server.database(session.databaseId);
      database.schema.fields = database.schema.fields.filter((field) => field.id !== fields.text);
      server.dropSubscriptions(session.databaseId, 'accessChanged');
      await settle();
    });
    expect(session.getSchema().fieldById.has(fields.text)).toBe(false);
    expect(screen.queryByText('Private before')).toBeNull();
    expect(screen.queryByText('Private after')).toBeNull();
    expect(history).toHaveBeenCalledOnce();
    expect(screen.getByText('No changes yet.')).toBeTruthy();
  });

  it('aborts an old history response before the new access schema finishes reading', async () => {
    const { server, session, fields } = await mount((fields) => [
      {
        entries: [
          entry({ changes: [{ fieldId: fields.text, before: 'Private before', after: 'Private after' }] }),
        ],
        next: null,
      },
    ]);
    let release!: (page: HistoryPage) => void;
    const pending = new Promise<HistoryPage>((resolve) => {
      release = resolve;
    });
    const history = vi
      .spyOn(session, 'history')
      .mockReturnValueOnce(pending)
      .mockResolvedValue({ entries: [], next: null });
    const tableId = session.getSchema().tables[0]!.id;
    const recordId = server.database(session.databaseId).rows(tableId).id(0);
    await act(async () => {
      server.remoteChange(session.databaseId, {
        kind: 'record.updated',
        tableId,
        records: [
          {
            id: recordId,
            values: { [fields.text]: 'Private after' },
            updatedAt: ago(0),
            updatedBy: session.userId,
          },
        ],
      });
      await settle();
    });
    let finishSchema!: () => void;
    const schemaRead = new Promise<void>((resolve) => {
      finishSchema = resolve;
    });
    server.beforeRequest = (request) => (request.path.endsWith('/schema') ? schemaRead : Promise.resolve());
    await act(async () => {
      server.dropSubscriptions(session.databaseId, 'accessChanged');
      await settle();
    });
    const aborted = history.mock.calls[0]![3]!.aborted;
    const privateBefore = screen.queryByText('Private before');
    await act(async () => {
      finishSchema();
      release({
        entries: [
          entry({
            changes: [{ fieldId: fields.text, before: 'Stale private before', after: 'Stale private after' }],
          }),
        ],
        next: null,
      });
      await settle();
    });
    expect(aborted).toBe(true);
    expect(privateBefore).toBeNull();
    expect(screen.queryByText('Stale private after')).toBeNull();
  });

  it.each(['oldest', null])(
    'preserves older loaded history and the %s cursor during live refreshes',
    async (cursor) => {
      const { server, session, fields } = await mount((fields) => [
        {
          entries: [
            entry({ seq: 3, changes: [{ fieldId: fields.text, before: null, after: 'Current page' }] }),
          ],
          next: 'second',
        },
        {
          cursor: 'second',
          entries: [
            entry({ seq: 2, changes: [{ fieldId: fields.text, before: null, after: 'Older page' }] }),
          ],
          next: cursor,
        },
        { cursor: 'oldest', entries: [entry({ seq: 1 })], next: null },
      ]);
      await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
      expect(await screen.findByText('Older page')).toBeTruthy();
      const tableId = session.getSchema().tables[0]!.id;
      const recordId = server.database(session.databaseId).rows(tableId).id(0);
      const history = vi.spyOn(session, 'history').mockResolvedValueOnce({
        entries: [
          entry({ seq: 4, changes: [{ fieldId: fields.text, before: null, after: 'Live change' }] }),
          entry({ seq: 3, changes: [{ fieldId: fields.text, before: null, after: 'Current page' }] }),
        ],
        next: 'second',
      });
      await act(async () => {
        server.remoteChange(session.databaseId, {
          kind: 'record.updated',
          tableId,
          records: [
            {
              id: recordId,
              values: { [fields.text]: 'Live change' },
              updatedAt: ago(0),
              updatedBy: session.userId,
            },
          ],
        });
        await settle();
      });
      expect(screen.getByText('Live change')).toBeTruthy();
      expect(screen.queryByText('Older page')).not.toBeNull();
      expect(screen.getAllByRole('listitem')).toHaveLength(3);
      if (cursor) {
        await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
        await waitFor(() =>
          expect(history).toHaveBeenLastCalledWith(tableId, recordId, cursor, expect.any(AbortSignal)),
        );
      } else expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    },
  );

  it('clears cached history and reads it again after access changes', async () => {
    const { server, session, fields } = await mount((fields) => [
      {
        entries: [
          entry({ changes: [{ fieldId: fields.text, before: 'Private before', after: 'Private after' }] }),
        ],
        next: null,
      },
    ]);
    const history = vi.spyOn(session, 'history').mockResolvedValue({ entries: [], next: null });
    await act(async () => {
      const database = server.database(session.databaseId);
      database.schema.database.role = 'reader';
      database.schema.fields = database.schema.fields.filter((field) => field.id !== fields.text);
      server.dropSubscriptions(session.databaseId, 'accessChanged');
      await settle();
    });
    await waitFor(() => expect(session.role()).toBe('reader'));
    expect(history).toHaveBeenCalledOnce();
    expect(screen.queryByText('Private before')).toBeNull();
    expect(screen.queryByText('Private after')).toBeNull();
    expect(await screen.findByText('No changes yet.')).toBeTruthy();
  });

  it('does not reread history for an optimistic edit after another record changed', async () => {
    const { server, session, fields } = await mount([{ entries: [], next: null }]);
    const tableId = session.getSchema().tables[0]!.id;
    const records = server.database(session.databaseId).rows(tableId);
    const history = vi.spyOn(session, 'history');
    await act(async () => {
      server.remoteChange(session.databaseId, {
        kind: 'record.updated',
        tableId,
        records: [
          {
            id: records.id(1),
            values: { [fields.text]: 'Other' },
            updatedAt: new Date().toISOString(),
            updatedBy: session.userId,
          },
        ],
      });
      await settle();
    });
    server.goOffline();
    await act(async () => {
      session.run([
        {
          kind: 'record.update',
          tableId,
          records: [{ id: records.id(0), values: { [fields.text]: 'Pending' } }],
        },
      ]);
      await settle();
    });
    expect(history).not.toHaveBeenCalled();
  });

  it('refreshes history when this record changes, and ignores other records', async () => {
    const { server, session, fields } = await mount([{ entries: [], next: null }]);
    const schema = session.getSchema();
    const tableId = schema.tables[0]!.id;
    const records = server.database(session.databaseId).rows(tableId);
    const history = vi.spyOn(session, 'history').mockResolvedValue({
      entries: [entry({ changes: [{ fieldId: fields.text, before: 'Before', after: 'After' }] })],
      next: null,
    });
    await act(async () => {
      server.remoteChange(session.databaseId, {
        kind: 'record.updated',
        tableId,
        records: [
          {
            id: records.id(1),
            values: { [fields.text]: 'Other' },
            updatedAt: new Date().toISOString(),
            updatedBy: session.userId,
          },
        ],
      });
      await settle();
    });
    expect(history).not.toHaveBeenCalled();
    await act(async () => {
      server.remoteChange(session.databaseId, {
        kind: 'record.updated',
        tableId,
        records: [
          {
            id: records.id(0),
            values: { [fields.text]: 'After' },
            updatedAt: new Date().toISOString(),
            updatedBy: session.userId,
          },
        ],
      });
      await settle();
    });
    expect(await screen.findByText('After')).toBeTruthy();
    expect(history).toHaveBeenCalledOnce();
  });

  it('retries the failed older page without replacing the changes already loaded', async () => {
    const { session } = await mount([
      { entries: [entry({ seq: 3 })], next: 'older' },
      { cursor: 'older', entries: [entry({ seq: 2 })], next: null },
    ]);
    const history = vi.spyOn(session, 'history').mockRejectedValueOnce(new Error('disconnected'));
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    expect(history.mock.calls.map((args) => args[2])).toEqual(['older', 'older']);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says when nothing has changed yet', async () => {
    await mount([{ entries: [], next: null }]);
    expect(screen.getByText('No changes yet.')).toBeTruthy();
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('reads each kind of change as a sentence, newest first', async () => {
    const at = ago(30);
    await mount([
      {
        entries: [
          entry({ seq: 5, at, kind: 'synced', actorId: null }),
          entry({ seq: 4, at, kind: 'restored' }),
          entry({ seq: 3, at, kind: 'trashed' }),
          entry({ seq: 2, at, kind: 'created', actorId: SAM }),
          entry({ seq: 1, at, kind: 'updated', actorId: GONE, changes: [] }),
        ],
        next: null,
      },
    ]);
    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => item.querySelector('.rio-history__summary')?.textContent)).toEqual([
      'The source changed this record',
      'Alex Rivera restored this record',
      'Alex Rivera deleted this record',
      'Sam Lee created this record',
      'Someone changed 0 fields',
    ]);
    // A change no person made still shows who it came from.
    expect(within(items[0]!).getByRole('img', { name: 'R: Riosoma' })).toBeTruthy();
    expect(within(items[3]!).getByRole('img', { name: 'SL: Sam Lee' })).toBeTruthy();
    expect(items[0]!.textContent).toContain('30 minutes ago');
    expect(items[0]!.querySelector('time')?.getAttribute('datetime')).toBe(at);
  });

  it('counts the fields a change touched', async () => {
    await mount([
      {
        entries: [
          entry({
            seq: 2,
            actorId: SAM,
            changes: [{ fieldId: 'fld00000000000001', before: null, after: 'One' }],
          }),
          entry({
            seq: 1,
            changes: [
              { fieldId: 'fld00000000000001', before: null, after: 'One' },
              { fieldId: 'fld00000000000002', before: null, after: 2 },
            ],
          }),
        ],
        next: null,
      },
    ]);
    const items = screen.getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('Sam Lee changed 1 field');
    expect(items[1]!.textContent).toContain('Alex Rivera changed 2 fields');
  });

  it('shows what each field held before and after, the way the grid shows it', async () => {
    await mount((fields) => [
      {
        entries: [
          entry({
            seq: 1,
            changes: [
              { fieldId: fields.text, before: null, after: 'Record 1' },
              { fieldId: fields.number, before: 1234.5, after: null },
              { fieldId: fields.done, before: false, after: true },
            ],
          }),
        ],
        next: null,
      },
    ]);
    const rows = (await screen.findAllByRole('listitem')).flatMap((item) => [
      ...item.querySelectorAll('.rio-history__change'),
    ]);
    expect(rows).toHaveLength(3);
    const [text, number, done] = rows as HTMLElement[];
    expect(within(text!).getByText('Name')).toBeTruthy();
    expect(within(text!).getByText('empty').tagName).toBe('DEL');
    expect(within(text!).getByText('Record 1').tagName).toBe('INS');
    expect(within(number!).getByText('1,234.5').tagName).toBe('DEL');
    expect(within(number!).getByText('empty').tagName).toBe('INS');
    expect(within(done!).getByText('empty').tagName).toBe('DEL');
    expect(within(done!).getByText('checked').tagName).toBe('INS');
  });

  it('leaves out a field that reads empty before and after', async () => {
    await mount((fields) => [
      {
        entries: [
          entry({
            seq: 1,
            kind: 'created',
            changes: [
              { fieldId: fields.text, before: null, after: 'Record 1' },
              { fieldId: fields.done, before: null, after: false },
            ],
          }),
        ],
        next: null,
      },
    ]);
    const rows = (await screen.findAllByRole('listitem')).flatMap((item) => [
      ...item.querySelectorAll('.rio-history__change'),
    ]);
    expect(rows).toHaveLength(1);
    expect(within(rows[0] as HTMLElement).getByText('Record 1')).toBeTruthy();
  });

  it('names a field that is gone by its ID', async () => {
    await mount([
      {
        entries: [
          entry({
            seq: 1,
            changes: [{ fieldId: 'fld00000000000009', before: null, after: 'Kept' }],
          }),
        ],
        next: null,
      },
    ]);
    expect(screen.getByText('fld00000000000009')).toBeTruthy();
    expect(screen.getByText('Kept')).toBeTruthy();
  });

  it('says when an override was set or cleared', async () => {
    await mount((fields) => [
      {
        entries: [
          entry({ seq: 2, changes: [], overrides: [{ fieldId: fields.text, set: false }] }),
          entry({ seq: 1, changes: [], overrides: [{ fieldId: fields.text, set: true }] }),
        ],
        next: null,
      },
    ]);
    const items = screen.getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('Back to the source’s value');
    expect(items[1]!.textContent).toContain('Changed here instead of the source');
    expect(screen.getAllByText('Name')).toHaveLength(2);
  });

  it('pages in older changes with Show more', async () => {
    const newest = ago(5);
    const middle = ago(60);
    const oldest = ago(120);
    const { requested } = await mount([
      { entries: [entry({ seq: 3, at: newest })], next: 'second' },
      {
        cursor: 'second',
        entries: [entry({ seq: 2, at: middle }), entry({ seq: 1, at: oldest })],
        next: null,
      },
    ]);
    expect(requested[0]).not.toContain('cursor=');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
    expect(requested[1]).toContain('cursor=second');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    // Newest stays first across pages.
    const times = screen.getAllByRole('listitem').map((item) => item.querySelector('time'));
    expect(times.map((time) => time?.getAttribute('datetime'))).toEqual([newest, middle, oldest]);
  });

  it('keeps what it has and says so when a page won’t load', async () => {
    const server = new FakeServer();
    const fixture = server.createDatabase(2);
    const session = await openDatabase(fixture.databaseId, server.deps());
    sessions.push(session);
    await settle();
    server.goOffline();
    const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
    render(
      <I18nProvider i18n={i18n}>
        <HistoryPanel
          session={session}
          tableId={fixture.tableId}
          recordId={fixture.recordId(0)}
          format={format}
        />
      </I18nProvider>,
    );
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/check your connection/i)).toBeTruthy();
    // A page that didn't load is not an empty one.
    expect(screen.queryByText('No changes yet.')).toBeNull();
    expect(screen.queryByRole('listitem')).toBeNull();
  });
});
