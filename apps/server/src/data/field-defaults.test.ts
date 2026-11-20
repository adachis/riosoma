import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AppError,
  DatabaseCreate,
  dayIn,
  FieldSpec,
  newId,
  type CellValue,
  type CommandBatchResult,
  type FieldMeta,
  type RowsPage,
} from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { savedDefault } from './commands/defaults.js';

let kit: TestPostgres;
let server: ServerFixture;
const clientId = newId('client');
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'field_defaults');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function get<T>(url: string): Promise<T> {
  const response = await server.app.inject({ url, headers: server.owner.headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

async function send(databaseId: string, input: Record<string, unknown>, messageKey?: string) {
  const command = { id: newId('command'), groupId: newId('action'), ...input };
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: { clientId, commands: [command] },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<CommandBatchResult>().results[0]!;
  expect(result, response.body).toMatchObject(
    messageKey ? { status: 'rejected', error: { messageKey } } : { status: 'applied' },
  );
  return command;
}

const choice = (name: string) => ({ id: newId('choice'), name, color: 'blue' as const });

async function fixture(specs: unknown[], count = 0) {
  const fields = specs.map((spec, i) => ({
    id: newId('field'),
    name: `Field ${i}`,
    ...FieldSpec.parse(spec),
  }));
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Database',
    table: {
      id: newId('table'),
      name: 'Table',
      fields: [{ id: newId('field'), name: 'Name', type: 'text' }, ...fields],
      view: { id: newId('view'), name: 'Grid' },
      records: Array.from({ length: count }, () => ({ id: newId('record') })),
    },
  });
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: input,
  });
  expect(response.statusCode, response.body).toBe(200);
  const tableId = input.table.id;
  const command = (body: Record<string, unknown>, messageKey?: string) => send(input.id, body, messageKey);
  const record = async (id: string) =>
    (await get<RowsPage>(`/api/views/${input.table.view.id}/rows?refresh=1`)).rows.find(
      (row) => row?.id === id,
    )!.values;
  return {
    ...input,
    fields,
    tableId,
    command,
    record,
    schemaField: async (fieldId: string) =>
      (await get<{ fields: FieldMeta[] }>(`/api/databases/${input.id}/schema`)).fields.find(
        (field) => field.id === fieldId,
      )!,
    insert: async (values: Record<string, CellValue> = {}, extra: Record<string, unknown> = {}) => {
      const id = newId('record');
      await command({ kind: 'record.create', tableId, records: [{ id, values }], ...extra });
      return record(id);
    },
  };
}

