import type { ReportFrequency } from '@riosoma/contracts';
import { fromWallClock, localDay } from '../automations/schedule.js';

/**
 * When scheduled reports go.  Every frequency sends at a local time of day in the schedule's own
 * time zone, so a 9:00 report stays at 9:00 across daylight saving changes.  A time the clocks
 * skip moves forward past the gap, and a repeated one takes its first instant, as automations do.
 * A monthly day past the end of a short month sends on that month's last day.
 */

const DAY = 86_400_000;
/** Every frequency sends within this many days: a month and a spare. */
const HORIZON_DAYS = 40;

function timeOfDay(at: string): number {
  const [hours, minutes] = at.split(':').map(Number);
  return (hours! * 60 + minutes!) * 60_000;
}

/** Whether the frequency sends on a local day, given as a UTC-based stand-in for its midnight. */
function sendsOn(frequency: ReportFrequency, day: number): boolean {
  const date = new Date(day);
  switch (frequency.kind) {
    case 'daily':
      return true;
    case 'weekly':
      return frequency.days.includes(date.getUTCDay());
    case 'monthly': {
      const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      return date.getUTCDate() === Math.min(frequency.day, last);
    }
  }
}

/**
 * The first send strictly after `after`.  Sends missed while the server was down are skipped
 * rather than made up, so a report that was due yesterday goes once, not once per day it missed.
 */
export function nextSendAfter(frequency: ReportFrequency, timeZone: string, after: Date): Date {
  const now = after.getTime();
  const time = timeOfDay(frequency.at);
  // Starting the day before covers a zone whose local date trails the instant's.
  let day = localDay(now, timeZone) - DAY;
  for (let i = 0; i <= HORIZON_DAYS; i += 1, day += DAY) {
    if (!sendsOn(frequency, day)) continue;
    const candidate = fromWallClock(day + time, timeZone);
    if (candidate > now) return new Date(candidate);
  }
  // Unreachable for a valid frequency: every one sends at least once a month.
  return new Date(now + DAY);
}
