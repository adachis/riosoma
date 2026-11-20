import { beforeEach, expect, it, vi } from 'vitest';
import type { AppContext } from '../app.js';
import { SourceScheduler } from './scheduler.js';
import { purgeSyncHistory } from './history.js';
import { claimSyncs, runSync, type SyncJob } from './sync.js';

vi.mock('./history.js', () => ({ purgeSyncHistory: vi.fn(async () => undefined) }));
vi.mock('./sync.js', () => ({ claimSyncs: vi.fn(async () => []), runSync: vi.fn() }));
vi.mock('../data/context.js', () => ({ dataStore: () => ({ pool: {}, schemas: {} }) }));

beforeEach(() => {
  vi.clearAllMocks();
});

it('claims scheduled syncs without sweeping retention on every source tick', async () => {
  const scheduler = new SourceScheduler({ pool: {}, config: { database: {} } } as AppContext);
  try {
    await scheduler.tick();
    await scheduler.tick();
    expect(claimSyncs).toHaveBeenCalledTimes(2);
    expect(purgeSyncHistory).not.toHaveBeenCalled();
  } finally {
    await scheduler.close();
  }
});

it('remembers a dispatch arriving during a claim', async () => {
  let release!: () => void;
  vi.mocked(claimSyncs).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve([]);
      }),
  );
  const scheduler = new SourceScheduler({ pool: {}, config: { database: {} } } as AppContext);
  try {
    const first = scheduler.tick();
    scheduler.wake('waiting-table');
    release();
    await first;
    await scheduler.drain();
    expect(claimSyncs).toHaveBeenLastCalledWith(expect.anything(), 2, ['waiting-table']);
  } finally {
    release();
    await scheduler.close();
  }
});

it('dispatches waiting work as soon as a running copy releases capacity', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(claimSyncs)
    .mockResolvedValueOnce([{ table_id: 'first' }, { table_id: 'second' }] as SyncJob[])
    .mockResolvedValueOnce([{ table_id: 'third' }] as SyncJob[]);
  vi.mocked(runSync).mockImplementation(() => gate);
  const scheduler = new SourceScheduler({ pool: {}, config: { database: {} } } as AppContext);
  try {
    await scheduler.tick();
    scheduler.wake('third');
    expect(runSync).toHaveBeenCalledTimes(2);
    release();
    await scheduler.drain();
    expect(runSync).toHaveBeenCalledTimes(3);
    expect(vi.mocked(claimSyncs).mock.calls[1]?.[2]).toEqual(['third']);
  } finally {
    release();
    await scheduler.close();
  }
});
