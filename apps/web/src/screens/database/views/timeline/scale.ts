import type { TimelineZoom } from '@riosoma/contracts';

/**
 * The time axis of timelines and Gantt charts.  Days are whole numbers counted from 1970-01-01, so
 * spans compare and subtract without time zones getting involved.  A record's dates become days in
 * its fields' own zones before they arrive here.
 */

const DAY_MS = 86_400_000;

/** CSS pixels per day at each zoom.  One column of the header is one unit of the zoom wide. */
export const PX_PER_DAY: Record<TimelineZoom, number> = {
  day: 40,
  week: 14,
  month: 4,
  quarter: 2,
  year: 0.5,
};

/** Units of padding around the records, so there is room to drag a bar past the first or last. */
const PADDING: Record<TimelineZoom, number> = { day: 14, week: 6, month: 4, quarter: 3, year: 2 };

/** Past this width the axis narrows around today, well inside every browser's layout limits. */
const MAX_AXIS_PX = 4_000_000;

const MONTHS: Record<TimelineZoom, number> = { day: 0, week: 0, month: 1, quarter: 3, year: 12 };

/** A `YYYY-MM-DD` date as a day number. */
export function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

/** A day number as `YYYY-MM-DD`. */
export function dayString(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Noon on a day, for formatting it with `timeZone: 'UTC'` without the date slipping. */
export function dayDate(day: number): Date {
  return new Date(day * DAY_MS + DAY_MS / 2);
}

/** 0 for Sunday through 6 for Saturday. */
export function weekday(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

function addMonths(day: number, months: number): number {
  const date = new Date(day * DAY_MS);
  const dayOfMonth = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(date.getTime());
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  // The 31st of a month becomes the last day of a shorter one.
  date.setUTCDate(Math.min(dayOfMonth, last.getUTCDate()));
  return Math.round(date.getTime() / DAY_MS);
}

/** A day moved by whole units of a zoom.  Months keep their day, or take the last day of a shorter one. */
export function addUnits(day: number, zoom: TimelineZoom, count: number): number {
  if (zoom === 'day') return day + count;
  if (zoom === 'week') return day + 7 * count;
  return addMonths(day, MONTHS[zoom] * count);
}

/** The first day of the unit a day falls in.  Weeks start on the locale's first weekday. */
export function unitStart(day: number, zoom: TimelineZoom, weekStart: number): number {
  if (zoom === 'day') return day;
  if (zoom === 'week') return day - ((weekday(day) - weekStart + 7) % 7);
  const date = new Date(day * DAY_MS);
  const month = date.getUTCMonth();
  date.setUTCMonth(zoom === 'month' ? month : zoom === 'quarter' ? month - (month % 3) : 0, 1);
  return Math.round(date.getTime() / DAY_MS);
}

/** The larger unit that groups a zoom's columns in the header's top row, if there is one. */
export function parentZoom(zoom: TimelineZoom): TimelineZoom | null {
  if (zoom === 'day' || zoom === 'week') return 'month';
  if (zoom === 'month' || zoom === 'quarter') return 'year';
  return null;
}

export interface Cell {
  start: number;
  /** The day after the cell's last day */
  end: number;
}

/** The units of a zoom that overlap the days from `from` to `to`, inclusive. */
export function cells(from: number, to: number, zoom: TimelineZoom, weekStart: number): Cell[] {
  const result: Cell[] = [];
  for (let start = unitStart(from, zoom, weekStart); start <= to;) {
    const end = addUnits(start, zoom, 1);
    result.push({ start, end });
    start = end;
  }
  return result;
}

export interface Axis {
  /** The first day drawn */
  start: number;
  /** The day after the last day drawn */
  end: number;
  zoom: TimelineZoom;
  px: number;
  /** CSS pixels from the axis start to the start of a day */
  x(day: number): number;
  width: number;
}

/**
 * The days a timeline draws: every record, today, and some room on both sides, in whole units, at
 * least as wide as the space it has.  An axis wider than any layout allows narrows around today.
 */
export function makeAxis(
  first: number,
  last: number,
  today: number,
  zoom: TimelineZoom,
  weekStart: number,
  minWidth: number,
): Axis {
  const px = PX_PER_DAY[zoom];
  let start = unitStart(addUnits(Math.min(first, today), zoom, -PADDING[zoom]), zoom, weekStart);
  let end = addUnits(unitStart(Math.max(last, today), zoom, weekStart), zoom, PADDING[zoom] + 1);
  const least = Math.ceil(minWidth / px);
  if (end - start < least) end = addUnits(unitStart(start + least, zoom, weekStart), zoom, 1);
  const most = Math.floor(MAX_AXIS_PX / px);
  if (end - start > most) {
    start = Math.max(start, unitStart(today - Math.floor(most / 2), zoom, weekStart));
    end = Math.min(end, start + most);
  }
  return { start, end, zoom, px, x: (day) => (day - start) * px, width: (end - start) * px };
}
