import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { newId, type DatabaseTrash } from '@riosoma/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase } from '../../data/session';
import { FakeServer } from '../../data/testing';
import type { DatabaseSession } from '../../data/types';
import { renderHome } from '../home/test-support';
import { TrashDialog } from './TrashDialog';

let session: DatabaseSession | undefined;
afterEach(() => {
  cleanup();
  session?.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

it('lists and restores every kind through the session, pages records, and supports keyboard dismissal', async () => {
  const server = new FakeServer();
  const fixture = server.createDatabase(101);
  session = await openDatabase(fixture.databaseId, server.deps());
  const secondId = newId('table');
  const extraView = newId('view');
  await session.run([
    {
      kind: 'table.create',
      table: {
        id: secondId,
        name: 'Archived table',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    },
    {
      kind: 'view.create',
      view: { id: extraView, tableId: fixture.tableId, name: 'Archived view', type: 'grid' },
    },
  ]).done;
  await session.run([
    { kind: 'table.trash', tableId: secondId },
    { kind: 'field.trash', fieldId: fixture.numberFieldId },
    { kind: 'view.trash', viewId: extraView },
    {
      kind: 'record.trash',
      tableId: fixture.tableId,
      recordIds: Array.from({ length: 101 }, (_, n) => fixture.recordId(n)),
    },
  ]).done;
  const trashedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const trashedBy = server.userId;
  const items: DatabaseTrash['items'] = [
    {
      kind: 'table',
      id: secondId,
      name: 'Archived table',
      tableId: null,
      tableName: null,
      trashedAt,
      trashedBy,
    },
    {
      kind: 'field',
      id: fixture.numberFieldId,
      name: 'Number',
      tableId: fixture.tableId,
      tableName: 'Table',
      trashedAt,
      trashedBy,
    },
    {
      kind: 'view',
      id: extraView,
      name: 'Archived view',
      tableId: fixture.tableId,
      tableName: 'Table',
      trashedAt,
      trashedBy,
    },
  ];
  const fetch = vi.fn(async (path: string) => {
    const database = server.database(fixture.databaseId);
    if (path.includes('/trash/records')) {
      const page = path.includes('cursor=page2') ? [100] : Array.from({ length: 100 }, (_, n) => n);
      return json({
        records: page
          .filter((n) => !database.rows(fixture.tableId).get(fixture.recordId(n)))
          .map((n) => ({ id: fixture.recordId(n), name: `Record ${n + 1}`, trashedAt, trashedBy })),
        next: path.includes('cursor=page2') ? null : 'page2',
      });
    }
    return json({
      items: items.filter(
        (item) =>
          ![...database.schema.tables, ...database.schema.fields, ...database.schema.views].some(
            (value) => value.id === item.id,
          ),
      ),
      records: [{ tableId: fixture.tableId, tableName: 'Table', count: 101 }],
    });
  });
  vi.stubGlobal('fetch', fetch);
  const onClose = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  renderHome(
    <QueryClientProvider client={client}>
      <TrashDialog session={session} onClose={onClose} />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'Restore Archived table' });
  expect(screen.getByRole('dialog', { name: 'Trash' })).toBeDefined();
  expect(screen.getAllByText('Gone for good in 27 days')).toHaveLength(3);
  expect(screen.getAllByText(/Deleted by .* 3 days ago/)).toHaveLength(3);
  for (const name of ['Archived table', 'Number', 'Archived view']) {
    const button = screen.getByRole('button', { name: `Restore ${name}` });
    button.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('button', { name: `Restore ${name}` })).toBeNull());
  }
  expect(session.getSchema()!.tableById.has(secondId)).toBe(true);
  expect(session.getSchema()!.fieldById.has(fixture.numberFieldId)).toBe(true);
  expect(session.getSchema()!.viewById.has(extraView)).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: '101 deleted records in Table' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Show more' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Restore Record 101' }));
  await waitFor(() =>
    expect(
      server.database(fixture.databaseId).rows(fixture.tableId).get(fixture.recordId(100)),
    ).toBeDefined(),
  );
  expect(fetch.mock.calls.some(([path]) => path.endsWith('?cursor=page2'))).toBe(true);
  expect(session.canUndo()).toBe(true);
  await act(async () => {
    await session!.undo();
  });
  expect(
    server.database(fixture.databaseId).rows(fixture.tableId).get(fixture.recordId(100)),
  ).toBeUndefined();
  await userEvent.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledOnce();
});

it('shows an empty state and keeps restore controls disabled for readers', async () => {
  const server = new FakeServer();
  const fixture = server.createDatabase();
  server.database(fixture.databaseId).schema.database.role = 'reader';
  session = await openDatabase(fixture.databaseId, server.deps());
  let items: DatabaseTrash['items'] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ items, records: [] })),
  );
  const client = new QueryClient();
  renderHome(
    <QueryClientProvider client={client}>
      <TrashDialog session={session} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('Nothing has been deleted.')).toBeDefined();
  items = [
    {
      kind: 'field',
      id: newId('field'),
      name: 'Deleted field',
      tableId: fixture.tableId,
      tableName: 'Table',
      trashedAt: new Date().toISOString(),
      trashedBy: null,
    },
  ];
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['trash'] });
  });
  expect(
    (await screen.findByRole('button', { name: 'Restore Deleted field' })).hasAttribute('disabled'),
  ).toBe(true);
});

it('counts down the window the administrator chose and keeps restore available inside it', async () => {
  const server = new FakeServer();
  const fixture = server.createDatabase();
  session = await openDatabase(fixture.databaseId, server.deps());
  // Deleted 40 days ago, which the default window would already have removed for good.
  const trashedAt = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const tableId = newId('table');
  let retention: DatabaseTrash['retention'] = { days: 90, legalHold: false };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      json({
        items: [
          {
            kind: 'table',
            id: tableId,
            name: 'Kept table',
            tableId: null,
            tableName: null,
            trashedAt,
            trashedBy: null,
          },
        ],
        records: [],
        retention,
      }),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderHome(
    <QueryClientProvider client={client}>
      <TrashDialog session={session} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  const restore = () => screen.getByRole('button', { name: 'Restore Kept table' });
  expect(await screen.findByText('Gone for good in 50 days')).toBeDefined();
  expect((restore() as HTMLButtonElement).disabled).toBe(false);
  // A hold stops purging, so nothing counts down and restore stays available.
  retention = { days: null, legalHold: true };
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['trash', fixture.databaseId] });
  });
  expect(await screen.findByText('Kept while a legal hold is on')).toBeDefined();
  expect((restore() as HTMLButtonElement).disabled).toBe(false);
  // A window that has run out still refuses restore, as it always did.
  retention = { days: 30, legalHold: false };
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['trash', fixture.databaseId] });
  });
  await waitFor(() => expect((restore() as HTMLButtonElement).disabled).toBe(true));
});
