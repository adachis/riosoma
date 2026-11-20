import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Command,
  DatabaseCreate,
  newId,
  type AggregateRecords,
  type ChartAggregate,
  type CommandBatchResult,
  type PivotAggregate,
  type ViewAggregate,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { AccessScope } from '../access.js';
import { AGGREGATE_DEADLINES } from './routes.js';

let kit: TestPostgres;
let server: ServerFixture;
let member: SignedIn;
const clientId = newId('client');

const choice = () => newId('choice');
const ids = {
  database: newId('database'),
  projects: newId('table'),
  clients: newId('table'),
  name: newId('field'),
  status: newId('field'),
  amount: newId('field'),
  due: newId('field'),
  at: newId('field'),
  done: newId('field'),
  owner: newId('field'),
  tags: newId('field'),
  score: newId('field'),
  files: newId('field'),
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
const deadlines = { ...AGGREGATE_DEADLINES };

async function send(input: Record<string, unknown>) {
  const command = Command.parse({ id: newId('command'), groupId: newId('action'), ...input });
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${ids.database}/commands`,
    headers: server.owner.headers,
    payload: { clientId, commands: [command] },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<CommandBatchResult>().results[0]!;
}

async function run(input: Record<string, unknown>) {
  const result = await send(input);
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
}

/**
 * Projects, as the dashboard tests have them: five records across every kind of field, two of them
 * with two tags, one linked to two clients, and one with almost nothing filled in.
 */
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'viewagg');
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
        { id: ids.files, name: 'Files', type: 'attachment' },
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
  Object.assign(AGGREGATE_DEADLINES, deadlines);
});

type Settings = Record<string, unknown>;

async function createView(type: 'chart' | 'pivot' | 'grid', config: Settings = {}): Promise<string> {
  const id = newId('view');
  await run({ kind: 'view.create', view: { id, tableId: ids.projects, name: id, type, config } });
  return id;
}

const chartView = (settings: Settings, config: Settings = {}) =>
  createView('chart', { chart: settings, ...config });
const pivotView = (settings: Settings, config: Settings = {}) =>
  createView('pivot', { pivot: settings, ...config });

async function post(
  viewId: string,
  body: Settings = {},
  who: SignedIn = server.owner,
  databaseId = ids.database,
) {
  return server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/views/${viewId}/aggregate`,
    headers: who.headers,
    payload: { timeZone: 'UTC', ...body },
  });
}

async function aggregate(
  viewId: string,
  body: Settings = {},
  who: SignedIn = server.owner,
): Promise<ViewAggregate> {
  const response = await post(viewId, body, who);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<ViewAggregate>();
}

function chartOf(data: ViewAggregate): ChartAggregate {
  if (data.kind !== 'chart') throw new Error(`expected a chart, got ${JSON.stringify(data)}`);
  return data;
}

function pivotOf(data: ViewAggregate): PivotAggregate {
  if (data.kind !== 'pivot') throw new Error(`expected a pivot, got ${JSON.stringify(data)}`);
  return data;
}

function recordsOf(data: ViewAggregate): AggregateRecords {
  if (data.kind !== 'records') throw new Error(`expected records, got ${JSON.stringify(data)}`);
  return data;
}

/** A chart's categories as [key, label, value] with one series. */
async function grouped(fieldId: string, extra: Settings = {}, timeZone = 'UTC') {
  const { dateBucket = null, ...rest } = extra;
  const viewId = await chartView({ ...rest, groupBy: { fieldId, dateBucket } });
  const data = chartOf(await aggregate(viewId, { timeZone }));
  expect(data.series).toHaveLength(1);
  return data.categories.map((category, index) => [
    category.key,
    category.label,
    data.series[0]!.values[index],
  ]);
}

const count = { fn: 'count', fieldId: null };

