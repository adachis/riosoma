import { minutesOf, type BookingPageSettings } from '@riosoma/contracts';
import { fromWallClock, localDay, wallClock } from '../automations/schedule.js';

/**
 * When a booking page has open times.  Everything here is pure, so the rules are tested apart
 * from any database.
 *
 * Times are laid out on the page's own wall clock: each stretch of opening hours starts a time at
 * its beginning and another every booking length plus buffer after it, for as long as a whole
 * booking fits before the stretch ends.  A wall-clock time that a daylight saving change skips
 * has no booking, and one it repeats has only its first.  A booking then lasts its length in real
 * minutes, so every time is exactly as long as any other.
 *
 * A time is open when fewer records than its places overlap it, with the buffer added on both
 * sides, so a buffer keeps a gap after a booking as well as before one.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;

export type Availability = Pick<
  BookingPageSettings,
  | 'timeZone'
  | 'lengthMinutes'
  | 'bufferMinutes'
  | 'hours'
  | 'blockedDays'
  | 'maxDaysAhead'
  | 'minNoticeMinutes'
  | 'places'
>;

/** A time, as milliseconds since the epoch.  The end is left out. */
export interface Span {
  start: number;
  end: number;
}

/** A local day as `YYYY-MM-DD`, from its UTC-based stand-in. */
export function dayText(day: number): string {
  return new Date(day).toISOString().slice(0, 10);
}

/** The first and last local days, as UTC-based stand-ins, that can have open times. */
export function bookableDays(page: Availability, now: number): { first: number; last: number } {
  const today = localDay(now, page.timeZone);
  return {
    first: Math.max(today, localDay(now + page.minNoticeMinutes * MINUTE, page.timeZone)),
    last: today + page.maxDaysAhead * DAY,
  };
}

/**
 * Every time that starts in `[from, to)` within the hours, off the blocked days, no sooner than
 * the notice allows, and no further ahead than the page reaches, in order.  Nothing is counted.
 */
export function candidateSlots(page: Availability, from: number, to: number, now: number): Span[] {
  const zone = page.timeZone;
  const { first, last } = bookableDays(page, now);
  const earliest = now + page.minNoticeMinutes * MINUTE;
  const slots: Span[] = [];
  // A day on either side covers zones whose local days start before or after UTC's.
  const lastDay = Math.min(last, localDay(to, zone) + DAY);
  for (let day = Math.max(first, localDay(from, zone) - DAY); day <= lastDay; day += DAY)
    for (const slot of slotsOnDay(page, day))
      if (slot.start >= earliest && slot.start >= from && slot.start < to) slots.push(slot);
  return slots;
}

/**
 * Every time a local day's hours offer, as a UTC-based stand-in for the day, whatever the notice
 * and however far ahead it is.  A blocked day has none.
 */
export function slotsOnDay(page: Availability, day: number): Span[] {
  const zone = page.timeZone;
  if (new Set(page.blockedDays).has(dayText(day))) return [];
  const length = page.lengthMinutes * MINUTE;
  const step = (page.lengthMinutes + page.bufferMinutes) * MINUTE;
  const slots: Span[] = [];
  for (const interval of page.hours[new Date(day).getUTCDay()] ?? []) {
    const open = day + minutesOf(interval.start) * MINUTE;
    const close = day + minutesOf(interval.end) * MINUTE;
    const closing = fromWallClock(close, zone);
    for (let wall = open; wall + length <= close; wall += step) {
      const start = fromWallClock(wall, zone);
      // The clocks skipped this time, so it would only repeat a later one.
      if (wallClock(start, zone) !== wall) continue;
      const end = start + length;
      if (end > closing) continue;
      slots.push({ start, end });
    }
  }
  return slots;
}

/** How many of the spans, sorted by start, overlap a time once the buffer is added on both sides. */
export function overlapping(slot: Span, sorted: readonly Span[], bufferMinutes: number): number {
  const from = slot.start - bufferMinutes * MINUTE;
  const to = slot.end + bufferMinutes * MINUTE;
  let count = 0;
  for (const span of sorted) {
    if (span.start >= to) break;
    // A record that starts and ends at once still takes its moment.
    if (Math.max(span.end, span.start + 1) > from) count += 1;
  }
  return count;
}

export function byStart(spans: readonly Span[]): Span[] {
  return [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** The times among `slots` that fewer than the page's places of the existing spans overlap. */
export function openSlots(page: Availability, slots: readonly Span[], spans: readonly Span[]): Span[] {
  const sorted = byStart(spans);
  return slots.filter((slot) => overlapping(slot, sorted, page.bufferMinutes) < page.places);
}

/** The stretch of time whose records could overlap any of these times. */
export function reach(page: Availability, slots: readonly Span[]): Span | null {
  if (!slots.length) return null;
  const buffer = page.bufferMinutes * MINUTE;
  return {
    start: slots[0]!.start - buffer,
    end: slots.reduce((latest, slot) => Math.max(latest, slot.end), slots[0]!.end) + buffer,
  };
}
