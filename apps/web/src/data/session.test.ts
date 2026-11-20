import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '@riosoma/contracts';
import type { Command, ServerMessage } from '@riosoma/contracts';
import { openDatabase, recoverDatabaseSessions } from './session';
import { SchemaModel } from './state';
import { FakeServer } from './testing';
import type { FakeFixture } from './testing';
import type { CommentChange, DatabaseSession, SessionEvent, ViewRows } from './types';
import { MemoryOutboxStore } from './outbox';
import type { ApiOptions } from '../api';
import { session as signedIn } from '../screens/database/share/testing';

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
function gate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  return {
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}
let server: FakeServer, fixture: FakeFixture, session: DatabaseSession, view: ViewRows;
const sessions: DatabaseSession[] = [];
beforeEach(async () => {
  vi.useFakeTimers();
  server = new FakeServer();
  fixture = server.createDatabase(1000);
  session = await openDatabase(fixture.databaseId, server.deps());
  sessions.push(session);
  view = session.openView(fixture.viewId);
  await settle();
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  vi.useRealTimers();
});
const edit = (value: string, index = 0) => ({
  kind: 'record.update' as const,
  tableId: fixture.tableId,
  records: [{ id: fixture.recordId(index), values: { [fixture.textFieldId]: value } }],
});
const value = (index = 0) => view.getRow(index)?.values[fixture.textFieldId];
const serverValue = (index = 0) =>
  server.database(fixture.databaseId).rows(fixture.tableId).get(fixture.recordId(index))?.values[
    fixture.textFieldId
  ];

describe('authentication recovery', () => {
  async function retained() {
    const identity = { ...signedIn, user: { ...signedIn.user, id: server.userId } };
    const database = await openDatabase(
      fixture.databaseId,
      server.deps({
        http: async <T>(path: string, options?: ApiOptions): Promise<T> =>
          path === '/api/auth/session' ? (identity as T) : server.http<T>(path, options),
      }),
    );
    sessions.push(database);
    server.failNext(401, '/commands');
    database.run([edit('Retained draft')]);
    await settle();
    expect(database.saveState().status).toBe('error');
    return { identity, database };
  }

  it('rechecks access once, keeps draft values, and waits for an explicit retry', async () => {
    const { identity, database } = await retained();
    const before = server.requests.length;
    const handshakes = server.messages.filter((message) => message.type === 'hello').length;
    await Promise.all([recoverDatabaseSessions(identity), recoverDatabaseSessions(identity)]);
    await settle();
    expect(server.messages.filter((message) => message.type === 'hello')).toHaveLength(handshakes + 1);
    expect(server.requests.slice(before).filter((request) => request.path.endsWith('/schema'))).toHaveLength(
      1,
    );
    expect(serverValue()).toBe('Record 1');
    expect(database.saveState()).toEqual({ status: 'error', pending: 1, retryRequired: true });
    server.onlineTarget.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(serverValue()).toBe('Record 1');
    database.retrySave?.();
    await settle();
    expect(serverValue()).toBe('Retained draft');
    expect(database.saveState()).toEqual({ status: 'saved', pending: 0 });
  });

  it.each([403, 404])('keeps writes blocked when renewed access is refused with %i', async (status) => {
    const { identity, database } = await retained();
    const events: SessionEvent[] = [];
    database.subscribeEvents((event) => events.push(event));
    server.failNext(status, '/schema');
    await recoverDatabaseSessions(identity);
    database.retrySave?.();
    database.run([edit('Still private')]);
    await settle();
    expect(serverValue()).toBe('Record 1');
    expect(events.filter((event) => event.kind === 'accessLost')).toHaveLength(1);
    expect(server.requests.filter((request) => request.path.endsWith('/commands'))).toHaveLength(1);
  });

  it('keeps drafts blocked after a failed access check and allows another recovery attempt', async () => {
    const { identity, database } = await retained();
    server.failNext(503, '/schema');
    await expect(recoverDatabaseSessions(identity)).rejects.toMatchObject({ status: 503 });
    database.retrySave?.();
    await settle();
    expect(serverValue()).toBe('Record 1');
    await recoverDatabaseSessions(identity);
    database.retrySave?.();
    await settle();
    expect(serverValue()).toBe('Retained draft');
  });
});

