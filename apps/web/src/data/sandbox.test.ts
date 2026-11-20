import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '@riosoma/contracts';
import type { Command } from '@riosoma/contracts';
import { api, ApiError } from '../api';
import { openDatabase } from './session';
import {
  beginSandbox,
  endSandbox,
  inSandbox,
  resetSandbox,
  SANDBOX_REFUSED,
  sandboxRefuses,
} from './sandbox';
import { FakeServer } from './testing';
import type { FakeFixture } from './testing';
import type { DatabaseSession, ViewRows } from './types';

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

let server: FakeServer, fixture: FakeFixture, session: DatabaseSession, view: ViewRows;
beforeEach(async () => {
  vi.useFakeTimers();
  server = new FakeServer();
  fixture = server.createDatabase(20);
  session = await openDatabase(fixture.databaseId, server.deps());
  view = session.openView(fixture.viewId);
  await settle();
});
afterEach(() => {
  endSandbox();
  view.close();
  session.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const edit = (value: string, index = 0) => ({
  kind: 'record.update' as const,
  tableId: fixture.tableId,
  records: [{ id: fixture.recordId(index), values: { [fixture.textFieldId]: value } }],
});
const shown = (index = 0) => view.getRow(index)?.values[fixture.textFieldId];
const saved = (index = 0) =>
  server.database(fixture.databaseId).rows(fixture.tableId).get(fixture.recordId(index))?.values[
    fixture.textFieldId
  ];
/** Requests that could change something: anything but a read of rows or the schema */
const writes = () => server.requests.filter((request) => (request.options.method ?? 'GET') !== 'GET');

describe('the demo sandbox', () => {
  it('shows changes at once, then leaves the store, the server, undo, and realtime as they were', async () => {
    const schema = session.getSchema();
    const count = view.rowCount();
    const history = session.undoHistory();
    const requests = server.requests.length;
    const messages = server.messages.length;
    const commands = vi.fn();
    session.subscribeCommands?.(commands);
    const fieldId = newId('field');

    beginSandbox();
    expect(inSandbox()).toBe(true);
    const action = session.run([edit('Typed in a demo')]);
    session.run([
      {
        kind: 'record.create',
        tableId: fixture.tableId,
        records: [{ id: newId('record'), values: { [fixture.textFieldId]: 'A demo record' } }],
      },
    ]);
    session.run([
      {
        kind: 'field.create',
        tableId: fixture.tableId,
        field: { id: fieldId, name: 'Due date', type: 'date' },
        placement: { viewId: fixture.viewId, index: 0 },
      },
    ]);
    session.run([
      {
        kind: 'view.update',
        viewId: fixture.viewId,
        config: { sorts: [{ fieldId: fixture.textFieldId, direction: 'desc' }] },
      },
    ]);
    session.run([{ kind: 'table.update', tableId: fixture.tableId, name: 'Renamed in a demo' }]);
    session.setPresence({ tableId: fixture.tableId, viewId: fixture.viewId });
    expect(await session.undo()).toEqual({ nothing: true, skipped: 0 });
    expect(await action.done).toEqual({ applied: 1, rejected: 0 });
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();

    // Everything shows as it would.
    expect(shown()).toBe('Typed in a demo');
    expect(view.rowCount()).toBe(count + 1);
    expect(session.getSchema().fieldById.get(fieldId)?.name).toBe('Due date');
    expect(session.getSchema().tableById.get(fixture.tableId)?.name).toBe('Renamed in a demo');
    expect(session.getSchema().viewById.get(fixture.viewId)?.config.sorts).toEqual([
      { fieldId: fixture.textFieldId, direction: 'desc' },
    ]);
    // Nothing reached the server, the realtime connection, the outbox, undo, or the command bus.
    expect(server.requests.slice(requests).filter((request) => request.path.endsWith('/commands'))).toEqual(
      [],
    );
    expect(writes()).toEqual([]);
    expect(server.messages.slice(messages)).toEqual([]);
    expect(await server.outbox.load(server.userId, fixture.databaseId)).toEqual([]);
    expect(session.undoHistory()).toEqual(history);
    expect(session.canUndo()).toBe(false);
    expect(commands).not.toHaveBeenCalled();
    expect(saved()).toBe('Record 1');

    endSandbox();
    await settle();
    expect(inSandbox()).toBe(false);
    expect(session.getSchema()).toEqual(schema);
    expect(shown()).toBe('Record 1');
    expect(view.rowCount()).toBe(count);
    expect(writes()).toEqual([]);
    expect(server.messages.slice(messages)).toEqual([]);
    expect(session.undoHistory()).toEqual(history);
    expect(saved()).toBe('Record 1');

    // The session carries on as before once the demo is over.
    await vi.advanceTimersByTimeAsync(1_500);
    const real = session.run([edit('A real edit')]);
    await real.done;
    await settle();
    expect(saved()).toBe('A real edit');
    expect(session.canUndo()).toBe(true);
  });

  it('keeps changes made before a demo until it ends, then saves them', async () => {
    session.run([edit('Before the demo')]);
    beginSandbox();
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(writes()).toEqual([]);
    expect(shown()).toBe('Before the demo');
    endSandbox();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(saved()).toBe('Before the demo');
  });

  it('throws away a save that lands just after a demo, to something the demo changed', async () => {
    const sorted = (direction: 'asc' | 'desc') => [
      {
        kind: 'view.update' as const,
        viewId: fixture.viewId,
        config: { sorts: [{ fieldId: fixture.textFieldId, direction }] },
      },
    ];
    beginSandbox();
    session.run(sorted('desc'));
    endSandbox();
    // A control that saves after a pause in typing fires once the page is back.
    session.run(sorted('desc'));
    session.run([edit('Someone’s own edit', 1)]);
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(session.getSchema().viewById.get(fixture.viewId)?.config.sorts).toEqual([]);
    expect(writes().flatMap((request) => (request.options.body as { commands: Command[] }).commands)).toEqual(
      [expect.objectContaining({ kind: 'record.update' })],
    );
    // Later, the same change is the person's own.
    await vi.advanceTimersByTimeAsync(1_500);
    session.run(sorted('asc'));
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(session.getSchema().viewById.get(fixture.viewId)?.config.sorts).toEqual([
      { fieldId: fixture.textFieldId, direction: 'asc' },
    ]);
  });

  it('starts over empty when a demo steps back', async () => {
    beginSandbox();
    session.run([edit('First pass')]);
    expect(shown()).toBe('First pass');
    resetSandbox();
    await settle();
    expect(inSandbox()).toBe(true);
    expect(shown()).toBe('Record 1');
    session.run([edit('Second pass')]);
    expect(shown()).toBe('Second pass');
    endSandbox();
    await settle();
    expect(shown()).toBe('Record 1');
  });

  it('refuses anything but a read at the network layer, before it leaves the browser', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    beginSandbox();
    await expect(
      api('/api/databases/db1/commands', { method: 'POST', body: { commands: [] } }),
    ).rejects.toMatchObject({ status: 409, info: { messageKey: SANDBOX_REFUSED } });
    await expect(api('/api/me/preferences', { method: 'PATCH', body: {} })).rejects.toBeInstanceOf(ApiError);
    expect(fetch).not.toHaveBeenCalled();
    // Reads still go out, including the few that ask their question with POST.
    await api('/api/databases/db1/schema');
    await api('/api/views/viw1/search', { method: 'POST', body: { query: 'a' } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sandboxRefuses('DELETE', '/api/views/viw1/search')).toBe(true);
    expect(sandboxRefuses('POST', '/api/tables/tbl1/records/names?x=1')).toBe(false);
    endSandbox();
    await api('/api/databases/db1/commands', { method: 'POST', body: { commands: [] } });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
