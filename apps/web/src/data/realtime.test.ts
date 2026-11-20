import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '@riosoma/contracts';
import { openDatabase } from './session';
import { FakeServer } from './testing';
import type { FakeFixture } from './testing';
import type { DatabaseSession, SessionEvent, ViewRows } from './types';

async function settle(): Promise<void> {
  for (let index = 0; index < 100; index++) await Promise.resolve();
}
let server: FakeServer, fixture: FakeFixture, session: DatabaseSession, view: ViewRows;
beforeEach(async () => {
  vi.useFakeTimers();
  server = new FakeServer();
  fixture = server.createDatabase();
  session = await openDatabase(fixture.databaseId, server.deps());
  view = session.openView(fixture.viewId);
  await settle();
});
afterEach(() => {
  session.close();
  vi.useRealTimers();
});
const edit = (value: string) => ({
  kind: 'record.update' as const,
  tableId: fixture.tableId,
  records: [{ id: fixture.recordId(0), values: { [fixture.textFieldId]: value } }],
});
const value = () => view.getRow(0)?.values[fixture.textFieldId];

describe('ordered realtime delivery', () => {
  it('updates a person in place without reloading records or the schema', async () => {
    const requests = server.requests.length;
    server.send({
      type: 'personChanged',
      person: {
        id: server.userId,
        name: 'Updated person',
        email: 'person@example.test',
        pictureUrl: `/api/people/${server.userId}/picture?v=1`,
        deactivated: true,
      },
    });
    await settle();
    expect(session.getSchema().collaborators.get(server.userId)).toMatchObject({
      name: 'Updated person',
      pictureUrl: `/api/people/${server.userId}/picture?v=1`,
      deactivated: true,
    });
    expect(value()).toBe('Record 1');
    expect(server.requests).toHaveLength(requests);
  });

  it('applies a shuffled stream strictly in order and ignores duplicates before and after recovery', async () => {
    const applied: number[] = [];
    session.subscribe(() => applied.push(session.getSchema().seq));
    server.pauseChanges();
    server.remote(fixture.databaseId, [edit('One'), edit('Two'), edit('Three')]);
    const socket = [...server.sockets][0]!,
      changes = server.changes(fixture.databaseId);
    socket.deliver({ type: 'change', change: changes[2]! });
    socket.deliver({ type: 'change', change: changes[2]! });
    await settle();
    expect(session.getSchema().seq).toBe(0);
    expect(value()).toBe('Record 1');
    socket.deliver({ type: 'change', change: changes[0]! });
    await settle();
    expect(session.getSchema().seq).toBe(1);
    expect(value()).toBe('One');
    socket.deliver({ type: 'change', change: changes[1]! });
    await settle();
    expect(applied).toEqual([1, 2, 3]);
    expect(value()).toBe('Three');
    server.resumeChanges();
    await settle();
    expect(applied).toEqual([1, 2, 3]);
    expect(
      server.messages.filter((message) => message.type === 'subscribe').map((message) => message.sinceSeq),
    ).toEqual([0, 0, 1]);
  });

  it('recovers a missing tail when caughtUp reports a newer sequence', async () => {
    server.pauseChanges();
    server.remote(fixture.databaseId, [edit('Tail')]);
    const socket = [...server.sockets][0]!;
    socket.deliver({ type: 'caughtUp', databaseId: fixture.databaseId, seq: 1 });
    await settle();
    expect(server.messages.filter((message) => message.type === 'subscribe')).toHaveLength(2);
    server.resumeChanges();
    await settle();
    expect(session.getSchema().seq).toBe(1);
    expect(value()).toBe('Tail');
  });

  it('converges when a later remote write arrives before the local echo', async () => {
    server.pauseChanges();
    await session.run([edit('Local')]).done;
    await settle();
    server.remote(fixture.databaseId, [edit('Remote last')]);
    const changes = server.changes(fixture.databaseId),
      socket = [...server.sockets][0]!;
    socket.deliver({ type: 'change', change: changes[1]! });
    await settle();
    expect(value()).toBe('Local');
    socket.deliver({ type: 'change', change: changes[0]! });
    await settle();
    expect(value()).toBe('Remote last');
    server.resumeChanges();
    await settle();
    expect(value()).toBe('Remote last');
  });

  it('keeps undo waiting after the HTTP answer until the ordered echo arrives', async () => {
    server.pauseChanges();
    await session.run([edit('Local')]).done;
    const undo = session.undo();
    await settle();
    expect(server.requests.filter((request) => request.path.endsWith('/undo'))).toHaveLength(0);
    server.resumeChanges();
    await undo;
    await settle();
    expect(value()).toBe('Record 1');
  });

  it('buffers changes during a schema reload and rebases pending edits on the new schema', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.afterRequest = (request) => (request.path.endsWith('/schema') ? held : Promise.resolve());
    server.send({ type: 'reload', databaseId: fixture.databaseId, reason: 'accessChanged' });
    await settle();
    server.remote(fixture.databaseId, [
      { kind: 'table.update', tableId: fixture.tableId, name: 'Remote table' },
      edit('Remote'),
    ]);
    await settle();
    server.pauseChanges();
    await session.run([edit('Pending')]).done;
    await settle();
    expect(value()).toBe('Pending');
    release();
    await settle();
    expect(session.getSchema().tableById.get(fixture.tableId)?.name).toBe('Remote table');
    expect(value()).toBe('Pending');
    server.resumeChanges();
    await settle();
    expect(session.getSchema().seq).toBe(3);
    expect(value()).toBe('Pending');
  });

  it('retries a failed schema reload without losing the request', async () => {
    server.database(fixture.databaseId).schema.database.name = 'Reloaded';
    server.failNext(503, '/schema');
    server.send({ type: 'reload', databaseId: fixture.databaseId, reason: 'tooFarBehind' });
    await settle();
    expect(session.saveState().status).toBe('error');
    await vi.advanceTimersByTimeAsync(1100);
    await settle();
    expect(session.getSchema().database.name).toBe('Reloaded');
  });
});

