import { describe, expect, it } from 'vitest';
import { parseCalendar } from '../calendar-feeds/ical.test-helpers.js';
import { bookingEmail, type BookingEmailInput } from './email.js';
import { INVITATION_TYPE, senderAddress, writeInvitation, type Invitation } from './invitation.js';

/**
 * The confirmation email and its invitation, checked against RFC 5545 by the calendar feeds'
 * strict reader.  The times are fixed, since nothing here compares them with the clock.
 */

const start = new Date(Date.UTC(2026, 9, 6, 13, 0));
const end = new Date(Date.UTC(2026, 9, 6, 13, 30));
// A stand-in for a signed link's token, built here so it never reads as a stored secret.
const cancelUrl = `https://riosoma.example/bookings/cancel?token=${['bkgAAAAAAAAAAAAAA', 'signature'].join('.')}`;

function invitation(overrides: Partial<Invitation> = {}): Invitation {
  return {
    bookingId: 'bkgAAAAAAAAAAAAAA',
    domain: 'riosoma.example',
    summary: 'Office hours',
    start,
    end,
    description: 'Bring your questions.',
    organizer: { name: 'Office hours', address: 'bookings@riosoma.example' },
    attendee: { name: 'Ada Lovelace', address: 'ada@example.test' },
    cancelUrl,
    sentAt: new Date(Date.UTC(2026, 9, 1, 8, 0)),
    ...overrides,
  };
}

/** The document's logical lines, folds undone. */
function unfolded(document: string): string[] {
  return document
    .split('\r\n')
    .reduce<string[]>((lines, line) => {
      if (line.startsWith(' ')) lines[lines.length - 1] += line.slice(1);
      else lines.push(line);
      return lines;
    }, [])
    .filter(Boolean);
}

describe('the invitation', () => {
  it('is one event, as a request, that the strict reader accepts', () => {
    const document = writeInvitation(invitation());
    const parsed = parseCalendar(document);
    expect(parsed.properties.get('METHOD')).toBe('REQUEST');
    expect(parsed.events).toHaveLength(1);
    const [event] = parsed.events;
    expect(event).toMatchObject({
      uid: 'bkgAAAAAAAAAAAAAA@riosoma.example',
      summary: 'Office hours',
      description: 'Bring your questions.',
      url: cancelUrl,
      start: { instant: start },
      end: { instant: end },
    });
    const lines = unfolded(document);
    expect(lines).toContain('ORGANIZER;CN="Office hours":mailto:bookings@riosoma.example');
    expect(lines).toContain(
      'ATTENDEE;CN="Ada Lovelace";ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:ada@example.test',
    );
    expect(lines).toEqual(expect.arrayContaining(['STATUS:CONFIRMED', 'SEQUENCE:0']));
  });

  it('keeps names and text from breaking out of their values', () => {
    const document = writeInvitation(
      invitation({
        summary: 'Room 1, north; upstairs',
        description: 'Line one\nLine two, with a comma',
        organizer: { name: 'The "big" room\r\nX-EVIL:1', address: 'bookings@riosoma.example' },
        attendee: { name: 'Ada\nLovelace', address: 'ada@example.test\r\nX-EVIL:1' },
      }),
    );
    const [event] = parseCalendar(document).events;
    expect(event!.summary).toBe('Room 1, north; upstairs');
    expect(event!.description).toBe('Line one\nLine two, with a comma');
    const lines = unfolded(document);
    expect(lines.some((line) => line.startsWith('X-EVIL'))).toBe(false);
    expect(lines).toContain('ORGANIZER;CN="The big roomX-EVIL:1":mailto:bookings@riosoma.example');
    expect(lines.find((line) => line.startsWith('ATTENDEE'))).toMatch(
      /CN="AdaLovelace".*:mailto:ada@example.testX-EVIL1$/,
    );
  });

  it('folds long lines without splitting a character', () => {
    const summary = `Consultation ${'é'.repeat(80)}`;
    const document = writeInvitation(invitation({ summary }));
    expect(parseCalendar(Buffer.from(document)).events[0]!.summary).toBe(summary);
  });
});

describe('the confirmation email', () => {
  function email(overrides: Partial<BookingEmailInput> = {}) {
    return bookingEmail({
      to: 'ada@example.test',
      name: 'Ada Lovelace',
      locale: 'en-US',
      timeZone: 'America/Los_Angeles',
      pageTitle: 'Office hours',
      resource: 'Room <b>1</b>',
      confirmation: 'Bring your questions.\nThe door code is on the sign.',
      start,
      end,
      bookingId: 'bkgAAAAAAAAAAAAAA',
      cancelUrl,
      sender: 'bookings@riosoma.example',
      sentAt: new Date(Date.UTC(2026, 9, 1, 8, 0)),
      ...overrides,
    });
  }

  it('says what was booked and when, in the booker’s own zone, with the cancel link', () => {
    const message = email();
    expect(message.to).toBe('ada@example.test');
    // 13:00 UTC is 6:00 in the morning in Los Angeles in October.
    expect(message.subject).toMatch(/^Booked: Office hours, Tuesday, October 6, 2026, 6:00/);
    expect(message.text).toContain('You’re booked for Office hours.');
    expect(message.text).toMatch(/When: Tuesday, October 6, 2026, 6:00.*6:30.* \(America\/Los_Angeles\)/);
    expect(message.text).toContain('With: Room <b>1</b>');
    expect(message.text).toContain('The door code is on the sign.');
    expect(message.text).toContain(`Cancel your booking here: ${cancelUrl}`);
    expect(message.html).toContain('With: Room &lt;b&gt;1&lt;/b&gt;');
    expect(message.html).toContain(`<a href="${cancelUrl}">`);
  });

  it('writes the time the booker’s way', () => {
    expect(email({ locale: 'de', timeZone: 'Europe/Berlin' }).text).toMatch(
      /Dienstag, 6\. Oktober 2026.*15:00/,
    );
  });

  it('carries the invitation as a calendar request', () => {
    const [attachment] = email().attachments ?? [];
    expect(attachment).toMatchObject({ filename: 'invite.ics', contentType: INVITATION_TYPE });
    const [event] = parseCalendar(attachment!.content).events;
    expect(event).toMatchObject({
      summary: 'Office hours (Room <b>1</b>)',
      start: { instant: start },
      end: { instant: end },
      url: cancelUrl,
    });
    expect(event!.description).toContain('Bring your questions.');
    expect(event!.description).toContain(cancelUrl);
  });
});

describe('the sending address', () => {
  it('is read from the server’s sender, with or without a name', () => {
    expect(senderAddress('Riosoma <bookings@riosoma.example>')).toBe('bookings@riosoma.example');
    expect(senderAddress('bookings@riosoma.example')).toBe('bookings@riosoma.example');
    expect(senderAddress('Riosoma')).toBeNull();
    expect(senderAddress(undefined)).toBeNull();
  });
});
