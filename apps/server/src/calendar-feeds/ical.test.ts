import { describe, expect, it } from 'vitest';
import {
  escapeText,
  eventSpan,
  foldLine,
  icalInstant,
  writeCalendar,
  type CalendarDocument,
  type CalendarEvent,
} from './ical.js';
import { parseCalendar, unescapeText } from './ical.test-helpers.js';
import { matchesTag } from './routes.js';

/**
 * The document the feed writes, checked against RFC 5545 by the strict reader in
 * `ical.test-helpers.ts`, which is written by hand for these tests.
 */

const modified = new Date(Date.UTC(2026, 2, 4, 5, 6, 7));

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    uid: 'recAAAAAAAAAAAAAA.viwAAAAAAAAAAAAAA@riosoma',
    summary: 'Launch',
    start: { day: '2026-03-10' },
    end: null,
    description: '',
    url: 'https://riosoma.example/db1/tbl1/viw1/rec1',
    lastModified: modified,
    ...overrides,
  };
}

function calendar(events: CalendarEvent[], name = 'Launches: Calendar'): CalendarDocument {
  return { name, timeZone: 'America/Chicago', refreshMinutes: 60, events };
}

describe('text values', () => {
  it('escapes backslashes, semicolons, commas, and every kind of line break', () => {
    expect(escapeText('a\\b;c,d\ne\r\nf\rg')).toBe('a\\\\b\\;c\\,d\\ne\\nf\\ng');
  });

  it('leaves out control characters but keeps tabs', () => {
    expect(escapeText('bell\u0007 and\ttab\u007F')).toBe('bell and\ttab');
  });

  it('round-trips through the strict reader', () => {
    const summary = 'Ship v2, then celebrate; really \\ truly';
    const description = 'Notes: first line\nsecond, with a comma; and a semicolon\r\nthird';
    const parsed = parseCalendar(writeCalendar(calendar([event({ summary, description })])));
    expect(parsed.events[0]!.summary).toBe(summary);
    expect(parsed.events[0]!.description).toBe(description.replace('\r\n', '\n'));
  });

  it('is what the strict reader refuses when left unescaped', () => {
    expect(() => unescapeText('a, b')).toThrow(/unescaped/);
    expect(() => unescapeText('a; b')).toThrow(/unescaped/);
    expect(() => unescapeText('a\\x')).toThrow(/unknown escape/);
  });
});

describe('line folding', () => {
  it('leaves a line of 75 octets alone and folds one of 76', () => {
    const exact = `SUMMARY:${'x'.repeat(67)}`;
    expect(Buffer.byteLength(exact)).toBe(75);
    expect(foldLine(exact)).toBe(exact);
    const over = `${exact}y`;
    expect(foldLine(over)).toBe(`${exact}\r\n y`);
  });

  it('counts octets, not characters, and never splits one', () => {
    const line = `DESCRIPTION:${'é'.repeat(40)}${'🗓️'.repeat(20)}${'日本'.repeat(30)}`;
    const folded = foldLine(line);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(3);
    for (const [index, part] of parts.entries()) {
      expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
      if (index > 0) expect(part.startsWith(' ')).toBe(true);
      // Every part is whole UTF-8 on its own.
      expect(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(part))).toBe(part);
    }
    expect(parts.map((part, index) => (index ? part.slice(1) : part)).join('')).toBe(line);
  });

  it('folds long values in a whole document so every line holds 75 octets at most', () => {
    const summary = `A very long launch name that keeps going, ${'and going; '.repeat(20)}ñandú 🎉`;
    const text = writeCalendar(calendar([event({ summary, description: 'ü'.repeat(300) })]));
    const parsed = parseCalendar(Buffer.from(text, 'utf8'));
    expect(parsed.lines.every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
    expect(parsed.lines.some((line) => line.startsWith(' '))).toBe(true);
    expect(parsed.events[0]!.summary).toBe(summary);
    expect(parsed.events[0]!.description).toBe('ü'.repeat(300));
  });

  it('ends every line with CRLF and never with a bare line feed', () => {
    const text = writeCalendar(calendar([event({ description: 'one\ntwo' })]));
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
  });
});

describe('the calendar', () => {
  it('names itself, its zone, and how often to check again', () => {
    const parsed = parseCalendar(writeCalendar(calendar([], 'Launches: Q3, final')));
    expect(parsed.properties.get('VERSION')).toBe('2.0');
    expect(parsed.properties.get('PRODID')).toBeTruthy();
    expect(parsed.properties.get('X-WR-CALNAME')).toBe('Launches: Q3, final');
    expect(parsed.properties.get('X-WR-TIMEZONE')).toBe('America/Chicago');
    expect(parsed.properties.get('REFRESH-INTERVAL')).toBe('PT1H');
    expect(parsed.properties.get('X-PUBLISHED-TTL')).toBe('PT1H');
    expect(parsed.events).toEqual([]);
  });

  it('writes the same text for the same records, so its tag stays put between polls', () => {
    const events = [event(), event({ uid: 'other@riosoma', start: { day: '2026-03-11' } })];
    expect(writeCalendar(calendar(events))).toBe(writeCalendar(calendar(events)));
  });
});

