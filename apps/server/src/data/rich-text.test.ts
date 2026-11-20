import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import {
  checkCellValue,
  DatabaseCreate,
  FieldMeta,
  FormSettings,
  newId,
  type CellValue,
  type CommandBatchResult,
  type DatabaseSchema,
  type KeyedRecords,
  type RowsPage,
  type TokenCreated,
  type ViewSearchResult,
} from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { publicQuestions } from './public-forms.js';
import { publicField } from './shared-view-reads.js';
import type { StoredField } from './types.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'rich_text');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

/** Markdown with every format, and markup that must stay characters. */
const MARKDOWN = [
  '# Plan',
  '**Bold** and _italic_ with [a link](https://example.com)',
  '- [x] Done\n- [ ] <b>not html</b>, as typed',
  '```\ncode\n```',
].join('\n\n');
const PLAIN = 'First line\nSecond line, with "quotes"';

type Result = CommandBatchResult['results'][number];

async function fixture() {
  const ids = {
    database: newId('database'),
    table: newId('table'),
    view: newId('view'),
    name: newId('field'),
    rich: newId('field'),
    plain: newId('field'),
    first: newId('record'),
  };
  const input = DatabaseCreate.parse({
    id: ids.database,
    name: 'Notes',
    table: {
      id: ids.table,
      name: 'Items',
      fields: [
        { id: ids.name, name: 'Name', type: 'text' },
        { id: ids.rich, name: 'Rich', type: 'longText', options: { richText: true } },
        { id: ids.plain, name: 'Plain', type: 'longText' },
      ],
      view: { id: ids.view, name: 'Grid' },
      records: [{ id: ids.first }],
    },
  });
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: input,
  });
  expect(created.statusCode, created.body).toBe(200);
  const command = async (body: Record<string, unknown>): Promise<Result> => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${ids.database}/commands`,
      headers: server.owner.headers,
      payload: {
        clientId: newId('client'),
        commands: [{ id: newId('command'), groupId: newId('action'), ...body }],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<CommandBatchResult>().results[0]!;
    expect(result.status, response.body).toBe('applied');
    return result;
  };
  const write = (values: Record<string, CellValue>) =>
    command({ kind: 'record.update', tableId: ids.table, records: [{ id: ids.first, values }] });
  const values = async () => {
    const response = await server.app.inject({
      url: `/api/views/${ids.view}/rows?refresh=1`,
      headers: server.owner.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<RowsPage>().rows[0]!.values;
  };
  const field = async (id: string) => {
    const response = await server.app.inject({
      url: `/api/databases/${ids.database}/schema`,
      headers: server.owner.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<DatabaseSchema>().fields.find((entry) => entry.id === id)!;
  };
  return { ids, command, write, values, field };
}

describe('rich text in long text fields', () => {
  it('stores Markdown as long text, exactly as written, and plain long text as before', async () => {
    const f = await fixture();
    expect((await f.field(f.ids.rich)).options).toEqual({ richText: true });
    // Fields made before rich text read as plain.
    expect((await f.field(f.ids.plain)).options).toEqual({ richText: false });
    await f.write({ [f.ids.rich]: MARKDOWN.replace(/\n/g, '\r\n'), [f.ids.plain]: PLAIN });
    const stored = await f.values();
    // Line endings settle as they do for any long text; nothing else about the text changes.
    expect(stored[f.ids.rich]).toBe(MARKDOWN);
    expect(stored[f.ids.plain]).toBe(PLAIN);

    const rich = await f.field(f.ids.rich);
    const plain = await f.field(f.ids.plain);
    for (const value of [MARKDOWN, PLAIN, '', '  ', 'x'.repeat(1_000_000)])
      expect(checkCellValue(rich, value)).toEqual(checkCellValue(plain, value));
    expect(checkCellValue(rich, 'x'.repeat(1_000_001))).toEqual({
      ok: false,
      messageKey: 'data.value.tooLong',
    });
    expect(checkCellValue(rich, 5)).toEqual({ ok: false, messageKey: 'data.value.notText' });
  });

  it('turns rich text off and on again without changing a value', async () => {
    const f = await fixture();
    await f.write({ [f.ids.rich]: MARKDOWN, [f.ids.plain]: PLAIN });
    await f.command({ kind: 'field.update', fieldId: f.ids.rich, options: { richText: false } });
    expect((await f.field(f.ids.rich)).options).toEqual({ richText: false });
    expect((await f.values())[f.ids.rich]).toBe(MARKDOWN);
    await f.command({ kind: 'field.update', fieldId: f.ids.plain, options: { richText: true } });
    await f.command({ kind: 'field.update', fieldId: f.ids.rich, options: { richText: true } });
    expect((await f.field(f.ids.plain)).options).toEqual({ richText: true });
    expect(await f.values()).toMatchObject({ [f.ids.rich]: MARKDOWN, [f.ids.plain]: PLAIN });
  });

  it('searches and filters the stored text', async () => {
    const f = await fixture();
    await f.write({ [f.ids.rich]: MARKDOWN });
    const search = await server.app.inject({
      method: 'POST',
      url: `/api/views/${f.ids.view}/search`,
      headers: server.owner.headers,
      payload: { query: '<b>not html</b>' },
    });
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json<ViewSearchResult>().matches.map((match) => match.fieldId)).toEqual([f.ids.rich]);
    await f.command({
      kind: 'view.update',
      viewId: f.ids.view,
      config: {
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'bold', fieldId: f.ids.rich, operator: 'contains', value: '**Bold**' }],
        },
      },
    });
    expect((await f.values())[f.ids.rich]).toBe(MARKDOWN);
  });

  it('downloads rich text as its Markdown, and plain long text as before', async () => {
    const f = await fixture();
    await f.write({ [f.ids.name]: 'One', [f.ids.rich]: MARKDOWN, [f.ids.plain]: PLAIN });
    const url = (format: string) =>
      `/api/views/${f.ids.view}/export?${new URLSearchParams({ format, timeZone: 'UTC', locale: 'en-US' })}`;
    const csv = await server.app.inject({ url: url('csv'), headers: server.owner.headers });
    expect(csv.statusCode, csv.body).toBe(200);
    const quoted = (text: string) => `"${text.replaceAll('"', '""')}"`;
    expect(csv.rawPayload.toString('utf8')).toBe(
      `\uFEFFName,Rich,Plain\r\nOne,${quoted(MARKDOWN)},${quoted(PLAIN)}\r\n`,
    );
    const xlsx = await server.app.inject({ url: url('xlsx'), headers: server.owner.headers });
    expect(xlsx.statusCode, xlsx.body).toBe(200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(xlsx.rawPayload as unknown as Parameters<ExcelJS.Workbook['xlsx']['load']>[0]);
    const row = book.worksheets[0]!.getRow(2);
    expect([row.getCell(1).value, row.getCell(2).value, row.getCell(3).value]).toEqual([
      'One',
      MARKDOWN,
      PLAIN,
    ]);
  });

  it('answers the Markdown through the REST API, in both cell formats', async () => {
    const f = await fixture();
    await f.write({ [f.ids.rich]: MARKDOWN });
    const made = await server.app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: server.owner.headers,
      payload: { name: 'Rich text', scopes: ['data.records:read'], databases: 'all' },
    });
    expect(made.statusCode, made.body).toBe(200);
    const headers = { authorization: `Bearer ${made.json<TokenCreated>().token}` };
    for (const cellFormat of ['json', 'string']) {
      const response = await server.app.inject({
        url: `/api/v1/tables/${f.ids.table}/records?cellFormat=${cellFormat}&timeZone=UTC&locale=en-US`,
        headers,
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<KeyedRecords>().records[f.ids.first]).toMatchObject({ Rich: MARKDOWN });
    }
  });

  it('tells public forms and shared views which long text takes rich text', () => {
    const stored = (id: string, richText: boolean): StoredField => ({
      ...FieldMeta.parse({
        id,
        tableId: 'tbl00000000000001',
        name: id,
        description: '',
        position: 0,
        createdAt: '',
        updatedAt: '',
        type: 'longText',
        options: { richText },
      }),
      columnName: id,
    });
    const rich = stored('fld00000000000001', true);
    const plain = stored('fld00000000000002', false);
    const { questions } = publicQuestions(
      FormSettings.parse({ questions: [{ fieldId: rich.id }, { fieldId: plain.id }] }),
      [rich, plain],
    );
    expect(questions.map((question) => question.options)).toEqual([{ richText: true }, { richText: false }]);
    expect(publicField(rich).options).toEqual({ richText: true });
    expect(publicField(plain).options).toEqual({ richText: false });
  });
});
