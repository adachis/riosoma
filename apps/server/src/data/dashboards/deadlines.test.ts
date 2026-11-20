import type pg from 'pg';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  Command,
  DatabaseCreate,
  newId,
  type CommandBatchResult,
  type DashboardData,
} from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { TILE_DEADLINES } from './routes.js';

let kit: TestPostgres;
let server: ServerFixture;
const databaseId = newId('database');
const tableId = newId('table');
const fieldId = newId('field');
const deadlines = { ...TILE_DEADLINES };
const busy = { kind: 'error', messageKey: 'errors.unavailable' };

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'dashdeadlines', { logLevel: 'error' });
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: DatabaseCreate.parse({
      id: databaseId,
      name: 'Deadlines',
      table: {
        id: tableId,
        name: 'Records',
        fields: [{ id: fieldId, name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    }),
  });
  expect(response.statusCode, response.body).toBe(200);
});

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

afterEach(() => {
  Object.assign(TILE_DEADLINES, deadlines);
  vi.restoreAllMocks();
});

async function board(kind: 'number' | 'records' | 'chart' = 'number') {
  const dashboardId = newId('dashboard');
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        Command.parse({
          id: newId('command'),
          groupId: newId('action'),
          kind: 'dashboard.create',
          dashboard: {
            id: dashboardId,
            name: 'Board',
            config: {
              tiles: [0, 1].map((index) => ({
                id: `tile_${index}`,
                kind,
                source: { tableId },
                value: { fn: 'count' },
                fieldIds: [fieldId],
                groupBy: { fieldId },
                place: { x: 0, y: index, w: 6, h: 4 },
              })),
            },
          },
        }),
      ],
    },
  });
  expect(response.json<CommandBatchResult>().results[0]?.status, response.body).toBe('applied');
  return dashboardId;
}