describe('events', () => {
  it('writes an all-day event with its end as the day after its last', () => {
    const parsed = parseCalendar(
      writeCalendar(calendar([event({ start: { day: '2026-03-10' }, end: { day: '2026-03-12' } })])),
    );
    expect(parsed.events[0]).toMatchObject({ start: { date: '2026-03-10' }, end: { date: '2026-03-13' } });
    const text = writeCalendar(
      calendar([event({ start: { day: '2026-03-10' }, end: { day: '2026-03-12' } })]),
    );
    expect(text).toContain('DTSTART;VALUE=DATE:20260310\r\n');
    expect(text).toContain('DTEND;VALUE=DATE:20260313\r\n');
  });

  it('writes a timed event in UTC', () => {
    const start = new Date(Date.UTC(2026, 2, 10, 14, 30));
    const end = new Date(Date.UTC(2026, 2, 10, 16, 0));
    const text = writeCalendar(calendar([event({ start: { instant: start }, end: { instant: end } })]));
    expect(text).toContain('DTSTART:20260310T143000Z\r\n');
    expect(text).toContain('DTEND:20260310T160000Z\r\n');
    expect(parseCalendar(text).events[0]).toMatchObject({ start: { instant: start }, end: { instant: end } });
  });

  it('gives an all-day event with no end its one day, and a timed one none at all', () => {
    const allDay = parseCalendar(writeCalendar(calendar([event({ start: { day: '2026-12-31' } })])));
    expect(allDay.events[0]).toMatchObject({ start: { date: '2026-12-31' }, end: { date: '2027-01-01' } });
    const moment = new Date(Date.UTC(2026, 2, 10, 9));
    const timed = parseCalendar(writeCalendar(calendar([event({ start: { instant: moment } })])));
    expect(timed.events[0]!.end).toBeNull();
    expect(timed.lines.some((line) => line.startsWith('DTEND'))).toBe(false);
  });

  it('carries its UID, link, and when it last changed', () => {
    const parsed = parseCalendar(writeCalendar(calendar([event()])));
    expect(parsed.events[0]).toMatchObject({
      uid: 'recAAAAAAAAAAAAAA.viwAAAAAAAAAAAAAA@riosoma',
      url: 'https://riosoma.example/db1/tbl1/viw1/rec1',
      stamp: modified,
      lastModified: modified,
    });
    expect(icalInstant(modified)).toBe('20260304T050607Z');
  });

  it('leaves out an empty description', () => {
    const parsed = parseCalendar(writeCalendar(calendar([event({ description: '' })])));
    expect(parsed.events[0]!.description).toBeNull();
  });
});

describe('placing a record', () => {
  it('makes dates without times all-day and instants timed', () => {
    expect(eventSpan('2026-03-10', '2026-03-12', 'UTC')).toEqual({
      start: { day: '2026-03-10' },
      end: { day: '2026-03-12' },
    });
    expect(eventSpan('2026-03-10T14:00:00.000Z', '2026-03-10T15:00:00.000Z', 'UTC')).toEqual({
      start: { instant: new Date('2026-03-10T14:00:00.000Z') },
      end: { instant: new Date('2026-03-10T15:00:00.000Z') },
    });
  });

  it('reads an instant as its day in the view’s zone when the other date has no time', () => {
    // Half past midnight in UTC is still the evening before in Chicago.
    expect(eventSpan('2026-03-10', '2026-03-12T00:30:00.000Z', 'America/Chicago')).toEqual({
      start: { day: '2026-03-10' },
      end: { day: '2026-03-11' },
    });
    expect(eventSpan('2026-03-10T03:00:00.000Z', '2026-03-12', 'America/Chicago')).toEqual({
      start: { day: '2026-03-09' },
      end: { day: '2026-03-12' },
    });
  });

  it('treats an end before the start, or a missing one, as no end', () => {
    expect(eventSpan('2026-03-10', '2026-03-01', 'UTC')).toEqual({ start: { day: '2026-03-10' }, end: null });
    expect(eventSpan('2026-03-10T10:00:00.000Z', '2026-03-10T09:00:00.000Z', 'UTC')).toEqual({
      start: { instant: new Date('2026-03-10T10:00:00.000Z') },
      end: null,
    });
    expect(eventSpan('2026-03-10', null, 'UTC')).toEqual({ start: { day: '2026-03-10' }, end: null });
  });

  it('places nothing without a start', () => {
    expect(eventSpan(null, '2026-03-10', 'UTC')).toBeNull();
    expect(eventSpan('not a date', null, 'UTC')).toBeNull();
  });
});

describe('entity tags', () => {
  it('matches strong, weak, listed, and wildcard tags', () => {
    expect(matchesTag('"abc"', '"abc"')).toBe(true);
    expect(matchesTag('W/"abc"', '"abc"')).toBe(true);
    expect(matchesTag('"xyz", "abc"', '"abc"')).toBe(true);
    expect(matchesTag('*', '"abc"')).toBe(true);
    expect(matchesTag('"abd"', '"abc"')).toBe(false);
    expect(matchesTag(undefined, '"abc"')).toBe(false);
  });
});
