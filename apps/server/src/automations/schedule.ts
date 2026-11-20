import type { AutomationTrigger } from '@riosoma/contracts';

/**
 * When scheduled automations run.  Daily and weekly schedules run at a local time of day in their
 * own time zone, so a 9:00 run stays at 9:00 across daylight saving changes.  Hourly schedules run
 * on the hour, every so many hours of elapsed time.
 */
export type ScheduleTrigger = Extract<AutomationTrigger, { kind: 'schedule' }>;

const HOUR = 3_600_000;
const DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let result = formatters.get(zone);
  if (!result) {
    result = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    if (formatters.size >= 128) formatters.clear();
    formatters.set(zone, result);
  }
  return result;
}

/** The wall clock in a zone at an instant, as if that wall clock were UTC. */
export function wallClock(time: number, zone: string): number {
  const parts = formatter(zone).formatToParts(time);
  const get = (name: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === name)!.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
}

/**
 * The instant a zone's wall clock shows `wall` (a UTC-based stand-in).  A repeated hour takes its
 * first instant, and a time skipped by a daylight saving change moves forward past the gap.
 */
export function fromWallClock(wall: number, zone: string): number {
  const offsets = [-2, -1, 0, 1, 2].map((day) => {
    const instant = wall + day * DAY;
    return wallClock(instant, zone) - Math.floor(instant / 1000) * 1000;
  });
  const candidates = [...new Set(offsets)].map((offset) => wall - offset).sort((a, b) => a - b);
  return (
    candidates.find((t) => wallClock(t, zone) === wall) ??
    candidates.find((t) => wallClock(t, zone) > wall) ??
    wall
  );
}

/** Midnight of the zone’s local day at an instant, as a UTC-based stand-in. */
export function localDay(time: number, zone: string): number {
  const wall = wallClock(time, zone);
  return wall - (((wall % DAY) + DAY) % DAY);
}

function at(trigger: ScheduleTrigger): number {
  const [hours, minutes] = trigger.at.split(':').map(Number);
  return (hours! * 60 + minutes!) * 60_000;
}

/** The first time the schedule runs after `after`. */
export function firstRunAfter(trigger: ScheduleTrigger, after: Date): Date {
  const now = after.getTime();
  if (trigger.every.unit === 'hour') return new Date(Math.floor(now / HOUR) * HOUR + HOUR);
  const zone = trigger.timeZone;
  let day = localDay(now, zone);
  for (let i = 0; i < 16; i += 1, day += DAY) {
    if (trigger.every.unit === 'week' && new Date(day).getUTCDay() !== trigger.weekday) continue;
    const candidate = fromWallClock(day + at(trigger), zone);
    if (candidate > now) return new Date(candidate);
  }
  // Unreachable for a valid schedule: every weekday falls within the next 16 days.
  return new Date(now + DAY);
}

/** The run after one that was due at `previous`, skipping any that `now` has already passed. */
export function nextRunAfter(trigger: ScheduleTrigger, previous: Date, now: Date): Date {
  const n = trigger.every.n;
  let next: number;
  if (trigger.every.unit === 'hour') {
    next = previous.getTime() + n * HOUR;
    if (next <= now.getTime()) next += Math.ceil((now.getTime() - next + 1) / (n * HOUR)) * n * HOUR;
    return new Date(next);
  }
  const zone = trigger.timeZone;
  const step = (trigger.every.unit === 'week' ? 7 * n : n) * DAY;
  let day = localDay(previous.getTime(), zone) + step;
  next = fromWallClock(day + at(trigger), zone);
  if (next <= now.getTime()) {
    const behind = Math.ceil((localDay(now.getTime(), zone) - day) / step);
    day += Math.max(0, behind) * step;
    next = fromWallClock(day + at(trigger), zone);
    while (next <= now.getTime()) {
      day += step;
      next = fromWallClock(day + at(trigger), zone);
    }
  }
  return new Date(next);
}
