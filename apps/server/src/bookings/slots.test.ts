import { describe, expect, it } from 'vitest';
import type { OpenInterval } from '@riosoma/contracts';
import { bookableDays, candidateSlots, dayText, openSlots, type Availability, type Span } from './slots.js';

/**
 * The slot math on its own.  Each test hands the functions its own "now", so none of them reads
 * the clock, and the dates are chosen for the daylight saving changes around them.
 */

const MINUTE = 60_000;
const at = (iso: string) => Date.parse(iso);
const iso = (time: number) => new Date(time).toISOString();
const starts = (slots: readonly Span[]) => slots.map((slot) => iso(slot.start));

const hours = (open: OpenInterval[], days: number[] = [1, 2, 3, 4, 5]): OpenInterval[][] =>
  Array.from({ length: 7 }, (_, day) => (days.includes(day) ? open : []));

function page(overrides: Partial<Availability> = {}): Availability {
  return {
    timeZone: 'America/New_York',
    lengthMinutes: 60,
    bufferMinutes: 0,
    hours: hours([{ start: '09:00', end: '11:00' }]),
    blockedDays: [],
    maxDaysAhead: 60,
    minNoticeMinutes: 0,
    places: 1,
    ...overrides,
  };
}

describe('laying out times across daylight saving changes', () => {
  it('keeps 9:00 at 9:00 on the wall clock when New York springs forward', () => {
    const now = at('2026-03-01T12:00:00Z');
    const slots = candidateSlots(page(), at('2026-03-05T00:00:00Z'), at('2026-03-11T00:00:00Z'), now);
    expect(starts(slots)).toEqual([
      // Thursday and Friday in standard time, five hours behind UTC
      '2026-03-05T14:00:00.000Z',
      '2026-03-05T15:00:00.000Z',
      '2026-03-06T14:00:00.000Z',
      '2026-03-06T15:00:00.000Z',
      // Monday and Tuesday in daylight time, four hours behind
      '2026-03-09T13:00:00.000Z',
      '2026-03-09T14:00:00.000Z',
      '2026-03-10T13:00:00.000Z',
      '2026-03-10T14:00:00.000Z',
    ]);
    expect(slots.every((slot) => slot.end - slot.start === 60 * MINUTE)).toBe(true);
  });

  it('offers nothing at a time the clocks skip, and keeps every booking its full length', () => {
    const now = at('2026-03-01T12:00:00Z');
    const night = page({ hours: hours([{ start: '01:00', end: '04:00' }], [0]) });
    const slots = candidateSlots(night, at('2026-03-08T00:00:00Z'), at('2026-03-09T00:00:00Z'), now);
    // 1:00 in standard time, then 3:00 in daylight time.  2:00 never happens that night.
    expect(starts(slots)).toEqual(['2026-03-08T06:00:00.000Z', '2026-03-08T07:00:00.000Z']);
    expect(slots.map((slot) => (slot.end - slot.start) / MINUTE)).toEqual([60, 60]);
  });

  it('offers a repeated wall-clock time once when the clocks fall back', () => {
    const now = at('2026-10-25T12:00:00Z');
    const night = page({ hours: hours([{ start: '00:00', end: '03:00' }], [0]) });
    const slots = candidateSlots(night, at('2026-11-01T00:00:00Z'), at('2026-11-02T00:00:00Z'), now);
    // Midnight and 1:00 in daylight time, then 2:00 in standard time.  The second 1:00 is left out.
    expect(starts(slots)).toEqual([
      '2026-11-01T04:00:00.000Z',
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T07:00:00.000Z',
    ]);
  });

  it('follows each zone’s own offset and change, south of the equator too', () => {
    const now = at('2026-03-30T00:00:00Z');
    const from = at('2026-04-01T00:00:00Z');
    const to = at('2026-04-08T00:00:00Z');
    const morning = { hours: hours([{ start: '09:00', end: '10:00' }], [2, 5]) };
    const kolkata = candidateSlots(page({ ...morning, timeZone: 'Asia/Kolkata' }), from, to, now);
    expect(starts(kolkata)).toEqual(['2026-04-03T03:30:00.000Z', '2026-04-07T03:30:00.000Z']);
    // Auckland leaves daylight time on the first Sunday of April, from 13 hours ahead to 12.
    const auckland = candidateSlots(page({ ...morning, timeZone: 'Pacific/Auckland' }), from, to, now);
    expect(starts(auckland)).toEqual(['2026-04-02T20:00:00.000Z', '2026-04-06T21:00:00.000Z']);
  });

  it('counts days ahead in the page’s zone, not in UTC', () => {
    // Early Tuesday morning in Auckland is still Monday in UTC.
    const now = at('2026-06-01T13:00:00Z');
    const days = bookableDays(page({ timeZone: 'Pacific/Auckland', maxDaysAhead: 2 }), now);
    expect([dayText(days.first), dayText(days.last)]).toEqual(['2026-06-02', '2026-06-04']);
  });
});

