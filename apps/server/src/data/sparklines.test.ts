import { guardViewPatch } from './permissions/config-guard.js';
import { GridConfig } from '@riosoma/contracts';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { DatabaseCreate, newId, Sparkline, sparklineKey, type RowsPage } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { apply, send } from '../scripts/scripts.test-helpers.js';

let kit: TestPostgres, server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'sparklines');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

/** Read a named ZIP member through the central directory, including streamed entries. */
function zipMember(bytes: Buffer, name: string): string {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('Missing ZIP directory');
  let entry = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    const length = bytes.readUInt16LE(entry + 28);
    const member = bytes.toString('utf8', entry + 46, entry + 46 + length);
    if (member === name) {
      const header = bytes.readUInt32LE(entry + 42);
      const start = header + 30 + bytes.readUInt16LE(header + 26) + bytes.readUInt16LE(header + 28);
      const compressed = bytes.subarray(start, start + bytes.readUInt32LE(entry + 20));
      return (bytes.readUInt16LE(entry + 10) === 8 ? inflateRawSync(compressed) : compressed).toString(
        'utf8',
      );
    }
    entry += 46 + length + bytes.readUInt16LE(entry + 30) + bytes.readUInt16LE(entry + 32);
  }
  throw new Error(`Missing ZIP member ${name}`);
}

