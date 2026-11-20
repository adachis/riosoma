import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeWhere, newId } from '@riosoma/contracts';
import type { RowsPage } from '@riosoma/contracts';
import { ApiError } from '../api';
import { openDatabase } from './session';
import { FakeServer } from './testing';
import type { DatabaseSession, ViewRowsChange } from './types';

async function settle(): Promise<void> {
  for (let index = 0; index < 80; index++) await Promise.resolve();
}
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
const sessions: DatabaseSession[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  vi.useRealTimers();
});
async function setup(count = 1000) {
  const server = new FakeServer();
  const fixture = server.createDatabase(count);
  const session = await openDatabase(fixture.databaseId, server.deps());
  sessions.push(session);
  const view = session.openView(fixture.viewId);
  await settle();
  const requests = () => server.requests.filter((request) => request.path.includes('/rows?'));
  return { server, fixture, session, view, requests };
}

describe('snapshot paging', () => {
  it('includes a remote creation that commits before the first page starts watching its snapshot', async () => {
    const server = new FakeServer();
    const fixture = server.createDatabase(0);
    const blocked = gate();
    server.afterRequest = (request) =>
      request.path.includes('/rows?') && !request.path.includes('refresh=1')
        ? blocked.wait
        : Promise.resolve();
    const session = await openDatabase(fixture.databaseId, server.deps());
    sessions.push(session);
    const view = session.openView(fixture.viewId);
    await settle();
    const id = newId('record');
    server.remote(fixture.databaseId, [
      { kind: 'record.create', tableId: fixture.tableId, records: [{ id, values: {} }] },
    ]);
    await settle();
    blocked.release();
    await settle();
    await vi.advanceTimersByTimeAsync(350);
    await settle();
    expect(view.rowCount()).toBe(1);
    expect(view.getRow(0)?.id).toBe(id);
  });

  it('retries a failed refresh after a remote creation during initial loading', async () => {
    const server = new FakeServer();
    const fixture = server.createDatabase(0);
    const blocked = gate();
    server.afterRequest = (request) =>
      request.path.includes('/rows?') && !request.path.includes('refresh=1')
        ? blocked.wait
        : Promise.resolve();
    const session = await openDatabase(fixture.databaseId, server.deps());
    sessions.push(session);
    const view = session.openView(fixture.viewId);
    await settle();
    const id = newId('record');
    server.remote(fixture.databaseId, [
      { kind: 'record.create', tableId: fixture.tableId, records: [{ id, values: {} }] },
    ]);
    await settle();
    blocked.release();
    await settle();
    const snapshot = view.snapshotId?.();
    server.failNext(500, 'refresh=1');
    await vi.advanceTimersByTimeAsync(350);
    await settle();
    expect(view.rowCount()).toBe(0);
    expect(view.snapshotId?.()).toBe(snapshot);
    expect(session.saveState().status).toBe('error');
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(server.requests.filter(({ path }) => path.includes('refresh=1'))).toHaveLength(2);
    expect(view.snapshotId?.()).not.toBe(snapshot);
    expect(view.rowCount()).toBe(1);
    expect(view.getRow(0)?.id).toBe(id);
  });

  it.each([
    ['filter', 0],
    ['sort', 0],
    ['filter', 1],
    ['sort', 1],
    ['filter', 2],
    ['sort', 2],
  ] as const)(
    'refreshes %s membership and order after a named function changes with %i failed refreshes',
    async (setting, failures) => {
      const server = new FakeServer();
      const fixture = server.createDatabase(5);
      const database = server.database(fixture.databaseId);
      const functionId = newId('namedFunction');
      const computedId = newId('field');
      const definition = {
        id: functionId,
        databaseId: fixture.databaseId,
        name: 'MULTIPLY',
        parameters: ['amount'],
        body: 'amount',
        description: '',
        revision: 1,
        createdBy: server.userId,
        updatedBy: server.userId,
        createdAt: database.schema.database.createdAt,
        updatedAt: database.schema.database.createdAt,
      };
      database.schema.namedFunctions = [definition];
      server.remote(fixture.databaseId, [
        {
          kind: 'field.create',
          tableId: fixture.tableId,
          field: {
            id: computedId,
            name: 'Computed amount',
            type: 'formula',
            options: { expression: `MULTIPLY({${fixture.numberFieldId}})`, resultType: 'number' },
          },
        },
        {
          kind: 'view.update',
          viewId: fixture.viewId,
          config:
            setting === 'filter'
              ? {
                  filter: {
                    conjunction: 'and',
                    conditions: [{ id: 'large', fieldId: computedId, operator: 'gt', value: 4 }],
                  },
                }
              : { sorts: [{ fieldId: computedId, direction: 'asc' }] },
        },
      ]);
      database.rows(fixture.tableId).transform((row) => ({
        ...row,
        values: { ...row.values, [computedId]: row.values[fixture.numberFieldId]! },
      }));
      const session = await openDatabase(fixture.databaseId, server.deps());
      sessions.push(session);
      const view = session.openView(fixture.viewId);
      await settle();
      const snapshot = view.snapshotId?.();
      expect(snapshot).toEqual(expect.any(String));
      expect(view.rowCount()).toBe(setting === 'filter' ? 0 : 5);
      database.rows(fixture.tableId).transform((row) => ({
        ...row,
        values: { ...row.values, [computedId]: 8 - Number(row.values[fixture.numberFieldId]) },
      }));
      let failuresLeft = failures;
      server.beforeRequest = async ({ path }) => {
        if (path.includes('refresh=1') && failuresLeft > 0) {
          failuresLeft--;
          throw new ApiError(500, {
            code: 'internal',
            messageKey: 'errors.internal',
            userFault: false,
          });
        }
      };
      server.remoteChange(fixture.databaseId, {
        kind: 'namedFunction.changed',
        functionId,
        definition: { ...definition, body: '8 - amount', revision: 2 },
        fields: [database.field(computedId)],
      });
      await settle();
      if (failures) {
        expect(view.snapshotId?.()).toBe(snapshot);
        expect(session.saveState().status).toBe('error');
        await vi.advanceTimersByTimeAsync(10_000);
        await settle();
      }
      expect(server.requests.filter(({ path }) => path.includes('refresh=1'))).toHaveLength(failures + 1);
      expect(view.snapshotId?.()).not.toBe(snapshot);
      expect(view.rowCount()).toBe(setting === 'filter' ? 4 : 5);
      expect(view.getRow(0)?.id).toBe(fixture.recordId(setting === 'filter' ? 0 : 4));
      expect(view.getRow(0)?.values[computedId]).toBe(setting === 'filter' ? 8 : 4);
    },
  );

  it('refreshes group counts after a remote deletion outside the loaded page', async () => {
    const server = new FakeServer();
    const fixture = server.createDatabase(500);
    server.remote(fixture.databaseId, [
      {
        kind: 'view.update',
        viewId: fixture.viewId,
        config: { groups: [{ fieldId: fixture.textFieldId, direction: 'asc' }] },
      },
    ]);
    server.afterRequest = async (request, answer) => {
      if (!request.path.includes('/rows?')) return;
      const page = answer as RowsPage;
      const query = new URLSearchParams(request.path.split('?')[1]);
      if (!query.has('snapshot') || query.has('refresh') || page.rebuilt)
        page.groups = [
          {
            key: 'all',
            level: 1,
            start: 0,
            count: page.total,
            values: { [fixture.textFieldId]: 'Projects' },
            summaries: {},
          },
        ];
    };
    const session = await openDatabase(fixture.databaseId, server.deps());
    sessions.push(session);
    const view = session.openView(fixture.viewId);
    await settle();
    expect(view.groups?.()[0]?.count).toBe(500);
    view.ensureRows(200, 400);
    await settle();
    expect(view.groups?.()[0]?.count).toBe(500);
    server.remote(fixture.databaseId, [
      { kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.recordId(450)] },
    ]);
    await settle();
    await vi.advanceTimersByTimeAsync(350);
    await settle();
    expect(view.groups?.()[0]?.count).toBe(499);
    expect(view.rowCount()).toBe(499);
  });
  it('coalesces neighboring pages, deduplicates loaded and in-flight requests, and sends the snapshot and time zone', async () => {
    const { server, fixture, view, requests } = await setup();
    const blocked = gate();
    server.beforeRequest = (request) => (request.path.includes('/rows?') ? blocked.wait : Promise.resolve());
    view.ensureRows(200, 600);
    view.ensureRows(250, 500);
    await settle();
    view.ensureRows(0, 600);
    await settle();
    expect(requests()).toHaveLength(2);
    const query = new URL(requests()[1]!.path, 'http://localhost').searchParams;
    expect(query.get('offset')).toBe('200');
    expect(query.get('limit')).toBe('400');
    expect(query.get('snapshot')).toBe(server.messages.find((message) => message.type === 'watch')?.snapshot);
    expect(query.get('tz')).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    blocked.release();
    await settle();
    expect(view.getRow(599)?.id).toBe(fixture.recordId(599));
    view.ensureRows(0, 600);
    await settle();
    expect(requests()).toHaveLength(2);
  });

  it('keeps deleted snapshot positions when the server returns null rows', async () => {
    const { server, fixture, view, requests } = await setup();
    server.remote(fixture.databaseId, [
      {
        kind: 'record.trash',
        tableId: fixture.tableId,
        recordIds: [fixture.recordId(201), fixture.recordId(0)],
      },
    ]);
    await settle();
    view.ensureRows(200, 400);
    await settle();
    expect(view.rowCount()).toBe(1000);
    expect(view.getRow(0)?.id).toBe(fixture.recordId(0));
    expect(view.getRow(200)?.id).toBe(fixture.recordId(200));
    expect(view.getRow(201)).toBeUndefined();
    expect(view.getRow(202)?.id).toBe(fixture.recordId(202));
    expect(view.prompts().left).toEqual(new Set([fixture.recordId(0), fixture.recordId(201)]));
    view.ensureRows(200, 400);
    await settle();
    expect(requests()).toHaveLength(2);
  });

  it('drops old pages and emits a full change when the server rebuilds an expired snapshot', async () => {
    const { server, fixture, view } = await setup();
    const changes: ViewRowsChange[] = [];
    view.subscribe((change) => changes.push(change));
    server.remote(fixture.databaseId, [
      { kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.recordId(0)] },
    ]);
    await settle();
    server.expireSnapshots();
    view.ensureRows(400, 600);
    await settle();
    expect(view.rowCount()).toBe(999);
    expect(view.getRow(0)).toBeUndefined();
    expect(view.getRow(400)?.id).toBe(fixture.recordId(401));
    expect(changes).toContainEqual(expect.objectContaining({ rows: 'all', count: true }));
    expect(view.prompts().left.size).toBe(0);
  });

  it('refreshes with an anchor and ignores old requests still in flight', async () => {
    const { server, fixture, view } = await setup();
    const blocked = gate();
    let delayed = false;
    server.afterRequest = async (request) => {
      if (request.path.includes('offset=200') && !delayed) {
        delayed = true;
        await blocked.wait;
      }
    };
    view.ensureRows(200, 400);
    await settle();
    server.remote(fixture.databaseId, [
      { kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.recordId(0)] },
    ]);
    await settle();
    expect(await view.refresh(fixture.recordId(450))).toEqual({ anchorIndex: 449 });
    await settle();
    blocked.release();
    await settle();
    expect(view.rowCount()).toBe(999);
    expect(view.getRow(449)?.id).toBe(fixture.recordId(450));
    expect(view.getRow(200)).toBeUndefined();
    expect(view.prompts().left.size).toBe(0);
    expect(server.requests.find((request) => request.path.includes('/position?'))?.path).toContain('tz=');
  });

  it.each(['queued', 'in flight'])(
    'keeps requested pages through repeated reloads while %s',
    async (state) => {
      const { server, fixture, view } = await setup(20);
      const blocked = gate();
      server.beforeRequest = (request) =>
        request.path.includes('/rows?') ? blocked.wait : Promise.resolve();
      const reload = () => (view as unknown as { reloadRows(): void }).reloadRows();
      reload();
      if (state === 'in flight') await settle();
      reload();
      await settle();
      blocked.release();
      await settle();
      expect(view.getRow(0)?.id).toBe(fixture.recordId(0));
      expect(view.getRow(19)?.id).toBe(fixture.recordId(19));
    },
  );

  it('keeps the rows a refresh reads when a reload asks for them while it is in flight', async () => {
    const { server, fixture, view } = await setup(20);
    const blocked = gate();
    let held = false;
    server.afterRequest = async (request) => {
      if (request.path.includes('refresh=1') && !held) {
        held = true;
        await blocked.wait;
      }
    };
    server.remote(fixture.databaseId, [
      { kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.recordId(0)] },
    ]);
    await settle();
    const refreshed = view.refresh();
    await settle();
    (view as unknown as { reloadRows(): void }).reloadRows();
    blocked.release();
    await refreshed;
    await settle();
    expect(view.rowCount()).toBe(19);
    expect(view.getRow(0)?.id).toBe(fixture.recordId(1));
  });
  it('retries every failed requested page after reconnecting', async () => {
    const { server, fixture, view } = await setup();
    server.goOffline();
    await settle();
    view.ensureRows(200, 1000);
    await settle();
    server.goOnline();
    await settle();
    expect(view.getRow(250)?.id).toBe(fixture.recordId(250));
    expect(view.getRow(999)?.id).toBe(fixture.recordId(999));
  });

  it('rebases a page response over changes that arrived during the read and reports loaded ranges', async () => {
    const { server, fixture, session, view } = await setup();
    const blocked = gate();
    server.afterRequest = (request) => (request.path.includes('/rows?') ? blocked.wait : Promise.resolve());
    const changes: ViewRowsChange[] = [];
    view.subscribe((change) => changes.push(change));
    view.ensureRows(200, 400);
    await settle();
    server.remote(fixture.databaseId, [
      {
        kind: 'record.update',
        tableId: fixture.tableId,
        records: [{ id: fixture.recordId(250), values: { [fixture.textFieldId]: 'Remote' } }],
      },
    ]);
    await settle();
    blocked.release();
    await settle();
    expect(view.getRow(250)?.values[fixture.textFieldId]).toBe('Remote');
    const notified = vi.fn();
    session.subscribeRecords(fixture.tableId, notified);
    await session.run([
      {
        kind: 'record.update',
        tableId: fixture.tableId,
        records: [{ id: fixture.recordId(250), values: { [fixture.numberFieldId]: 123 } }],
      },
    ]).done;
    await settle();
    expect(changes).toContainEqual({ rows: [250, 251] });
    expect(notified).toHaveBeenCalledWith(new Set([fixture.recordId(250)]));
  });
});

