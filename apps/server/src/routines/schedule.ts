import type { RoutineSchedule } from '@riosoma/contracts';
import { nextSendAfter } from '../reports/schedule.js';

const HOUR = 3_600_000;

/**
 * The first run strictly after `after`.  Hourly routines run on the hour.  Daily, weekly, and
 * monthly ones run at a local time of day in the routine's time zone, the way scheduled reports
 * send, so a 9:00 routine stays at 9:00 across daylight saving changes.  Runs missed while the
 * server was down, or while the routine was paused, are skipped rather than made up.
 */
export function nextRunAfter(schedule: RoutineSchedule, timeZone: string, after: Date): Date {
  if (schedule.kind === 'hourly') return new Date(Math.floor(after.getTime() / HOUR) * HOUR + HOUR);
  return nextSendAfter(schedule, timeZone, after);
}
