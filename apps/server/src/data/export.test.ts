import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import ExcelJS from 'exceljs';
import { newId, type CommandBatchResult, type FieldSpec } from '@riosoma/contracts';
import { ident, join, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { LightMyRequestResponse } from 'fastify';
import type { z } from 'zod';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { AccessScope } from './access.js';
import { exportFileName, sheetName } from './export/filename.js';
import { EXPORT_PAGE } from './export/source.js';
import { columnLetter } from './export/xlsx.js';
import { insertRecords } from './physical/records.js';
import { readFixture, saveView } from './snapshots.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'export');
}, 60_000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

/** The reader's own zone, which every download asks for. */
const ZONE = 'America/Los_Angeles';

async function download(
  viewId: string,
  format: 'csv' | 'xlsx' = 'csv',
  options: { headers?: Record<string, string>; timeZone?: string; locale?: string; raw?: string } = {},
): Promise<LightMyRequestResponse> {
  const suffix = options.raw
    ? options.raw
    : new URLSearchParams({
        format,
        timeZone: options.timeZone ?? ZONE,
        locale: options.locale ?? 'en-US',
      }).toString();
  return server.app.inject({
    url: `/api/views/${viewId}/export?${suffix}`,
    headers: options.headers ?? server.owner.headers,
  });
}

/** The file as text, byte-order mark left in place so a test can still see it. */
function text(response: LightMyRequestResponse): string {
  return response.rawPayload.toString('utf8');
}

/** One CSV record back into its fields, which is what the quoting rules promise. */
function cells(record: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < record.length; index++) {
    const char = record[index]!;
    if (quoted) {
      if (char !== '"') field += char;
      else if (record[index + 1] === '"') field += record[++index]!;
      else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      fields.push(field);
      field = '';
    } else field += char;
  }
  return [...fields, field];
}

/** The reader declares a buffer shape of its own; the Node buffer a reply carries is what it reads. */
type WorkbookBytes = Parameters<ExcelJS.Workbook['xlsx']['load']>[0];

async function workbook(response: LightMyRequestResponse): Promise<ExcelJS.Workbook> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(response.rawPayload as unknown as WorkbookBytes);
  return book;
}

async function command(databaseId: string, input: Record<string, unknown>): Promise<void> {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
    },
  });
  expect(response.json<CommandBatchResult>().results[0]?.status, response.body).toBe('applied');
}

it('exports native icon formats over the exported data rows and preserves numeric cells', async () => {
  const read = await readFixture(server, [{ type: 'number' }, { type: 'number' }, { type: 'number' }]);
  const styles = ['arrows', 'flags', 'ratings'];
  const iconSets = read.fields.map((field, index) => ({
    fieldId: field.id,
    style: styles[index],
    thresholds: [-5, 10],
  }));
  await command(read.table.databaseId, { kind: 'view.update', viewId: read.view.id, config: { iconSets } });
  await command(read.table.databaseId, {
    kind: 'record.create',
    tableId: read.table.id,
    records: [-10, -5, 10].map((value) => ({
      id: newId('record'),
      values: Object.fromEntries(read.fields.map((field) => [field.id, value])),
    })),
  });
  const sheet = (await workbook(await download(read.view.id, 'xlsx'))).worksheets[0]!;
  const formats = (
    sheet as ExcelJS.Worksheet & { conditionalFormattings: ExcelJS.ConditionalFormattingOptions[] }
  ).conditionalFormattings;
  expect(formats.map((format) => format.ref)).toEqual(['A2:A4', 'B2:B4', 'C2:C4']);
  expect(formats.map((format) => format.rules[0])).toMatchObject([
    {
      type: 'iconSet',
      iconSet: '3Arrows',
      cfvo: [{ type: 'min' }, { type: 'num', value: -5 }, { type: 'num', value: 10 }],
    },
    { type: 'iconSet', iconSet: '3Flags' },
    {
      type: 'iconSet',
      iconSet: '5Rating',
      cfvo: [
        { type: 'min' },
        { type: 'num', value: -5 },
        { type: 'num', value: -5 },
        { type: 'num', value: 10 },
        { type: 'num', value: 10 },
      ],
    },
  ]);
  expect([2, 3, 4].map((index) => sheet.getRow(index).getCell(1).value)).toEqual([-10, -5, 10]);
});