describe('sparse row overlays', () => {
  it('places own inserts immediately and restores deleted records to their original positions through undo and redo', async () => {
    const { fixture, session, view } = await setup();
    const id = newId('record');
    const create = session.run(
      [{ kind: 'record.create', tableId: fixture.tableId, records: [{ id, values: {} }] }],
      { placeAt: { viewId: fixture.viewId, index: 2 } },
    );
    expect(view.rowCount()).toBe(1001);
    expect(view.getRow(2)?.id).toBe(id);
    expect(view.getRow(3)?.id).toBe(fixture.recordId(2));
    await create.done;
    await settle();
    const trash = session.run([
      { kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.recordId(0), id] },
    ]);
    expect(view.rowCount()).toBe(999);
    expect(view.getRow(0)?.id).toBe(fixture.recordId(1));
    await trash.done;
    await session.undo();
    await settle();
    expect(view.rowCount()).toBe(1001);
    expect(view.getRow(0)?.id).toBe(fixture.recordId(0));
    expect(view.getRow(2)?.id).toBe(id);
    await session.redo();
    await settle();
    expect(view.rowCount()).toBe(999);
  });

  it('rolls back rejected structural commands without disturbing subsequent inserts', async () => {
    const { server, fixture, session, view } = await setup();
    const rejectedId = newId('record'),
      acceptedId = newId('record');
    server.rejectNext();
    const first = session.run(
      [{ kind: 'record.create', tableId: fixture.tableId, records: [{ id: rejectedId, values: {} }] }],
      { placeAt: { viewId: fixture.viewId, index: 0 } },
    );
    const second = session.run(
      [{ kind: 'record.create', tableId: fixture.tableId, records: [{ id: acceptedId, values: {} }] }],
      { placeAt: { viewId: fixture.viewId, index: 0 } },
    );
    await first.done;
    await second.done;
    await settle();
    expect(view.rowCount()).toBe(1001);
    expect(view.getRow(0)?.id).toBe(acceptedId);
    expect(view.getRow(1)?.id).toBe(fixture.recordId(0));
    server.rejectNext();
    const trash = session.run([
      { kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.recordId(0)] },
    ]);
    expect(view.rowCount()).toBe(1000);
    await trash.done;
    await settle();
    expect(view.rowCount()).toBe(1001);
    expect(view.getRow(1)?.id).toBe(fixture.recordId(0));
  });

  it('shows remote changes as prompts and clears them on refresh', async () => {
    const { server, fixture, view } = await setup();
    const id = newId('record');
    server.remote(fixture.databaseId, [
      { kind: 'record.create', tableId: fixture.tableId, records: [{ id, values: {} }] },
      { kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.recordId(0)] },
    ]);
    await settle();
    const watch = server.messages.findLast((message) => message.type === 'watch' && message.snapshot);
    if (watch?.type !== 'watch' || !watch.snapshot) throw new Error('data.test.watchMissing');
    server.send({
      type: 'viewDelta',
      databaseId: fixture.databaseId,
      viewId: fixture.viewId,
      snapshot: watch.snapshot,
      entered: [id],
      left: [],
      moved: [fixture.recordId(1)],
    });
    await settle();
    expect(view.rowCount()).toBe(1000);
    expect(view.prompts()).toEqual({ entered: 1, left: new Set([fixture.recordId(0)]), orderChanged: true });
    await view.refresh();
    await settle();
    expect(view.prompts()).toEqual({ entered: 0, left: new Set(), orderChanged: false });
    expect(view.getRow(0)?.id).toBe(fixture.recordId(1));
  });

  it('never counts a record added here as someone else’s, even after another change to it', async () => {
    const { server, fixture, session, view } = await setup();
    const id = newId('record');
    await session.run([{ kind: 'record.create', tableId: fixture.tableId, records: [{ id, values: {} }] }], {
      placeAt: { viewId: fixture.viewId, index: 1000 },
    }).done;
    await settle();
    // An automation, say, fills in a value, and the view's delta then names the record as entered.
    server.remote(fixture.databaseId, [
      {
        kind: 'record.update',
        tableId: fixture.tableId,
        records: [{ id, values: { [fixture.numberFieldId]: 7 } }],
      },
    ]);
    await settle();
    const watch = server.messages.findLast((message) => message.type === 'watch' && message.snapshot);
    if (watch?.type !== 'watch' || !watch.snapshot) throw new Error('data.test.watchMissing');
    server.send({
      type: 'viewDelta',
      databaseId: fixture.databaseId,
      viewId: fixture.viewId,
      snapshot: watch.snapshot,
      entered: [id],
      left: [],
      moved: [],
    });
    await settle();
    expect(view.rowCount()).toBe(1001);
    expect(view.prompts().entered).toBe(0);
  });

  it('supports a million rows without generating unseen records and keeps only nearby pages', async () => {
    const { server, fixture, session, view, requests } = await setup(1_000_000);
    const records = server.database(fixture.databaseId).rows(fixture.tableId);
    expect(view.rowCount()).toBe(1_000_000);
    expect(records.generated).toBe(200);
    view.ensureRows(999_800, 1_000_000);
    await settle();
    expect(requests()).toHaveLength(2);
    expect(records.generated).toBe(400);
    expect(view.getRow(999_999)?.id).toBe(fixture.recordId(999_999));
    const id = newId('record');
    const action = session.run(
      [{ kind: 'record.create', tableId: fixture.tableId, records: [{ id, values: {} }] }],
      { placeAt: { viewId: fixture.viewId, index: 900_000 } },
    );
    expect(view.rowCount()).toBe(1_000_001);
    expect(view.getRow(900_000)?.id).toBe(id);
    expect(view.getRow(1_000_000)?.id).toBe(fixture.recordId(999_999));
    await action.done;
    await settle();
    view.ensureRows(900_001, 920_201);
    await settle();
    expect(view.getRow(0)).toBeUndefined();
    expect(view.getRow(1_000_000)).toBeUndefined();
    expect(session.cachedRecord(fixture.tableId, fixture.recordId(0))).toBeUndefined();
    expect(view.getRow(900_201)?.id).toBe(fixture.recordId(900_200));
    expect(records.generated).toBeLessThan(21_000);
  });

  it('retains hidden positions through eviction and reloads their rows on undo', async () => {
    const { fixture, session, view } = await setup(30_000);
    await session.run([{ kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.recordId(10)] }])
      .done;
    await settle();
    view.ensureRows(2000, 23_000);
    await settle();
    expect(view.rowCount()).toBe(29_999);
    await session.undo();
    await settle();
    expect(view.rowCount()).toBe(30_000);
    view.ensureRows(0, 200);
    await settle();
    expect(view.getRow(10)?.id).toBe(fixture.recordId(10));
  });

  it('handles multiple changes from one undo command', async () => {
    const { fixture, session, view } = await setup();
    await session.run([
      { kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.recordId(0)] },
      { kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.recordId(2)] },
    ]).done;
    await settle();
    expect(view.rowCount()).toBe(998);
    await session.undo();
    await settle();
    expect(view.rowCount()).toBe(1000);
    expect(view.getRow(2)?.id).toBe(fixture.recordId(2));
  });

  it('does not duplicate a restored outbox insert already included in a fresh snapshot', async () => {
    const { server, fixture, session } = await setup();
    server.loseNextResponse();
    const id = newId('record');
    session.run([{ kind: 'record.create', tableId: fixture.tableId, records: [{ id, values: {} }] }]);
    await settle();
    session.close();
    const blocked = gate();
    server.beforeRequest = (request) =>
      request.path.endsWith('/commands') ? blocked.wait : Promise.resolve();
    const next = await openDatabase(fixture.databaseId, server.deps());
    sessions.push(next);
    const view = next.openView(fixture.viewId);
    await settle();
    expect(view.rowCount()).toBe(1001);
    blocked.release();
    await settle();
    expect(view.rowCount()).toBe(1001);
  });

  it('does not let a canceled read clear a new request for the same page', async () => {
    const { server, view, requests } = await setup();
    const first = gate(),
      second = gate();
    let count = 0;
    server.afterRequest = async (request, answer) => {
      if (request.path.includes('/rows?') && (answer as RowsPage).offset === 200)
        await (++count === 1 ? first.wait : second.wait);
    };
    view.ensureRows(200, 400);
    await settle();
    await view.refresh();
    view.ensureRows(200, 400);
    await settle();
    first.release();
    await settle();
    view.ensureRows(200, 400);
    await settle();
    expect(requests().filter((request) => request.path.includes('offset=200'))).toHaveLength(2);
    second.release();
    await settle();
  });
});