describe('optimistic state and persistence', () => {
  it('shows browser connection loss immediately and keeps queued edits until reconnect', async () => {
    server.onlineTarget.dispatchEvent(new Event('offline'));
    expect(session.saveState()).toEqual({ status: 'offline', pending: 0 });
    const action = session.run([edit('Queued 東京 🦋')]);
    await settle();
    expect(session.saveState()).toEqual({ status: 'offline', pending: 1 });
    expect(serverValue()).toBe('Record 1');
    expect(await server.outbox.load(server.userId, fixture.databaseId)).toHaveLength(1);
    server.onlineTarget.dispatchEvent(new Event('online'));
    await action.done;
    await settle();
    expect(serverValue()).toBe('Queued 東京 🦋');
    expect(session.saveState()).toEqual({ status: 'saved', pending: 0 });
  });

  it('keeps the offline indicator when an in-flight save answers after connection loss', async () => {
    const answer = gate();
    server.afterRequest = (request) => (request.path.endsWith('/commands') ? answer.wait : Promise.resolve());
    const action = session.run([edit('In flight')]);
    await settle();
    server.onlineTarget.dispatchEvent(new Event('offline'));
    answer.release();
    await action.done;
    await settle();
    expect(session.saveState()).toEqual({ status: 'offline', pending: 0 });
    server.onlineTarget.dispatchEvent(new Event('online'));
    await settle();
    expect(session.saveState()).toEqual({ status: 'saved', pending: 0 });
    expect(server.changes(fixture.databaseId)).toHaveLength(1);
  });

  it('starts an already disconnected session offline and removes its browser listeners on close', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const target = new EventTarget();
    const remove = vi.spyOn(target, 'removeEventListener');
    try {
      const disconnected = await openDatabase(fixture.databaseId, server.deps({ onlineTarget: target }));
      sessions.push(disconnected);
      expect(disconnected.saveState()).toEqual({ status: 'offline', pending: 0 });
      const action = disconnected.run([edit('Disconnected')]);
      await settle();
      expect(serverValue()).toBe('Record 1');
      target.dispatchEvent(new Event('online'));
      await action.done;
      disconnected.close();
      expect(remove.mock.calls.map(([name]) => name)).toEqual(['online', 'offline', 'pagehide']);
    } finally {
      online.mockRestore();
    }
  });

  it('keeps a queued copy out of undo history until completion and lets earlier edits undo after cancellation', async () => {
    const another = await openDatabase(
      fixture.databaseId,
      server.deps({
        http: async <T>(path: string, options: ApiOptions = {}) => {
          const payload = options.body as { commands: Command[] } | undefined;
          if (path.endsWith('/commands') && payload?.commands[0]?.kind === 'table.duplicate')
            return {
              results: payload.commands.map((command) => ({
                id: command.id,
                status: 'applied',
                output: { jobId: newId('job'), tableId: newId('table') },
              })),
            } as T;
          return server.http<T>(path, options);
        },
      }),
    );
    sessions.push(another);
    await another.run([edit('Earlier edit')]).done;
    const copy = another.run([
      {
        kind: 'table.duplicate',
        tableId: fixture.tableId,
        newTableId: newId('table'),
        name: 'Background copy',
        withRecords: true,
      },
    ]);
    await copy.done;
    await settle();
    expect(another.undoHistory().undo.map((entry) => entry.groupId)).not.toContain(copy.groupId);
    expect(another.saveState().pending).toBe(0);
    expect(await another.undo()).toEqual({ nothing: false, skipped: 0 });
    another.adoptAction?.(copy.groupId, { kind: 'table.duplicate', count: 1, name: 'Background copy' });
    expect(another.undoHistory().undo.map((entry) => entry.groupId)).toEqual([copy.groupId]);
  });
  it('keeps a text edit’s starting value in the durable command sent to the server', async () => {
    const blocked = gate();
    server.beforeRequest = (request) =>
      request.path.endsWith('/commands') ? blocked.wait : Promise.resolve();
    session.run([
      {
        ...edit('Local'),
        records: [
          {
            id: fixture.recordId(0),
            values: { [fixture.textFieldId]: 'Local' },
            baseValues: { [fixture.textFieldId]: 'Record 1' },
          },
        ],
      },
    ]);
    await settle();
    const stored = await server.outbox.load(server.userId, fixture.databaseId);
    expect(stored[0]!.command).toMatchObject({
      records: [{ baseValues: { [fixture.textFieldId]: 'Record 1' } }],
    });
    blocked.release();
    await settle();
    expect(server.requests.find((request) => request.path.endsWith('/commands'))?.options.body).toMatchObject(
      {
        commands: [{ records: [{ baseValues: { [fixture.textFieldId]: 'Record 1' } }] }],
      },
    );
  });
  it('shows an edit synchronously, stores before sending, and converges after confirmation', async () => {
    const blocked = gate();
    server.beforeRequest = (request) =>
      request.path.endsWith('/commands') ? blocked.wait : Promise.resolve();
    const action = session.run([edit('Local')]);
    expect(value()).toBe('Local');
    expect(session.saveState()).toEqual({ status: 'saving', pending: 1 });
    await settle();
    const stored = await server.outbox.load(server.userId, fixture.databaseId);
    expect(stored).toHaveLength(1);
    expect(serverValue()).toBe('Record 1');
    blocked.release();
    await action.done;
    await settle();
    expect(value()).toBe(serverValue());
    expect(session.saveState()).toEqual({ status: 'saved', pending: 0 });
    expect(await server.outbox.load(server.userId, fixture.databaseId)).toEqual([]);
  });
  it('validates the entire action before applying anything and normalizes cell values', async () => {
    expect(() =>
      session.run([
        edit('Changed'),
        {
          kind: 'record.update',
          tableId: fixture.tableId,
          records: [{ id: fixture.recordId(1), values: { [fixture.numberFieldId]: 'bad' } }],
        },
      ]),
    ).toThrow();
    expect(value()).toBe('Record 1');
    expect(session.canUndo()).toBe(false);
    const action = session.run([edit('')]);
    expect(view.getRow(0)?.values[fixture.textFieldId]).toBeNull();
    await action.done;
  });
  it('rolls back only the rejected command and emits its message key', async () => {
    server.rejectNext('data.value.rejected');
    const events: SessionEvent[] = [];
    session.subscribeEvents((event) => events.push(event));
    const action = session.run([edit('Rejected'), edit('Accepted', 1)]);
    expect(value()).toBe('Rejected');
    expect(await action.done).toEqual({ applied: 1, rejected: 1 });
    await settle();
    expect(value()).toBe('Record 1');
    expect(value(1)).toBe('Accepted');
    expect(events).toContainEqual({ kind: 'rejected', messageKey: 'data.value.rejected', params: undefined });
  });
  it('marks a refusal handled when the caller shows it in place', async () => {
    server.rejectNext('data.value.rejected');
    const events: SessionEvent[] = [];
    session.subscribeEvents((event) => events.push(event));
    await session.run([edit('Rejected')], { handlesRefusal: true }).done;
    expect(events).toContainEqual({
      kind: 'rejected',
      handled: true,
      messageKey: 'data.value.rejected',
      params: undefined,
    });
  });
  it('rebases remote changes without covering pending edits, including the same cell', async () => {
    const blocked = gate();
    server.beforeRequest = (request) =>
      request.path.endsWith('/commands') ? blocked.wait : Promise.resolve();
    const action = session.run([edit('Local')]);
    await settle();
    server.remote(fixture.databaseId, [
      {
        kind: 'record.update',
        tableId: fixture.tableId,
        records: [
          {
            id: fixture.recordId(0),
            values: { [fixture.numberFieldId]: 42, [fixture.textFieldId]: 'Remote first' },
          },
        ],
      },
    ]);
    await settle();
    expect(value()).toBe('Local');
    expect(view.getRow(0)?.values[fixture.numberFieldId]).toBe(42);
    blocked.release();
    await action.done;
    await settle();
    server.remote(fixture.databaseId, [edit('Remote last')]);
    await settle();
    expect(value()).toBe('Remote last');
    expect(value()).toBe(serverValue());
  });
  it('keeps an answered command visible until its realtime confirmation arrives', async () => {
    server.pauseChanges();
    const action = session.run([edit('Pending echo')]);
    await action.done;
    await settle();
    expect(value()).toBe('Pending echo');
    server.resumeChanges();
    await settle();
    expect(value()).toBe(serverValue());
  });
  it('sends at most 100 commands in order with only one request in flight', async () => {
    const blocked = gate();
    let active = 0,
      maximum = 0;
    server.beforeRequest = async (request) => {
      if (request.path.endsWith('/commands')) {
        maximum = Math.max(maximum, ++active);
        await blocked.wait;
      }
    };
    server.afterRequest = async (request) => {
      if (request.path.endsWith('/commands')) active--;
    };
    const action = session.run(Array.from({ length: 205 }, (_, index) => edit(String(index))));
    await settle();
    expect(server.requests.filter((request) => request.path.endsWith('/commands'))).toHaveLength(1);
    blocked.release();
    await action.done;
    await settle();
    const batches = server.requests
      .filter((request) => request.path.endsWith('/commands'))
      .map((request) => (request.options.body as { commands: Command[] }).commands);
    expect(batches.map((commands) => commands.length)).toEqual([100, 100, 5]);
    expect(maximum).toBe(1);
    expect(value()).toBe('204');
  });
  it('survives offline, retries in order, and deduplicates a lost response', async () => {
    server.goOffline();
    await settle();
    const first = session.run([edit('First')]);
    const second = session.run([edit('Second')]);
    await settle();
    expect(session.saveState()).toEqual({ status: 'offline', pending: 2 });
    expect(
      (await server.outbox.load(server.userId, fixture.databaseId)).map((entry) => entry.command.groupId),
    ).toEqual([first.groupId, second.groupId]);
    server.loseNextResponse();
    server.goOnline();
    await settle();
    expect(session.saveState().status).toBe('offline');
    expect(serverValue()).toBe('Second');
    await vi.advanceTimersByTimeAsync(1100);
    await first.done;
    await second.done;
    await settle();
    expect(server.changes(fixture.databaseId)).toHaveLength(2);
    expect(session.saveState().status).toBe('saved');
  });
  it('classifies server errors, retries, and stops sending after a 401', async () => {
    server.failNext(503, '/commands');
    const action = session.run([edit('Retry')]);
    await settle();
    expect(session.saveState().status).toBe('error');
    await vi.advanceTimersByTimeAsync(1100);
    await action.done;
    server.failNext(401, '/commands');
    session.run([edit('Keep')]);
    await settle();
    const sent = server.requests.length;
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(server.requests).toHaveLength(sent);
    expect(session.saveState().pending).toBe(1);
    expect(await server.outbox.load(server.userId, fixture.databaseId)).toHaveLength(1);
  });
  it('loads the same IDs from the outbox and isolates different users', async () => {
    server.goOffline();
    await settle();
    session.run([edit('Restored')]);
    await settle();
    const entries = await server.outbox.load(server.userId, fixture.databaseId);
    session.close();
    server.offline = false;
    const blocked = gate();
    server.beforeRequest = (request) =>
      request.path.endsWith('/commands') ? blocked.wait : Promise.resolve();
    const restored = await openDatabase(fixture.databaseId, server.deps());
    sessions.push(restored);
    const rows = restored.openView(fixture.viewId);
    await settle();
    expect(rows.getRow(0)?.values[fixture.textFieldId]).toBe('Restored');
    expect(await server.outbox.load(newId('user'), fixture.databaseId)).toEqual([]);
    blocked.release();
    await settle();
    expect(server.changes(fixture.databaseId)[0]?.commandId).toBe(entries[0]?.command.id);
    expect(restored.saveState().pending).toBe(0);
  });
  it('preserves commands when the view closes before the first sending microtask', async () => {
    session.run([edit('Persist')]);
    session.close();
    await settle();
    expect(await server.outbox.load(server.userId, fixture.databaseId)).toHaveLength(1);
  });
  it('keeps a change made just before the page goes away', async () => {
    const answer = gate();
    server.beforeRequest = (request) =>
      request.path.endsWith('/commands') ? answer.wait : Promise.resolve();
    const store = new MemoryOutboxStore();
    const original = store.put.bind(store);
    const blocked = gate();
    vi.spyOn(store, 'put').mockImplementation(async (entries) => {
      await blocked.wait;
      await original(entries);
    });
    const leaving = await openDatabase(fixture.databaseId, server.deps({ outbox: store }));
    sessions.push(leaving);
    leaving.run([edit('Left behind')]);
    await settle();
    // The store is still waiting, as one whose transaction hasn't committed is, and the page goes.
    server.onlineTarget.dispatchEvent(new Event('pagehide'));
    leaving.close();
    const restored = await openDatabase(fixture.databaseId, server.deps({ outbox: store }));
    sessions.push(restored);
    const rows = restored.openView(fixture.viewId);
    await settle();
    expect(rows.getRow(0)?.values[fixture.textFieldId]).toBe('Left behind');
    expect(await store.load(server.userId, fixture.databaseId)).toHaveLength(1);
    answer.release();
    await settle();
    expect(serverValue()).toBe('Left behind');
    expect(await store.load(server.userId, fixture.databaseId)).toEqual([]);
  });
  it('does not send until a slow outbox commits and retries storage failures', async () => {
    const store = new MemoryOutboxStore();
    const original = store.put.bind(store);
    const blocked = gate();
    vi.spyOn(store, 'put').mockImplementationOnce(async (entries) => {
      await blocked.wait;
      await original(entries);
    });
    const another = await openDatabase(fixture.databaseId, server.deps({ outbox: store }));
    sessions.push(another);
    const before = server.requests.filter((request) => request.path.endsWith('/commands')).length;
    const action = another.run([edit('Durable')]);
    await settle();
    expect(server.requests.filter((request) => request.path.endsWith('/commands'))).toHaveLength(before);
    blocked.release();
    await action.done;
    vi.spyOn(store, 'put').mockRejectedValueOnce(new Error('errors.storage'));
    const retry = another.run([edit('Retry storage')]);
    await settle();
    expect(another.saveState().status).toBe('error');
    await vi.advanceTimersByTimeAsync(1100);
    await retry.done;
  });
});

