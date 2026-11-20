import { describe, expect, it } from 'vitest';
import { ReportFrequency } from '@riosoma/contracts';
import { nextSendAfter } from './schedule.js';

const at = (iso: string) => new Date(iso);
const next = (frequency: unknown, zone: string, after: string) =>
  nextSendAfter(ReportFrequency.parse(frequency), zone, at(after)).toISOString();

describe('report schedules', () => {
  it('send daily at the same local time on both sides of a daylight saving change', () => {
    const daily = { kind: 'daily', at: '09:00' };
    // New York moves its clocks forward on March 8, 2026: 9:00 is 14:00 UTC before and 13:00 after.
    expect(next(daily, 'America/New_York', '2026-03-07T12:00:00Z')).toBe('2026-03-07T14:00:00.000Z');
    expect(next(daily, 'America/New_York', '2026-03-07T14:00:00Z')).toBe('2026-03-08T13:00:00.000Z');
    expect(next(daily, 'America/New_York', '2026-03-08T13:00:00Z')).toBe('2026-03-09T13:00:00.000Z');
    // And back on November 1, 2026.
    expect(next(daily, 'America/New_York', '2026-10-31T13:00:00Z')).toBe('2026-11-01T14:00:00.000Z');
  });

  it('move a time the clocks skip forward past the gap, and take the first of a repeated one', () => {
    expect(next({ kind: 'daily', at: '02:30' }, 'America/New_York', '2026-03-07T08:00:00Z')).toBe(
      '2026-03-08T07:30:00.000Z',
    );
    expect(next({ kind: 'daily', at: '01:30' }, 'America/New_York', '2026-10-31T06:00:00Z')).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });

  it('send weekly on each chosen local weekday', () => {
    // Monday and Thursday at 08:30 in Tokyo, which is Sunday and Wednesday evening in UTC.
    const weekly = { kind: 'weekly', days: [4, 1, 1], at: '08:30' };
    expect(ReportFrequency.parse(weekly)).toEqual({ kind: 'weekly', days: [1, 4], at: '08:30' });
    expect(next(weekly, 'Asia/Tokyo', '2026-09-27T12:00:00Z')).toBe('2026-09-27T23:30:00.000Z');
    expect(next(weekly, 'Asia/Tokyo', '2026-09-27T23:30:00Z')).toBe('2026-09-30T23:30:00.000Z');
    // Berlin leaves summer time on October 25, 2026, between two Wednesdays.
    const wednesdays = { kind: 'weekly', days: [3], at: '09:00' };
    expect(next(wednesdays, 'Europe/Berlin', '2026-10-21T07:00:00Z')).toBe('2026-10-28T08:00:00.000Z');
  });

  it('send monthly on the chosen day, or the last day of a shorter month', () => {
    const last = { kind: 'monthly', day: 31, at: '18:00' };
    expect(next(last, 'UTC', '2026-01-31T18:00:00Z')).toBe('2026-02-28T18:00:00.000Z');
    expect(next(last, 'UTC', '2026-02-28T18:00:00Z')).toBe('2026-03-31T18:00:00.000Z');
    expect(next(last, 'UTC', '2026-04-01T00:00:00Z')).toBe('2026-04-30T18:00:00.000Z');
    // The first of the month in Sydney is still the last day of the one before in UTC.
    const first = { kind: 'monthly', day: 1, at: '07:00' };
    expect(next(first, 'Australia/Sydney', '2026-09-15T00:00:00Z')).toBe('2026-09-30T21:00:00.000Z');
  });

  it('skip sends missed while the server was down instead of making them up', () => {
    const daily = { kind: 'daily', at: '06:15' };
    expect(next(daily, 'Europe/London', '2026-07-20T12:00:00Z')).toBe('2026-07-21T05:15:00.000Z');
  });
});