it('keeps its rows while a refresh is out, then shows the fresh read all at once', async () => {
  const { server, fixture, view } = await setup();
  server.remote(fixture.databaseId, [
    { kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.recordId(0)] },
  ]);
  await settle();
  const changes: ViewRowsChange[] = [];
  view.subscribe((change) => changes.push(change));
  const blocked = gate();
  server.afterRequest = (request) => (request.path.includes('refresh=1') ? blocked.wait : Promise.resolve());
  const refresh = view.refresh();
  await settle();
  // Nothing blanks while the request is out, so a row that stays keeps its menu and its focus.
  expect(changes).toEqual([]);
  expect(view.getRow(0)?.id).toBe(fixture.recordId(0));
  expect(view.indexOf(fixture.recordId(1))).toBe(1);
  blocked.release();
  await refresh;
  expect(changes).toContainEqual(expect.objectContaining({ rows: 'all', count: true }));
  expect(view.rowCount()).toBe(999);
  expect(view.getRow(0)?.id).toBe(fixture.recordId(1));
  expect(view.prompts().left.size).toBe(0);
});

it('keeps an own insertion that commits while a refresh response is delayed', async () => {
  const { server, fixture, session, view } = await setup();
  const blocked = gate();
  server.afterRequest = (request) => (request.path.includes('refresh=1') ? blocked.wait : Promise.resolve());
  const refresh = view.refresh();
  await settle();
  const id = newId('record');
  await session.run([{ kind: 'record.create', tableId: fixture.tableId, records: [{ id, values: {} }] }], {
    placeAt: { viewId: fixture.viewId, index: 2 },
  }).done;
  await settle();
  blocked.release();
  await refresh;
  await settle();
  expect(view.rowCount()).toBe(1001);
  expect(view.getRow(2)?.id).toBe(id);
});