describe('undo and redo', () => {
  it('undoes a named action while keeping later edits and their history', async () => {
    const original = value();
    const copy = session.run([edit('Earlier action')]);
    await copy.done;
    const later = session.run([edit('Later edit', 1)]);
    await later.done;
    expect(await session.undo(copy.groupId)).toEqual({ nothing: false, skipped: 0 });
    await settle();
    expect(value()).toBe(original);
    expect(serverValue(1)).toBe('Later edit');
    expect(session.undoHistory().undo.map((entry) => entry.groupId)).toEqual([later.groupId]);
    await session.redo();
    await settle();
    expect(value()).toBe('Earlier action');
  });
  it.each(['undo', 'redo'] as const)(
    'keeps a fully refused %s available when no inverse was recorded',
    async (direction) => {
      let refuse = false;
      const another = await openDatabase(
        fixture.databaseId,
        server.deps({
          http: async <T>(path: string, options = {}) =>
            refuse && path.endsWith(`/${direction}`)
              ? ({ status: 'nothing', state: direction === 'undo' ? 'done' : 'undone', skipped: 1 } as T)
              : server.http<T>(path, options),
        }),
      );
      sessions.push(another);
      const events: SessionEvent[] = [];
      another.subscribeEvents((event) => events.push(event));
      await another.run([edit('Changed')]).done;
      if (direction === 'redo') await another.undo();
      const before = another.undoHistory();
      refuse = true;
      expect(await another[direction]()).toEqual({ nothing: true, skipped: 1 });
      expect(another.undoHistory()).toEqual(before);
      expect(events).toContainEqual({ kind: 'undoSkipped', skipped: 1 });
      refuse = false;
      expect(await another[direction]()).toEqual({ nothing: false, skipped: 0 });
    },
  );

  it('waits for confirmation and undoes and redoes a whole action', async () => {
    const blocked = gate();
    server.beforeRequest = (request) =>
      request.path.endsWith('/commands') ? blocked.wait : Promise.resolve();
    const action = session.run([edit('First'), edit('Second', 1)]);
    const undo = session.undo();
    await settle();
    expect(server.requests.some((request) => request.path.endsWith('/undo'))).toBe(false);
    blocked.release();
    await action.done;
    expect(await undo).toEqual({ nothing: false, skipped: 0 });
    await settle();
    expect(value()).toBe('Record 1');
    expect(value(1)).toBe('Record 2');
    expect(session.canRedo()).toBe(true);
    await session.redo();
    await settle();
    expect(value()).toBe('First');
    expect(value(1)).toBe('Second');
  });
  it('retains confirmed undo and redo history when the same tab reloads', async () => {
    const deps = server.deps({ clientId: newId('client') });
    const first = await openDatabase(fixture.databaseId, deps);
    sessions.push(first);
    await first.run([edit('Saved edit')]).done;
    const history = first.undoHistory();
    first.close();
    const reloaded = await openDatabase(fixture.databaseId, deps);
    sessions.push(reloaded);
    expect(reloaded.undoHistory()).toEqual(history);
    expect(await reloaded.undo()).toEqual({ nothing: false, skipped: 0 });
    expect(serverValue()).toBe('Record 1');
    const undone = reloaded.undoHistory();
    reloaded.close();
    const again = await openDatabase(fixture.databaseId, deps);
    sessions.push(again);
    expect(again.undoHistory()).toEqual(undone);
    expect(await again.redo()).toEqual({ nothing: false, skipped: 0 });
    expect(serverValue()).toBe('Saved edit');
  });
  it('keeps field-owned table changes out of the asks-first history mark', async () => {
    const fieldId = newId('field');
    const childId = newId('table');
    const action = session.run([
      {
        kind: 'field.create',
        tableId: fixture.tableId,
        field: {
          id: fieldId,
          name: 'Lines',
          type: 'lineItems',
          options: {
            linkedTableId: childId,
            columns: [{ id: newId('field'), name: 'Description', type: 'text' }],
          },
        },
      },
    ]);
    await action.done;
    const change = server.changes(fixture.databaseId).at(-1)!;
    server.send({
      type: 'change',
      change: {
        ...change,
        seq: change.seq + 1,
        kind: 'table.created',
        table: {
          ...server.database(fixture.databaseId).schema.tables[0]!,
          id: childId,
          lineItems: { parentTableId: fixture.tableId, parentFieldId: fieldId },
        },
        fields: [],
        views: [],
        records: [],
      },
    });
    await settle();
    expect(session.undoHistory().undo[0]?.groupId).toBe(action.groupId);
    expect(session.undoHistory().undo[0]?.summary.asksFirst).toBeUndefined();
  });
  it('restores a pending edit once in the history when the same tab reconnects after a reload', async () => {
    const deps = server.deps({ clientId: newId('client') });
    const first = await openDatabase(fixture.databaseId, deps);
    sessions.push(first);
    server.goOffline();
    await settle();
    const action = first.run([edit('Pending edit')]);
    await settle();
    first.close();
    server.offline = false;
    const restored = await openDatabase(fixture.databaseId, deps);
    sessions.push(restored);
    await settle();
    expect(restored.undoHistory().undo.map((entry) => entry.groupId)).toEqual([action.groupId]);
    expect(await restored.undo()).toEqual({ nothing: false, skipped: 0 });
    expect(serverValue()).toBe('Record 1');
    expect(restored.undoHistory().undo).toEqual([]);
  });
  it('skips remotely changed cells and clears redo on a new action', async () => {
    const events: SessionEvent[] = [];
    session.subscribeEvents((event) => events.push(event));
    await session.run([edit('Local'), edit('Other', 1)]).done;
    await settle();
    server.remote(fixture.databaseId, [edit('Remote')]);
    await settle();
    expect(await session.undo()).toEqual({ nothing: false, skipped: 1 });
    await settle();
    expect(value()).toBe('Remote');
    expect(value(1)).toBe('Record 2');
    expect(events).toContainEqual({ kind: 'undoSkipped', skipped: 1 });
    await session.run([edit('New action', 2)]).done;
    expect(session.canRedo()).toBe(false);
  });
  it('disables history while offline and keeps only 100 actions', async () => {
    for (let index = 0; index < 101; index++) await session.run([edit(String(index))]).done;
    await settle();
    for (let index = 0; index < 100; index++) await session.undo();
    expect(session.canUndo()).toBe(false);
    server.goOffline();
    await settle();
    expect(session.canRedo()).toBe(false);
    expect(await session.undo()).toEqual({ nothing: true, skipped: 0 });
  });
});

