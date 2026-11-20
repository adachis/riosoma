import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cellValue,
  CHOICE_COLORS,
  FieldSpec,
  isEmptyValue,
  LIMITS,
  newId,
  type CellValue,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { StoredField } from '../types.js';
import { columnRef } from './columns.js';
import { convertColumn, previewConversion, type ConversionOptions } from './convert.js';
import { createRecordTable } from './ddl.js';
import { fetchRowsById, insertRecords, trashRecords } from './records.js';

let kit: TestPostgres;
let database: Awaited<ReturnType<TestPostgres['createDatabase']>>;
let db: pg.Client;
const schema = 'convert_data';
const actor = newId('user');
const options: ConversionOptions = {
  dateOrder: 'mdy',
  timeZone: 'America/Los_Angeles',
  userNames: new Map([[actor, 'Pat Example']]),
};
const first = { id: newId('choice'), name: 'First', color: 'blue' } as const;
const second = { id: newId('choice'), name: 'Second', color: 'red' } as const;

beforeAll(async () => {
  kit = await startTestPostgres();
  database = await kit.createDatabase('conversion');
  db = new pg.Client({ connectionString: database.url });
  await db.connect();
  await query(db, sql`CREATE SCHEMA ${ident(schema)}`);
}, 60_000);
afterAll(async () => {
  await db?.end();
  await database?.drop();
  await kit?.stop();
});
beforeEach(async () => {
  await query(db, sql`BEGIN`);
  await query(db, sql`SET LOCAL TIME ZONE 'Pacific/Kiritimati'`);
  await query(db, sql`SET LOCAL DateStyle = 'SQL, DMY'`);
});
afterEach(async () => {
  await query(db, sql`ROLLBACK`);
});

async function source(spec: unknown, values: CellValue[]) {
  const tableId = newId('table');
  const id = newId('field');
  const field: StoredField = {
    id,
    tableId,
    columnName: `${id}_old`,
    name: 'Field',
    description: '',
    position: 0,
    createdAt: '',
    updatedAt: '',
    ...FieldSpec.parse(spec),
  };
  await createRecordTable(db, schema, tableId, [field]);
  const rows = values.map((value) => ({ id: newId('record'), values: { [id]: value } }));
  await insertRecords(db, schema, tableId, [field], rows, actor);
  return { field, tableId, ids: rows.map((r) => r.id) };
}

async function conversion(from: unknown, toInput: unknown, values: CellValue[], context = options) {
  const src = await source(from, values);
  const to = FieldSpec.parse(toInput);
  const before = await fetchRowsById(db, schema, src.tableId, [src.field], src.ids);
  const preview = await previewConversion(db, schema, src.tableId, src.field, to, context);
  const result = await convertColumn(db, schema, src.tableId, src.field, to, 'converted', context);
  const target = { ...src.field, ...to, columnName: 'converted', options: result.options } as StoredField;
  expect(FieldSpec.safeParse(target).success).toBe(true);
  const after = await fetchRowsById(db, schema, src.tableId, [target], src.ids);
  const converted = after.map((row) => cellValue(row, target));
  const originals = before.map((row) => cellValue(row, src.field));
  const lost = originals.filter((value, i) => !isEmptyValue(value) && isEmptyValue(converted[i]));
  expect(preview.total).toBe(originals.filter((v) => !isEmptyValue(v)).length);
  expect(preview.emptied).toBe(lost.length);
  expect(preview.converted).toBe(preview.total - lost.length);
  expect(preview.samples).toEqual(lost.slice(0, 5));
  expect(result.emptied).toBe(preview.emptied);
  expect(await fetchRowsById(db, schema, src.tableId, [src.field], src.ids)).toEqual(before);
  return { preview, result, converted, originals, target };
}

