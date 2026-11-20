import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId, type DashboardConfig, type DashboardMeta } from '@riosoma/contracts';
import { openDatabase } from './session';
import { FakeServer } from './testing';
import type { FakeFixture } from './testing';
import type { DatabaseSession } from './types';

async function settle(): Promise<void> {
  for (let index = 0; index < 80; index++) await Promise.resolve();
}

function dashboard(
  databaseId: string,
  name: string,
  position: number,
  config: DashboardConfig = { tiles: [] },
) {
  const at = new Date(0).toISOString();
  return {
    id: newId('dashboard'),
    databaseId,
    name,
    position,
    config,
    createdAt: at,
    updatedAt: at,
  } satisfies DashboardMeta;
}

function numberTile(tableId: string, id = 'tileNumber1'): DashboardConfig['tiles'][number] {
  return {
    id,
    kind: 'number',
    title: 'Records',
    place: { x: 0, y: 0, w: 3, h: 2 },
    source: { tableId, viewId: null, filter: null },
    value: { fn: 'count', fieldId: null },
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
const names = () => session.getSchema().dashboards.map((item) => item.name);
const commands = () =>
  server.requests
    .filter((request) => request.path.endsWith('/commands'))
    .flatMap((request) => (request.options.body as { commands: Array<{ kind: string }> }).commands);

describe('dashboards in the session', () => {
  it('reads a schema without dashboards as none', async () => {
    session = await openDatabase(fixture.databaseId, server.deps());
    expect(server.database(fixture.databaseId).schema.dashboards).toBeUndefined();
    expect(session.getSchema().dashboards).toEqual([]);
    expect(session.getSchema().dashboardById.size).toBe(0);
  });

  it('keeps dashboards from the schema in sidebar order', async () => {
    const second = dashboard(fixture.databaseId, 'Second', 2);
    const first = dashboard(fixture.databaseId, 'First', 1);
    server.database(fixture.databaseId).schema.dashboards = [second, first];
    session = await openDatabase(fixture.databaseId, server.deps());
    expect(names()).toEqual(['First', 'Second']);
    expect(session.getSchema().dashboardById.get(second.id)?.name).toBe('Second');
  });

  it('creates, renames, reorders, configures, and deletes dashboards at once, then saves them', async () => {
    session = await openDatabase(fixture.databaseId, server.deps());
    const one = newId('dashboard'),
      two = newId('dashboard');
    const created = session.run([
      { kind: 'dashboard.create', dashboard: { id: one, name: 'Sales' }, position: 0 },
      { kind: 'dashboard.create', dashboard: { id: two, name: 'Support', config: { tiles: [] } } },
    ]);
    expect(names()).toEqual(['Sales', 'Support']);
    expect(session.getSchema().dashboardById.get(two)?.position).toBe(1);
    await created.done;
    await settle();
    expect(server.database(fixture.databaseId).schema.dashboards?.map((item) => item.name)).toEqual([
      'Sales',
      'Support',
    ]);
    session.run([{ kind: 'dashboard.update', dashboardId: one, name: 'Revenue' }]);
    session.run([{ kind: 'dashboard.move', dashboardId: two, position: -1 }]);
    const config = { tiles: [numberTile(fixture.tableId)] };
    session.run([{ kind: 'dashboard.update', dashboardId: one, config }]);
    expect(names()).toEqual(['Support', 'Revenue']);
    expect(session.getSchema().dashboardById.get(one)?.config).toEqual(config);
    const trashed = session.run([{ kind: 'dashboard.trash', dashboardId: two }]);
    expect(names()).toEqual(['Revenue']);
    expect(session.getSchema().dashboardById.has(two)).toBe(false);
    await trashed.done;
    await settle();
    expect(names()).toEqual(['Revenue']);
    expect(server.database(fixture.databaseId).schema.dashboards?.map((item) => item.name)).toEqual([
      'Revenue',
    ]);
    expect(commands().map((command) => command.kind)).toEqual([
      'dashboard.create',
      'dashboard.create',
      'dashboard.update',
      'dashboard.move',
      'dashboard.update',
      'dashboard.trash',
    ]);
  });

  it('undoes and redoes dashboard changes like views', async () => {
    const existing = dashboard(fixture.databaseId, 'Existing', 0);
    server.database(fixture.databaseId).schema.dashboards = [existing];
    session = await openDatabase(fixture.databaseId, server.deps());
    const id = newId('dashboard');
    await session.run([{ kind: 'dashboard.create', dashboard: { id, name: 'New' }, position: 1 }]).done;
    await settle();
    await session.undo();
    await settle();
    expect(names()).toEqual(['Existing']);
    await session.redo();
    await settle();
    expect(names()).toEqual(['Existing', 'New']);
    const config = { tiles: [numberTile(fixture.tableId)] };
    await session.run([{ kind: 'dashboard.update', dashboardId: existing.id, config }]).done;
    await settle();
    await session.undo();
    await settle();
    expect(session.getSchema().dashboardById.get(existing.id)?.config).toEqual({ tiles: [] });
    await session.run([{ kind: 'dashboard.trash', dashboardId: existing.id }]).done;
    await settle();
    expect(names()).toEqual(['New']);
    await session.undo();
    await settle();
    expect(names()).toEqual(['Existing', 'New']);
    expect(
      server
        .database(fixture.databaseId)
        .schema.dashboards?.map((item) => item.name)
        .sort(),
    ).toEqual(['Existing', 'New']);
  });

  it('applies other people’s dashboard changes and rolls back a rejected one', async () => {
    session = await openDatabase(fixture.databaseId, server.deps());
    await settle();
    const id = newId('dashboard');
    server.remote(fixture.databaseId, [{ kind: 'dashboard.create', dashboard: { id, name: 'Shared' } }]);
    await settle();
    expect(names()).toEqual(['Shared']);
    server.remote(fixture.databaseId, [{ kind: 'dashboard.trash', dashboardId: id }]);
    await settle();
    expect(names()).toEqual([]);
    server.remote(fixture.databaseId, [{ kind: 'dashboard.restore', dashboardId: id }]);
    await settle();
    expect(names()).toEqual(['Shared']);
    server.rejectNext('data.command.rejected');
    const rejected = session.run([{ kind: 'dashboard.update', dashboardId: id, name: 'Mine' }]);
    expect(names()).toEqual(['Mine']);
    expect(await rejected.done).toEqual({ applied: 0, rejected: 1 });
    await settle();
    expect(names()).toEqual(['Shared']);
  });

  it('refuses a configuration the contracts don’t accept before anything changes', async () => {
    session = await openDatabase(fixture.databaseId, server.deps());
    const id = newId('dashboard');
    session.run([{ kind: 'dashboard.create', dashboard: { id, name: 'Board' } }]);
    const broken = { tiles: [{ ...numberTile(fixture.tableId), place: { x: 12, y: 0, w: 1, h: 1 } }] };
    expect(() => session.run([{ kind: 'dashboard.update', dashboardId: id, config: broken }])).toThrow(
      'data.command.invalid',
    );
    expect(session.getSchema().dashboardById.get(id)?.config).toEqual({ tiles: [] });
  });

  it('asks for tile data with the person’s time zone', async () => {
    const board = dashboard(fixture.databaseId, 'Board', 0, { tiles: [numberTile(fixture.tableId)] });
    server.database(fixture.databaseId).schema.dashboards = [board];
    session = await openDatabase(fixture.databaseId, server.deps());
    const data = await session.dashboardData(board.id, {
      timeZone: 'America/Chicago',
      tileIds: ['tileNumber1'],
    });
    expect(data.tiles.tileNumber1).toEqual({ kind: 'number', value: 5, records: 5 });
    const request = server.requests.find((item) => item.path.includes('/api/dashboards/'))!;
    expect(request.path).toBe(`/api/dashboards/${board.id}/data`);
    expect(request.options).toMatchObject({
      method: 'POST',
      body: { timeZone: 'America/Chicago', tileIds: ['tileNumber1'] },
    });
  });
});