describe('chart views', () => {
  it('groups choices in their order with empty values last, and sorts by value when asked', async () => {
    const empty = [null, '', 1];
    expect(await grouped(ids.status)).toEqual([
      [status.planned, 'Planned', 1],
      [status.active, 'Active', 2],
      [status.done, 'Done', 1],
      empty,
    ]);
    expect(await grouped(ids.status, { sort: 'valueDescending' })).toEqual([
      [status.active, 'Active', 2],
      [status.planned, 'Planned', 1],
      [status.done, 'Done', 1],
      empty,
    ]);
    expect(await grouped(ids.status, { sort: 'valueAscending' })).toEqual([
      [status.planned, 'Planned', 1],
      [status.done, 'Done', 1],
      empty,
      [status.active, 'Active', 2],
    ]);
    expect(await grouped(ids.status, { value: { fn: 'sum', fieldId: ids.amount } })).toEqual([
      [status.planned, 'Planned', 100],
      [status.active, 'Active', 300.5],
      [status.done, 'Done', null],
      [null, '', 75],
    ]);
  });

  it('groups links and people by name, lists by each value, and numbers, text, and checkboxes by value', async () => {
    expect(await grouped(ids.client)).toEqual([
      [clients.acme, 'Acme', 2],
      [clients.globex, 'Globex', 2],
      [clients.initech, 'Initech', 1],
      [null, '', 1],
    ]);
    expect(await grouped(ids.owner)).toEqual([
      [member.userId, 'Morgan', 2],
      [server.owner.userId, 'Owner', 2],
      [null, '', 1],
    ]);
    expect(await grouped(ids.tags)).toEqual([
      [tag.red, 'Red', 2],
      [tag.blue, 'Blue', 2],
      [null, '', 2],
    ]);
    expect(await grouped(ids.score)).toEqual([
      [3, '3', 1],
      [5, '5', 2],
      [8, '8', 1],
      [null, '', 1],
    ]);
    expect(await grouped(ids.amount, { value: { fn: 'sum', fieldId: ids.score } })).toEqual([
      [50, '$50.00', 5],
      [75, '$75.00', 8],
      [100, '$100.00', 5],
      [250.5, '$250.50', 3],
      [null, '', null],
    ]);
    expect(await grouped(ids.name)).toEqual(
      ['Alpha', 'Beta', 'Delta', 'Epsilon', 'Gamma'].map((name) => [name, name, 1]),
    );
    expect(await grouped(ids.done)).toEqual([
      ['false', 'Unchecked', 3],
      ['true', 'Checked', 2],
    ]);
  });

  it('groups dates by day, week, month, quarter, and year', async () => {
    expect(await grouped(ids.due)).toEqual([
      ['2026-01-15', 'Jan 15, 2026', 1],
      ['2026-02-01', 'Feb 1, 2026', 1],
      ['2026-02-20', 'Feb 20, 2026', 1],
      ['2026-03-03', 'Mar 3, 2026', 1],
      [null, '', 1],
    ]);
    const weeks = await grouped(ids.due, { dateBucket: 'week' });
    expect(weeks.map(([key, , value]) => [key, value])).toEqual([
      ['2026-01-12', 1],
      ['2026-01-26', 1],
      ['2026-02-16', 1],
      ['2026-03-02', 1],
      [null, 1],
    ]);
    expect(await grouped(ids.due, { dateBucket: 'month' })).toEqual([
      ['2026-01-01', 'Jan 2026', 1],
      ['2026-02-01', 'Feb 2026', 2],
      ['2026-03-01', 'Mar 2026', 1],
      [null, '', 1],
    ]);
    expect(await grouped(ids.due, { dateBucket: 'quarter' })).toEqual([
      ['2026-01-01', 'Q1 2026', 4],
      [null, '', 1],
    ]);
    expect(await grouped(ids.due, { dateBucket: 'year' })).toEqual([
      ['2026-01-01', '2026', 4],
      [null, '', 1],
    ]);
  });

  it('puts times on the days and months of the requested time zone', async () => {
    expect(await grouped(ids.at, { dateBucket: 'month' })).toEqual([
      ['2026-09-01', 'Sep 2026', 2],
      ['2026-10-01', 'Oct 2026', 1],
      ['2026-12-01', 'Dec 2026', 1],
      [null, '', 1],
    ]);
    expect(await grouped(ids.at, { dateBucket: 'month' }, 'Asia/Tokyo')).toEqual([
      ['2026-09-01', 'Sep 2026', 1],
      ['2026-10-01', 'Oct 2026', 2],
      ['2027-01-01', 'Jan 2027', 1],
      [null, '', 1],
    ]);
    const days = async (timeZone: string) =>
      (await grouped(ids.at, { dateBucket: 'day' }, timeZone)).map(([key]) => key);
    expect(await days('UTC')).toEqual(['2026-09-15', '2026-09-30', '2026-10-01', '2026-12-31', null]);
    expect(await days('Asia/Tokyo')).toEqual(['2026-09-15', '2026-10-01', '2027-01-01', null]);
  });

  it('splits categories into series, with zero counts and empty sums where nothing falls', async () => {
    const data = chartOf(
      await aggregate(await chartView({ groupBy: { fieldId: ids.status }, seriesBy: ids.done })),
    );
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
    expect(data.capped).toEqual({ categories: false, series: false });
    const sums = chartOf(
      await aggregate(
        await chartView({
          groupBy: { fieldId: ids.tags },
          seriesBy: ids.status,
          value: { fn: 'sum', fieldId: ids.amount },
          stacked: true,
          chart: 'bar',
        }),
      ),
    );
    expect(sums.categories.map((category) => category.label)).toEqual(['Red', 'Blue', '']);
    expect(sums.series.map((line) => [line.label, line.values])).toEqual([
      ['Planned', [100, null, null]],
      ['Active', [250.5, 250.5, 50]],
      ['Done', [null, null, null]],
      ['', [null, null, 75]],
    ]);
  });

  it('reads only the records its own filter lets through', async () => {
    const filter = {
      conjunction: 'and',
      conditions: [{ id: 'd', fieldId: ids.done, operator: 'is', value: true }],
    };
    const viewId = await chartView({ groupBy: { fieldId: ids.status } }, { filter });
    const data = chartOf(await aggregate(viewId));
    expect(data.categories.map((category) => category.label)).toEqual(['Planned', 'Active']);
    expect(data.series[0]!.values).toEqual([1, 1]);
  });
});

