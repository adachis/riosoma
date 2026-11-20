import { describe, expect, it } from 'vitest';
import {
  COLOR_LIMITS,
  ColorRule,
  IconSet,
  iconBand,
  colorRuleMatches,
  FieldMeta,
  GridConfig,
  rangeFieldIds,
  scaleValueFits,
  ViewRangesQuery,
  type RowData,
} from './index.js';

const meta = (id: string, spec: unknown): FieldMeta =>
  FieldMeta.parse({
    id,
    tableId: 'tbl00000000000001',
    name: id,
    description: '',
    position: 1,
    createdAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-27T00:00:00.000Z',
    ...(spec as object),
  });

const amount = meta('fld00000000000001', { type: 'number' });
const due = meta('fld00000000000002', { type: 'date' });
const status = meta('fld00000000000003', {
  type: 'singleSelect',
  options: { choices: [{ id: 'cho00000000000001', name: 'Done', color: 'green' }] },
});
const notes = meta('fld00000000000004', { type: 'text' });
const fields = new Map([amount, due, status, notes].map((field) => [field.id, field]));

const rule = (overrides: Record<string, unknown> = {}) => ({
  id: 'rule1',
  target: 'cell',
  condition: { id: 'c1', fieldId: status.id, operator: 'is', value: 'cho00000000000001' },
  color: 'green',
  ...overrides,
});

const row = (values: RowData['values']): RowData => ({
  id: 'rec00000000000001',
  values,
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
  createdBy: null,
  updatedBy: null,
});

const context = { timeZone: 'UTC', now: new Date('2026-09-27T12:00:00Z') };

describe('color settings in the view configuration', () => {
  it('validates unique numeric icon bands and places equality in the higher band', () => {
    expect(GridConfig.parse({}).iconSets).toEqual([]);
    const set = IconSet.parse({ fieldId: amount.id, thresholds: [-5, 10] });
    expect([-6, -5, 9, 10, 20, null, '10', NaN, Infinity].map((value) => iconBand(set, value))).toEqual([
      0,
      1,
      1,
      2,
      2,
      null,
      null,
      null,
      null,
    ]);
    expect(IconSet.safeParse({ ...set, thresholds: [10, 5] }).success).toBe(false);
    expect(IconSet.safeParse({ ...set, thresholds: [0, Infinity] }).success).toBe(false);
    expect(IconSet.safeParse({ ...set, labels: ['x'.repeat(101), '', ''] }).success).toBe(false);
    expect(GridConfig.safeParse({ iconSets: [set, set] }).success).toBe(false);
    expect(iconBand(IconSet.parse({ ...set, thresholds: [5, 5] }), 5)).toBe(2);
  });
  it('start empty, so older views keep their look', () => {
    expect(GridConfig.parse({})).toMatchObject({ colorRules: [], colorScales: [], dataBars: [] });
  });

  it('fill in rule names and bar defaults, and accept two or three scale stops', () => {
    const config = GridConfig.parse({
      colorRules: [rule()],
      colorScales: [
        { fieldId: amount.id, stops: [{ color: 'red' }, { color: 'green', value: 100 }] },
        {
          fieldId: due.id,
          stops: [{ color: 'blue' }, { color: 'gray' }, { color: 'red', value: '2026-12-31' }],
        },
      ],
      dataBars: [{ fieldId: amount.id }],
    });
    expect(config.colorRules[0]).toEqual({ ...rule(), name: '' });
    expect(config.colorScales[0]!.stops).toEqual([
      { color: 'red', value: null },
      { color: 'green', value: 100 },
    ]);
    expect(config.dataBars).toEqual([{ fieldId: amount.id, color: 'blue', showValue: true }]);
  });

  it('refuse colors outside the palette, missing targets, and duplicate rule IDs', () => {
    expect(ColorRule.safeParse(rule({ color: 'magenta' })).success).toBe(false);
    expect(ColorRule.safeParse(rule({ target: 'row' })).success).toBe(false);
    expect(ColorRule.safeParse(rule({ name: 'x'.repeat(COLOR_LIMITS.nameLength + 1) })).success).toBe(false);
    expect(GridConfig.safeParse({ colorRules: [rule(), rule()] }).success).toBe(false);
    expect(
      GridConfig.safeParse({
        colorRules: Array.from({ length: COLOR_LIMITS.rules + 1 }, (_, i) => rule({ id: `rule${i}` })),
      }).success,
    ).toBe(false);
  });

  it('refuse scales with too few or too many stops, bad fixed values, and a second scale or bar per field', () => {
    const scale = (stops: unknown[]) =>
      GridConfig.safeParse({ colorScales: [{ fieldId: amount.id, stops }] });
    expect(scale([{ color: 'red' }]).success).toBe(false);
    expect(scale([{ color: 'red' }, { color: 'gray' }, { color: 'blue' }, { color: 'green' }]).success).toBe(
      false,
    );
    expect(scale([{ color: 'red', value: Infinity }, { color: 'green' }]).success).toBe(false);
    expect(scale([{ color: 'red', value: '2026-02-30' }, { color: 'green' }]).success).toBe(false);
    const twice = { fieldId: amount.id, stops: [{ color: 'red' }, { color: 'green' }] };
    expect(GridConfig.safeParse({ colorScales: [twice, twice] }).success).toBe(false);
    expect(GridConfig.safeParse({ dataBars: [{ fieldId: amount.id }, { fieldId: amount.id }] }).success).toBe(
      false,
    );
  });

  it('match fixed scale values to their fields', () => {
    expect(scaleValueFits(amount, 5)).toBe(true);
    expect(scaleValueFits(amount, '2026-01-01')).toBe(false);
    expect(scaleValueFits(due, '2026-01-01')).toBe(true);
    expect(scaleValueFits(due, 5)).toBe(false);
  });
});

