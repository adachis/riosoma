import { apply, send as sendAs } from '../scripts/scripts.test-helpers.js';
import { grant } from '../automations/automations.test-helpers.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  DatabaseCreate,
  FieldSpec,
  newId,
  type CellValue,
  type CommandBatchResult,
  type ConversionPreview,
  type FieldMeta,
  type PublicForm,
  type PublicFormLink,
  type RowData,
  type RowsPage,
  type SignatureValue,
  type TokenCreated,
} from '@riosoma/contracts';
import { query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { issueTicket } from './public-forms.js';

let kit: TestPostgres;
let server: ServerFixture;
let token: TokenCreated;
const clientId = newId('client');
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'compound_fields', { automationsPollMs: 0 });
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: server.owner.headers,
    payload: {
      name: 'Integration',
      scopes: ['data.records:read', 'data.records:write', 'schema.bases:read'],
      databases: 'all',
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  token = response.json<TokenCreated>();
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

/** A table with a text primary field named Name and the given fields, named Field 0, Field 1, … */
async function fixture(specs: unknown[], count = 3) {
  const fields = specs.map((spec, i) => ({
    id: newId('field'),
    name: `Field ${i}`,
    ...FieldSpec.parse(spec),
  }));
  const primary = newId('field');
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Database',
    table: {
      id: newId('table'),
      name: 'Table',
      fields: [{ id: primary, name: 'Name', type: 'text' }, ...fields],
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
  const viewId = input.table.view.id;
  const records = input.table.records.map((record) => record.id);
  const command = (body: Record<string, unknown>, messageKey?: string) => send(input.id, body, messageKey);
  // Records are named R0, R1, … so a test can say which ones a view shows, in order.
  if (count)
    await command({
      kind: 'record.update',
      tableId,
      records: records.map((id, i) => ({ id, values: { [primary]: `R${i}` } })),
    });
  const page = () => get<RowsPage>(`/api/views/${viewId}/rows?refresh=1`);
  return {
    id: input.id,
    tableId,
    viewId,
    primary,
    records,
    fields,
    command,
    page,
    names: async () => (await page()).rows.map((row) => row!.values[primary]),
    values: async (fieldId: string) => (await page()).rows.map((row) => row!.values[fieldId] ?? null),
    write: (fieldId: string, values: unknown[], messageKey?: string) =>
      command(
        {
          kind: 'record.update',
          tableId,
          records: values.map((value, i) => ({ id: records[i]!, values: { [fieldId]: value } })),
        },
        messageKey,
      ),
    view: (config: unknown) => command({ kind: 'view.update', viewId, config }),
    undo: async (groupId: string) => {
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/databases/${input.id}/undo`,
        headers: server.owner.headers,
        payload: { commandId: newId('command'), groupId, clientId },
      });
      expect(response.json(), response.body).toMatchObject({ status: 'applied' });
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function filtered(f: Fixture, fieldId: string, operator: string, value?: unknown) {
  await f.view({ filter: { conjunction: 'and', conditions: [{ id: 'filter', fieldId, operator, value }] } });
  return f.names();
}

function preview(fieldId: string, to: unknown) {
  return server.app.inject({
    method: 'POST',
    url: `/api/fields/${fieldId}/conversion-preview`,
    headers: server.owner.headers,
    payload: { to, dateOrder: 'mdy', timeZone: 'UTC' },
  });
}

async function conversion(from: unknown, to: unknown, values: unknown[], expected: CellValue[]) {
  const f = await fixture([from], values.length);
  const fieldId = f.fields[0]!.id;
  await f.write(fieldId, values);
  const stored = await f.values(fieldId);
  const total = stored.filter((value) => value !== null).length;
  const emptied = stored.filter((value, i) => value !== null && expected[i] === null).length;
  const counts = await preview(fieldId, to);
  expect(counts.statusCode, counts.body).toBe(200);
  expect(counts.json<ConversionPreview>()).toMatchObject({ total, converted: total - emptied, emptied });
  const command = await f.command({ kind: 'field.convert', fieldId, to });
  expect(await f.values(fieldId)).toEqual(expected);
  return { f, fieldId, command };
}

/** Today and nearby days in UTC, where a view with no zone of its own reads "today". */
function day(offset: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

const drawing = { path: 'M10 20l3 -2 4 1 M50 60l0 0', width: 400, height: 150 };

describe('date range, JSON, location, signature, and button fields', () => {
  it('stores each type in its own column and reads it back from commands, pages, and records', async () => {
    const f = await fixture([
      { type: 'dateRange' },
      { type: 'dateRange', options: { includeTime: true, timeZone: 'America/Chicago' } },
      { type: 'json' },
      { type: 'location' },
      { type: 'signature' },
      {
        type: 'button',
        options: { label: 'Open', action: { kind: 'openUrl', urlTemplate: 'https://x.test' } },
      },
    ]);
    const [range, timed, json, place, signature, button] = f.fields.map((field) => field.id);
    const physical = await query<{ column_name: string; udt_name: string }>(
      server.pool,
      sql`SELECT column_name, udt_name FROM information_schema.columns
      WHERE table_schema = ${server.schemas.data} AND table_name = ${f.tableId}`,
    );
    const types = new Map(physical.rows.map((row) => [row.column_name, row.udt_name]));
    expect([range, timed, json, place, signature, button].map((id) => types.get(id!))).toEqual([
      'daterange',
      'tstzrange',
      'text',
      'jsonb',
      'jsonb',
      undefined,
    ]);
    await f.command({
      kind: 'record.update',
      tableId: f.tableId,
      records: [
        {
          id: f.records[0]!,
          values: {
            [range!]: { start: '2026-09-27', end: '2026-09-30', extra: true },
            [timed!]: { start: '2026-09-27T14:00:00+02:00', end: '2026-09-27T17:30:00Z' },
            [json!]: '{\n  "b": 1.50,\n  "a": [true, null]\n}',
            [place!]: { lat: 40.71278123, lng: -74.0059999, label: ' New York\nCity ' },
            [signature!]: { drawing, name: '  Ada   Lovelace ' },
          },
        },
      ],
    });
    const expected = {
      [range!]: { start: '2026-09-27', end: '2026-09-30' },
      [timed!]: { start: '2026-09-27T12:00:00.000Z', end: '2026-09-27T17:30:00.000Z' },
      [json!]: '{"b":1.50,"a":[true,null]}',
      [place!]: { lat: 40.712781, lng: -74.006, label: 'New York City' },
    };
    const first = await f.page();
    expect(first.rows[0]!.values).toMatchObject(expected);
    expect(first.rows[0]!.values).not.toHaveProperty(button!);
    const record = await get<RowData>(`/api/tables/${f.tableId}/records/${f.records[0]}`);
    expect(record).toEqual(first.rows[0]);
    const signed = record.values[signature!] as SignatureValue;
    expect(signed).toMatchObject({ drawing, name: 'Ada Lovelace', signedBy: server.owner.userId });
    expect(Date.now() - Date.parse(signed.signedAt)).toBeLessThan(60_000);
    const retained = await get<RowsPage>(`/api/views/${f.viewId}/rows?snapshot=${first.snapshot}`);
    expect(retained.rows).toEqual(first.rows);
    await f.write(json!, ['null', '   ']);
    expect((await f.values(json!)).slice(0, 2)).toEqual([null, null]);
  });

  it('refuses values each type can’t hold, and any value at all for a button', async () => {
    const f = await fixture([
      { type: 'dateRange' },
      { type: 'json' },
      { type: 'location' },
      { type: 'signature' },
      { type: 'button' },
    ]);
    const [range, json, place, signature, button] = f.fields.map((field) => field.id);
    const bad: Array<[string, unknown, string]> = [
      [range!, { start: '2026-09-30', end: '2026-09-27' }, 'data.value.dateRange'],
      [range!, { start: '2026-02-30', end: '2026-03-01' }, 'data.value.dateRange'],
      [range!, '2026-09-27', 'data.value.dateRange'],
      [json!, '{"a":', 'data.value.notJson'],
      [json!, { a: 1 }, 'data.value.notJson'],
      [json!, `"${'x'.repeat(100_000)}"`, 'data.value.tooLong'],
      [place!, { lat: 91, lng: 0 }, 'data.value.location'],
      [place!, { lat: 0, lng: -180.5 }, 'data.value.location'],
      [place!, { lat: '1', lng: 2 }, 'data.value.location'],
      [signature!, { drawing: null, name: ' ' }, 'data.value.signature'],
      [signature!, { drawing: { ...drawing, path: 'M0 0" onload="alert(1)' } }, 'data.value.signature'],
      [signature!, { drawing: { ...drawing, width: 0 } }, 'data.value.signature'],
      [signature!, { name: 'Ada', signedBy: 'someone' }, 'data.value.signature'],
      [button!, 'https://x.test', 'data.value.button'],
    ];
    for (const [fieldId, value, key] of bad) await f.write(fieldId, [value], key);
  });

  it('signs as whoever writes, now, whatever the writer claims, and undo restores the earlier signer', async () => {
    const f = await fixture([{ type: 'signature' }]);
    const fieldId = f.fields[0]!.id;
    const other = await server.addMember({ name: 'Other' });
    await f.write(fieldId, [
      { drawing, name: 'Ada', signedBy: other.userId, signedAt: '2001-01-01T00:00:00.000Z' },
    ]);
    const first = (await f.values(fieldId))[0] as SignatureValue;
    expect(first.signedBy).toBe(server.owner.userId);
    expect(first.signedAt > '2020').toBe(true);
    const replaced = await f.write(fieldId, [{ drawing: null, name: 'Grace' }]);
    expect((await f.values(fieldId))[0]).toMatchObject({ drawing: null, name: 'Grace' });
    await f.undo(replaced.groupId);
    expect((await f.values(fieldId))[0]).toEqual(first);
  });

  it('filters date ranges by their days and sorts them by their start', async () => {
    const f = await fixture(
      [{ type: 'dateRange' }, { type: 'dateRange', options: { includeTime: true, timeZone: 'Asia/Tokyo' } }],
      5,
    );
    const [range, timed] = f.fields.map((field) => field.id);
    await f.write(range!, [
      { start: day(-10), end: day(-5) },
      { start: day(-2), end: day(2) },
      { start: day(1), end: day(3) },
      { start: day(20), end: day(40) },
      null,
    ]);
    const cases: Array<[string, unknown, string[]]> = [
      ['containsDate', { mode: 'today' }, ['R1']],
      ['containsDate', { mode: 'exactDate', date: day(-5) }, ['R0']],
      ['overlaps', { mode: 'nextWeek' }, ['R1', 'R2']],
      ['overlaps', { mode: 'pastDays', days: 7 }, ['R0', 'R1']],
      ['isWithin', { mode: 'nextWeek' }, ['R2']],
      ['isWithin', { mode: 'pastMonth' }, ['R0']],
      ['is', { mode: 'exactDate', date: day(1) }, ['R2']],
      ['isNot', { mode: 'exactDate', date: day(1) }, ['R0', 'R1', 'R3', 'R4']],
      ['isBefore', { mode: 'today' }, ['R0', 'R1']],
      ['isOnOrAfter', { mode: 'tomorrow' }, ['R2', 'R3']],
      ['isEmpty', undefined, ['R4']],
      ['isNotEmpty', undefined, ['R0', 'R1', 'R2', 'R3']],
    ];
    for (const [operator, value, names] of cases)
      expect(await filtered(f, range!, operator, value), operator).toEqual(names);
    // 23:30 on the 27th in UTC is already the 28th in Tokyo, the field's zone, and 10:00 on the
    // 27th in UTC is still the 27th there.
    await f.write(timed!, [
      { start: '2026-09-27T23:30:00Z', end: '2026-09-28T01:00:00Z' },
      { start: '2026-09-26T00:00:00Z', end: '2026-09-27T10:00:00Z' },
    ]);
    expect(await filtered(f, timed!, 'containsDate', { mode: 'exactDate', date: '2026-09-28' })).toEqual([
      'R0',
    ]);
    expect(await filtered(f, timed!, 'containsDate', { mode: 'exactDate', date: '2026-09-27' })).toEqual([
      'R1',
    ]);
    expect(await filtered(f, timed!, 'is', { mode: 'exactDate', date: '2026-09-28' })).toEqual(['R0']);
    expect(await filtered(f, timed!, 'is', { mode: 'exactDate', date: '2026-09-26' })).toEqual(['R1']);
    await f.view({ filter: null, sorts: [{ fieldId: range, direction: 'desc' }] });
    expect(await f.names()).toEqual(['R3', 'R2', 'R1', 'R0', 'R4']);
    await f.view({ sorts: [{ fieldId: range, direction: 'asc' }] });
    expect(await f.names()).toEqual(['R0', 'R1', 'R2', 'R3', 'R4']);
  });

  it('filters JSON by its text, locations by distance, and signatures by whether they’re there', async () => {
    const f = await fixture([{ type: 'json' }, { type: 'location' }, { type: 'signature' }], 4);
    const [json, place, signature] = f.fields.map((field) => field.id);
    await f.write(json!, ['{"city":"Paris"}', '["Lyon"]', '42', null]);
    expect(await filtered(f, json!, 'contains', 'paris')).toEqual(['R0']);
    expect(await filtered(f, json!, 'doesNotContain', 'paris')).toEqual(['R1', 'R2', 'R3']);
    expect(await filtered(f, json!, 'isEmpty')).toEqual(['R3']);
    await f.write(place!, [
      { lat: 48.8566, lng: 2.3522, label: 'Paris' },
      { lat: 45.764, lng: 4.8357, label: 'Lyon' },
      { lat: 51.5072, lng: -0.1276 },
      null,
    ]);
    // Lyon is about 390 km from Paris, and London about 344 km.
    expect(await filtered(f, place!, 'isWithin', { lat: 48.8566, lng: 2.3522, km: 1 })).toEqual(['R0']);
    expect(await filtered(f, place!, 'isWithin', { lat: 48.8566, lng: 2.3522, km: 350 })).toEqual([
      'R0',
      'R2',
    ]);
    expect(await filtered(f, place!, 'isWithin', { lat: 48.8566, lng: 2.3522, km: 400 })).toEqual([
      'R0',
      'R1',
      'R2',
    ]);
    expect(await filtered(f, place!, 'isEmpty')).toEqual(['R3']);
    // Signed one after the other, so the later one sorts first when newest comes first.
    await f.write(signature!, [{ drawing, name: null }]);
    await f.command({
      kind: 'record.update',
      tableId: f.tableId,
      records: [{ id: f.records[2]!, values: { [signature!]: { name: 'Ada' } } }],
    });
    expect(await filtered(f, signature!, 'isNotEmpty')).toEqual(['R0', 'R2']);
    expect(await filtered(f, signature!, 'isEmpty')).toEqual(['R1', 'R3']);
    await f.view({ filter: null, sorts: [{ fieldId: place, direction: 'asc' }] });
    // By label, or by coordinates when there's none.
    expect(await f.names()).toEqual(['R2', 'R1', 'R0', 'R3']);
    await f.write(json!, ['"b"', '"a"', '"c"', null]);
    await f.view({ sorts: [{ fieldId: json, direction: 'asc' }] });
    expect(await f.names()).toEqual(['R1', 'R0', 'R2', 'R3']);
    await f.view({ sorts: [{ fieldId: signature, direction: 'desc' }] });
    expect(await f.names()).toEqual(['R2', 'R0', 'R1', 'R3']);
  });

  it('converts date ranges to and from text and dates, and keeps ranges when times are switched on', async () => {
    await conversion(
      { type: 'text' },
      { type: 'dateRange' },
      ['2026-09-27/2026-09-30', '9/27/2026 - 10/2/2026', '2026-09-27', 'Sep 30 to Sep 27', 'soon'],
      [
        { start: '2026-09-27', end: '2026-09-30' },
        { start: '2026-09-27', end: '2026-10-02' },
        { start: '2026-09-27', end: '2026-09-27' },
        null,
        null,
      ],
    );
    await conversion(
      { type: 'dateRange' },
      { type: 'text' },
      [{ start: '2026-09-27', end: '2026-09-30' }, { start: '2026-09-27', end: '2026-09-27' }, null],
      ['2026-09-27 – 2026-09-30', '2026-09-27', null],
    );
    await conversion(
      { type: 'dateRange' },
      { type: 'date' },
      [{ start: '2026-09-27', end: '2026-09-30' }, null],
      ['2026-09-27', null],
    );
    await conversion(
      { type: 'date', options: { includeTime: true } },
      { type: 'dateRange', options: { includeTime: true } },
      ['2026-09-27T09:30:00.000Z', null],
      [{ start: '2026-09-27T09:30:00.000Z', end: '2026-09-27T09:30:00.000Z' }, null],
    );
    const f = await fixture([{ type: 'dateRange', options: { timeZone: 'America/New_York' } }]);
    const fieldId = f.fields[0]!.id;
    await f.write(fieldId, [{ start: '2026-09-27', end: '2026-09-30' }]);
    await f.command({
      kind: 'field.update',
      fieldId,
      options: { includeTime: true, timeZone: 'America/New_York' },
    });
    expect((await f.values(fieldId))[0]).toEqual({
      start: '2026-09-27T04:00:00.000Z',
      end: '2026-09-30T04:00:00.000Z',
    });
  });

  it('converts JSON and locations to and from text, and refuses conversions that make no sense', async () => {
    await conversion(
      { type: 'text' },
      { type: 'json' },
      ['{"a": 1}', 'plain words', '12', null],
      ['{"a":1}', '"plain words"', '12', null],
    );
    await conversion({ type: 'number' }, { type: 'json' }, [1.5, null], ['1.5', null]);
    await conversion({ type: 'json' }, { type: 'longText' }, ['{"a":[1,2]}', null], ['{"a":[1,2]}', null]);
    await conversion(
      { type: 'text' },
      { type: 'location' },
      ['40.7128, -74.006', 'Paris (48.8566, 2.3522)', 'Paris', '95, 10'],
      [
        { lat: 40.7128, lng: -74.006, label: null },
        { lat: 48.8566, lng: 2.3522, label: 'Paris' },
        null,
        null,
      ],
    );
    await conversion(
      { type: 'location' },
      { type: 'text' },
      [
        { lat: 48.8566, lng: 2.3522, label: 'Paris' },
        { lat: 1, lng: 2 },
      ],
      ['Paris (48.8566, 2.3522)', '1, 2'],
    );
    const { f } = await conversion(
      { type: 'signature' },
      { type: 'text' },
      [{ name: 'Ada' }],
      [expect.any(String) as never],
    );
    expect((await f.values(f.fields[0]!.id))[0]).toMatch(/^Signed by Ada at \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    const refused = await fixture([{ type: 'text' }, { type: 'json' }, { type: 'dateRange' }]);
    for (const [fieldId, to] of [
      [refused.fields[0]!.id, { type: 'signature' }],
      [refused.fields[1]!.id, { type: 'number' }],
      [refused.fields[2]!.id, { type: 'singleSelect' }],
    ] as const) {
      const response = await preview(fieldId, to);
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().error).toMatchObject({ messageKey: 'data.field.cannotConvert' });
      await refused.command({ kind: 'field.convert', fieldId, to }, 'data.field.cannotConvert');
    }
  });

  it('warns that a button keeps no values, and becomes an empty field again', async () => {
    const f = await fixture([{ type: 'text' }]);
    const fieldId = f.fields[0]!.id;
    await f.write(fieldId, ['a', 'b', null]);
    const counts = await preview(fieldId, { type: 'button' });
    expect(counts.json<ConversionPreview>()).toMatchObject({ total: 2, converted: 0, emptied: 2 });
    const command = await f.command({ kind: 'field.convert', fieldId, to: { type: 'button' } });
    expect((await f.page()).rows[0]!.values).not.toHaveProperty(fieldId);
    await f.command({ kind: 'field.convert', fieldId, to: { type: 'text' } });
    expect(await f.values(fieldId)).toEqual([null, null, null]);
    await f.undo(command.groupId);
  });

  it('stores a button’s fields by ID, refuses unknown fields and other schemes, and has nothing to look up', async () => {
    const f = await fixture([{ type: 'text' }]);
    const order = f.fields[0]!.id;
    await f.command({ kind: 'field.update', fieldId: order, name: 'Order ID' });
    const buttonId = newId('field');
    const button = (urlTemplate: string, messageKey?: string, id = newId('field')) =>
      f.command(
        {
          kind: 'field.create',
          tableId: f.tableId,
          field: {
            id,
            name: `Open ${id}`,
            type: 'button',
            options: { action: { kind: 'openUrl', urlTemplate } },
          },
        },
        messageKey,
      );
    await button('https://example.com/orders/{ order id }?by={Name}', undefined, buttonId);
    const schema = await get<{ fields: FieldMeta[] }>(`/api/databases/${f.id}/schema`);
    const saved = schema.fields.find((field) => field.id === buttonId)!;
    expect(saved.options).toEqual({
      label: '',
      action: { kind: 'openUrl', urlTemplate: `https://example.com/orders/{${order}}?by={${f.primary}}` },
    });
    await button('https://example.com/{Missing}', 'data.field.buttonField');
    await button('javascript:alert(1)', 'data.field.buttonLink');
    await button('ftp://example.com/{Name}', 'data.field.buttonLink');
    await button('{Order ID}/path');
    // A lookup through a link to this same table can't read a button, which holds nothing.
    const linkId = newId('field');
    await f.command({
      kind: 'field.create',
      tableId: f.tableId,
      field: { id: linkId, name: 'Related', type: 'link', options: { linkedTableId: f.tableId } },
    });
    await f.command(
      {
        kind: 'field.create',
        tableId: f.tableId,
        field: {
          id: newId('field'),
          name: 'Looked up',
          type: 'lookup',
          options: { linkFieldId: linkId, targetFieldId: buttonId },
        },
      },
      'data.field.buttonTarget',
    );
  });

  it('reads date ranges with START() and END() in SQL, and locations, signatures, and JSON as text or moments', async () => {
    const f = await fixture([
      { type: 'dateRange' },
      { type: 'signature' },
      { type: 'location' },
      { type: 'json' },
    ]);
    const [range, signature, place, json] = f.fields;
    await f.command({
      kind: 'record.update',
      tableId: f.tableId,
      records: [
        {
          id: f.records[0]!,
          values: {
            [range!.id]: { start: '2026-09-27', end: '2026-09-30' },
            [signature!.id]: { name: 'Ada' },
            [place!.id]: { lat: 48.8566, lng: 2.3522, label: 'Paris' },
            [json!.id]: '{"a":1}',
          },
        },
        { id: f.records[1]!, values: { [range!.id]: { start: '2026-01-01', end: '2026-12-31' } } },
      ],
    });
    const formulas = [
      ['Days', `DATETIME_DIFF(END({${range!.name}}),START({${range!.name}}),"days")`, 'number'],
      ['Signed', `IF({${signature!.name}},"yes","no")`, 'text'],
      ['Where', `{${place!.name}}`, 'text'],
      ['Size', `LEN({${json!.name}})`, 'number'],
    ] as const;
    const ids: string[] = [];
    for (const [name, expression] of formulas) {
      const id = newId('field');
      ids.push(id);
      await f.command({
        kind: 'field.create',
        tableId: f.tableId,
        field: { id, name, type: 'formula', options: { expression } },
      });
    }
    const schema = await get<{ fields: FieldMeta[] }>(`/api/databases/${f.id}/schema`);
    const days = schema.fields.find((field) => field.id === ids[0]) as Extract<
      FieldMeta,
      { type: 'formula' }
    >;
    expect(days.options).toMatchObject({ resultType: 'number', sortable: true });
    const rows = (await f.page()).rows;
    expect(ids.map((id) => rows[0]!.values[id])).toEqual([3, 'yes', '48.8566, 2.3522', 7]);
    expect(ids.map((id) => rows[2]!.values[id])).toEqual([null, 'no', null, 0]);
    await f.view({ sorts: [{ fieldId: ids[0], direction: 'desc' }] });
    expect(await f.names()).toEqual(['R1', 'R0', 'R2']);
    expect(await filtered(f, ids[0]!, 'gt', 100)).toEqual(['R1']);
  });
});