async function read(dashboardId: string) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/dashboards/${dashboardId}/data`,
    headers: server.owner.headers,
    payload: { timeZone: 'UTC' },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<DashboardData>().tiles;
}

/** Delays selected statements on the request's actual connection, under its current timeout. */
async function delayQueries(
  delay: (text: string, values: unknown[]) => boolean,
  work: () => Promise<void>,
  before = 'SELECT pg_sleep(0.1)',
) {
  const wrapped = new Map<pg.PoolClient, pg.PoolClient['query']>();
  const watch = (client: pg.PoolClient) => {
    if (wrapped.has(client)) return;
    const original = client.query;
    wrapped.set(client, original);
    client.query = new Proxy(original, {
      apply(target, receiver, args: unknown[]) {
        if (typeof args[0] !== 'string' || !delay(args[0], args[1] as unknown[])) {
          return Reflect.apply(target, receiver, args);
        }
        return (async () => {
          await Reflect.apply(target, receiver, [before]);
          return Reflect.apply(target, receiver, args);
        })();
      },
    });
  };
  server.pool.on('acquire', watch);
  try {
    await work();
  } finally {
    server.pool.off('acquire', watch);
    for (const [client, original] of wrapped) client.query = original;
  }
}

const isTileQuery = (text: string) => text.startsWith('SELECT count(*)::double precision AS records');

it.each(['SAVEPOINT tile', 'RELEASE SAVEPOINT tile', 'COMMIT'])(
  'keeps the tile timeout off %s and reuses a clean connection',
  async (statement) => {
    const dashboardId = await board();
    TILE_DEADLINES.statementMs = 50;
    let tileQueries = 0;
    await delayQueries(
      (text) => text === statement || (isTileQuery(text) && tileQueries++ === 0),
      async () => {
        expect(await read(dashboardId)).toEqual({
          tile_0: busy,
          tile_1: { kind: 'number', value: 0, records: 0 },
        });
      },
    );
    expect(tileQueries).toBe(2);
    // Check every connection, including the one whose tile was canceled, after it returns to the pool.
    const clients = await Promise.all(
      Array.from({ length: server.pool.totalCount }, () => server.pool.connect()),
    );
    try {
      for (const client of clients) {
        const result = await client.query(
          "SELECT current_setting('statement_timeout') AS timeout, pg_sleep(0.1)",
        );
        expect(result.rows[0].timeout).toBe('30s');
      }
    } finally {
      for (const client of clients) client.release();
    }
  },
);

it('stops an active tile at the request deadline and marks the remaining tiles unavailable', async () => {
  const dashboardId = await board();
  TILE_DEADLINES.statementMs = 1_000;
  TILE_DEADLINES.requestMs = 50;
  let tileQueries = 0;
  await delayQueries(
    (text) => {
      if (!isTileQuery(text)) return false;
      tileQueries++;
      return true;
    },
    async () => {
      expect(await read(dashboardId)).toEqual({ tile_0: busy, tile_1: busy });
    },
  );
  expect(tileQueries).toBe(1);
});

it.each([{ delays: [100] }, { delays: [40, 60] }])(
  'stops before dispatching tile SQL when timeout setup takes $delays ms and exhausts the budget',
  async ({ delays }) => {
    const dashboardId = await board();
    TILE_DEADLINES.statementMs = 1_000;
    TILE_DEADLINES.requestMs = 50;
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    let setups = 0;
    let tileQueries = 0;
    await delayQueries(
      (text) => {
        if (isTileQuery(text)) tileQueries++;
        if (!text.includes("set_config('statement_timeout'")) return false;
        now += delays[setups] ?? 0;
        setups++;
        return true;
      },
      async () => {
        expect(await read(dashboardId)).toEqual({ tile_0: busy, tile_1: busy });
      },
      'SELECT 1',
    );
    expect(setups).toBe(delays.length);
    expect(tileQueries).toBe(0);
    Object.assign(TILE_DEADLINES, deadlines);
    expect(await read(dashboardId)).toEqual({
      tile_0: { kind: 'number', value: 0, records: 0 },
      tile_1: { kind: 'number', value: 0, records: 0 },
    });
  },
);

it('bounds tile SQL by the budget left after timeout setup', async () => {
  const dashboardId = await board();
  TILE_DEADLINES.statementMs = 1_000;
  TILE_DEADLINES.requestMs = 150;
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  let timeout = 0;
  const dispatchedTimeouts: number[] = [];
  let tileQueries = 0;
  await delayQueries(
    (text, values) => {
      if (text.includes("set_config('statement_timeout'")) {
        timeout = Number(values[0]);
        if (now === 0) {
          now += 100;
          return true;
        }
      }
      if (!isTileQuery(text)) return false;
      dispatchedTimeouts.push(timeout);
      tileQueries++;
      now += 100;
      return true;
    },
    async () => {
      const tiles = await read(dashboardId);
      expect(dispatchedTimeouts).toHaveLength(1);
      expect(dispatchedTimeouts[0]).toBeGreaterThan(0);
      expect(dispatchedTimeouts[0]).toBeLessThanOrEqual(50);
      expect(tiles).toEqual({ tile_0: busy, tile_1: busy });
    },
  );
  expect(tileQueries).toBe(1);
});

it('uses the remaining request budget for each query in a tile', async () => {
  const dashboardId = await board('records');
  TILE_DEADLINES.statementMs = 1_000;
  TILE_DEADLINES.requestMs = 150;
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  let tileQueries = 0;
  await delayQueries(
    (text) => {
      if (!text.includes(`FROM "${server.schemas.data}"."${tableId}"`)) return false;
      tileQueries++;
      now += 100;
      return true;
    },
    async () => {
      expect(await read(dashboardId)).toEqual({ tile_0: busy, tile_1: busy });
    },
  );
  expect(tileQueries).toBe(2);
});

it('recovers from an explicit cancellation and still evaluates the next tile', async () => {
  const dashboardId = await board();
  let tileQueries = 0;
  await delayQueries(
    (text) => isTileQuery(text) && tileQueries++ === 0,
    async () => {
      expect(await read(dashboardId)).toEqual({
        tile_0: busy,
        tile_1: { kind: 'number', value: 0, records: 0 },
      });
    },
    'SELECT pg_cancel_backend(pg_backend_pid()), pg_sleep(0.1)',
  );
  expect(tileQueries).toBe(2);
});

it('restores the normal timeout before committing a chart drill-down', async () => {
  const dashboardId = await board('chart');
  TILE_DEADLINES.statementMs = 50;
  await delayQueries(
    (text) => text === 'COMMIT',
    async () => {
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/dashboards/${dashboardId}/tiles/tile_0/records`,
        headers: server.owner.headers,
        payload: { timeZone: 'UTC', slice: { category: null } },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ kind: 'records', rows: [], total: 0 });
    },
  );
});