describe('pivot views', () => {
  it('fills cells, row totals, and column totals, counting a record with two tags once in each total', async () => {
    const viewId = await pivotView({
      rows: [{ fieldId: ids.status }],
      column: { fieldId: ids.tags },
      values: [count, { fn: 'sum', fieldId: ids.amount }],
    });
    expect(pivotOf(await aggregate(viewId))).toEqual({
      kind: 'pivot',
      columns: [
        { key: tag.red, label: 'Red' },
        { key: tag.blue, label: 'Blue' },
        { key: null, label: '' },
      ],
      rows: [
        { keys: [status.planned], label: 'Planned', cells: [[1, 100], null, null], total: [1, 100] },
        {
          keys: [status.active],
          label: 'Active',
          cells: [
            [1, 250.5],
            [1, 250.5],
            [1, 50],
          ],
          total: [2, 300.5],
        },
        { keys: [status.done], label: 'Done', cells: [null, [1, null], null], total: [1, null] },
        { keys: [null], label: '', cells: [null, null, [1, 75]], total: [1, 75] },
      ],
      totals: {
        cells: [
          [2, 350.5],
          [2, 250.5],
          [2, 125],
        ],
        total: [5, 475.5],
      },
      capped: { rows: false, columns: false },
    });
  });

  it('gives each outer group a row of its own and orders every level by label or by the first value', async () => {
    const nested = (order: string) =>
      pivotView({
        rows: [{ fieldId: ids.status }, { fieldId: ids.done }],
        values: [count, { fn: 'sum', fieldId: ids.amount }],
        order,
      });
    const byLabel = pivotOf(await aggregate(await nested('labelAscending')));
    expect(byLabel.columns).toEqual([]);
    expect(byLabel.rows).toEqual([
      { keys: [status.planned], label: 'Planned', cells: [], total: [1, 100] },
      { keys: [status.planned, 'true'], label: 'Checked', cells: [], total: [1, 100] },
      { keys: [status.active], label: 'Active', cells: [], total: [2, 300.5] },
      { keys: [status.active, 'false'], label: 'Unchecked', cells: [], total: [1, 250.5] },
      { keys: [status.active, 'true'], label: 'Checked', cells: [], total: [1, 50] },
      { keys: [status.done], label: 'Done', cells: [], total: [1, null] },
      { keys: [status.done, 'false'], label: 'Unchecked', cells: [], total: [1, null] },
      { keys: [null], label: '', cells: [], total: [1, 75] },
      { keys: [null, 'false'], label: 'Unchecked', cells: [], total: [1, 75] },
    ]);
    expect(byLabel.totals).toEqual({ cells: [], total: [5, 475.5] });
    const keys = async (order: string) =>
      pivotOf(await aggregate(await nested(order))).rows.map((row) => row.keys);
    expect(await keys('valueDescending')).toEqual([
      [status.active],
      [status.active, 'false'],
      [status.active, 'true'],
      [status.planned],
      [status.planned, 'true'],
      [status.done],
      [status.done, 'false'],
      [null],
      [null, 'false'],
    ]);
    expect((await keys('labelDescending')).filter((row) => row.length === 1)).toEqual([
      [status.done],
      [status.active],
      [status.planned],
      [null],
    ]);
  });

  it('counts a record once for each of its tags, and once in the total', async () => {
    const data = pivotOf(await aggregate(await pivotView({ rows: [{ fieldId: ids.tags }] })));
    expect(data.rows.map((row) => [row.label, row.total])).toEqual([
      ['Red', [2]],
      ['Blue', [2]],
      ['', [2]],
    ]);
    expect(data.totals).toEqual({ cells: [], total: [5] });
  });

  it('leaves out the totals it’s asked to, and computes unique values of lists in queries of their own', async () => {
    const viewId = await pivotView({
      rows: [{ fieldId: ids.status }],
      column: { fieldId: ids.done },
      values: [{ fn: 'countUnique', fieldId: ids.tags }, count, { fn: 'countUnique', fieldId: ids.client }],
      rowTotals: false,
      columnTotals: false,
    });
    const data = pivotOf(await aggregate(viewId));
    expect(data.totals).toBeNull();
    expect(data.rows.map((row) => [row.label, row.cells, row.total])).toEqual([
      ['Planned', [null, [1, 1, 1]], null],
      [
        'Active',
        [
          [2, 1, 2],
          [0, 1, 1],
        ],
        null,
      ],
      ['Done', [[1, 1, 0], null], null],
      ['', [[0, 1, 1], null], null],
    ]);
    const unique = pivotOf(
      await aggregate(
        await pivotView({
          rows: [{ fieldId: ids.status }],
          values: [count, { fn: 'countUnique', fieldId: ids.tags }],
          order: 'valueDescending',
        }),
      ),
    );
    expect(unique.rows.map((row) => [row.label, row.total])).toEqual([
      ['Active', [2, 2]],
      ['Planned', [1, 1]],
      ['Done', [1, 1]],
      ['', [1, 0]],
    ]);
    expect(unique.totals).toEqual({ cells: [], total: [5, 2] });
  });

  it('groups a date column by month in the requested time zone', async () => {
    const viewId = await pivotView({
      rows: [{ fieldId: ids.done }],
      column: { fieldId: ids.at, dateBucket: 'month' },
    });
    const tokyo = pivotOf(await aggregate(viewId, { timeZone: 'Asia/Tokyo' }));
    expect(tokyo.columns).toEqual([
      { key: '2026-09-01', label: 'Sep 2026' },
      { key: '2026-10-01', label: 'Oct 2026' },
      { key: '2027-01-01', label: 'Jan 2027' },
      { key: null, label: '' },
    ]);
    expect(tokyo.rows.map((row) => row.cells)).toEqual([
      [null, [1], [1], [1]],
      [[1], [1], null, null],
    ]);
    expect(tokyo.totals?.cells).toEqual([[1], [2], [1], [1]]);
  });
});