it('re-anchors on the visible record when an expired snapshot rebuilds', async () => {
  const { server, fixture, view } = await setup();
  server.remote(fixture.databaseId, [
    { kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.recordId(0)] },
  ]);
  await settle();
  server.expireSnapshots();
  view.ensureRows(10, 400);
  await settle();
  expect(view.indexOf(fixture.recordId(10))).toBe(9);
  expect(view.getRow(9)?.id).toBe(fixture.recordId(10));
  expect(server.requests.find((request) => request.path.includes('/position?'))?.path).toContain(
    fixture.recordId(10),
  );
});

it('shows a new table and its initial records before the command is sent', async () => {
  const { server, session } = await setup();
  const blocked = gate();
  server.beforeRequest = (request) => (request.path.endsWith('/commands') ? blocked.wait : Promise.resolve());
  const tableId = newId('table'),
    viewId = newId('view'),
    recordId = newId('record');
  const action = session.run([
    {
      kind: 'table.create',
      table: {
        id: tableId,
        name: 'Created',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: viewId, name: 'Grid' },
        records: [{ id: recordId }],
      },
    },
  ]);
  const view = session.openView(viewId);
  expect(view.rowCount()).toBe(1);
  expect(view.getRow(0)?.id).toBe(recordId);
  blocked.release();
  await action.done;
  await settle();
  expect(view.rowCount()).toBe(1);
  expect(view.getRow(0)?.id).toBe(recordId);
});

