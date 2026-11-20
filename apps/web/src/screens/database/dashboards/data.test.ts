import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId, type DashboardData, type Tile } from '@riosoma/contracts';
import { openDatabase } from '../../../data/session';
import { FakeServer } from '../../../data/testing';
import { relationalFixture } from '../../../data/testing/relational';
import type { DatabaseSession } from '../../../data/types';
import { DashboardDataStore, type TileState } from './data';

const sessions: DatabaseSession[] = [];
const stores: DashboardDataStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.stop();
  for (const session of sessions.splice(0)) session.close();
});

function count(id: string, tableId: string, viewId: string | null = null): Tile {
  return {
    id,
    kind: 'number',
    title: '',
    place: { x: 0, y: 0, w: 3, h: 2 },
    source: { tableId, viewId, filter: null },
    value: { fn: 'count', fieldId: null },
  };
}

async function setup(tiles: (ids: ReturnType<typeof relationalFixture>) => Tile[]) {
  const server = new FakeServer();
  const fixture = relationalFixture(server);
  const at = new Date(0).toISOString();
  const dashboardId = newId('dashboard');
  fixture.database.schema.dashboards = [
    {
      id: dashboardId,
      databaseId: fixture.source.databaseId,
      name: 'Board',
      position: 0,
      config: { tiles: tiles(fixture) },
      createdAt: at,
      updatedAt: at,
    },
  ];
  const session = await openDatabase(fixture.source.databaseId, server.deps());
  sessions.push(session);
  const store = new DashboardDataStore(session, dashboardId, 'UTC', 10);
  stores.push(store);
  const requests = () =>
    server.requests
      .filter((request) => request.path.endsWith('/data'))
      .map((request) => (request.options.body as { tileIds: string[] }).tileIds);
  const status = (id: string) => store.getSnapshot().get(id)?.status;
  return { server, fixture, session, store, requests, status, dashboardId };
}

const ready = (state: TileState | undefined) => (state?.status === 'ready' ? state.data : undefined);