describe('column conversions', () => {
  const cases: Array<{
    name: string;
    from: unknown;
    to: unknown;
    values: CellValue[];
    expected: CellValue[];
  }> = [
    {
      name: 'plain decimal numbers to text',
      from: { type: 'number' },
      to: { type: 'text' },
      values: [1e-8, 1e21, -120.25, 0, null],
      expected: ['0.00000001', '1000000000000000000000', '-120.25', '0', null],
    },
    {
      name: 'checkboxes to long text',
      from: { type: 'checkbox' },
      to: { type: 'longText' },
      values: [true, false, null],
      expected: ['true', null, null],
    },
    {
      name: 'dates to text',
      from: { type: 'date' },
      to: { type: 'text' },
      values: ['2024-02-29', null],
      expected: ['2024-02-29', null],
    },
    {
      name: 'local date times to text',
      from: { type: 'date', options: { includeTime: true } },
      to: { type: 'text' },
      values: ['2024-03-01T01:02:00.000Z', null],
      expected: ['2024-02-29 17:02', null],
    },
    {
      name: 'fixed date time zone to long text',
      from: { type: 'date', options: { includeTime: true, timeZone: 'Asia/Tokyo' } },
      to: { type: 'longText' },
      values: ['2024-03-01T01:02:00.000Z'],
      expected: ['2024-03-01 10:02'],
    },
    {
      name: 'single choice names to text',
      from: { type: 'singleSelect', options: { choices: [first] } },
      to: { type: 'text' },
      values: [first.id, null],
      expected: ['First', null],
    },
    {
      name: 'multiple choice names to long text',
      from: { type: 'multipleSelect', options: { choices: [first, second] } },
      to: { type: 'longText' },
      values: [[second.id, first.id], [], null],
      expected: ['Second, First', null, null],
    },
    {
      name: 'currency and decimal text to numbers',
      from: { type: 'text' },
      to: { type: 'number' },
      values: [
        ' $ 1,234.50 ',
        '-42 £',
        '€12',
        '13¥',
        '.5',
        '1e3',
        'NaN',
        'Infinity',
        '1e999',
        '0x20',
        '12no',
        '',
        null,
      ],
      expected: [1234.5, -42, 12, 13, 0.5, 1000, null, null, null, null, null, null, null],
    },
    {
      name: 'negative number restriction',
      from: { type: 'longText' },
      to: { type: 'number', options: { allowNegative: false } },
      values: ['-1', '0', '1'],
      expected: [null, 0, 1],
    },
    {
      name: 'text checkbox tokens',
      from: { type: 'text' },
      to: { type: 'checkbox' },
      values: ['TRUE', ' Yes ', 'y', '1', 'X', 'Checked', '✓', '✔', 'no', '0', null],
      expected: [true, true, true, true, true, true, true, true, false, false, false],
    },
    {
      name: 'numbers to checkboxes',
      from: { type: 'number' },
      to: { type: 'checkbox' },
      values: [-1, 0, 2, null],
      expected: [true, false, true, false],
    },
    {
      name: 'checkboxes to numbers',
      from: { type: 'checkbox' },
      to: { type: 'number' },
      values: [true, false, null],
      expected: [1, null, null],
    },
    {
      name: 'email validation',
      from: { type: 'text' },
      to: { type: 'email' },
      values: [' person@example.test ', 'invalid', 'a b@example.test', null],
      expected: ['person@example.test', null, null, null],
    },
    {
      name: 'URL validation',
      from: { type: 'text' },
      to: { type: 'url' },
      values: [' https://example.test ', 'example.test', 'two words', null],
      expected: ['https://example.test', 'example.test', null, null],
    },
    {
      name: 'phone validation',
      from: { type: 'text' },
      to: { type: 'phone' },
      values: [' +1 555 0100 ', 'x'.repeat(LIMITS.phoneLength + 1), null],
      expected: ['+1 555 0100', null, null],
    },
    ...['email', 'url', 'phone', 'longText'].map((type) => ({
      name: `${type} to text`,
      from: { type },
      to: { type: 'text' },
      values: ['value@example.test', null],
      expected: ['value@example.test', null],
    })),
    {
      name: 'unsupported number to date',
      from: { type: 'number' },
      to: { type: 'date' },
      values: [5, null],
      expected: [null, null],
    },
    {
      name: 'unsupported checkbox to email',
      from: { type: 'checkbox' },
      to: { type: 'email' },
      values: [true, false],
      expected: [null, null],
    },
    {
      name: 'unsupported number to select',
      from: { type: 'number' },
      to: { type: 'singleSelect' },
      values: [5, null],
      expected: [null, null],
    },
    {
      name: 'long text normalizes for a single line',
      from: { type: 'longText' },
      to: { type: 'text' },
      values: ['line one\nline two', null],
      expected: ['line one line two', null],
    },
    {
      name: 'same type keeps values',
      from: { type: 'number' },
      to: { type: 'number', options: { precision: 2 } },
      values: [12.345, null],
      expected: [12.345, null],
    },
  ];
  it.each(cases)('$name', async ({ from, to, values, expected }) => {
    expect((await conversion(from, to, values)).converted).toEqual(expected);
  });

  it.each(['mdy', 'dmy', 'ymd'] as const)(
    'parses dates by %s without relying on DateStyle',
    async (dateOrder) => {
      const local = dateOrder === 'mdy' ? '2/29/2024' : dateOrder === 'dmy' ? '29/2/2024' : '2024/2/29';
      const { converted } = await conversion(
        { type: 'text' },
        { type: 'date' },
        [
          local,
          local.replaceAll('/', '-'),
          local.replaceAll('/', '.'),
          '2024-02-29',
          '2023-02-29',
          '2024-13-01',
          'not a date',
          null,
        ],
        { ...options, dateOrder },
      );
      expect(converted).toEqual([
        '2024-02-29',
        '2024-02-29',
        '2024-02-29',
        '2024-02-29',
        null,
        null,
        null,
        null,
      ]);
    },
  );

  it('converts ISO instants and local times with explicit timezone arithmetic', async () => {
    const { converted } = await conversion(
      { type: 'text' },
      { type: 'date', options: { includeTime: true } },
      [
        '2024-03-10',
        '2024-03-11',
        '2024-03-01T01:02:03Z',
        '2024-03-01T03:02:03+02:00',
        '2024-03-01 01:02',
        '2024-02-30T12:00Z',
        '2024-02-29T25:00Z',
        '2024-02-29T12:99Z',
        '2024-02-29T12:00:99Z',
        '2024-02-29T12:00+99:00',
        null,
      ],
    );
    expect(converted).toEqual([
      '2024-03-10T08:00:00.000Z',
      '2024-03-11T07:00:00.000Z',
      '2024-03-01T01:02:03.000Z',
      '2024-03-01T01:02:03.000Z',
      '2024-03-01T09:02:00.000Z',
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect((await conversion({ type: 'text' }, { type: 'date' }, ['2024-03-01T01:00Z'])).converted).toEqual([
      '2024-02-29',
    ]);
  });

  it('adds time at local midnight and removes it by the local calendar day', async () => {
    expect(
      (
        await conversion({ type: 'date' }, { type: 'date', options: { includeTime: true } }, [
          '2024-03-10',
          '2024-03-11',
          null,
        ])
      ).converted,
    ).toEqual(['2024-03-10T08:00:00.000Z', '2024-03-11T07:00:00.000Z', null]);
    expect(
      (
        await conversion({ type: 'date', options: { includeTime: true } }, { type: 'date' }, [
          '2024-03-01T01:00:00.000Z',
          null,
        ])
      ).converted,
    ).toEqual(['2024-02-29', null]);
    expect(
      (
        await conversion(
          { type: 'date' },
          { type: 'date', options: { includeTime: true, timeZone: 'Asia/Tokyo' } },
          ['2024-03-01'],
        )
      ).converted,
    ).toEqual(['2024-02-29T15:00:00.000Z']);
  });

  it.each(['singleSelect', 'multipleSelect'] as const)(
    'creates and reuses %s choices in first appearance order',
    async (type) => {
      const values =
        type === 'singleSelect'
          ? ['first', ' Second ', 'THIRD', 'second', null]
          : ['first, Second, first', 'THIRD, second', ' , ', null];
      const { converted, preview, target } = await conversion(
        { type: 'text' },
        { type, options: { choices: [first] } },
        values,
      );
      if (target.type !== 'singleSelect' && target.type !== 'multipleSelect')
        throw new Error('Expected select');
      expect(preview.newChoices).toEqual(['Second', 'THIRD']);
      expect(preview.tooManyChoices).toBe(false);
      expect(target.options.choices.map((c) => c.name)).toEqual(['First', 'Second', 'THIRD']);
      expect(target.options.choices.map((c) => c.color)).toEqual(['blue', 'red', 'orange']);
      expect(target.options.choices.every((c) => /^cho[0-9A-Za-z]{14}$/.test(c.id))).toBe(true);
      const [, two, three] = target.options.choices;
      expect(converted).toEqual(
        type === 'singleSelect'
          ? [first.id, two!.id, three!.id, two!.id, null]
          : [[first.id, two!.id], [three!.id, two!.id], [], []],
      );
    },
  );

  it('cycles choice colors without gray and keeps injection text literal', async () => {
    const values = [...Array.from({ length: 12 }, (_, i) => `Choice ${i}`), "O'Brien; $1 --"];
    const { target } = await conversion({ type: 'text' }, { type: 'singleSelect' }, values);
    if (target.type !== 'singleSelect') throw new Error('Expected select');
    const colors = CHOICE_COLORS.filter((color) => color !== 'gray');
    expect(target.options.choices.map((c) => c.name)).toEqual(values);
    expect(target.options.choices.map((c) => c.color)).toEqual(
      values.map((_, i) => colors[i % colors.length]),
    );
  });

  it('empties choice names that exceed the field options contract', async () => {
    const { converted, preview, target } = await conversion({ type: 'text' }, { type: 'singleSelect' }, [
      'x'.repeat(LIMITS.nameLength + 1),
      'Valid',
    ]);
    if (target.type !== 'singleSelect') throw new Error('Expected select');
    expect(converted).toEqual([null, target.options.choices[0]!.id]);
    expect(preview.newChoices).toEqual(['Valid']);
    expect(preview.emptied).toBe(1);
  });

  it('carries choice identities and options between single and multiple selects', async () => {
    const many = await conversion(
      { type: 'singleSelect', options: { choices: [first, second] } },
      { type: 'multipleSelect' },
      [second.id, null],
    );
    expect(many.converted).toEqual([[second.id], []]);
    expect(many.result.options).toEqual({ choices: [first, second] });
    const one = await conversion(
      { type: 'multipleSelect', options: { choices: [first, second] } },
      { type: 'singleSelect' },
      [[second.id, first.id], [], null],
    );
    expect(one.converted).toEqual([second.id, null, null]);
    expect(one.result.options).toEqual({ choices: [first, second] });
  });

  it('reports and refuses excess choices before adding a column', async () => {
    const src = await source(
      { type: 'text' },
      Array.from({ length: LIMITS.choicesPerField + 1 }, (_, i) => `Choice ${i}`),
    );
    const to = FieldSpec.parse({ type: 'singleSelect' });
    const preview = await previewConversion(db, schema, src.tableId, src.field, to, options);
    expect(preview.tooManyChoices).toBe(true);
    expect(preview.newChoices).toHaveLength(LIMITS.choicesPerField + 1);
    await expect(
      convertColumn(db, schema, src.tableId, src.field, to, 'converted', options),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      messageKey: 'data.field.tooManyChoices',
    });
    const added = await query<{ count: string }>(
      db,
      sql`SELECT count(*)::text AS count FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = ${src.tableId} AND column_name = 'converted'`,
    );
    expect(added.rows[0]!.count).toBe('0');
  });

  it('allows exactly the choice limit, counting reused choices once', async () => {
    const choices = Array.from({ length: LIMITS.choicesPerField }, (_, i) => ({
      id: newId('choice'),
      name: `Choice ${i}`,
      color: 'blue',
    }));
    const { preview, converted } = await conversion(
      { type: 'text' },
      { type: 'singleSelect', options: { choices } },
      ['choice 0', 'CHOICE 999'],
    );
    expect(preview.tooManyChoices).toBe(false);
    expect(preview.newChoices).toEqual([]);
    expect(converted).toEqual([choices[0]!.id, choices[999]!.id]);
  });

  it.each(['createdBy', 'lastModifiedBy'])('converts %s to a person name', async (type) => {
    expect((await conversion({ type }, { type: 'text' }, [null])).converted).toEqual(['Pat Example']);
  });

  it.each(['createdTime', 'lastModifiedTime'])('converts %s from its system column', async (type) => {
    const src = await source({ type }, [null]);
    await query(
      db,
      sql`UPDATE ${ident(schema, src.tableId)} SET ${columnRef(src.field)} = ${'2024-03-01T01:02:00Z'}::timestamptz`,
    );
    const to = FieldSpec.parse({ type: 'date' });
    const preview = await previewConversion(db, schema, src.tableId, src.field, to, options);
    const result = await convertColumn(db, schema, src.tableId, src.field, to, 'converted', options);
    const target: StoredField = { ...src.field, ...to, columnName: 'converted' };
    expect(preview).toMatchObject({ total: 1, converted: 1, emptied: 0 });
    expect(result.emptied).toBe(0);
    expect((await fetchRowsById(db, schema, src.tableId, [target], src.ids))[0]!.values[target.id]).toBe(
      '2024-02-29',
    );
    const text = await conversion({ type }, { type: 'text' }, [null]);
    expect(text.converted[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('converts record IDs from the system column and skips computed targets', async () => {
    const { converted, originals } = await conversion({ type: 'recordId' }, { type: 'text' }, [null]);
    expect(converted).toEqual(originals);
    const src = await source({ type: 'text' }, ['Stored']);
    const to = FieldSpec.parse({ type: 'createdTime' });
    expect(await convertColumn(db, schema, src.tableId, src.field, to, 'unused', options)).toEqual({
      emptied: 0,
      options: to.options,
    });
    expect(await previewConversion(db, schema, src.tableId, src.field, to, options)).toMatchObject({
      total: 1,
      emptied: 0,
    });
    const columns = await query<{ count: string }>(
      db,
      sql`SELECT count(*)::text AS count FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = ${src.tableId} AND column_name = 'unused'`,
    );
    expect(columns.rows[0]!.count).toBe('0');
  });

  it('includes trashed values in conversion and limits loss samples to five', async () => {
    const src = await source(
      { type: 'text' },
      Array.from({ length: 8 }, (_, i) => `Invalid ${i}`),
    );
    await trashRecords(db, schema, src.tableId, src.ids.slice(0, 1), actor);
    const to = FieldSpec.parse({ type: 'number' });
    const preview = await previewConversion(db, schema, src.tableId, src.field, to, options);
    expect(preview).toMatchObject({
      total: 8,
      emptied: 8,
      converted: 0,
      samples: ['Invalid 0', 'Invalid 1', 'Invalid 2', 'Invalid 3', 'Invalid 4'],
    });
    expect((await convertColumn(db, schema, src.tableId, src.field, to, 'converted', options)).emptied).toBe(
      8,
    );
  });
});
