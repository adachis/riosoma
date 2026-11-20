import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Command,
  DatabaseCreate,
  newId,
  type CommandBatchResult,
  type DashboardData,
  type RowData,
  type TileData,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { AccessScope } from '../access.js';
import { OTHER_KEY } from './tiles.js';

let kit: TestPostgres;
let server: ServerFixture;
let member: SignedIn;
const clientId = newId('client');

const choice = () => newId('choice');
const ids = {
  database: newId('database'),
  projects: newId('table'),
  clients: newId('table'),
  grid: newId('view'),
  name: newId('field'),
  status: newId('field'),
  amount: newId('field'),
  due: newId('field'),
  at: newId('field'),
  done: newId('field'),
  owner: newId('field'),
  tags: newId('field'),
  score: newId('field'),
  client: newId('field'),
  clientName: newId('field'),
};
const status = { planned: choice(), active: choice(), done: choice() };
const tag = { red: choice(), blue: choice() };
const clients = { acme: newId('record'), globex: newId('record'), initech: newId('record') };
const records = {
  alpha: newId('record'),
  beta: newId('record'),
  gamma: newId('record'),
  delta: newId('record'),
  epsilon: newId('record'),
};

async function run(input: Record<string, unknown>, databaseId = ids.database) {
  const command = Command.parse({ id: newId('command'), groupId: newId('action'), ...input });
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: { clientId, commands: [command] },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<CommandBatchResult>().results[0]!;
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
}

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'dashdata');
  member = await server.addMember({ name: 'Morgan' });
  const input = DatabaseCreate.parse({
    id: ids.database,
    name: 'Work',
    table: {
      id: ids.projects,
      name: 'Projects',
      fields: [
        { id: ids.name, name: 'Name', type: 'text' },
        {
          id: ids.status,
          name: 'Status',
          type: 'singleSelect',
          options: {
            choices: [
              { id: status.planned, name: 'Planned', color: 'gray' },
              { id: status.active, name: 'Active', color: 'blue' },
              { id: status.done, name: 'Done', color: 'green' },
            ],
          },
        },
        { id: ids.amount, name: 'Amount', type: 'currency', options: { code: 'USD' } },
        { id: ids.due, name: 'Due', type: 'date' },
        { id: ids.at, name: 'At', type: 'date', options: { includeTime: true } },
        { id: ids.done, name: 'Done', type: 'checkbox' },
        { id: ids.owner, name: 'Owner', type: 'user' },
        {
          id: ids.tags,
          name: 'Tags',
          type: 'multipleSelect',
          options: {
            choices: [
              { id: tag.red, name: 'Red', color: 'red' },
              { id: tag.blue, name: 'Blue', color: 'blue' },
            ],
          },
        },
        { id: ids.score, name: 'Score', type: 'number' },
      ],
      view: { id: ids.grid, name: 'Grid' },
    },
  });
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: input,
  });
  expect(created.statusCode, created.body).toBe(200);
  await run({
    kind: 'table.create',
    table: {
      id: ids.clients,
      name: 'Clients',
      fields: [{ id: ids.clientName, name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  await run({
    kind: 'record.create',
    tableId: ids.clients,
    records: [
      { id: clients.acme, values: { [ids.clientName]: 'Acme' } },
      { id: clients.globex, values: { [ids.clientName]: 'Globex' } },
      { id: clients.initech, values: { [ids.clientName]: 'Initech' } },
    ],
  });
  await run({
    kind: 'field.create',
    tableId: ids.projects,
    field: { id: ids.client, name: 'Client', type: 'link', options: { linkedTableId: ids.clients } },
  });
  const owner = server.owner.userId;
  const row = (
    id: string,
    name: string,
    values: [
      string | null,
      number | null,
      string | null,
      string | null,
      boolean,
      string[],
      string[],
      number | null,
      string[],
    ],
  ) => ({
    id,
    values: {
      [ids.name]: name,
      [ids.status]: values[0],
      [ids.amount]: values[1],
      [ids.due]: values[2],
      [ids.at]: values[3],
      [ids.done]: values[4],
      [ids.owner]: values[5],
      [ids.tags]: values[6],
      [ids.score]: values[7],
      [ids.client]: values[8],
    },
  });
  await run({
    kind: 'record.create',
    tableId: ids.projects,
    records: [
      row(records.alpha, 'Alpha', [
        status.planned,
        100,
        '2026-01-15',
        '2026-09-30T23:30:00.000Z',
        true,
        [owner],
        [tag.red],
        5,
        [clients.acme],
      ]),
      row(records.beta, 'Beta', [
        status.active,
        250.5,
        '2026-02-01',
        '2026-10-01T12:00:00.000Z',
        false,
        [member.userId],
        [tag.red, tag.blue],
        3,
        [clients.acme, clients.globex],
      ]),
      row(records.gamma, 'Gamma', [
        status.active,
        50,
        '2026-02-20',
        '2026-09-15T08:00:00.000Z',
        true,
        [owner],
        [],
        5,
        [clients.globex],
      ]),
      row(records.delta, 'Delta', [status.done, null, null, null, false, [], [tag.blue], null, []]),
      row(records.epsilon, 'Epsilon', [
        null,
        75,
        '2026-03-03',
        '2026-12-31T23:00:00.000Z',
        false,
        [member.userId],
        [],
        8,
        [clients.initech],
      ]),
    ],
  });
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Tile = Record<string, unknown>;

/** A tile over the projects table: counts unless told otherwise. */
const number = (value: Tile = {}, source: Tile = {}): Tile => ({
  kind: 'number',
  source: { tableId: ids.projects, ...source },
  value: { fn: 'count', ...value },
});
const chart = (fieldId: string, extra: Tile = {}, source: Tile = {}): Tile => ({
  kind: 'chart',
  source: { tableId: ids.projects, ...source },
  groupBy: { fieldId },
  value: { fn: 'count' },
  ...extra,
});
const list = (extra: Tile = {}, source: Tile = {}): Tile => ({
  kind: 'records',
  source: { tableId: ids.projects, ...source },
  ...extra,
});

async function board(tiles: Tile[]) {
  const dashboardId = newId('dashboard');
  const config = {
    tiles: tiles.map((tile, index) => ({
      id: `tile_${index}`,
      place: { x: 0, y: index, w: 4, h: 3 },
      ...tile,
    })),
  };
  await run({ kind: 'dashboard.create', dashboard: { id: dashboardId, name: 'Board', config } });
  return dashboardId;
}

async function read(
  dashboardId: string,
  body: Record<string, unknown> = {},
  who = server.owner,
): Promise<Record<string, TileData>> {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/dashboards/${dashboardId}/data`,
    headers: who.headers,
    payload: { timeZone: 'UTC', ...body },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<DashboardData>().tiles;
}

/** Each tile's data in order, from a fresh dashboard. */
async function compute(tiles: Tile[], timeZone = 'UTC'): Promise<TileData[]> {
  const data = await read(await board(tiles), { timeZone });
  return tiles.map((_, index) => data[`tile_${index}`]!);
}

async function one(tile: Tile, timeZone = 'UTC'): Promise<TileData> {
  return (await compute([tile], timeZone))[0]!;
}

function chartOf(data: TileData) {
  if (data.kind !== 'chart') throw new Error(`expected a chart, got ${JSON.stringify(data)}`);
  return data;
}

/** Categories as [key, label, value] with one series. */
async function grouped(tile: Tile, timeZone = 'UTC') {
  const data = chartOf(await one(tile, timeZone));
  expect(data.series).toHaveLength(1);
  return data.categories.map((category, index) => [
    category.key,
    category.label,
    data.series[0]!.values[index],
  ]);
}

const unavailable = { kind: 'error', messageKey: 'dashboards.tile.unavailable' };
const badAggregate = { kind: 'error', messageKey: 'dashboards.tile.badAggregate' };

describe('number tiles', () => {
  it('computes every aggregate with the record count', async () => {
    const at = (value: Tile) => number(value);
    const results = await compute([
      at({}),
      at({ fn: 'sum', fieldId: ids.amount }),
      at({ fn: 'average', fieldId: ids.amount }),
      at({ fn: 'min', fieldId: ids.amount }),
      at({ fn: 'max', fieldId: ids.amount }),
      at({ fn: 'count', fieldId: ids.amount }),
      at({ fn: 'count', fieldId: ids.done }),
      at({ fn: 'count', fieldId: ids.client }),
      at({ fn: 'countUnique', fieldId: ids.status }),
      at({ fn: 'countUnique', fieldId: ids.tags }),
      at({ fn: 'countUnique', fieldId: ids.client }),
      at({ fn: 'countUnique', fieldId: ids.owner }),
      at({ fn: 'countUnique', fieldId: ids.score }),
      at({ fn: 'countUnique', fieldId: ids.done }),
      at({ fn: 'min', fieldId: ids.due }),
      at({ fn: 'max', fieldId: ids.at }),
      at({ fn: 'sum', fieldId: ids.score }),
    ]);
    expect(results.map((result) => (result.kind === 'number' ? result.value : result))).toEqual([
      5,
      475.5,
      118.875,
      50,
      250.5,
      4,
      2,
      4,
      3,
      2,
      3,
      2,
      3,
      2,
      Date.UTC(2026, 0, 15),
      Date.parse('2026-12-31T23:00:00Z'),
      21,
    ]);
    expect(results.every((result) => result.kind === 'number' && result.records === 5)).toBe(true);
  });

  it('refuses aggregates that don’t fit the field', async () => {
    const results = await compute([
      number({ fn: 'sum', fieldId: ids.name }),
      number({ fn: 'average', fieldId: ids.due }),
      number({ fn: 'min', fieldId: ids.status }),
      number({ fn: 'max', fieldId: ids.done }),
      number({ fn: 'sum', fieldId: ids.tags }),
      number({ fn: 'sum' }),
      chart(ids.status, { value: { fn: 'average', fieldId: ids.owner } }),
    ]);
    expect(results).toEqual(results.map(() => badAggregate));
  });

  it('reads through the view’s filter and then the tile’s', async () => {
    const viewId = newId('view');
    await run({
      kind: 'view.create',
      view: {
        id: viewId,
        tableId: ids.projects,
        name: 'Finished',
        type: 'grid',
        config: {
          filter: {
            conjunction: 'and',
            conditions: [{ id: 'd', fieldId: ids.done, operator: 'is', value: true }],
          },
        },
      },
    });
    const active = {
      conjunction: 'and',
      conditions: [{ id: 's', fieldId: ids.status, operator: 'is', value: status.active }],
    };
    expect(
      await compute([
        number({}, { viewId }),
        number({}, { filter: active }),
        number({}, { viewId, filter: active }),
      ]),
    ).toEqual([
      { kind: 'number', value: 2, records: 2 },
      { kind: 'number', value: 2, records: 2 },
      { kind: 'number', value: 1, records: 1 },
    ]);
  });
});

describe('chart tiles', () => {
  it('groups choices in their order with empty values last, and sorts by value when asked', async () => {
    const empty = [null, '', 1];
    expect(await grouped(chart(ids.status))).toEqual([
      [status.planned, 'Planned', 1],
      [status.active, 'Active', 2],
      [status.done, 'Done', 1],
      empty,
    ]);
    expect(await grouped(chart(ids.status, { sort: 'valueDescending' }))).toEqual([
      [status.active, 'Active', 2],
      [status.planned, 'Planned', 1],
      [status.done, 'Done', 1],
      empty,
    ]);
    expect(await grouped(chart(ids.status, { sort: 'valueAscending' }))).toEqual([
      [status.planned, 'Planned', 1],
      [status.done, 'Done', 1],
      empty,
      [status.active, 'Active', 2],
    ]);
    expect(await grouped(chart(ids.status, { value: { fn: 'sum', fieldId: ids.amount } }))).toEqual([
      [status.planned, 'Planned', 100],
      [status.active, 'Active', 300.5],
      [status.done, 'Done', null],
      [null, '', 75],
    ]);
  });

  it('keeps the first categories and combines the rest as Other', async () => {
    const data = chartOf(await one(chart(ids.status, { limit: 2 })));
    expect(data).toEqual({
      kind: 'chart',
      categories: [
        { key: status.planned, label: 'Planned' },
        { key: status.active, label: 'Active' },
        { key: OTHER_KEY, label: 'Other' },
      ],
      series: [{ key: null, label: '', values: [1, 2, 2] }],
      truncated: true,
    });
    const sums = chartOf(
      await one(
        chart(ids.status, { limit: 1, sort: 'valueDescending', value: { fn: 'sum', fieldId: ids.amount } }),
      ),
    );
    expect(sums.categories.map((category) => category.key)).toEqual([status.active, OTHER_KEY]);
    expect(sums.series[0]!.values).toEqual([300.5, 175]);
    const unique = chartOf(
      await one(chart(ids.status, { limit: 1, value: { fn: 'countUnique', fieldId: ids.owner } })),
    );
    expect(unique.series[0]!.values).toEqual([1, 2]);
  });

  it('splits categories into series, combining series and categories past their limits', async () => {
    const data = chartOf(await one(chart(ids.status, { seriesBy: ids.done })));
    expect(data.categories.map((category) => category.key)).toEqual([
      status.planned,
      status.active,
      status.done,
      null,
    ]);
    expect(data.series).toEqual([
      { key: 'false', label: 'Unchecked', values: [0, 1, 1, 1] },
      { key: 'true', label: 'Checked', values: [1, 1, 0, 0] },
    ]);
    expect(data.truncated).toBe(false);
    const combined = chartOf(await one(chart(ids.status, { seriesBy: ids.done, limit: 1 })));
    expect(combined.categories.map((category) => category.key)).toEqual([status.planned, OTHER_KEY]);
    expect(combined.series).toEqual([
      { key: 'false', label: 'Unchecked', values: [0, 3] },
      { key: 'true', label: 'Checked', values: [1, 1] },
    ]);
    const sums = chartOf(
      await one(chart(ids.tags, { seriesBy: ids.status, value: { fn: 'sum', fieldId: ids.amount } })),
    );
    expect(sums.categories.map((category) => category.label)).toEqual(['Red', 'Blue', '']);
    expect(sums.series.map((line) => [line.label, line.values])).toEqual([
      ['Planned', [100, null, null]],
      ['Active', [250.5, 250.5, 50]],
      ['Done', [null, null, null]],
      ['', [null, null, 75]],
    ]);
  });

  it('groups links and people by name, lists by each value, and numbers and text by value', async () => {
    expect(await grouped(chart(ids.client))).toEqual([
      [clients.acme, 'Acme', 2],
      [clients.globex, 'Globex', 2],
      [clients.initech, 'Initech', 1],
      [null, '', 1],
    ]);
    expect(await grouped(chart(ids.owner))).toEqual([
      [member.userId, 'Morgan', 2],
      [server.owner.userId, 'Owner', 2],
      [null, '', 1],
    ]);
    expect(await grouped(chart(ids.tags))).toEqual([
      [tag.red, 'Red', 2],
      [tag.blue, 'Blue', 2],
      [null, '', 2],
    ]);
    expect(await grouped(chart(ids.score))).toEqual([
      [3, '3', 1],
      [5, '5', 2],
      [8, '8', 1],
      [null, '', 1],
    ]);
    expect(await grouped(chart(ids.amount, { value: { fn: 'sum', fieldId: ids.score } }))).toEqual([
      [50, '$50.00', 5],
      [75, '$75.00', 8],
      [100, '$100.00', 5],
      [250.5, '$250.50', 3],
      [null, '', null],
    ]);
    expect(await grouped(chart(ids.name))).toEqual(
      ['Alpha', 'Beta', 'Delta', 'Epsilon', 'Gamma'].map((name) => [name, name, 1]),
    );
    expect(await grouped(chart(ids.done))).toEqual([
      ['false', 'Unchecked', 3],
      ['true', 'Checked', 2],
    ]);
  });

  it('groups dates by day, week, month, quarter, and year', async () => {
    const due = (dateBucket: string | null) => chart(ids.due, { groupBy: { fieldId: ids.due, dateBucket } });
    expect(await grouped(due(null))).toEqual([
      ['2026-01-15', 'Jan 15, 2026', 1],
      ['2026-02-01', 'Feb 1, 2026', 1],
      ['2026-02-20', 'Feb 20, 2026', 1],
      ['2026-03-03', 'Mar 3, 2026', 1],
      [null, '', 1],
    ]);
    const weeks = await grouped(due('week'));
    expect(weeks.map(([key, , value]) => [key, value])).toEqual([
      ['2026-01-12', 1],
      ['2026-01-26', 1],
      ['2026-02-16', 1],
      ['2026-03-02', 1],
      [null, 1],
    ]);
    expect(weeks[0]![1]).toMatch(/^Jan 12\s*–\s*18, 2026$/);
    expect(await grouped(due('month'))).toEqual([
      ['2026-01-01', 'Jan 2026', 1],
      ['2026-02-01', 'Feb 2026', 2],
      ['2026-03-01', 'Mar 2026', 1],
      [null, '', 1],
    ]);
    expect(await grouped(due('quarter'))).toEqual([
      ['2026-01-01', 'Q1 2026', 4],
      [null, '', 1],
    ]);
    expect(await grouped(due('year'))).toEqual([
      ['2026-01-01', '2026', 4],
      [null, '', 1],
    ]);
  });

  it('puts times on the days and months of the requested time zone', async () => {
    const at = (dateBucket: string) => chart(ids.at, { groupBy: { fieldId: ids.at, dateBucket } });
    expect(await grouped(at('month'))).toEqual([
      ['2026-09-01', 'Sep 2026', 2],
      ['2026-10-01', 'Oct 2026', 1],
      ['2026-12-01', 'Dec 2026', 1],
      [null, '', 1],
    ]);
    expect(await grouped(at('month'), 'Asia/Tokyo')).toEqual([
      ['2026-09-01', 'Sep 2026', 1],
      ['2026-10-01', 'Oct 2026', 2],
      ['2027-01-01', 'Jan 2027', 1],
      [null, '', 1],
    ]);
    expect(await grouped(at('month'), 'America/Los_Angeles')).toEqual(await grouped(at('month')));
    const days = async (timeZone: string) => (await grouped(at('day'), timeZone)).map(([key]) => key);
    expect(await days('UTC')).toEqual(['2026-09-15', '2026-09-30', '2026-10-01', '2026-12-31', null]);
    expect(await days('Asia/Tokyo')).toEqual(['2026-09-15', '2026-10-01', '2027-01-01', null]);
    const busy = await grouped(at('day'), 'Asia/Tokyo');
    expect(busy[1]).toEqual(['2026-10-01', 'Oct 1, 2026', 2]);
  });
});

describe('record tiles', () => {
  it('lists the first records in the view’s order with the tile’s fields, and the total', async () => {
    const viewId = newId('view');
    await run({
      kind: 'view.create',
      view: {
        id: viewId,
        tableId: ids.projects,
        name: 'By score',
        type: 'grid',
        config: { sorts: [{ fieldId: ids.score, direction: 'desc' }] },
      },
    });
    const [sorted, plain] = await compute([
      list({ fieldIds: [ids.status, ids.amount], limit: 2 }, { viewId }),
      list({ limit: 3 }),
    ]);
    if (sorted?.kind !== 'records' || plain?.kind !== 'records') throw new Error('expected records');
    expect(sorted.total).toBe(5);
    expect(sorted.rows.map((row: RowData) => row.id)).toEqual([records.epsilon, records.alpha]);
    expect(sorted.rows[1]!.values).toEqual({
      [ids.name]: 'Alpha',
      [ids.status]: status.planned,
      [ids.amount]: 100,
    });
    expect(plain.rows.map((row) => row.id)).toEqual([records.alpha, records.beta, records.gamma]);
    expect(plain.rows[0]!.values).toEqual({ [ids.name]: 'Alpha' });
  });
});

describe('computed fields', () => {
  it('groups and aggregates formulas, counts, lookups, and rollups', async () => {
    const added = async (tableId: string, name: string, spec: Record<string, unknown>) => {
      const id = newId('field');
      await run({ kind: 'field.create', tableId, field: { id, name, ...spec } });
      return id;
    };
    const double = await added(ids.projects, 'Double', {
      type: 'formula',
      options: { expression: '{Score} * 2' },
    });
    const shout = await added(ids.projects, 'Shout', {
      type: 'formula',
      options: { expression: 'CONCATENATE({Name}, "!")' },
    });
    // Formulas Postgres can't compute, which the grid can't sort either, can't be charted.
    const unsortable = await added(ids.projects, 'Loud', {
      type: 'formula',
      options: { expression: 'REGEX_REPLACE({Name}, "[aeiou]", "")' },
    });
    const linked = await added(ids.projects, 'Linked', {
      type: 'count',
      options: { linkFieldId: ids.client },
    });
    const clientNames = await added(ids.projects, 'Client names', {
      type: 'lookup',
      options: { linkFieldId: ids.client, targetFieldId: ids.clientName },
    });
    const inverse = await query<{ right_field_id: string }>(
      server.pool,
      sql`SELECT right_field_id FROM ${ident(server.schemas.app, 'links')} WHERE left_field_id = ${ids.client}`,
    );
    const billed = await added(ids.clients, 'Billed', {
      type: 'rollup',
      options: { linkFieldId: inverse.rows[0]!.right_field_id, targetFieldId: ids.amount, fn: 'sum' },
    });
    // Formulas read a blank number as zero, the way Airtable's do.
    expect(await grouped(chart(double))).toEqual([
      [0, '0', 1],
      [6, '6', 1],
      [10, '10', 2],
      [16, '16', 1],
    ]);
    expect((await grouped(chart(shout))).map(([key]) => key)).toEqual([
      'Alpha!',
      'Beta!',
      'Delta!',
      'Epsilon!',
      'Gamma!',
    ]);
    expect(await compute([chart(unsortable), number({ fn: 'countUnique', fieldId: unsortable })])).toEqual([
      badAggregate,
      badAggregate,
    ]);
    expect(await grouped(chart(linked))).toEqual([
      [0, '0', 1],
      [1, '1', 3],
      [2, '2', 1],
    ]);
    expect(await grouped(chart(clientNames))).toEqual([
      ['Acme', 'Acme', 2],
      ['Globex', 'Globex', 2],
      ['Initech', 'Initech', 1],
      [null, '', 1],
    ]);
    const numbers = await compute([
      number({ fn: 'sum', fieldId: double }),
      number({ fn: 'average', fieldId: linked }),
      number({ fn: 'countUnique', fieldId: clientNames }),
      number({ fn: 'count', fieldId: clientNames }),
      number({ fn: 'sum', fieldId: clientNames }),
    ]);
    expect(numbers.map((data) => (data.kind === 'number' ? data.value : data))).toEqual([
      42,
      1,
      3,
      4,
      badAggregate,
    ]);
    expect(
      await grouped(
        chart(ids.clientName, { value: { fn: 'sum', fieldId: billed } }, { tableId: ids.clients }),
      ),
    ).toEqual([
      ['Acme', 'Acme', 350.5],
      ['Globex', 'Globex', 300.5],
      ['Initech', 'Initech', 75],
    ]);
  });

  it('puts times on the days of a field’s own time zone when it has one', async () => {
    const tokyo = newId('field');
    await run({
      kind: 'field.create',
      tableId: ids.projects,
      field: {
        id: tokyo,
        name: 'Tokyo time',
        type: 'date',
        options: { includeTime: true, timeZone: 'Asia/Tokyo' },
      },
    });
    await run({
      kind: 'record.update',
      tableId: ids.projects,
      records: [
        { id: records.alpha, values: { [tokyo]: '2026-09-30T23:30:00.000Z' } },
        { id: records.gamma, values: { [tokyo]: '2026-09-15T08:00:00.000Z' } },
      ],
    });
    const monthly = chart(tokyo, { groupBy: { fieldId: tokyo, dateBucket: 'month' } });
    const expected = [
      ['2026-09-01', 'Sep 2026', 1],
      ['2026-10-01', 'Oct 2026', 1],
      [null, '', 3],
    ];
    expect(await grouped(monthly)).toEqual(expected);
    expect(await grouped(monthly, 'America/Los_Angeles')).toEqual(expected);
  });
});

describe('access and broken tiles', () => {
  it('leaves out records the person can’t see and makes tiles over hidden fields unavailable', async () => {
    const dashboardId = await board([
      number(),
      number({ fn: 'sum', fieldId: ids.amount }),
      chart(ids.status),
      list({ fieldIds: [ids.status] }),
      list({ fieldIds: [ids.amount] }),
      chart(ids.client),
    ]);
    vi.spyOn(AccessScope.prototype, 'recordPredicate').mockReturnValue(sql`__id <> ${records.alpha}`);
    vi.spyOn(AccessScope.prototype, 'visibleFields').mockImplementation((_tableId, fields) =>
      fields.filter((field) => field.id !== ids.amount && field.id !== ids.clientName),
    );
    const data = await read(dashboardId);
    expect(data.tile_0).toEqual({ kind: 'number', value: 4, records: 4 });
    expect(data.tile_1).toEqual(unavailable);
    expect(chartOf(data.tile_2!).categories.map((category) => category.label)).toEqual([
      'Active',
      'Done',
      '',
    ]);
    const rows = data.tile_3!;
    if (rows.kind !== 'records') throw new Error('expected records');
    expect(rows.total).toBe(4);
    expect(rows.rows.map((row) => row.id)).not.toContain(records.alpha);
    expect(Object.keys(rows.rows[0]!.values).sort()).toEqual([ids.name, ids.status].sort());
    expect(data.tile_4).toEqual(unavailable);
    expect(data.tile_5).toEqual(unavailable);
  });

  it('answers for deleted tables, views, and fields tile by tile', async () => {
    const extraTable = newId('table');
    const extraView = newId('view');
    const extraField = newId('field');
    await run({
      kind: 'table.create',
      table: {
        id: extraTable,
        name: `Extra ${extraTable}`,
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    });
    await run({
      kind: 'view.create',
      view: { id: extraView, tableId: ids.projects, name: `View ${extraView}`, type: 'grid' },
    });
    await run({
      kind: 'field.create',
      tableId: ids.projects,
      field: { id: extraField, name: `Field ${extraField}`, type: 'number' },
    });
    const dashboardId = await board([
      number(),
      number({ fn: 'sum', fieldId: extraField }),
      list({}, { viewId: extraView }),
      { kind: 'number', source: { tableId: extraTable }, value: { fn: 'count' } },
      { kind: 'text', text: 'Notes' },
    ]);
    const before = await read(dashboardId);
    expect(before.tile_1).toEqual({ kind: 'number', value: null, records: 5 });
    expect(before.tile_4).toBeUndefined();
    await run({ kind: 'field.trash', fieldId: extraField });
    await run({ kind: 'view.trash', viewId: extraView });
    await run({ kind: 'table.trash', tableId: extraTable });
    const after = await read(dashboardId);
    expect(after).toEqual({
      tile_0: { kind: 'number', value: 5, records: 5 },
      tile_1: unavailable,
      tile_2: unavailable,
      tile_3: unavailable,
    });
    expect(await read(dashboardId, { tileIds: ['tile_0', 'tile_4', 'missing'] })).toEqual({
      tile_0: { kind: 'number', value: 5, records: 5 },
    });
  });

  it('answers only people who can read the database, for live dashboards', async () => {
    const dashboardId = await board([number()]);
    const outsider = await server.addMember();
    const denied = await server.app.inject({
      method: 'POST',
      url: `/api/dashboards/${dashboardId}/data`,
      headers: outsider.headers,
      payload: { timeZone: 'UTC' },
    });
    expect(denied.statusCode).toBe(404);
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${outsider.info.org.id}, 'database', ${ids.database}, 'user', ${outsider.userId}, 'reader')`,
    );
    expect((await read(dashboardId, {}, outsider)).tile_0).toEqual({ kind: 'number', value: 5, records: 5 });
    const post = (id: string, payload: Record<string, unknown>) =>
      server.app.inject({
        method: 'POST',
        url: `/api/dashboards/${id}/data`,
        headers: server.owner.headers,
        payload,
      });
    expect((await post(dashboardId, { timeZone: 'Mars/Olympus_Mons' })).statusCode).toBe(422);
    expect((await post(dashboardId, {})).statusCode).toBe(422);
    expect((await post(newId('dashboard'), { timeZone: 'UTC' })).statusCode).toBe(404);
    await run({ kind: 'dashboard.trash', dashboardId });
    expect((await post(dashboardId, { timeZone: 'UTC' })).statusCode).toBe(404);
    const anonymous = await server.app.inject({
      method: 'POST',
      url: `/api/dashboards/${dashboardId}/data`,
      payload: { timeZone: 'UTC' },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('pivot tiles', () => {
  const settings = () => ({
    rows: [{ fieldId: ids.status }],
    column: { fieldId: ids.done },
    values: [
      { fn: 'count', fieldId: null },
      { fn: 'sum', fieldId: ids.amount },
      { fn: 'average', fieldId: ids.amount },
      { fn: 'min', fieldId: ids.amount },
      { fn: 'max', fieldId: ids.amount },
    ],
    rowTotals: true,
    columnTotals: true,
  });
  const pivot = (source: Tile = {}, extra: Tile = {}): Tile => ({
    kind: 'pivot',
    source: { tableId: ids.projects, ...source },
    pivot: { ...settings(), ...extra },
  });

  it('matches the pivot view for every summary, hierarchy, and total', async () => {
    const viewId = newId('view');
    const definition = {
      ...settings(),
      rows: [{ fieldId: ids.status }, { fieldId: ids.due, dateBucket: 'month' }],
    };
    await run({
      kind: 'view.create',
      view: {
        id: viewId,
        tableId: ids.projects,
        name: 'Pivot',
        type: 'pivot',
        config: { pivot: definition },
      },
    });
    const view = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${ids.database}/views/${viewId}/aggregate`,
      headers: server.owner.headers,
      payload: { timeZone: 'UTC' },
    });
    expect(view.statusCode, view.body).toBe(200);
    const data = await one(pivot({}, definition));
    expect(data).toEqual(view.json());
    if (data.kind !== 'pivot') throw new Error('expected pivot');
    expect(data.totals?.total).toEqual([5, 475.5, 118.875, 50, 250.5]);
  });

  it('combines view, tile, and dashboard date filters and keeps drill-down in that range', async () => {
    const viewId = newId('view');
    await run({
      kind: 'view.create',
      view: {
        id: viewId,
        tableId: ids.projects,
        name: 'Active projects',
        type: 'grid',
        config: {
          filter: {
            conjunction: 'and',
            conditions: [{ id: 'status', fieldId: ids.status, operator: 'is', value: status.active }],
          },
        },
      },
    });
    const dashboardId = await board([
      pivot({
        viewId,
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'amount', fieldId: ids.amount, operator: 'gt', value: 10 }],
        },
      }),
    ]);
    const filters = [
      {
        tableId: ids.projects,
        filter: {
          conjunction: 'and',
          conditions: [
            {
              id: 'start',
              fieldId: ids.due,
              operator: 'isOnOrAfter',
              value: { mode: 'exactDate', date: '2026-02-01' },
            },
            {
              id: 'end',
              fieldId: ids.due,
              operator: 'isBefore',
              value: { mode: 'exactDate', date: '2026-03-01' },
            },
            { id: 'amount', fieldId: ids.amount, operator: 'lt', value: 100 },
          ],
        },
      },
    ];
    const data = (await read(dashboardId, { filters })).tile_0!;
    if (data.kind !== 'pivot') throw new Error(JSON.stringify(data));
    expect(data.totals?.total).toEqual([1, 50, 50, 50, 50]);
    const drill = await server.app.inject({
      method: 'POST',
      url: `/api/dashboards/${dashboardId}/tiles/tile_0/records`,
      headers: server.owner.headers,
      payload: { timeZone: 'UTC', filters, slice: { row: [status.active], column: 'true' } },
    });
    expect(drill.statusCode, drill.body).toBe(200);
    expect(drill.json()).toMatchObject({ kind: 'records', total: 1, rows: [{ id: records.gamma }] });
    const open = drill.json().open;
    expect(open).not.toBeNull();
    const page = await server.app.inject({
      method: 'GET',
      url: `/api/views/${open.viewId}/rows?limit=10&tz=UTC&where=${encodeURIComponent(open.where)}`,
      headers: server.owner.headers,
    });
    expect(page.statusCode, page.body).toBe(200);
    expect(JSON.stringify(page.json())).toContain(records.gamma);
    expect(JSON.stringify(page.json())).not.toContain(records.beta);
  });

  it('uses viewer access for numbers and records and marks hidden fields unavailable', async () => {
    const dashboardId = await board([pivot()]);
    vi.spyOn(AccessScope.prototype, 'recordPredicate').mockReturnValue(sql`__id <> ${records.beta}`);
    const data = (await read(dashboardId)).tile_0!;
    if (data.kind !== 'pivot') throw new Error('expected pivot');
    expect(data.totals?.total).toEqual([4, 225, 75, 50, 100]);
    const drill = await server.app.inject({
      method: 'POST',
      url: `/api/dashboards/${dashboardId}/tiles/tile_0/records`,
      headers: server.owner.headers,
      payload: { timeZone: 'UTC', slice: { row: [status.active] } },
    });
    expect(drill.json()).toMatchObject({ total: 1, rows: [{ id: records.gamma }] });
    vi.spyOn(AccessScope.prototype, 'visibleFields').mockImplementation((_tableId, fields) =>
      fields.filter((field) => field.id !== ids.amount),
    );
    expect((await read(dashboardId)).tile_0).toEqual(unavailable);
    const hidden = await server.app.inject({
      method: 'POST',
      url: `/api/dashboards/${dashboardId}/tiles/tile_0/records`,
      headers: server.owner.headers,
      payload: { timeZone: 'UTC', slice: { row: [] } },
    });
    expect(hidden.json()).toEqual(unavailable);
  });

  it('rejects malformed cells and handles removed fields without breaking other tiles', async () => {
    const fieldId = newId('field');
    await run({
      kind: 'field.create',
      tableId: ids.projects,
      field: { id: fieldId, name: 'Pivot category', type: 'text' },
    });
    const dashboardId = await board([pivot({}, { rows: [{ fieldId }] }), number()]);
    for (const slice of [{ category: status.active }, { row: [1] }, { row: ['a', 'b'] }]) {
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/dashboards/${dashboardId}/tiles/tile_0/records`,
        headers: server.owner.headers,
        payload: { timeZone: 'UTC', slice },
      });
      expect(response.statusCode, response.body).toBe(422);
    }
    await run({ kind: 'field.trash', fieldId });
    const data = await read(dashboardId);
    expect(data.tile_0).toEqual(unavailable);
    expect(data.tile_1).toMatchObject({ kind: 'number', records: 5 });
  });
});
