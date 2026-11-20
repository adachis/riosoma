import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncOutAction } from '@riosoma/contracts';
import { renderSharing } from '../../screens/database/share/testing';
import { SyncOutDialog } from './SyncOutDialog';
import {
  DATABASE_ID,
  VIEW_ID,
  mockSyncOut,
  runFixture,
  statsFixture,
  statusFixture,
  syncFixture,
  type MockOptions,
} from './testing';

function start(options: MockOptions = {}) {
  const server = mockSyncOut(options);
  vi.stubGlobal('fetch', vi.fn(server.handle));
  const onClose = vi.fn();
  renderSharing(
    <SyncOutDialog viewId={VIEW_ID} viewName="Launches" databaseId={DATABASE_ID} onClose={onClose} />,
  );
  return { ...server, onClose };
}

/** The actions posted to the commands route, in order. */
function actions(sent: { url: string; body: unknown }[]): SyncOutAction[] {
  return sent
    .filter((request) => request.url.endsWith('/sync-out/commands'))
    .map((request) => (request.body as { action: SyncOutAction }).action);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SyncOutDialog', () => {
  it('shows the empty state with a way to set one up', async () => {
    start();
    expect(await screen.findByText('This view isn’t synced anywhere yet.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Set up a sync' })).toBeDefined();
  });

  it('shows a loading spinner while the list loads', async () => {
    // A request that never resolves leaves the spinner on screen.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    renderSharing(
      <SyncOutDialog viewId={VIEW_ID} viewName="Launches" databaseId={DATABASE_ID} onClose={vi.fn()} />,
    );
    expect(await screen.findByRole('progressbar', { name: 'Loading syncs…' })).toBeDefined();
  });

  it('explains why Sync out is unavailable without a setup button', async () => {
    start({ canCreate: false, unavailable: 'syncOut.unavailable.policy', syncs: [] });
    expect(
      await screen.findByText(
        'Your organization has turned Sync out off, or keeps sharing inside the organization.',
      ),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Set up a sync' })).toBeNull();
  });

  it('shows a finished sync with its facts and a real future next-run time', async () => {
    start({ syncs: [syncFixture()] });
    const item = (await screen.findByRole('listitem')) as HTMLElement;
    expect(item.textContent).toContain('Launches in Product, Airtable');
    expect(item.textContent).toContain('Every hour');
    expect(item.textContent).toContain('12 added, 3 updated, 0 removed, and 240 unchanged');
    expect(item.textContent).toContain('Dana Ortiz');
    const status = within(item).getByRole('status');
    // The next run is a moment, never "just now" (the relative helper's future answer).
    expect(status.textContent).toContain('Next sync');
    expect(status.textContent).not.toContain('just now');
    expect(within(item).getByRole('link', { name: /Open/ })).toHaveProperty(
      'href',
      'https://airtable.com/app/tbl',
    );
  });

  it('shows a running sync with its live counts', async () => {
    start({
      syncs: [
        syncFixture({
          status: statusFixture({ state: 'running', progress: { done: 120, total: 240 }, stats: null }),
        }),
      ],
    });
    expect(await screen.findByText('Syncing… 120 of 240 rows')).toBeDefined();
  });

  it('shows a failed sync with its reason and a Try again control', async () => {
    start({
      syncs: [
        syncFixture({
          status: statusFixture({
            state: 'failed',
            stats: null,
            error: { messageKey: 'syncOut.destination.unreachable' },
          }),
        }),
      ],
    });
    const item = await screen.findByRole('listitem');
    expect(item.textContent).toContain('The last sync didn’t finish.');
    expect(item.textContent).toContain('Riosoma couldn’t reach the destination.  The next sync tries again.');
    expect(within(item).getByRole('button', { name: 'Try again' })).toBeDefined();
  });

  it('says why a sync turned itself off', async () => {
    start({
      syncs: [
        syncFixture({
          enabled: false,
          stoppedBecause: 'syncOut.stopped.viewDeleted',
          status: statusFixture({ state: 'idle' }),
        }),
      ],
    });
    expect(await screen.findByText(/Turned itself off\.\s+The view was deleted\./)).toBeDefined();
  });

  it('syncs now, posting a run command', async () => {
    const { sent } = start({ syncs: [syncFixture()] });
    await userEvent.click(await screen.findByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(actions(sent).some((action) => action.kind === 'run')).toBe(true));
  });

  it('turns a sync off through its switch', async () => {
    const { sent } = start({ syncs: [syncFixture()] });
    await userEvent.click(await screen.findByRole('switch', { name: 'Launches to Airtable' }));
    await waitFor(() => {
      const update = actions(sent).find((action) => action.kind === 'update');
      expect(update && update.kind === 'update' && update.input.enabled).toBe(false);
    });
  });

  it('deletes a sync after an in-app confirmation', async () => {
    const { sent } = start({ syncs: [syncFixture()] });
    await userEvent.click(await screen.findByRole('button', { name: 'More for Launches to Airtable' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this sync?' });
    expect(confirm.textContent).toContain('Riosoma stops updating Launches.');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete sync' }));
    expect(await screen.findByText('This view isn’t synced anywhere yet.')).toBeDefined();
    expect(actions(sent).some((action) => action.kind === 'delete')).toBe(true);
  });

  it('shows run history with counts and outcomes', async () => {
    start({
      syncs: [syncFixture()],
      runs: [
        runFixture({ outcome: 'succeeded' }),
        runFixture({
          id: 'jobBBBBBBBBBBBBBB',
          outcome: 'partial',
          trigger: 'manual',
          actor: { id: 'usrADAADAADAADAAD', name: 'Dana Ortiz' },
          stats: statsFixture({ failed: 2 }),
          error: { messageKey: 'syncOut.destination.rateLimited' },
          notes: [{ messageKey: 'syncOut.note.truncated', params: { count: 1 } }],
        }),
      ],
    });
    await userEvent.click(await screen.findByRole('button', { name: 'More for Launches to Airtable' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'History' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sync history' });
    expect(dialog.textContent).toContain('Completed');
    expect(dialog.textContent).toContain('Completed with problems');
    expect(dialog.textContent).toContain('Started by Dana Ortiz');
    expect(dialog.textContent).toContain('and 2 not sent');
    expect(dialog.textContent).toContain('1 value was too long and was cut to fit.');
    expect(dialog.textContent).toContain('The last 50 syncs are kept.');
    await userEvent.click(screen.getByRole('button', { name: 'Back to syncs' }));
    expect(await screen.findByRole('button', { name: 'More for Launches to Airtable' })).toBeDefined();
  });

  it('shows an empty history', async () => {
    start({ syncs: [syncFixture()], runs: [] });
    await userEvent.click(await screen.findByRole('button', { name: 'More for Launches to Airtable' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'History' }));
    expect(await screen.findByText('No syncs have run yet.')).toBeDefined();
  });

  it('offers Try again when the list fails to load', async () => {
    start({ listError: { status: 500, code: 'internal', messageKey: 'errors.internal' } });
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeDefined();
  });
});
