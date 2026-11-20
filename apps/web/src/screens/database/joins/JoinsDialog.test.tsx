import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JoinSuggestions, TableSource } from '@riosoma/contracts';
import { ConfirmProvider } from '@riosoma/ui';
import type { ReactElement } from 'react';
import { openDatabase } from '../../../data/session';
import type { DatabaseSession } from '../../../data';
import { FakeServer } from '../../../data/testing';
import { relationalFixture } from '../../../data/testing/relational';
import { syncedFixture } from '../../../data/testing/synced';
import { renderShell, table } from '../shell/test-support';
import { TableSidebar } from '../shell/TableSidebar';
import { SyncStatus } from '../synced/SyncStatus';
import { JoinsDialog } from './JoinsDialog';

const sessions: DatabaseSession[] = [];
afterEach(() => {
  cleanup();
  for (const session of sessions.splice(0)) session.close();
  vi.unstubAllGlobals();
});

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function withQueries(element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderShell(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

type Fixture = ReturnType<typeof relationalFixture>;

async function mount(answer: (f: Fixture) => Promise<Response>) {
  const server = new FakeServer();
  const f = relationalFixture(server);
  const session = await openDatabase(f.source.databaseId, server.deps());
  sessions.push(session);
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => answer(f));
  vi.stubGlobal('fetch', fetch);
  const onClose = vi.fn();
  withQueries(<JoinsDialog session={session} tableId={f.source.tableId} onClose={onClose} />);
  return { server, f, session, fetch, onClose };
}

describe('suggested links', () => {
  it('lists suggestions in words with a confidence meter, and links one through field.create', async () => {
    const { server, f, fetch } = await mount(async (f) =>
      json({
        suggestions: [
          {
            fromTableId: f.source.tableId,
            fromFieldId: f.source.numberFieldId,
            toTableId: f.tableId,
            toFieldId: f.price.id,
            confidence: 0.92,
            coverage: 0.9,
            uniqueness: 0.954,
            namesMatch: false,
            examples: [
              { value: '1', records: 3 },
              { value: '2', records: 1 },
            ],
          },
        ],
        profiledFields: 9,
        ms: 12,
      } satisfies JoinSuggestions),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Suggested links' });
    expect(
      within(dialog).getByText(
        'Fields whose values match records in another table. Linking them keeps the links up to date as values change.',
      ),
    ).toBeDefined();
    const item = (await within(dialog).findByText('From Number in Table to Price in Projects')).closest(
      'li',
    )!;
    const meter = within(item).getByRole('meter', { name: 'From Number in Table to Price in Projects' });
    expect(meter.getAttribute('aria-valuenow')).toBe('92');
    expect(meter.getAttribute('aria-valuetext')).toBe('92% confident');
    expect(within(item).getByText('90% of values found')).toBeDefined();
    expect(within(item).getByText('95% of matches are unique')).toBeDefined();
    expect(within(item).getByText('For example: 1, 2')).toBeDefined();
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe(`/api/databases/${f.source.databaseId}/join-suggestions`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ tableIds: [f.source.tableId] });

    await userEvent.click(within(item).getByRole('button', { name: 'Link them' }));
    await waitFor(() => expect(screen.queryByText('From Number in Table to Price in Projects')).toBeNull());
    // The linked suggestion is gone, but the focus stays in the dialog, so Escape still closes it.
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(within(dialog).getByText('Every suggested link is made.')).toBeDefined();
    const created = server
      .database(f.source.databaseId)
      .schema.fields.find((field) => field.type === 'link' && field.options.match);
    // The table already has a field named after Projects, so the new one is numbered.
    expect(created).toMatchObject({
      tableId: f.source.tableId,
      name: 'Projects 2',
      options: {
        linkedTableId: f.tableId,
        match: { fieldId: f.source.numberFieldId, linkedFieldId: f.price.id },
      },
    });
  });

  it('says nothing obvious was found when no fields match', async () => {
    await mount(async () => json({ suggestions: [], profiledFields: 4, ms: 3 }));
    expect(
      await screen.findByText(
        'Nothing obvious to link. Values in one table don’t match values in another closely enough.',
      ),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Link them' })).toBeNull();
  });

  it('compares again when a copied table finishes while the dialog is open', async () => {
    const { server, f, fetch, session } = await mount(async () =>
      json({ suggestions: [], profiledFields: 4, ms: 3 }),
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const current = session.getSchema().tableById.get(f.source.tableId)!;
    const { table: copied } = syncedFixture();
    server.remoteChange(f.source.databaseId, {
      kind: 'table.synced',
      table: {
        ...current,
        source: {
          ...copied.source!,
          status: {
            ...copied.source!.status,
            state: 'idle',
            lastSuccessAt: new Date().toISOString(),
          },
        },
      },
      stats: { added: 50_000, changed: 0, removed: 0, unchanged: 0, overridesCleared: 0, ms: 10 },
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it('shows progress while comparing and explains failures', async () => {
    let release: (response: Response) => void = () => {};
    await mount(() => new Promise<Response>((resolve) => (release = resolve)));
    expect(await screen.findByRole('progressbar', { name: 'Comparing fields…' })).toBeDefined();
    release(
      json(
        { error: { code: 'forbidden', messageKey: 'data.access.denied', userFault: true, requestId: 'r' } },
        403,
      ),
    );
    expect(await screen.findByText('You don’t have access to do that in this database.')).toBeDefined();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText(/Nothing obvious/)).toBeNull();
  });

  it('opens from the synced table status bar for that table', async () => {
    const { server, fixture, table: synced } = syncedFixture();
    const session = await openDatabase(fixture.databaseId, server.deps());
    sessions.push(session);
    const fetch = vi.fn(async () => json({ suggestions: [], profiledFields: 2, ms: 1 }));
    vi.stubGlobal('fetch', fetch);
    withQueries(
      <ConfirmProvider>
        <SyncStatus table={{ ...synced, source: synced.source as TableSource }} session={session} />
      </ConfirmProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Find links' }));
    expect(await screen.findByRole('dialog', { name: 'Suggested links' })).toBeDefined();
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(call[1].body))).toEqual({ tableIds: [fixture.tableId] });
  });

  it('opens from a table’s menu', async () => {
    const tables = [table('Orders'), table('Customers')];
    const onFindLinks = vi.fn();
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
        onFindLinks={onFindLinks}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'More for Customers' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Find links' }));
    expect(onFindLinks).toHaveBeenCalledWith(tables[1]!.id);
  });
});
