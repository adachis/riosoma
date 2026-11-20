import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Command,
  DatabaseCreate,
  newId,
  type CommandBatchResult,
  type InterfaceData,
  type InterfaceRecordsPage,
  type RowData,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { AccessScope } from '../access.js';

let kit: TestPostgres;
let server: ServerFixture;
let member: SignedIn;
const clientId = newId('client');

const choice = () => newId('choice');
const ids = {
  database: newId('database'),
  requests: newId('table'),
  clients: newId('table'),
  grid: newId('view'),
  byAmount: newId('view'),
  clientGrid: newId('view'),
  name: newId('field'),
  status: newId('field'),
  tags: newId('field'),
  owner: newId('field'),
  urgent: newId('field'),
  amount: newId('field'),
  clientName: newId('field'),
};
const status = { open: choice(), done: choice() };
const tag = { red: choice(), blue: choice() };
const records = {
  alpha: newId('record'),
  beta: newId('record'),
  gamma: newId('record'),
  delta: newId('record'),
  epsilon: newId('record'),
  zeta: newId('record'),
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
  server = await startServer(kit, 'itfdata');
  member = await server.addMember({ name: 'Morgan' });
  const input = DatabaseCreate.parse({
    id: ids.database,
    name: 'Work',
    table: {
      id: ids.requests,
      name: 'Requests',
      fields: [
        { id: ids.name, name: 'Name', type: 'text' },
        {
          id: ids.status,
          name: 'Status',
          type: 'singleSelect',
          options: {
            choices: [
              { id: status.open, name: 'Open', color: 'blue' },
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
        { id: ids.urgent, name: 'Urgent', type: 'checkbox' },
        { id: ids.amount, name: 'Amount', type: 'number' },
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
      view: { id: ids.clientGrid, name: 'Grid' },
    },
  });
  const owner = server.owner.userId;
  const row = (
    id: string,
    name: string,
    values: [string | null, string[], string[], boolean, number | null],
  ) => ({
    id,
    values: {
      [ids.name]: name,
      [ids.status]: values[0],
      [ids.tags]: values[1],
      [ids.owner]: values[2],
      [ids.urgent]: values[3],
      [ids.amount]: values[4],
    },
  });
  await run({
    kind: 'record.create',
    tableId: ids.requests,
    records: [
      row(records.alpha, 'Alpha printer', [status.open, [tag.red], [owner], true, 40]),
      row(records.beta, 'Beta laptop', [status.open, [tag.red, tag.blue], [member.userId], false, 90]),
      row(records.gamma, 'Gamma printer', [status.done, [], [owner], true, 10]),
      row(records.delta, 'Delta desk', [status.open, [tag.blue], [], false, 70]),
      row(records.epsilon, 'Epsilon chair', [null, [], [member.userId], true, null]),
      row(records.zeta, 'Zeta printer', [status.open, [], [owner], false, 20]),
    ],
  });
  await run({
    kind: 'record.create',
    tableId: ids.clients,
    records: [{ id: newId('record'), values: { [ids.clientName]: 'Acme' } }],
  });
  // The largest amounts first, leaving out records without one.
  await run({
    kind: 'view.create',
    view: {
      id: ids.byAmount,
      tableId: ids.requests,
      name: 'By amount',
      type: 'grid',
      config: {
        sorts: [{ fieldId: ids.amount, direction: 'desc' }],
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'has', fieldId: ids.amount, operator: 'isNotEmpty' }],
        },
      },
    },
  });
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Block = Record<string, unknown>;

const records0 = (extra: Block = {}, source: Block = {}): Block => ({
  id: 'records01',
  kind: 'records',
  source: { tableId: ids.requests, viewId: ids.byAmount, ...source },
  fieldIds: [ids.amount],
  ...extra,
});
const filter = (id: string, control: 'choice' | 'search', fieldId: string, extra: Block = {}): Block => ({
  id,
  kind: 'filter',
  control,
  tableId: ids.requests,
  fieldId,
  ...extra,
});

/** A fresh interface with one page of these blocks, placed one below another. */
async function build(blocks: Block[]) {
  const interfaceId = newId('interface');
  const pages = [
    {
      id: 'pageMain01',
      name: 'Main',
      blocks: blocks.map((block, index) => ({ place: { x: 0, y: index * 4, w: 6, h: 4 }, ...block })),
    },
  ];
  await run({ kind: 'interface.create', interface: { id: interfaceId, name: 'Desk', pages } });
  return interfaceId;
}

async function post(interfaceId: string, route: 'records' | 'data', payload: Block, who = server.owner) {
  return server.app.inject({
    method: 'POST',
    url: `/api/interfaces/${interfaceId}/${route}`,
    headers: who.headers,
    payload,
  });
}

async function page(
  interfaceId: string,
  body: Block = {},
  who = server.owner,
): Promise<InterfaceRecordsPage> {
  const response = await post(
    interfaceId,
    'records',
    { pageId: 'pageMain01', blockId: 'records01', offset: 0, limit: 50, timeZone: 'UTC', ...body },
    who,
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json<InterfaceRecordsPage>();
}

const namesOf = (answer: InterfaceRecordsPage) =>
  answer.rows.map((row) => (row?.values[ids.name] as string | undefined) ?? null);

describe('records blocks', () => {
  it('page through the view’s order with the block’s own filter, keeping one order across pages', async () => {
    const interfaceId = await build([
      records0(
        {},
        {
          filter: {
            conjunction: 'and',
            conditions: [{ id: 'open', fieldId: ids.status, operator: 'is', value: status.open }],
          },
        },
      ),
    ]);
    const first = await page(interfaceId, { limit: 2 });
    expect(first.total).toBe(4);
    expect(namesOf(first)).toEqual(['Beta laptop', 'Delta desk']);
    expect(first.rows[0]!.values[ids.amount]).toBe(90);
    // A record that changes after the order was taken keeps its place until the order is taken again.
    await run({
      kind: 'record.update',
      tableId: ids.requests,
      records: [{ id: records.zeta, values: { [ids.amount]: 100 } }],
    });
    const second = await page(interfaceId, { offset: 2, limit: 2, snapshot: first.snapshot });
    expect(second.snapshot).toBe(first.snapshot);
    expect(second.offset).toBe(2);
    expect(namesOf(second)).toEqual(['Alpha printer', 'Zeta printer']);
    const fresh = await page(interfaceId, { limit: 2, snapshot: first.snapshot, refresh: true });
    expect(namesOf(fresh)).toEqual(['Zeta printer', 'Beta laptop']);
    await run({
      kind: 'record.update',
      tableId: ids.requests,
      records: [{ id: records.zeta, values: { [ids.amount]: 20 } }],
    });
  });

  it('narrow with the page’s filter blocks: choices, people, checkboxes, and searches', async () => {
    const interfaceId = await build([
      records0({}, { viewId: ids.grid }),
      filter('status01', 'choice', ids.status),
      filter('tags0001', 'choice', ids.tags),
      filter('owner001', 'choice', ids.owner),
      filter('urgent01', 'choice', ids.urgent),
      filter('search01', 'search', ids.name),
      // Filter blocks that name other records blocks leave this one alone.
      filter('elsewhere', 'search', ids.name, { blockIds: ['records02'] }),
      { id: 'records02', kind: 'records', source: { tableId: ids.requests, viewId: ids.grid } },
    ]);
    const names = async (filters: Record<string, string | boolean>) =>
      namesOf(await page(interfaceId, { filters }));
    const everyone = [
      'Alpha printer',
      'Beta laptop',
      'Gamma printer',
      'Delta desk',
      'Epsilon chair',
      'Zeta printer',
    ];
    expect(await names({})).toEqual(everyone);
    expect(await names({ status01: status.done })).toEqual(['Gamma printer']);
    expect(await names({ tags0001: tag.blue })).toEqual(['Beta laptop', 'Delta desk']);
    expect(await names({ owner001: member.userId })).toEqual(['Beta laptop', 'Epsilon chair']);
    expect(await names({ urgent01: false })).toEqual(['Beta laptop', 'Delta desk', 'Zeta printer']);
    expect(await names({ search01: '  PRINTER ' })).toEqual([
      'Alpha printer',
      'Gamma printer',
      'Zeta printer',
    ]);
    expect(await names({ search01: 'printer', status01: status.open, urgent01: true })).toEqual([
      'Alpha printer',
    ]);
    expect(await names({ elsewhere: 'desk' })).toEqual(everyone);
    // Nothing chosen, values that don't suit the field, and blocks that aren't there narrow nothing.
    expect(await names({ search01: '', status01: true, urgent01: 'yes', missing01: 'Alpha' })).toEqual(
      everyone,
    );
    const other = await page(interfaceId, { blockId: 'records02', filters: { elsewhere: 'desk' } });
    expect(namesOf(other)).toEqual(['Delta desk']);
  });

  it('read through the person’s access: hidden records stay out, hidden fields make the block unavailable, and filters over them narrow nothing', async () => {
    const interfaceId = await build([
      records0({ fieldIds: [ids.name] }, { viewId: ids.grid }),
      {
        id: 'records02',
        kind: 'records',
        source: { tableId: ids.requests, viewId: ids.grid },
        fieldIds: [ids.amount],
      },
      filter('amount01', 'search', ids.name),
      filter('status01', 'choice', ids.status),
    ]);
    vi.spyOn(AccessScope.prototype, 'recordPredicate').mockReturnValue(sql`__id <> ${records.alpha}`);
    vi.spyOn(AccessScope.prototype, 'visibleFields').mockImplementation((_tableId, fields) =>
      fields.filter((field) => field.id !== ids.amount && field.id !== ids.status),
    );
    const answer = await page(interfaceId, { filters: { status01: status.done } });
    expect(answer.total).toBe(5);
    expect(namesOf(answer)).not.toContain('Alpha printer');
    expect(Object.keys(answer.rows[0]!.values)).not.toContain(ids.amount);
    const hidden = await post(interfaceId, 'records', {
      pageId: 'pageMain01',
      blockId: 'records02',
      offset: 0,
      limit: 10,
      timeZone: 'UTC',
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ error: { messageKey: 'interfaces.block.unavailable' } });
  });

  it('answer for deleted views and fields, and only for records blocks on live pages', async () => {
    const view = newId('view');
    const field = newId('field');
    await run({
      kind: 'view.create',
      view: { id: view, tableId: ids.requests, name: `View ${view}`, type: 'grid' },
    });
    await run({
      kind: 'field.create',
      tableId: ids.requests,
      field: { id: field, name: `Field ${field}`, type: 'text' },
    });
    const interfaceId = await build([
      records0({}, { viewId: view }),
      {
        id: 'records02',
        kind: 'records',
        source: { tableId: ids.requests, viewId: ids.grid },
        fieldIds: [field],
      },
      { id: 'text0001', kind: 'text', text: 'Hello' },
    ]);
    expect((await page(interfaceId)).total).toBe(6);
    expect((await page(interfaceId, { blockId: 'records02' })).total).toBe(6);
    await run({ kind: 'view.trash', viewId: view });
    await run({ kind: 'field.trash', fieldId: field });
    for (const blockId of ['records01', 'records02']) {
      const gone = await post(interfaceId, 'records', {
        pageId: 'pageMain01',
        blockId,
        offset: 0,
        limit: 5,
        timeZone: 'UTC',
      });
      expect(gone.statusCode).toBe(404);
      expect(gone.json()).toMatchObject({ error: { messageKey: 'interfaces.block.unavailable' } });
    }
    const request = (body: Block) =>
      post(interfaceId, 'records', {
        pageId: 'pageMain01',
        blockId: 'records01',
        offset: 0,
        limit: 5,
        timeZone: 'UTC',
        ...body,
      });
    expect((await request({ blockId: 'text0001' })).statusCode).toBe(404);
    expect((await request({ pageId: 'pageNone01' })).statusCode).toBe(404);
    expect((await request({ timeZone: 'Mars/Olympus_Mons' })).statusCode).toBe(422);
    expect((await request({ limit: 1_000 })).statusCode).toBe(422);
  });
});

describe('number and chart blocks', () => {
  it('are computed the way dashboard tiles are, each on its own', async () => {
    const trashed = newId('field');
    await run({
      kind: 'field.create',
      tableId: ids.requests,
      field: { id: trashed, name: `Gone ${trashed}`, type: 'number' },
    });
    const interfaceId = await build([
      { id: 'count001', kind: 'number', source: { tableId: ids.requests }, value: { fn: 'count' } },
      {
        id: 'total001',
        kind: 'number',
        source: { tableId: ids.requests, viewId: ids.byAmount },
        value: { fn: 'sum', fieldId: ids.amount },
      },
      {
        id: 'chart001',
        kind: 'chart',
        source: { tableId: ids.requests },
        groupBy: { fieldId: ids.status },
        value: { fn: 'count' },
      },
      {
        id: 'wrong001',
        kind: 'number',
        source: { tableId: ids.requests },
        value: { fn: 'sum', fieldId: ids.name },
      },
      {
        id: 'gone0001',
        kind: 'number',
        source: { tableId: ids.requests },
        value: { fn: 'max', fieldId: trashed },
      },
      { id: 'text0001', kind: 'text', text: 'Notes' },
      records0(),
    ]);
    await run({ kind: 'field.trash', fieldId: trashed });
    const response = await post(interfaceId, 'data', { pageId: 'pageMain01', timeZone: 'UTC' });
    expect(response.statusCode, response.body).toBe(200);
    const { blocks } = response.json<InterfaceData>();
    expect(Object.keys(blocks).sort()).toEqual(['chart001', 'count001', 'gone0001', 'total001', 'wrong001']);
    expect(blocks.count001).toEqual({ kind: 'number', value: 6, records: 6 });
    expect(blocks.total001).toEqual({ kind: 'number', value: 230, records: 5 });
    const chart = blocks.chart001!;
    if (chart.kind !== 'chart') throw new Error(`expected a chart, got ${JSON.stringify(chart)}`);
    expect(chart.categories.map((category) => category.label)).toEqual(['Open', 'Done', '']);
    expect(chart.series[0]!.values).toEqual([4, 1, 1]);
    expect(blocks.wrong001).toEqual({ kind: 'error', messageKey: 'interfaces.block.badAggregate' });
    expect(blocks.gone0001).toEqual({ kind: 'error', messageKey: 'interfaces.block.unavailable' });
    const some = await post(interfaceId, 'data', {
      pageId: 'pageMain01',
      blockIds: ['count001', 'text0001'],
      timeZone: 'UTC',
    });
    expect(some.json<InterfaceData>().blocks).toEqual({ count001: { kind: 'number', value: 6, records: 6 } });
  });

  it('leave out records the person can’t see and are unavailable over hidden fields', async () => {
    const interfaceId = await build([
      { id: 'count001', kind: 'number', source: { tableId: ids.requests }, value: { fn: 'count' } },
      {
        id: 'total001',
        kind: 'number',
        source: { tableId: ids.requests },
        value: { fn: 'sum', fieldId: ids.amount },
      },
    ]);
    vi.spyOn(AccessScope.prototype, 'recordPredicate').mockReturnValue(sql`__id <> ${records.alpha}`);
    vi.spyOn(AccessScope.prototype, 'visibleFields').mockImplementation((_tableId, fields) =>
      fields.filter((field) => field.id !== ids.amount),
    );
    const { blocks } = (
      await post(interfaceId, 'data', { pageId: 'pageMain01', timeZone: 'UTC' })
    ).json<InterfaceData>();
    expect(blocks.count001).toEqual({ kind: 'number', value: 5, records: 5 });
    expect(blocks.total001).toEqual({ kind: 'error', messageKey: 'interfaces.block.unavailable' });
  });
});

describe('who can read an interface', () => {
  it('is everyone who can read the database, while the interface is live', async () => {
    const interfaceId = await build([
      records0(),
      { id: 'count001', kind: 'number', source: { tableId: ids.requests }, value: { fn: 'count' } },
    ]);
    const outsider = await server.addMember();
    const body = { pageId: 'pageMain01', blockId: 'records01', offset: 0, limit: 5, timeZone: 'UTC' };
    expect((await post(interfaceId, 'records', body, outsider)).statusCode).toBe(404);
    expect(
      (await post(interfaceId, 'data', { pageId: 'pageMain01', timeZone: 'UTC' }, outsider)).statusCode,
    ).toBe(404);
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${outsider.info.org.id}, 'database', ${ids.database}, 'user', ${outsider.userId}, 'reader')`,
    );
    expect((await page(interfaceId, {}, outsider)).total).toBe(5);
    const data = await post(interfaceId, 'data', { pageId: 'pageMain01', timeZone: 'UTC' }, outsider);
    expect(data.json<InterfaceData>().blocks.count001).toEqual({ kind: 'number', value: 6, records: 6 });
    // A record block reads its record the way the record card does, through the same access.
    vi.spyOn(AccessScope.prototype, 'recordPredicate').mockReturnValue(sql`__id <> ${records.alpha}`);
    const hidden = await server.app.inject({
      url: `/api/tables/${ids.requests}/records/${records.alpha}`,
      headers: outsider.headers,
    });
    expect(hidden.statusCode).toBe(404);
    const shown = await server.app.inject({
      url: `/api/tables/${ids.requests}/records/${records.beta}`,
      headers: outsider.headers,
    });
    expect(shown.json<RowData>().values[ids.name]).toBe('Beta laptop');
    vi.restoreAllMocks();

    await run({ kind: 'interface.trash', interfaceId });
    expect((await post(interfaceId, 'records', body)).statusCode).toBe(404);
    expect((await post(interfaceId, 'data', { pageId: 'pageMain01', timeZone: 'UTC' })).statusCode).toBe(404);
    expect((await post(newId('interface'), 'records', body)).statusCode).toBe(404);
    const anonymous = await server.app.inject({
      method: 'POST',
      url: `/api/interfaces/${interfaceId}/records`,
      payload: body,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