describe('the records behind a number', () => {
  const ofRecords = async (viewId: string, target: Settings) =>
    recordsOf(await aggregate(viewId, { records: target }));
  const names = (data: AggregateRecords) => data.rows.map((row) => row.values[ids.name]);

  it('lists a category’s or a cell’s records in the view’s order, a page at a time', async () => {
    const byStatus = await chartView(
      { groupBy: { fieldId: ids.status }, seriesBy: ids.done },
      { sorts: [{ fieldId: ids.score, direction: 'desc' }] },
    );
    const active = await ofRecords(byStatus, { row: [status.active] });
    expect(names(active)).toEqual(['Gamma', 'Beta']);
    expect(active.total).toBe(2);
    expect(Object.keys(active.rows[0]!.values).sort()).toEqual([ids.name, ids.status, ids.done].sort());
    expect(names(await ofRecords(byStatus, { row: [status.active], column: 'true' }))).toEqual(['Gamma']);
    expect(names(await ofRecords(byStatus, { row: [null] }))).toEqual(['Epsilon']);
    const page = await ofRecords(byStatus, { row: [], offset: 1, limit: 2 });
    expect(names(page)).toEqual(['Alpha', 'Gamma']);
    expect(page.total).toBe(5);
    const byMonth = await chartView({ groupBy: { fieldId: ids.due, dateBucket: 'month' } });
    expect(names(await ofRecords(byMonth, { row: ['2026-02-01'] }))).toEqual(['Beta', 'Gamma']);
    const byAmount = await chartView({ groupBy: { fieldId: ids.amount } });
    expect(names(await ofRecords(byAmount, { row: [250.5] }))).toEqual(['Beta']);
  });

  it('lists a pivot’s cells, outer groups, and totals, matching each value of a list', async () => {
    const viewId = await pivotView({
      rows: [{ fieldId: ids.tags }, { fieldId: ids.done }],
      column: { fieldId: ids.status },
    });
    expect(names(await ofRecords(viewId, { row: [tag.blue] }))).toEqual(['Beta', 'Delta']);
    expect(names(await ofRecords(viewId, { row: [tag.blue], column: status.active }))).toEqual(['Beta']);
    expect(names(await ofRecords(viewId, { row: [tag.red, 'true'] }))).toEqual(['Alpha']);
    expect(names(await ofRecords(viewId, { row: [null] }))).toEqual(['Gamma', 'Epsilon']);
    expect(names(await ofRecords(viewId, { row: [], column: status.active }))).toEqual(['Beta', 'Gamma']);
    expect(names(await ofRecords(viewId, { row: [], column: null }))).toEqual(['Epsilon']);
    expect((await ofRecords(viewId, {})).total).toBe(5);
  });

  it('refuses keys the view has no groups for', async () => {
    const plain = await chartView({ groupBy: { fieldId: ids.status } });
    expect((await post(plain, { records: { row: [status.active, 'true'] } })).statusCode).toBe(422);
    expect((await post(plain, { records: { row: [], column: 'true' } })).statusCode).toBe(422);
  });
});

