/**
 * The iCalendar document a calendar feed serves, following RFC 5545: CRLF line ends, lines folded
 * at 75 octets without splitting a character, text values escaped, and times in UTC.  Everything
 * here is pure, so the rules are tested apart from any database.
 */

/** When an event starts or ends: a whole day, as `YYYY-MM-DD`, or an instant. */
export type EventTime = { day: string } | { instant: Date };

export interface CalendarEvent {
  uid: string;
  summary: string;
  start: EventTime;
  /** Null for an event with no end of its own */
  end: EventTime | null;
  /** Plain text, with line breaks between lines */
  description: string;
  url: string | null;
  lastModified: Date;
}

export interface CalendarDocument {
  name: string;
  /** The zone calendar apps show the events' times in */
  timeZone: string;
  /** How often calendar apps are asked to check again */
  refreshMinutes: number;
  events: readonly CalendarEvent[];
}

export const CALENDAR_TYPE = 'text/calendar; charset=utf-8';
const PRODID = '-//Riosoma//Calendar feeds//EN';
const LINE_END = '\r\n';
/** The longest a line may be, in octets, not counting its line end */
const LINE_OCTETS = 75;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A value without the control characters no iCalendar value may hold.  Tabs are allowed, and line
 * feeds are kept only where the caller escapes them next.
 */
function withoutControls(value: string, keepLineFeeds: boolean): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    const control = code < 0x20 || code === 0x7f;
    if (!control || code === TAB || (keepLineFeeds && code === LINE_FEED)) out += char;
  }
  return out;
}

/**
 * A TEXT value: backslashes, semicolons, commas, and line breaks escaped, and control characters,
 * which no value may hold, left out.
 */
export function escapeText(value: string): string {
  return withoutControls(value.replace(/\r\n?/g, '\n'), true).replace(/[\\;,\n]/g, (char) =>
    char === '\n' ? '\\n' : `\\${char}`,
  );
}

/**
 * One content line folded so no line passes 75 octets: each continuation starts with a space,
 * which counts toward its 75, and a character is never split between two lines.
 */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line) <= LINE_OCTETS) return line;
  const parts: string[] = [];
  let current = '';
  let size = 0;
  let room = LINE_OCTETS;
  for (const char of line) {
    const octets = Buffer.byteLength(char);
    if (size + octets > room) {
      parts.push(current);
      current = '';
      size = 0;
      room = LINE_OCTETS - 1;
    }
    current += char;
    size += octets;
  }
  parts.push(current);
  return parts.join(`${LINE_END} `);
}

/** A day as an iCalendar DATE. */
export function icalDate(day: string): string {
  const match = DAY.exec(day);
  if (!match) throw new Error('A calendar day has to read YYYY-MM-DD');
  return `${match[1]}${match[2]}${match[3]}`;
}

/** An instant as an iCalendar DATE-TIME in UTC. */
export function icalInstant(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
}

export function addDays(day: string, count: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

/** The day an instant falls on in a zone. */
export function dayInZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: string) => parts.find((piece) => piece.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function timeOf(value: string | null): EventTime | null {
  if (!value) return null;
  if (DAY.test(value)) return { day: value };
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) ? { instant } : null;
}

function dayOf(time: EventTime, timeZone: string): string {
  return 'day' in time ? time.day : dayInZone(time.instant, timeZone);
}

/**
 * An event's start and end from a record's two dates, as a calendar view places them.  A date
 * without a time makes the whole event last whole days, with an instant read as its day in the
 * view's zone.  An end before the start counts as no end at all.  Null when there's no start.
 */
export function eventSpan(
  startValue: string | null,
  endValue: string | null,
  timeZone: string,
): { start: EventTime; end: EventTime | null } | null {
  let start = timeOf(startValue);
  let end = timeOf(endValue);
  if (!start) return null;
  if (end && ('day' in start || 'day' in end)) {
    start = { day: dayOf(start, timeZone) };
    end = { day: dayOf(end, timeZone) };
  }
  if (end && 'day' in start && 'day' in end && end.day < start.day) end = null;
  if (end && 'instant' in start && 'instant' in end && end.instant.getTime() < start.instant.getTime())
    end = null;
  return { start, end };
}

function duration(minutes: number): string {
  return minutes % 60 === 0 ? `PT${minutes / 60}H` : `PT${minutes}M`;
}

function eventLines(event: CalendarEvent): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${escapeText(event.uid)}`,
    `DTSTAMP:${icalInstant(event.lastModified)}`,
  ];
  if ('day' in event.start) {
    lines.push(`DTSTART;VALUE=DATE:${icalDate(event.start.day)}`);
    // An all-day end is the day after the last one.  With no end, the event lasts its one day,
    // said outright since not every calendar app reads the standard's default.
    const last = event.end && 'day' in event.end ? event.end.day : event.start.day;
    lines.push(`DTEND;VALUE=DATE:${icalDate(addDays(last, 1))}`);
  } else {
    lines.push(`DTSTART:${icalInstant(event.start.instant)}`);
    // A timed event with no end is a moment, which is what leaving the end out means.
    if (event.end && 'instant' in event.end) lines.push(`DTEND:${icalInstant(event.end.instant)}`);
  }
  lines.push(`SUMMARY:${escapeText(event.summary)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.url) lines.push(`URL:${withoutControls(event.url, false)}`);
  lines.push(`LAST-MODIFIED:${icalInstant(event.lastModified)}`, 'END:VEVENT');
  return lines;
}

/** The whole document, every line folded and ended with CRLF. */
export function writeCalendar(document: CalendarDocument): string {
  const name = escapeText(document.name);
  const refresh = duration(document.refreshMinutes);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `NAME:${name}`,
    `X-WR-CALNAME:${name}`,
    `X-WR-TIMEZONE:${escapeText(document.timeZone)}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${refresh}`,
    `X-PUBLISHED-TTL:${refresh}`,
    ...document.events.flatMap(eventLines),
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join(LINE_END) + LINE_END;
}
