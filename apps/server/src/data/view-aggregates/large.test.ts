import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import {
  Command,
  DatabaseCreate,
  newId,
  type CommandBatchResult,
  type ViewAggregate,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { AGGREGATE_DEADLINES } from './routes.js';

const RECORDS = 200_000;

let kit: TestPostgres;
let server: ServerFixture;
const ids = {
  database: newId('database'),
  table: newId('table'),
  name: newId('field'),
  status: newId('field'),
  amount: newId('field'),
  day: newId('field'),
  tags: newId('field'),
};
const choices = [newId('choice'), newId('choice'), newId('choice')];
const tags = [newId('choice'), newId('choice')];
const deadlines = { ...AGGREGATE_DEADLINES };

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'viewlarge');
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
        {
          id: ids.tags,
          name: 'Tags',
          type: 'multipleSelect',
          options: { choices: tags.map((id, index) => ({ id, name: `Tag ${index}`, color: 'red' })) },
        },
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
  // Written straight to the record table: this many records through commands would take minutes.
  // A quarter have both tags, half have one, and a quarter have none.
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.data, ids.table)}
      (__id, ${ident(ids.name)}, ${ident(ids.status)}, ${ident(ids.amount)}, ${ident(ids.day)}, ${ident(ids.tags)})
    SELECT 'rec' || lpad(n::text, 14, '0'), 'Order ' || n, (${choices}::text[])[1 + n % 3],
      (n % 1000)::numeric, date '2025-01-01' + (n % 730),
      CASE n % 4 WHEN 0 THEN ARRAY[${tags[0]}::text] WHEN 1 THEN ${tags}::text[]
        WHEN 2 THEN ARRAY[${tags[1]}::text] ELSE ARRAY[]::text[] END
    FROM generate_series(1, ${RECORDS}::int) AS n`,
  );
  await query(server.pool, sql`ANALYZE ${ident(server.schemas.data, ids.table)}`);
}, 300_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});
afterEach(() => {
  Object.assign(AGGREGATE_DEADLINES, deadlines);
});

async function view(type: 'chart' | 'pivot', config: Record<string, unknown>): Promise<string> {
  const id = newId('view');
  const command = Command.parse({
    id: newId('command'),
    groupId: newId('action'),
    kind: 'view.create',
    view: { id, tableId: ids.table, name: id, type, config },
  });
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${ids.database}/commands`,
    headers: server.owner.headers,
    payload: { clientId: newId('client'), commands: [command] },
  });
  expect(response.json<CommandBatchResult>().results[0]?.status, response.body).toBe('applied');
  return id;
}

async function read(viewId: string, body: Record<string, unknown> = {}) {
  const started = performance.now();
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${ids.database}/views/${viewId}/aggregate`,
    headers: server.owner.headers,
    payload: { timeZone: 'America/New_York', ...body },
  });
  const elapsed = performance.now() - started;
  expect(response.statusCode, response.body).toBe(200);
  return { data: response.json<ViewAggregate>(), elapsed };
}

const count = { fn: 'count', fieldId: null };
const nested = {
  pivot: {
    rows: [{ fieldId: ids.status }, { fieldId: ids.day, dateBucket: 'quarter' }],
    column: { fieldId: ids.tags },
    values: [count, { fn: 'sum', fieldId: ids.amount }, { fn: 'average', fieldId: ids.amount }],
    order: 'valueDescending',
  },
};

// A timing budget means little on a machine running other suites at once, so it runs with the
// performance checks (RIOSOMA_PERF=1) rather than on every commit.  The deadline test below
// checks behavior, not speed, and always runs.
it.skipIf(!process.env.RIOSOMA_PERF)(
  'charts and pivots 200,000 records in a few seconds',
  async () => {
    const monthly = await view('chart', {
      chart: {
        groupBy: { fieldId: ids.day, dateBucket: 'month' },
        seriesBy: ids.status,
        value: { fn: 'sum', fieldId: ids.amount },
      },
    });
    const pivot = await view('pivot', nested);
    const names = await view('chart', { chart: { groupBy: { fieldId: ids.name }, sort: 'valueDescending' } });

    const months = await read(monthly);
    if (months.data.kind !== 'chart') throw new Error(JSON.stringify(months.data));
    expect(months.data.categories).toHaveLength(24);
    expect(months.data.categories[0]).toEqual({ key: '2025-01-01', label: 'Jan 2025' });
    expect(months.data.series.map((line) => line.label)).toEqual(['Stage 0', 'Stage 1', 'Stage 2']);
    const total = months.data.series
      .flatMap((line) => line.values)
      .reduce<number>((sum, value) => sum + (value ?? 0), 0);
    expect(total).toBe(((RECORDS / 1000) * (999 * 1000)) / 2);

    const table = await read(pivot);
    if (table.data.kind !== 'pivot') throw new Error(JSON.stringify(table.data));
    expect(table.data.rows).toHaveLength(3 + 3 * 8);
    expect(table.data.columns.map((column) => column.label)).toEqual(['Tag 0', 'Tag 1', '']);
    // Records with both tags count once in every total that spans the tags.
    expect(table.data.totals?.cells.map((cell) => cell?.[0])).toEqual([
      RECORDS / 2,
      RECORDS / 2,
      RECORDS / 4,
    ]);
    expect(table.data.totals?.total?.[0]).toBe(RECORDS);

    const top = await read(names);
    if (top.data.kind !== 'chart') throw new Error(JSON.stringify(top.data));
    expect(top.data.categories).toHaveLength(1_000);
    expect(top.data.capped.categories).toBe(true);
    expect(top.data.categories.slice(0, 3).map((category) => category.label)).toEqual([
      'Order 1',
      'Order 2',
      'Order 3',
    ]);

    const listed = await read(pivot, { records: { row: [choices[1]], limit: 100 } });
    if (listed.data.kind !== 'records') throw new Error(JSON.stringify(listed.data));
    expect(listed.data.rows).toHaveLength(100);
    // Stage 1 holds the records numbered one more than a multiple of three.
    expect(listed.data.total).toBe(Math.floor((RECORDS - 1) / 3) + 1);

    for (const step of [months, table, top, listed]) expect(step.elapsed).toBeLessThan(3_000);
    expect(months.elapsed + table.elapsed + top.elapsed + listed.elapsed).toBeLessThan(6_000);
  },
  60_000,
);

it('stops a slow aggregate at its deadline and says the server is busy', async () => {
  const pivot = await view('pivot', nested);
  AGGREGATE_DEADLINES.statementMs = 1;
  const { data, elapsed } = await read(pivot);
  expect(data).toEqual({ kind: 'error', messageKey: 'errors.unavailable' });
  expect(elapsed).toBeLessThan(2_000);
});
