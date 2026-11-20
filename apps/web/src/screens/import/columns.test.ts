import { describe, expect, it } from 'vitest';
import { FieldSpec } from '@riosoma/contracts';
import type { ImportCell } from './cells';
import {
  analyze,
  emptyStats,
  inferType,
  makeColumns,
  mapColumns,
  meta,
  observe,
  prepareColumns,
  readValue,
  specFor,
  uniqueNames,
  type Column,
} from './columns';

export async function* rows(values: ImportCell[][]) {
  yield* values;
}
const fallback = (number: number) => `Field ${number}`;
function infer(values: string[]) {
  const stats = emptyStats();
  for (const value of values) observe(stats, value);
  return { type: inferType(stats), stats };
}
describe('column inference', () => {
  it('excludes blank lines from the preview and the import total', async () => {
    const preview = await analyze(rows([['Name'], ['Alpha'], [''], ['   '], ['Beta']]), true);
    expect(preview.total).toBe(2);
    expect(preview.rows).toEqual([['Alpha'], ['Beta']]);
  });
  it.each([
    ['number', ['1.20', '-2.345', '']],
    ['checkbox', ['true', 'FALSE', 'yes', 'no', '1', '0', 'x', 'checked']],
    ['date', ['2026-01-02', '2026-02-03']],
    ['dateTime', ['2026-01-02', '2026-02-03T12:20:00Z']],
    ['email', ['a@example.com', 'b@example.com']],
    ['url', ['https://example.com', 'http://example.org/a']],
    ['singleSelect', ['Ready', 'Done', 'Ready']],
    ['longText', ['A\nB', 'C']],
    ['longText', ['x'.repeat(256)]],
    ['text', ['A', 'B']],
    ['text', ['', '']],
  ])('chooses %s', (type, values) => {
    expect(infer(values).type).toBe(type);
  });
  it('uses the maximum decimal places and caps contract precision', () => {
    const { stats } = infer(['1.20', '-2.345', '3.123456789']);
    expect(specFor('number', stats).options).toMatchObject({ precision: 8 });
  });
  it('samples at most 1,000 nonempty values and bounds distinct metadata', () => {
    const { stats, type } = infer([
      ...Array<string>(1000).fill(''),
      ...Array<string>(1000).fill('12'),
      'not a number',
    ]);
    expect(stats.count).toBe(1000);
    expect(type).toBe('number');
    expect(infer(Array.from({ length: 1000 }, (_, i) => `Name ${i}`)).stats.distinct).toHaveLength(51);
  });
  it('requires repeated values and no more than 50 distinct choices', () => {
    const values = Array.from({ length: 50 }, (_, i) => `Name ${i}`);
    expect(infer([...values, ...values]).type).toBe('singleSelect');
    expect(infer([...values, ...values, 'New']).type).toBe('text');
  });
  it('chooses a single date order for the column and prefers US for ambiguity', async () => {
    const preview = await analyze(rows([['Day'], ['01/02/2026'], ['13/02/2026']]), true);
    const column = makeColumns(preview, true, fallback)[0]!;
    expect(column.dateOrder).toBe('dmy');
    expect(readValue(column, '01/02/2026').value).toBe('2026-02-01');
    expect(readValue(column, '02/13/2026').misfit).toBe(true);
    const ambiguous = await analyze(rows([['Day'], ['01/02/2026']]), true);
    const us = makeColumns(ambiguous, true, fallback)[0]!;
    expect(us.dateOrder).toBe('mdy');
    expect(readValue(us, '01/02/2026').value).toBe('2026-01-02');
    expect(infer(['13/02/2026', '02/13/2026']).type).toBe('text');
    expect(infer(['02/30/2026']).type).toBe('text');
  });
  it('handles European dates with times and preserves explicit offsets', () => {
    const column: Column = { name: 'Day', include: true, dateOrder: 'dmy', field: meta(specFor('dateTime')) };
    expect(readValue(column, '27.09.2026 11:05').value).toBe('2026-09-27T11:05:00.000Z');
    expect(readValue(column, '2026-09-27T11:05:00+02:00').value).toBe('2026-09-27T09:05:00.000Z');
  });
  it('trims and deduplicates headers, names extra columns, and honors header off', async () => {
    const preview = await analyze(
      rows([
        [' Name ', 'name', ''],
        ['A', 'B', 'C', 'D'],
      ]),
      true,
    );
    expect(makeColumns(preview, true, fallback).map((c) => c.name)).toEqual([
      'Name',
      'name (2)',
      'Field 3',
      'Field 4',
    ]);
    expect(makeColumns(preview, false, fallback).map((c) => c.name)).toEqual([
      'Field 1',
      'Field 2',
      'Field 3',
      'Field 4',
    ]);
    expect(
      uniqueNames(['a'.repeat(255), 'a'.repeat(255)], fallback).every((name) => name.length <= 255),
    ).toBe(true);
    expect((await analyze(rows([['a'], ['b']]), false)).rows).toEqual([['a'], ['b']]);
  });
  it('keeps only 20 preview rows and defaults an incompatible primary to text', async () => {
    const preview = await analyze(rows([['Status'], ...Array.from({ length: 2000 }, () => ['Ready'])]), true);
    expect(preview.rows).toHaveLength(20);
    expect(preview.total).toBe(2000);
    expect(makeColumns(preview, true, fallback)[0]!.field.type).toBe('text');
  });
  it('maps writable fields by name once and counts misfits over the entire file', async () => {
    const preview = await analyze(
      rows([
        ['Total', 'Created'],
        ['1', 'date'],
      ]),
      true,
    );
    const field = { ...meta(specFor('number')), name: 'total' };
    const computed = { ...meta(FieldSpec.parse({ type: 'createdTime' })), name: 'Created' };
    const mapped = mapColumns(makeColumns(preview, true, fallback), [field, computed]);
    expect(mapped[0]!.field.id).toBe(field.id);
    expect(mapped[1]!.include).toBe(false);
    const result = await prepareColumns(
      rows([['Total'], ['1'], ['bad'], ['2'], ['also bad']]),
      mapped,
      true,
      true,
      'UTC',
    );
    expect(result.misfits).toEqual([2, 0]);
  });
  it('creates choices across the entire file, rotates colors, and parses multiple selects', async () => {
    const column: Column = {
      name: 'Tags',
      include: true,
      dateOrder: 'mdy',
      field: meta(specFor('multipleSelect')),
    };
    const result = await prepareColumns(
      rows([['Tags'], ['A, B'], ['C\nA'], ['D']]),
      [column],
      true,
      false,
      'UTC',
    );
    const field = result.columns[0]!.field;
    expect(field.type).toBe('multipleSelect');
    if (field.type !== 'multipleSelect') throw new Error();
    expect(field.options.choices.map((choice) => [choice.name, choice.color])).toEqual([
      ['A', 'gray'],
      ['B', 'red'],
      ['C', 'orange'],
      ['D', 'yellow'],
    ]);
    expect(readValue(result.columns[0]!, 'A,B').value).toHaveLength(2);
    expect(result.misfits).toEqual([0]);
  });
  it('omits empty values, keeps false and zero, and rejects invalid checkbox and URL text', () => {
    const column: Column = { name: '', include: true, dateOrder: 'mdy', field: meta(specFor('checkbox')) };
    expect(readValue(column, '').value).toBeUndefined();
    expect(readValue(column, '0').value).toBe(false);
    expect(readValue(column, 'maybe').misfit).toBe(true);
    column.field = meta(specFor('number'));
    expect(readValue(column, '0').value).toBe(0);
    column.field = meta(specFor('url'));
    expect(readValue(column, 'bad').misfit).toBe(true);
  });
});

