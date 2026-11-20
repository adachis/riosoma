import { describe, expect, it } from 'vitest';
import {
  ColorConfig,
  ColorScale,
  FieldMeta,
  type ColorRule,
  type FieldRange,
  type RowData,
} from '@riosoma/contracts';
import { barSize, createViewColors, mixFill, NO_COLORS, scaleFill, scalePoint } from './paint';

const field = (id: string, type: string, options: object = {}): FieldMeta =>
  FieldMeta.parse({
    id,
    tableId: 'tbl00000000000001',
    name: id,
    description: '',
    position: 0,
    createdAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-27T00:00:00.000Z',
    type,
    options,
  });

const done = 'cho00000000000001';
const status = field('fld00000000000001', 'singleSelect', {
  choices: [{ id: done, name: 'Done', color: 'green' }],
});
const amount = field('fld00000000000002', 'number');
const due = field('fld00000000000003', 'date');
const notes = field('fld00000000000004', 'text');
const fields = [status, amount, due, notes];

const row = (values: RowData['values'], id = 'rec00000000000001'): RowData => ({
  id,
  values,
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
  createdBy: null,
  updatedBy: null,
});

const rule = (id: string, target: 'cell' | 'record', condition: object, color: string, name = '') => ({
  id,
  name,
  target,
  condition: { id: `${id}-condition`, ...condition },
  color,
});

function colors(config: unknown, ranges: FieldRange[] = []) {
  return createViewColors({
    config: ColorConfig.parse(config),
    fields,
    context: { timeZone: 'UTC', now: new Date('2026-09-27T12:00:00Z') },
    ranges: new Map(ranges.map((range) => [range.fieldId, range])),
    label: (rule: ColorRule, field) => rule.name || `${field?.name} ${rule.condition.operator}`,
  });
}

describe('rules', () => {
  it('draws each icon style alongside rules and ignores blanks and incompatible fields', () => {
    for (const [style, glyphs] of [
      ['arrows', ['↓', '→', '↑']],
      ['flags', ['⚑', '⚑', '⚑']],
      ['ratings', ['★☆☆', '★★☆', '★★★']],
    ] as const) {
      const view = colors({
        iconSets: [{ fieldId: amount.id, style, thresholds: [0, 10], labels: ['Low', 'Middle', 'High'] }],
        colorRules: [rule('big', 'cell', { fieldId: amount.id, operator: 'gt', value: 5 }, 'blue', 'Big')],
      });
      for (const [index, value] of [-1, 0, 10].entries()) {
        expect(view.cell(row({ [amount.id]: value }), amount)?.icon).toMatchObject({ glyph: glyphs[index] });
      }
      expect(view.cell(row({ [amount.id]: 10 }), amount)?.labels).toEqual(['Big', 'High']);
      expect(view.cell(row({ [amount.id]: null }), amount)).toBeNull();
    }
    expect(colors({ iconSets: [{ fieldId: notes.id, thresholds: [0, 10] }] })).toBe(NO_COLORS);
  });
  const view = colors({
    colorRules: [
      rule('big', 'cell', { fieldId: amount.id, operator: 'gt', value: 100 }, 'red', 'Large'),
      rule('some', 'cell', { fieldId: amount.id, operator: 'gt', value: 10 }, 'yellow'),
      rule('finished', 'record', { fieldId: status.id, operator: 'is', value: done }, 'green', 'Finished'),
      rule('any', 'record', { fieldId: amount.id, operator: 'isNotEmpty' }, 'blue'),
      rule('unfinished', 'cell', { fieldId: notes.id, operator: 'contains' }, 'pink'),
    ],
  });

  it('let the first matching rule color each cell', () => {
    expect(view.cell(row({ [amount.id]: 500 }), amount)).toEqual({
      fill: 'var(--rio-aa-choice-red-soft)',
      color: 'red',
      bar: null,
      labels: ['Large'],
    });
    expect(view.cell(row({ [amount.id]: 50 }), amount)?.color).toBe('yellow');
    expect(view.cell(row({ [amount.id]: 5 }), amount)).toBeNull();
    expect(view.cell(row({ [amount.id]: 500 }), status)).toBeNull();
  });

  it('let the first matching record rule tint the record', () => {
    expect(view.record(row({ [status.id]: done, [amount.id]: 1 }))).toEqual({
      color: 'green',
      label: 'Finished',
    });
    expect(view.record(row({ [amount.id]: 1 }))).toEqual({ color: 'blue', label: `${amount.id} isNotEmpty` });
    expect(view.record(row({}))).toBeNull();
  });

  it('skip rules still missing a value, so they color nothing', () => {
    expect(view.cell(row({ [notes.id]: 'anything' }), notes)).toBeNull();
  });

  it('name every rule behind a record’s colors', () => {
    const record = row({ [status.id]: done, [amount.id]: 500 });
    expect(view.labels(record, [status, amount, notes])).toEqual(['Finished', 'Large']);
  });

  it('draw nothing without settings', () => {
    expect(colors({})).toBe(NO_COLORS);
    expect(colors({ colorRules: [rule('x', 'cell', { fieldId: amount.id, operator: 'gt' }, 'red')] })).toBe(
      NO_COLORS,
    );
  });
});

