import { StrictMode, createElement } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '@riosoma/contracts';
import { FakeServer } from './testing';
import type { FakeFixture } from './testing';
import type { DatabaseSession } from './types';
import { openDatabase } from './session';
import type * as SessionModule from './session';
import {
  useDatabaseSession,
  usePeers,
  useSaveState,
  useSchema,
  useSessionEvents,
  useViewRows,
} from './hooks';

const auth = vi.hoisted(() => ({ id: '' }));
vi.mock('../session', () => ({ useSession: () => (auth.id ? { user: { id: auth.id } } : null) }));
vi.mock('./session', async (original) => {
  const module = await original<typeof SessionModule>();
  return { ...module, openDatabase: vi.fn(module.openDatabase) };
});
async function settle(): Promise<void> {
  for (let index = 0; index < 80; index++) await Promise.resolve();
}
let server: FakeServer, fixture: FakeFixture;
const sessions: DatabaseSession[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  server = new FakeServer();
  fixture = server.createDatabase();
  auth.id = server.userId;
});
afterEach(async () => {
  cleanup();
  await vi.advanceTimersByTimeAsync(0);
  for (const session of sessions.splice(0)) session.close();
  vi.useRealTimers();
  vi.mocked(openDatabase).mockClear();
});
async function open() {
  const original = await vi.importActual<typeof SessionModule>('./session');
  const session = await original.openDatabase(fixture.databaseId, server.deps());
  sessions.push(session);
  return session;
}

