import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Command,
  DatabaseCreate,
  OTHER_GROUP_KEY,
  decodeWhere,
  encodeWhere,
  isGroup,
  newId,
  type CommandBatchResult,
  type DashboardData,
  type FilterGroup,
  type GroupKey,
  type PositionResult,
  type RowsPage,
  type TileData,
  type TileRecordsAnswer,
  type ViewAggregate,
  type ViewSearchResult,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';

let kit: TestPostgres;
let server: ServerFixture;
let reader: SignedIn;
const clientId = newId('client');

const choice = () => newId('choice');
const ids = {
  database: newId('database'),
  projects: newId('table'),
  clients: newId('table'),
  grid: newId('view'),
  name: newId('field'),
  status: newId('field'),
  tags: newId('field'),
  owner: newId('field'),
  amount: newId('field'),
  due: newId('field'),
  at: newId('field'),
  done: newId('field'),
  client: newId('field'),
  kind: newId('field'),
  salary: newId('field'),
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

async function run(input: Record<string, unknown>) {
  const command = Command.parse({ id: newId('command'), groupId: newId('action'), ...input });
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${ids.database}/commands`,
    headers: server.owner.headers,
    payload: { clientId, commands: [command] },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<CommandBatchResult>().results[0]!;
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
}

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'drill');
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
        { id: ids.owner, name: 'Owner', type: 'user' },
        { id: ids.amount, name: 'Amount', type: 'number' },
        { id: ids.due, name: 'Due', type: 'date' },
        { id: ids.at, name: 'At', type: 'date', options: { includeTime: true } },
        { id: ids.done, name: 'Done', type: 'checkbox' },
        { id: ids.kind, name: 'Kind', type: 'text' },
        { id: ids.salary, name: 'Salary', type: 'number' },
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
  reader = await server.addMember({ name: 'Riley' });
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${ids.database}, 'user', ${reader.userId}, 'reader')`,
  );
  const owner = server.owner.userId;
  const row = (
    id: string,
    name: string,
    values: {
      status: string | null;
      tags: string[];
      owner: string[];
      amount: number | null;
      due: string | null;
      at: string | null;
      done: boolean;
      client: string[];
      kind: string | null;
      salary: number;
    },
  ) => ({
    id,
    values: {
      [ids.name]: name,
      [ids.status]: values.status,
      [ids.tags]: values.tags,
      [ids.owner]: values.owner,
      [ids.amount]: values.amount,
      [ids.due]: values.due,
      [ids.at]: values.at,
      [ids.done]: values.done,
      [ids.client]: values.client,
      [ids.kind]: values.kind,
      [ids.salary]: values.salary,
    },
  });
  await run({
    kind: 'record.create',
    tableId: ids.projects,
    records: [
      row(records.alpha, 'Alpha', {
        status: status.planned,
        tags: [tag.red],
        owner: [owner],
        amount: 100,
        due: '2026-01-15',
        at: '2026-09-30T23:30:00.000Z',
        done: true,
        client: [clients.acme],
        kind: 'Alpha',
        salary: 10,
      }),
      row(records.beta, 'Beta', {
        status: status.active,
        tags: [tag.red, tag.blue],
        owner: [reader.userId],
        amount: 250.5,
        due: '2026-02-01',
        at: '2026-10-01T12:00:00.000Z',
        done: false,
        client: [clients.acme, clients.globex],
        kind: 'alpha',
        salary: 20,
      }),
      row(records.gamma, 'Gamma', {
        status: status.active,
        tags: [],
        owner: [owner],
        amount: 50,
        due: '2026-02-20',
        at: '2026-09-15T08:00:00.000Z',
        done: true,
        client: [clients.globex],
        kind: 'Beta',
        salary: 30,
      }),
      row(records.delta, 'Delta', {
        status: status.done,
        tags: [tag.blue],
        owner: [],
        amount: null,
        due: null,
        at: null,
        done: false,
        client: [],
        kind: null,
        salary: 40,
      }),
      row(records.epsilon, 'Epsilon', {
        status: null,
        tags: [],
        owner: [reader.userId],
        amount: 75,
        due: '2026-03-03',
        at: '2026-12-31T23:00:00.000Z',
        done: false,
        client: [clients.initech],
        kind: 'Beta',
        salary: 50,
      }),
    ],
  });
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

type Tile = Record<string, unknown>;

const chart = (fieldId: string, extra: Tile = {}, source: Tile = {}): Tile => ({
  kind: 'chart',
  source: { tableId: ids.projects, ...source },
  groupBy: { fieldId },
  value: { fn: 'count' },
  ...extra,
});

/** A dashboard holding these tiles, named tile_0 onward. */
async function board(tiles: Tile[]): Promise<string> {
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

async function tileData(
  dashboardId: string,
  tileId = 'tile_0',
  who = server.owner,
  timeZone = 'UTC',
): Promise<TileData> {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/dashboards/${dashboardId}/data`,
    headers: who.headers,
    payload: { timeZone },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<DashboardData>().tiles[tileId]!;
}

function post(dashboardId: string, tileId: string, payload: Record<string, unknown>, who?: SignedIn) {
  return server.app.inject({
    method: 'POST',
    url: `/api/dashboards/${dashboardId}/tiles/${tileId}/records`,
    ...(who ? { headers: who.headers } : {}),
    payload,
  });
}

async function drill(
  dashboardId: string,
  category: GroupKey,
  options: {
    series?: GroupKey;
    who?: SignedIn;
    tileId?: string;
    offset?: number;
    limit?: number;
    timeZone?: string;
  } = {},
): Promise<TileRecordsAnswer> {
  const response = await post(
    dashboardId,
    options.tileId ?? 'tile_0',
    {
      timeZone: options.timeZone ?? 'UTC',
      slice: { category, ...(options.series === undefined ? {} : { series: options.series }) },
      ...(options.offset === undefined ? {} : { offset: options.offset }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    },
    options.who ?? server.owner,
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json<TileRecordsAnswer>();
}

function listed(answer: TileRecordsAnswer) {
  if (answer.kind !== 'records') throw new Error(`expected records, got ${JSON.stringify(answer)}`);
  return answer;
}

const names = (answer: TileRecordsAnswer) =>
  listed(answer)
    .rows.map((row) => row.values[ids.name])
    .sort();

/** A filter without the IDs its conditions carry, which only key them for editing. */
function shape(group: FilterGroup | null): unknown {
  if (!group) return null;
  return {
    conjunction: group.conjunction,
    conditions: group.conditions.map((item) =>
      isGroup(item)
        ? shape(item)
        : {
            fieldId: item.fieldId,
            operator: item.operator,
            ...(item.value === undefined ? {} : { value: item.value }),
          },
    ),
  };
}

function opened(answer: TileRecordsAnswer) {
  const open = listed(answer).open;
  return open ? { viewId: open.viewId, where: shape(decodeWhere(open.where)) } : null;
}

const and = (...conditions: unknown[]): FilterGroup => ({
  conjunction: 'and',
  conditions: conditions as FilterGroup['conditions'],
});
const or = (...conditions: unknown[]): FilterGroup => ({
  conjunction: 'or',
  conditions: conditions as FilterGroup['conditions'],
});
const is = (fieldId: string, operator: string, value?: unknown) => ({
  fieldId,
  operator,
  ...(value === undefined ? {} : { value }),
});

describe('the records behind a chart', () => {
  it('lists a category’s records with a filter that picks out exactly them', async () => {
    const dashboardId = await board([chart(ids.status)]);
    const answer = await drill(dashboardId, status.active);
    expect(names(answer)).toEqual(['Beta', 'Gamma']);
    expect(listed(answer).total).toBe(2);
    // The tile reads the whole table, so it opens in the table's grid view, which has no filter.
    expect(opened(answer)).toEqual({
      viewId: ids.grid,
      where: and(and(is(ids.status, 'is', status.active))),
    });
    // Each record carries its name and the fields the chart reads, and nothing else.
    expect(Object.keys(listed(answer).rows[0]!.values).sort()).toEqual([ids.name, ids.status].sort());
  });

  it('lists the records with no value as the empty group', async () => {
    const dashboardId = await board([chart(ids.status)]);
    const answer = await drill(dashboardId, null);
    expect(names(answer)).toEqual(['Epsilon']);
    // A stale choice also groups as empty, so the filter names every choice the field still has.
    expect(opened(answer)?.where).toEqual(
      and(and(is(ids.status, 'isNoneOf', [status.planned, status.active, status.done]))),
    );
  });

  it('agrees with the chart’s own count for every category of every kind of field', async () => {
    const tiles = [
      chart(ids.status),
      chart(ids.tags),
      chart(ids.owner),
      chart(ids.amount),
      chart(ids.due, { groupBy: { fieldId: ids.due, dateBucket: 'month' } }),
      chart(ids.due, { groupBy: { fieldId: ids.due, dateBucket: 'week' } }),
      chart(ids.due, { groupBy: { fieldId: ids.due, dateBucket: 'quarter' } }),
      chart(ids.due, { groupBy: { fieldId: ids.due, dateBucket: 'year' } }),
      chart(ids.due),
      chart(ids.at, { groupBy: { fieldId: ids.at, dateBucket: 'day' } }),
      chart(ids.done),
      chart(ids.client),
      chart(ids.name),
    ];
    const dashboardId = await board(tiles);
    for (const timeZone of ['UTC', 'America/Los_Angeles'])
      for (const [index, tile] of tiles.entries()) {
        const tileId = `tile_${index}`;
        const data = await tileData(dashboardId, tileId, server.owner, timeZone);
        if (data.kind !== 'chart') throw new Error(JSON.stringify(data));
        for (const [column, category] of data.categories.entries()) {
          const answer = await drill(dashboardId, category.key, { tileId, timeZone });
          expect(listed(answer).total, `${timeZone} ${JSON.stringify(tile)} ${category.key}`).toBe(
            data.series[0]!.values[column],
          );
        }
      }
  });

  it('lists one part of a divided chart', async () => {
    const dashboardId = await board([chart(ids.status, { seriesBy: ids.tags })]);
    const data = await tileData(dashboardId);
    if (data.kind !== 'chart') throw new Error(JSON.stringify(data));
    for (const [line, series] of data.series.entries())
      for (const [column, category] of data.categories.entries()) {
        const answer = await drill(dashboardId, category.key, { series: series.key });
        expect(listed(answer).total).toBe(data.series[line]!.values[column] ?? 0);
      }
    expect(names(await drill(dashboardId, status.active, { series: tag.red }))).toEqual(['Beta']);
    expect(names(await drill(dashboardId, status.active, { series: null }))).toEqual(['Gamma']);
    expect(opened(await drill(dashboardId, status.active, { series: tag.red }))?.where).toEqual(
      and(and(is(ids.status, 'is', status.active), is(ids.tags, 'hasAnyOf', [tag.red]))),
    );
  });

  it('lists “Other” when a filter can name exactly what it combines', async () => {
    const dashboardId = await board([
      chart(ids.status, { limit: 1 }),
      chart(ids.tags, { limit: 1 }),
      chart(ids.amount, { limit: 2 }),
      chart(ids.status, { limit: 1, sort: 'valueDescending' }),
    ]);
    const otherOf = async (tileId: string) => {
      const data = await tileData(dashboardId, tileId);
      if (data.kind !== 'chart' || !data.truncated) throw new Error(JSON.stringify(data));
      expect(data.categories.at(-1)!.key).toBe(OTHER_GROUP_KEY);
      return { data, answer: await drill(dashboardId, OTHER_GROUP_KEY, { tileId }) };
    };
    const status1 = await otherOf('tile_0');
    expect(names(status1.answer)).toEqual(['Beta', 'Delta', 'Epsilon', 'Gamma']);
    expect(listed(status1.answer).total).toBe(status1.data.series[0]!.values.at(-1));
    // Not Planned, which takes in empty values and stale choices too.
    expect(opened(status1.answer)?.where).toEqual(and(and(is(ids.status, 'isNoneOf', [status.planned]))));

    // Records with a choice past the first, or with none at all.
    const tags = await otherOf('tile_1');
    expect(names(tags.answer)).toEqual(['Beta', 'Delta', 'Epsilon', 'Gamma']);
    expect(opened(tags.answer)?.where).toEqual(
      and(or(is(ids.tags, 'hasAnyOf', [tag.blue]), is(ids.tags, 'hasNoneOf', [tag.red, tag.blue]))),
    );

    const amounts = await otherOf('tile_2');
    expect(names(amounts.answer)).toEqual(['Alpha', 'Beta', 'Delta']);
    expect(opened(amounts.answer)?.where).toEqual(
      and(and(is(ids.amount, 'neq', 50), is(ids.amount, 'neq', 75))),
    );

    // Largest first keeps Active, and the empty group falls into Other with the rest.
    const byValue = await otherOf('tile_3');
    expect(names(byValue.answer)).toEqual(['Alpha', 'Delta', 'Epsilon']);
  });

  it('refuses “Other” where no filter can name what it combines', async () => {
    const dashboardId = await board([chart(ids.owner, { limit: 1 }), chart(ids.client, { limit: 1 })]);
    for (const tileId of ['tile_0', 'tile_1'])
      expect(await drill(dashboardId, OTHER_GROUP_KEY, { tileId })).toEqual({
        kind: 'error',
        messageKey: 'dashboards.drill.otherUnsupported',
      });
  });

  it('refuses a part that no filter picks out exactly, rather than listing something close', async () => {
    const dashboardId = await board([chart(ids.kind)]);
    // A text filter ignores case, so "Alpha" would also take in "alpha", a category of its own.
    expect(await drill(dashboardId, 'Alpha')).toEqual({
      kind: 'error',
      messageKey: 'dashboards.drill.inexact',
    });
    expect(names(await drill(dashboardId, 'Beta'))).toEqual(['Epsilon', 'Gamma']);
  });

  it('says so when the chart no longer combines anything as “Other”', async () => {
    const dashboardId = await board([chart(ids.status)]);
    expect(await drill(dashboardId, OTHER_GROUP_KEY)).toEqual({
      kind: 'error',
      messageKey: 'dashboards.drill.changed',
    });
  });

  it('reads through the tile’s view and filter, and opens in a grid view that shows the same', async () => {
    const notDone = newId('view');
    await run({
      kind: 'view.create',
      view: {
        id: notDone,
        tableId: ids.projects,
        name: 'Not done',
        type: 'grid',
        config: {
          filter: and({ id: 'd', ...is(ids.done, 'is', false) }),
        },
      },
    });
    const board_ = newId('view');
    await run({
      kind: 'view.create',
      view: {
        id: board_,
        tableId: ids.projects,
        name: 'Board',
        type: 'kanban',
        config: { filter: and({ id: 'd', ...is(ids.done, 'is', false) }) },
      },
    });
    const big = and({ id: 'a', ...is(ids.amount, 'gt', 60) });
    const dashboardId = await board([
      chart(ids.status, {}, { viewId: notDone, filter: big }),
      chart(ids.status, {}, { viewId: board_ }),
    ]);
    const inGrid = await drill(dashboardId, status.active);
    expect(names(inGrid)).toEqual(['Beta']);
    // The view's own filter already applies there, so the address carries only the rest.
    expect(opened(inGrid)).toEqual({
      viewId: notDone,
      where: and(and(is(ids.amount, 'gt', 60)), and(is(ids.status, 'is', status.active))),
    });
    // A kanban can't take a filter, so the records open in the grid view with no filter of its own.
    const fromBoard = await drill(dashboardId, status.active, { tileId: 'tile_1' });
    expect(names(fromBoard)).toEqual(['Beta']);
    expect(opened(fromBoard)).toEqual({
      viewId: ids.grid,
      where: and(and(is(ids.done, 'is', false)), and(is(ids.status, 'is', status.active))),
    });
    await run({ kind: 'view.trash', viewId: notDone });
    await run({ kind: 'view.trash', viewId: board_ });
  });

  it('opens nowhere when every grid view of the table has a filter of its own', async () => {
    const clientsView = newId('view');
    await run({
      kind: 'view.create',
      view: {
        id: clientsView,
        tableId: ids.clients,
        name: 'Board',
        type: 'kanban',
      },
    });
    const grids = (
      await query<{ id: string }>(
        server.pool,
        sql`SELECT id FROM ${ident(server.schemas.app, 'views')} WHERE table_id = ${ids.clients} AND type = 'grid'`,
      )
    ).rows;
    for (const grid of grids)
      await run({
        kind: 'view.update',
        viewId: grid.id,
        config: { filter: and({ id: 'n', ...is(ids.clientName, 'isNotEmpty') }) },
      });
    const dashboardId = await board([{ ...chart(ids.clientName, {}, { tableId: ids.clients }) }]);
    const answer = await drill(dashboardId, 'Acme');
    expect(listed(answer).rows.map((row) => row.id)).toEqual([clients.acme]);
    expect(listed(answer).open).toBeNull();
  });

  it('pages through the records in the view’s order', async () => {
    const dashboardId = await board([chart(ids.done)]);
    const first = listed(await drill(dashboardId, 'false', { limit: 2 }));
    const rest = listed(await drill(dashboardId, 'false', { limit: 2, offset: 2 }));
    expect(first.total).toBe(3);
    expect(first.rows).toHaveLength(2);
    expect([...first.rows, ...rest.rows].map((row) => row.id)).toEqual([
      records.beta,
      records.delta,
      records.epsilon,
    ]);
  });
});

describe('who may see the records behind a chart', () => {
  beforeAll(async () => {
    const permission = await server.app.inject({
      method: 'PUT',
      url: `/api/fields/${ids.salary}/permissions`,
      headers: server.owner.headers,
      payload: { restricted: { roles: ['owner'], users: [] }, locked: null },
    });
    expect(permission.statusCode, permission.body).toBe(200);
    // Readers see only the records that aren't done.
    const rules = await server.app.inject({
      method: 'PUT',
      url: `/api/tables/${ids.projects}/record-rules`,
      headers: server.owner.headers,
      payload: {
        rules: [
          {
            id: newId('recordRule'),
            roles: ['reader'],
            users: [],
            condition: and({ id: 'open', ...is(ids.done, 'is', false) }),
          },
        ],
      },
    });
    expect(rules.statusCode, rules.body).toBe(200);
  });

  it('lists only the records and fields the reader may see', async () => {
    const salaryBoard = newId('view');
    await run({
      kind: 'view.create',
      view: {
        id: salaryBoard,
        tableId: ids.projects,
        name: 'Well paid',
        type: 'kanban',
        config: { filter: and({ id: 's', ...is(ids.salary, 'gt', 15) }) },
      },
    });
    const dashboardId = await board([
      chart(ids.status),
      chart(ids.salary),
      chart(ids.status, {}, { filter: and({ id: 's', ...is(ids.salary, 'gt', 15) }) }),
      chart(ids.status, {}, { viewId: salaryBoard }),
    ]);
    const answer = await drill(dashboardId, status.active, { who: reader });
    expect(names(answer)).toEqual(['Beta']);
    expect(listed(answer).rows.every((row) => !(ids.salary in row.values))).toBe(true);
    // The owner's records come from everything.
    expect(names(await drill(dashboardId, status.active))).toEqual(['Beta', 'Gamma']);
    // A tile that groups or filters by a field the reader can't see is unavailable to them, as on
    // the dashboard itself.
    for (const tileId of ['tile_1', 'tile_2'])
      expect(
        await drill(dashboardId, tileId === 'tile_1' ? 30 : status.done, { who: reader, tileId }),
      ).toEqual({
        kind: 'error',
        messageKey: 'dashboards.tile.unavailable',
      });
    expect(names(await drill(dashboardId, status.done, { tileId: 'tile_2' }))).toEqual(['Delta']);
    // A view's condition on a field the reader can't see doesn't apply for them, and the address
    // never carries it.
    const viaView = await drill(dashboardId, status.active, { who: reader, tileId: 'tile_3' });
    expect(names(viaView)).toEqual(['Beta']);
    expect(opened(viaView)).toEqual({
      viewId: ids.grid,
      where: and(and(is(ids.status, 'is', status.active))),
    });
    const owners = await drill(dashboardId, status.active, { tileId: 'tile_3' });
    expect(names(owners)).toEqual(['Beta', 'Gamma']);
    expect(opened(owners)?.where).toEqual(
      and(and(is(ids.salary, 'gt', 15)), and(is(ids.status, 'is', status.active))),
    );
    await run({ kind: 'view.trash', viewId: salaryBoard });
  });

  it('answers only people who can read the database, about chart tiles that exist', async () => {
    const dashboardId = await board([
      chart(ids.status),
      { kind: 'number', source: { tableId: ids.projects }, value: { fn: 'count' } },
    ]);
    const outsider = await server.addMember();
    const slice = { timeZone: 'UTC', slice: { category: status.active } };
    expect((await post(dashboardId, 'tile_0', slice, outsider)).statusCode).toBe(404);
    expect((await post(dashboardId, 'tile_0', slice)).statusCode).toBe(401);
    expect((await post(dashboardId, 'tile_1', slice, server.owner)).statusCode).toBe(404);
    expect((await post(dashboardId, 'tile_9', slice, server.owner)).statusCode).toBe(404);
    expect((await post(newId('dashboard'), 'tile_0', slice, server.owner)).statusCode).toBe(404);
    // A key that can't be one of the chart's, a series it doesn't have, or a strange time zone.
    expect(
      (await post(dashboardId, 'tile_0', { ...slice, slice: { category: 12 } }, server.owner)).statusCode,
    ).toBe(422);
    expect(
      (await post(dashboardId, 'tile_0', { ...slice, slice: { category: null, series: null } }, server.owner))
        .statusCode,
    ).toBe(422);
    expect(
      (await post(dashboardId, 'tile_0', { ...slice, timeZone: 'Mars/Olympus_Mons' }, server.owner))
        .statusCode,
    ).toBe(422);
  });
});

describe('a view narrowed by a where token', () => {
  const get = async <T>(path: string, who = server.owner) => {
    const response = await server.app.inject({ method: 'GET', url: path, headers: who.headers });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<T>();
  };

  it('exports only the drilled records through the reader’s access', async () => {
    const dashboardId = await board([chart(ids.status)]);
    const answer = listed(await drill(dashboardId, status.active));
    expect(answer.open).not.toBeNull();
    const { viewId, where } = answer.open!;
    const search = new URLSearchParams({ format: 'csv', timeZone: 'UTC', locale: 'en-US', where });
    const download = async (who = server.owner) => {
      const response = await server.app.inject({
        method: 'GET',
        url: `/api/views/${viewId}/export?${search}`,
        headers: who.headers,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.body;
    };
    const ownerCsv = await download();
    expect(ownerCsv).toContain('Beta');
    expect(ownerCsv).toContain('Gamma');
    for (const name of ['Alpha', 'Delta', 'Epsilon']) expect(ownerCsv).not.toContain(name);
    const readerCsv = await download(reader);
    expect(readerCsv).toContain('Beta');
    for (const name of ['Alpha', 'Gamma', 'Delta', 'Epsilon', 'Salary'])
      expect(readerCsv).not.toContain(name);
  });

  it('reads its rows, positions, searches, and summary through the token and the reader’s access', async () => {
    const where = encodeWhere(and({ id: 'w', ...is(ids.status, 'is', status.active) }));
    const page = await get<RowsPage>(`/api/views/${ids.grid}/rows?where=${where}`);
    expect(page.total).toBe(2);
    expect(page.rows.map((row) => row?.values[ids.name]).sort()).toEqual(['Beta', 'Gamma']);
    const position = await get<PositionResult>(
      `/api/views/${ids.grid}/position?snapshot=${page.snapshot}&recordId=${records.alpha}&where=${where}`,
    );
    expect(position.index).toBeNull();
    const found = await server.app.inject({
      method: 'POST',
      url: `/api/views/${ids.grid}/search`,
      headers: server.owner.headers,
      payload: { query: 'a', where },
    });
    expect(found.statusCode, found.body).toBe(200);
    expect(new Set(found.json<ViewSearchResult>().matches.map((match) => match.recordId))).toEqual(
      new Set([records.beta, records.gamma]),
    );
    const summary = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${ids.database}/views/${ids.grid}/aggregate`,
      headers: server.owner.headers,
      payload: { timeZone: 'UTC', summary: true, where },
    });
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json<ViewAggregate>()).toMatchObject({ kind: 'summary', records: 2 });
    // Without the token, the view is as it always was.
    expect((await get<RowsPage>(`/api/views/${ids.grid}/rows`)).total).toBe(5);
    // The reader's record rule still applies under the token.
    expect((await get<RowsPage>(`/api/views/${ids.grid}/rows?where=${where}`, reader)).total).toBe(1);
  });

  it('leaves out conditions on fields the reader can’t see, and refuses tokens that aren’t one', async () => {
    const hidden = encodeWhere(and({ id: 'w', ...is(ids.salary, 'gt', 1_000) }));
    expect((await get<RowsPage>(`/api/views/${ids.grid}/rows?where=${hidden}`, reader)).total).toBe(3);
    expect((await get<RowsPage>(`/api/views/${ids.grid}/rows?where=${hidden}`)).total).toBe(0);
    for (const token of ['not-a-filter', 'e30', '%7B%7D'])
      expect(
        (
          await server.app.inject({
            method: 'GET',
            url: `/api/views/${ids.grid}/rows?where=${token}`,
            headers: server.owner.headers,
          })
        ).statusCode,
      ).toBe(422);
  });
});
