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
import { evaluateRelation } from '@riosoma/formula';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';

/**
 * Row reads of tables whose formulas read number-like fields, and rollups and lookups of formulas
 * in other tables.  A bad value in one cell must become that cell's error, never a failed read.
 */

let kit: TestPostgres;
let server: ServerFixture;
const clientId = newId('client');
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'formula_reads');
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

async function send(databaseId: string, input: Record<string, unknown>, error?: string) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: { clientId, commands: [{ id: newId('command'), groupId: newId('action'), ...input }] },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<CommandBatchResult>().results[0]!;
  if (error) expect(result.error?.messageKey, response.body).toBe(error);
  else expect(result.status, response.body).toBe('applied');
}

async function setup(firstTable = 'Shifts', databaseName = 'Volunteers') {
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
    payload: { id: databaseId, name: databaseName, table: first },
  });
  expect(response.statusCode, response.body).toBe(200);
  const tables = new Map<string, Table>();
  const remember = (table: ReturnType<typeof spec>) => {
    const entry = { id: table.id, viewId: table.view.id, nameId: table.fields[0]!.id };
    tables.set(table.name, entry);
    return entry;
  };
  const shifts = remember(first);
  const addTable = async (name: string) => {
    const table = spec(name);
    await send(databaseId, { kind: 'table.create', table });
    return remember(table);
  };
  const add = async (
    table: Table,
    name: string,
    field: { type: FieldSpec['type']; options?: Record<string, unknown> },
    error?: string,
  ) => {
    const id = newId('field');
    await send(databaseId, { kind: 'field.create', tableId: table.id, field: { id, name, ...field } }, error);
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
  const schema = () => get<DatabaseSchema>(`/api/databases/${databaseId}/schema`);
  const field = async (id: string) => (await schema()).fields.find((item) => item.id === id)!;
  const page = (table: Table) => get<RowsPage>(`/api/views/${table.viewId}/rows`);
  const record = (table: Table, id: string) => get<RowData>(`/api/tables/${table.id}/records/${id}`);
  /** Every row of the view, by record ID, after checking a record read agrees with the page. */
  const rows = async (table: Table) => {
    const result = await page(table);
    const byId = new Map(result.rows.map((row) => [row!.id, row!]));
    for (const row of byId.values()) expect(await record(table, row.id)).toEqual(row);
    return byId;
  };
  const view = async (table: Table, config: Record<string, unknown>) => {
    const current = (await schema()).views.find((item) => item.id === table.viewId)!;
    await send(databaseId, {
      kind: 'view.update',
      viewId: table.viewId,
      config: { ...current.config, ...config },
    });
  };
  /** Sends a command as is, and gives back its result. */
  const command = async (input: Record<string, unknown>) => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/commands`,
      headers: server.owner.headers,
      payload: { clientId, commands: [{ id: newId('command'), groupId: newId('action'), ...input }] },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<CommandBatchResult>().results[0]!;
  };
  const link = async (from: Table, to: Table, name: string) => {
    const id = await add(from, name, { type: 'link', options: { linkedTableId: to.id } });
    const meta = (await field(id)) as Extract<FieldMeta, { type: 'link' }>;
    return { id, inverseId: meta.options.inverseFieldId! };
  };
  return {
    databaseId,
    shifts,
    addTable,
    add,
    formula,
    create,
    update,
    field,
    page,
    record,
    rows,
    view,
    command,
    link,
  };
}

/** Shifts link to the people who signed up for them, as the report that found the second bug had it. */
async function volunteers() {
  const f = await setup();
  const signups = await f.addTable('Signups');
  const guests = await f.add(signups, 'Guests', { type: 'number' });
  const counts = await f.formula(signups, 'Counts', 'IF({Guests} > 0, {Guests} + 1, 1)');
  const needed = await f.add(f.shifts, 'Needed', { type: 'number' });
  const people = await f.link(f.shifts, signups, 'Volunteers');
  const signedUp = await f.add(f.shifts, 'Signed up', {
    type: 'rollup',
    options: { linkFieldId: people.id, targetFieldId: counts, fn: 'sum' },
  });
  const open = await f.formula(f.shifts, 'Open spots', 'MAX(0, {Needed} - {Signed up})');
  const [ana, ben, cy] = await f.create(signups, [
    { [signups.nameId]: 'Ana', [guests]: 2 },
    { [signups.nameId]: 'Ben' },
    { [signups.nameId]: 'Cy', [guests]: 0 },
  ]);
  const [morning, evening, night] = await f.create(f.shifts, [
    { [f.shifts.nameId]: 'Morning', [needed]: 5, [people.id]: [ana, ben] },
    { [f.shifts.nameId]: 'Evening', [needed]: 2, [people.id]: [ana, cy] },
    { [f.shifts.nameId]: 'Night', [needed]: 3 },
  ]);
  return {
    ...f,
    signups,
    guests,
    counts,
    needed,
    people,
    signedUp,
    open,
    signupIds: { ana: ana!, ben: ben!, cy: cy! },
    shiftIds: { morning: morning!, evening: evening!, night: night! },
  };
}

describe('formulas over number-like fields', () => {
  async function tickets() {
    const f = await setup();
    const table = f.shifts;
    const number = await f.add(table, 'Number', { type: 'autoNumber' });
    const price = await f.add(table, 'Price', { type: 'currency' });
    const share = await f.add(table, 'Share', { type: 'percent' });
    const time = await f.add(table, 'Time', { type: 'duration' });
    const stars = await f.add(table, 'Stars', { type: 'rating' });
    const ids = await f.create(table, [
      { [table.nameId]: 'First', [price]: 12.5, [share]: 0.25, [time]: 5400, [stars]: 4 },
      { [table.nameId]: 'Second', [price]: 0.1 + 0.2, [share]: 1e-7, [time]: 90.5, [stars]: 1 },
      { [table.nameId]: 'Third' },
    ]);
    return { ...f, table, number, price, share, time, stars, ids };
  }

  it('reads formulas that join auto number, currency, percent, duration, and rating fields with text', async () => {
    const f = await tickets();
    const bug = await f.formula(f.table, 'Key', '"BUG-" & {Number}');
    const cost = await f.formula(f.table, 'Cost', '"$" & {Price}');
    const joined = await f.formula(
      f.table,
      'Joined',
      'CONCATENATE({Share}, " / ", {Time}, " / ", {Stars}, " / ", {Number})',
    );
    const text = await f.formula(f.table, 'Text only', 'T({Price})');
    const rows = await f.rows(f.table);
    const [first, second, third] = f.ids.map((id) => rows.get(id)!);
    expect(first!.values).toMatchObject({
      [bug]: 'BUG-1',
      [cost]: '$12.5',
      [joined]: '0.25 / 5400 / 4 / 1',
      [text]: null,
    });
    expect(second!.values).toMatchObject({
      [bug]: 'BUG-2',
      [cost]: '$0.30000000000000004',
      [joined]: '1e-7 / 90.5 / 1 / 2',
    });
    expect(third!.values).toMatchObject({ [bug]: 'BUG-3', [cost]: '$', [joined]: ' /  /  / 3' });
    for (const row of [first, second, third]) expect(row!.errors).toBeUndefined();
    // Each compiles to SQL, so it sorts and filters like any other text.
    for (const id of [bug, cost, joined, text])
      expect((await f.field(id)).options).toMatchObject({ resultType: 'text', sortable: true });
    await f.view(f.table, {
      sorts: [{ fieldId: bug, direction: 'desc' }],
      filter: {
        conjunction: 'and',
        conditions: [{ id: 'priced', fieldId: cost, operator: 'contains', value: '.' }],
      },
    });
    expect((await f.page(f.table)).rows.map((row) => row!.values[bug])).toEqual(['BUG-2', 'BUG-1']);
  });

  it('does math on number-like fields in SQL, so the results sort and filter', async () => {
    const f = await tickets();
    const total = await f.formula(f.table, 'Total', '{Price} * 2 + {Stars} + {Number}');
    const percent = await f.formula(f.table, 'Percent', '{Share} * 100');
    const minutes = await f.formula(f.table, 'Minutes', '{Time} / 60');
    const label = await f.formula(f.table, 'Label', 'ROUND({Share} * 100, 0) & "%"');
    const rows = await f.rows(f.table);
    expect(rows.get(f.ids[0]!)!.values).toMatchObject({
      [total]: 30,
      [percent]: 25,
      [minutes]: 90,
      [label]: '25%',
    });
    expect(rows.get(f.ids[2]!)!.values).toMatchObject({ [total]: 3, [percent]: 0, [minutes]: 0 });
    for (const id of [total, percent, minutes])
      expect((await f.field(id)).options).toMatchObject({ resultType: 'number', sortable: true });
    await f.view(f.table, {
      sorts: [{ fieldId: total, direction: 'desc' }],
      filter: {
        conjunction: 'and',
        conditions: [{ id: 'some', fieldId: minutes, operator: 'gt', value: 1 }],
      },
    });
    expect((await f.page(f.table)).rows.map((row) => row!.id)).toEqual([f.ids[0], f.ids[1]]);
  });
});

describe('formulas over people and attachment fields', () => {
  it('reads people as names and attachments as lists, without failing the read', async () => {
    const f = await setup();
    const owner = await f.add(f.shifts, 'Owner', { type: 'user', options: { allowMultiple: true } });
    await f.add(f.shifts, 'Files', { type: 'attachment' });
    const [record] = await f.create(f.shifts, [{ [owner]: [server.owner.userId] }]);
    const label = await f.formula(f.shifts, 'Label', '"Led by " & {Owner}');
    const people = await f.formula(f.shifts, 'People', 'COUNTALL({Owner})');
    const joined = await f.formula(f.shifts, 'Joined', 'ARRAYJOIN({Owner}, " and ")');
    const attached = await f.formula(f.shifts, 'Attached', '"Files: " & {Files}');
    const rows = await f.rows(f.shifts);
    expect(rows.get(record!)!.values).toMatchObject({
      [label]: `Led by ${server.owner.info.user.name}`,
      [people]: 1,
      [joined]: server.owner.info.user.name,
      [attached]: 'Files: ',
    });
    expect(rows.get(record!)!.errors).toBeUndefined();
    // A list isn't text, so LEN refuses it, as the editor says.
    await f.add(
      f.shifts,
      'Length',
      { type: 'formula', options: { expression: 'LEN({Owner})' } },
      'formula.type.argument',
    );
  });
});

describe('rollups and lookups of formulas in other tables', () => {
  it('reads a formula over a rollup of an IF() formula in another table', async () => {
    const f = await volunteers();
    const rows = await f.rows(f.shifts);
    expect(rows.get(f.shiftIds.morning)!.values).toMatchObject({ [f.signedUp]: 4, [f.open]: 1 });
    expect(rows.get(f.shiftIds.evening)!.values).toMatchObject({ [f.signedUp]: 4, [f.open]: 0 });
    expect(rows.get(f.shiftIds.night)!.values).toMatchObject({ [f.signedUp]: 0, [f.open]: 3 });
    expect((await f.field(f.open)).options).toMatchObject({ resultType: 'number', sortable: true });
    await f.view(f.shifts, { sorts: [{ fieldId: f.open, direction: 'desc' }] });
    expect((await f.page(f.shifts)).rows.map((row) => row!.id)).toEqual([
      f.shiftIds.night,
      f.shiftIds.morning,
      f.shiftIds.evening,
    ]);
    // Changing a signup changes the shift.
    await f.update(f.signups, f.signupIds.ben, { [f.guests]: 3 });
    expect((await f.record(f.shifts, f.shiftIds.morning)).values).toMatchObject({
      [f.signedUp]: 7,
      [f.open]: 0,
    });
  });

  it('makes an error in the target formula that rollup’s error, and the error of formulas over it', async () => {
    const f = await volunteers();
    await send(f.databaseId, {
      kind: 'field.update',
      fieldId: f.counts,
      options: { expression: 'IF({Guests} < 0, ERROR(), {Guests} + 1)' },
    });
    const caught = await f.formula(f.shifts, 'Caught', 'IF(ISERROR({Signed up}), -1, {Signed up})');
    // ROUND is computed in JavaScript, so this one reads the rollup's error there.
    const rounded = await f.formula(f.shifts, 'Rounded', 'ROUND({Signed up} / 3, 1)');
    await f.update(f.signups, f.signupIds.cy, { [f.guests]: -1 });
    const rows = await f.rows(f.shifts);
    const evening = rows.get(f.shiftIds.evening)!;
    expect(evening.values).toMatchObject({
      [f.signedUp]: null,
      [f.open]: null,
      [caught]: -1,
      [rounded]: null,
    });
    expect(evening.errors).toEqual({
      [f.signedUp]: 'formula.runtime.explicit',
      [f.open]: 'formula.runtime.explicit',
      [rounded]: 'formula.runtime.explicit',
    });
    // Ben counts one: his Guests is blank, and a blank is never below zero.
    const morning = rows.get(f.shiftIds.morning)!;
    expect(morning.values).toMatchObject({ [f.signedUp]: 4, [f.open]: 1, [caught]: 4, [rounded]: 1.3 });
    expect(morning.errors).toBeUndefined();
    // The error sorts and filters as blank, without failing the read.
    await f.view(f.shifts, {
      sorts: [{ fieldId: f.signedUp, direction: 'asc' }],
      filter: {
        conjunction: 'or',
        conditions: [
          { id: 'open', fieldId: f.open, operator: 'gte', value: 0 },
          { id: 'none', fieldId: f.signedUp, operator: 'isEmpty' },
        ],
      },
    });
    const sorted = await f.page(f.shifts);
    expect(sorted.rows.map((row) => row!.id)).toEqual([
      f.shiftIds.night,
      f.shiftIds.morning,
      f.shiftIds.evening,
    ]);
  });

  it('looks up formulas and their errors, and reads formulas over those lookups', async () => {
    const f = await volunteers();
    const list = await f.add(f.shifts, 'Counts list', {
      type: 'lookup',
      options: { linkFieldId: f.people.id, targetFieldId: f.counts },
    });
    const joined = await f.formula(f.shifts, 'Counts joined', 'ARRAYJOIN({Counts list}, "+")');
    const total = await f.formula(f.shifts, 'Counts counted', 'COUNT({Counts list})');
    let rows = await f.rows(f.shifts);
    expect(rows.get(f.shiftIds.morning)!.values).toMatchObject({
      [list]: [3, 1],
      [joined]: '3+1',
      [total]: 2,
    });
    expect((await f.field(list)).options).toMatchObject({ resultType: 'number' });
    await send(f.databaseId, {
      kind: 'field.update',
      fieldId: f.counts,
      options: { expression: '1 / {Guests}' },
    });
    rows = await f.rows(f.shifts);
    const morning = rows.get(f.shiftIds.morning)!;
    expect(morning.values).toMatchObject({ [list]: null, [joined]: null, [total]: null });
    expect(morning.errors).toMatchObject({
      [list]: 'formula.runtime.divisionByZero',
      [joined]: 'formula.runtime.divisionByZero',
      [total]: 'formula.runtime.divisionByZero',
    });
    expect(rows.get(f.shiftIds.night)!.values).toMatchObject({ [list]: [], [joined]: '', [total]: 0 });
    expect(rows.get(f.shiftIds.night)!.errors).toBeUndefined();
    // A lookup of that lookup, from a third table, carries the same error.
    const teams = await f.addTable('Teams');
    const shifts = await f.link(teams, f.shifts, 'Shifts');
    const nested = await f.add(teams, 'Nested counts', {
      type: 'lookup',
      options: { linkFieldId: shifts.id, targetFieldId: list },
    });
    const [team] = await f.create(teams, [{ [shifts.id]: [f.shiftIds.night, f.shiftIds.morning] }]);
    const read = await f.record(teams, team!);
    expect(read.values[nested]).toBeNull();
    expect(read.errors).toEqual({ [nested]: 'formula.runtime.divisionByZero' });
  });

  it('rolls up and looks up currency, percent, duration, rating, and auto number fields', async () => {
    const f = await volunteers();
    const fee = await f.add(f.signups, 'Fee', { type: 'currency' });
    const share = await f.add(f.signups, 'Share', { type: 'percent' });
    const time = await f.add(f.signups, 'Time', { type: 'duration' });
    const stars = await f.add(f.signups, 'Stars', { type: 'rating' });
    const number = await f.add(f.signups, 'Number', { type: 'autoNumber' });
    await f.update(f.signups, f.signupIds.ana, { [fee]: 12.5, [share]: 0.25, [time]: 3600, [stars]: 5 });
    await f.update(f.signups, f.signupIds.ben, { [fee]: 7.25, [share]: 0.5, [time]: 1800, [stars]: 2 });
    const rollup = (name: string, targetFieldId: string, fn: string) =>
      f.add(f.shifts, name, { type: 'rollup', options: { linkFieldId: f.people.id, targetFieldId, fn } });
    const fees = await rollup('Fees', fee, 'sum');
    const shares = await rollup('Shares', share, 'average');
    const hours = await rollup('Hours', time, 'sum');
    const best = await rollup('Best', stars, 'max');
    const last = await rollup('Last', number, 'max');
    const feeList = await f.add(f.shifts, 'Fee list', {
      type: 'lookup',
      options: { linkFieldId: f.people.id, targetFieldId: fee },
    });
    const summary = await f.formula(
      f.shifts,
      'Summary',
      '"$" & {Fees} & ", " & {Shares} & ", " & ({Hours} / 3600) & "h, " & {Best} & ", #" & {Last}',
    );
    const fees2 = await f.formula(f.shifts, 'Fees joined', 'ARRAYJOIN({Fee list}, " + ")');
    for (const id of [fees, shares, hours, best, last])
      expect((await f.field(id)).options).toMatchObject({ resultType: 'number' });
    expect((await f.field(feeList)).options).toMatchObject({ resultType: 'number' });
    expect((await f.field(summary)).options).toMatchObject({ resultType: 'text', sortable: true });
    const rows = await f.rows(f.shifts);
    expect(rows.get(f.shiftIds.morning)!.values).toMatchObject({
      [fees]: 19.75,
      [shares]: 0.375,
      [hours]: 5400,
      [best]: 5,
      [last]: 2,
      [feeList]: [12.5, 7.25],
      [summary]: '$19.75, 0.375, 1.5h, 5, #2',
      [fees2]: '12.5 + 7.25',
    });
    expect(rows.get(f.shiftIds.night)!.values).toMatchObject({ [fees]: 0, [summary]: '$0, , 0h, , #' });
  });

  it('shows a lookup or rollup of a formula that only JavaScript can compute as that cell’s error', async () => {
    const f = await volunteers();
    const thirds = await f.formula(f.signups, 'Thirds', 'ROUNDUP({Guests} / 3, 1)');
    expect((await f.field(thirds)).options).toMatchObject({ sortable: false });
    const sum = await f.add(f.shifts, 'Thirds total', {
      type: 'rollup',
      options: { linkFieldId: f.people.id, targetFieldId: thirds, fn: 'sum' },
    });
    const list = await f.add(f.shifts, 'Thirds list', {
      type: 'lookup',
      options: { linkFieldId: f.people.id, targetFieldId: thirds },
    });
    const over = await f.formula(f.shifts, 'Over', '{Thirds total} + 1');
    const rows = await f.rows(f.shifts);
    const morning = rows.get(f.shiftIds.morning)!;
    expect(morning.values).toMatchObject({ [sum]: null, [list]: null, [over]: null });
    expect(morning.errors).toEqual({
      [sum]: 'formula.relation.unsupported',
      [list]: 'formula.relation.unsupported',
      [over]: 'formula.relation.unsupported',
    });
    const night = rows.get(f.shiftIds.night)!;
    expect(night.values).toMatchObject({ [sum]: 0, [list]: [], [over]: 1 });
    expect(night.errors).toBeUndefined();
  });
});

describe('a bad value never fails a whole read', () => {
  it('reads rollups and lookups whose target formula changed to a type they can’t use', async () => {
    const f = await volunteers();
    const keen = await f.formula(f.signups, 'Keen', '{Guests} > 0');
    const every = await f.add(f.shifts, 'Every', {
      type: 'rollup',
      options: { linkFieldId: f.people.id, targetFieldId: keen, fn: 'and' },
    });
    const most = await f.add(f.shifts, 'Most', {
      type: 'rollup',
      options: { linkFieldId: f.people.id, targetFieldId: f.counts, fn: 'max' },
    });
    const list = await f.add(f.shifts, 'List', {
      type: 'lookup',
      options: { linkFieldId: f.people.id, targetFieldId: f.counts },
    });
    const doubled = await f.formula(f.shifts, 'Doubled', '{Most} * 2');
    await f.view(f.shifts, {
      sorts: [
        { fieldId: most, direction: 'asc' },
        { fieldId: list, direction: 'asc' },
      ],
      filter: {
        conjunction: 'and',
        conditions: [{ id: 'listed', fieldId: list, operator: 'isNotEmpty' }],
      },
    });
    // Counts and Keen become text after the rollups and lookups were made to read numbers and checks.
    for (const [fieldId, expression] of [
      [f.counts, '"n" & {Guests}'],
      [keen, '"k" & {Guests}'],
    ])
      await send(f.databaseId, { kind: 'field.update', fieldId, options: { expression } });
    const rows = await f.rows(f.shifts);
    expect(rows.get(f.shiftIds.morning)!.values).toMatchObject({
      [f.signedUp]: 0,
      [every]: true,
      [most]: 'n2',
      [list]: ['n2', 'n'],
    });
    expect((await f.field(most)).options).toMatchObject({ resultType: 'text' });
    expect((await f.field(list)).options).toMatchObject({ resultType: 'text' });
    // A formula over the rollup now does math on text, which the editor would have refused.
    expect(rows.get(f.shiftIds.morning)!.errors?.[doubled]).toBe('formula.type.argument');
    expect((await f.page(f.shifts)).rows.map((row) => row!.id)).toEqual([
      f.shiftIds.morning,
      f.shiftIds.evening,
    ]);
  });

  it('reads a formula whose target in another table refers back to it', async () => {
    const f = await volunteers();
    // Signups roll up the shifts they're on, and Counts reads that, so the loop runs through both tables.
    const shiftsOpen = await f.add(f.signups, 'Shift openings', {
      type: 'rollup',
      options: { linkFieldId: f.people.inverseId, targetFieldId: f.open, fn: 'sum' },
    });
    // Saving that loop is refused now, so this is a loop saved before it was, written straight in.
    await send(
      f.databaseId,
      { kind: 'field.update', fieldId: f.counts, options: { expression: '{Shift openings} + 1' } },
      'formula.field.circular',
    );
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'fields')}
        SET options = jsonb_set(options, '{expression}', to_jsonb(${`({${shiftsOpen}} + 1)`}::text)) WHERE id = ${f.counts}`,
    );
    const shifts = await f.rows(f.shifts);
    expect(shifts.get(f.shiftIds.morning)!.errors?.[f.open]).toBe('formula.field.circular');
    expect(shifts.get(f.shiftIds.night)!.values[f.open]).toBe(3);
    const signups = await f.rows(f.signups);
    expect(signups.get(f.signupIds.ana)!.errors?.[f.counts]).toBe('formula.field.circular');
    expect(signups.get(f.signupIds.ana)!.errors?.[shiftsOpen]).toBe('formula.field.circular');
  });

  it('reads a number too large for any double as blank, in formulas and rollups alike', async () => {
    const f = await volunteers();
    const total = await f.add(f.shifts, 'Guests total', {
      type: 'rollup',
      options: { linkFieldId: f.people.id, targetFieldId: f.guests, fn: 'sum' },
    });
    const doubled = await f.formula(f.signups, 'Doubled', '{Guests} * 2');
    const text = await f.formula(f.signups, 'Guests text', '"g" & {Guests}');
    const rounded = await f.formula(f.signups, 'Rounded', 'ROUND({Guests}, 0)');
    const over = await f.formula(f.shifts, 'Over total', '{Guests total} + 1');
    // A sync can store any decimal in a number field, even one no double can hold.
    for (const [id, value] of [
      [f.signupIds.ana, '1e400'],
      [f.signupIds.ben, '1e-400'],
    ])
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.data, f.signups.id)} SET ${ident(f.guests)} = ${value}::numeric
          WHERE __id = ${id}`,
      );
    const signups = await f.rows(f.signups);
    expect(signups.get(f.signupIds.ana)!.values).toMatchObject({
      [f.guests]: null,
      [doubled]: 0,
      [text]: 'g',
      [rounded]: 0,
      [f.counts]: 1,
    });
    expect(signups.get(f.signupIds.ben)!.values).toMatchObject({
      [f.guests]: 0,
      [doubled]: 0,
      [text]: 'g0',
      [rounded]: 0,
    });
    const shifts = await f.rows(f.shifts);
    expect(shifts.get(f.shiftIds.morning)!.values).toMatchObject({ [total]: null, [over]: 1, [f.open]: 3 });
    expect(shifts.get(f.shiftIds.night)!.values).toMatchObject({ [total]: 0, [over]: 1 });
  });

  it('names linked records by a formula primary field', async () => {
    const f = await volunteers();
    await send(f.databaseId, {
      kind: 'field.convert',
      fieldId: f.signups.nameId,
      to: { type: 'formula', options: { expression: '"Guest " & {Counts}' } },
      dateOrder: 'mdy',
      timeZone: 'UTC',
    });
    expect((await f.page(f.shifts)).linked).toMatchObject({
      [f.signupIds.ana]: 'Guest 3',
      [f.signupIds.ben]: 'Guest 1',
    });
    // A name that fails is blank, never the error's inner workings.
    await send(f.databaseId, {
      kind: 'field.update',
      fieldId: f.counts,
      options: { expression: '1 / {Guests}' },
    });
    expect((await f.page(f.shifts)).linked).toMatchObject({
      [f.signupIds.ana]: 'Guest 0.5',
      [f.signupIds.cy]: '',
    });
    // A number formula only JavaScript computes can't name them in SQL, so its names are blank.
    await send(f.databaseId, {
      kind: 'field.update',
      fieldId: f.signups.nameId,
      options: { expression: 'ROUNDUP({Guests} / 3, 2)' },
    });
    expect((await f.field(f.signups.nameId)).options).toMatchObject({
      resultType: 'number',
      sortable: false,
    });
    expect((await f.page(f.shifts)).linked).toMatchObject({ [f.signupIds.ana]: '' });
  });
});

/**
 * Orders with line items, each linked to a product, the usual shape of a shop's base: a line's
 * total multiplies the product's price, a lookup, by its quantity, and an order sums its lines.
 */
async function shop() {
  const f = await setup('Orders', 'Shop');
  const orders = f.shifts;
  const products = await f.addTable('Products');
  const items = await f.addTable('Line items');
  const price = await f.add(products, 'Price', { type: 'currency' });
  const released = await f.add(products, 'Released', { type: 'date' });
  const product = await f.link(items, products, 'Product');
  const order = await f.link(items, orders, 'Order');
  const quantity = await f.add(items, 'Quantity', { type: 'number' });
  const lookup = (name: string, targetFieldId: string) =>
    f.add(items, name, { type: 'lookup', options: { linkFieldId: product.id, targetFieldId } });
  const unit = await lookup('Unit price', price);
  const named = await lookup('Product name', products.nameId);
  const since = await lookup('Released on', released);
  const total = await f.formula(items, 'Line total', '{Unit price} * {Quantity}');
  const [tea, mug, cake] = await f.create(products, [
    { [products.nameId]: 'Tea', [price]: 4.5, [released]: '2024-05-01' },
    { [products.nameId]: 'Mug', [price]: 12 },
    { [products.nameId]: 'Cake', [price]: 3.25 },
  ]);
  const [first, second, third] = await f.create(orders, [
    { [orders.nameId]: 'First' },
    { [orders.nameId]: 'Second' },
    { [orders.nameId]: 'Third' },
  ]);
  const [teas, mugs, both, none, cakes] = await f.create(items, [
    { [items.nameId]: 'Teas', [quantity]: 2, [product.id]: [tea], [order.id]: [first] },
    { [items.nameId]: 'Mugs', [quantity]: 1, [product.id]: [mug], [order.id]: [first] },
    // Linked to two products, so its price is ambiguous.
    { [items.nameId]: 'Both', [quantity]: 1, [product.id]: [tea, mug], [order.id]: [second] },
    // Linked to none yet, so it has no price.
    { [items.nameId]: 'None', [quantity]: 3, [order.id]: [third] },
    { [items.nameId]: 'Cakes', [quantity]: 4, [product.id]: [cake], [order.id]: [third] },
  ]);
  const orderTotal = await f.add(orders, 'Order total', {
    type: 'rollup',
    options: { linkFieldId: order.inverseId, targetFieldId: total, fn: 'sum' },
  });
  return {
    ...f,
    orders,
    products,
    items,
    quantity,
    unit,
    named,
    since,
    total,
    product,
    order,
    orderTotal,
    productIds: { tea: tea!, mug: mug!, cake: cake! },
    orderIds: { first: first!, second: second!, third: third! },
    itemIds: { teas: teas!, mugs: mugs!, both: both!, none: none!, cakes: cakes! },
  };
}

describe('lookups where one value belongs, and in totals', () => {
  it('multiplies a looked-up price by a quantity, and sums the lines into orders', async () => {
    const f = await shop();
    expect((await f.field(f.total)).options).toMatchObject({ resultType: 'number', sortable: true });
    // Rounded, which the database does too, it gives the same numbers.
    const rounded = await f.formula(f.items, 'Rounded', 'ROUND({Unit price} * {Quantity}, 2)');
    expect((await f.field(rounded)).options).toMatchObject({ resultType: 'number', sortable: true });
    const items = await f.rows(f.items);
    const line = (id: string) => items.get(id)!;
    expect(line(f.itemIds.teas).values).toMatchObject({ [f.unit]: [4.5], [f.total]: 9, [rounded]: 9 });
    expect(line(f.itemIds.mugs).values).toMatchObject({ [f.total]: 12, [rounded]: 12 });
    expect(line(f.itemIds.cakes).values).toMatchObject({ [f.total]: 13, [rounded]: 13 });
    // No product reads as a blank price, and a blank is zero in arithmetic.
    expect(line(f.itemIds.none).values).toMatchObject({ [f.unit]: [], [f.total]: 0, [rounded]: 0 });
    expect(line(f.itemIds.none).errors).toBeUndefined();
    // Two products is an error, since there's no telling which price is meant.
    expect(line(f.itemIds.both).values).toMatchObject({
      [f.unit]: [4.5, 12],
      [f.total]: null,
      [rounded]: null,
    });
    expect(line(f.itemIds.both).errors).toEqual({
      [f.total]: 'formula.list.several',
      [rounded]: 'formula.list.several',
    });
    const orders = await f.rows(f.orders);
    expect(orders.get(f.orderIds.first)!.values[f.orderTotal]).toBe(21);
    expect(orders.get(f.orderIds.third)!.values[f.orderTotal]).toBe(13);
    expect(orders.get(f.orderIds.second)!.values[f.orderTotal]).toBeNull();
    expect(orders.get(f.orderIds.second)!.errors).toEqual({ [f.orderTotal]: 'formula.list.several' });
    // Line totals sort and filter in the database, with the error among the blanks.
    await f.view(f.items, {
      sorts: [{ fieldId: f.total, direction: 'desc' }],
      filter: {
        conjunction: 'and',
        conditions: [{ id: 'some', fieldId: f.total, operator: 'gt', value: 5 }],
      },
    });
    expect((await f.page(f.items)).rows.map((row) => row!.id)).toEqual([
      f.itemIds.cakes,
      f.itemIds.mugs,
      f.itemIds.teas,
    ]);
    // Linking the line to one product fixes it, and its order.
    await f.update(f.items, f.itemIds.both, { [f.product.id]: [f.productIds.mug] });
    expect((await f.record(f.items, f.itemIds.both)).values[f.total]).toBe(12);
    expect((await f.record(f.orders, f.orderIds.second)).values[f.orderTotal]).toBe(12);
  });

  it('reads looked-up text, dates, and prices as one value in comparisons and functions', async () => {
    const f = await shop();
    const state = await f.formula(
      f.items,
      'Price state',
      'IF(ISERROR({Unit price} * 1), "several", IF({Unit price} > 0, "one", "none"))',
    );
    const isTea = await f.formula(f.items, 'Is tea', '{Product name} = "Tea"');
    const letters = await f.formula(f.items, 'Letters', 'LEN({Product name})');
    const year = await f.formula(f.items, 'Year', 'YEAR({Released on})');
    const kind = await f.formula(
      f.items,
      'Kind',
      'SWITCH({Product name}, "Tea", "drink", "Cake", "food", "other")',
    );
    const joined = await f.formula(f.items, 'Joined', '"Items: " & {Product name}');
    for (const id of [state, isTea, letters, year, kind, joined])
      expect((await f.field(id)).options, id).toMatchObject({ sortable: true });
    const items = await f.rows(f.items);
    expect(items.get(f.itemIds.teas)!.values).toMatchObject({
      [state]: 'one',
      [isTea]: true,
      [letters]: 3,
      [year]: 2024,
      [kind]: 'drink',
      [joined]: 'Items: Tea',
    });
    expect(items.get(f.itemIds.mugs)!.values).toMatchObject({
      [isTea]: false,
      [year]: null,
      [kind]: 'other',
    });
    expect(items.get(f.itemIds.none)!.values).toMatchObject({
      [state]: 'none',
      [isTea]: false,
      [letters]: 0,
      [kind]: 'other',
      [joined]: 'Items: ',
    });
    // Several values: an error where one is needed, and a list where a list fits.
    const both = items.get(f.itemIds.both)!;
    expect(both.values).toMatchObject({ [state]: 'several', [joined]: 'Items: Tea, Mug' });
    expect(both.errors).toMatchObject({
      [isTea]: 'formula.list.several',
      [letters]: 'formula.list.several',
      [kind]: 'formula.list.several',
    });
  });

  it('flattens lookups in SUM, MAX, COUNT, and CONCATENATE, in the database', async () => {
    const f = await shop();
    const lines = await f.add(f.orders, 'Line totals', {
      type: 'lookup',
      options: { linkFieldId: f.order.inverseId, targetFieldId: f.quantity },
    });
    const sum = await f.formula(f.orders, 'Units', 'SUM({Line totals})');
    const most = await f.formula(f.orders, 'Most', 'MAX({Line totals}, 0)');
    const average = await f.formula(f.orders, 'Average', 'AVERAGE({Line totals})');
    const count = await f.formula(f.orders, 'Lines', 'COUNT({Line totals})');
    const text = await f.formula(f.orders, 'Text', 'CONCATENATE("Units: ", {Line totals})');
    for (const id of [sum, most, average, count, text])
      expect((await f.field(id)).options, id).toMatchObject({ sortable: true });
    const orders = await f.rows(f.orders);
    expect(orders.get(f.orderIds.first)!.values).toMatchObject({
      [lines]: [2, 1],
      [sum]: 3,
      [most]: 2,
      [average]: 1.5,
      [count]: 2,
      [text]: 'Units: 2, 1',
    });
    expect(orders.get(f.orderIds.third)!.values).toMatchObject({ [sum]: 7, [text]: 'Units: 3, 4' });
    await f.view(f.orders, { sorts: [{ fieldId: sum, direction: 'desc' }] });
    expect((await f.page(f.orders)).rows.map((row) => row!.id)).toEqual([
      f.orderIds.third,
      f.orderIds.first,
      f.orderIds.second,
    ]);
  });
});

describe('formula loops through other tables', () => {
  it('refuses a formula, rollup, or lookup that closes a loop through another table', async () => {
    const f = await volunteers();
    const circular = { status: 'rejected', error: { messageKey: 'formula.field.circular' } };
    const formula = (fieldId: string, expression: string) =>
      f.command({ kind: 'field.update', fieldId, options: { expression } });
    // Shifts roll up Counts, so Counts can't read a rollup of the shifts' openings.
    await f.add(f.signups, 'Shift openings', {
      type: 'rollup',
      options: { linkFieldId: f.people.inverseId, targetFieldId: f.open, fn: 'sum' },
    });
    expect(await formula(f.counts, '{Shift openings} + 1')).toMatchObject(circular);
    // Nor through a formula of its own table that reads them, whether updated or converted.
    await f.formula(f.signups, 'Through', '{Shift openings} * 2');
    expect(await formula(f.counts, '{Through} + 1')).toMatchObject(circular);
    expect(
      await f.command({
        kind: 'field.convert',
        fieldId: f.counts,
        to: { type: 'formula', options: { expression: '{Through}' } },
        dateOrder: 'mdy',
        timeZone: 'UTC',
      }),
    ).toMatchObject(circular);
    // A rollup or lookup pointed at a formula that reads it back makes the same kind of loop.
    const spare = await f.add(f.signups, 'Spare', { type: 'number' });
    const spares = await f.add(f.shifts, 'Spares', {
      type: 'rollup',
      options: { linkFieldId: f.people.id, targetFieldId: spare, fn: 'sum' },
    });
    const reader = await f.formula(f.shifts, 'Reader', '{Spares} + 1');
    await f.add(f.signups, 'Readers', {
      type: 'rollup',
      options: { linkFieldId: f.people.inverseId, targetFieldId: reader, fn: 'sum' },
    });
    const echo = await f.formula(f.signups, 'Echo', '{Readers} + 1');
    expect(
      await f.command({
        kind: 'field.update',
        fieldId: spares,
        options: { linkFieldId: f.people.id, targetFieldId: echo, fn: 'sum' },
      }),
    ).toMatchObject(circular);
    expect(
      await f.command({
        kind: 'field.convert',
        fieldId: spares,
        to: { type: 'lookup', options: { linkFieldId: f.people.id, targetFieldId: echo } },
        dateOrder: 'mdy',
        timeZone: 'UTC',
      }),
    ).toMatchObject(circular);
    // Nothing was saved, and every table still reads.
    expect((await f.field(f.counts)).options).toMatchObject({ resultType: 'number' });
    expect((await f.field(spares)).options).toMatchObject({ targetFieldId: spare });
    expect((await f.rows(f.shifts)).get(f.shiftIds.morning)!.values).toMatchObject({ [f.open]: 1 });
    expect((await f.rows(f.signups)).get(f.signupIds.ana)!.errors).toBeUndefined();
  });
});

describe('calendars and timelines over date formulas', () => {
  it('refuses a date formula only JavaScript computes, and takes one the database does', async () => {
    const f = await setup('Events', 'Calendar');
    const table = f.shifts;
    const start = await f.add(table, 'Start', { type: 'date' });
    const inDatabase = await f.formula(table, 'Shown', 'IF({Name} = "", BLANK(), {Start})');
    const inJavaScript = await f.formula(table, 'Workday', 'WORKDAY({Start}, 2)');
    expect((await f.field(inDatabase)).options).toMatchObject({ resultType: 'date', sortable: true });
    expect((await f.field(inJavaScript)).options).toMatchObject({ resultType: 'date', sortable: false });
    await f.create(table, [{ [table.nameId]: 'Launch', [start]: '2026-03-02' }]);
    const create = (type: string, config: Record<string, unknown>) => {
      const id = newId('view');
      return f
        .command({ kind: 'view.create', view: { id, name: id, tableId: table.id, type, config } })
        .then((result) => ({ id, result }));
    };
    const refused = (setting: string) => ({
      status: 'rejected',
      error: { messageKey: 'data.view.formulaDates', params: { setting } },
    });
    for (const [type, setting] of [
      ['calendar', 'calendar'],
      ['timeline', 'timeline'],
      ['gantt', 'gantt'],
    ] as const) {
      expect((await create(type, { [setting]: { startFieldId: inJavaScript } })).result).toMatchObject(
        refused(`${setting}.startFieldId`),
      );
      const { id, result } = await create(type, { [setting]: { startFieldId: inDatabase } });
      expect(result).toMatchObject({ status: 'applied' });
      expect(
        await f.command({
          kind: 'view.update',
          viewId: id,
          config: { [setting]: { startFieldId: inDatabase, endFieldId: inJavaScript } },
        }),
      ).toMatchObject(refused(`${setting}.endFieldId`));
    }
    // A grid view isn't a calendar, so what its calendar settings name doesn't matter yet.
    expect((await create('grid', { calendar: { startFieldId: inJavaScript } })).result).toMatchObject({
      status: 'applied',
    });
    // A calendar whose formula changes to one only JavaScript computes says so when it reads, and
    // its other settings still change.
    const { id: calendar } = await create('calendar', { calendar: { startFieldId: inDatabase } });
    const read = () =>
      server.app.inject({
        url: `/api/views/${calendar}/rows?from=2026-03-01&to=2026-03-31`,
        headers: server.owner.headers,
      });
    expect((await read()).json<RowsPage>().rows).toHaveLength(1);
    await send(f.databaseId, {
      kind: 'field.update',
      fieldId: inDatabase,
      options: { expression: 'WORKDAY({Start}, 0)' },
    });
    const failed = await read();
    expect(failed.statusCode).toBe(422);
    expect(failed.json()).toMatchObject({
      error: { messageKey: 'data.view.formulaDates', params: { setting: 'calendar.startFieldId' } },
    });
    expect(
      await f.command({
        kind: 'view.update',
        viewId: calendar,
        config: { calendar: { startFieldId: inDatabase, endFieldId: null, range: 'week' } },
      }),
    ).toMatchObject({ status: 'applied' });
  });
});

it('scopes every cross-record function before calculation and hides unreadable dependencies', async () => {
  const f = await setup('Orders', 'Conditional totals');
  const source = await f.addTable('Sales Leads');
  const amount = await f.add(source, 'Amount', { type: 'number' });
  const visible = await f.add(source, 'Visible', { type: 'checkbox' });
  const [first, hidden, last] = await f.create(source, [
    { [source.nameId]: 'match', [amount]: 4, [visible]: true },
    { [source.nameId]: 'match', [amount]: 6, [visible]: false },
    { [source.nameId]: 'match', [amount]: 9, [visible]: true },
  ]);
  const [order] = await f.create(f.shifts, [{ [f.shifts.nameId]: 'match' }]);
  const linked = await f.link(f.shifts, source, 'Items');
  await f.update(f.shifts, order!, { [linked.id]: [first!, hidden!, last!] });
  const filter = {
    conjunction: 'and',
    conditions: [{ id: 'positive', fieldId: amount, operator: 'gt', value: 0 }],
  };
  const conditional = [
    {
      id: await f.add(f.shifts, 'Linked count', {
        type: 'count',
        options: { linkFieldId: linked.id, filter },
      }),
      expected: 2,
    },
    {
      id: await f.add(f.shifts, 'Linked sum', {
        type: 'rollup',
        options: { linkFieldId: linked.id, targetFieldId: amount, filter, fn: 'sum' },
      }),
      expected: 13,
    },
    {
      id: await f.add(f.shifts, 'Linked maximum', {
        type: 'lookup',
        options: {
          linkFieldId: linked.id,
          targetFieldId: amount,
          filter,
          sort: [{ fieldId: amount, direction: 'desc' }],
          limit: 1,
        },
      }),
      expected: [9],
    },
  ];
  const totals = [];
  for (const [name, expression, expected] of [
    ['SUMIFS', "SUMIFS('Sales Leads'[Amount], 'Sales Leads'[Name], {Name})", 13],
    [
      'Computed criterion',
      'SUMIFS(\'Sales Leads\'[Amount], \'Sales Leads\'[Name], REGEX_REPLACE({Name}, "^m", "m"))',
      13,
    ],
    [
      'Computed lookup',
      'XLOOKUP(VALUE(REGEX_REPLACE("6", "x", "")), \'Sales Leads\'[Amount], \'Sales Leads\'[Amount], 0, -1)',
      4,
    ],
    ['COUNTIFS', 'COUNTIFS(\'Sales Leads\'[Amount], ">0")', 2],
    ['AVERAGEIFS', "AVERAGEIFS('Sales Leads'[Amount], 'Sales Leads'[Name], {Name})", 6.5],
    ['MAXIFS', "MAXIFS('Sales Leads'[Amount], 'Sales Leads'[Name], {Name})", 9],
    ['MINIFS', "MINIFS('Sales Leads'[Amount], 'Sales Leads'[Name], {Name})", 4],
    ['XLOOKUP', "XLOOKUP(6, 'Sales Leads'[Amount], 'Sales Leads'[Amount], 0, -1)", 4],
  ] as const)
    totals.push({ id: await f.formula(f.shifts, name, expression), expected });
  const windows = [];
  await f.formula(source, 'Doubled', '{Amount} * 2');
  await f.formula(source, 'Group', 'REGEX_REPLACE("same", "x", "")');
  for (const [name, expression, recordId, expected] of [
    ['RANK', 'RANK({Amount})', first!, 2],
    ['PREVIOUS', 'PREVIOUS({Amount}, {Amount})', last!, 4],
    ['Computed previous', 'PREVIOUS(VALUE(REGEX_REPLACE({Amount} & "", "x", "")), {Amount})', last!, 4],
    ['NEXT', 'NEXT({Amount}, {Amount})', first!, 9],
    ['RUNNINGSUM', 'RUNNINGSUM({Amount}, {Amount})', last!, 13],
    ['RUNNINGCOUNT', 'RUNNINGCOUNT({Amount}, {Amount})', last!, 2],
    ['Partitioned rank', 'RANK({Amount}, 0, {Group})', first!, 2],
    ['Ordered previous', 'PREVIOUS({Amount}, {Doubled}, {Group})', last!, 4],
    ['Ordered next', 'NEXT({Amount}, {Doubled}, {Group})', first!, 9],
    ['Ordered sum', 'RUNNINGSUM({Amount}, {Doubled}, {Group})', last!, 13],
    ['Ordered count', 'RUNNINGCOUNT({Amount}, {Doubled}, {Group})', last!, 2],
  ] as const)
    windows.push({ id: await f.formula(source, name, expression), recordId, expected });
  const reader = await server.addMember({ name: 'Casey Reader' });
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${f.databaseId}, 'user', ${reader.userId}, 'reader')`,
  );
  const ruled = await server.app.inject({
    method: 'PUT',
    url: `/api/tables/${source.id}/record-rules`,
    headers: server.owner.headers,
    payload: {
      rules: [
        {
          id: newId('recordRule'),
          roles: ['reader'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'visible', fieldId: visible, operator: 'is', value: true }],
          },
        },
      ],
    },
  });
  expect(ruled.statusCode, ruled.body).toBe(200);
  const read = async (table: Table) => {
    const response = await server.app.inject({
      url: `/api/views/${table.viewId}/rows`,
      headers: reader.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<RowsPage>().rows.filter((row): row is RowData => !!row);
  };
  const rows = await read(f.shifts);
  for (const total of totals) expect(rows[0]!.values[total.id], total.id).toBe(total.expected);
  for (const field of conditional) expect(rows[0]!.values[field.id]).toEqual(field.expected);
  const records = await read(source);
  expect(records.some((row) => row.id === hidden)).toBe(false);
  for (const window of windows)
    expect(records.find((row) => row.id === window.recordId)!.values[window.id], window.id).toBe(
      window.expected,
    );
  // A view filter changes which rows appear, while windows still use the whole readable table.
  await f.view(source, {
    filter: { conjunction: 'and', conditions: [{ id: 'last', fieldId: amount, operator: 'gt', value: 8 }] },
  });
  const filtered = await read(source);
  expect(filtered).toHaveLength(1);
  expect(filtered[0]!.values[windows[1]!.id]).toBe(4);
  const restricted = await server.app.inject({
    method: 'PUT',
    url: `/api/fields/${amount}/permissions`,
    headers: server.owner.headers,
    payload: { restricted: { roles: ['owner'], users: [] }, locked: null },
  });
  expect(restricted.statusCode, restricted.body).toBe(200);
  const redacted = await read(f.shifts);
  for (const total of [...totals, ...conditional]) expect(redacted[0]!.values).not.toHaveProperty(total.id);
  const schema = await server.app.inject({
    url: `/api/databases/${f.databaseId}/schema`,
    headers: reader.headers,
  });
  expect(schema.statusCode, schema.body).toBe(200);
  const ids = schema.json<DatabaseSchema>().fields.map((field) => field.id);
  for (const window of windows) expect(ids).not.toContain(window.id);
});