it('orders scoped lookup and rollup points by links or a linked date, retains values, scales across rows, and writes native XLSX groups', async () => {
  const date = newId('field'),
    amount = newId('field'),
    title = newId('field');
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'History',
    table: {
      id: newId('table'),
      name: 'Points',
      fields: [
        { id: title, name: 'Name', type: 'text' },
        { id: amount, name: 'Amount', type: 'number' },
        { id: date, name: 'Day', type: 'date' },
      ],
      view: { id: newId('view'), name: 'Grid' },
      records: [
        { id: newId('record'), values: { [title]: 'A', [amount]: 8, [date]: '2026-09-03' } },
        { id: newId('record'), values: { [title]: 'B', [amount]: -2, [date]: '2026-09-01' } },
        { id: newId('record'), values: { [title]: 'C', [amount]: 5, [date]: '2026-09-02' } },
      ],
    },
  });
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: input,
  });
  expect(created.statusCode, created.body).toBe(200);
  const table = newId('table'),
    view = newId('view'),
    name = newId('field'),
    link = newId('field'),
    lookup = newId('field'),
    rollup = newId('field'),
    list = newId('field');
  const parent = newId('record'),
    second = newId('record');
  const settings = [
    Sparkline.parse({ fieldId: lookup, first: true, min: true, max: true }),
    Sparkline.parse({
      fieldId: rollup,
      type: 'column',
      sharedAxis: true,
      order: { fieldId: date, direction: 'asc' },
    }),
    Sparkline.parse({ fieldId: list, type: 'winLoss' }),
  ];
  await apply(server, server.owner, input.id, [
    {
      kind: 'record.update',
      tableId: input.table.id,
      records: input.table.records.map((record, index) => ({
        id: record.id,
        values: {
          [title]: ['A', 'B', 'C'][index],
          [amount]: [8, -2, 5][index],
          [date]: ['2026-09-03', '2026-09-01', '2026-09-02'][index],
        },
      })),
    },
    {
      kind: 'table.create',
      table: {
        id: table,
        name: 'Series',
        fields: [
          { id: name, name: 'Name', type: 'text' },
          { id: list, name: 'Numbers', type: 'json' },
        ],
        view: { id: view, name: 'Grid' },
      },
    },
    {
      kind: 'field.create',
      tableId: table,
      field: { id: link, name: 'Points', type: 'link', options: { linkedTableId: input.table.id } },
    },
    ...[
      { id: lookup, type: 'lookup' },
      { id: rollup, type: 'rollup' },
    ].map((field) => ({
      kind: 'field.create',
      tableId: table,
      field: {
        ...field,
        name: field.type,
        options: {
          linkFieldId: link,
          targetFieldId: amount,
          ...(field.type === 'rollup' ? { fn: 'sum' } : {}),
        },
      },
    })),
    {
      kind: 'record.create',
      tableId: table,
      records: [
        {
          id: parent,
          values: { [name]: 'First', [link]: input.table.records.map((row) => row.id), [list]: '[-3,0,4]' },
        },
        { id: second, values: { [name]: 'Second', [link]: [input.table.records[0]!.id], [list]: '[1,2]' } },
      ],
    },
    { kind: 'view.update', viewId: view, config: { sparklines: settings } },
  ]);
  const get = async (path: string) => {
    const response = await server.app.inject({ url: path, headers: server.owner.headers });
    expect(response.statusCode, response.body).toBe(200);
    return response;
  };
  const page = (await get(`/api/views/${view}/rows`)).json<RowsPage>();
  const row = page.rows.find((row) => row?.id === parent)!;
  expect(row.values[lookup]).toEqual([8, -2, 5]);
  expect(row.values[rollup]).toBe(11);
  expect(row.sparklineValues?.[sparklineKey(settings[0]!)]).toEqual([8, -2, 5]);
  expect(row.sparklineValues?.[sparklineKey(settings[1]!)]).toEqual([-2, 5, 8]);
  expect((await get(`/api/views/${view}/ranges?fields=${rollup},${list}`)).json()).toMatchObject({
    ranges: [
      { fieldId: rollup, min: -2, max: 8 },
      { fieldId: list, min: -3, max: 4 },
    ],
  });
  await apply(server, server.owner, input.id, [
    {
      kind: 'record.update',
      tableId: table,
      records: [{ id: parent, values: { [link]: [...input.table.records].reverse().map((row) => row.id) } }],
    },
  ]);
  const reordered = (await get(`/api/views/${view}/rows?refresh=1`))
    .json<RowsPage>()
    .rows.find((row) => row?.id === parent)!;
  expect(reordered.sparklineValues?.[sparklineKey(settings[0]!)]).toEqual([5, -2, 8]);
  const descending = { ...settings[1]!, order: { fieldId: date, direction: 'desc' as const } };
  await apply(server, server.owner, input.id, [
    { kind: 'view.update', viewId: view, config: { sparklines: [settings[0], descending, settings[2]] } },
  ]);
  const record = (await get(`/api/tables/${table}/records/${parent}`)).json();
  expect(record.sparklineValues[sparklineKey(descending)]).toEqual([8, 5, -2]);
  const invalid = await send(server, server.owner, input.id, [
    {
      kind: 'view.update',
      viewId: view,
      config: { sparklines: [{ ...descending, order: { fieldId: name, direction: 'asc' } }] },
    },
  ]);
  expect(invalid[0]?.status).toBe('rejected');
  const response = await get(`/api/views/${view}/export?format=xlsx&locale=en-US&timeZone=UTC`);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(response.rawPayload as unknown as Parameters<ExcelJS.Workbook['xlsx']['load']>[0]);
  expect(book.worksheets[1]!.state).toBe('veryHidden');
  const sheet = zipMember(response.rawPayload, 'xl/worksheets/sheet1.xml');
  const groups = [...sheet.matchAll(/<x14:sparklineGroup\s([^>]+)>([\s\S]*?)<\/x14:sparklineGroup>/g)];
  expect(groups).toHaveLength(3);
  expect(groups.map((group) => /type="([^"]+)"/.exec(group[1]!)![1])).toEqual(['line', 'column', 'stacked']);
  expect(groups[1]![1]).toContain('minAxisType="group"');
  expect(groups[0]![1]).toContain('first="1"');
  expect(groups[0]![2]).toContain('<xm:sqref>D2</xm:sqref>');
  expect(groups[0]![2]).toMatch(/_sparkline_data.*A1:C1/);
  expect(book.worksheets[1]!.getRow(2).values).toEqual([undefined, 8, 5, -2]);
});

