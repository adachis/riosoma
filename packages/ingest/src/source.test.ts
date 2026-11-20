import { describe, expect, it } from 'vitest';
import { cell, EMPTY_CELL, isBlankRow } from './source.js';

describe('cell', () => {
  it('keeps blank distinct from zero', () => {
    expect(cell(0)).toEqual({ v: 0, t: 'number' });
    expect(cell('')).toBe(EMPTY_CELL);
    expect(cell('   ')).toBe(EMPTY_CELL);
    expect(cell(null)).toBe(EMPTY_CELL);
    expect(cell(undefined)).toBe(EMPTY_CELL);
  });

  it('keeps an identifier as text, zeros included', () => {
    expect(cell('00412')).toEqual({ v: '00412', t: 'text' });
  });

  it('keeps text as received', () => {
    expect(cell(' Northwind ')).toEqual({ v: ' Northwind ', t: 'text' });
  });

  it('types booleans and finite numbers, and treats the rest as blank', () => {
    expect(cell(false)).toEqual({ v: false, t: 'bool' });
    expect(cell(-12.5)).toEqual({ v: -12.5, t: 'number' });
    expect(cell(Number.NaN)).toBe(EMPTY_CELL);
    expect(cell(Number.POSITIVE_INFINITY)).toBe(EMPTY_CELL);
  });

  it('writes a date as a day, and a date with a time as both', () => {
    expect(cell(new Date('2026-03-01T00:00:00Z'))).toEqual({ v: '2026-03-01', t: 'date' });
    expect(cell(new Date('2026-03-01T09:30:00Z'))).toEqual({ v: '2026-03-01T09:30:00', t: 'date' });
    expect(cell(new Date('nonsense'))).toBe(EMPTY_CELL);
  });
});

describe('isBlankRow', () => {
  it('is true only when every cell is blank', () => {
    expect(isBlankRow([])).toBe(true);
    expect(isBlankRow([EMPTY_CELL, cell('')])).toBe(true);
    expect(isBlankRow([EMPTY_CELL, cell(0)])).toBe(false);
  });
});