it.each([false, true])(
  'reads structured formula dependencies with JavaScript fallback after an update: %s',
  async (updated) => {
    const f = await setup('Orders', 'Formula dependencies');
    const items = await f.addTable('Items');
    const amount = await f.add(items, 'Amount', { type: 'number' });
    const visible = await f.add(items, 'Visible', { type: 'checkbox' });
    const expression = 'VALUE(REGEX_REPLACE({Amount} & "", "x", ""))';
    const clean = await f.formula(items, 'Clean', updated ? '{Amount} * 1' : expression);
    for (const values of [
      { [items.nameId]: 'x', [amount]: 4, [visible]: true },
      { [items.nameId]: 'x', [amount]: 6, [visible]: false },
      { [items.nameId]: 'x', [amount]: 9, [visible]: true },
    ])
      await f.create(items, [values]);
    const [order] = await f.create(f.shifts, [{ [f.shifts.nameId]: 'x' }]);
    const formulas = [];
    for (const [name, source, expected] of [
      ['Lookup return', 'XLOOKUP({Name}, Items[Name], Items[Clean])', 4],
      ['Lookup key', 'XLOOKUP(6, Items[Clean], Items[Clean], 0, -1)', 4],
      ['Sum', 'SUMIFS(Items[Clean], Items[Name], {Name})', 13],
      ['Count', 'COUNTIFS(Items[Clean], ">0")', 2],
      ['Average', 'AVERAGEIFS(Items[Clean], Items[Name], {Name})', 6.5],
      ['Maximum', 'MAXIFS(Items[Clean], Items[Name], {Name})', 9],
      ['Minimum', 'MINIFS(Items[Clean], Items[Name], {Name})', 4],
    ] as const)
      formulas.push({ id: await f.formula(f.shifts, name, source), expected });
    if (updated) {
      expect((await f.record(f.shifts, order!)).values[formulas[2]!.id]).toBe(19);
      expect(
        await f.command({ kind: 'field.update', fieldId: clean, options: { expression } }),
      ).toMatchObject({
        status: 'applied',
      });
    }
    for (const formula of formulas)
      expect((await f.field(formula.id)).options).toMatchObject({ sortable: false });
    expect((await f.rows(f.shifts)).get(order!)!.values[formulas[2]!.id]).toBe(19);
    const reader = await server.addMember({ name: 'Formula Reader' });
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${server.owner.info.org.id}, 'database', ${f.databaseId}, 'user', ${reader.userId}, 'reader')`,
    );
    const rules = await server.app.inject({
      method: 'PUT',
      url: `/api/tables/${items.id}/record-rules`,
      headers: server.owner.headers,
      payload: {
        rules: [
          {
            id: newId('recordRule'),
            roles: ['reader'],
            users: [],
            condition: {
              conjunction: 'and',
              conditions: [{ id: 'visible', fieldId: visible, operator: 'is', value: true }],
            },
          },
        ],
      },
    });
    expect(rules.statusCode, rules.body).toBe(200);
    const read = async () => {
      const response = await server.app.inject({
        url: `/api/views/${f.shifts.viewId}/rows`,
        headers: reader.headers,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<RowsPage>().rows[0]!;
    };
    const row = await read();
    for (const formula of formulas) expect(row.values[formula.id], formula.id).toBe(formula.expected);
    const permissions = await server.app.inject({
      method: 'PUT',
      url: `/api/fields/${amount}/permissions`,
      headers: server.owner.headers,
      payload: { restricted: { roles: ['owner'], users: [] }, locked: null },
    });
    expect(permissions.statusCode, permissions.body).toBe(200);
    const hidden = await read();
    for (const formula of formulas) expect(hidden.values).not.toHaveProperty(formula.id);
  },
);

it.each([false, true])(
  'uses computed window ordering and partitions with JavaScript fallback: %s',
  async (fallback) => {
    const f = await setup('Items', 'Computed window fields');
    const amount = await f.add(f.shifts, 'Amount', { type: 'number' });
    await f.formula(
      f.shifts,
      'Doubled',
      fallback ? 'VALUE(REGEX_REPLACE({Amount} & "", "x", "")) * 2' : '{Amount} * 2',
    );
    await f.formula(f.shifts, 'Group', fallback ? 'REGEX_REPLACE(UPPER({Name}), "x", "")' : 'UPPER({Name})');
    const ids = await f.create(f.shifts, [
      { [f.shifts.nameId]: 'a', [amount]: 2 },
      { [f.shifts.nameId]: 'A', [amount]: 4 },
      { [f.shifts.nameId]: 'b', [amount]: 8 },
    ]);
    const formulas = [];
    for (const [name, expression, expected] of [
      ['Previous', 'PREVIOUS({Amount}, {Doubled}, {Group})', [null, 2, null]],
      ['Next', 'NEXT({Amount}, {Doubled}, {Group})', [4, null, null]],
      ['Sum', 'RUNNINGSUM({Amount}, {Doubled}, {Group})', [2, 6, 8]],
      ['Count', 'RUNNINGCOUNT({Amount}, {Doubled}, {Group})', [1, 2, 1]],
      ['Rank', 'RANK({Amount}, 0, {Group})', [2, 1, 1]],
    ] as const)
      formulas.push({ id: await f.formula(f.shifts, name, expression), expected });
    const rows = await f.rows(f.shifts);
    for (const formula of formulas) {
      expect((await f.field(formula.id)).options).toMatchObject({ sortable: !fallback });
      expect(ids.map((id) => rows.get(id)!.values[formula.id])).toEqual(formula.expected);
    }
    await f.add(
      f.shifts,
      'Invalid order',
      { type: 'formula', options: { expression: 'PREVIOUS({Amount}, {Amount} * 2)' } },
      'formula.type.fieldRequired',
    );
  },
);

it('filters linked counts and totals by constants and the current record, then sorts and limits lookups', async () => {
  const f = await setup('Orders', 'Filtered links');
  const products = await f.addTable('Products');
  const price = await f.add(products, 'Price', { type: 'number' });
  const threshold = await f.add(f.shifts, 'Threshold', { type: 'number' });
  const link = await f.link(f.shifts, products, 'Products');
  const ids = await f.create(products, [
    { [products.nameId]: 'First', [price]: 4 },
    { [products.nameId]: 'Middle', [price]: 6 },
    { [products.nameId]: 'Last', [price]: 9 },
  ]);
  const [id] = await f.create(f.shifts, [{ [f.shifts.nameId]: 'Order', [threshold]: 5, [link.id]: ids }]);
  const filter = {
    conjunction: 'and',
    conditions: [{ id: 'threshold', fieldId: price, operator: 'gt', currentFieldId: threshold }],
  };
  const lookup = await f.add(f.shifts, 'Latest', {
    type: 'lookup',
    options: {
      linkFieldId: link.id,
      targetFieldId: price,
      filter,
      sort: [{ fieldId: price, direction: 'desc' }],
      limit: 1,
    },
  });
  const rollup = await f.add(f.shifts, 'Total', {
    type: 'rollup',
    options: { linkFieldId: link.id, targetFieldId: price, filter, fn: 'sum' },
  });
  const count = await f.add(f.shifts, 'Count', { type: 'count', options: { linkFieldId: link.id, filter } });
  const productCreated = await f.add(products, 'Created', { type: 'createdTime' });
  const orderCreated = await f.add(f.shifts, 'Created', { type: 'createdTime' });
  const earlier = await f.add(f.shifts, 'Earlier products', {
    type: 'count',
    options: {
      linkFieldId: link.id,
      filter: {
        conjunction: 'and',
        conditions: [
          { id: 'earlier', fieldId: productCreated, operator: 'isOnOrBefore', currentFieldId: orderCreated },
        ],
      },
    },
  });
  let row = await f.record(f.shifts, id!);
  expect(row.values).toMatchObject({ [lookup]: [9], [rollup]: 15, [count]: 2, [earlier]: 3 });
  const linkedRows = await Promise.all(ids.map((id) => f.record(products, id)));
  const fields = await Promise.all([price, threshold, productCreated, orderCreated].map((id) => f.field(id)));
  for (const id of [lookup, rollup, count, earlier]) {
    const field = await f.field(id);
    if (field.type !== 'lookup' && field.type !== 'rollup' && field.type !== 'count')
      throw new Error('Unexpected field type');
    expect(evaluateRelation(field, row, linkedRows, fields, { now: new Date(), timeZone: 'UTC' })).toEqual(
      row.values[id],
    );
  }
  await f.update(f.shifts, id!, { [threshold]: 7 });
  row = await f.record(f.shifts, id!);
  expect(row.values).toMatchObject({ [lookup]: [9], [rollup]: 9, [count]: 1 });
  await f.update(products, ids[2]!, { [price]: 10 });
  expect((await f.record(f.shifts, id!)).values[lookup]).toEqual([10]);
});

it('returns a warm first page of 20000 records with SUMIFS over 2000 records in under two seconds', async () => {
  const f = await setup('Orders', 'Conditional performance');
  const source = await f.addTable('Items');
  const amount = await f.add(source, 'Amount', { type: 'number' });
  for (let offset = 0; offset < 2000; offset += 500)
    await f.create(
      source,
      Array.from({ length: 500 }, (_, index) => ({
        [source.nameId]: String((offset + index) % 20),
        [amount]: 1,
      })),
    );
  for (let offset = 0; offset < 20000; offset += 500)
    await f.create(
      f.shifts,
      Array.from({ length: 500 }, (_, index) => ({ [f.shifts.nameId]: String((offset + index) % 20) })),
    );
  const total = await f.formula(f.shifts, 'Total', 'SUMIFS(Items[Amount], Items[Name], {Name})');
  await f.page(f.shifts);
  const start = performance.now();
  const page = await f.page(f.shifts);
  const elapsed = performance.now() - start;
  expect(page.rows.length).toBeGreaterThan(0);
  expect(page.rows[0]!.values[total]).toBe(100);
  expect(elapsed).toBeLessThan(2000);
}, 120_000);

it('rebuilds a filtered snapshot when an unlinked formula source changes', async () => {
  const f = await setup('Orders', 'Unlinked refresh');
  const items = await f.addTable('Items');
  const amount = await f.add(items, 'Amount', { type: 'number' });
  const [item] = await f.create(items, [{ [items.nameId]: 'Match', [amount]: 2 }]);
  await f.create(f.shifts, [{ [f.shifts.nameId]: 'Match' }]);
  const total = await f.formula(f.shifts, 'Total', 'SUMIFS(Items[Amount], Items[Name], {Name})');
  await f.view(f.shifts, {
    filter: { conjunction: 'and', conditions: [{ id: 'large', fieldId: total, operator: 'gt', value: 5 }] },
  });
  expect((await f.page(f.shifts)).rows).toHaveLength(0);
  await f.update(items, item!, { [amount]: 8 });
  const page = await f.page(f.shifts);
  expect(page.rows).toHaveLength(1);
  expect(page.rows[0]!.values[total]).toBe(8);
});
