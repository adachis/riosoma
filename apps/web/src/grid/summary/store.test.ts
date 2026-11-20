import { afterEach, expect, it } from 'vitest';
import type { ViewAggregate } from '@riosoma/contracts';
import { ApiError } from '../../api';
import { openDatabase } from '../../data/session';
import { FakeServer } from '../../data/testing';
import { GridSummaryStore } from './store';

const dispose: Array<() => void> = [];
afterEach(() => {
  for (const stop of dispose.splice(0)) stop();
});

function pendingAggregate() {
  let resolve!: (answer: ViewAggregate) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<ViewAggregate>((answer, fail) => {
    resolve = answer;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function setup() {
  const server = new FakeServer();
  const fixture = server.createDatabase(1);
  const requests: Array<ReturnType<typeof pendingAggregate> & { signal: AbortSignal }> = [];
  const session = await openDatabase(
    fixture.databaseId,
    server.deps({
      http: <T>(path: string, options?: Parameters<typeof server.http>[1]): Promise<T> => {
        if (!path.endsWith('/aggregate')) return server.http<T>(path, options);
        const request = { ...pendingAggregate(), signal: options!.signal! };
        requests.push(request);
        return request.promise as Promise<T>;
      },
    }),
  );
  const store = new GridSummaryStore(session, fixture.viewId, fixture.tableId, 'UTC');
  const stop = store.start();
  dispose.push(stop, () => session.close());
  store.setKey('first');
  const ready: ViewAggregate = { kind: 'summary', records: 1, values: {} };
  requests[0]!.resolve(ready);
  await settle();
  expect(store.getSnapshot()).toEqual({ status: 'ready', data: ready, refreshing: false });
  return { store, requests, stop, ready };
}

/** Rejection handlers and the unhandled-rejection event both run before the next turn. */
async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const aborts = [
  { browser: 'standard', error: () => new DOMException('The operation was aborted.', 'AbortError') },
  {
    browser: 'WebKit',
    error: () => new TypeError('Fetch API cannot load /aggregate due to access control checks.'),
  },
  { browser: 'Firefox', error: () => new TypeError('NetworkError when attempting to fetch resource.') },
];

it.each(aborts)('handles a pending refresh rejected during cleanup in $browser', async ({ error }) => {
  const { store, requests, stop } = await setup();
  store.setKey('refresh');
  const pending = requests[1]!;
  const before = store.getSnapshot();
  const unhandled: unknown[] = [];
  const capture = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', capture);
  dispose.push(() => process.off('unhandledRejection', capture));
  stop();
  expect(pending.signal.aborted).toBe(true);
  pending.reject(error());
  await settle();
  expect(unhandled).toEqual([]);
  expect(store.getSnapshot()).toBe(before);
});

it.each(aborts)('keeps a superseded $browser rejection out of the current summary', async ({ error }) => {
  const { store, requests } = await setup();
  store.setKey('old refresh');
  store.setKey('new refresh');
  const old = requests[1]!;
  const current = requests[2]!;
  expect(old.signal.aborted).toBe(true);
  expect(current.signal.aborted).toBe(false);
  current.resolve({ kind: 'summary', records: 2, values: {} });
  await settle();
  const before = store.getSnapshot();
  old.reject(error());
  await settle();
  expect(store.getSnapshot()).toBe(before);
  expect(before).toEqual({
    status: 'ready',
    data: { kind: 'summary', records: 2, values: {} },
    refreshing: false,
  });
});

it.each([
  {
    error: new ApiError(503, { code: 'unavailable', messageKey: 'errors.offline', userFault: false }),
    messageKey: 'errors.offline',
  },
  { error: new TypeError('NetworkError when attempting to fetch resource.'), messageKey: 'errors.internal' },
])('reports a current request failure as $messageKey', async ({ error, messageKey }) => {
  const { store, requests } = await setup();
  store.setKey('refresh');
  expect(requests[1]!.signal.aborted).toBe(false);
  requests[1]!.reject(error);
  await settle();
  expect(store.getSnapshot()).toEqual({ status: 'error', messageKey });
});