describe('record comments and history', () => {
  const comment = (body: string, index = 0) => ({
    kind: 'comment.create' as const,
    tableId: fixture.tableId,
    recordId: fixture.recordId(index),
    comment: { id: newId('comment'), body },
  });
  it('sends a comment as a change, but keeps it out of undo', async () => {
    const changes: CommentChange[] = [];
    session.subscribeComments((change) => changes.push(change));
    const written = comment('Noted');
    await session.run([written]).done;
    await settle();
    const thread = server.database(fixture.databaseId).commentsOn(written.tableId, written.recordId);
    expect(thread.map((item) => item.body)).toEqual(['Noted']);
    expect(changes.map((change) => change.kind)).toEqual(['comment.created']);
    // A conversation isn't a value to put back, so undo leaves it alone.
    expect(session.canUndo()).toBe(false);
    expect(await session.undo()).toEqual({ nothing: true, skipped: 0 });
    await expect(session.comments(written.tableId, written.recordId)).resolves.toEqual({
      comments: thread,
    });
  });
  it('edits and removes a comment, telling whoever is listening', async () => {
    const changes: CommentChange[] = [];
    session.subscribeComments((change) => changes.push(change));
    const written = comment('Before');
    await session.run([written]).done;
    await session.run([{ kind: 'comment.update', commentId: written.comment.id, body: 'After' }]).done;
    await session.run([{ kind: 'comment.delete', commentId: written.comment.id }]).done;
    await settle();
    expect(changes.map((change) => change.kind)).toEqual([
      'comment.created',
      'comment.updated',
      'comment.deleted',
    ]);
    expect(await session.comments(written.tableId, written.recordId)).toEqual({ comments: [] });
  });
  it('reads a record’s history a page at a time', async () => {
    const recordId = fixture.recordId(0);
    expect(await session.history(fixture.tableId, recordId)).toEqual({ entries: [], next: null });
    expect(server.requests.at(-1)?.path).toBe(`/api/tables/${fixture.tableId}/records/${recordId}/history`);
    await session.history(fixture.tableId, recordId, 'a page&more');
    expect(server.requests.at(-1)?.path).toBe(
      `/api/tables/${fixture.tableId}/records/${recordId}/history?cursor=a%20page%26more`,
    );
  });
});

