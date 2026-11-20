import { describe, expect, it } from 'vitest';
import { inferRollup, rollupValue, sameValue } from './rollups.js';

const sample = (values: unknown[], result: unknown) => ({ values, linked: values.length, result });

describe('working out a rollup’s function', () => {
  it('finds the function that gives Airtable’s value for every record', () => {
    expect(inferRollup([sample([3, 2.5], 5.5), sample([1], 1)], 'number')).toEqual({ fn: 'sum', checked: 2 });
    expect(inferRollup([sample([3, 2.5], 3), sample([1, 4], 4)], 'number')).toEqual({
      fn: 'max',
      checked: 2,
    });
    expect(inferRollup([sample([2, 4], 3)], 'number')).toEqual({ fn: 'average', checked: 1 });
    expect(inferRollup([sample(['a', null, 'b'], 2)], 'number')).toEqual({ fn: 'count', checked: 1 });
    expect(inferRollup([sample(['Ada', 'Bea'], 'Ada, Bea')], 'singleLineText')).toEqual({
      fn: 'concatenate',
      checked: 1,
    });
    expect(inferRollup([sample([true, false], 0), sample([true], 1)], 'checkbox')).toEqual({
      fn: 'and',
      checked: 2,
    });
    expect(inferRollup([sample(['2026-01-05', '2026-03-01'], '2026-03-01T00:00:00.000Z')], 'date')).toEqual({
      fn: 'latest',
      checked: 1,
    });
  });

  it('prefers the likelier function when several fit', () => {
    expect(inferRollup([sample([1], 1)], 'number')?.fn).toBe('sum');
  });

  it('chooses by what the rollup produces when nothing can be checked', () => {
    expect(inferRollup([{ values: [], linked: 0, result: 0 }], 'number')).toEqual({ fn: 'sum', checked: 0 });
    expect(inferRollup([], 'singleLineText')).toEqual({ fn: 'concatenate', checked: 0 });
  });

  it('answers null when none of Riosoma’s functions gives Airtable’s values', () => {
    expect(inferRollup([sample([3, 2], 1)], 'number')).toBeNull();
  });

  it('computes values the way Riosoma does', () => {
    expect(rollupValue('countAll', { values: [null, 'a'], linked: 2 })).toBe(2);
    expect(rollupValue('countUnique', { values: ['a', 'a', ['b', 'a']], linked: 3 })).toBe(2);
    expect(rollupValue('arrayUnique', { values: ['a', 'a', 'b'], linked: 3 })).toEqual(['a', 'b']);
    expect(rollupValue('or', { values: [], linked: 0 })).toBe(false);
    expect(rollupValue('min', { values: ['b', 'a'], linked: 2 })).toBe('a');
  });

  it('compares values the way a person reads them', () => {
    expect(sameValue(0.1 + 0.2, 0.3)).toBe(true);
    expect(sameValue(1, true)).toBe(true);
    expect(sameValue(null, [])).toBe(true);
    expect(sameValue('2026-01-05', '2026-01-05T00:00:00.000Z')).toBe(true);
    expect(sameValue(['a', 'b'], ['a', 'c'])).toBe(false);
  });
});