describe('ranges a view needs', () => {
  it('ask only for automatic scale stops and for bars, on fields that can have them', () => {
    const config = GridConfig.parse({
      colorScales: [
        { fieldId: due.id, stops: [{ color: 'red' }, { color: 'green' }] },
        {
          fieldId: amount.id,
          stops: [
            { color: 'red', value: 0 },
            { color: 'green', value: 10 },
          ],
        },
        { fieldId: notes.id, stops: [{ color: 'red' }, { color: 'green' }] },
      ],
      dataBars: [{ fieldId: amount.id }, { fieldId: status.id }],
    });
    expect(rangeFieldIds(config, [...fields.values()])).toEqual([amount.id, due.id].sort());
    expect(rangeFieldIds(GridConfig.parse({}), [...fields.values()])).toEqual([]);
  });

  it('read field IDs from a comma-separated query and refuse anything else', () => {
    expect(ViewRangesQuery.parse({ fields: `${amount.id},${due.id}`, tz: 'UTC' })).toEqual({
      fields: [amount.id, due.id],
      tz: 'UTC',
    });
    expect(ViewRangesQuery.safeParse({ fields: '' }).success).toBe(false);
    expect(ViewRangesQuery.safeParse({ fields: 'amount' }).success).toBe(false);
    expect(ViewRangesQuery.safeParse({ fields: amount.id, tz: 'Mars/Olympus' }).success).toBe(false);
  });
});

describe('color rules', () => {
  it('color the records their condition admits, and nothing while the condition is incomplete', () => {
    const done = ColorRule.parse(rule());
    expect(colorRuleMatches(done, row({ [status.id]: 'cho00000000000001' }), fields, context)).toBe(true);
    expect(colorRuleMatches(done, row({ [status.id]: null }), fields, context)).toBe(false);
    const incomplete = ColorRule.parse(rule({ condition: { id: 'c1', fieldId: amount.id, operator: 'gt' } }));
    expect(colorRuleMatches(incomplete, row({ [amount.id]: 5 }), fields, context)).toBe(false);
    const mismatched = ColorRule.parse(
      rule({ condition: { id: 'c1', fieldId: amount.id, operator: 'contains', value: '5' } }),
    );
    expect(colorRuleMatches(mismatched, row({ [amount.id]: 5 }), fields, context)).toBe(false);
    const missing = ColorRule.parse(
      rule({ condition: { id: 'c1', fieldId: 'fld00000000000099', operator: 'isEmpty' } }),
    );
    expect(colorRuleMatches(missing, row({}), fields, context)).toBe(false);
  });

  it('follow relative dates in the viewer’s time zone', () => {
    const today = ColorRule.parse(
      rule({ condition: { id: 'c1', fieldId: due.id, operator: 'is', value: { mode: 'today' } } }),
    );
    expect(colorRuleMatches(today, row({ [due.id]: '2026-09-27' }), fields, context)).toBe(true);
    expect(
      colorRuleMatches(today, row({ [due.id]: '2026-09-27' }), fields, {
        ...context,
        timeZone: 'Pacific/Kiritimati',
      }),
    ).toBe(false);
  });
});