describe('downloads and the REST API', () => {
  async function download(viewId: string, format: 'csv' | 'xlsx') {
    const response = await server.app.inject({
      url: `/api/views/${viewId}/export?${new URLSearchParams({ format, timeZone: 'UTC', locale: 'en-US' })}`,
      headers: server.owner.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response;
  }

  async function sample() {
    const f = await fixture(
      [
        { type: 'dateRange' },
        { type: 'json' },
        { type: 'location' },
        { type: 'signature' },
        { type: 'text' },
        {
          type: 'button',
          options: {
            label: 'Track',
            action: { kind: 'openUrl', urlTemplate: 'https://example.com/t/{Field 4}?n=1' },
          },
        },
        { type: 'button', options: { action: { kind: 'openUrl', urlTemplate: '{Field 1}' } } },
      ],
      1,
    );
    const [range, json, place, signature, code] = f.fields.map((field) => field.id);
    await f.command({
      kind: 'record.update',
      tableId: f.tableId,
      records: [
        {
          id: f.records[0]!,
          values: {
            [range!]: { start: '2026-09-27', end: '2026-09-30' },
            [json!]: '"javascript:alert(1)"',
            [place!]: { lat: 40.7128, lng: -74.006, label: 'New York' },
            [signature!]: { drawing, name: 'Ada Lovelace' },
            [code!]: 'A/B 7',
          },
        },
      ],
    });
    // The link can use a field the view hides, since the reader can still see it.
    await f.view({ hiddenFieldIds: [code] });
    return f;
  }

  it('words each type the same way in CSV and Excel, with a button as the link it opens', async () => {
    const f = await sample();
    const csv = (await download(f.viewId, 'csv')).rawPayload.toString('utf8');
    const [header, row] = csv.replace('﻿', '').trim().split('\r\n');
    expect(header).toBe('Name,Field 0,Field 1,Field 2,Field 3,Field 5,Field 6');
    // The signature reads the moment it was signed, in the reader's zone.
    expect(row).toMatch(
      /^R0,"Sep 27, 2026 – Sep 30, 2026","""javascript:alert\(1\)""","40\.7128, -74\.006","Signed by Ada Lovelace at [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s[AP]M",https:\/\/example\.com\/t\/A%2FB%207\?n=1,$/,
    );
    const book = new ExcelJS.Workbook();
    const bytes = (await download(f.viewId, 'xlsx')).rawPayload;
    await book.xlsx.load(bytes as unknown as Parameters<ExcelJS.Workbook['xlsx']['load']>[0]);
    const cells = book.worksheets[0]!.getRow(2).values as unknown[];
    expect(cells.slice(1, 7)).toEqual([
      'R0',
      'Sep 27, 2026 – Sep 30, 2026',
      '"javascript:alert(1)"',
      '40.7128, -74.006',
      expect.stringMatching(/^Signed by Ada Lovelace at /),
      'https://example.com/t/A%2FB%207?n=1',
    ]);
    expect(cells[7]).toBeUndefined();
  });

  it('reads and writes each type through the REST API', async () => {
    const f = await sample();
    const [range, json, place, signature, , track, unsafe] = f.fields;
    const url = `/api/v1/tables/${f.tableId}/records`;
    const headers = { authorization: `Bearer ${token.token}` };
    const read = await server.app.inject({ url: `${url}?shape=airtable`, headers });
    expect(read.statusCode, read.body).toBe(200);
    const fields = read.json<{ records: Array<{ fields: Record<string, unknown> }> }>().records[0]!.fields;
    expect(fields[range!.name]).toEqual({ start: '2026-09-27', end: '2026-09-30' });
    expect(fields[json!.name]).toBe('javascript:alert(1)');
    expect(fields[place!.name]).toEqual({ lat: 40.7128, lng: -74.006, label: 'New York' });
    expect(fields[signature!.name]).toMatchObject({
      drawing,
      name: 'Ada Lovelace',
      signedBy: { id: server.owner.userId },
    });
    expect(fields[track!.name]).toEqual({ label: 'Track', url: 'https://example.com/t/A%2FB%207?n=1' });
    // JSON text that names another scheme never becomes a link.
    expect(fields[unsafe!.name]).toEqual({ label: unsafe!.name, url: null });
    const text = await server.app.inject({
      url: `${url}?shape=airtable&cellFormat=string&locale=en-US`,
      headers,
    });
    const strings = text.json<{ records: Array<{ fields: Record<string, unknown> }> }>().records[0]!.fields;
    expect(strings[place!.name]).toBe('40.7128, -74.006');
    expect(strings[track!.name]).toBe('https://example.com/t/A%2FB%207?n=1');
    const written = await server.app.inject({
      method: 'POST',
      url: `${url}?shape=airtable`,
      headers,
      payload: {
        typecast: true,
        records: [
          {
            fields: {
              [range!.name]: '2026-10-01/2026-10-03',
              [json!.name]: '{"typed": [1, 2]}',
              [place!.name]: 'Paris (48.8566, 2.3522)',
              [signature!.name]: {
                name: 'Grace',
                signedBy: 'usr00000000000000',
                signedAt: '2001-01-01T00:00:00Z',
              },
            },
          },
          {
            fields: {
              [json!.name]: { a: [1, 'two'] },
              [range!.name]: { start: '2026-10-01', end: '2026-10-01' },
            },
          },
        ],
      },
    });
    expect(written.statusCode, written.body).toBe(200);
    const created = written.json<{ records: Array<{ fields: Record<string, unknown> }> }>().records;
    expect(created[0]!.fields).toMatchObject({
      [range!.name]: { start: '2026-10-01', end: '2026-10-03' },
      [json!.name]: { typed: [1, 2] },
      [place!.name]: { lat: 48.8566, lng: 2.3522, label: 'Paris' },
      [signature!.name]: { name: 'Grace', signedBy: { id: server.owner.userId } },
    });
    expect(created[1]!.fields[json!.name]).toEqual({ a: [1, 'two'] });
    const refused = await server.app.inject({
      method: 'POST',
      url,
      headers,
      payload: { records: [{ fields: { [track!.name]: 'https://example.com' } }] },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toMatchObject({ messageKey: 'data.value.button' });
  });
});

describe('public forms', () => {
  it('asks date ranges, JSON, locations, and signatures, never a button, and signs as nobody', async () => {
    const f = await fixture([
      { type: 'dateRange', options: { includeTime: true } },
      { type: 'json' },
      { type: 'location' },
      { type: 'signature' },
      { type: 'button' },
    ]);
    const ids = f.fields.map((field) => field.id);
    const viewId = newId('view');
    await f.command({
      kind: 'view.create',
      view: {
        id: viewId,
        name: 'Form',
        tableId: f.tableId,
        type: 'form',
        config: {
          form: {
            title: 'Sign',
            questions: ids.slice(0, 4).map((fieldId) => ({ fieldId, required: false, label: '', help: '' })),
          },
        },
      },
    });
    const shared = await server.app.inject({
      method: 'PUT',
      url: `/api/views/${viewId}/public-form`,
      headers: server.owner.headers,
    });
    const { formId } = shared.json<PublicFormLink>();
    const form = (await server.app.inject({ url: `/api/public/forms/${formId}` })).json<PublicForm>();
    expect(form.questions.map((question) => [question.type, question.options])).toEqual([
      ['dateRange', { includeTime: true }],
      ['json', {}],
      ['location', {}],
      ['signature', {}],
    ]);
    const submitted = await server.app.inject({
      method: 'POST',
      url: `/api/public/forms/${formId}/submissions`,
      remoteAddress: '203.0.113.77',
      payload: {
        ticket: issueTicket(server.config.secretKey, formId, Date.now() - 3_000),
        values: {
          [ids[0]!]: { start: '2026-09-27T09:00:00.000Z', end: '2026-09-27T10:00:00.000Z' },
          [ids[1]!]: '[1,2]',
          [ids[2]!]: { lat: 1, lng: 2, label: 'Here' },
          [ids[3]!]: { drawing, name: 'Visitor', signedBy: server.owner.userId },
        },
      },
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    const rows = (await f.page()).rows;
    const answer = rows.at(-1)!;
    expect(answer.values[ids[3]!]).toMatchObject({ name: 'Visitor', signedBy: null });
    expect(answer.values[ids[1]!]).toBe('[1,2]');
  });
});

describe('barcode, time, change log, and multi-currency fields', () => {
  it('exports change logs with display names through private and public text reads', async () => {
    const f = await fixture([{ type: 'text' }, { type: 'changeLog' }], 1);
    const secret = f.fields[0]!.id;
    const history = f.fields[1]!.id;
    await f.write(secret, ['Private value']);
    const share = await server.app.inject({
      method: 'PUT',
      url: `/api/views/${f.viewId}/shared-view`,
      headers: server.owner.headers,
    });
    expect(share.statusCode, share.body).toBe(200);
    const settings = await server.app.inject({
      method: 'PATCH',
      url: `/api/views/${f.viewId}/shared-view`,
      headers: server.owner.headers,
      payload: { allowCopy: true, fieldIds: [f.primary, history] },
    });
    expect(settings.statusCode, settings.body).toBe(200);
    const log = (await f.page()).rows[0]!.values[history] as Array<{ at: string }>;
    const timeZone = 'America/New_York';
    const at = new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short', timeZone }).format(
      new Date(log.at(-1)!.at),
    );
    for (const [url, headers, publicRead] of [
      [
        `/api/views/${f.viewId}/export?format=csv&timeZone=${timeZone}&locale=en-US`,
        server.owner.headers,
        false,
      ],
      [`/api/public/views/${share.json().linkId}/download?timeZone=${timeZone}&locale=en-US`, {}, true],
      [
        `/api/v1/tables/${f.tableId}/records?cellFormat=string&timeZone=${timeZone}&locale=en-US`,
        { authorization: `Bearer ${token.token}` },
        false,
      ],
      [
        `/api/v1/tables/${f.tableId}/records?cellFormat=string&timeZone=${timeZone}&locale=en-US&fields=${history}`,
        { authorization: `Bearer ${token.token}` },
        false,
      ],
    ] as const) {
      const response = await server.app.inject({ url, headers });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain(`${at} ${server.owner.info.user.name}: Name`);
      expect(response.body).not.toContain(server.owner.userId);
      expect(response.body).not.toContain('actorId');
      if (publicRead) {
        expect(response.body).not.toContain(secret);
        expect(response.body).not.toContain('Field 0');
      }
    }
  });

  it('reads only requested visible history columns in a bounded batch', async () => {
    const f = await fixture([{ type: 'text' }, { type: 'changeLog' }], 2);
    const history = f.fields[1]!.id;
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/tables/${f.tableId}/records/history`,
      headers: server.owner.headers,
      payload: { ids: [...f.records, newId('record')], fieldIds: [history] },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      response
        .json()
        .map((row: RowData) => row.id)
        .sort(),
    ).toEqual([...f.records].sort());
    for (const row of response.json()) {
      expect(Object.keys(row.values)).toEqual([history]);
      expect(row.values[history]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ actorId: server.owner.userId, fieldIds: [f.primary] }),
        ]),
      );
    }
    const tooMany = await server.app.inject({
      method: 'POST',
      url: `/api/tables/${f.tableId}/records/history`,
      headers: server.owner.headers,
      payload: { ids: Array.from({ length: 501 }, () => newId('record')), fieldIds: [history] },
    });
    expect(tooMany.statusCode).toBe(422);
    const reader = await server.addMember({ name: 'History reader' });
    await grant(server, f.id, reader, 'reader');
    const secret = f.fields[0]!.id;
    await f.write(secret, ['Hidden first', 'Hidden second']);
    const permission = await server.app.inject({
      method: 'PUT',
      url: `/api/fields/${secret}/permissions`,
      headers: server.owner.headers,
      payload: { restricted: { roles: ['owner'], users: [] }, locked: null },
    });
    expect(permission.statusCode, permission.body).toBe(200);
    const rules = await server.app.inject({
      method: 'PUT',
      url: `/api/tables/${f.tableId}/record-rules`,
      headers: server.owner.headers,
      payload: {
        rules: [
          {
            id: newId('recordRule'),
            roles: ['reader'],
            users: [],
            condition: {
              conjunction: 'and',
              conditions: [{ id: 'first', fieldId: f.primary, operator: 'is', value: 'R0' }],
            },
          },
        ],
      },
    });
    expect(rules.statusCode, rules.body).toBe(200);
    const scoped = await server.app.inject({
      method: 'POST',
      url: `/api/tables/${f.tableId}/records/history`,
      headers: reader.headers,
      payload: { ids: f.records, fieldIds: [history, secret, f.primary] },
    });
    expect(scoped.statusCode, scoped.body).toBe(200);
    expect(scoped.json()).toHaveLength(1);
    expect(scoped.json()[0].id).toBe(f.records[0]);
    expect(Object.keys(scoped.json()[0].values)).toEqual([history]);
    expect(scoped.body).not.toContain(secret);
    const hidden = await server.app.inject({
      method: 'PUT',
      url: `/api/fields/${history}/permissions`,
      headers: server.owner.headers,
      payload: { restricted: { roles: ['owner'], users: [] }, locked: null },
    });
    expect(hidden.statusCode, hidden.body).toBe(200);
    const excluded = await server.app.inject({
      method: 'POST',
      url: `/api/tables/${f.tableId}/records/history`,
      headers: reader.headers,
      payload: { ids: f.records, fieldIds: [history] },
    });
    expect(excluded.statusCode, excluded.body).toBe(200);
    expect(excluded.json()).toEqual([]);
  });

  it('groups currency objects by code and numeric amount with empty cells last', async () => {
    const f = await fixture([{ type: 'multiCurrency' }], 5);
    const money = f.fields[0]!.id;
    await f.write(money, [
      { code: 'USD', amount: 10 },
      { code: 'USD', amount: 2 },
      { code: 'EUR', amount: 100 },
      { code: 'USD', amount: 2 },
      null,
    ]);
    for (const direction of ['asc', 'desc'] as const) {
      await f.view({ groups: [{ fieldId: money, direction }] });
      const ordered = [
        { code: 'EUR', amount: 100 },
        { code: 'USD', amount: 2 },
        { code: 'USD', amount: 10 },
      ];
      const page = await f.page();
      expect(page.groups!.map((group) => group.values[money])).toEqual([
        ...(direction === 'asc' ? ordered : ordered.reverse()),
        null,
      ]);
      expect(page.groups!.find((group) => group.count === 2)?.values[money]).toEqual({
        code: 'USD',
        amount: 2,
      });
    }
  });

  it('preserves the source currency when converting amounts to multi-currency', async () => {
    await conversion(
      { type: 'currency', options: { code: 'EUR' } },
      { type: 'multiCurrency' },
      [12.5, -2, 0, null],
      [{ code: 'EUR', amount: 12.5 }, { code: 'EUR', amount: -2 }, { code: 'EUR', amount: 0 }, null],
    );
    await conversion(
      { type: 'number' },
      { type: 'multiCurrency', options: { code: 'GBP' } },
      [12.5],
      [{ code: 'GBP', amount: 12.5 }],
    );
  });

  it('reads change log columns through the SQL editor query role', async () => {
    const f = await fixture([{ type: 'changeLog' }], 1);
    const settings = await server.app.inject({
      method: 'PUT',
      url: `/api/databases/${f.id}/sql/settings`,
      headers: server.owner.headers,
      payload: { roles: ['owner'], timeoutMs: 15000, rowCap: 10000 },
    });
    expect(settings.statusCode, settings.body).toBe(200);
    for (const source of ['SELECT "Field 0" FROM "Table"', 'SELECT * FROM "Table"']) {
      const result = await server.app.inject({
        method: 'POST',
        url: `/api/databases/${f.id}/sql/run`,
        headers: server.owner.headers,
        payload: { id: crypto.randomUUID(), query: source },
      });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().rows).toHaveLength(1);
      expect(result.json().rows[0][result.json().columns.indexOf('Field 0')]).toBeNull();
    }
  });

  it('reads a lookup and a rollup of a change log through the SQL editor query role', async () => {
    const f = await fixture([{ type: 'changeLog' }], 2);
    const history = f.fields[0]!.id;
    const link = newId('field');
    const lookup = newId('field');
    const joined = newId('field');
    const deeper = newId('field');
    for (const field of [
      { id: link, name: 'Related', type: 'link', options: { linkedTableId: f.tableId } },
      {
        id: lookup,
        name: 'Related changes',
        type: 'lookup',
        // Sorting by the change log reads it as a condition field, another way history reaches SQL.
        options: {
          linkFieldId: link,
          targetFieldId: history,
          sort: [{ fieldId: history, direction: 'asc' }],
        },
      },
      {
        id: joined,
        name: 'Related changes joined',
        type: 'rollup',
        options: { linkFieldId: link, targetFieldId: history, fn: 'concatenate' },
      },
    ])
      await f.command({ kind: 'field.create', tableId: f.tableId, field });
    // A rollup of the lookup reads the same change log one level further down.
    await f.command({
      kind: 'field.create',
      tableId: f.tableId,
      field: {
        id: deeper,
        name: 'Related changes again',
        type: 'rollup',
        options: { linkFieldId: link, targetFieldId: lookup, fn: 'concatenate' },
      },
    });
    await f.command({
      kind: 'record.update',
      tableId: f.tableId,
      records: [{ id: f.records[0]!, values: { [link]: [f.records[1]!] } }],
    });
    // The linked record has history of its own, so a query that read it would fail.
    const values = await f.values(history);
    expect(values[0]).not.toEqual([]);
    expect(values[1]).not.toEqual([]);
    // The grid still reads that history, so only SQL is empty.
    expect((await f.values(lookup))[0]).not.toEqual([]);
    const settings = await server.app.inject({
      method: 'PUT',
      url: `/api/databases/${f.id}/sql/settings`,
      headers: server.owner.headers,
      payload: { roles: ['owner'], timeoutMs: 15000, rowCap: 10000 },
    });
    expect(settings.statusCode, settings.body).toBe(200);
    const result = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${f.id}/sql/run`,
      headers: server.owner.headers,
      payload: { id: crypto.randomUUID(), query: 'SELECT * FROM "Table" ORDER BY "Name"' },
    });
    expect(result.statusCode, result.body).toBe(200);
    const { columns, rows } = result.json<{ columns: string[]; rows: unknown[][] }>();
    expect(rows).toHaveLength(2);
    const shown = (name: string) => rows[0]![columns.indexOf(name)];
    expect(shown('Field 0')).toBeNull();
    expect(shown('Related changes')).toEqual([]);
    expect(shown('Related changes joined')).toBe('');
    expect(shown('Related changes again')).toBe('');
  });

  it('reads stored values and scoped history, filters, sorts, summarizes, and undoes edits', async () => {
    const f = await fixture([
      { type: 'barcode' },
      { type: 'time' },
      { type: 'multiCurrency' },
      { type: 'changeLog' },
    ]);
    const [barcode, time, money, history] = f.fields.map((field) => field.id) as [
      string,
      string,
      string,
      string,
    ];
    await f.write(barcode, ['00012', '00002', null]);
    await f.write(time, ['14:30', '00:05', '23:59:59']);
    const edit = await f.write(money, [
      { amount: 10, code: 'USD' },
      { amount: 5, code: 'EUR' },
      { amount: 2, code: 'USD' },
    ]);
    expect(await f.values(time)).toEqual(['14:30:00', '00:05:00', '23:59:59']);
    expect((await f.values(history))[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldIds: expect.arrayContaining([money]),
          actorId: server.owner.userId,
          at: expect.any(String),
        }),
      ]),
    );
    await f.write(history, ['forged'], 'data.value.computed');
    expect(await filtered(f, money, 'contains', 'USD')).toEqual(['R0', 'R2']);
    expect(await filtered(f, time, 'isBefore', '14:45:00')).toEqual(['R0', 'R1']);
    await f.view({
      filter: { conjunction: 'and', conditions: [] },
      sorts: [{ fieldId: time, direction: 'asc' }],
      summaries: { [money]: 'sum', [time]: 'earliest' },
    });
    expect(await f.names()).toEqual(['R1', 'R0', 'R2']);
    const summary = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${f.id}/views/${f.viewId}/aggregate`,
      headers: server.owner.headers,
      payload: { timeZone: 'UTC', summary: true },
    });
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json()).toMatchObject({
      values: { [money]: { currencies: { USD: 12, EUR: 5 } }, [time]: { value: '00:05:00' } },
    });
    await f.view({ groups: [{ fieldId: barcode, direction: 'asc' }] });
    const groups = (await f.page()).groups!;
    expect(groups.find((group) => group.values[barcode] === '00012')?.summaries[money]).toMatchObject({
      currencies: { USD: 10 },
    });
    await f.view({ groups: [] });
    await f.undo(edit.groupId);
    expect(await f.values(money)).toEqual([null, null, null]);
  });

  it('sorts currency codes and numeric amounts with empty cells last in both directions', async () => {
    const f = await fixture([{ type: 'multiCurrency' }], 4);
    const money = f.fields[0]!.id;
    await f.write(money, [
      { code: 'USD', amount: 2 },
      { code: 'USD', amount: 10 },
      { code: 'EUR', amount: 100 },
      null,
    ]);
    await f.view({ sorts: [{ fieldId: money, direction: 'asc' }] });
    expect(await f.names()).toEqual(['R2', 'R0', 'R1', 'R3']);
    await f.view({ sorts: [{ fieldId: money, direction: 'desc' }] });
    expect(await f.names()).toEqual(['R1', 'R0', 'R2', 'R3']);
  });

  it('converts portable text and uses the new values in formulas', async () => {
    await conversion({ type: 'text' }, { type: 'time' }, ['2:30 PM', 'invalid'], ['14:30:00', null]);
    await conversion(
      { type: 'text' },
      { type: 'multiCurrency' },
      ['EUR 12.5', 'invalid'],
      [{ code: 'EUR', amount: 12.5 }, null],
    );
    const f = await fixture([{ type: 'multiCurrency' }, { type: 'barcode' }], 1);
    const money = f.fields[0]!.id;
    await f.write(money, [{ code: 'USD', amount: 8 }]);
    const formula = newId('field');
    await f.command({
      kind: 'field.create',
      tableId: f.tableId,
      field: {
        id: formula,
        name: 'Description',
        type: 'formula',
        options: { expression: `{${money}} & " total"` },
      },
    });
    expect(await f.values(formula)).toEqual(['USD 8 total']);
  });
});

it('hides inaccessible field names from a change log and refuses reader action runs', async () => {
  const automationId = newId('automation');
  const f = await fixture(
    [
      { type: 'text' },
      { type: 'changeLog' },
      { type: 'button', options: { action: { kind: 'runAutomation', automationId } } },
    ],
    1,
  );
  await f.command({
    kind: 'automation.create',
    automation: {
      id: automationId,
      name: 'Read guarded',
      config: {
        trigger: { kind: 'recordCreated', tableId: f.tableId },
        steps: [
          {
            id: 'rename',
            kind: 'updateRecord',
            tableId: f.tableId,
            record: 'trigger',
            values: { [f.primary]: 'Changed' },
          },
        ],
      },
    },
  });
  await f.command({ kind: 'automation.update', automationId, enabled: true });
  const secret = f.fields[0]!.id;
  const log = f.fields[1]!.id;
  await f.write(secret, ['private']);
  const reader = await server.addMember({ name: 'History reader' });
  await grant(server, f.id, reader, 'reader');
  const permissions = await server.app.inject({
    method: 'PUT',
    url: `/api/fields/${secret}/permissions`,
    headers: server.owner.headers,
    payload: { restricted: { roles: ['creator'], users: [] }, locked: null },
  });
  expect(permissions.statusCode, permissions.body).toBe(200);
  const rows = await server.app.inject({
    url: `/api/views/${f.viewId}/rows?refresh=1`,
    headers: reader.headers,
  });
  expect(rows.statusCode, rows.body).toBe(200);
  expect(JSON.stringify(rows.json<RowsPage>().rows[0]!.values[log])).not.toContain(secret);
  const shared = await server.app.inject({
    method: 'PUT',
    url: `/api/views/${f.viewId}/shared-view`,
    headers: server.owner.headers,
  });
  expect(shared.statusCode, shared.body).toBe(200);
  const publicRows = await server.app.inject({
    url: `/api/public/views/${shared.json().linkId}/rows`,
    remoteAddress: '203.0.113.79',
  });
  expect(publicRows.statusCode, publicRows.body).toBe(200);
  expect(publicRows.body).not.toContain('Field 0');
  expect(publicRows.body).not.toContain(secret);
  expect(publicRows.body).not.toContain('private');

  const denied = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${f.id}/commands`,
    headers: reader.headers,
    payload: {
      clientId,
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'button.run',
          fieldId: f.fields[2]!.id,
          recordId: f.records[0],
        },
      ],
    },
  });
  expect(denied.json<CommandBatchResult>().results[0]).toMatchObject({
    status: 'rejected',
    error: { messageKey: 'data.access.denied' },
  });
});

