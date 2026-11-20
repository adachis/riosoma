import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId, type InterfaceMeta, type InterfacePage } from '@riosoma/contracts';
import { openDatabase } from './session';
import { FakeServer } from './testing';
import type { FakeFixture } from './testing';
import type { DatabaseSession } from './types';

async function settle(): Promise<void> {
  for (let index = 0; index < 80; index++) await Promise.resolve();
}

function stored(databaseId: string, name: string, position: number, pages: InterfacePage[] = []) {
  const at = new Date(0).toISOString();
  return {
    id: newId('interface'),
    databaseId,
    name,
    position,
    pages,
    createdAt: at,
    updatedAt: at,
  } satisfies InterfaceMeta;
}

function page(tableId: string, viewId: string): InterfacePage {
  return {
    id: 'pageMain01',
    name: 'Main',
    blocks: [
      {
        id: 'blkRecords01',
        kind: 'records',
        title: '',
        place: { x: 0, y: 0, w: 6, h: 4 },
        source: { tableId, viewId, filter: null },
        fieldIds: [],
        display: 'list',
        showFieldNames: true,
      },
    ],
  };
}

let server: FakeServer, fixture: FakeFixture, session: DatabaseSession;
beforeEach(() => {
  vi.useFakeTimers();
  server = new FakeServer();
  fixture = server.createDatabase(5);
});
afterEach(() => {
  session.close();
  vi.useRealTimers();
});
const names = () => session.getSchema().interfaces.map((item) => item.name);
const commands = () =>
  server.requests
    .filter((request) => request.path.endsWith('/commands'))
    .flatMap((request) => (request.options.body as { commands: Array<{ kind: string }> }).commands);

describe('interfaces in the session', () => {
  it('reads a schema without interfaces as none, and keeps the rest in sidebar order', async () => {
    session = await openDatabase(fixture.databaseId, server.deps());
    expect(session.getSchema().interfaces).toEqual([]);
    session.close();
    const second = stored(fixture.databaseId, 'Second', 2);
    const first = stored(fixture.databaseId, 'First', 1);
    server.database(fixture.databaseId).schema.interfaces = [second, first];
    session = await openDatabase(fixture.databaseId, server.deps());
    expect(names()).toEqual(['First', 'Second']);
    expect(session.getSchema().interfaceById.get(second.id)?.name).toBe('Second');
  });

  it('creates, renames, reorders, changes pages, and deletes interfaces at once, then saves them', async () => {
    session = await openDatabase(fixture.databaseId, server.deps());
    const one = newId('interface'),
      two = newId('interface');
    const created = session.run([
      { kind: 'interface.create', interface: { id: one, name: 'Desk' }, position: 0 },
      { kind: 'interface.create', interface: { id: two, name: 'Reports', pages: [] } },
    ]);
    expect(names()).toEqual(['Desk', 'Reports']);
    expect(session.getSchema().interfaceById.get(two)?.position).toBe(1);
    await created.done;
    await settle();
    expect(server.database(fixture.databaseId).schema.interfaces?.map((item) => item.name)).toEqual([
      'Desk',
      'Reports',
    ]);
    session.run([{ kind: 'interface.update', interfaceId: one, name: 'Front desk' }]);
    session.run([{ kind: 'interface.move', interfaceId: two, position: -1 }]);
    const pages = [page(fixture.tableId, fixture.viewId)];
    session.run([{ kind: 'interface.update', interfaceId: one, pages }]);
    expect(names()).toEqual(['Reports', 'Front desk']);
    expect(session.getSchema().interfaceById.get(one)?.pages).toEqual(pages);
    const trashed = session.run([{ kind: 'interface.trash', interfaceId: two }]);
    expect(names()).toEqual(['Front desk']);
    await trashed.done;
    await settle();
    expect(server.database(fixture.databaseId).schema.interfaces?.map((item) => item.name)).toEqual([
      'Front desk',
    ]);
    expect(commands().map((command) => command.kind)).toEqual([
      'interface.create',
      'interface.create',
      'interface.update',
      'interface.move',
      'interface.update',
      'interface.trash',
    ]);
  });

  it('undoes and redoes interface changes, and follows other people’s', async () => {
    const existing = stored(fixture.databaseId, 'Existing', 0);
    server.database(fixture.databaseId).schema.interfaces = [existing];
    session = await openDatabase(fixture.databaseId, server.deps());
    const pages = [page(fixture.tableId, fixture.viewId)];
    await session.run([{ kind: 'interface.update', interfaceId: existing.id, pages }]).done;
    await settle();
    await session.undo();
    await settle();
    expect(session.getSchema().interfaceById.get(existing.id)?.pages).toEqual([]);
    await session.redo();
    await settle();
    expect(session.getSchema().interfaceById.get(existing.id)?.pages).toEqual(pages);
    const id = newId('interface');
    server.remote(fixture.databaseId, [{ kind: 'interface.create', interface: { id, name: 'Shared' } }]);
    await settle();
    expect(names()).toEqual(['Existing', 'Shared']);
    server.remote(fixture.databaseId, [{ kind: 'interface.trash', interfaceId: id }]);
    await settle();
    expect(names()).toEqual(['Existing']);
    server.rejectNext('data.command.rejected');
    const rejected = session.run([{ kind: 'interface.update', interfaceId: existing.id, name: 'Mine' }]);
    expect(names()).toEqual(['Mine']);
    expect(await rejected.done).toEqual({ applied: 0, rejected: 1 });
    await settle();
    expect(names()).toEqual(['Existing']);
  });

  it('refuses pages the contracts don’t accept before anything changes', async () => {
    session = await openDatabase(fixture.databaseId, server.deps());
    const id = newId('interface');
    session.run([{ kind: 'interface.create', interface: { id, name: 'Desk' } }]);
    const broken = [{ ...page(fixture.tableId, fixture.viewId), id: 'x' }];
    expect(() => session.run([{ kind: 'interface.update', interfaceId: id, pages: broken }])).toThrow(
      'data.command.invalid',
    );
    expect(session.getSchema().interfaceById.get(id)?.pages).toEqual([]);
  });

  it('reads a records block’s records, keeping them for the rest of the app', async () => {
    const value = stored(fixture.databaseId, 'Desk', 0, [page(fixture.tableId, fixture.viewId)]);
    server.database(fixture.databaseId).schema.interfaces = [value];
    session = await openDatabase(fixture.databaseId, server.deps());
    const unsubscribe = session.subscribeRecords(fixture.tableId, () => undefined);
    const answer = await session.interfaceRecords(value.id, {
      pageId: 'pageMain01',
      blockId: 'blkRecords01',
      offset: 1,
      limit: 2,
      timeZone: 'America/Chicago',
    });
    expect(answer).toMatchObject({ total: 5, offset: 1, tableId: fixture.tableId });
    expect(answer.rows.map((row) => row?.id)).toEqual([fixture.recordId(1), fixture.recordId(2)]);
    expect(session.cachedRecord(fixture.tableId, fixture.recordId(2))?.values[fixture.textFieldId]).toBe(
      'Record 3',
    );
    const request = server.requests.find((item) => item.path.includes('/api/interfaces/'))!;
    expect(request.path).toBe(`/api/interfaces/${value.id}/records`);
    expect(request.options).toMatchObject({
      method: 'POST',
      body: { timeZone: 'America/Chicago', limit: 2 },
    });
    unsubscribe();
  });
});
