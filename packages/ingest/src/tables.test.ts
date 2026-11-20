import { describe, expect, it } from 'vitest';
import { cell } from './source.js';
import {
  between,
  cellText,
  fillDown,
  findHeaderRow,
  findLabelValueBlocks,
  isTotalRow,
  lineTable,
  normalizeMarker,
  pageLines,
  pivot,
  splitLine,
  splitLines,
  splitText,
  tableByName,
  unpivot,
  wildcardMatches,
} from './tables.js';

describe('headers and named tables', () => {
  const rows = [['A report'], [], [' ID: ', 'AMOUNT', 'Amount'], ['0042', '1.20', '3.50']].map((row) =>
    row.map(cell),
  );
  it('finds delayed headers within the declared search window', () => {
    expect(findHeaderRow(rows, ['id', 'amount'])).toBe(2);
    expect(findHeaderRow(rows, ['ID'], 2)).toBeNull();
    expect(findHeaderRow(rows, ['missing'])).toBeNull();
    expect(findHeaderRow(rows, [])).toBeNull();
    expect(findHeaderRow(rows, ['ID'], 0)).toBeNull();
    expect(normalizeMarker(' Cafe\u0301  Amount: ')).toBe('café amount');
  });
  it('keeps all duplicate headings accessible by occurrence', () => {
    const table = tableByName(rows, 2);
    expect(table.indices('amount')).toEqual([1, 2]);
    expect(table.get(rows[3]!, 'AMOUNT', 1).v).toBe('3.50');
    expect(table.all(rows[3]!, 'amount').map(cellText)).toEqual(['1.20', '3.50']);
    expect(table.get([], 'ID').v).toBeNull();
    expect(table.get(rows[3]!, 'missing').v).toBeNull();
    expect(() => tableByName(rows, -1)).toThrow('ingest.table.headerMissing');
    expect(() => tableByName(rows, 9)).toThrow('ingest.table.headerMissing');
  });
});
describe('fill-down and totals', () => {
  it('fills selected fields without mutating the input or treating zero as blank', () => {
    const input = [
      { group: null, value: 1 },
      { group: 'Crest', value: 2 },
      { group: '', value: 0 },
      { group: 'Cove', value: 4 },
      { group: null, value: 5 },
    ];
    expect(fillDown(input, ['group']).map((row) => row.group)).toEqual([
      null,
      'Crest',
      'Crest',
      'Cove',
      'Cove',
    ]);
    expect(input[2]?.group).toBe('');
    expect(fillDown([{ group: 0 }, { group: null }], ['group'])).toEqual([{ group: 0 }, { group: 0 }]);
  });
  it('recognizes total and subtotal labels without matching a similar product name', () => {
    for (const label of ['TOTAL:', 'Subtotal Workshop A', ' Grand  total '])
      expect(isTotalRow([cell(label), cell(0)])).toBe(true);
    expect(isTotalRow([cell('Totalizer'), cell(4)])).toBe(false);
    expect(isTotalRow([cell('Balance')], ['Balance'])).toBe(true);
  });
  it('recognizes a colon between a total label and its group name', () => {
    for (const label of ['Subtotal: Cove', 'Grand total: Cove', 'Total:Cove'])
      expect(isTotalRow([cell(label), cell(3)])).toBe(true);
  });
});
describe('unpivot and pivot', () => {
  it('keeps row and period order, including empty values', () => {
    expect(
      unpivot([{ product: 'Orbit', march: '1.5', april: null }], {
        keys: ['product'],
        columns: [
          { key: 'march', period: '2026-03-01' },
          { key: 'april', period: '2026-04-01' },
        ],
        periodField: 'period',
        valueField: 'amount',
      }),
    ).toEqual([
      { product: 'Orbit', period: '2026-03-01', amount: '1.5' },
      { product: 'Orbit', period: '2026-04-01', amount: null },
    ]);
  });
  it('groups measures in source order and reports duplicates rather than overwriting', () => {
    const result = pivot(
      [
        { id: 'A', measure: 'units', value: '2' },
        { id: 'B', measure: 'units', value: '3' },
        { id: 'A', measure: 'amount', value: '1.5' },
        { id: 'A', measure: 'amount', value: '9' },
      ],
      { keys: ['id'], measureField: 'measure', valueField: 'value' },
    );
    expect(result.rows).toEqual([
      { id: 'A', units: '2', amount: '1.5' },
      { id: 'B', units: '3' },
    ]);
    expect(result.conflicts).toEqual([{ row: 3, measure: 'amount', key: 'ingest.pivot.duplicateMeasure' }]);
    expect(
      pivot([{ id: 'A', measure: '__proto__', value: '1' }], {
        keys: ['id'],
        measureField: 'measure',
        valueField: 'value',
      }).conflicts,
    ).toHaveLength(1);
  });
});
describe('label blocks and page lines', () => {
  it('finds declared adjacent label and value pairs on both sides of a sheet', () => {
    const rows = [
      ['Amount:', '1.20', null, 'ID', '0042'],
      ['Amount', null],
    ].map((row) => row.map(cell));
    expect(
      findLabelValueBlocks(rows, ['amount', 'id']).map((block) => ({
        label: block.label,
        value: block.value.v,
        row: block.row,
        column: block.column,
      })),
    ).toEqual([
      { label: 'Amount:', value: '1.20', row: 0, column: 0 },
      { label: 'ID', value: '0042', row: 0, column: 3 },
    ]);
  });
  it('preserves line locations and excludes missing or garbled text layers', () => {
    const lines = pageLines({
      kind: 'pdf',
      name: 'letter.pdf',
      warnings: [],
      pages: [
        { number: 1, textQuality: 'clean', text: 'Dear Mira\r\nID  Amount\r\n0042  1.20' },
        { number: 2, textQuality: 'garbled', text: 'noise' },
        { number: 3, textQuality: 'none', text: '' },
      ],
    });
    expect(lines).toHaveLength(3);
    const table = lineTable(lines, ['ID', 'Amount']);
    expect(table?.headerIndex).toBe(1);
    expect(table?.locations[2]).toEqual({ page: 1, line: 3 });
    expect(lineTable(lines, ['missing'])).toBeNull();
    expect(splitLines('a\rb\nc\r\nd')).toEqual(['a', 'b', 'c', 'd']);
    expect(splitLine(' A | B ', '|')).toEqual(['A', 'B']);
    expect(splitLine(' A\tB  C ')).toEqual(['A', 'B', 'C']);
  });
  it('splits small literal grammars and requires both delimiters', () => {
    expect(between('Hold 1.5 - Final [XD]', '[', ']')).toBe('XD');
    expect(between('Hold 1.5', '[', ']')).toBeNull();
    expect(between('[XD', '[', ']')).toBeNull();
    expect(splitText('Hold 1.5 - Final [XD]', ' - ')).toEqual(['Hold 1.5', 'Final [XD]']);
  });
});
describe('literal wildcards', () => {
  it('supports only stars and treats regular expression punctuation literally', () => {
    for (const [value, pattern, expected] of [
      ['Subtotal A', 'Subtotal*', true],
      ['foo.bar', '*.bar', true],
      ['fooXbar', 'foo.bar', false],
      ['abcdef', 'a*c*f', true],
      ['abc', 'a*d', false],
      ['a', 'a*a', false],
      ['', '*', true],
      ['abc', 'a*c*', true],
    ] as const)
      expect(wildcardMatches(value, pattern)).toBe(expected);
  });
});
