import { describe, expect, it } from 'vitest';
import { detectSeries, type SeriesItem } from './series';

const numbers = (...values: number[]): SeriesItem[] => values.map((value) => ({ kind: 'number', value }));
const dates = (...values: string[]): SeriesItem[] => values.map((value) => ({ kind: 'date', value }));
const texts = (...values: string[]): SeriesItem[] => values.map((value) => ({ kind: 'text', value }));

/** The values at the positions after the source, or before it for negative positions. */
function run(items: SeriesItem[], positions: number[], options = { copy: false, locale: 'en-US' }) {
  const series = detectSeries(items, options);
  return positions.map((position) => series.at(position).value);
}
const after = (items: SeriesItem[], count = 3, locale = 'en-US') =>
  run(
    items,
    Array.from({ length: count }, (_, index) => items.length + index),
    { copy: false, locale },
  );
const before = (items: SeriesItem[], count = 3) =>
  run(
    items,
    Array.from({ length: count }, (_, index) => -1 - index),
  );

describe('number series', () => {
  it('continues the step of two or more numbers, forward and backward', () => {
    expect(after(numbers(1, 2))).toEqual([3, 4, 5]);
    expect(after(numbers(10, 20, 30))).toEqual([40, 50, 60]);
    expect(after(numbers(5, 3))).toEqual([1, -1, -3]);
    expect(before(numbers(3, 4))).toEqual([2, 1, 0]);
  });

  it('keeps decimals clean and fits a line through uneven steps', () => {
    expect(after(numbers(0.1, 0.2))).toEqual([0.3, 0.4, 0.5]);
    expect(after(numbers(1.25, 1.5))).toEqual([1.75, 2, 2.25]);
    expect(after(numbers(1, 2, 4), 2)).toEqual([5.33333333333, 6.83333333333]);
  });

  it('repeats a single number, as spreadsheets do', () => {
    expect(after(numbers(7))).toEqual([7, 7, 7]);
  });
});

describe('date series', () => {
  it('counts on by a day from one date, and by the step between several', () => {
    expect(after(dates('2026-09-27'))).toEqual(['2026-09-28', '2026-09-29', '2026-09-30']);
    expect(before(dates('2026-03-01'), 2)).toEqual(['2026-02-28', '2026-02-27']);
    expect(after(dates('2026-12-30', '2026-12-31'), 2)).toEqual(['2027-01-01', '2027-01-02']);
  });

  it('continues by week', () => {
    expect(after(dates('2026-09-07', '2026-09-14'))).toEqual(['2026-09-21', '2026-09-28', '2026-10-05']);
  });

  it('continues by month, keeping the day and falling back to the month’s last day', () => {
    expect(after(dates('2026-01-15', '2026-02-15'))).toEqual(['2026-03-15', '2026-04-15', '2026-05-15']);
    expect(after(dates('2026-01-31', '2026-02-28'), 4)).toEqual([
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
    ]);
    expect(after(dates('2026-01-31', '2026-03-31'), 2)).toEqual(['2026-05-31', '2026-07-31']);
    expect(before(dates('2026-03-31', '2026-04-30'), 2)).toEqual(['2026-02-28', '2026-01-31']);
  });

  it('stays on month ends through leap years', () => {
    expect(after(dates('2023-12-31', '2024-01-31'), 3)).toEqual(['2024-02-29', '2024-03-31', '2024-04-30']);
    expect(after(dates('2023-02-28', '2023-03-31'), 3)).toEqual(['2023-04-30', '2023-05-31', '2023-06-30']);
    expect(after(dates('2024-02-29', '2024-03-31'), 2)).toEqual(['2024-04-30', '2024-05-31']);
  });

  it('continues by year, keeping February 29 for leap years', () => {
    expect(after(dates('2024-02-29', '2025-02-28'), 4)).toEqual([
      '2026-02-28',
      '2027-02-28',
      '2028-02-29',
      '2029-02-28',
    ]);
    expect(after(dates('2020-06-01', '2022-06-01'), 2)).toEqual(['2024-06-01', '2026-06-01']);
  });

  it('keeps the time of day on dates with times', () => {
    expect(after(dates('2026-01-31T09:30:00.000Z', '2026-02-28T09:30:00.000Z'), 2)).toEqual([
      '2026-03-31T09:30:00.000Z',
      '2026-04-30T09:30:00.000Z',
    ]);
    expect(after(dates('2026-09-27T23:00:00.000Z'), 1)).toEqual(['2026-09-28T23:00:00.000Z']);
    expect(after(dates('2026-09-27T08:00:00.000Z', '2026-09-27T10:00:00.000Z'), 2)).toEqual([
      '2026-09-27T12:00:00.000Z',
      '2026-09-27T14:00:00.000Z',
    ]);
  });
});

