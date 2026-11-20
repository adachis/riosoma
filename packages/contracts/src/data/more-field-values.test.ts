import { describe, expect, it } from 'vitest';
import {
  checkCellValue,
  checkCondition,
  canConvert,
  operatorsFor,
  conditionMatches,
  FieldMeta,
  FieldSpec,
  formatTimeOfDay,
  isComputedType,
  parseMultiCurrency,
  parseTimeOfDay,
  summaryKindsFor,
  type FieldType,
} from '../index.js';

const field = (type: FieldType) =>
  FieldMeta.parse({
    id: 'fld00000000000001',
    tableId: 'tbl00000000000001',
    name: 'Field',
    description: '',
    position: 0,
    createdAt: '',
    updatedAt: '',
    type,
  });

describe('additional field values', () => {
  it('preserves barcode leading zeros and typed values', () => {
    expect(checkCellValue(field('barcode'), '000123')).toEqual({ ok: true, value: '000123' });
    expect(checkCellValue(field('barcode'), 123).ok).toBe(false);
  });

  it('normalizes times without accepting dates, offsets, or an invalid clock', () => {
    expect(checkCellValue(field('time'), '00:00')).toEqual({ ok: true, value: '00:00:00' });
    expect(parseTimeOfDay('12:05 AM')).toBe('00:05:00');
    expect(parseTimeOfDay('2:30:45 PM')).toBe('14:30:45');
    for (const value of ['24:00', '12:60', '12:30:60', '2026-09-30T12:30Z', '12:30+02:00'])
      expect(checkCellValue(field('time'), value).ok).toBe(false);
    expect(formatTimeOfDay('14:30:00', 'en-US', '12h')).toMatch(/2:30:00\sPM/);
    expect(formatTimeOfDay('14:30:00', 'en-US', '24h')).toBe('14:30:00');
    for (const locale of ['en-US', 'de', 'ja', 'ko', 'ar-EG']) {
      expect(parseTimeOfDay(formatTimeOfDay('14:30:00', locale, '12h'), locale)).toBe('14:30:00');
    }
    const clock = field('time');
    const condition = { id: 'clock', fieldId: clock.id, operator: 'isBefore' as const, value: '14:45:00' };
    const context = { timeZone: 'UTC', now: new Date('2026-09-30T00:00:00Z') };
    expect(conditionMatches(clock, '14:30:00', condition, context)).toBe(true);
    expect(conditionMatches(clock, '15:00:00', condition, context)).toBe(false);
    expect(conditionMatches(clock, null, condition, context)).toBe(false);
  });

  it('keeps a finite amount with a supported currency code', () => {
    expect(checkCellValue(field('multiCurrency'), { amount: 12.5, code: 'EUR' })).toEqual({
      ok: true,
      value: { amount: 12.5, code: 'EUR' },
    });
    for (const value of [
      { amount: Infinity, code: 'USD' },
      { amount: null, code: 'USD' },
      { amount: 1, code: 'ZZZ' },
    ])
      expect(checkCellValue(field('multiCurrency'), value).ok).toBe(false);
    expect(parseMultiCurrency('EUR -12.5')).toEqual({ amount: -12.5, code: 'EUR' });
    expect(summaryKindsFor(field('multiCurrency'))).toContain('sum');
    expect(summaryKindsFor(field('multiCurrency'))).not.toContain('average');
  });

  it('requires canonical time filters and compares currency amounts', () => {
    for (const value of ['2:45 PM', '午後2:45:00', '14:45'])
      expect(
        checkCondition(field('time'), { id: 'clock', fieldId: field('time').id, operator: 'is', value })
          .usable,
      ).toBe(false);
    expect(
      checkCondition(field('time'), {
        id: 'clock',
        fieldId: field('time').id,
        operator: 'is',
        value: '14:45:00',
      }).usable,
    ).toBe(true);
    expect(operatorsFor('changeLog')).toEqual([]);
    expect(summaryKindsFor(field('changeLog'))).toEqual(['none', 'count']);
    expect(operatorsFor('multiCurrency')).toContain('gt');
    expect(
      conditionMatches(
        field('multiCurrency'),
        { code: 'EUR', amount: 12.5 },
        {
          id: 'amount',
          fieldId: field('multiCurrency').id,
          operator: 'gt',
          value: 10,
        },
        { timeZone: 'UTC', now: new Date() },
      ),
    ).toBe(true);
  });

  it('rounds currency amounts in decimal and uses the default code for bare amounts', () => {
    for (const [input, amount] of [
      [10.005, 10.01],
      [-10.005, -10.01],
      [0.1 + 0.2, 0.3],
      [1e-8, 0],
    ])
      expect(checkCellValue(field('multiCurrency'), { code: 'EUR', amount: input })).toEqual({
        ok: true,
        value: { code: 'EUR', amount },
      });
    expect(parseMultiCurrency('12.50', 'EUR')).toEqual({ code: 'EUR', amount: 12.5 });
    expect(canConvert('number', 'multiCurrency')).toBe(true);
    expect(canConvert('currency', 'multiCurrency')).toBe(true);
  });

  it('keeps change logs read-only and validates each button target', () => {
    expect(isComputedType('changeLog')).toBe(true);
    expect(checkCellValue(field('changeLog'), 'forged')).toEqual({
      ok: false,
      messageKey: 'data.value.computed',
    });
    for (const action of [
      { kind: 'runAutomation', automationId: 'aut00000000000001' },
      { kind: 'runScript', scriptId: 'scr00000000000001' },
    ])
      expect(FieldSpec.parse({ type: 'button', options: { action } }).options).toMatchObject({ action });
    expect(
      FieldSpec.safeParse({ type: 'button', options: { action: { kind: 'runScript', scriptId: 'bad' } } })
        .success,
    ).toBe(false);
  });
});
