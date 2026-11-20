import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DatabaseCreate,
  newId,
  type CommandBatchResult,
  type GridSummary,
  type ViewAggregate,
} from '@riosoma/contracts';
import { sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { AccessScope } from '../access.js';

let kit: TestPostgres;
let server: ServerFixture;
let member: SignedIn;
const clientId = newId('client');

const ids = {
  database: newId('database'),
  projects: newId('table'),
  name: newId('field'),
  amount: newId('field'),
  score: newId('field'),
  due: newId('field'),
  at: newId('field'),
  done: newId('field'),
  tags: newId('field'),
  owner: newId('field'),
  notes: newId('field'),
  shout: newId('field'),
};
const tag = { red: newId('choice'), blue: newId('choice') };
const records = {
  alpha: newId('record'),
  beta: newId('record'),
  gamma: newId('record'),
  delta: newId('record'),
  epsilon: newId('record'),
};

/** Sends a command as the web app does, so a view's settings patch names only the keys it changes. */
async function send(input: Record<string, unknown>) {
  const command = { id: newId('command'), groupId: newId('action'), ...input };
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

/** Five projects with every kind of value a summary reads, one of them nearly empty. */
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'gridsum');
  member = await server.addMember({ name: 'Morgan' });
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: DatabaseCreate.parse({
      id: ids.database,
      name: 'Work',
      table: {
        id: ids.projects,
        name: 'Projects',
        fields: [
          { id: ids.name, name: 'Name', type: 'text' },
          { id: ids.amount, name: 'Amount', type: 'currency', options: { code: 'USD' } },
          { id: ids.score, name: 'Score', type: 'number' },
          { id: ids.due, name: 'Due', type: 'date' },
          { id: ids.at, name: 'At', type: 'date', options: { includeTime: true } },
          { id: ids.done, name: 'Done', type: 'checkbox' },
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
          { id: ids.notes, name: 'Notes', type: 'text' },
        ],
        view: { id: newId('view'), name: 'Grid' },
      },
    }),
  });
  expect(created.statusCode, created.body).toBe(200);
  const owner = server.owner.userId;
  const row = (
    id: string,
    name: string,
    [amount, score, due, at, done, tags, people, notes]: [
      number | null,
      number | null,
      string | null,
      string | null,
      boolean,
      string[],
      string[],
      string | null,
    ],
  ) => ({
    id,
    values: {
      [ids.name]: name,
      [ids.amount]: amount,
      [ids.score]: score,
      [ids.due]: due,
      [ids.at]: at,
      [ids.done]: done,
      [ids.tags]: tags,
      [ids.owner]: people,
      [ids.notes]: notes,
    },
  });
  await run({
    kind: 'record.create',
    tableId: ids.projects,
    records: [
      row(records.alpha, 'Alpha', [
        100,
        5,
        '2026-01-15',
        '2026-09-30T23:30:00.000Z',
        true,
        [tag.red],
        [owner],
        'First',
      ]),
      row(records.beta, 'Beta', [
        250.5,
        3,
        '2026-02-01',
        '2026-10-01T12:00:00.000Z',
        false,
        [tag.red, tag.blue],
        [member.userId],
        null,
      ]),
      row(records.gamma, 'Gamma', [
        50,
        5,
        '2026-02-20',
        '2026-09-15T08:00:00.000Z',
        true,
        [],
        [owner],
        'Third',
      ]),
      row(records.delta, 'Delta', [null, null, null, null, false, [tag.blue], [], null]),
      row(records.epsilon, 'Epsilon', [
        75,
        8,
        '2026-03-03',
        '2026-12-31T23:00:00.000Z',
        false,
        [],
        [member.userId],
        'Fifth',
      ]),
    ],
  });
  // Postgres can't compute this formula, so nothing that reads its values in SQL can summarize it.
  await run({
    kind: 'field.create',
    tableId: ids.projects,
    field: {
      id: ids.shout,
      name: 'Shout',
      type: 'formula',
      options: { expression: 'REGEX_REPLACE({Name}, "[aeiou]", "")' },
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

type Settings = Record<string, unknown>;

async function gridView(config: Settings = {}, tableId = ids.projects): Promise<string> {
  const id = newId('view');
  await run({ kind: 'view.create', view: { id, tableId, name: id, type: 'grid', config } });
  return id;
}

async function post(viewId: string, body: Settings = {}, who: SignedIn = server.owner) {
  return server.app.inject({
    method: 'POST',
    url: `/api/databases/${ids.database}/views/${viewId}/aggregate`,
    headers: who.headers,
    payload: { timeZone: 'UTC', summary: true, ...body },
  });
}

async function summary(viewId: string, who: SignedIn = server.owner): Promise<GridSummary> {
  const response = await post(viewId, {}, who);
  expect(response.statusCode, response.body).toBe(200);
  const answer = response.json<ViewAggregate>();
  if (answer.kind !== 'summary') throw new Error(`expected a summary, got ${JSON.stringify(answer)}`);
  return answer;
}

/** Each field's value for the kinds given, one view per kind so every kind is read. */
async function each(fieldId: string, kinds: readonly string[]) {
  const found: Record<string, unknown> = {};
  for (const kind of kinds) {
    const answer = await summary(await gridView({ summaries: { [fieldId]: kind } }));
    found[kind] = answer.values[fieldId]?.value;
  }
  return found;
}

describe('the grid’s summary row', () => {
  it('counts the view’s records, filled and empty cells, and unique values of every kind of field', async () => {
    const answer = await summary(
      await gridView({
        summaries: {
          [ids.amount]: 'count',
          [ids.notes]: 'filled',
          [ids.due]: 'empty',
          [ids.score]: 'percentFilled',
          [ids.tags]: 'unique',
          [ids.owner]: 'unique',
          [ids.at]: 'none',
        },
      }),
    );
    expect(answer).toEqual({
      kind: 'summary',
      records: 5,
      values: {
        [ids.amount]: { kind: 'count', value: 5 },
        [ids.notes]: { kind: 'filled', value: 3 },
        [ids.due]: { kind: 'empty', value: 1 },
        [ids.score]: { kind: 'percentFilled', value: 0.8 },
        // Each choice and each person counts once, however many records hold them.
        [ids.tags]: { kind: 'unique', value: 2 },
        [ids.owner]: { kind: 'unique', value: 2 },
      },
    });
    expect(await each(ids.tags, ['filled', 'empty', 'percentFilled'])).toEqual({
      filled: 3,
      empty: 2,
      percentFilled: 0.6,
    });
  });

  it('sums, averages, and ranges numbers in the field’s own unit, leaving empty cells out', async () => {
    expect(await each(ids.amount, ['sum', 'average', 'median', 'min', 'max', 'range', 'unique'])).toEqual({
      sum: 475.5,
      average: 118.875,
      median: 87.5,
      min: 50,
      max: 250.5,
      range: 200.5,
      unique: 4,
    });
    expect(await each(ids.score, ['sum', 'average', 'median', 'range'])).toEqual({
      sum: 21,
      average: 5.25,
      median: 5,
      range: 5,
    });
  });

  it('gives the earliest and latest dates as the field holds them, and the days between', async () => {
    expect(await each(ids.due, ['earliest', 'latest', 'range'])).toEqual({
      earliest: '2026-01-15',
      latest: '2026-03-03',
      range: 47,
    });
    expect(await each(ids.at, ['earliest', 'latest', 'range'])).toEqual({
      earliest: '2026-09-15T08:00:00.000Z',
      latest: '2026-12-31T23:00:00.000Z',
      range: 107.625,
    });
  });

  it('counts checked and unchecked boxes', async () => {
    expect(await each(ids.done, ['checked', 'unchecked', 'count'])).toEqual({
      checked: 2,
      unchecked: 3,
      count: 5,
    });
  });

  it('reads only the records the view’s filter lets through', async () => {
    const answer = await summary(
      await gridView({
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'checked', fieldId: ids.done, operator: 'is', value: true }],
        },
        summaries: { [ids.amount]: 'sum', [ids.due]: 'latest', [ids.tags]: 'unique' },
      }),
    );
    expect(answer.records).toBe(2);
    expect(answer.values).toEqual({
      [ids.amount]: { kind: 'sum', value: 150 },
      [ids.due]: { kind: 'latest', value: '2026-02-20' },
      [ids.tags]: { kind: 'unique', value: 1 },
    });
  });

  it('leaves out records and fields the reader can’t see, and summarizes for readers too', async () => {
    const viewId = await gridView({
      summaries: { [ids.amount]: 'sum', [ids.score]: 'sum', [ids.owner]: 'unique' },
    });
    const reader = await server.addMember();
    expect((await post(viewId, {}, reader)).statusCode).toBe(404);
    await server.pool.query(
      `INSERT INTO "${server.schemas.app}".grants
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES ($1, 'database', $2, 'user', $3, 'reader')`,
      [reader.info.org.id, ids.database, reader.userId],
    );
    expect((await summary(viewId, reader)).values[ids.score]).toEqual({ kind: 'sum', value: 21 });
    vi.spyOn(AccessScope.prototype, 'recordPredicate').mockReturnValue(sql`__id <> ${records.alpha}`);
    vi.spyOn(AccessScope.prototype, 'visibleFields').mockImplementation((_tableId, fields) =>
      fields.filter((field) => field.id !== ids.amount),
    );
    const answer = await summary(viewId, reader);
    expect(answer.records).toBe(4);
    expect(answer.values).toEqual({
      [ids.score]: { kind: 'sum', value: 16 },
      [ids.owner]: { kind: 'unique', value: 2 },
    });
  });

  it('leaves out hidden fields, the primary field, and summaries that don’t fit their field', async () => {
    const answer = await summary(
      await gridView({
        hiddenFieldIds: [ids.score],
        summaries: {
          [ids.name]: 'unique',
          [ids.score]: 'sum',
          [ids.notes]: 'sum',
          [ids.done]: 'filled',
          [ids.shout]: 'unique',
          [ids.amount]: 'max',
        },
      }),
    );
    expect(answer).toEqual({
      kind: 'summary',
      records: 5,
      values: { [ids.amount]: { kind: 'max', value: 250.5 } },
    });
  });

  it('keeps the rest of the row when one column’s values can’t be summarized', async () => {
    const table = newId('table');
    const label = newId('field');
    const huge = newId('field');
    const small = newId('field');
    await run({
      kind: 'table.create',
      table: {
        id: table,
        name: 'Huge',
        fields: [
          { id: label, name: 'Name', type: 'text' },
          { id: huge, name: 'Huge', type: 'number' },
          { id: small, name: 'Small', type: 'number' },
        ],
        view: { id: newId('view'), name: 'Grid' },
      },
    });
    await run({
      kind: 'record.create',
      tableId: table,
      records: [
        { id: newId('record'), values: { [label]: 'One', [huge]: 1e308, [small]: 1 } },
        { id: newId('record'), values: { [label]: 'Two', [huge]: 1e308, [small]: 2 } },
      ],
    });
    // The sum is too large for a double, which the database refuses to convert.
    const answer = await summary(await gridView({ summaries: { [huge]: 'sum', [small]: 'sum' } }, table));
    expect(answer).toEqual({
      kind: 'summary',
      records: 2,
      values: { [small]: { kind: 'sum', value: 3 } },
    });
  });

  it('keeps a summary its field outgrew without blocking later changes to the view', async () => {
    const extra = newId('field');
    await run({
      kind: 'field.create',
      tableId: ids.projects,
      field: { id: extra, name: `Extra ${extra}`, type: 'number' },
    });
    const viewId = await gridView({ summaries: { [extra]: 'sum', [ids.score]: 'max' } });
    await run({ kind: 'field.convert', fieldId: extra, to: { type: 'text' } });
    await run({ kind: 'view.update', viewId, config: { columnWidths: { [ids.score]: 200 } } });
    expect((await summary(viewId)).values).toEqual({ [ids.score]: { kind: 'max', value: 8 } });
  });

  it('checks the fields summaries name and answers only for grid views', async () => {
    const viewId = await gridView();
    expect(
      await send({ kind: 'view.update', viewId, config: { summaries: { [newId('field')]: 'sum' } } }),
    ).toMatchObject({ status: 'rejected', error: { messageKey: 'errors.notFound' } });
    expect((await post(viewId, { records: {} })).statusCode).toBe(422);
    const chart = newId('view');
    await run({
      kind: 'view.create',
      view: {
        id: chart,
        tableId: ids.projects,
        name: chart,
        type: 'chart',
        config: { chart: { groupBy: { fieldId: ids.done } } },
      },
    });
    const refused = await post(chart);
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({
      error: { messageKey: 'data.view.badSetting', params: { setting: 'type' } },
    });
    // Without asking for the summary, a grid still has no numbers of its own.
    expect((await post(viewId, { summary: false })).statusCode).toBe(422);
    expect(await summary(viewId)).toEqual({ kind: 'summary', records: 5, values: {} });
  });
});