describe('data hooks', () => {
  it('continues rendering row-data updates for React views by default', async () => {
    const session = await open();
    const hook = renderHook(() => {
      const rows = useViewRows(session, fixture.viewId);
      return rows?.getRow(0)?.values[fixture.textFieldId];
    });
    await act(settle);
    expect(hook.result.current).toBe('Record 1');
    await act(async () => {
      await session.run([
        {
          kind: 'record.update',
          tableId: fixture.tableId,
          records: [{ id: fixture.recordId(0), values: { [fixture.textFieldId]: 'Changed' } }],
        },
      ]).done;
      await settle();
    });
    expect(hook.result.current).toBe('Changed');
  });

  it('lets a grid observe row data without rendering its surrounding screen on each edit', async () => {
    const session = await open();
    const rendered = vi.fn();
    const hook = renderHook(() => {
      rendered();
      return useViewRows(session, fixture.viewId, undefined, 'structure');
    });
    await act(settle);
    const rows = hook.result.current!;
    const changed = vi.fn();
    const unsubscribe = rows.subscribe(changed);
    rendered.mockClear();
    await act(async () => {
      session.run([
        {
          kind: 'record.update',
          tableId: fixture.tableId,
          records: [{ id: fixture.recordId(0), values: { [fixture.textFieldId]: 'Changed' } }],
        },
      ]);
      await settle();
    });
    expect(rows.getRow(0)?.values[fixture.textFieldId]).toBe('Changed');
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ rows: [0, 1] }));
    expect(rendered).not.toHaveBeenCalled();
    await act(async () => {
      await session.run([
        { kind: 'record.create', tableId: fixture.tableId, records: [{ id: newId('record'), values: {} }] },
      ]).done;
      await settle();
    });
    expect(rendered).toHaveBeenCalled();
    unsubscribe();
  });

  it('shares a database session across consumers and releases it after the final unmount', async () => {
    const session = await open();
    const close = vi.spyOn(session, 'close');
    vi.mocked(openDatabase).mockResolvedValue(session);
    const a = renderHook(() => useDatabaseSession(fixture.databaseId));
    const b = renderHook(() => useDatabaseSession(fixture.databaseId));
    await act(settle);
    expect(a.result.current).toBe(session);
    expect(b.result.current).toBe(session);
    expect(openDatabase).toHaveBeenCalledTimes(1);
    a.unmount();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(close).not.toHaveBeenCalled();
    b.unmount();
    const replacement = renderHook(() => useDatabaseSession(fixture.databaseId));
    await act(settle);
    expect(replacement.result.current).toBe(session);
    expect(openDatabase).toHaveBeenCalledTimes(1);
    replacement.unmount();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('survives strict effect remounting and closes a session that finishes opening after unmount', async () => {
    const session = await open();
    const close = vi.spyOn(session, 'close');
    let resolve!: (session: DatabaseSession) => void;
    vi.mocked(openDatabase).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const rendered = renderHook(() => useDatabaseSession(fixture.databaseId), {
      wrapper: ({ children }) => createElement(StrictMode, null, children),
    });
    expect(openDatabase).toHaveBeenCalledTimes(1);
    rendered.unmount();
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(async () => {
      resolve(session);
      await settle();
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('subscribes to rows, schema, saving, peers, and events and changes event handlers', async () => {
    const session = await open();
    const first = vi.fn(),
      second = vi.fn();
    const hook = renderHook(
      ({ handler }) => {
        const schema = useSchema(session),
          rows = useViewRows(session, fixture.viewId),
          save = useSaveState(session),
          peers = usePeers(session);
        useSessionEvents(session, handler);
        return { schema, rows, save, peers, value: rows?.getRow(0)?.values[fixture.textFieldId] };
      },
      { initialProps: { handler: first } },
    );
    await act(settle);
    expect(hook.result.current.value).toBe('Record 1');
    await act(async () => {
      await session.run([
        {
          kind: 'record.update',
          tableId: fixture.tableId,
          records: [{ id: fixture.recordId(0), values: { [fixture.textFieldId]: 'Changed' } }],
        },
      ]).done;
      await settle();
    });
    expect(hook.result.current.value).toBe('Changed');
    expect(hook.result.current.save).toEqual({ status: 'saved', pending: 0 });
    const peer = {
      clientId: newId('client'),
      userId: newId('user'),
      name: 'Peer',
      color: 'blue' as const,
      where: null,
    };
    await act(async () => {
      server.remote(fixture.databaseId, [{ kind: 'database.update', name: 'Updated' }]);
      server.send({ type: 'presence', databaseId: fixture.databaseId, peers: [peer] });
      await settle();
    });
    expect(hook.result.current.schema?.database.name).toBe('Updated');
    expect(hook.result.current.peers).toEqual([peer]);
    hook.rerender({ handler: second });
    await act(async () => {
      server.rejectNext('data.test.rejected');
      await session.run([{ kind: 'database.update', name: 'Rejected' }]).done;
      await settle();
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'rejected', messageKey: 'data.test.rejected' }),
    );
    hook.unmount();
    expect(server.messages.findLast((message) => message.type === 'watch')).toMatchObject({ snapshot: null });
  });

  it('opens and closes views when the requested view changes and provides stable empty snapshots', async () => {
    const session = await open();
    const other = newId('view');
    await session.run([
      { kind: 'view.create', view: { id: other, tableId: fixture.tableId, name: 'Other', type: 'grid' } },
    ]).done;
    await settle();
    const hook = renderHook(({ id }: { id: string | null }) => useViewRows(session, id), {
      initialProps: { id: fixture.viewId as string | null },
    });
    await act(settle);
    const original = hook.result.current!;
    hook.rerender({ id: other });
    await act(settle);
    expect(hook.result.current?.viewId).toBe(other);
    expect(hook.result.current).not.toBe(original);
    hook.rerender({ id: null });
    expect(hook.result.current).toBeNull();
    auth.id = '';
    const empty = renderHook(() => ({
      session: useDatabaseSession(null),
      schema: useSchema(null),
      save: useSaveState(null),
      peers: usePeers(null),
    }));
    expect(empty.result.current).toEqual({
      session: null,
      schema: null,
      save: { status: 'idle', pending: 0 },
      peers: [],
    });
  });
});