describe('realtime', () => {
  it('leaves a revoked database when its schema refresh returns not found', async () => {
    const events: SessionEvent[] = [];
    session.subscribeEvents((event) => events.push(event));
    server.failNext(404, '/schema');
    server.send({ type: 'reload', databaseId: fixture.databaseId, reason: 'accessChanged' });
    await settle();
    expect(events).toContainEqual({ kind: 'accessLost' });
    expect(session.saveState().status).toBe('error');
    const subscriptions = server.messages.filter((message) => message.type === 'subscribe').length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.messages.filter((message) => message.type === 'subscribe')).toHaveLength(subscriptions);
  });

  it('keeps access after a temporary schema refresh failure', async () => {
    const events: SessionEvent[] = [];
    session.subscribeEvents((event) => events.push(event));
    server.failNext(500, '/schema');
    server.send({ type: 'reload', databaseId: fixture.databaseId, reason: 'accessChanged' });
    await settle();
    expect(events).not.toContainEqual({ kind: 'accessLost' });
    expect(value()).toBe('Record 1');
  });

  it('recovers sequence gaps and ignores duplicate changes', async () => {
    server.pauseChanges();
    server.remote(fixture.databaseId, [edit('One')]);
    server.remote(fixture.databaseId, [edit('Two')]);
    const changes = server.changes(fixture.databaseId);
    const socket = [...server.sockets][0]!;
    socket.deliver({ type: 'change', change: changes[1]! });
    await settle();
    expect(session.getSchema().seq).toBe(0);
    server.resumeChanges();
    await settle();
    expect(session.getSchema().seq).toBe(2);
    expect(value()).toBe('Two');
    socket.deliver({ type: 'change', change: changes[0]! });
    await settle();
    expect(value()).toBe('Two');
    expect(server.messages.filter((message) => message.type === 'subscribe')).toHaveLength(2);
  });
  it('reloads schema and views and handles access and trash notifications', async () => {
    const events: SessionEvent[] = [];
    session.subscribeEvents((event) => events.push(event));
    server.database(fixture.databaseId).schema.database.name = 'Updated';
    server.send({ type: 'reload', databaseId: fixture.databaseId, reason: 'tooFarBehind' });
    await settle();
    expect(session.getSchema().database.name).toBe('Updated');
    expect(events).toContainEqual({ kind: 'reloaded', reason: 'tooFarBehind' });
    server.send({ type: 'reload', databaseId: fixture.databaseId, reason: 'trashed' });
    await settle();
    expect(events).toContainEqual({ kind: 'trashed' });
  });
  it('updates source labels without reloading rows or subscriptions', async () => {
    const id = newId('field');
    const choiceId = newId('choice');
    const schema = server.database(fixture.databaseId).schema;
    schema.fields.push({
      ...schema.fields[0]!,
      id,
      name: 'Source choice',
      type: 'singleSelect',
      options: { source: { tableId: newId('table') }, choices: [] },
    });
    const reader = await openDatabase(fixture.databaseId, server.deps());
    sessions.push(reader);
    const rows = reader.openView(fixture.viewId);
    await settle();
    const row = rows.getRow(0);
    const requests = server.requests.length;
    server.send({
      type: 'selectOptions',
      databaseId: fixture.databaseId,
      fields: [
        { fieldId: id, choices: [{ id: choiceId, name: 'Renamed', color: 'gray' }], truncated: false },
      ],
    } as unknown as ServerMessage);
    await settle();
    expect(reader.getSchema().fieldById.get(id)).toMatchObject({
      options: { choices: [{ id: choiceId, name: 'Renamed' }] },
    });
    expect(rows.getRow(0)).toEqual(row);
    expect(server.requests).toHaveLength(requests);
    const later = { id: newId('choice'), name: 'Later option', color: 'gray' as const };
    reader.rememberSelectChoices(id, [later]);
    await settle();
    const watches = () => server.messages.filter((message) => message.type === 'watchSelectOptions');
    expect(watches()).toMatchObject([{ fieldId: id, choiceIds: [later.id] }]);
    server.send({ type: 'caughtUp', databaseId: fixture.databaseId, seq: schema.seq });
    await settle();
    expect(watches()).toHaveLength(1);
    server.dropConnections();
    await settle();
    await vi.advanceTimersByTimeAsync(1100);
    await settle();
    expect(watches()).toHaveLength(2);
  });

  it('refreshes source choices without an interruption toast', async () => {
    const events: SessionEvent[] = [];
    session.subscribeEvents((event) => events.push(event));
    const schema = server.database(fixture.databaseId).schema;
    const id = newId('field');
    const choiceId = newId('choice');
    schema.fields.push({
      ...schema.fields[0]!,
      id,
      tableId: fixture.tableId,
      name: 'Source choice',
      position: 2,
      type: 'singleSelect',
      options: { choices: [{ id: choiceId, name: 'Renamed', color: 'gray' }] },
    });
    server.send({ type: 'reload', databaseId: fixture.databaseId, reason: 'selectOptionsChanged' });
    await settle();
    expect(session.getSchema().fieldById.get(id)).toMatchObject({
      options: { choices: [{ id: choiceId, name: 'Renamed' }] },
    });
    expect(events).toEqual([]);
  });
  it('refreshes external dependencies and open records outside the view without an interruption toast', async () => {
    const events: SessionEvent[] = [];
    session.subscribeEvents((event) => events.push(event));
    const recordId = fixture.recordId(999);
    await session.getRecord(fixture.tableId, recordId);
    const changed = vi.fn((ids: ReadonlySet<string>) => {
      if (ids.has(recordId)) void session.getRecord(fixture.tableId, recordId);
    });
    session.subscribeRecords(fixture.tableId, changed);
    server.pauseChanges();
    server.remote(fixture.databaseId, [edit('Updated dependency', 999)]);
    server.send({
      type: 'reload',
      databaseId: fixture.databaseId,
      reason: 'dependenciesChanged',
    } as unknown as ServerMessage);
    await settle();
    expect(session.cachedRecord(fixture.tableId, recordId)?.values[fixture.textFieldId]).toBe(
      'Updated dependency',
    );
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ size: expect.any(Number) }));
    expect(events).toEqual([]);
  });
  it('shares the socket between databases, reconnects, and pings', async () => {
    const sharedId = newId('client');
    const a = await openDatabase(fixture.databaseId, server.deps({ clientId: sharedId }));
    sessions.push(a);
    const second = server.createDatabase();
    const b = await openDatabase(second.databaseId, server.deps({ clientId: sharedId }));
    sessions.push(b);
    await settle();
    expect(server.sockets.size).toBe(2);
    a.close();
    expect(server.sockets.size).toBe(2);
    server.dropConnections();
    await settle();
    await vi.advanceTimersByTimeAsync(1100);
    await settle();
    expect(server.sockets.size).toBe(2);
    expect(
      server.messages.some(
        (message) => message.type === 'subscribe' && message.databaseId === second.databaseId,
      ),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(server.messages.some((message) => message.type === 'ping')).toBe(true);
  });
  it('throttles presence and excludes this tab', async () => {
    const initial = server.messages.filter((message) => message.type === 'presence').length;
    for (let index = 0; index < 10; index++)
      session.setPresence({ tableId: fixture.tableId, recordId: fixture.recordId(index) });
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(server.messages.filter((message) => message.type === 'presence')).toHaveLength(initial + 1);
    expect(session.peers()).toEqual([]);
    const peer: Extract<ServerMessage, { type: 'presence' }>['peers'][number] = {
      clientId: newId('client'),
      userId: newId('user'),
      name: 'Peer',
      color: 'green',
      where: null,
    };
    server.send({ type: 'presence', databaseId: fixture.databaseId, peers: [peer] });
    await settle();
    expect(session.peers()).toEqual([peer]);
  });
});