it('exports icon-formatted durations as Excel days and ratings as numbers', async () => {
  const read = await readFixture(server, [
    { type: 'duration', options: { format: 'h:mm:ss.ss' } },
    { type: 'rating' },
  ]);
  const [duration, rating] = read.fields.map((field) => field.id) as [string, string];
  await command(read.table.databaseId, {
    kind: 'view.update',
    viewId: read.view.id,
    config: {
      iconSets: [
        { fieldId: duration, thresholds: [3600, 7200] },
        { fieldId: rating, thresholds: [2, 4] },
      ],
    },
  });
  await command(read.table.databaseId, {
    kind: 'record.create',
    tableId: read.table.id,
    records: [{ id: newId('record'), values: { [duration]: 3600, [rating]: 4 } }],
  });
  const sheet = (await workbook(await download(read.view.id, 'xlsx'))).worksheets[0]!;
  const elapsed = sheet.getRow(2).getCell(1);
  expect(elapsed.numFmt).toBe('[h]:mm:ss.00');
  expect((elapsed.value as Date).getUTCHours()).toBe(1);
  expect(sheet.getRow(2).getCell(2).value).toBe(4);
  expect(sheet.getRow(2).getCell(2).type).toBe(ExcelJS.ValueType.Number);
  const formats = (
    sheet as ExcelJS.Worksheet & { conditionalFormattings: ExcelJS.ConditionalFormattingOptions[] }
  ).conditionalFormattings;
  expect(formats[0]!.rules[0]).toMatchObject({
    cfvo: [{ type: 'min' }, { type: 'num', value: 1 / 24 }, { type: 'num', value: 1 / 12 }],
  });
});

/** A spreadsheet column letter from a one-based count, for a filter's range. */
function columnOf(count: number): string {
  let letter = '';
  for (let rest = count; rest > 0; rest = Math.floor((rest - 1) / 26))
    letter = `${String.fromCharCode(65 + ((rest - 1) % 26))}${letter}`;
  return letter;
}

// A memory budget only means something against what is still held, so the collector runs first.
setFlagsFromString('--expose_gc');
const collect = runInNewContext('gc') as () => void;

function held(): number {
  collect();
  return process.memoryUsage().heapUsed;
}

const NUMBER = expect.stringMatching(/^[0-9]+$/);
const MOMENT = expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2} [AP]M$/);