it('queues an automation button once, audits the request, and cancels it with undo', async () => {
  const automationId = newId('automation');
  const f = await fixture(
    [{ type: 'button', options: { action: { kind: 'runAutomation', automationId } } }],
    1,
  );
  await f.command({
    kind: 'automation.create',
    automation: {
      id: automationId,
      name: 'Rename',
      config: {
        trigger: { kind: 'recordCreated', tableId: f.tableId },
        steps: [
          {
            id: 'rename',
            kind: 'updateRecord',
            tableId: f.tableId,
            record: 'trigger',
            values: { [f.primary]: 'Renamed' },
          },
        ],
      },
    },
  });
  await f.command({ kind: 'automation.update', automationId, enabled: true });
  const command = await f.command({ kind: 'button.run', fieldId: f.fields[0]!.id, recordId: f.records[0] });
  const replay = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${f.id}/commands`,
    headers: server.owner.headers,
    payload: { clientId, commands: [command] },
  });
  expect(replay.statusCode, replay.body).toBe(200);
  const runs = await get<{ runs: Array<{ state: string }> }>(`/api/automations/${automationId}/runs`);
  expect(runs.runs).toHaveLength(1);
  expect(runs.runs[0]!.state).toBe('queued');
  await f.undo(command.groupId);
  expect(
    (await get<{ runs: Array<{ state: string }> }>(`/api/automations/${automationId}/runs`)).runs[0]!.state,
  ).toBe('canceled');
});

it('accepts the editable types in public forms and preserves them through the API and downloads', async () => {
  const f = await fixture(
    [{ type: 'barcode' }, { type: 'time', options: { timeFormat: '24h' } }, { type: 'multiCurrency' }],
    0,
  );
  const [barcode, time, money] = f.fields.map((field) => field.id) as [string, string, string];
  const viewId = newId('view');
  await f.command({
    kind: 'view.create',
    view: {
      id: viewId,
      name: 'Entry',
      tableId: f.tableId,
      type: 'form',
      config: {
        form: {
          title: 'Entry',
          questions: f.fields.map((field) => ({ fieldId: field.id, required: true, label: '', help: '' })),
        },
      },
    },
  });
  const shared = await server.app.inject({
    method: 'PUT',
    url: `/api/views/${viewId}/public-form`,
    headers: server.owner.headers,
  });
  expect(shared.statusCode, shared.body).toBe(200);
  const { formId } = shared.json<PublicFormLink>();
  const form = (await server.app.inject({ url: `/api/public/forms/${formId}` })).json<PublicForm>();
  expect(form.questions.map((question) => question.type)).toEqual(['barcode', 'time', 'multiCurrency']);
  const values = { [barcode]: '000123', [time]: '14:30:00', [money]: { amount: 12.5, code: 'EUR' } };
  const submitted = await server.app.inject({
    method: 'POST',
    url: `/api/public/forms/${formId}/submissions`,
    remoteAddress: '203.0.113.78',
    payload: {
      ticket: issueTicket(server.config.secretKey, formId, Date.now() - 3_000),
      values,
    },
  });
  expect(submitted.statusCode, submitted.body).toBe(200);
  expect((await f.page()).rows[0]!.values).toMatchObject(values);
  const url = `/api/v1/tables/${f.tableId}/records?shape=airtable`;
  const headers = { authorization: `Bearer ${token.token}` };
  const read = await server.app.inject({ url, headers });
  expect(read.statusCode, read.body).toBe(200);
  expect(read.json().records[0].fields).toMatchObject({
    'Field 0': '000123',
    'Field 1': '14:30:00',
    'Field 2': { amount: 12.5, code: 'EUR' },
  });
  const write = await server.app.inject({
    method: 'POST',
    url,
    headers,
    payload: {
      typecast: true,
      records: [{ fields: { 'Field 0': '000456', 'Field 1': '3:45 PM', 'Field 2': '20.5' } }],
    },
  });
  expect(write.statusCode, write.body).toBe(200);
  expect((await f.page()).rows[1]!.values).toMatchObject({
    [barcode]: '000456',
    [time]: '15:45:00',
    [money]: { code: 'USD', amount: 20.5 },
  });
  const exported = await server.app.inject({
    url: `/api/views/${f.viewId}/export?format=csv&timeZone=UTC&locale=en-US`,
    headers: server.owner.headers,
  });
  expect(exported.statusCode, exported.body).toBe(200);
  expect(exported.rawPayload.toString('utf8')).toContain('000123,14:30:00,EUR 12.5');
});

it('preserves public display options, default currencies, and numeric amount filters', async () => {
  const f = await fixture(
    [
      { type: 'time', options: { timeFormat: '24h' } },
      { type: 'multiCurrency', options: { code: 'EUR', precision: 3, allowNegative: false } },
    ],
    2,
  );
  const [clock, money] = f.fields.map((field) => field.id) as [string, string];
  await f.write(money, [
    { code: 'EUR', amount: 8 },
    { code: 'USD', amount: 20 },
  ]);
  expect(await filtered(f, money, 'gt', 10)).toEqual(['R1']);
  await f.view({ filter: null });
  const shared = await server.app.inject({
    method: 'PUT',
    url: `/api/views/${f.viewId}/shared-view`,
    headers: server.owner.headers,
  });
  expect(shared.statusCode, shared.body).toBe(200);
  const result = await server.app.inject({ url: `/api/public/views/${shared.json().linkId}` });
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().fields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: clock, options: { timeFormat: '24h' } }),
      expect.objectContaining({ id: money, options: { code: 'EUR', precision: 3, allowNegative: false } }),
    ]),
  );
  await conversion(
    { type: 'number' },
    { type: 'multiCurrency', options: { code: 'EUR' } },
    [12.5, 10.005],
    [
      { code: 'EUR', amount: 12.5 },
      { code: 'EUR', amount: 10.01 },
    ],
  );
  await conversion(
    { type: 'currency' },
    { type: 'multiCurrency', options: { code: 'EUR' } },
    [12.5],
    [{ code: 'USD', amount: 12.5 }],
  );
  await conversion(
    { type: 'text' },
    { type: 'multiCurrency', options: { code: 'EUR' } },
    ['12.50'],
    [{ code: 'EUR', amount: 12.5 }],
  );
});

it('checks a real automation button against role, run identity, trigger, and database', async () => {
  const automationId = newId('automation');
  const f = await fixture(
    [{ type: 'text' }, { type: 'button', options: { action: { kind: 'runAutomation', automationId } } }],
    2,
  );
  const secret = f.fields[0]!.id;
  const button = f.fields[1]!.id;
  await f.write(secret, ['Approved', 'Pending']);
  await f.command({
    kind: 'automation.create',
    automation: {
      id: automationId,
      name: 'Approved only',
      config: {
        trigger: {
          kind: 'recordMatches',
          tableId: f.tableId,
          filter: {
            conjunction: 'and',
            conditions: [{ id: 'approved', fieldId: secret, operator: 'is', value: 'Approved' }],
          },
        },
        steps: [
          {
            id: 'rename',
            kind: 'updateRecord',
            tableId: f.tableId,
            record: 'trigger',
            values: { [f.primary]: 'Renamed' },
          },
        ],
      },
    },
  });
  const click = (recordId = f.records[0]!) => ({ kind: 'button.run', fieldId: button, recordId });
  await f.command(click(), 'errors.notFound');
  await f.command({ kind: 'automation.update', automationId, enabled: true });
  await f.command(click(), 'errors.validationFailed');
  await f.command({
    kind: 'field.update',
    fieldId: button,
    options: { action: { kind: 'runAutomation', automationId, allowConditionalTriggers: true } },
  });
  const creator = await server.addMember({ name: 'Limited creator' });
  const editor = await server.addMember({ name: 'Button editor' });
  await grant(server, f.id, creator, 'creator');
  await grant(server, f.id, editor, 'editor');
  const permissions = await server.app.inject({
    method: 'PUT',
    url: `/api/fields/${secret}/permissions`,
    headers: server.owner.headers,
    payload: { restricted: { roles: ['owner'], users: [] }, locked: null },
  });
  expect(permissions.statusCode, permissions.body).toBe(200);
  for (const person of [creator, editor]) {
    const result = await sendAs(server, person, f.id, [click()]);
    expect(result[0]).toMatchObject({ status: 'rejected', error: { messageKey: 'data.access.denied' } });
  }
  await f.command(click(f.records[1]), 'errors.validationFailed');
  const other = await fixture(
    [
      {
        type: 'button',
        options: { action: { kind: 'runAutomation', automationId, allowConditionalTriggers: true } },
      },
    ],
    1,
  );
  await other.command(
    { kind: 'button.run', fieldId: other.fields[0]!.id, recordId: other.records[0] },
    'errors.notFound',
  );
  server.config.automationsPollMs = 20;
  server.app.ctx.automations!.start();
  try {
    await f.command(click());
    await expect.poll(async () => (await f.names())[0], { timeout: 10000 }).toBe('Renamed');
    expect((await f.names())[1]).toBe('R1');
    const runs = await get<{ runs: Array<{ state: string }> }>(`/api/automations/${automationId}/runs`);
    expect(runs.runs).toEqual([expect.objectContaining({ state: 'succeeded' })]);
  } finally {
    server.app.ctx.automations!.pause();
    server.config.automationsPollMs = 0;
  }
});

it('fails a button run queued as one person once the automation acts as someone else', async () => {
  const automationId = newId('automation');
  const f = await fixture(
    [{ type: 'button', options: { action: { kind: 'runAutomation', automationId } } }],
    1,
  );
  const renaming = (name: string) => ({
    trigger: { kind: 'recordCreated', tableId: f.tableId },
    steps: [
      {
        id: 'rename',
        kind: 'updateRecord',
        tableId: f.tableId,
        record: 'trigger',
        values: { [f.primary]: name },
      },
    ],
  });
  await f.command({
    kind: 'automation.create',
    automation: { id: automationId, name: 'Rename', config: renaming('Owner') },
  });
  await f.command({ kind: 'automation.update', automationId, enabled: true });
  const creator = await server.addMember({ name: 'Button creator' });
  await grant(server, f.id, creator, 'creator');
  // A teammate publishes a change while it's on, so it acts as them, and they press the button.
  await apply(server, creator, f.id, [
    { kind: 'automation.update', automationId, config: renaming('Creator') },
    { kind: 'automation.publish', automationId },
  ]);
  await apply(server, creator, f.id, [
    { kind: 'button.run', fieldId: f.fields[0]!.id, recordId: f.records[0] },
  ]);
  // Before the run starts, the owner publishes a correction, so it acts as the owner again.
  await f.command({ kind: 'automation.update', automationId, config: renaming('Owner again') });
  await f.command({ kind: 'automation.publish', automationId });
  await server.app.ctx.automations!.drain();
  // The teammate's version never runs with the owner's access or under the owner's name.
  expect(await f.names()).toEqual(['R0']);
  const runs = await get<{ runs: Array<{ state: string; version: number; steps: unknown[] }> }>(
    `/api/automations/${automationId}/runs`,
  );
  expect(runs.runs).toEqual([
    expect.objectContaining({
      state: 'failed',
      version: 2,
      steps: [
        expect.objectContaining({ state: 'failed', error: { messageKey: 'automations.runAs.changed' } }),
      ],
    }),
  ]);
});

it('formats currency lookup formulas and rollups without combining currencies', async () => {
  const f = await fixture([{ type: 'multiCurrency' }], 2);
  const money = f.fields[0]!.id;
  await f.write(money, [
    { code: 'USD', amount: 8 },
    { code: 'EUR', amount: 3 },
  ]);
  const link = newId('field');
  const lookup = newId('field');
  const formula = newId('field');
  const joined = newId('field');
  await apply(server, server.owner, f.id, [
    {
      kind: 'field.create',
      tableId: f.tableId,
      field: { id: link, name: 'Related', type: 'link', options: { linkedTableId: f.tableId } },
    },
    {
      kind: 'field.create',
      tableId: f.tableId,
      field: {
        id: lookup,
        name: 'Prices',
        type: 'lookup',
        options: { linkFieldId: link, targetFieldId: money },
      },
    },
    {
      kind: 'field.create',
      tableId: f.tableId,
      field: {
        id: formula,
        name: 'Prices text',
        type: 'formula',
        options: { expression: `ARRAYJOIN({${lookup}}, ", ")` },
      },
    },
    {
      kind: 'field.create',
      tableId: f.tableId,
      field: {
        id: joined,
        name: 'Joined',
        type: 'rollup',
        options: { linkFieldId: link, targetFieldId: money, fn: 'concatenate' },
      },
    },
    {
      kind: 'record.update',
      tableId: f.tableId,
      records: [{ id: f.records[0], values: { [link]: f.records } }],
    },
  ]);
  expect((await f.values(formula))[0]).toBe('USD 8, EUR 3');
  expect((await f.values(joined))[0]).toBe('USD 8, EUR 3');
  const nested = newId('field');
  await f.command({
    kind: 'field.create',
    tableId: f.tableId,
    field: {
      id: nested,
      name: 'Nested prices',
      type: 'rollup',
      options: { linkFieldId: link, targetFieldId: lookup, fn: 'concatenate' },
    },
  });
  expect((await f.values(nested))[0]).toBe('USD 8, EUR 3');
  for (const targetFieldId of [money, lookup])
    for (const fn of ['sum', 'average'])
      await f.command(
        {
          kind: 'field.create',
          tableId: f.tableId,
          field: {
            id: newId('field'),
            name: fn,
            type: 'rollup',
            options: { linkFieldId: link, targetFieldId, fn },
          },
        },
        'errors.validationFailed',
      );
});

it('refuses change log filters, sorts, and groups', async () => {
  const f = await fixture([{ type: 'changeLog' }], 1);
  const fieldId = f.fields[0]!.id;
  for (const config of [
    { sorts: [{ fieldId, direction: 'asc' }] },
    { groups: [{ fieldId, direction: 'asc' }] },
    {
      filter: {
        conjunction: 'and',
        conditions: [{ id: 'history', fieldId, operator: 'contains', value: 'Name' }],
      },
    },
  ])
    await f.command({ kind: 'view.update', viewId: f.viewId, config }, 'errors.validationFailed');
});

it('keeps public site history within the displayed unrestricted fields', async () => {
  const f = await fixture([{ type: 'text' }, { type: 'text' }, { type: 'changeLog' }], 1);
  const [secret, omitted, log] = f.fields.map((field) => field.id) as [string, string, string];
  await f.write(secret, ['private']);
  await f.write(omitted, ['unpublished']);
  const permissions = await server.app.inject({
    method: 'PUT',
    url: `/api/fields/${secret}/permissions`,
    headers: server.owner.headers,
    payload: { restricted: { roles: ['owner'], users: [] }, locked: null },
  });
  expect(permissions.statusCode, permissions.body).toBe(200);
  const interfaceId = newId('interface');
  await f.command({
    kind: 'interface.create',
    interface: {
      id: interfaceId,
      name: 'History site',
      pages: [
        {
          id: 'page01',
          name: 'History',
          blocks: [
            {
              id: 'records01',
              kind: 'records',
              place: { x: 0, y: 0, w: 6, h: 4 },
              source: { tableId: f.tableId, viewId: f.viewId },
              fieldIds: [f.primary, secret, log],
            },
          ],
        },
      ],
    },
  });
  const slug = `history-${interfaceId.toLowerCase()}`;
  const published = await server.app.inject({
    method: 'PUT',
    url: `/api/interfaces/${interfaceId}/site`,
    headers: server.owner.headers,
    payload: {
      slug,
      title: 'History',
      pages: [
        { pageId: 'page01', slug: 'history', title: 'History', description: '', slugFieldId: f.primary },
      ],
      theme: { id: 'palette', scheme: 'house' },
    },
  });
  expect(published.statusCode, published.body).toBe(200);
  const content = await server.app.inject({ url: `/api/public/sites/${slug}/history` });
  expect(content.statusCode, content.body).toBe(200);
  expect(content.body).not.toContain('Field 0');
  expect(content.body).not.toContain('Field 1');
  expect(content.body).not.toContain(secret);
  expect(content.body).not.toContain(omitted);
  expect(content.body).not.toContain(server.owner.userId);
  expect(content.body).toContain('Name');
});

it('requires opt-in and a recorded submission before a form automation button can run', async () => {
  const automationId = newId('automation');
  const f = await fixture(
    [{ type: 'button', options: { action: { kind: 'runAutomation', automationId } } }],
    1,
  );
  const viewId = newId('view');
  await f.command({
    kind: 'view.create',
    view: {
      id: viewId,
      name: 'Submit',
      tableId: f.tableId,
      type: 'form',
      config: { form: { questions: [{ fieldId: f.primary, label: '', help: '', required: false }] } },
    },
  });
  await f.command({
    kind: 'automation.create',
    automation: {
      id: automationId,
      name: 'Submission only',
      config: {
        trigger: { kind: 'formSubmitted', viewId },
        steps: [
          {
            id: 'rename',
            kind: 'updateRecord',
            tableId: f.tableId,
            record: 'trigger',
            values: { [f.primary]: 'Submitted' },
          },
        ],
      },
    },
  });
  await f.command({ kind: 'automation.update', automationId, enabled: true });
  const button = f.fields[0]!.id;
  const click = { kind: 'button.run', fieldId: button, recordId: f.records[0] };
  await f.command(click, 'errors.validationFailed');
  await f.command({
    kind: 'field.update',
    fieldId: button,
    options: { action: { kind: 'runAutomation', automationId, allowConditionalTriggers: true } },
  });
  await f.command(click, 'errors.validationFailed');
  const recordId = newId('record');
  await f.command({
    kind: 'record.create',
    tableId: f.tableId,
    formViewId: viewId,
    records: [{ id: recordId, values: { [f.primary]: 'Submitted record' } }],
  });
  await server.app.ctx.automations!.drain();
  await f.command({ ...click, recordId });
  const runs = await get<{ runs: unknown[] }>(`/api/automations/${automationId}/runs`);
  expect(runs.runs).toHaveLength(2);
});

it('evaluates structured change logs in formulas without scanning history for sorting', async () => {
  const f = await fixture([{ type: 'changeLog' }], 1);
  const formula = newId('field');
  await f.command({
    kind: 'field.create',
    tableId: f.tableId,
    field: {
      id: formula,
      name: 'History data',
      type: 'formula',
      options: { expression: `ARRAYJOIN({${f.fields[0]!.id}})` },
    },
  });
  expect((await f.page()).rows[0]!.values[formula]).toContain('fieldIds');
});
