import { describe, expect, it } from 'vitest';
import {
  FieldMeta,
  GridConfig,
  Sparkline,
  numericList,
  rangeFieldIds,
  sparklineKey,
  sparklineShape,
  sparklineSummary,
  sparklineValues,
  type RowData,
} from './index.js';

const field = FieldMeta.parse({
  id: 'fld00000000000001',
  tableId: 'tbl00000000000001',
  name: 'History',
  type: 'json',
  position: 0,
  description: '',
  createdAt: '',
  updatedAt: '',
});
const setting = Sparkline.parse({ fieldId: field.id });
const row: RowData = {
  id: 'rec00000000000001',
  values: { [field.id]: '[3,-2,8,4]' },
  createdAt: '',
  updatedAt: '',
  createdBy: null,
  updatedBy: null,
};

describe('sparkline values and axes', () => {
  it('keeps plain list order, duplicates, and finite numbers without coercion', () => {
    expect(numericList([4, null, '2', 4, NaN, Infinity, -1, false])).toEqual([4, 4, -1]);
    expect(sparklineValues(row, field, setting)).toEqual([3, -2, 8, 4]);
    expect(numericList('invalid')).toEqual([]);
    expect(sparklineSummary([3, -2, 8, 4])).toEqual({ min: -2, max: 8, last: 4, trend: 'up' });
    expect(sparklineSummary([])).toBeNull();
    expect(sparklineSummary([2, 1])?.trend).toBe('down');
    expect(sparklineSummary([2, 2])?.trend).toBe('flat');
  });
  it('uses independently ordered relational sources and suppresses errors', () => {
    const ordered = { ...setting, order: { fieldId: 'fld00000000000002', direction: 'asc' as const } };
    expect(sparklineValues(row, field, ordered)).toEqual([]);
    expect(
      sparklineValues({ ...row, sparklineValues: { [sparklineKey(ordered)]: [8, 3, -2] } }, field, ordered),
    ).toEqual([8, 3, -2]);
    expect(sparklineValues({ ...row, errors: { [field.id]: 'errors.internal' } }, field, setting)).toEqual(
      [],
    );
  });
  it('scales zero, negative, constant, single, shared, and extreme values', () => {
    expect(sparklineShape([0, 10], setting).path).toBe('M2.00,22.00 L98.00,2.00');
    expect(sparklineShape([0, 10], setting, { min: 0, max: 20 }).path).toBe('M2.00,22.00 L98.00,12.00');
    expect(sparklineShape([-1, -1], setting).path).toBe('M2.00,12.00 L98.00,12.00');
    expect(sparklineShape([5], setting).marks).toEqual([{ x: 50, y: 12 }]);
    expect(sparklineShape([-Number.MAX_VALUE, Number.MAX_VALUE], setting).path).not.toMatch(/NaN|Infinity/);
    const columns = sparklineShape([-10, 0, 10], { ...setting, type: 'column' });
    expect(columns.bars.map(({ y, height }) => [y, height])).toEqual([
      [12, 10],
      [12, 0],
      [2, 10],
    ]);
    expect(
      sparklineShape([-5, 0, 50], { ...setting, type: 'winLoss' }).bars.map(({ y, height }) => [y, height]),
    ).toEqual([
      [12, 10],
      [12, 0],
      [2, 10],
    ]);
  });
  it('preserves extrema and limits geometry for very long lists', () => {
    const values = Array.from({ length: 10_000 }, (_, index) => (index === 100 ? -500 : index % 20));
    const shape = sparklineShape(values, { ...setting, first: true, min: true, max: true });
    expect(shape.path.split(' ').length).toBeLessThanOrEqual(384);
    expect(shape.marks.some((point) => point.y === 22)).toBe(true);
    expect(shape.marks[0]?.x).toBe(2);
    expect(shape.marks.at(-1)?.x).toBe(98);
    expect(sparklineShape(values, { ...setting, type: 'column' }).bars.length).toBeLessThanOrEqual(96);
  });
  it.each(['column', 'winLoss'] as const)('preserves highlighted losses when sampling %s points', (type) => {
    const values = [type === 'column' ? -100 : -1, ...Array<number>(96).fill(1)];
    const shape = sparklineShape(values, { ...setting, type, first: true, last: false, min: true });
    const marked = shape.bars.filter((bar) => bar.highlighted);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ x: 2, negative: true });
    expect(marked[0]!.height).toBeGreaterThan(0);
    expect(shape.bars.filter((bar) => !bar.negative).every((bar) => !bar.highlighted)).toBe(true);
  });
  it('renders first, last, minimum, and maximum highlights at their sampled positions', () => {
    const values = Array<number>(193).fill(2);
    values[0] = -1;
    values[1] = -100;
    values[2] = 100;
    values[192] = 3;
    const shape = sparklineShape(values, {
      ...setting,
      type: 'column',
      first: true,
      last: true,
      min: true,
      max: true,
    });
    expect(shape.bars.filter((bar) => bar.highlighted).map((bar) => bar.x)).toEqual(
      [0, 1, 2, 192].map((index) => 2 + (index / values.length) * 96),
    );
    expect(shape.bars.filter((bar) => bar.highlighted).map((bar) => bar.negative)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(shape.bars.length).toBeLessThanOrEqual(384);
  });
  it('defaults old views and validates settings and shared-axis requests', () => {
    expect(GridConfig.parse({}).sparklines).toEqual([]);
    expect(Sparkline.safeParse({ fieldId: field.id, color: '#fff' }).success).toBe(false);
    expect(GridConfig.safeParse({ sparklines: [setting, setting] }).success).toBe(false);
    expect(
      rangeFieldIds(GridConfig.parse({ sparklines: [{ ...setting, sharedAxis: true }] }), [field]),
    ).toEqual([field.id]);
  });
});