describe('downloading a view', () => {
  const choice = { id: newId('choice'), name: 'Selected', color: 'blue' as const };
  const first = { id: newId('choice'), name: 'First', color: 'green' as const };
  const second = { id: newId('choice'), name: 'Second', color: 'red' as const };
  const specs: Array<z.input<typeof FieldSpec>> = [
    { type: 'text' },
    { type: 'longText' },
    { type: 'number', options: { precision: 2 } },
    { type: 'currency', options: { code: 'USD', precision: 2 } },
    { type: 'percent', options: { precision: 1 } },
    { type: 'duration', options: { format: 'h:mm:ss.ss' } },
    { type: 'rating' },
    { type: 'checkbox' },
    { type: 'singleSelect', options: { choices: [choice] } },
    { type: 'multipleSelect', options: { choices: [first, second] } },
    { type: 'date', options: { dateFormat: 'iso' } },
    { type: 'date', options: { includeTime: true, dateFormat: 'iso', timeFormat: '24h' } },
    { type: 'email' },
    { type: 'user' },
    { type: 'createdBy' },
    { type: 'lastModifiedBy' },
    { type: 'createdTime', options: { dateFormat: 'iso' } },
    { type: 'recordId' },
    { type: 'autoNumber' },
    { type: 'formula', options: { expression: '2 + 3', precision: 2 } },
    { type: 'text' },
  ];
  /** What the view shows: the primary field, two moved to the front, then the rest.  One hidden. */
  const shown = [0, 2, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
  const header = shown.map((index) => `Field ${index}`);

  async function fixture() {
    const read = await readFixture(server, specs);
    const field = (index: number) => read.fields[index]!;
    read.view.config.filter = {
      conjunction: 'and',
      conditions: [{ id: 'keep', fieldId: field(2).id, operator: 'gte', value: 2 }],
    };
    read.view.config.sorts = [{ fieldId: field(0).id, direction: 'desc' }];
    read.view.config.hiddenFieldIds = [field(20).id];
    read.view.config.fieldOrder = shown.map((index) => field(index).id);
    await saveView(server, read);
    const [dropped, charlie, bravo] = await insertRecords(
      server.pool,
      server.schemas.data,
      read.table.id,
      read.fields,
      [
        { id: newId('record'), values: { [field(0).id]: 'Alpha', [field(2).id]: 1 } },
        {
          id: newId('record'),
          values: {
            [field(0).id]: 'Charlie',
            [field(1).id]: 'Long\nText',
            [field(2).id]: 3,
            [field(3).id]: 12.5,
            [field(4).id]: 0.25,
            [field(5).id]: 3723.45,
            [field(6).id]: 4,
            [field(7).id]: true,
            [field(8).id]: choice.id,
            [field(9).id]: [first.id, second.id],
            [field(10).id]: '2026-09-27',
            [field(11).id]: '2026-09-27T12:00:00Z',
            [field(12).id]: 'a@example.test',
            [field(13).id]: [server.owner.userId],
            [field(20).id]: 'Never exported',
          },
        },
        { id: newId('record'), values: { [field(0).id]: 'Bravo', [field(2).id]: 2, [field(7).id]: false } },
      ],
      server.owner.userId,
    );
    return { read, dropped: dropped!.id, charlie: charlie!.id, bravo: bravo!.id };
  }

  it('writes a filtered, sorted view with only its visible fields as CSV', async () => {
    const { read, charlie, bravo, dropped } = await fixture();
    const response = await download(read.view.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toContain('attachment;');
    expect(response.headers['cache-control']).toBe('no-store');
    // A streamed file has no length; the mark is what tells Excel the file is UTF-8.
    expect(response.headers['content-length']).toBeUndefined();
    expect(response.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const body = text(response);
    const [head, firstRow, secondRow, tail] = body.split('\r\n');
    expect(tail).toBe('');
    expect(head).toBe(`\uFEFF${header.join(',')}`);
    expect(head).not.toContain('Field 20');
    // The view sorts by name downwards, and its filter leaves the record worth one out.
    expect(cells(firstRow!)).toEqual([
      'Charlie',
      '3.00',
      'Long\nText',
      '$12.50',
      '25.0%',
      '1:02:03.45',
      '4',
      'checked',
      'Selected',
      'First, Second',
      '2026-09-27',
      // Noon UTC is 05:00 in the zone the file was asked for, which is what the reader sees.
      '2026-09-27 05:00',
      'a@example.test',
      'Owner',
      'Owner',
      'Owner',
      MOMENT,
      charlie,
      NUMBER,
      '5.00',
    ]);
    expect(cells(secondRow!)).toEqual([
      'Bravo',
      '2.00',
      ...Array.from({ length: 12 }, () => ''),
      'Owner',
      'Owner',
      MOMENT,
      bravo,
      NUMBER,
      '5.00',
    ]);
    expect(body).not.toContain('Never exported');
    expect(body).not.toContain(dropped);
    expect(body).not.toContain('Alpha');
  });

  it('writes the same view as a workbook of typed cells', async () => {
    const { read, charlie } = await fixture();
    const response = await download(read.view.id, 'xlsx');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    const sheet = (await workbook(response)).worksheets[0]!;
    expect(sheet.name).toBe('Grid');
    expect(sheet.rowCount).toBe(3);
    // The header and frozen field stay in sight, with the scrolling pane starting after both.
    expect(sheet.views[0]).toMatchObject({
      state: 'frozen',
      xSplit: 1,
      ySplit: 1,
      topLeftCell: 'B2',
      activeCell: 'B2',
    });
    expect(sheet.autoFilter).toBe(`A1:${columnOf(header.length)}1`);
    expect(sheet.getRow(1).values).toEqual([undefined, ...header]);
    for (const [index] of header.entries())
      expect(sheet.getRow(1).getCell(index + 1).font).toMatchObject({ bold: true });
    const row = sheet.getRow(2);
    const expected: Array<{ column: number; value: unknown; type: number; format?: string }> = [
      { column: 1, value: 'Charlie', type: ExcelJS.ValueType.String },
      { column: 2, value: 3, type: ExcelJS.ValueType.Number, format: '#,##0.00' },
      { column: 3, value: 'Long\nText', type: ExcelJS.ValueType.String },
      { column: 4, value: 12.5, type: ExcelJS.ValueType.Number, format: '"$"#,##0.00' },
      { column: 5, value: 0.25, type: ExcelJS.ValueType.Number, format: '0.0%' },
      // A duration reads as the text its format asks for, and a rating has no number of its own.
      { column: 6, value: '1:02:03.45', type: ExcelJS.ValueType.String },
      { column: 7, value: '4', type: ExcelJS.ValueType.String },
      { column: 8, value: true, type: ExcelJS.ValueType.Boolean },
      { column: 9, value: 'Selected', type: ExcelJS.ValueType.String },
      { column: 10, value: 'First, Second', type: ExcelJS.ValueType.String },
      { column: 11, value: Date.UTC(2026, 8, 27), type: ExcelJS.ValueType.Date, format: 'yyyy-mm-dd' },
      // A moment is stored as the wall clock the reader sees, so Excel never shifts it again.
      {
        column: 12,
        value: Date.UTC(2026, 8, 27, 5, 0),
        type: ExcelJS.ValueType.Date,
        format: 'yyyy-mm-dd hh:mm',
      },
      { column: 13, value: 'a@example.test', type: ExcelJS.ValueType.String },
      { column: 14, value: 'Owner', type: ExcelJS.ValueType.String },
      { column: 15, value: 'Owner', type: ExcelJS.ValueType.String },
      { column: 16, value: 'Owner', type: ExcelJS.ValueType.String },
      { column: 17, value: 'createdTime', type: ExcelJS.ValueType.Date, format: 'yyyy-mm-dd h:mm AM/PM' },
      { column: 18, value: charlie, type: ExcelJS.ValueType.String },
      { column: 19, value: 'autoNumber', type: ExcelJS.ValueType.String },
      // A formula returning a number is a number, so a spreadsheet can total it.
      { column: 20, value: 5, type: ExcelJS.ValueType.Number, format: '#,##0.00' },
    ];
    for (const cell of expected) {
      const actual = row.getCell(cell.column);
      expect(actual.type, `column ${cell.column}`).toBe(cell.type);
      if (cell.value === 'createdTime') expect((actual.value as Date).getFullYear()).toBeGreaterThan(2020);
      else if (cell.value === 'autoNumber') expect(Number(actual.value)).toBeGreaterThan(0);
      else
        expect(
          actual.value instanceof Date ? actual.value.getTime() : actual.value,
          `column ${cell.column}`,
        ).toBe(cell.value);
      if (cell.format) expect(actual.numFmt, `column ${cell.column}`).toBe(cell.format);
    }
    // A record with only two values leaves the rest of its cells empty rather than blank strings.
    const sparse = sheet.getRow(3);
    expect(sparse.getCell(1).value).toBe('Bravo');
    expect(sparse.getCell(2).value).toBe(2);
    expect(sparse.getCell(8).value).toBe(false);
    expect(sparse.getCell(3).value).toBeNull();
    expect(sparse.getCell(3).type).toBe(ExcelJS.ValueType.Null);
    for (const column of sheet.columns) {
      expect(column.width).toBeGreaterThanOrEqual(10);
      expect(column.width).toBeLessThanOrEqual(60);
    }
  });

  it('names linked records, lookups, rollups, and counts', async () => {
    const read = await readFixture(server, [{ type: 'text' }]);
    const tableId = newId('table');
    const primary = newId('field');
    const amount = newId('field');
    await command(read.table.databaseId, {
      kind: 'table.create',
      table: {
        id: tableId,
        name: 'Targets',
        fields: [
          { id: primary, name: 'Name', type: 'text' },
          { id: amount, name: 'Amount', type: 'number' },
        ],
        view: { id: newId('view'), name: 'Grid' },
      },
    });
    const targetId = newId('record');
    await command(read.table.databaseId, {
      kind: 'record.create',
      tableId,
      records: [{ id: targetId, values: { [primary]: 'Linked name', [amount]: 7 } }],
    });
    const link = newId('field');
    await command(read.table.databaseId, {
      kind: 'field.create',
      tableId: read.table.id,
      field: { id: link, name: 'Link', type: 'link', options: { linkedTableId: tableId } },
    });
    const computed: Array<[string, z.input<typeof FieldSpec>]> = [
      ['Lookup', { type: 'lookup', options: { linkFieldId: link, targetFieldId: primary } }],
      ['Rollup', { type: 'rollup', options: { linkFieldId: link, targetFieldId: amount, fn: 'sum' } }],
      ['Count', { type: 'count', options: { linkFieldId: link } }],
    ];
    for (const [name, spec] of computed)
      await command(read.table.databaseId, {
        kind: 'field.create',
        tableId: read.table.id,
        field: { id: newId('field'), name, ...spec },
      });
    await command(read.table.databaseId, {
      kind: 'record.create',
      tableId: read.table.id,
      records: [{ id: newId('record'), values: { [read.fields[0]!.id]: 'Source', [link]: [targetId] } }],
    });
    const rows = text(await download(read.view.id)).split('\r\n');
    expect(rows[0]).toBe('\uFEFFField 0,Link,Lookup,Rollup,Count');
    expect(rows[1]).toBe('Source,Linked name,Linked name,7,1');
    const sheet = (await workbook(await download(read.view.id, 'xlsx'))).worksheets[0]!;
    const row = sheet.getRow(2);
    expect([2, 3].map((column) => row.getCell(column).value)).toEqual(['Linked name', 'Linked name']);
    expect(row.getCell(4).value).toBe(7);
    expect(row.getCell(4).type).toBe(ExcelJS.ValueType.Number);
    expect(row.getCell(5).value).toBe(1);
    expect(row.getCell(5).numFmt).toBe('#,##0');
  });

  it('keeps a value a spreadsheet would run as a formula as text', async () => {
    const read = await readFixture(server, [{ type: 'text' }, { type: 'longText' }]);
    const dangers = ['=SUM(1)', '+1 555', '-2', '@mention', '\tTab', '\rCarriage', 'safe'];
    await insertRecords(
      server.pool,
      server.schemas.data,
      read.table.id,
      read.fields,
      dangers.map((value) => ({ id: newId('record'), values: { [read.fields[0]!.id]: value } })),
      server.owner.userId,
    );
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'fields')}
      SET name = ${'=Name'} WHERE id = ${read.fields[1]!.id}`,
    );
    const rows = text(await download(read.view.id)).split('\r\n');
    // A field's name is a cell too, so it is guarded the same way.
    expect(rows[0]).toBe("\uFEFFField 0,'=Name");
    expect(rows.slice(1, 7)).toEqual([
      "'=SUM(1),",
      "'+1 555,",
      "'-2,",
      "'@mention,",
      "'\tTab,",
      // A carriage return is also a delimiter, so the guard rides inside the quotes.
      `"'${'\r'}Carriage",`,
    ]);
    expect(rows[7]).toBe('safe,');
    const sheet = (await workbook(await download(read.view.id, 'xlsx'))).worksheets[0]!;
    expect(sheet.getRow(1).getCell(2).value).toBe("'=Name");
    expect(sheet.getRow(1).getCell(2).type).toBe(ExcelJS.ValueType.String);
    expect(sheet.getRow(2).getCell(1).value).toBe("'=SUM(1)");
    expect(sheet.getRow(6).getCell(1).value).toBe("'\tTab");
    expect(sheet.getRow(8).getCell(1).value).toBe('safe');
    for (const number of [2, 3, 4, 5, 6, 7, 8])
      expect(sheet.getRow(number).getCell(1).type).toBe(ExcelJS.ValueType.String);
  });

  it('quotes commas, quotes, and line breaks, and ends every record with a carriage return', async () => {
    const read = await readFixture(server, [{ type: 'text' }, { type: 'text' }]);
    await insertRecords(
      server.pool,
      server.schemas.data,
      read.table.id,
      read.fields,
      [
        { id: newId('record'), values: { [read.fields[0]!.id]: 'a,b', [read.fields[1]!.id]: 'say "hi"' } },
        { id: newId('record'), values: { [read.fields[0]!.id]: 'one\ntwo', [read.fields[1]!.id]: '' } },
      ],
      server.owner.userId,
    );
    const body = text(await download(read.view.id));
    expect(body).toBe(['\uFEFFField 0,Field 1', '"a,b","say ""hi"""', '"one\ntwo",', ''].join('\r\n'));
    // Every record ends with a carriage return and a line feed, including the last one.
    expect(body.match(/\r\n/g)).toHaveLength(3);
  });

  it('sizes columns from what they hold, up to a limit', async () => {
    const read = await readFixture(server, [{ type: 'text' }, { type: 'text' }, { type: 'text' }]);
    await insertRecords(
      server.pool,
      server.schemas.data,
      read.table.id,
      read.fields,
      [
        {
          id: newId('record'),
          values: {
            [read.fields[0]!.id]: 'Wide value',
            [read.fields[1]!.id]: 'x'.repeat(200),
            [read.fields[2]!.id]: 'x',
          },
        },
      ],
      server.owner.userId,
    );
    const sheet = (await workbook(await download(read.view.id, 'xlsx'))).worksheets[0]!;
    // A header's own width, the widest value, and a cap that keeps one column off the screen.
    expect(sheet.columns.map((column) => column.width)).toEqual([12, 60, 10]);
    expect(EXPORT_PAGE).toBe(1000);
    // A view wider than Z columns still gets a filter over all of them.
    expect(columnLetter(26)).toBe('Z');
    expect(columnLetter(27)).toBe('AA');
    expect(columnLetter(702)).toBe('ZZ');
  });

  it('downloads a view with nothing in it as a header alone', async () => {
    const read = await readFixture(server, [{ type: 'text' }, { type: 'number' }]);
    expect(text(await download(read.view.id))).toBe('\uFEFFField 0,Field 1\r\n');
    const sheet = (await workbook(await download(read.view.id, 'xlsx'))).worksheets[0]!;
    expect(sheet.actualRowCount).toBe(1);
    expect(sheet.getRow(1).values).toEqual([undefined, 'Field 0', 'Field 1']);
    expect(sheet.autoFilter).toBe('A1:B1');
    expect(sheet.columns.map((column) => column.width)).toEqual([10, 10]);
  });

  it('names files after the table and view, and sheets after Excel’s rules', async () => {
    expect(exportFileName('Tasks', 'Grid', 'csv')).toBe('Tasks - Grid.csv');
    expect(exportFileName('Tasks', 'Grid', 'xlsx')).toBe('Tasks - Grid.xlsx');
    expect(exportFileName('A/B:C*D?E"F<G>H|I\\J', 'Grid', 'csv')).toBe('A B C D E F G H I J - Grid.csv');
    expect(exportFileName('  Spaced  ', 'Grid', 'csv')).toBe('Spaced - Grid.csv');
    expect(exportFileName('Dots...', 'Grid', 'csv')).toBe('Dots - Grid.csv');
    expect(exportFileName('***', '???', 'csv')).toBe('records.csv');
    expect(exportFileName('x'.repeat(200), 'Grid', 'csv')).toBe(`${'x'.repeat(60)} - Grid.csv`);
    expect(sheetName('Q1: [draft] *final*?')).toBe('Q1 draft final');
    expect(sheetName("'quoted'")).toBe('quoted');
    expect(sheetName('y'.repeat(80))).toBe('y'.repeat(31));
    expect(sheetName('???')).toBe('records');

    const read = await readFixture(server, [{ type: 'text' }]);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'tables')} SET name = ${'Задачи/2026'} WHERE id = ${read.table.id}`,
    );
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'views')} SET name = ${'Сетка: черновик'} WHERE id = ${read.view.id}`,
    );
    const csv = await download(read.view.id);
    const excel = await download(read.view.id, 'xlsx');
    // A name in another script rides in the RFC 5987 form; the plain one is an ASCII fallback.
    expect(csv.headers['content-disposition']).toBe(
      'attachment; filename="______ 2026 - _____ ________.csv"; ' +
        `filename*=UTF-8''${encodeURIComponent('Задачи 2026 - Сетка черновик.csv')}`,
    );
    expect(excel.headers['content-disposition']).toContain(
      `filename*=UTF-8''${encodeURIComponent('Задачи 2026 - Сетка черновик.xlsx')}`,
    );
    expect((await workbook(excel)).worksheets[0]!.name).toBe('Сетка черновик');
  });

  it('refuses a download without read access and leaves masked fields and records out', async () => {
    const read = await readFixture(server, [{ type: 'text' }, { type: 'number' }]);
    const [hidden] = await insertRecords(
      server.pool,
      server.schemas.data,
      read.table.id,
      read.fields,
      ['One', 'Two'].map((value, index) => ({
        id: newId('record'),
        values: { [read.fields[0]!.id]: value, [read.fields[1]!.id]: index + 1 },
      })),
      server.owner.userId,
    );
    const member = await server.addMember();
    for (const format of ['csv', 'xlsx'] as const) {
      const denied = await download(read.view.id, format, { headers: member.headers });
      expect(denied.statusCode).toBe(404);
      expect(denied.json()).toMatchObject({ error: { code: 'not_found' } });
    }
    expect((await download(read.view.id, 'csv', { headers: {} })).statusCode).toBe(401);
    vi.spyOn(AccessScope.prototype, 'recordPredicate').mockReturnValue(sql`__id <> ${hidden!.id}`);
    vi.spyOn(AccessScope.prototype, 'visibleFields').mockImplementation((_tableId, fields) =>
      fields.filter((field) => field.id !== read.fields[1]!.id),
    );
    expect(text(await download(read.view.id))).toBe('\uFEFFField 0\r\nTwo\r\n');
    const sheet = (await workbook(await download(read.view.id, 'xlsx'))).worksheets[0]!;
    expect(sheet.getRow(1).values).toEqual([undefined, 'Field 0']);
    expect(sheet.getRow(2).values).toEqual([undefined, 'Two']);
    expect(sheet.actualRowCount).toBe(2);
    expect(sheet.autoFilter).toBe('A1:A1');
  });

  it('refuses a format, language, or zone it cannot honour', async () => {
    const read = await readFixture(server, [{ type: 'text' }]);
    for (const raw of [
      'format=pdf&timeZone=UTC&locale=en-US',
      'format=csv&timeZone=Mars%2FOlympus&locale=en-US',
      'format=csv&timeZone=UTC&locale=%21',
      'format=csv&timeZone=UTC&locale=',
      'timeZone=UTC&locale=en-US',
    ]) {
      const response = await download(read.view.id, 'csv', { raw });
      expect(response.statusCode, `${raw}: ${response.body}`).toBe(422);
    }
    expect((await download(newId('view'))).statusCode).toBe(404);
  });

  it('words numbers and dates in the language and zone the reader asked for', async () => {
    const read = await readFixture(server, [
      { type: 'number', options: { precision: 2 } },
      { type: 'currency', options: { code: 'EUR', precision: 2 } },
      { type: 'date', options: { includeTime: true, dateFormat: 'local', timeFormat: 'local' } },
    ]);
    await insertRecords(
      server.pool,
      server.schemas.data,
      read.table.id,
      read.fields,
      [
        {
          id: newId('record'),
          values: {
            [read.fields[0]!.id]: 1234.5,
            [read.fields[1]!.id]: 12.5,
            [read.fields[2]!.id]: '2026-01-02T23:30:00Z',
          },
        },
      ],
      server.owner.userId,
    );
    const berlin = await download(read.view.id, 'csv', { locale: 'de-DE', timeZone: 'Europe/Berlin' });
    // The space before a currency's symbol is whichever one that language's rules call for.
    expect(cells(text(berlin).split('\r\n')[1]!)).toEqual([
      '1.234,50',
      expect.stringMatching(/^12,50\s€$/),
      '03.01.2026, 00:30',
    ]);
    const sheet = (
      await workbook(await download(read.view.id, 'xlsx', { locale: 'de-DE', timeZone: 'Europe/Berlin' }))
    ).worksheets[0]!;
    expect(sheet.getRow(2).getCell(1).numFmt).toBe('#,##0.00');
    expect(sheet.getRow(2).getCell(2).numFmt).toBe('"€"#,##0.00');
    // The reader's own numeric order and clock, read from the runtime rather than a table.
    expect(sheet.getRow(2).getCell(3).numFmt).toBe('dd.mm.yyyy hh:mm');
    expect(sheet.getRow(2).getCell(3).value).toEqual(new Date(Date.UTC(2026, 0, 3, 0, 30)));
    const utc = (await workbook(await download(read.view.id, 'xlsx', { timeZone: 'UTC' }))).worksheets[0]!;
    expect(utc.getRow(2).getCell(3).numFmt).toBe('m/d/yyyy h:mm AM/PM');
    expect(utc.getRow(2).getCell(3).value).toEqual(new Date(Date.UTC(2026, 0, 2, 23, 30)));
  });

  it('pages a 50,000-record download and stays inside its memory budget', async () => {
    const read = await readFixture(
      server,
      Array.from({ length: 8 }, (_unused, index) =>
        index === 0 ? { type: 'text' as const } : { type: 'number' as const, options: { precision: 2 } },
      ),
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.data, read.table.id)}
      (__id, ${join(
        read.fields.map((field) => sql`${ident(field.columnName)}`),
        ', ',
      )})
      SELECT 'rec' || lpad(n::text, 14, '0'), ${join(
        read.fields.map((_field, index) => sql`n + ${index}`),
        ', ',
      )}
      FROM generate_series(1, 50000) n`,
    );
    await query(server.pool, sql`ANALYZE ${ident(server.schemas.data, read.table.id)}`);
    /**
     * Reads the whole file and checks its shape.  This frame ends before the memory is measured,
     * so what is left is what the download holds, not this test's copy of 50,000 records.
     */
    async function readAll(viewId: string): Promise<void> {
      const response = await download(viewId);
      expect(response.statusCode, response.body.slice(0, 200)).toBe(200);
      const body = text(response);
      // Counted in place: holding 50,000 strings would dwarf what the download itself uses.
      let lines = 0;
      for (let at = body.indexOf('\r\n'); at >= 0; at = body.indexOf('\r\n', at + 2)) lines += 1;
      expect(lines).toBe(50_001);
      expect(
        body.startsWith('\uFEFFField 0,Field 1,Field 2,Field 3,Field 4,Field 5,Field 6,Field 7\r\n'),
      ).toBe(true);
      expect(
        body.endsWith(
          '50000,"50,001.00","50,002.00","50,003.00","50,004.00","50,005.00","50,006.00","50,007.00"\r\n',
        ),
      ).toBe(true);
    }
    const queries = vi.spyOn(server.pool, 'query');
    const before = held();
    const started = performance.now();
    await readAll(read.view.id);
    // Every page is read on its own, so a million records would cost no more memory than this.
    const sizes = queries.mock.calls
      .filter((call) => String(call[0]).includes('__rid = ANY('))
      .map((call) => ((call[1] as unknown[]).find(Array.isArray) as number[]).length);
    // The spy's own record of every row it saw goes before the measuring, too.
    queries.mockRestore();
    queries.mock.calls.length = 0;
    queries.mock.results.length = 0;
    const used = held() - before;
    expect(sizes).toHaveLength(Math.ceil(50_000 / EXPORT_PAGE));
    expect(Math.max(...sizes)).toBe(EXPORT_PAGE);
    // What is still held is the view's row numbers, which the snapshot cache keeps for the next
    // reader: a download that gathered its records first would hold all 50,000 of them instead.
    expect(used).toBeLessThan(8 * 1024 * 1024);
    expect((await workbook(await download(read.view.id, 'xlsx'))).worksheets[0]!.actualRowCount).toBe(50_001);
    console.info(
      `50,000 records: ${(used / 1024 / 1024).toFixed(1)} MiB of heap, ${((performance.now() - started) / 1000).toFixed(1)} s`,
    );
  }, 180_000);
});
