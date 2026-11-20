import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '@riosoma/ui';
import type { SessionInfo, SyncState, TableSource } from '@riosoma/contracts';
import { celebrations, type Celebration } from '../../../features/celebrations/engine';
import { sessionQuery } from '../../../session';
import { openDatabase } from '../../../data/session';
import type { DatabaseSession } from '../../../data';
import { syncedFixture } from '../../../data/testing/synced';
import { renderShell } from '../shell/test-support';
import { SyncStatus } from './SyncStatus';
const sessions: DatabaseSession[] = [];
afterEach(() => {
  cleanup();
  for (const session of sessions.splice(0)) session.close();
});
async function mount(
  state: SyncState,
  lastSuccessAt: string | null = null,
  extra: {
    freshness?: 'copy' | 'live';
    switchingToCopy?: boolean;
    kind?: TableSource['sourceKind'];
    error?: TableSource['status']['error'];
    rowsRead?: number;
  } = {},
) {
  const { server, fixture, table } = syncedFixture();
  const source = table.source!;
  source.status = {
    ...source.status,
    state,
    lastSuccessAt,
    error:
      extra.error ??
      (state === 'failed' ? { messageKey: 'sources.sync.failed', detail: 'Connection closed' } : null),
    held: state === 'held' ? { removing: 30, total: 40 } : null,
    ...(extra.switchingToCopy ? { switchingToCopy: true } : {}),
    ...(extra.rowsRead !== undefined
      ? { progress: { rowsRead: extra.rowsRead }, lastSyncAt: new Date(Date.now() - 3_000).toISOString() }
      : {}),
  };
  source.freshness = extra.freshness ?? 'copy';
  if (extra.kind) source.sourceKind = extra.kind;
  const session = await openDatabase(fixture.databaseId, server.deps());
  sessions.push(session);
  renderShell(
    <ConfirmProvider>
      <SyncStatus table={{ ...table, source: source as TableSource }} session={session} />
    </ConfirmProvider>,
  );
  const commands = () =>
    server.requests.flatMap((request) =>
      request.path.endsWith('/commands')
        ? (
            request.options.body as {
              commands: Array<{ kind: string; confirmRemovals?: boolean; settings?: object }>;
            }
          ).commands
        : [],
    );
  return { commands, session, table };
}
it.each(['queued', 'running'] as const)(
  'announces %s with a spinner and no duplicate sync action',
  async (state) => {
    await mount(state);
    expect(screen.getByRole('status').textContent).toContain('Syncing…');
    expect(screen.getByRole('progressbar')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  },
);
it('shows the source before the first sync and queues one on request', async () => {
  const { commands } = await mount('idle');
  expect(screen.getByRole('status').textContent).toBe('Waiting for the first sync from Warehouse');
  await userEvent.click(screen.getByRole('button', { name: 'Sync now' }));
  await waitFor(() =>
    expect(commands()).toContainEqual(
      expect.objectContaining({ kind: 'table.sync', confirmRemovals: false }),
    ),
  );
});
it('announces the first copy, reported rows, and elapsed time', async () => {
  await mount('running', null, { rowsRead: 5_000 });
  expect(screen.getByRole('status').textContent).toContain('Copy started.');
  expect(screen.getByText('Copy started.', { exact: true })).toBeDefined();
  expect(screen.getByRole('status').textContent).toContain('5,000 rows read');
  expect(screen.getByText(/3 seconds elapsed/)).toBeDefined();
});
it('shows a successful sync with relative time', async () => {
  await mount('idle', new Date(Date.now() - 3600000).toISOString());
  expect(screen.getByRole('status').textContent).toBe('Synced from Warehouse 1 hour ago');
});
it('shows a failure message and retries', async () => {
  const { commands } = await mount('failed');
  expect(screen.getByRole('status').textContent).toContain('Connection closed');
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(commands()).toHaveLength(1));
});
it.each([
  ['sources.sync.columnMissing', { column: '名前🚢' }, 'The source no longer has the column 名前🚢.'],
  ['sources.sync.objectMissing', { object: 'موانئ' }, 'The source no longer has موانئ.'],
] as const)(
  'names the missing source item for %s alongside diagnostics',
  async (messageKey, params, message) => {
    await mount('failed', null, { error: { messageKey, params, detail: 'Remote schema changed' } });
    expect(screen.getByRole('status').textContent).toContain(message);
    expect(screen.getByRole('status').textContent).toContain('Remote schema changed');
  },
);
it('requires confirmation for held removals and leaves cancellation unchanged', async () => {
  const { commands } = await mount('held');
  expect(screen.getByRole('status').textContent).toBe('This sync would remove 30 of 40 records.');
  await userEvent.click(screen.getByRole('button', { name: 'Remove them' }));
  const dialog = screen.getByRole('dialog', { name: 'Remove 30 records?' });
  expect(
    within(dialog).getByText('They’re missing from the source. Records return if the source has them again.'),
  ).toBeDefined();
  expect(commands()).toHaveLength(0);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await userEvent.click(screen.getByRole('button', { name: 'Remove them' }));
  await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove them' }));
  await waitFor(() =>
    expect(commands()).toContainEqual(expect.objectContaining({ kind: 'table.sync', confirmRemovals: true })),
  );
});
it('keeps held records without sending a command', async () => {
  const { commands } = await mount('held');
  await userEvent.click(screen.getByRole('button', { name: 'Keep them for now' }));
  expect(commands()).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Remove them' })).toBeNull();
});
it('saves schedule, overrides, and removal threshold through updateSource', async () => {
  const { commands } = await mount('idle');
  await userEvent.click(screen.getByRole('button', { name: 'Sync settings' }));
  const dialog = screen.getByRole('dialog', { name: 'Sync settings' });
  await userEvent.click(within(dialog).getByRole('button', { name: /Every hour Sync/ }));
  await userEvent.click(screen.getByRole('option', { name: 'Only when asked' }));
  await userEvent.click(
    within(dialog).getByRole('checkbox', { name: 'Let people change source values here' }),
  );
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(commands()).toContainEqual(
      expect.objectContaining({
        kind: 'table.updateSource',
        settings: { everyMinutes: null, allowOverrides: false, holdAboveDeleteShare: 0.5, freshness: 'copy' },
      }),
    ),
  );
});
it('says a live table reads its source, with no sync to run, and reads it again on request', async () => {
  const { commands, session, table } = await mount('idle', null, { freshness: 'live' });
  const refresh = vi.spyOn(session, 'refreshTable');
  expect(screen.getByRole('status').textContent).toBe('Live from Warehouse');
  expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Find links' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Read again' }));
  expect(refresh).toHaveBeenCalledWith(table.id);
  expect(commands()).toHaveLength(0);
});
it('says a table switching to Copy reads live until its first sync', async () => {
  await mount('running', null, { switchingToCopy: true });
  expect(screen.getByRole('status').textContent).toContain('Making the first copy.');
});
it('switches a table to Live from its settings, where the schedule and removal limit don’t apply', async () => {
  const { commands } = await mount('idle');
  await userEvent.click(screen.getByRole('button', { name: 'Sync settings' }));
  const dialog = screen.getByRole('dialog', { name: 'Sync settings' });
  await userEvent.click(within(dialog).getByRole('radio', { name: /Live/ }));
  expect(within(dialog).queryByRole('button', { name: /Every hour Sync/ })).toBeNull();
  expect(within(dialog).queryByRole('textbox', { name: /Wait for a person/ })).toBeNull();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(commands()).toContainEqual(
      expect.objectContaining({
        kind: 'table.updateSource',
        settings: expect.objectContaining({ freshness: 'live' }),
      }),
    ),
  );
});

