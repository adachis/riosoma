import type { DigestSchedule } from '@riosoma/contracts';

/** A missed hour is caught up that day, and repeated daylight-saving hours share one slot. */
export function digestSlot(schedule: DigestSchedule, now: Date): string | null {
  if (schedule.frequency === 'off') return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: schedule.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  if (Number(parts.hour) < schedule.hour) return null;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (schedule.frequency === 'weekly' && new Date(`${date}T00:00:00Z`).getUTCDay() !== 1) return null;
  return `${schedule.frequency}:${date}`;
}
