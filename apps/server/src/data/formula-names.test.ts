import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newId,
  type CommandBatchResult,
  type DatabaseSchema,
  type FieldMeta,
  type FieldSpec,
  type RowData,
  type RowsPage,
} from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import {
  automate,
  createBase,
  createRecords,
  runRows,
  updateRecord,
} from '../automations/automations.test-helpers.js';

/**
 * Formulas read a link as its linked records' names and a choice as its name, never as IDs, in SQL
 * and in JavaScript, and follow a renamed record or choice wherever a formula is read.
 */

let kit: TestPostgres;
let server: ServerFixture;
const clientId = newId('client');
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'formula_names', { automationsPollMs: 0 });
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

interface Table {
  id: string;
  viewId: string;
  nameId: string;
}

async function get<T>(url: string): Promise<T> {
  const response = await server.app.inject({ url, headers: server.owner.headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

/** Sends a command, which applies, or is refused for the reason given. */
async function send(databaseId: string, input: Record<string, unknown>, refused?: string) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: { clientId, commands: [{ id: newId('command'), groupId: newId('action'), ...input }] },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<CommandBatchResult>().results[0]!;
  if (refused) expect(result.error?.messageKey, response.body).toBe(refused);
  else expect(result.status, response.body).toBe('applied');
}

async function setup(firstTable: string) {
  const databaseId = newId('database');
  const spec = (name: string) => ({
    id: newId('table'),
    name,
    fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
    view: { id: newId('view'), name: 'Grid' },
    records: [],
  });
  const first = spec(firstTable);
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: { id: databaseId, name: 'Names', table: first },
  });
  expect(response.statusCode, response.body).toBe(200);
  const entry = (table: ReturnType<typeof spec>): Table => ({
    id: table.id,
    viewId: table.view.id,
    nameId: table.fields[0]!.id,
  });
  const addTable = async (name: string) => {
    const table = spec(name);
    await send(databaseId, { kind: 'table.create', table });
    return entry(table);
  };
  const add = async (table: Table, name: string, field: { type: FieldSpec['type']; options?: object }) => {
    const id = newId('field');
    await send(databaseId, { kind: 'field.create', tableId: table.id, field: { id, name, ...field } });
    return id;
  };
  const formula = (table: Table, name: string, expression: string) =>
    add(table, name, { type: 'formula', options: { expression } });
  const create = async (table: Table, records: Record<string, unknown>[]) => {
    const ids = records.map(() => newId('record'));
    await send(databaseId, {
      kind: 'record.create',
      tableId: table.id,
      records: ids.map((id, index) => ({ id, values: records[index] })),
    });
    return ids;
  };
  const update = (table: Table, id: string, values: Record<string, unknown>) =>
    send(databaseId, { kind: 'record.update', tableId: table.id, records: [{ id, values }] });
  const field = async (id: string) =>
    (await get<DatabaseSchema>(`/api/databases/${databaseId}/schema`)).fields.find((item) => item.id === id)!;
  const page = (table: Table) => get<RowsPage>(`/api/views/${table.viewId}/rows`);
  const record = (table: Table, id: string) => get<RowData>(`/api/tables/${table.id}/records/${id}`);
  /** Every row of the view, by record ID, after checking a record read agrees with the page. */
  const rows = async (table: Table) => {
    const result = await page(table);
    const byId = new Map(result.rows.map((row) => [row!.id, row!]));
    for (const row of byId.values()) expect(await record(table, row.id)).toEqual(row);
    return byId;
  };
  const view = (table: Table, config: Record<string, unknown>) =>
    send(databaseId, { kind: 'view.update', viewId: table.viewId, config });
  const link = async (from: Table, to: Table, name: string) =>
    add(from, name, { type: 'link', options: { linkedTableId: to.id } });
  /** The view as a CSV download, one list of cells per line. */
  const csv = async (table: Table) => {
    const response = await server.app.inject({
      url: `/api/views/${table.viewId}/export?format=csv&timeZone=UTC&locale=en-US`,
      headers: server.owner.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.rawPayload.toString('utf8');
  };
  return {
    databaseId,
    first: entry(first),
    addTable,
    add,
    formula,
    create,
    update,
    field,
    page,
    rows,
    view,
    link,
    csv,
    send: (input: Record<string, unknown>, refused?: string) => send(databaseId, input, refused),
  };
}

/** Orders linked to clients, as the Product Catalog base lays them out. */
async function catalog() {
  const f = await setup('Orders');
  const orders = f.first;
  const clients = await f.addTable('Clients');
  const number = await f.add(orders, 'Order Number', { type: 'autoNumber' });
  const client = await f.link(orders, clients, 'Client');
  const [forrester, smith, unnamed] = await f.create(clients, [
    { [clients.nameId]: 'Forrester Legal Partners' },
    { [clients.nameId]: 'Smith, Jones & "Sons"' },
    { [clients.nameId]: '' },
  ]);
  const [first, second, third, fourth] = await f.create(orders, [
    { [orders.nameId]: 'First', [client]: [forrester] },
    { [orders.nameId]: 'Second', [client]: [smith, forrester] },
    { [orders.nameId]: 'Third' },
    { [orders.nameId]: 'Fourth', [client]: [unnamed] },
  ]);
  return {
    ...f,
    orders,
    clients,
    number,
    client,
    clientIds: { forrester: forrester!, smith: smith!, unnamed: unnamed! },
    orderIds: { first: first!, second: second!, third: third!, fourth: fourth! },
  };
}

describe('formulas over links', () => {
  it('read the linked records’ names, and follow a renamed record into rows, reads, and downloads', async () => {
    const f = await catalog();
    const label = await f.formula(f.orders, 'Label', '{Client} & " Order #" & {Order Number}');
    const forrester = await f.formula(f.orders, 'Forrester', '{Client} = "Forrester Legal Partners"');
    const counted = await f.formula(f.orders, 'Clients', 'COUNTA({Client})');
    // A list joined with a separator of its own, which the database does too.
    const joined = await f.formula(f.orders, 'Joined', 'ARRAYJOIN({Client}, " + ")');
    const own = await f.formula(f.orders, 'Own ID', 'RECORD_ID()');
    let rows = await f.rows(f.orders);
    const { first, second, third, fourth } = f.orderIds;
    expect(rows.get(first)!.values).toMatchObject({
      [label]: 'Forrester Legal Partners Order #1',
      [forrester]: true,
      [counted]: 1,
      [joined]: 'Forrester Legal Partners',
      [own]: first,
    });
    expect(rows.get(second)!.values).toMatchObject({
      [label]: 'Smith, Jones & "Sons", Forrester Legal Partners Order #2',
      [forrester]: null,
      [counted]: 2,
      [joined]: 'Smith, Jones & "Sons" + Forrester Legal Partners',
    });
    // Two linked records aren't one name to compare.
    expect(rows.get(second)!.errors).toEqual({ [forrester]: 'formula.list.several' });
    expect(rows.get(third)!.values).toMatchObject({
      [label]: ' Order #3',
      [forrester]: false,
      [counted]: 0,
      [joined]: '',
    });
    // A record with no name still counts as linked, with an empty name.
    expect(rows.get(fourth)!.values).toMatchObject({ [label]: ' Order #4', [counted]: 0, [joined]: '' });
    // The link's own value is still its records' IDs.
    expect(rows.get(first)!.values[f.client]).toEqual([f.clientIds.forrester]);
    expect((await f.field(label)).options).toMatchObject({ resultType: 'text', sortable: true });
    expect((await f.field(forrester)).options).toMatchObject({ resultType: 'boolean', sortable: true });
    expect((await f.field(joined)).options).toMatchObject({ sortable: true });

    // A filter and a sort read the names too.
    await f.view(f.orders, {
      sorts: [{ fieldId: label, direction: 'desc' }],
      filter: {
        conjunction: 'and',
        conditions: [{ id: 'named', fieldId: label, operator: 'contains', value: 'Forrester' }],
      },
    });
    expect((await f.page(f.orders)).rows.map((row) => row!.id)).toEqual([second, first]);

    await f.update(f.clients, f.clientIds.forrester, { [f.clients.nameId]: 'Forrester LLP' });
    rows = await f.rows(f.orders);
    expect(rows.get(first)!.values).toMatchObject({
      [label]: 'Forrester LLP Order #1',
      [forrester]: false,
      [joined]: 'Forrester LLP',
    });
    expect(rows.get(second)!.values[label]).toBe('Smith, Jones & "Sons", Forrester LLP Order #2');
    const download = await f.csv(f.orders);
    expect(download).toContain('Forrester LLP Order #1');
    expect(download).toContain('"Smith, Jones & ""Sons"", Forrester LLP Order #2"');
    expect(download).not.toContain(f.clientIds.forrester);
  });

  it('read names a primary field formula gives, and refuse ones only JavaScript can give', async () => {
    const f = await catalog();
    const firm = await f.add(f.clients, 'Firm', { type: 'text' });
    await f.update(f.clients, f.clientIds.forrester, { [firm]: 'Forrester' });
    await f.update(f.clients, f.clientIds.smith, { [firm]: 'Smith' });
    await f.send({
      kind: 'field.convert',
      fieldId: f.clients.nameId,
      to: { type: 'formula', options: { expression: '{Firm} & " (client)"' } },
    });
    const label = await f.formula(f.orders, 'Label', '"For " & {Client}');
    const shouted = await f.formula(f.orders, 'Shouted', 'UPPER({Client} & "")');
    let rows = await f.rows(f.orders);
    expect(rows.get(f.orderIds.second)!.values).toMatchObject({
      [label]: 'For Smith (client), Forrester (client)',
      [shouted]: 'SMITH (CLIENT), FORRESTER (CLIENT)',
    });
    expect(rows.get(f.orderIds.fourth)!.values).toMatchObject({ [label]: 'For  (client)' });
    await f.update(f.clients, f.clientIds.smith, { [firm]: 'Smythe' });
    rows = await f.rows(f.orders);
    expect(rows.get(f.orderIds.second)!.values[label]).toBe('For Smythe (client), Forrester (client)');

    // A primary field formula that only JavaScript computes has no name SQL could read.
    await f.send({
      kind: 'field.update',
      fieldId: f.clients.nameId,
      options: { expression: 'REGEX_REPLACE({Firm}, " ", "-")' },
    });
    rows = await f.rows(f.orders);
    for (const id of [f.orderIds.first, f.orderIds.second]) {
      expect(rows.get(id)!.values).toMatchObject({ [label]: null, [shouted]: null });
      expect(rows.get(id)!.errors).toEqual({
        [label]: 'formula.link.unnamed',
        [shouted]: 'formula.link.unnamed',
      });
    }
    // Linked to nothing, there's no name to miss.
    expect(rows.get(f.orderIds.third)!.values).toMatchObject({ [label]: 'For ', [shouted]: '' });
  });

  it('refuse a primary field that would read its own names back through links', async () => {
    const f = await catalog();
    const orders = (await f.field(f.client)) as Extract<FieldMeta, { type: 'link' }>;
    const inverse = orders.options.inverseFieldId!;
    // Clients named by their orders' names is fine while orders have names of their own.
    await f.send({
      kind: 'field.convert',
      fieldId: f.clients.nameId,
      to: { type: 'formula', options: { expression: `"Client of " & {${inverse}}` } },
    });
    const label = await f.formula(f.orders, 'Label', '{Client} & " order"');
    // Forrester's orders are the first and the second.
    expect((await f.rows(f.orders)).get(f.orderIds.first)!.values[label]).toBe(
      'Client of First, Second order',
    );
    // Orders named by their clients' names would read themselves.
    await f.send(
      {
        kind: 'field.convert',
        fieldId: f.orders.nameId,
        to: { type: 'formula', options: { expression: '{Client} & ""' } },
      },
      'formula.field.circular',
    );
    await f.send(
      { kind: 'field.setPrimary', tableId: f.orders.id, fieldId: label },
      'formula.field.circular',
    );
    // So would a record named by its parent's name, through a link to its own table.
    const parent = await f.link(f.clients, f.clients, 'Parent');
    await f.send(
      {
        kind: 'field.update',
        fieldId: f.clients.nameId,
        options: { expression: `{${parent}} & " > client"` },
      },
      'formula.field.circular',
    );
  });

  it('read a lookup of a link as the names it reaches', async () => {
    const f = await catalog();
    const invoices = await f.addTable('Invoices');
    const order = await f.link(invoices, f.orders, 'Order');
    const billed = await f.add(invoices, 'Billed', {
      type: 'lookup',
      options: { linkFieldId: order, targetFieldId: f.client },
    });
    const to = await f.formula(invoices, 'To', '"Bill " & {Billed}');
    const loud = await f.formula(invoices, 'Loud', 'UPPER({Billed} & "")');
    const [invoice] = await f.create(invoices, [{ [order]: [f.orderIds.second, f.orderIds.fourth] }]);
    const read = (await f.rows(invoices)).get(invoice!)!;
    // A lookup leaves out blank names, as it leaves out every blank value.
    expect(read.values).toMatchObject({
      [billed]: [f.clientIds.smith, f.clientIds.forrester, f.clientIds.unnamed],
      [to]: 'Bill Smith, Jones & "Sons", Forrester Legal Partners',
      [loud]: 'SMITH, JONES & "SONS", FORRESTER LEGAL PARTNERS',
    });
  });
});

describe('formulas over choices', () => {
  async function tasks() {
    const f = await setup('Tasks');
    const todo = newId('choice'),
      done = newId('choice'),
      waiting = newId('choice'),
      red = newId('choice'),
      blue = newId('choice');
    const status = await f.add(f.first, 'Status', {
      type: 'singleSelect',
      options: {
        choices: [
          { id: todo, name: 'Todo', color: 'gray' },
          { id: done, name: 'Done', color: 'green' },
          { id: waiting, name: 'Waiting, blocked', color: 'red' },
        ],
      },
    });
    const tags = await f.add(f.first, 'Tags', {
      type: 'multipleSelect',
      options: {
        choices: [
          { id: red, name: 'Red', color: 'red' },
          { id: blue, name: 'Blue "sky"', color: 'blue' },
        ],
      },
    });
    const [one, two, three] = await f.create(f.first, [
      { [f.first.nameId]: 'One', [status]: done, [tags]: [blue, red] },
      { [f.first.nameId]: 'Two', [status]: waiting, [tags]: [red] },
      { [f.first.nameId]: 'Three' },
    ]);
    return {
      ...f,
      status,
      tags,
      choices: { todo, done, waiting, red, blue },
      ids: { one: one!, two: two!, three: three! },
    };
  }

  it('read single and multiple selects by name, and follow a renamed or deleted choice', async () => {
    const f = await tasks();
    const summary = await f.formula(f.first, 'Summary', '{Status} & ": " & {Tags}');
    const finished = await f.formula(f.first, 'Finished', '{Status} = "Done"');
    const counted = await f.formula(f.first, 'Tag count', 'COUNTALL({Tags})');
    // LOWER reads them by name too.
    const lower = await f.formula(f.first, 'Lower', 'LOWER({Status} & " " & {Tags})');
    let rows = await f.rows(f.first);
    expect(rows.get(f.ids.one)!.values).toMatchObject({
      [summary]: 'Done: Blue "sky", Red',
      [finished]: true,
      [counted]: 2,
      [lower]: 'done blue "sky", red',
    });
    expect(rows.get(f.ids.two)!.values).toMatchObject({
      [summary]: 'Waiting, blocked: Red',
      [finished]: false,
      [counted]: 1,
    });
    expect(rows.get(f.ids.three)!.values).toMatchObject({
      [summary]: ': ',
      [finished]: false,
      [counted]: 0,
      [lower]: ' ',
    });
    for (const id of [summary, finished, counted])
      expect((await f.field(id)).options).toMatchObject({ sortable: true });
    // A filter on a comparison with a choice's name keeps what it names.
    const onlyFinished = {
      filter: {
        conjunction: 'and',
        conditions: [{ id: 'finished', fieldId: finished, operator: 'is', value: true }],
      },
    };
    await f.view(f.first, onlyFinished);
    expect((await f.page(f.first)).rows.map((row) => row!.id)).toEqual([f.ids.one]);
    await f.view(f.first, { filter: null });

    // Renamed, a choice reads by its new name: "Done" is no longer what the record holds.
    const field = (await f.field(f.status)) as Extract<FieldMeta, { type: 'singleSelect' }>;
    await f.send({
      kind: 'field.update',
      fieldId: f.status,
      options: {
        choices: field.options.choices.map((choice) =>
          choice.id === f.choices.done ? { ...choice, name: 'Shipped' } : choice,
        ),
      },
    });
    const tagField = (await f.field(f.tags)) as Extract<FieldMeta, { type: 'multipleSelect' }>;
    await f.send({
      kind: 'field.update',
      fieldId: f.tags,
      options: { choices: tagField.options.choices.filter((choice) => choice.id !== f.choices.red) },
    });
    rows = await f.rows(f.first);
    expect(rows.get(f.ids.one)!.values).toMatchObject({
      [summary]: 'Shipped: Blue "sky"',
      [finished]: false,
      [counted]: 1,
      [lower]: 'shipped blue "sky"',
    });
    expect(rows.get(f.ids.two)!.values).toMatchObject({ [summary]: 'Waiting, blocked: ', [counted]: 0 });
    expect(await f.csv(f.first)).toContain('"Shipped: Blue ""sky"""');
    // What the filter kept, it no longer keeps.
    await f.view(f.first, onlyFinished);
    expect((await f.page(f.first)).rows).toEqual([]);
  });

  it('read a lookup of a single select by name, as an imported Scene I/E does', async () => {
    const f = await setup('Shots');
    const scenes = await f.addTable('Scenes');
    const inside = newId('choice'),
      outside = newId('choice');
    const where = await f.add(scenes, 'I/E', {
      type: 'singleSelect',
      options: {
        choices: [
          { id: inside, name: 'INT', color: 'blue' },
          { id: outside, name: 'EXT', color: 'green' },
        ],
      },
    });
    const scene = await f.link(f.first, scenes, 'Scene');
    const lookup = await f.add(f.first, 'Scene I/E', {
      type: 'lookup',
      options: { linkFieldId: scene, targetFieldId: where },
    });
    const shown = await f.formula(f.first, 'Shown', '{Scene I/E} & ""');
    const outdoors = await f.formula(f.first, 'Outdoors', '{Scene I/E} = "EXT"');
    const slug = await f.formula(f.first, 'Slug', 'LOWER({Scene I/E} & ". " & {Name})');
    const [night, day] = await f.create(scenes, [
      { [scenes.nameId]: 'Night', [where]: outside },
      { [scenes.nameId]: 'Day', [where]: inside },
    ]);
    const [shot, both] = await f.create(f.first, [
      { [f.first.nameId]: 'Wide', [scene]: [night] },
      { [f.first.nameId]: 'Close', [scene]: [night, day] },
    ]);
    let rows = await f.rows(f.first);
    expect(rows.get(shot!)!.values).toMatchObject({
      [lookup]: [outside],
      [shown]: 'EXT',
      [outdoors]: true,
      [slug]: 'ext. wide',
    });
    expect(rows.get(both!)!.values).toMatchObject({ [shown]: 'EXT, INT', [slug]: 'ext, int. close' });
    expect(rows.get(both!)!.errors).toEqual({ [outdoors]: 'formula.list.several' });

    const field = (await f.field(where)) as Extract<FieldMeta, { type: 'singleSelect' }>;
    await f.send({
      kind: 'field.update',
      fieldId: where,
      options: {
        choices: field.options.choices.map((choice) =>
          choice.id === outside ? { ...choice, name: 'EXTERIOR' } : choice,
        ),
      },
    });
    rows = await f.rows(f.first);
    expect(rows.get(shot!)!.values).toMatchObject({
      [shown]: 'EXTERIOR',
      [outdoors]: false,
      [slug]: 'exterior. wide',
    });
  });

  it('start an automation when a formula over a choice starts to match', async () => {
    const base = await createBase(server);
    const finished = newId('field');
    await send(base.databaseId, {
      kind: 'field.create',
      tableId: base.tasks,
      field: {
        id: finished,
        name: 'Finished',
        type: 'formula',
        options: { expression: '{Status} = "Done"' },
      },
    });
    const automation = await automate(server, base.databaseId, {
      trigger: {
        kind: 'recordMatches',
        tableId: base.tasks,
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'finished', fieldId: finished, operator: 'is', value: true }],
        },
      },
    });
    const [task] = await createRecords(server, base.databaseId, base.tasks, [
      { [base.f.name]: 'Write', [base.f.status]: base.todo },
    ]);
    expect(await runRows(server, automation)).toEqual([]);
    await updateRecord(server, base.databaseId, base.tasks, task!, { [base.f.status]: base.done });
    expect((await runRows(server, automation)).map((run) => run.record_id)).toEqual([task]);
  });
});