describe('field default values', () => {
  it('gives a new record each field’s default where nobody gave a value', async () => {
    const [a, b, c] = [choice('A'), choice('B'), choice('C')];
    const f = await fixture([
      { type: 'text', options: { defaultValue: { kind: 'value', value: 'New' } } },
      { type: 'number', options: { defaultValue: { kind: 'value', value: 3 } } },
      { type: 'currency', options: { defaultValue: { kind: 'value', value: 9.5 } } },
      { type: 'percent', options: { defaultValue: { kind: 'value', value: 0.25 } } },
      { type: 'rating', options: { defaultValue: { kind: 'value', value: 4 } } },
      { type: 'checkbox', options: { defaultValue: { kind: 'value', value: true } } },
      { type: 'singleSelect', options: { choices: [a, b], defaultValue: { kind: 'value', value: b.id } } },
      { type: 'singleSelect', options: { choices: [a, b], defaultValue: { kind: 'firstChoice' } } },
      {
        type: 'multipleSelect',
        options: { choices: [a, b, c], defaultValue: { kind: 'value', value: [a.id, c.id] } },
      },
      { type: 'date', options: { defaultValue: { kind: 'value', value: '2026-01-02' } } },
      { type: 'date', options: { timeZone: 'Pacific/Kiritimati', defaultValue: { kind: 'today' } } },
      { type: 'date', options: { defaultValue: { kind: 'today' } } },
      { type: 'date', options: { includeTime: true, defaultValue: { kind: 'now' } } },
      { type: 'url', options: { defaultValue: { kind: 'value', value: 'https://example.com' } } },
      { type: 'email', options: { defaultValue: { kind: 'value', value: 'team@example.com' } } },
      { type: 'phone', options: { defaultValue: { kind: 'value', value: '555-0100' } } },
      { type: 'user', options: { defaultValue: { kind: 'creator' } } },
    ]);
    const ids = f.fields.map((field) => field.id);
    const before = new Date();
    const values = await f.insert({}, { timeZone: 'Pacific/Pago_Pago' });
    const after = new Date();
    expect(ids.map((id) => values[id])).toEqual([
      'New',
      3,
      9.5,
      0.25,
      4,
      true,
      b.id,
      a.id,
      [a.id, c.id],
      '2026-01-02',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      expect.any(String),
      'https://example.com',
      'team@example.com',
      '555-0100',
      [server.owner.userId],
    ]);
    // A field with its own time zone uses it, and one that follows each person uses theirs.
    expect([dayIn('Pacific/Kiritimati', before), dayIn('Pacific/Kiritimati', after)]).toContain(
      values[ids[10]!],
    );
    expect([dayIn('Pacific/Pago_Pago', before), dayIn('Pacific/Pago_Pago', after)]).toContain(
      values[ids[11]!],
    );
    const moment = Date.parse(values[ids[12]!] as string);
    expect(moment).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(moment).toBeLessThanOrEqual(after.getTime() + 1000);
    // Without the person's time zone, a day that follows each person is the day in UTC.
    const utc = await f.insert();
    expect([dayIn('UTC', before), dayIn('UTC', new Date())]).toContain(utc[ids[11]!]);
  });

  it('keeps every value someone gave, even an empty one, and never fills a default on update', async () => {
    const f = await fixture([
      { type: 'text', options: { defaultValue: { kind: 'value', value: 'New' } } },
      { type: 'checkbox', options: { defaultValue: { kind: 'value', value: true } } },
      { type: 'number', options: { defaultValue: { kind: 'value', value: 3 } } },
    ]);
    const [text, box, number] = f.fields.map((field) => field.id) as [string, string, string];
    const given = await f.insert({ [text]: 'Mine', [box]: false, [number]: null });
    expect([given[text], given[box], given[number]]).toEqual(['Mine', false, null]);
    const id = newId('record');
    await f.command({
      kind: 'record.create',
      tableId: f.tableId,
      records: [{ id, values: { [text]: null } }],
    });
    expect((await f.record(id))[text]).toBeNull();
    expect((await f.record(id))[number]).toBe(3);
    await f.command({
      kind: 'record.update',
      tableId: f.tableId,
      records: [{ id, values: { [text]: 'Later' } }],
    });
    expect((await f.record(id))[number]).toBe(3);
    await f.command({
      kind: 'record.update',
      tableId: f.tableId,
      records: [{ id, values: { [number]: null } }],
    });
    expect((await f.record(id))[number]).toBeNull();
  });

  it('gives a new table’s first records their defaults', async () => {
    const f = await fixture(
      [{ type: 'text', options: { defaultValue: { kind: 'value', value: 'Open' } } }],
      2,
    );
    const page = await get<RowsPage>(`/api/views/${f.table.view.id}/rows?refresh=1`);
    expect(page.rows.map((row) => row!.values[f.fields[0]!.id])).toEqual(['Open', 'Open']);
  });

  it('fills a form question left blank with its default, and keeps an answer', async () => {
    const f = await fixture([
      { type: 'text', options: { defaultValue: { kind: 'value', value: 'Website' } } },
      { type: 'checkbox', options: { defaultValue: { kind: 'value', value: true } } },
      { type: 'number', options: { defaultValue: { kind: 'value', value: 1 } } },
    ]);
    const [text, box, number] = f.fields.map((field) => field.id) as [string, string, string];
    const formViewId = newId('view');
    await f.command({
      kind: 'view.create',
      view: {
        id: formViewId,
        name: 'Form',
        tableId: f.tableId,
        type: 'form',
        config: { form: { questions: [{ fieldId: text }, { fieldId: box }] } },
      },
    });
    const blank = await f.insert({ [text]: '  ' }, { formViewId });
    // A question left blank and a field the form doesn't ask about both take their defaults.
    expect([blank[text], blank[box], blank[number]]).toEqual(['Website', true, 1]);
    const answered = await f.insert({ [text]: 'Friend', [box]: false }, { formViewId });
    expect([answered[text], answered[box]]).toEqual(['Friend', false]);
  });

  it('checks required form answers after usable defaults and still refuses invalid answers', async () => {
    const f = await fixture([
      { type: 'text', options: { defaultValue: { kind: 'value', value: 'Open' } } },
      { type: 'number', options: { defaultValue: { kind: 'value', value: 2 } } },
      { type: 'text' },
      { type: 'checkbox', options: { defaultValue: { kind: 'value', value: true } } },
      { type: 'checkbox', options: { defaultValue: { kind: 'value', value: false } } },
    ]);
    const [text, number, plain, checked, unchecked] = f.fields.map((field) => field.id) as [
      string,
      string,
      string,
      string,
      string,
    ];
    const formViewId = newId('view');
    await f.command({
      kind: 'view.create',
      view: {
        id: formViewId,
        name: 'Form',
        tableId: f.tableId,
        type: 'form',
        config: {
          form: {
            questions: [text, number, plain, checked, unchecked].map((fieldId) => ({
              fieldId,
              required: true,
            })),
          },
        },
      },
    });
    for (const values of [
      { [plain]: 'Answered' },
      { [text]: '  ', [number]: null, [plain]: 'Answered', [checked]: null, [unchecked]: null },
      { [plain]: 'Answered', [checked]: false, [unchecked]: false },
    ]) {
      const row = await f.insert(values, { formViewId });
      expect([row[text], row[number], row[plain], row[checked], row[unchecked]]).toEqual([
        'Open',
        2,
        'Answered',
        values[checked] ?? true,
        false,
      ]);
    }
    await f.command(
      {
        kind: 'record.create',
        tableId: f.tableId,
        formViewId,
        records: [{ id: newId('record'), values: {} }],
      },
      'data.form.required',
    );
    await f.command(
      {
        kind: 'record.create',
        tableId: f.tableId,
        formViewId,
        records: [{ id: newId('record'), values: { [number]: 'invalid', [plain]: 'Answered' } }],
      },
      'data.value.notNumber',
    );
  });

  it('refuses a default that doesn’t fit its field, and stores one that does the way values are stored', async () => {
    const f = await fixture([]);
    const create = (spec: unknown, messageKey?: string) =>
      f.command(
        {
          kind: 'field.create',
          tableId: f.tableId,
          field: { id: newId('field'), name: newId('field'), ...(spec as object) },
        },
        messageKey,
      );
    await create(
      { type: 'rating', options: { max: 3, defaultValue: { kind: 'value', value: 4 } } },
      'data.field.defaultInvalid',
    );
    await create(
      { type: 'number', options: { allowNegative: false, defaultValue: { kind: 'value', value: -2 } } },
      'data.field.defaultInvalid',
    );
    await create(
      { type: 'email', options: { defaultValue: { kind: 'value', value: 'not an address' } } },
      'data.field.defaultInvalid',
    );
    await create(
      {
        type: 'text',
        options: { validation: { maxLength: { value: 2 } }, defaultValue: { kind: 'value', value: 'Long' } },
      },
      'data.field.defaultInvalid',
    );
    await create(
      {
        type: 'singleSelect',
        options: { choices: [], defaultValue: { kind: 'value', value: newId('choice') } },
      },
      'data.field.defaultInvalid',
    );
    await create(
      { type: 'text', options: { unique: true, defaultValue: { kind: 'value', value: 'Same' } } },
      'data.field.defaultUnique',
    );
    const id = newId('field');
    await f.command({
      kind: 'field.create',
      tableId: f.tableId,
      field: {
        id,
        name: 'When',
        type: 'date',
        options: { includeTime: true, defaultValue: { kind: 'value', value: '2026-10-01T09:00:00-07:00' } },
      },
    });
    expect((await f.schemaField(id)).options).toMatchObject({
      defaultValue: { kind: 'value', value: '2026-10-01T16:00:00.000Z' },
    });
  });

  it('drops a deleted option from a default and clears one a later change no longer fits', async () => {
    const [a, b, c] = [choice('A'), choice('B'), choice('C')];
    const f = await fixture([
      {
        type: 'multipleSelect',
        options: { choices: [a, b, c], defaultValue: { kind: 'value', value: [a.id, b.id] } },
      },
      { type: 'singleSelect', options: { choices: [a, b], defaultValue: { kind: 'value', value: a.id } } },
      { type: 'rating', options: { max: 5, defaultValue: { kind: 'value', value: 5 } } },
      { type: 'date', options: { defaultValue: { kind: 'value', value: '2026-01-02' } } },
      { type: 'date', options: { defaultValue: { kind: 'today' } } },
    ]);
    const [multi, single, rating, day, today] = f.fields;
    const update = (field: (typeof f.fields)[number], options: Record<string, unknown>) =>
      f.command({ kind: 'field.update', fieldId: field!.id, options: { ...field!.options, ...options } });
    await update(multi!, { choices: [b, c] });
    expect((await f.schemaField(multi!.id)).options).toMatchObject({
      defaultValue: { kind: 'value', value: [b.id] },
    });
    await update(single!, { choices: [b] });
    expect((await f.schemaField(single!.id)).options).not.toHaveProperty('defaultValue');
    await update(rating!, { max: 3 });
    expect((await f.schemaField(rating!.id)).options).not.toHaveProperty('defaultValue');
    // A default someone sets in the same change has to fit, rather than being dropped.
    await f.command(
      {
        kind: 'field.update',
        fieldId: rating!.id,
        options: { ...rating!.options, max: 3, defaultValue: { kind: 'value', value: 4 } },
      },
      'data.field.defaultInvalid',
    );
    await update(day!, { includeTime: true });
    expect((await f.schemaField(day!.id)).options).not.toHaveProperty('defaultValue');
    await update(today!, { includeTime: true });
    expect((await f.schemaField(today!.id)).options).toMatchObject({ defaultValue: { kind: 'today' } });
    // A default on a field turned unique goes away, since every new record would repeat it.
    await f.command({
      kind: 'field.update',
      fieldId: f.table.fields[0]!.id,
      options: { defaultValue: { kind: 'value', value: 'Name' } },
    });
    await f.command({
      kind: 'field.update',
      fieldId: f.table.fields[0]!.id,
      options: { unique: true, defaultValue: { kind: 'value', value: 'Name' } },
    });
    expect((await f.schemaField(f.table.fields[0]!.id)).options).not.toHaveProperty('defaultValue');
  });

  it('keeps a default through a type change that can hold it, and clears one that can’t', async () => {
    const [a, b] = [choice('A'), choice('B')];
    const f = await fixture([
      { type: 'singleSelect', options: { choices: [a, b], defaultValue: { kind: 'value', value: b.id } } },
      { type: 'text', options: { defaultValue: { kind: 'value', value: 'Words' } } },
      { type: 'number', options: { defaultValue: { kind: 'value', value: 7 } } },
    ]);
    const [select, text, number] = f.fields;
    const convert = (fieldId: string, to: unknown) =>
      f.command({ kind: 'field.convert', fieldId, to, dateOrder: 'mdy', timeZone: 'UTC' });
    await convert(select!.id, { type: 'multipleSelect', options: { choices: [a, b] } });
    expect((await f.schemaField(select!.id)).options).toMatchObject({
      defaultValue: { kind: 'value', value: [b.id] },
    });
    await convert(text!.id, { type: 'number', options: {} });
    expect((await f.schemaField(text!.id)).options).not.toHaveProperty('defaultValue');
    await convert(number!.id, { type: 'currency', options: {} });
    expect((await f.schemaField(number!.id)).options).toMatchObject({
      defaultValue: { kind: 'value', value: 7 },
    });
    // A default the change names that the new type can't hold is cleared too.
    const other = newId('field');
    await f.command({
      kind: 'field.create',
      tableId: f.tableId,
      field: { id: other, name: 'Other', type: 'text' },
    });
    await convert(other, { type: 'rating', options: { max: 3, defaultValue: { kind: 'value', value: 3 } } });
    expect((await f.schemaField(other)).options).toMatchObject({ defaultValue: { kind: 'value', value: 3 } });
    await convert(other, { type: 'checkbox', options: {} });
    expect((await f.schemaField(other)).options).not.toHaveProperty('defaultValue');
  });

  it('refuses a new default on a synced table’s field and drops one it kept', () => {
    const spec = FieldSpec.parse({ type: 'text', options: { defaultValue: { kind: 'value', value: 'x' } } });
    expect(() => savedDefault(spec, undefined, { synced: true })).toThrow(AppError);
    expect(savedDefault(spec, spec, { synced: true }).options).not.toHaveProperty('defaultValue');
    expect(savedDefault(spec, undefined).options).toMatchObject({
      defaultValue: { kind: 'value', value: 'x' },
    });
  });
});