describe('when the server drops the subscription because access changed', () => {
  function watchEvents(): SessionEvent[] {
    const events: SessionEvent[] = [];
    session.subscribeEvents((event) => events.push(event));
    return events;
  }
  const refusals = (events: SessionEvent[]) => events.filter((event) => event.kind === 'rejected');
  const socket = () => [...server.sockets][0]!;

  it('announces access invalidation before reading the schema even when the grid refresh fails', async () => {
    const events = watchEvents();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.beforeRequest = (request) => (request.path.endsWith('/schema') ? held : Promise.resolve());
    vi.spyOn(view, 'refresh').mockRejectedValue(new Error('disconnected'));
    server.dropSubscriptions(fixture.databaseId, 'accessChanged');
    await settle();
    const beforeSchema = [...events];
    release();
    await settle();
    expect(beforeSchema).toContainEqual({ kind: 'reloading', reason: 'accessChanged' });
    expect(events).not.toContainEqual({ kind: 'reloaded', reason: 'accessChanged' });
    expect(session.saveState().status).toBe('offline');
  });

  it('subscribes again before it watches its view or says where it is, so the server refuses neither', async () => {
    const events = watchEvents();
    session.setPresence({ tableId: fixture.tableId, viewId: fixture.viewId });
    await vi.advanceTimersByTimeAsync(200);
    const from = server.messages.length;
    server.dropSubscriptions(fixture.databaseId, 'accessChanged');
    await settle();
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    const sent = server.messages.slice(from).map((message) => message.type);
    expect(sent[0]).toBe('subscribe');
    expect(sent).toContain('watch');
    // The server forgot where the tab was along with its subscription, so it hears again.
    expect(sent).toContain('presence');
    expect(events).toContainEqual({ kind: 'reloaded', reason: 'accessChanged' });
    expect(refusals(events)).toEqual([]);
  });

  it('keeps quiet about a watch refused before the tab heard, and still offers records entering the view', async () => {
    const events = watchEvents();
    server.dropSubscriptions(fixture.databaseId, 'accessChanged');
    // A watch the tab sent just before it heard of the reload is refused as not found.
    socket().deliver({ type: 'error', messageKey: 'errors.notFound' });
    await settle();
    expect(events).toContainEqual({ kind: 'reloaded', reason: 'accessChanged' });
    expect(refusals(events)).toEqual([]);

    server.remote(fixture.databaseId, [
      { kind: 'record.create', tableId: fixture.tableId, records: [{ id: newId('record'), values: {} }] },
    ]);
    await settle();
    expect(view.prompts().entered).toBe(1);

    // Once the subscription is back, the server's "not found" means what it says.
    socket().deliver({ type: 'error', messageKey: 'errors.notFound' });
    await settle();
    expect(refusals(events)).toEqual([{ kind: 'rejected', messageKey: 'errors.notFound' }]);
  });

  it('reads again when access changes once more while the views read', async () => {
    const events = watchEvents();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = true;
    server.beforeRequest = (request) => {
      if (!holding || !request.path.includes('/rows')) return Promise.resolve();
      holding = false;
      return held;
    };
    server.database(fixture.databaseId).schema.database.name = 'First';
    server.dropSubscriptions(fixture.databaseId, 'accessChanged');
    await settle();
    expect(session.getSchema().database.name).toBe('First');
    server.database(fixture.databaseId).schema.database.name = 'Second';
    server.dropSubscriptions(fixture.databaseId, 'accessChanged');
    await settle();
    release();
    await settle();
    await settle();
    expect(session.getSchema().database.name).toBe('Second');
    expect(events.filter((event) => event.kind === 'reloaded')).toHaveLength(1);
    expect(refusals(events)).toEqual([]);
    server.remote(fixture.databaseId, [
      { kind: 'record.create', tableId: fixture.tableId, records: [{ id: newId('record'), values: {} }] },
    ]);
    await settle();
    expect(view.prompts().entered).toBe(1);
  });
});

it('lists other tabs and removes a peer when its session closes', async () => {
  const second = await openDatabase(fixture.databaseId, server.deps());
  try {
    await settle();
    expect(session.peers()).toHaveLength(1);
    expect(second.peers()).toHaveLength(1);
    second.close();
    await settle();
    expect(session.peers()).toHaveLength(0);
  } finally {
    second.close();
  }
});