it('keeps remote restorations outside the snapshot as prompts and cancels deleted entrants', async () => {
  const { server, fixture, view } = await setup();
  server.remote(fixture.databaseId, [
    { kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.recordId(0)] },
  ]);
  await settle();
  await view.refresh();
  server.remote(fixture.databaseId, [
    { kind: 'record.restore', tableId: fixture.tableId, recordIds: [fixture.recordId(0)] },
  ]);
  await settle();
  expect(view.rowCount()).toBe(999);
  expect(view.prompts().entered).toBe(1);
  server.remote(fixture.databaseId, [
    { kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.recordId(0)] },
  ]);
  await settle();
  expect(view.rowCount()).toBe(999);
  expect(view.prompts()).toEqual({ entered: 0, left: new Set(), orderChanged: false });
});

it('does not mark a deleted record outside a filtered snapshot as having left it', async () => {
  const { server, fixture, session, view } = await setup();
  await session.run([
    {
      kind: 'view.update',
      viewId: fixture.viewId,
      config: {
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'condition_1', fieldId: fixture.numberFieldId, operator: 'lt', value: 10 }],
        },
      },
    },
  ]).done;
  await settle();
  server.remote(fixture.databaseId, [
    { kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.recordId(500)] },
  ]);
  await settle();
  expect(view.rowCount()).toBe(10);
  expect(view.prompts().left.size).toBe(0);
});

