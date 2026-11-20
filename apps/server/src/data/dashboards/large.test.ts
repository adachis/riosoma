import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import {
  Command,
  DatabaseCreate,
  newId,
  type CommandBatchResult,
  type DashboardData,
  type TileData,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { TILE_DEADLINES } from './routes.js';

// The full million only for performance runs; the deadline test needs work, not the whole budget.
const RECORDS = process.env.RIOSOMA_PERF ? 1_000_000 : 200_000;

let kit: TestPostgres;
let server: ServerFixture;
const ids = {
  database: newId('database'),
  table: newId('table'),
  name: newId('field'),
  status: newId('field'),
  amount: newId('field'),
  day: newId('field'),
};
const choices = [newId('choice'), newId('choice'), newId('choice')];
const deadlines = { ...TILE_DEADLINES };

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'dashlarge', { logLevel: 'error' });
  const input = DatabaseCreate.parse({
    id: ids.database,
    name: 'Large',
    table: {
      id: ids.table,
      name: 'Orders',
      fields: [
        { id: ids.name, name: 'Name', type: 'text' },
        {
          id: ids.status,
          name: 'Status',
          type: 'singleSelect',
          options: { choices: choices.map((id, index) => ({ id, name: `Stage ${index}`, color: 'blue' })) },
        },
        { id: ids.amount, name: 'Amount', type: 'number' },
        { id: ids.day, name: 'Day', type: 'date' },
      ],
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: input,
  });
  expect(created.statusCode, created.body).toBe(200);
  // Written straight to the record table: a million records through commands would take minutes.
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.data, ids.table)}
      (__id, ${ident(ids.name)}, ${ident(ids.status)}, ${ident(ids.amount)}, ${ident(ids.day)})
    SELECT 'rec' || lpad(n::text, 14, '0'), 'Order ' || n, (${choices}::text[])[1 + n % 3],
      (n % 1000)::numeric, date '2025-01-01' + (n % 730)
    FROM generate_series(1, ${RECORDS}::int) AS n`,
  );
  await query(server.pool, sql`ANALYZE ${ident(server.schemas.data, ids.table)}`);
}, 300_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});
afterEach(() => {
  Object.assign(TILE_DEADLINES, deadlines);
});

async function board(tiles: Array<Record<string, unknown>>) {
  const dashboardId = newId('dashboard');
  const command = Command.parse({
    id: newId('command'),
    groupId: newId('action'),
    kind: 'dashboard.create',
    dashboard: {
      id: dashboardId,
      name: 'Board',
      config: {
        tiles: tiles.map((tile, index) => ({
          id: `tile_${index}`,
          place: { x: 0, y: index, w: 6, h: 4 },
          source: { tableId: ids.table },
          ...tile,
        })),
      },
    },
  });
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${ids.database}/commands`,
    headers: server.owner.headers,
    payload: { clientId: newId('client'), commands: [command] },
  });
  expect(response.json<CommandBatchResult>().results[0]?.status, response.body).toBe('applied');
  return dashboardId;
}

async function read(dashboardId: string): Promise<{ tiles: Record<string, TileData>; elapsed: number }> {
  const started = performance.now();
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/dashboards/${dashboardId}/data`,
    headers: server.owner.headers,
    payload: { timeZone: 'America/New_York' },
  });
  const elapsed = performance.now() - started;
  expect(response.statusCode, response.body).toBe(200);
  return { tiles: response.json<DashboardData>().tiles, elapsed };
}

const monthly = {
  kind: 'chart',
  groupBy: { fieldId: ids.day, dateBucket: 'month' },
  seriesBy: ids.status,
  value: { fn: 'sum', fieldId: ids.amount },
};

// A timing budget means little on a machine running other suites at once, so it runs with the
// performance checks (RIOSOMA_PERF=1) rather than on every commit.  The deadline test below
// checks behavior, not speed, and always runs.
it.skipIf(!process.env.RIOSOMA_PERF)(
  'charts a million records in a few seconds',
  async () => {
    const dashboardId = await board([
      monthly,
      { kind: 'chart', groupBy: { fieldId: ids.status }, value: { fn: 'average', fieldId: ids.amount } },
      {
        kind: 'chart',
        groupBy: { fieldId: ids.name },
        value: { fn: 'count' },
        sort: 'valueDescending',
        limit: 10,
      },
      { kind: 'number', value: { fn: 'countUnique', fieldId: ids.day } },
    ]);
    const { tiles, elapsed } = await read(dashboardId);
    const months = tiles.tile_0!;
    if (months.kind !== 'chart') throw new Error(JSON.stringify(months));
    expect(months.categories).toHaveLength(21);
    expect(months.categories[0]).toEqual({ key: '2025-01-01', label: 'Jan 2025' });
    expect(months.truncated).toBe(true);
    expect(months.series.map((line) => line.label)).toEqual(['Stage 0', 'Stage 1', 'Stage 2']);
    const total = months.series
      .flatMap((line) => line.values)
      .reduce<number>((sum, value) => sum + (value ?? 0), 0);
    expect(total).toBe(((RECORDS / 1000) * (999 * 1000)) / 2);
    const stages = tiles.tile_1!;
    if (stages.kind !== 'chart') throw new Error(JSON.stringify(stages));
    expect(stages.series[0]!.values.every((value) => value !== null && Math.abs(value - 499.5) < 1)).toBe(
      true,
    );
    const names = tiles.tile_2!;
    if (names.kind !== 'chart') throw new Error(JSON.stringify(names));
    expect(names.categories).toHaveLength(11);
    // Equal counts fall back to natural text order, so "Order 2" comes before "Order 10".
    expect(names.categories.slice(0, 3).map((category) => category.label)).toEqual([
      'Order 1',
      'Order 2',
      'Order 3',
    ]);
    expect(names.series[0]!.values.at(-1)).toBe(RECORDS - 10);
    expect(tiles.tile_3).toEqual({ kind: 'number', value: 730, records: RECORDS });
    expect(elapsed).toBeLessThan(4_000);
  },
  60_000,
);

it('stops a tile at its deadline and still answers the rest', async () => {
  const dashboardId = await board([monthly, { kind: 'text', text: 'Notes' }]);
  TILE_DEADLINES.statementMs = 1;
  const { tiles, elapsed } = await read(dashboardId);
  expect(tiles).toEqual({ tile_0: { kind: 'error', messageKey: 'errors.unavailable' } });
  expect(elapsed).toBeLessThan(2_000);
  TILE_DEADLINES.statementMs = deadlines.statementMs;
  TILE_DEADLINES.requestMs = 0;
  expect((await read(await board([monthly, { kind: 'number', value: { fn: 'count' } }]))).tiles).toEqual({
    tile_0: { kind: 'error', messageKey: 'errors.unavailable' },
    tile_1: { kind: 'error', messageKey: 'errors.unavailable' },
  });
});