describe('text series', () => {
  it('counts on from text that ends in a number, keeping zero padding', () => {
    expect(after(texts('Item 9'))).toEqual(['Item 10', 'Item 11', 'Item 12']);
    expect(after(texts('Item 1', 'Item 3'))).toEqual(['Item 5', 'Item 7', 'Item 9']);
    expect(after(texts('A-007'))).toEqual(['A-008', 'A-009', 'A-010']);
    expect(after(texts('99'))).toEqual(['100', '101', '102']);
    expect(before(texts('Room 2'))).toEqual(['Room 1', 'Room 0', 'Room 1']);
  });

  it('continues weekday and month names, long or short, in the case they’re written', () => {
    expect(after(texts('Monday'))).toEqual(['Tuesday', 'Wednesday', 'Thursday']);
    expect(after(texts('Fri'), 4)).toEqual(['Sat', 'Sun', 'Mon', 'Tue']);
    expect(after(texts('Mon', 'Wed'))).toEqual(['Fri', 'Sun', 'Tue']);
    expect(after(texts('november'))).toEqual(['december', 'january', 'february']);
    expect(after(texts('OCT'))).toEqual(['NOV', 'DEC', 'JAN']);
    expect(after(texts('Sept'), 1)).toEqual(['Oct']);
    expect(before(texts('January'), 2)).toEqual(['December', 'November']);
    expect(after(texts('lundi'), 2, 'fr')).toEqual(['mardi', 'mercredi']);
  });

  it('repeats anything else, cycling through several cells', () => {
    expect(after(texts('North'))).toEqual(['North', 'North', 'North']);
    expect(after(texts('North', 'South'), 4)).toEqual(['North', 'South', 'North', 'South']);
    expect(before(texts('North', 'South'), 2)).toEqual(['South', 'North']);
    expect(after(texts('Item 1', 'Task 2'), 2)).toEqual(['Item 1', 'Task 2']);
    expect(after(texts('Mon', 'Mon', 'Fri'), 2)).toEqual(['Mon', 'Mon']);
  });
});

describe('everything else', () => {
  it('repeats mixed and other cells, and copies when asked to', () => {
    const mixed: SeriesItem[] = [
      { kind: 'number', value: 1 },
      { kind: 'text', value: 'a' },
    ];
    expect(after(mixed, 3)).toEqual([1, 'a', 1]);
    const choices: SeriesItem[] = [
      { kind: 'other', value: ['cho0000000000001'] },
      { kind: 'other', value: true },
    ];
    expect(after(choices, 2)).toEqual([['cho0000000000001'], true]);
    expect(run(numbers(1, 2), [2, 3, -1], { copy: true, locale: 'en-US' })).toEqual([1, 2, 2]);
    expect(run(texts('Item 9'), [1, 2], { copy: true, locale: 'en-US' })).toEqual(['Item 9', 'Item 9']);
    expect(detectSeries(dates('2026-01-01'), { copy: true, locale: 'en-US' }).kind).toBe('repeat');
  });

  it('says which source cell a position takes after', () => {
    const series = detectSeries(texts('a', 'b', 'c'), { copy: false, locale: 'en-US' });
    expect([3, 4, 5, -1].map((position) => series.from(position))).toEqual([0, 1, 2, 2]);
    expect(() => detectSeries([], { copy: false, locale: 'en-US' })).toThrow();
  });
});