describe('the dashboard data store', () => {
  it('loads every data tile in one request and only reloads a tile whose query changed', async () => {
    const { store, requests, status, fixture, session, dashboardId } = await setup((ids) => [
      count('tileSource1', ids.source.tableId),
      count('tileProject', ids.tableId),
    ]);
    store.start();
    const tiles = session.getSchema().dashboardById.get(dashboardId)!.config.tiles;
    store.setTiles(tiles);
    expect(status('tileSource1')).toBe('loading');
    await vi.waitFor(() => expect(status('tileProject')).toBe('ready'));
    expect(requests()).toEqual([['tileSource1', 'tileProject']]);
    expect(ready(store.getSnapshot().get('tileSource1'))).toEqual({ kind: 'number', value: 3, records: 3 });
    // A new place or title doesn't change the data.
    store.setTiles(tiles.map((tile) => ({ ...tile, title: 'Moved', place: { ...tile.place, x: 6 } })));
    await Promise.resolve();
    expect(requests()).toHaveLength(1);
    // Nor does the same query with its keys in another order, as a saved configuration comes back.
    store.setTiles(
      tiles.map((tile) =>
        tile.kind !== 'number'
          ? tile
          : {
              ...tile,
              source: Object.fromEntries(Object.entries(tile.source).reverse()) as typeof tile.source,
              value: Object.fromEntries(Object.entries(tile.value).reverse()) as typeof tile.value,
            },
      ),
    );
    await Promise.resolve();
    expect(status('tileSource1')).toBe('ready');
    expect(requests()).toHaveLength(1);
    const narrowed = count('tileSource1', fixture.source.tableId, fixture.source.viewId);
    store.setTiles([narrowed, tiles[1]!]);
    expect(status('tileSource1')).toBe('loading');
    await vi.waitFor(() => expect(status('tileSource1')).toBe('ready'));
    expect(requests()).toEqual([['tileSource1', 'tileProject'], ['tileSource1']]);
  });

  it('waits for a changed configuration to be saved before asking for its data', async () => {
    const { store, requests, status, session, dashboardId, fixture, server } = await setup(() => []);
    store.start();
    const tile = count('tileNewOne', fixture.source.tableId);
    let answered = false;
    server.afterRequest = async (request) => {
      if (request.path.endsWith('/commands')) answered = true;
    };
    session.run([{ kind: 'dashboard.update', dashboardId, config: { tiles: [tile] } }]);
    store.setTiles([tile]);
    await vi.waitFor(() => expect(status('tileNewOne')).toBe('ready'));
    expect(answered).toBe(true);
    expect(requests()).toEqual([['tileNewOne']]);
    expect(ready(store.getSnapshot().get('tileNewOne'))).toMatchObject({ kind: 'number', value: 3 });
  });

  it('refreshes the tiles that read a table after its records or a linked table’s records change', async () => {
    const { store, requests, status, session, dashboardId, fixture, server } = await setup((ids) => [
      count('tileSource1', ids.source.tableId),
      count('tileProject', ids.tableId),
    ]);
    store.start();
    store.setTiles(session.getSchema().dashboardById.get(dashboardId)!.config.tiles);
    await vi.waitFor(() => expect(status('tileSource1')).toBe('ready'));
    // Projects link back to the source table too, so either side's changes reach both tiles.
    server.remote(fixture.source.databaseId, [
      {
        kind: 'record.update',
        tableId: fixture.tableId,
        records: [{ id: fixture.recordIds[0]!, values: { [fixture.price.id]: 50 } }],
      },
    ]);
    await vi.waitFor(() => expect(requests()).toHaveLength(2));
    expect(requests()[1]).toEqual(['tileSource1', 'tileProject']);
    await vi.waitFor(() => expect(status('tileSource1')).toBe('ready'));
    const state = store.getSnapshot().get('tileSource1');
    expect(state?.status === 'ready' && state.refreshing).toBe(false);
  });

  it('refreshes only the tiles of a table whose schema changed', async () => {
    const server = new FakeServer();
    const first = server.createDatabase(2);
    const database = server.database(first.databaseId);
    const other = newId('table');
    database.schema.tables.push({ ...database.schema.tables[0]!, id: other, name: 'Other', position: 1 });
    database.records.set(other, database.rows(first.tableId));
    const dashboardId = newId('dashboard');
    const at = new Date(0).toISOString();
    database.schema.dashboards = [
      {
        id: dashboardId,
        databaseId: first.databaseId,
        name: 'Board',
        position: 0,
        config: { tiles: [count('tileFirst01', first.tableId, first.viewId), count('tileOther01', other)] },
        createdAt: at,
        updatedAt: at,
      },
    ];
    const session = await openDatabase(first.databaseId, server.deps());
    sessions.push(session);
    const store = new DashboardDataStore(session, dashboardId, 'UTC', 10);
    stores.push(store);
    store.start();
    store.setTiles(session.getSchema().dashboardById.get(dashboardId)!.config.tiles);
    const requests = () => server.requests.filter((request) => request.path.endsWith('/data'));
    await vi.waitFor(() => expect(store.getSnapshot().get('tileFirst01')?.status).toBe('ready'));
    await session.run([
      {
        kind: 'view.update',
        viewId: first.viewId,
        config: {
          filter: {
            conjunction: 'and',
            conditions: [{ id: 'conditionOne', fieldId: first.numberFieldId, operator: 'gt', value: 0 }],
          },
        },
      },
    ]).done;
    await vi.waitFor(() => expect(requests()).toHaveLength(2));
    expect(requests()[1]!.options.body).toMatchObject({ tileIds: ['tileFirst01'] });
    await vi.waitFor(() =>
      expect(ready(store.getSnapshot().get('tileFirst01'))).toEqual({ kind: 'number', value: 1, records: 1 }),
    );
  });

  it('starts over after stopping, keeping what it showed, and ignores answers that arrive after', async () => {
    const { store, status, session, dashboardId, server } = await setup((ids) => [
      count('tileSource1', ids.source.tableId),
    ]);
    const tiles = session.getSchema().dashboardById.get(dashboardId)!.config.tiles;
    store.start();
    store.setTiles(tiles);
    await vi.waitFor(() => expect(status('tileSource1')).toBe('ready'));
    let answer: (data: DashboardData) => void = () => undefined;
    server.dashboardResponder = () =>
      new Promise<DashboardData>((resolve) => {
        answer = resolve;
      });
    store.stop();
    store.start();
    store.setTiles(tiles);
    // The tile keeps its data while it reloads, as React remounting an effect would.
    expect(status('tileSource1')).toBe('ready');
    await vi.waitFor(() =>
      expect(server.requests.filter((item) => item.path.endsWith('/data'))).toHaveLength(2),
    );
    store.stop();
    answer({ tiles: { tileSource1: { kind: 'number', value: 99, records: 99 } } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ready(store.getSnapshot().get('tileSource1'))).toEqual({ kind: 'number', value: 3, records: 3 });
  });
});