describe('save and history races', () => {
  it('keeps late command confirmations replayable when a session closes before their response', async () => {
    const deps = server.deps();
    const first = await openDatabase(fixture.databaseId, deps);
    sessions.push(first);
    const blocked = gate();
    server.afterRequest = (request) =>
      request.path.endsWith('/commands') ? blocked.wait : Promise.resolve();
    const action = first.run(Array.from({ length: 101 }, (_, index) => edit('Saved change', index)));
    await settle();
    expect(serverValue(99)).toBe('Saved change');
    first.close();
    blocked.release();
    await settle();
    server.afterRequest = undefined;
    server.rejectNext();
    const restored = await openDatabase(fixture.databaseId, deps);
    sessions.push(restored);
    await settle();
    expect(restored.undoHistory().undo.map((entry) => entry.groupId)).toEqual([action.groupId]);
    expect(await restored.undo()).toEqual({ nothing: false, skipped: 0 });
    expect(serverValue(99)).toBe('Record 100');
  });

  it('keeps redo cleared when a new edit arrives while undo waits for confirmation', async () => {
    const blocked = gate();
    server.beforeRequest = (request) =>
      request.path.endsWith('/commands') ? blocked.wait : Promise.resolve();
    const earlier = session.run([edit('Earlier edit')]);
    const reversal = session.undo();
    await settle();
    const later = session.run([edit('Newer edit', 1)]);
    blocked.release();
    await earlier.done;
    await later.done;
    await reversal;
    expect(session.undoHistory().undo.map((entry) => entry.groupId)).toEqual([later.groupId]);
    expect(session.undoHistory().redo).toEqual([]);
  });

  it.each(['undo', 'redo'] as const)(
    'reconciles a closed session’s late %s without replacing newer history',
    async (direction) => {
      const deps = server.deps();
      const first = await openDatabase(fixture.databaseId, deps);
      sessions.push(first);
      const earlier = first.run([edit('Earlier edit')]);
      await earlier.done;
      await settle();
      if (direction === 'redo') await first.undo();
      const blocked = gate();
      const recovery = gate();
      let requests = 0;
      server.beforeRequest = async (request) => {
        if (request.path.endsWith(`/${direction}`)) await (++requests === 1 ? blocked.wait : recovery.wait);
      };
      const reversal = first[direction]();
      await settle();
      first.close();
      const restored = await openDatabase(fixture.databaseId, deps);
      sessions.push(restored);
      const later = restored.run([edit('Newer edit', 1)]);
      await later.done;
      await settle();
      blocked.release();
      await reversal;
      await settle();
      recovery.release();
      await settle();
      const expected = direction === 'undo' ? [later.groupId] : [later.groupId, earlier.groupId];
      expect(restored.undoHistory().undo.map((entry) => entry.groupId)).toEqual(expected);
      expect(restored.undoHistory().redo).toEqual([]);
      restored.close();
      const again = await openDatabase(fixture.databaseId, deps);
      sessions.push(again);
      expect(again.undoHistory().undo.map((entry) => entry.groupId)).toEqual(expected);
      expect(await again.undo()).toEqual({ nothing: false, skipped: 0 });
      expect(serverValue(1)).toBe('Record 2');
    },
  );

  it.each([false, true])(
    'retains confirmed commands when a restored remainder is rejected with failed cleanup %s',
    async (failedCleanup) => {
      const deps = server.deps();
      const first = await openDatabase(fixture.databaseId, deps);
      sessions.push(first);
      server.beforeRequest = async (request) => {
        const body = request.options.body as { commands?: Command[] } | undefined;
        if (request.path.endsWith('/commands') && body?.commands?.length === 1) server.goOffline();
      };
      if (failedCleanup) {
        vi.spyOn(server.outbox, 'remove').mockRejectedValueOnce(new Error('errors.storage'));
        server.afterRequest = async (request) => {
          if (request.path.endsWith('/commands')) server.goOffline();
        };
      }
      const action = first.run(Array.from({ length: 101 }, (_, index) => edit('Saved change', index)));
      await settle();
      expect(serverValue(99)).toBe('Saved change');
      expect(await server.outbox.load(server.userId, fixture.databaseId)).toHaveLength(
        failedCleanup ? 101 : 1,
      );
      first.close();
      server.beforeRequest = undefined;
      server.afterRequest = undefined;
      server.offline = false;
      server.rejectNext();
      const restored = await openDatabase(fixture.databaseId, deps);
      sessions.push(restored);
      await settle();
      expect(restored.saveState().pending).toBe(0);
      expect(restored.undoHistory().undo.map((entry) => entry.groupId)).toEqual([action.groupId]);
      expect(restored.undoHistory().undo[0]?.summary.count).toBe(101);
      expect(await restored.undo()).toEqual({ nothing: false, skipped: 0 });
      expect(serverValue(0)).toBe('Record 1');
      expect(serverValue(99)).toBe('Record 100');
    },
  );

  it.each(['undo', 'redo'] as const)(
    'recovers a completed %s with a lost response after reload before enabling navigation',
    async (direction) => {
      const deps = server.deps();
      const first = await openDatabase(fixture.databaseId, deps);
      sessions.push(first);
      await first.run([edit('Saved edit')]).done;
      await settle();
      if (direction === 'redo') await first.undo();
      server.loseNextResponse();
      await expect(first[direction]()).rejects.toThrow();
      first.close();
      const blocked = gate();
      server.beforeRequest = (request) =>
        request.path.endsWith(`/${direction}`) ? blocked.wait : Promise.resolve();
      const restored = await openDatabase(fixture.databaseId, deps);
      sessions.push(restored);
      expect(restored.canUndo()).toBe(false);
      expect(restored.canRedo()).toBe(false);
      blocked.release();
      await settle();
      const requests = server.requests.filter((request) => request.path.endsWith(`/${direction}`));
      expect(requests).toHaveLength(2);
      expect(requests[1]?.options.body).toEqual(requests[0]?.options.body);
      expect(restored.undoHistory()[direction === 'undo' ? 'redo' : 'undo']).toHaveLength(1);
      expect(await restored[direction === 'undo' ? 'redo' : 'undo']()).toEqual({
        nothing: false,
        skipped: 0,
      });
      expect(serverValue()).toBe(direction === 'undo' ? 'Saved edit' : 'Record 1');
    },
  );

  it('persists new commands while an earlier request is still blocked', async () => {
    const blocked = gate();
    server.beforeRequest = (request) =>
      request.path.endsWith('/commands') ? blocked.wait : Promise.resolve();
    const first = session.run([edit('First')]);
    await settle();
    const second = session.run([edit('Second')]);
    await settle();
    const entries = await server.outbox.load(server.userId, fixture.databaseId);
    expect(entries.map((entry) => entry.command.groupId)).toEqual([first.groupId, second.groupId]);
    blocked.release();
    await first.done;
    await second.done;
  });

  it('exposes rolled-back values to rejection event listeners', async () => {
    server.rejectNext();
    let observed: unknown;
    session.subscribeEvents((event) => {
      if (event.kind === 'rejected') observed = value();
    });
    await session.run([edit('Rejected')]).done;
    expect(observed).toBe('Record 1');
  });

  it('settles a waiting undo when the session closes or goes offline', async () => {
    const blocked = gate();
    server.beforeRequest = (request) =>
      request.path.endsWith('/commands') ? blocked.wait : Promise.resolve();
    session.run([edit('Pending')]);
    const undo = session.undo();
    await settle();
    session.close();
    expect(await undo).toEqual({ nothing: true, skipped: 0 });
    expect(server.requests.some((request) => request.path.endsWith('/undo'))).toBe(false);
    blocked.release();
    await settle();
  });

  it('uses the same undo command ID after a lost response', async () => {
    await session.run([edit('Local')]).done;
    await settle();
    server.loseNextResponse();
    await expect(session.undo()).rejects.toThrow();
    await settle();
    server.goOnline();
    await settle();
    await session.undo();
    await settle();
    expect(value()).toBe('Record 1');
    expect(session.canRedo()).toBe(true);
    const requests = server.requests.filter((request) => request.path.endsWith('/undo'));
    expect(requests).toHaveLength(2);
    expect(requests[0]?.options.body).toEqual(requests[1]?.options.body);
  });

  it('keeps an edit optimistic when outbox cleanup fails and retries without reapplying it', async () => {
    vi.spyOn(server.outbox, 'remove').mockRejectedValueOnce(new Error('errors.storage'));
    await session.run([edit('Saved once')]).done;
    await settle();
    expect(session.saveState().status).toBe('error');
    expect(value()).toBe('Saved once');
    await vi.advanceTimersByTimeAsync(1100);
    await settle();
    expect(server.changes(fixture.databaseId)).toHaveLength(1);
    expect(await server.outbox.load(server.userId, fixture.databaseId)).toEqual([]);
  });
});

