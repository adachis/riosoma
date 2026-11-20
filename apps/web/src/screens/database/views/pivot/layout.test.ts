import { describe, expect, it } from 'vitest';
import { FieldMeta, PivotSettings, type PivotAggregate } from '@riosoma/contracts';
import { csvName, pivotCsv, pivotModel, type PivotWords } from './layout';

const field = (id: string, name: string, type: string, options: Record<string, unknown> = {}) =>
  FieldMeta.parse({
    id,
    tableId: 'tbl00000000000001',
    name,
    type,
    options,
    position: 0,
    description: '',
    createdAt: '',
    updatedAt: '',
  });

const words: PivotWords = {
  empty: '(Empty)',
  checked: 'Checked',
  unchecked: 'Unchecked',
  total: 'Total',
  everything: 'Every record',
  valueName: (value, target) => (value.fn === 'count' ? 'Records' : `Sum of ${target?.name ?? ''}`),
  cell: (row, column) => `${row}, ${column}`,
};
const format = { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() };

describe('the pivot layout', () => {
  const name = field('fld00000000000001', 'Name', 'text');
  const done = field('fld00000000000002', 'Done', 'checkbox');
  const amount = field('fld00000000000003', 'Amount', 'currency', { code: 'USD' });
  const settings = PivotSettings.parse({
    rows: [{ fieldId: name.id }],
    column: { fieldId: done.id },
    values: [{ fn: 'sum', fieldId: amount.id }],
  });
  const data: PivotAggregate = {
    kind: 'pivot',
    columns: [
      { key: 'false', label: 'Unchecked' },
      { key: 'true', label: 'Checked' },
    ],
    rows: [
      { keys: ['=HYPERLINK("x")'], label: '=HYPERLINK("x")', cells: [[-5], null], total: [-5] },
      { keys: ['Smith, Jo'], label: 'Smith, Jo', cells: [null, [1250.5]], total: [1250.5] },
      { keys: [null], label: '', cells: [[null], null], total: [null] },
    ],
    totals: { cells: [[-5], [1250.5]], total: [1245.5] },
    capped: { rows: false, columns: false },
  };

  it('formats values by their field, leaves empty cells blank, and names each cell’s records', () => {
    const model = pivotModel(data, settings, [name, done, amount], format, words, new Set());
    expect(model.rows.map((row) => [row.label, ...row.cells.map((cell) => cell.text)])).toEqual([
      ['=HYPERLINK("x")', '-$5.00', '', '-$5.00'],
      ['Smith, Jo', '', '$1,250.50', '$1,250.50'],
      ['(Empty)', '', '', ''],
    ]);
    expect(model.rows[1]!.cells[1]!.target).toEqual({
      row: ['Smith, Jo'],
      column: 'true',
      title: 'Smith, Jo, Checked',
    });
    expect(model.rows[2]!.cells.every((cell) => cell.target === null)).toBe(true);
    expect(model.footer!.cells.at(-1)!.target).toEqual({ row: [], title: 'Every record' });
  });

  it('writes CSV that keeps labels as text and quotes what needs quoting', () => {
    const model = pivotModel(data, settings, [name, done, amount], format, words, new Set());
    expect(pivotCsv(model).split('\r\n')).toEqual([
      '\uFEFFName,Unchecked,Checked,Total',
      ',Sum of Amount,Sum of Amount,Sum of Amount',
      `"'=HYPERLINK(""x"")",-$5.00,,-$5.00`,
      '"Smith, Jo",,"$1,250.50","$1,250.50"',
      '(Empty),,,',
      'Total,-$5.00,"$1,250.50","$1,245.50"',
      '',
    ]);
  });

  it('names the file after the table and the view, safely', () => {
    expect(csvName('Orders', 'By region')).toBe('Orders - By region.csv');
    expect(csvName('Q1/Q2: plans', 'Pivot?')).toBe('Q1 Q2 plans - Pivot.csv');
    expect(csvName('', '')).toBe('pivot.csv');
  });
});