it('recovers prompts for changes missed while disconnected', async () => {
  const { server, fixture, view } = await setup();
  server.dropConnections();
  await settle();
  const id = newId('record');
  server.remote(fixture.databaseId, [
    { kind: 'record.create', tableId: fixture.tableId, records: [{ id, values: {} }] },
  ]);
  await vi.advanceTimersByTimeAsync(1100);
  await settle();
  expect(view.prompts().entered).toBe(1);
  expect(view.rowCount()).toBe(1000);
});

describe('scoped rows', () => {
  it('ask for one stack or range, keep apart from the whole view, skip live order deltas, and reload after changes', async () => {
    const { server, fixture, session, view } = await setup(50);
    const stack = session.openView(fixture.viewId, { stack: 'cho00000000000001' });
    const days = session.openView(fixture.viewId, { from: '2026-09-01', to: '2026-09-30' });
    await settle();
    expect(stack).not.toBe(view);
    expect(session.openView(fixture.viewId, { stack: 'cho00000000000001' })).toBe(stack);
    const scoped = server.requests
      .filter((request) => request.path.includes('/rows?'))
      .map((request) => new URL(request.path, 'http://localhost').searchParams);
    expect(scoped.some((query) => query.get('stack') === 'cho00000000000001')).toBe(true);
    expect(
      scoped.some((query) => query.get('from') === '2026-09-01' && query.get('to') === '2026-09-30'),
    ).toBe(true);
    // Only the whole view watches for order deltas.
    const watches = server.messages.filter((message) => message.type === 'watch' && message.snapshot);
    expect(watches).toHaveLength(1);

    const before = server.requests.length;
    server.remote(fixture.databaseId, [
      { kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.recordId(0)] },
    ]);
    await settle();
    expect(server.requests.length).toBe(before);
    vi.advanceTimersByTime(300);
    await settle();
    const reloads = server.requests
      .slice(before)
      .filter((request) => request.path.includes('/rows?'))
      .map((request) => new URL(request.path, 'http://localhost').searchParams);
    expect(reloads.filter((query) => query.get('refresh') === '1')).toHaveLength(2);
    stack.close();
    stack.close();
    days.close();
  });
});