describe('the person’s own commands', () => {
  it('tells listeners what this tab runs, after it shows, but not undo or others’ changes', async () => {
    const heard: Command[][] = [];
    const stop = session.subscribeCommands!((commands) => {
      heard.push([...commands]);
      expect(value()).toBe('Mine');
    });
    const action = session.run([edit('Mine')]);
    expect(heard.map((commands) => commands.map((command) => command.kind))).toEqual([['record.update']]);
    expect(heard[0]![0]).toMatchObject({ tableId: fixture.tableId });
    await action.done;
    expect(await session.undo()).toEqual({ nothing: false, skipped: 0 });
    await settle();
    expect(value()).toBe('Record 1');
    expect(heard).toHaveLength(1);
    stop();
    session.run([edit('Unheard')]);
    expect(heard).toHaveLength(1);
  });

  it('keeps a change when a listener fails, and reports the failure afterward', async () => {
    const failure = new Error('A listener broke');
    const thrown: unknown[] = [];
    const original = globalThis.queueMicrotask.bind(globalThis);
    const queued = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((task) =>
      original(() => {
        try {
          task();
        } catch (error) {
          thrown.push(error);
        }
      }),
    );
    const stop = session.subscribeCommands!(() => {
      throw failure;
    });
    const action = session.run([edit('Kept')]);
    expect(value()).toBe('Kept');
    expect(thrown).toEqual([]);
    await settle();
    expect(thrown).toEqual([failure]);
    expect(await action.done).toEqual({ applied: 1, rejected: 0 });
    queued.mockRestore();
    stop();
  });
});

describe('the settings rows were read under', () => {
  it('keeps group source labels before the group records are loaded', async () => {
    const schema = server.database(fixture.databaseId).schema;
    const id = newId('field');
    const choice = { id: newId('choice'), name: 'Later group', color: 'gray' as const };
    schema.fields.push({
      ...schema.fields[0]!,
      id,
      name: 'Source choice',
      type: 'singleSelect',
      options: { source: { tableId: newId('table') }, choices: [] },
    });
    server.afterRequest = async (request, answer) => {
      if (request.path.includes('/rows?'))
        Object.assign(answer as object, { selectChoices: { [id]: [choice] } });
    };
    const reader = await openDatabase(fixture.databaseId, server.deps());
    sessions.push(reader);
    reader.openView(fixture.viewId);
    await settle();
    expect(reader.getSchema().fieldById.get(id)?.options).toMatchObject({ choices: [choice] });
  });

  it('follow the server’s filter, and stay with the old one until the rows are read again', async () => {
    const before = { filter: null, sorts: [] };
    const filter = {
      conjunction: 'and' as const,
      conditions: [{ id: 'first-five', fieldId: fixture.numberFieldId, operator: 'lt' as const, value: 5 }],
    };
    expect(session.settledView!(fixture.viewId)).toEqual(before);
    expect(view.settings!()).toEqual(before);
    server.pauseChanges();
    const action = session.run([{ kind: 'view.update', viewId: fixture.viewId, config: { filter } }]);
    // The view shows the filter at once, but until the server's copy comes back nothing read is sure
    // to follow it.
    expect(session.settledView!(fixture.viewId)).toBeUndefined();
    await action.done;
    await settle();
    expect(session.settledView!(fixture.viewId)).toBeUndefined();
    expect(view.settings!()).toEqual(before);
    expect(view.rowCount()).toBe(1000);
    server.resumeChanges();
    await settle();
    await settle();
    expect(session.settledView!(fixture.viewId)).toEqual({ filter, sorts: [] });
    expect(view.settings!()).toEqual({ filter, sorts: [] });
    expect(view.rowCount()).toBe(5);
  });
});