it('says when a webhook’s last post came, and offers no sync', async () => {
  await mount('idle', null, { kind: 'webhook' });
  expect(screen.getByRole('status').textContent).toContain('Waiting for the first post to Warehouse');
  expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
  cleanup();
  await mount('failed', new Date().toISOString(), { kind: 'webhook' });
  expect(screen.getByRole('status').textContent).toContain('The last post couldn’t be written.');
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Sync settings' })).toBeDefined();
});

describe('celebrations', () => {
  let shown: Celebration[] = [];
  let stop: () => void = () => undefined;
  beforeEach(() => {
    shown = [];
    stop = celebrations.subscribe((celebration) => shown.push(celebration));
  });
  afterEach(() => {
    stop();
    localStorage.clear();
  });
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  /** A synced table seen by a signed-in person, waiting for its first sync unless told otherwise. */
  async function waiting(lastSuccessAt: string | null = null) {
    const { server, fixture, table } = syncedFixture();
    const source = table.source!;
    source.status = { ...source.status, state: 'idle', lastSuccessAt, error: null, held: null };
    source.freshness = 'copy';
    const session = await openDatabase(fixture.databaseId, server.deps());
    sessions.push(session);
    const client = new QueryClient();
    client.setQueryData(sessionQuery.queryKey, { user: { id: 'user-one' }, preferences: {} } as SessionInfo);
    const element = (status: Partial<TableSource['status']> = {}) => (
      <QueryClientProvider client={client}>
        <ConfirmProvider>
          <SyncStatus
            table={{
              ...table,
              source: { ...source, status: { ...source.status, ...status } } as TableSource,
            }}
            session={session}
          />
        </ConfirmProvider>
      </QueryClientProvider>
    );
    const { rerender } = renderShell(element());
    return { settle: (status: Partial<TableSource['status']>) => rerender(element(status)) };
  }

  it('celebrate a first sync a schedule ran as someone else’s, once', async () => {
    const { settle } = await waiting();
    settle({ state: 'running' });
    settle({ state: 'idle', lastSuccessAt: ago(1) });
    expect(shown.map((celebration) => [celebration.name, celebration.cause])).toEqual([
      ['syncFirstSuccess', 'others'],
    ]);
    settle({ state: 'idle', lastSuccessAt: ago(0) });
    expect(shown).toHaveLength(1);
  });

  it('celebrate a first sync the person asked for as theirs', async () => {
    const { settle } = await waiting();
    await userEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    await act(async () => undefined);
    settle({ state: 'queued' });
    settle({ state: 'idle', lastSuccessAt: ago(0) });
    expect(shown.map((celebration) => [celebration.name, celebration.cause])).toEqual([
      ['syncFirstSuccess', 'you'],
    ]);
  });

  it('don’t count a sync the person asked for that failed toward a later scheduled one', async () => {
    const { settle } = await waiting();
    await userEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    await act(async () => undefined);
    settle({ state: 'failed', error: { messageKey: 'sources.sync.failed', detail: 'Connection closed' } });
    settle({ state: 'idle', lastSuccessAt: ago(0), error: null });
    expect(shown.map((celebration) => [celebration.name, celebration.cause])).toEqual([
      ['syncFirstSuccess', 'others'],
    ]);
  });

  it('don’t celebrate a table that had synced before it was first seen', async () => {
    const { settle } = await waiting(ago(60));
    settle({ state: 'idle', lastSuccessAt: ago(0) });
    expect(shown).toEqual([]);
  });
});