describe('color scales', () => {
  const twoStops = { fieldId: amount.id, stops: [{ color: 'red' }, { color: 'green' }] };

  it('mix between the ends in OKLab, from the tints of the legibility tier', () => {
    expect(mixFill('red', 'green', 0)).toBe('var(--rio-aa-choice-red-soft)');
    expect(mixFill('red', 'green', 1)).toBe('var(--rio-aa-choice-green-soft)');
    expect(mixFill('red', 'green', 0.254)).toBe(
      'color-mix(in oklab, var(--rio-aa-choice-green-soft) 25%, var(--rio-aa-choice-red-soft))',
    );
    expect(mixFill('blue', 'blue', 0.5)).toBe('var(--rio-aa-choice-blue-soft)');
  });

  it('follow the view’s range, and wait for it before coloring anything', () => {
    const range = { fieldId: amount.id, min: 0, max: 200 };
    const scale = ColorScale.parse(twoStops);
    expect(scaleFill(scale, amount, 50, range)).toBe(mixFill('red', 'green', 0.25));
    expect(scaleFill(scale, amount, 500, range)).toBe(mixFill('red', 'green', 1));
    expect(scaleFill(scale, amount, 50, undefined)).toBeNull();
    expect(scaleFill(scale, amount, null, range)).toBeNull();
  });

  it('use fixed values where given, and put a middle stop halfway unless it’s fixed', () => {
    const fixed = ColorScale.parse({
      fieldId: amount.id,
      stops: [
        { color: 'red', value: 10 },
        { color: 'green', value: 20 },
      ],
    });
    const middle = ColorScale.parse({
      fieldId: due.id,
      stops: [{ color: 'red' }, { color: 'yellow' }, { color: 'green' }],
    });
    const pinned = ColorScale.parse({
      fieldId: amount.id,
      stops: [{ color: 'red' }, { color: 'yellow', value: 0 }, { color: 'green' }],
    });
    expect(scaleFill(fixed, amount, 15, undefined)).toBe(mixFill('red', 'green', 0.5));
    const days = { fieldId: due.id, min: '2026-01-01', max: '2026-01-21' };
    expect(scaleFill(middle, due, '2026-01-11', days)).toBe(mixFill('yellow', 'green', 0));
    expect(scaleFill(middle, due, '2026-01-06', days)).toBe(mixFill('red', 'yellow', 0.5));
    expect(scaleFill(middle, due, '2026-01-16', days)).toBe(mixFill('yellow', 'green', 0.5));
    // A fixed middle splits the range where it sits, as a diverging scale around zero does.
    const around = { fieldId: amount.id, min: -10, max: 30 };
    expect(scaleFill(pinned, amount, -5, around)).toBe(mixFill('red', 'yellow', 0.5));
    expect(scaleFill(pinned, amount, 15, around)).toBe(mixFill('yellow', 'green', 0.5));
  });

  it('read days and moments as points in time', () => {
    expect(scalePoint(due, '2026-01-02')! - scalePoint(due, '2026-01-01')!).toBe(86_400_000);
    expect(scalePoint(due, '2026-01-01T12:00:00.000Z')).toBe(Date.parse('2026-01-01T12:00:00Z'));
    expect(scalePoint(due, 5)).toBeNull();
    expect(scalePoint(amount, '5')).toBeNull();
  });

  it('give way to a cell rule on the same field', () => {
    const view = colors(
      {
        colorRules: [
          rule('big', 'cell', { fieldId: amount.id, operator: 'gt', value: 100 }, 'purple', 'Large'),
        ],
        colorScales: [twoStops],
      },
      [{ fieldId: amount.id, min: 0, max: 200 }],
    );
    expect(view.cell(row({ [amount.id]: 150 }), amount)?.fill).toBe('var(--rio-aa-choice-purple-soft)');
    expect(view.cell(row({ [amount.id]: 100 }), amount)).toEqual({
      fill: mixFill('red', 'green', 0.5),
      color: null,
      bar: null,
      labels: [],
    });
  });
});

describe('data bars', () => {
  it('measure from zero to the highest value, or from the lowest when it is below zero', () => {
    expect(barSize(amount, 25, { fieldId: amount.id, min: 10, max: 100 })).toBe(25);
    expect(barSize(amount, 0, { fieldId: amount.id, min: -50, max: 50 })).toBe(50);
    expect(barSize(amount, 400, { fieldId: amount.id, min: 10, max: 100 })).toBe(100);
    expect(barSize(amount, 0, { fieldId: amount.id, min: 0, max: 0 })).toBe(0);
    expect(barSize(amount, null, { fieldId: amount.id, min: 0, max: 10 })).toBeNull();
    expect(barSize(amount, 5, undefined)).toBeNull();
  });

  it('draw beside a cell’s own color, and only on number fields', () => {
    const view = colors(
      {
        colorRules: [rule('big', 'cell', { fieldId: amount.id, operator: 'gt', value: 100 }, 'red', 'Large')],
        dataBars: [
          { fieldId: amount.id, color: 'teal', showValue: false },
          { fieldId: due.id, color: 'blue' },
        ],
      },
      [
        { fieldId: amount.id, min: 0, max: 400 },
        { fieldId: due.id, min: '2026-01-01', max: '2026-02-01' },
      ],
    );
    expect(view.cell(row({ [amount.id]: 200 }), amount)).toEqual({
      fill: 'var(--rio-aa-choice-red-soft)',
      color: 'red',
      bar: { color: 'teal', size: 50, showValue: false },
      labels: ['Large'],
    });
    expect(view.cell(row({ [due.id]: '2026-01-10' }), due)).toBeNull();
  });
});