it('refreshes only a changed record when the table has a change log', async () => {
  const history = newId('field');
  await session.run([
    {
      kind: 'field.create',
      tableId: fixture.tableId,
      field: { id: history, name: 'Changes', type: 'changeLog', description: '', options: {} },
    },
  ]).done;
  await settle();
  const before = server.requests.length;
  await session.run([edit('Changed')]).done;
  await settle();
  await vi.advanceTimersByTimeAsync(100);
  const requests = server.requests.slice(before).map((request) => request.path);
  expect(requests).not.toContain(`/api/views/${fixture.viewId}/rows`);
  expect(requests.filter((path) => path.includes('/records/'))).toEqual([
    `/api/tables/${fixture.tableId}/records/history`,
  ]);
  expect(server.requests.at(-1)?.options.body).toEqual({ ids: [fixture.recordId(0)], fieldIds: [history] });
});

describe('batched change log refreshes', () => {
  let history: string;
  beforeEach(async () => {
    history = newId('field');
    await session.run([
      {
        kind: 'field.create',
        tableId: fixture.tableId,
        field: { id: history, name: 'Changes', type: 'changeLog', options: {} },
      },
    ]).done;
    await settle();
    server.requests.length = 0;
  });
  const reads = () => server.requests.filter((request) => request.path.includes('/records/'));

  it('debounces changed rows into one read with only history columns', async () => {
    for (let i = 0; i < 100; i++) server.remote(fixture.databaseId, [edit(`Changed ${i}`, i)]);
    await settle();
    expect(reads()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(reads()).toHaveLength(1);
    expect(reads()[0]?.options.body).toEqual({
      ids: Array.from({ length: 100 }, (_, i) => fixture.recordId(i)),
      fieldIds: [history],
    });
  });

  it('merges refreshed history without replacing other cached cell values', async () => {
    const entry = { at: '2026-01-15T20:30:00.000Z', actorId: server.userId, fieldIds: [fixture.textFieldId] };
    server.remote(fixture.databaseId, [edit('Current text')]);
    const rows = server.database(fixture.databaseId).rows(fixture.tableId);
    const row = rows.get(fixture.recordId(0))!;
    rows.set({ ...row, values: { ...row.values, [history]: [entry] } });
    await vi.advanceTimersByTimeAsync(100);
    expect(session.cachedRecord(fixture.tableId, row.id)?.values[history]).toEqual([entry]);
    expect(value()).toBe('Current text');
    expect(value(1)).toBe('Record 2');
  });

  it('skips history hidden in every open view', async () => {
    await session.run([
      { kind: 'view.update', viewId: fixture.viewId, config: { hiddenFieldIds: [history] } },
    ]).done;
    await settle();
    server.requests.length = 0;
    server.remote(fixture.databaseId, [edit('Hidden')]);
    await vi.advanceTimersByTimeAsync(100);
    expect(reads()).toHaveLength(0);
  });

  it('refreshes displayed record layouts until their history fields close', async () => {
    const unwatch = session.watchHistory!(fixture.tableId, fixture.recordId(0), [history]);
    view.close();
    server.remote(fixture.databaseId, [edit('Open record')]);
    await vi.advanceTimersByTimeAsync(100);
    expect(reads()).toHaveLength(1);
    unwatch();
    server.remote(fixture.databaseId, [edit('Closed record')]);
    await vi.advanceTimersByTimeAsync(100);
    expect(reads()).toHaveLength(1);
  });

  it('splits a thousand changed rows into sequential bounded reads', async () => {
    view.ensureRows(0, 1000);
    await settle();
    server.requests.length = 0;
    let active = 0;
    let maximum = 0;
    server.beforeRequest = async (request) => {
      if (request.path.endsWith('/records/history')) maximum = Math.max(maximum, ++active);
    };
    server.afterRequest = async (request) => {
      if (request.path.endsWith('/records/history')) active--;
    };
    server.remote(fixture.databaseId, [
      {
        kind: 'record.update',
        tableId: fixture.tableId,
        records: Array.from({ length: 1000 }, (_, i) => ({
          id: fixture.recordId(i),
          values: { [fixture.textFieldId]: `Changed ${i}` },
        })),
      },
    ]);
    await vi.advanceTimersByTimeAsync(300);
    expect(reads().map((request) => (request.options.body as { ids: string[] }).ids.length)).toEqual([
      500, 500,
    ]);
    expect(maximum).toBe(1);
  });

  it('coalesces changes during a read without retrying for unrelated rows', async () => {
    const blocked = gate();
    server.afterRequest = async (request) => {
      if (request.path.endsWith('/records/history')) await blocked.wait;
    };
    server.remote(fixture.databaseId, [edit('First')]);
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 20; i++) server.remote(fixture.databaseId, [edit(`Newer ${i}`)]);
    await vi.advanceTimersByTimeAsync(100);
    expect(reads()).toHaveLength(1);
    blocked.release();
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(reads()).toHaveLength(2);
    expect(value()).toBe('Newer 19');
    server.afterRequest = async (request) => {
      if (request.path.endsWith('/records/history'))
        server.remote(fixture.databaseId, [edit('Unloaded row', 999)]);
    };
    server.remote(fixture.databaseId, [edit('Last')]);
    await vi.advanceTimersByTimeAsync(300);
    expect(reads()).toHaveLength(3);
  });

  it('cancels a queued refresh when the session closes', async () => {
    server.remote(fixture.databaseId, [edit('Closing')]);
    await settle();
    session.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(reads()).toHaveLength(0);
  });
});
it.each(['field.updated', 'field.converted', 'field.restored'] as const)(
  'keeps resolved source labels after %s with the same source',
  (kind) => {
    const schema = server.database(fixture.databaseId).schema;
    const source = { tableId: newId('table') };
    const choice = { id: newId('choice'), name: 'Available', color: 'gray' as const };
    const field = {
      ...schema.fields[0]!,
      type: 'singleSelect' as const,
      options: { source, choices: [choice] },
    };
    const model = new SchemaModel({ ...schema, fields: [field] });
    model.apply({ kind, removedChoiceIds: [], field: { ...field, options: { source, choices: [] } } });
    expect(model.fields.get(field.id)?.options).toMatchObject({ choices: [choice] });
    model.apply({
      kind,
      removedChoiceIds: [],
      field: { ...field, options: { source: { tableId: newId('table') }, choices: [] } },
    });
    expect(model.fields.get(field.id)?.options).toMatchObject({ choices: [] });
  },
);