describe('typed spreadsheet cells', () => {
  function inferCells(cells: ImportCell[]) {
    const stats = emptyStats();
    for (const cell of cells) observe(stats, cell);
    return inferType(stats);
  }
  it('infers types from the values a spreadsheet keeps', () => {
    expect(inferCells([12, 3.25, null])).toBe('number');
    expect(inferCells([true, false])).toBe('checkbox');
    expect(inferCells([{ date: '2026-01-02' }, { date: '2026-02-03' }])).toBe('date');
    expect(inferCells([{ date: '2026-01-02' }, { date: '2026-02-03T12:20:00' }])).toBe('dateTime');
    // Text that looks like a number still reads as one, and an error doesn't decide the type.
    expect(inferCells([12, '13', { error: '#N/A' }])).toBe('number');
    expect(inferCells([12, 'twelve'])).toBe('text');
    expect(inferCells([{ date: '2026-01-02' }, 5])).toBe('text');
  });
  it('keeps numbers, dates, and true or false as they are, and reads the rest as text', () => {
    const column = (spec: FieldSpec): Column => ({
      name: '',
      include: true,
      dateOrder: 'dmy',
      field: meta(spec),
    });
    expect(readValue(column(specFor('number')), 1234.5).value).toBe(1234.5);
    expect(readValue(column(FieldSpec.parse({ type: 'percent' })), 0.125).value).toBe(0.125);
    expect(readValue(column(specFor('checkbox')), true).value).toBe(true);
    expect(readValue(column(specFor('date')), { date: '2026-03-04' }).value).toBe('2026-03-04');
    expect(
      readValue(column(specFor('dateTime')), { date: '2026-03-04T10:30:00' }, 'America/New_York').value,
    ).toBe('2026-03-04T15:30:00.000Z');
    expect(readValue(column(specFor('text')), 12.5).value).toBe('12.5');
    expect(readValue(column(specFor('text')), false).value).toBe('FALSE');
    expect(readValue(column(specFor('text')), { date: '2026-03-04' }).value).toBe('2026-03-04');
  });
  it('says why a value doesn’t fit instead of guessing', () => {
    const column = (spec: FieldSpec): Column => ({
      name: '',
      include: true,
      dateOrder: 'mdy',
      field: meta(spec),
    });
    expect(readValue(column(specFor('number')), { error: '#DIV/0!' })).toEqual({
      misfit: true,
      reason: 'error',
    });
    expect(readValue(column(specFor('text')), { error: '' })).toEqual({ misfit: true, reason: 'error' });
    expect(readValue(column(specFor('date')), 45_000)).toEqual({ misfit: true, reason: 'date' });
    expect(readValue(column(specFor('number')), 'lots')).toEqual({ misfit: true, reason: 'number' });
    expect(
      readValue(column(FieldSpec.parse({ type: 'number', options: { allowNegative: false } })), -1),
    ).toEqual({
      misfit: true,
      reason: 'number',
    });
    const status = column(FieldSpec.parse({ type: 'singleSelect', options: { choices: [] } }));
    expect(readValue(status, 'Open')).toEqual({ misfit: true, reason: 'choice' });
    const person = column(FieldSpec.parse({ type: 'user' }));
    expect(readValue(person, 'Nobody')).toEqual({ misfit: true, reason: 'person' });
    const people = new Map([['usr00000000000001', { name: 'Ada Lovelace', email: 'ada@example.test' }]]);
    expect(readValue(person, 'ada@example.test', 'UTC', people).value).toEqual(['usr00000000000001']);
  });
  it('previews a sheet’s typed header and cells', async () => {
    const preview = await analyze(
      rows([
        ['Name', 2024],
        ['Ada', 12],
      ]),
      true,
    );
    expect(preview.header).toEqual(['Name', '2024']);
    expect(preview.rows).toEqual([['Ada', 12]]);
    expect(makeColumns(preview, true, fallback).map((column) => column.name)).toEqual(['Name', '2024']);
  });
});