describe('access and errors', () => {
  it('leaves out records the reader can’t see and makes views over hidden fields unavailable', async () => {
    const byStatus = await chartView({ groupBy: { fieldId: ids.status } });
    const summed = await pivotView({
      rows: [{ fieldId: ids.status }],
      values: [{ fn: 'sum', fieldId: ids.amount }],
    });
    const byClient = await chartView({ groupBy: { fieldId: ids.client } });
    vi.spyOn(AccessScope.prototype, 'recordPredicate').mockReturnValue(sql`__id <> ${records.alpha}`);
    vi.spyOn(AccessScope.prototype, 'visibleFields').mockImplementation((_tableId, fields) =>
      fields.filter((field) => field.id !== ids.amount && field.id !== ids.clientName),
    );
    const data = chartOf(await aggregate(byStatus));
    expect(data.categories.map((category) => category.label)).toEqual(['Active', 'Done', '']);
    expect(data.series[0]!.values).toEqual([2, 1, 1]);
    const listed = recordsOf(await aggregate(byStatus, { records: {} }));
    expect(listed.total).toBe(4);
    expect(listed.rows.map((row) => row.id)).not.toContain(records.alpha);
    const unavailable = { kind: 'error', messageKey: 'dashboards.tile.unavailable' };
    expect(await aggregate(summed)).toEqual(unavailable);
    expect(await aggregate(summed, { records: {} })).toEqual(unavailable);
    expect(await aggregate(byClient)).toEqual(unavailable);
  });

  it('answers with the dashboard tiles’ keys for values that don’t fit, deleted fields, and slow reads', async () => {
    const badAggregate = { kind: 'error', messageKey: 'dashboards.tile.badAggregate' };
    expect(
      await aggregate(
        await chartView({ groupBy: { fieldId: ids.status }, value: { fn: 'sum', fieldId: ids.name } }),
      ),
    ).toEqual(badAggregate);
    expect(
      await aggregate(
        await pivotView({ rows: [{ fieldId: ids.status }], values: [{ fn: 'average', fieldId: ids.owner }] }),
      ),
    ).toEqual(badAggregate);
    const extra = newId('field');
    await run({
      kind: 'field.create',
      tableId: ids.projects,
      field: { id: extra, name: `Extra ${extra}`, type: 'number' },
    });
    const viewId = await pivotView({ rows: [{ fieldId: extra }] });
    expect(pivotOf(await aggregate(viewId)).rows).toHaveLength(1);
    await run({ kind: 'field.trash', fieldId: extra });
    expect(await aggregate(viewId)).toEqual({ kind: 'error', messageKey: 'dashboards.tile.unavailable' });
    AGGREGATE_DEADLINES.requestMs = 0;
    expect(await aggregate(await pivotView({ rows: [{ fieldId: ids.status }] }))).toEqual({
      kind: 'error',
      messageKey: 'errors.unavailable',
    });
  });

  it('answers only people who can read the database, for chart and pivot views that are set up', async () => {
    const viewId = await chartView({ groupBy: { fieldId: ids.status } });
    const outsider = await server.addMember();
    expect((await post(viewId, {}, outsider)).statusCode).toBe(404);
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${outsider.info.org.id}, 'database', ${ids.database}, 'user', ${outsider.userId}, 'reader')`,
    );
    expect(chartOf(await aggregate(viewId, {}, outsider)).categories).toHaveLength(4);
    expect((await post(viewId, {}, server.owner, newId('database'))).statusCode).toBe(404);
    expect((await post(viewId, { timeZone: 'Mars/Olympus_Mons' })).statusCode).toBe(422);
    const refused = async (id: string, setting: string) => {
      const response = await post(id);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        error: { messageKey: 'data.view.badSetting', params: { setting } },
      });
    };
    await refused(await createView('grid'), 'type');
    await refused(await createView('chart'), 'chart.groupBy');
    await refused(await createView('pivot'), 'pivot.rows');
    await run({ kind: 'view.trash', viewId });
    expect((await post(viewId)).statusCode).toBe(404);
    const anonymous = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${ids.database}/views/${viewId}/aggregate`,
      payload: { timeZone: 'UTC' },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('checks the fields chart and pivot settings name when views are created and changed', async () => {
    const viewId = await createView('pivot');
    const rejected = (setting: string) => ({
      status: 'rejected',
      error: { messageKey: 'data.view.badSetting', params: { setting } },
    });
    const cases: Array<[Settings, string]> = [
      [{ chart: { groupBy: { fieldId: newId('field') } } }, 'chart.groupBy'],
      [{ chart: { groupBy: { fieldId: ids.files } } }, 'chart.groupBy'],
      [{ chart: { seriesBy: ids.files } }, 'chart.seriesBy'],
      [{ chart: { value: { fn: 'sum', fieldId: newId('field') } } }, 'chart.value'],
      [{ pivot: { rows: [{ fieldId: ids.status }, { fieldId: ids.status }] } }, 'pivot.rows'],
      [{ pivot: { rows: [{ fieldId: ids.files }] } }, 'pivot.rows'],
      [{ pivot: { rows: [{ fieldId: ids.status }], column: { fieldId: ids.status } } }, 'pivot.column'],
      [{ pivot: { column: { fieldId: ids.files } } }, 'pivot.column'],
      [{ pivot: { values: [{ fn: 'sum', fieldId: newId('field') }] } }, 'pivot.values'],
    ];
    for (const [config, setting] of cases) {
      expect(await send({ kind: 'view.update', viewId, config })).toMatchObject(rejected(setting));
      expect(
        await send({
          kind: 'view.create',
          view: { id: newId('view'), tableId: ids.projects, name: newId('view'), type: 'pivot', config },
        }),
      ).toMatchObject(rejected(setting));
    }
  });
});

describe('caps', () => {
  it('keeps the first 1,000 rows and 100 columns and says so', async () => {
    const table = newId('table');
    const label = newId('field');
    const group = newId('field');
    await run({
      kind: 'table.create',
      table: {
        id: table,
        name: `Many ${table}`,
        fields: [
          { id: label, name: 'Name', type: 'text' },
          { id: group, name: 'Group', type: 'number' },
        ],
        view: { id: newId('view'), name: 'Grid' },
      },
    });
    // Written straight to the record table: commands would take a while for this many.
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.data, table)} (__id, ${ident(label)}, ${ident(group)})
      SELECT 'rec' || lpad(n::text, 14, '0'), 'Item ' || n, (n % 150)::numeric
      FROM generate_series(1, 1200) AS n`,
    );
    const view = async (type: 'chart' | 'pivot', config: Settings) => {
      const id = newId('view');
      await run({ kind: 'view.create', view: { id, tableId: table, name: id, type, config } });
      return id;
    };
    const names = chartOf(await aggregate(await view('chart', { chart: { groupBy: { fieldId: label } } })));
    expect(names.categories).toHaveLength(1_000);
    expect(names.categories.slice(0, 3).map((category) => category.label)).toEqual([
      'Item 1',
      'Item 2',
      'Item 3',
    ]);
    expect(names.capped).toEqual({ categories: true, series: false });
    const split = chartOf(
      await aggregate(await view('chart', { chart: { groupBy: { fieldId: group }, seriesBy: label } })),
    );
    expect(split.categories).toHaveLength(150);
    expect(split.series).toHaveLength(100);
    expect(split.capped).toEqual({ categories: false, series: true });
    const pivot = pivotOf(
      await aggregate(
        await view('pivot', { pivot: { rows: [{ fieldId: label }], column: { fieldId: group } } }),
      ),
    );
    expect(pivot.rows).toHaveLength(1_000);
    expect(pivot.columns).toHaveLength(100);
    expect(pivot.capped).toEqual({ rows: true, columns: true });
    // Totals count every record, including the ones in groups past the caps.
    expect(pivot.totals?.total).toEqual([1_200]);
  });
});