describe('rows narrowed by a link', () => {
  it('read through the where token, keep apart from the whole view, and find positions the same way', async () => {
    const { server, fixture, session, view } = await setup(20);
    const where = encodeWhere({
      conjunction: 'and',
      conditions: [{ id: 'w', fieldId: fixture.numberFieldId, operator: 'lt', value: 5 }],
    });
    const narrowed = session.openView(fixture.viewId, { where });
    await settle();
    expect(narrowed).not.toBe(view);
    expect(narrowed.scope).toEqual({ where });
    expect(session.openView(fixture.viewId, { where })).toBe(narrowed);
    expect(narrowed.rowCount()).toBe(5);
    expect(view.rowCount()).toBe(20);
    const asked = server.requests
      .filter((request) => request.path.includes('/rows?'))
      .map((request) => new URL(request.path, 'http://localhost').searchParams);
    expect(asked.filter((query) => query.get('where') === where)).toHaveLength(1);
    // A narrowed list doesn't watch for order deltas, and reloads after changes instead.
    const watches = server.messages.filter((message) => message.type === 'watch' && message.snapshot);
    expect(watches).toHaveLength(1);
    narrowed.close();
    narrowed.close();
  });
});

describe('live tables', () => {
  it('shows a source that can’t be read in the view rather than taking the session offline, and reads again', async () => {
    const { server, view, session } = await setup(10);
    let down = true;
    server.beforeRequest = async (request) => {
      if (down && request.path.includes('/rows?'))
        throw new ApiError(503, {
          code: 'unavailable',
          messageKey: 'sources.live.unreachable',
          userFault: false,
        });
    };
    const changes: ViewRowsChange[] = [];
    view.subscribe((change) => changes.push(change));
    view.retryLive!();
    await settle();
    expect(view.live!().error).toEqual({ messageKey: 'sources.live.unreachable', params: undefined });
    expect(view.rowCount()).toBe(0);
    expect(view.loading()).toBe(false);
    expect(changes.some((change) => change.live)).toBe(true);
    expect(['error', 'offline']).not.toContain(session.saveState());
    down = false;
    view.retryLive!();
    await settle();
    expect(view.live!().error).toBeUndefined();
    expect(view.rowCount()).toBe(10);
  });
  it('stands for no view settings while its source can’t be read, so nothing counts the empty rows', async () => {
    const { server, view } = await setup(10);
    expect(view.settings!()).toEqual({ filter: null, sorts: [] });
    let down = true;
    server.beforeRequest = async (request) => {
      if (down && request.path.includes('/rows?'))
        throw new ApiError(503, {
          code: 'unavailable',
          messageKey: 'sources.live.unreachable',
          userFault: false,
        });
    };
    view.retryLive!();
    await settle();
    expect(view.rowCount()).toBe(0);
    expect(view.settings!()).toBeUndefined();
    down = false;
    view.retryLive!();
    await settle();
    expect(view.rowCount()).toBe(10);
    expect(view.settings!()).toEqual({ filter: null, sorts: [] });
  });
});