it('preserves hidden ordering settings while a visible chart changes', () => {
  const visible = newId('field'),
    secret = newId('field'),
    other = newId('field');
  const before = GridConfig.parse({
    sparklines: [{ fieldId: visible, order: { fieldId: secret, direction: 'asc' } }, { fieldId: other }],
  });
  const changed = { ...before.sparklines[1]!, type: 'column' as const };
  expect(guardViewPatch(new Set([secret]), before, { sparklines: [changed] }).sparklines).toEqual([
    before.sparklines[0],
    changed,
  ]);
  expect(() =>
    guardViewPatch(new Set([secret]), before, { sparklines: [{ ...before.sparklines[0]!, order: null }] }),
  ).toThrow();
});

it('ranges array formulas over numeric lookups, including JavaScript evaluation and filtered rows', async () => {
  const title = newId('field'),
    amount = newId('field');
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Formula history',
    table: {
      id: newId('table'),
      name: 'Points',
      fields: [
        { id: title, name: 'Name', type: 'text' },
        { id: amount, name: 'Amount', type: 'number' },
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
  const pointIds = Array.from({ length: 3 }, () => newId('record'));
  const table = newId('table'),
    view = newId('view'),
    name = newId('field'),
    link = newId('field');
  const lookup = newId('field'),
    formula = newId('field'),
    fallback = newId('field');
  const parent = newId('record');
  await apply(server, server.owner, input.id, [
    {
      kind: 'record.create',
      tableId: input.table.id,
      records: pointIds.map((id, index) => ({
        id,
        values: { [title]: `Point ${index}`, [amount]: [8, -2, 900][index] },
      })),
    },
    {
      kind: 'table.create',
      table: {
        id: table,
        name: 'Series',
        fields: [{ id: name, name: 'Name', type: 'text' }],
        view: { id: view, name: 'Grid' },
      },
    },
    {
      kind: 'field.create',
      tableId: table,
      field: { id: link, name: 'Points', type: 'link', options: { linkedTableId: input.table.id } },
    },
    {
      kind: 'field.create',
      tableId: table,
      field: {
        id: lookup,
        name: 'Values',
        type: 'lookup',
        options: { linkFieldId: link, targetFieldId: amount },
      },
    },
    ...[
      { id: formula, name: 'SQL list', expression: `{${lookup}}` },
      {
        id: fallback,
        name: 'Evaluated list',
        expression: `IF(REGEX_REPLACE({${name}}, "x", "") = "Error", ERROR(), {${lookup}})`,
      },
    ].map(({ id, name, expression }) => ({
      kind: 'field.create',
      tableId: table,
      field: { id, name, type: 'formula', options: { expression, resultType: 'array' } },
    })),
    {
      kind: 'record.create',
      tableId: table,
      records: [
        { id: parent, values: { [name]: 'Keep', [link]: pointIds.slice(0, 2) } },
        { id: newId('record'), values: { [name]: 'Skip', [link]: [pointIds[2]] } },
        { id: newId('record'), values: { [name]: 'Error', [link]: [] } },
        { id: newId('record'), values: { [name]: 'Empty', [link]: [] } },
      ],
    },
    {
      kind: 'view.update',
      viewId: view,
      config: {
        sparklines: [formula, fallback].map((fieldId) => Sparkline.parse({ fieldId, sharedAxis: true })),
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'keep', fieldId: name, operator: 'isNot', value: 'Skip' }],
        },
      },
    },
  ]);
  const rows = await server.app.inject({ url: `/api/views/${view}/rows`, headers: server.owner.headers });
  expect(rows.statusCode, rows.body).toBe(200);
  const row = rows.json<RowsPage>().rows.find((row) => row?.id === parent)!;
  expect(row.values[formula]).toEqual([8, -2]);
  expect(row.values[fallback]).toEqual([8, -2]);
  const ranges = await server.app.inject({
    url: `/api/views/${view}/ranges?fields=${formula},${fallback}`,
    headers: server.owner.headers,
  });
  expect(ranges.statusCode, ranges.body).toBe(200);
  expect(ranges.json()).toEqual({
    ranges: [formula, fallback].map((fieldId) => ({ fieldId, min: -2, max: 8 })),
  });
});
