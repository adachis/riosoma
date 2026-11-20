import { dayIn } from '@riosoma/contracts';

/**
 * Day arithmetic shared by every live read, kept apart from the SQL translation so an engine that
 * writes its own query syntax can use it without importing the SQL side, which would be a cycle.
 */

/** The first moment, in milliseconds, whose calendar day in `zone` is `day` or later. */
export function dayStart(day: string, zone: string): number {
  let low = Math.floor(Date.parse(`${day}T00:00:00.000Z`) / 1000) - 15 * 3600;
  let high = low + 30 * 3600;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (dayIn(zone, new Date(middle * 1000)) < day) low = middle + 1;
    else high = middle;
  }
  return low * 1000;
}

/** The calendar day after `day`, which is a `YYYY-MM-DD` day in no zone in particular. */
export function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