it('retains a scoped move after acknowledgment while its refresh is pending', async () => {
  const server = new FakeServer();
  const fixture = server.createDatabase(5);
  server.database(fixture.databaseId).view(fixture.viewId).type = 'kanban';
  const session = await openDatabase(fixture.databaseId, server.deps());
  sessions.push(session);
  const rows = session.openView(fixture.viewId, { stack: '' });
  await settle();
  const refresh = gate();
  server.beforeRequest = async ({ path }) => {
    if (path.includes('refresh=1')) await refresh.wait;
  };
  const move = session.run([
    {
      kind: 'record.move',
      tableId: fixture.tableId,
      viewId: fixture.viewId,
      recordIds: [fixture.recordId(0)],
      place: { after: fixture.recordId(1) },
    },
  ]);
  expect(rows.getRow(0)?.id).toBe(fixture.recordId(1));
  await vi.advanceTimersByTimeAsync(50);
  await settle();
  await move.done;
  expect(rows.getRow(0)?.id).toBe(fixture.recordId(1));
  await vi.advanceTimersByTimeAsync(300);
  expect(rows.getRow(0)?.id).toBe(fixture.recordId(1));
  refresh.release();
  await settle();
  expect(rows.getRow(0)?.id).toBe(fixture.recordId(1));
  rows.close();
});

it('keeps a scoped move committed after an in-flight refresh snapshot', async () => {
  const server = new FakeServer();
  const fixture = server.createDatabase(5);
  server.database(fixture.databaseId).view(fixture.viewId).type = 'kanban';
  const session = await openDatabase(fixture.databaseId, server.deps());
  sessions.push(session);
  const rows = session.openView(fixture.viewId, { stack: '' });
  await settle();
  const blocked = gate();
  server.afterRequest = ({ path }) => (path.includes('refresh=1') ? blocked.wait : Promise.resolve());
  const refresh = rows.refresh();
  await settle();
  await session.run([
    {
      kind: 'record.move',
      tableId: fixture.tableId,
      viewId: fixture.viewId,
      recordIds: [fixture.recordId(0)],
      place: { after: fixture.recordId(1) },
    },
  ]).done;
  await settle();
  blocked.release();
  await refresh;
  await settle();
  expect(rows.getRow(0)?.id).toBe(fixture.recordId(1));
  rows.close();
});

it('keeps overlay trash and inserts from promoting scrolling records into the pinned pane', async () => {
  const { server, fixture, session, view } = await setup(10);
  server.afterRequest = async (request, answer) => {
    if (request.path.includes('/rows?')) (answer as RowsPage).pinnedCount = 2;
  };
  await view.refresh();
  expect(view.pinnedCount?.()).toBe(2);
  const removal = session.run([
    { kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.recordId(0)] },
  ]);
  expect(view.pinnedCount?.()).toBe(1);
  expect(view.getRow(view.pinnedCount!())?.id).toBe(fixture.recordId(2));
  await removal.done;
  await session.undo();
  expect(view.pinnedCount?.()).toBe(2);
  const id = newId('record');
  session.run([{ kind: 'record.create', tableId: fixture.tableId, records: [{ id, values: {} }] }], {
    placeAt: { viewId: fixture.viewId, index: 1 },
  });
  expect(view.pinnedCount?.()).toBe(2);
  expect(view.getRow(2)?.id).toBe(id);
  expect(view.getRow(3)?.id).toBe(fixture.recordId(2));
});
