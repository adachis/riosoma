import { describe, expect, it } from 'vitest';
import { FieldMeta } from '@riosoma/contracts';
import type { FieldType } from '@riosoma/contracts';
import {
  aggregatesFor,
  fitValue,
  formatAxisValue,
  formatValue,
  groupFields,
  isDateField,
  isNumericField,
  recordFields,
  valueFields,
} from './aggregates';

let serial = 0;
function field(type: FieldType, options: Record<string, unknown> = {}, name: string = type): FieldMeta {
  serial++;
  return FieldMeta.parse({
    id: `fld${String(serial).padStart(14, '0')}`,
    tableId: 'tbl00000000000000',
    name,
    type,
    options,
    description: '',
    position: serial,
    createdAt: '',
    updatedAt: '',
  });
}
const link = { linkFieldId: 'fld99999999999999', targetFieldId: 'fld99999999999998' };
const format = { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() };

describe('values that fit a field', () => {
  it('only counts records without a field, and sums only numbers', () => {
    expect(aggregatesFor(null)).toEqual(['count']);
    for (const type of ['number', 'currency', 'percent', 'duration', 'rating', 'autoNumber'] as const)
      expect(aggregatesFor(field(type))).toEqual(['countUnique', 'sum', 'average', 'min', 'max']);
    for (const type of ['text', 'singleSelect', 'date', 'checkbox', 'user', 'email', 'link'] as const)
      expect(
        aggregatesFor(field(type, type === 'link' ? { linkedTableId: 'tbl00000000000001' } : {})),
      ).toEqual(['countUnique']);
    expect(aggregatesFor(field('attachment'))).toEqual([]);
  });

  it('reads formulas and rollups by what they produce, and never sums a lookup’s lists', () => {
    expect(isNumericField(field('formula', { resultType: 'number' }))).toBe(true);
    expect(isNumericField(field('formula', { resultType: 'text' }))).toBe(false);
    expect(isNumericField(field('rollup', { ...link, resultType: 'number' }))).toBe(true);
    expect(isNumericField(field('count', { linkFieldId: link.linkFieldId }))).toBe(true);
    expect(isNumericField(field('lookup', { ...link, resultType: 'number' }))).toBe(false);
    expect(isDateField(field('formula', { resultType: 'date' }))).toBe(true);
    expect(isDateField(field('createdTime'))).toBe(true);
    expect(isDateField(field('text'))).toBe(false);
  });

  it('lists the fields each part of a tile can use', () => {
    const name = field('text', {}, 'Name'),
      notes = field('longText', {}, 'Notes'),
      files = field('attachment', {}, 'Files'),
      amount = field('number', {}, 'Amount'),
      linked = field('link', { linkedTableId: 'tbl00000000000001' }, 'Linked');
    const fields = [name, notes, files, amount, linked];
    expect(valueFields(fields).map((item) => item.name)).toEqual(['Name', 'Notes', 'Amount', 'Linked']);
    expect(groupFields(fields).map((item) => item.name)).toEqual(['Name', 'Amount', 'Linked']);
    expect(recordFields(fields, name.id).map((item) => item.name)).toEqual(['Notes', 'Amount']);
  });

  it('keeps a value valid when its field changes or disappears', () => {
    const amount = field('number'),
      label = field('text');
    expect(fitValue({ fn: 'sum', fieldId: amount.id }, [amount])).toEqual({ fn: 'sum', fieldId: amount.id });
    expect(fitValue({ fn: 'sum', fieldId: label.id }, [label])).toEqual({
      fn: 'countUnique',
      fieldId: label.id,
    });
    expect(fitValue({ fn: 'max', fieldId: amount.id }, [])).toEqual({ fn: 'count', fieldId: null });
    expect(fitValue({ fn: 'count', fieldId: amount.id }, [amount])).toEqual({ fn: 'count', fieldId: null });
  });
});

describe('formatting values like their fields', () => {
  it('shows counts as whole numbers and field values in the field’s format', () => {
    expect(formatValue(1234, { fn: 'count', fieldId: null }, undefined, format)).toBe('1,234');
    const money = field('currency', { code: 'EUR', precision: 2 });
    expect(formatValue(1234.5, { fn: 'sum', fieldId: money.id }, money, format)).toBe('€1,234.50');
    const share = field('percent', { precision: 1 });
    expect(formatValue(0.256, { fn: 'average', fieldId: share.id }, share, format)).toBe('25.6%');
    const time = field('duration', { format: 'h:mm' });
    expect(formatValue(5400, { fn: 'max', fieldId: time.id }, time, format)).toBe('1:30');
    const plain = field('number');
    expect(formatValue(10 / 3, { fn: 'average', fieldId: plain.id }, plain, format)).toBe('3.33');
    const fixed = field('number', { precision: 3 });
    expect(formatValue(2, { fn: 'min', fieldId: fixed.id }, fixed, format)).toBe('2.000');
    const stars = field('rating');
    expect(formatValue(3.5, { fn: 'average', fieldId: stars.id }, stars, format)).toBe('3.5');
    expect(formatValue(null, { fn: 'sum', fieldId: plain.id }, plain, format)).toBeNull();
  });

  it('labels a whole step of an axis without the decimal places a number or money would show', () => {
    const money = field('currency', { code: 'USD', precision: 2 });
    const sum = { fn: 'sum' as const, fieldId: money.id };
    expect(formatAxisValue(25_000_000, sum, money, format)).toBe('$25,000,000');
    expect(formatValue(25_000_000, sum, money, format)).toBe('$25,000,000.00');
    const fixed = field('number', { precision: 2 });
    expect(formatAxisValue(5_000, { fn: 'sum', fieldId: fixed.id }, fixed, format)).toBe('5,000');
    // A step between whole numbers keeps the field's own places, and so does everything else.
    expect(formatAxisValue(2.5, sum, money, format)).toBe('$2.50');
    const share = field('percent', { precision: 1 });
    expect(formatAxisValue(1, { fn: 'average', fieldId: share.id }, share, format)).toBe('100.0%');
    const time = field('duration', { format: 'h:mm' });
    expect(formatAxisValue(5400, { fn: 'max', fieldId: time.id }, time, format)).toBe('1:30');
    expect(formatAxisValue(1234, { fn: 'count', fieldId: null }, undefined, format)).toBe('1,234');
  });
});