describe('what keeps a time from being offered', () => {
  const monday = at('2026-03-02T05:00:00Z');
  const week = [at('2026-03-02T00:00:00Z'), at('2026-03-09T00:00:00Z')] as const;

  it('asks for the minimum notice before a time', () => {
    const now = at('2026-03-02T13:30:00Z');
    const slots = candidateSlots(
      page({ hours: hours([{ start: '09:00', end: '12:00' }], [1]), minNoticeMinutes: 120 }),
      ...week,
      now,
    );
    // It's 8:30 in New York, so 10:00 is only an hour and a half away.
    expect(starts(slots)).toEqual(['2026-03-02T16:00:00.000Z']);
  });

  it('reaches only so many days ahead, and skips blocked days', () => {
    const slots = candidateSlots(page({ maxDaysAhead: 2, blockedDays: ['2026-03-03'] }), ...week, monday);
    expect(starts(slots)).toEqual([
      '2026-03-02T14:00:00.000Z',
      '2026-03-02T15:00:00.000Z',
      '2026-03-04T14:00:00.000Z',
      '2026-03-04T15:00:00.000Z',
    ]);
  });

  it('spaces times by the length and the buffer, with several stretches in a day', () => {
    const split = page({
      lengthMinutes: 30,
      bufferMinutes: 15,
      hours: hours(
        [
          { start: '09:00', end: '11:15' },
          { start: '13:00', end: '14:00' },
        ],
        [1],
      ),
    });
    const slots = candidateSlots(split, ...week, monday);
    expect(starts(slots)).toEqual([
      '2026-03-02T14:00:00.000Z',
      '2026-03-02T14:45:00.000Z',
      '2026-03-02T15:30:00.000Z',
      '2026-03-02T18:00:00.000Z',
    ]);
  });

  it('keeps the buffer free on both sides of a record, wherever the record falls', () => {
    const split = page({
      lengthMinutes: 30,
      bufferMinutes: 15,
      hours: hours([{ start: '09:00', end: '11:15' }], [1]),
    });
    const slots = candidateSlots(split, ...week, monday);
    // A record on the grid blocks only its own time.
    const onGrid = [{ start: at('2026-03-02T14:45:00Z'), end: at('2026-03-02T15:15:00Z') }];
    expect(starts(openSlots(split, slots, onGrid))).toEqual([
      '2026-03-02T14:00:00.000Z',
      '2026-03-02T15:30:00.000Z',
    ]);
    // One off the grid, 10:00 to 10:30, is too close to 9:45 and to 10:30 alike.
    const offGrid = [{ start: at('2026-03-02T15:00:00Z'), end: at('2026-03-02T15:30:00Z') }];
    expect(starts(openSlots(split, slots, offGrid))).toEqual(['2026-03-02T14:00:00.000Z']);
  });

  it('lets a class take bookings until its places are gone', () => {
    const lesson = page({ places: 3, hours: hours([{ start: '09:00', end: '10:00' }], [1]) });
    const slots = candidateSlots(lesson, ...week, monday);
    const booking = { start: at('2026-03-02T14:00:00Z'), end: at('2026-03-02T15:00:00Z') };
    expect(openSlots(lesson, slots, [booking, booking])).toHaveLength(1);
    expect(openSlots(lesson, slots, [booking, booking, booking])).toHaveLength(0);
    // A record that ends as the class starts takes no place in it.
    const before = { start: at('2026-03-02T13:00:00Z'), end: at('2026-03-02T14:00:00Z') };
    expect(openSlots(lesson, slots, [booking, booking, before])).toHaveLength(1);
  });
});
