import { describe, expect, it } from 'vitest';
import { firstRunAfter, fromWallClock, nextRunAfter, type ScheduleTrigger } from './schedule.js';

const schedule = (overrides: Partial<ScheduleTrigger> & Pick<ScheduleTrigger, 'every'>): ScheduleTrigger => ({
  kind: 'schedule',
  at: '09:00',
  weekday: 1,
  timeZone: 'UTC',
  ...overrides,
});
const at = (iso: string) => new Date(iso);

describe('schedules', () => {
  it('run daily at the local time, whatever the offset that day', () => {
    const daily = schedule({ every: { unit: 'day', n: 1 }, timeZone: 'America/New_York' });
    expect(firstRunAfter(daily, at('2026-03-07T12:00:00Z')).toISOString()).toBe('2026-03-07T14:00:00.000Z');
    expect(firstRunAfter(daily, at('2026-03-07T14:00:00Z')).toISOString()).toBe('2026-03-08T13:00:00.000Z');
    const previous = at('2026-03-07T14:00:00Z');
    expect(nextRunAfter(daily, previous, previous).toISOString()).toBe('2026-03-08T13:00:00.000Z');
    // Clocks fall back on November 1, 2026.
    const autumn = at('2026-10-31T13:00:00Z');
    expect(nextRunAfter(daily, autumn, autumn).toISOString()).toBe('2026-11-01T14:00:00.000Z');
  });

  it('count days in the schedule’s own time zone, not the server’s', () => {
    // 23:30 in Auckland is still the morning before in UTC.
    const late = schedule({ every: { unit: 'day', n: 2 }, at: '23:30', timeZone: 'Pacific/Auckland' });
    const first = firstRunAfter(late, at('2026-09-27T10:00:00Z'));
    expect(first.toISOString()).toBe('2026-09-27T10:30:00.000Z');
    expect(nextRunAfter(late, first, first).toISOString()).toBe('2026-09-29T10:30:00.000Z');
    // Auckland moves its clocks forward on September 27, 2026, so 23:30 was 11:30 UTC the day before.
    expect(firstRunAfter(late, at('2026-09-26T00:00:00Z')).toISOString()).toBe('2026-09-26T11:30:00.000Z');
  });

  it('run weekly on the local weekday', () => {
    // Monday 08:30 in Tokyo is Sunday 23:30 in UTC.
    const weekly = schedule({
      every: { unit: 'week', n: 1 },
      at: '08:30',
      weekday: 1,
      timeZone: 'Asia/Tokyo',
    });
    expect(firstRunAfter(weekly, at('2026-09-27T12:00:00Z')).toISOString()).toBe('2026-09-27T23:30:00.000Z');
    expect(firstRunAfter(weekly, at('2026-09-27T23:40:00Z')).toISOString()).toBe('2026-10-04T23:30:00.000Z');
    const everyOther = schedule({ every: { unit: 'week', n: 2 }, weekday: 3, timeZone: 'Europe/Berlin' });
    const first = firstRunAfter(everyOther, at('2026-09-27T12:00:00Z'));
    expect(first.toISOString()).toBe('2026-09-30T07:00:00.000Z');
    // Berlin leaves summer time on October 25, 2026.
    expect(nextRunAfter(everyOther, first, first).toISOString()).toBe('2026-10-14T07:00:00.000Z');
    expect(
      nextRunAfter(everyOther, at('2026-10-14T07:00:00Z'), at('2026-10-14T07:00:00Z')).toISOString(),
    ).toBe('2026-10-28T08:00:00.000Z');
  });

  it('run hourly on the hour, every so many hours of elapsed time', () => {
    const hourly = schedule({ every: { unit: 'hour', n: 3 } });
    const first = firstRunAfter(hourly, at('2026-09-27T10:17:00Z'));
    expect(first.toISOString()).toBe('2026-09-27T11:00:00.000Z');
    expect(nextRunAfter(hourly, first, first).toISOString()).toBe('2026-09-27T14:00:00.000Z');
    expect(nextRunAfter(hourly, first, at('2026-09-27T20:30:00Z')).toISOString()).toBe(
      '2026-09-27T23:00:00.000Z',
    );
  });

  it('skip runs missed while the server was down, keeping the time of day', () => {
    const daily = schedule({ every: { unit: 'day', n: 1 }, at: '06:15', timeZone: 'Europe/London' });
    const next = nextRunAfter(daily, at('2026-01-05T06:15:00Z'), at('2026-07-20T12:00:00Z'));
    expect(next.toISOString()).toBe('2026-07-21T05:15:00.000Z');
  });

  it('move a time skipped by the clocks forward, and take the first of a repeated one', () => {
    const skipped = Date.UTC(2026, 2, 8, 2, 30);
    expect(new Date(fromWallClock(skipped, 'America/New_York')).toISOString()).toBe(
      '2026-03-08T07:30:00.000Z',
    );
    const repeated = Date.UTC(2026, 10, 1, 1, 30);
    expect(new Date(fromWallClock(repeated, 'America/New_York')).toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });
});
