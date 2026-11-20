import { escapeText, foldLine, icalInstant } from '../calendar-feeds/ical.js';

/**
 * The invitation a booking's confirmation email carries: one event as an iCalendar request, so
 * mail and calendar apps offer to add it.  It's written with the calendar feeds' own rules (CRLF
 * line ends, lines folded at 75 octets, text escaped, times in UTC), and it's pure, so it's tested
 * apart from any database.
 */

export const INVITATION_TYPE = 'text/calendar; charset=utf-8; method=REQUEST';
const PRODID = '-//Riosoma//Booking pages//EN';
const LINE_END = '\r\n';

export interface Invitation {
  /** The booking's own ID, which keeps the event the same one if it's ever sent again */
  bookingId: string;
  /** Where the IDs are unique, such as the server's host name */
  domain: string;
  summary: string;
  start: Date;
  end: Date;
  /** Plain text, with line breaks between lines */
  description: string;
  /** Who the invitation is from: the page's name and the server's sending address */
  organizer: { name: string; address: string };
  attendee: { name: string; address: string };
  /** The page that cancels the booking */
  cancelUrl: string;
  sentAt: Date;
}

/** A value without control characters, which could end the line it's on. */
function withoutControls(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if ((code >= 0x20 || code === 0x09) && code !== 0x7f) out += char;
  }
  return out;
}

/** A parameter value, quoted, without the characters no quoted value may hold. */
function parameter(value: string): string {
  return `"${withoutControls(value).replaceAll('"', '')}"`;
}

/** An email address as a calendar user address, with nothing that could end the line or the value. */
function mailto(address: string): string {
  return `mailto:${address.replace(/[\s"<>;:,\\]/g, '')}`;
}

/** The whole document, every line folded and ended with CRLF. */
export function writeInvitation(invitation: Invitation): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${escapeText(`${invitation.bookingId}@${invitation.domain}`)}`,
    `DTSTAMP:${icalInstant(invitation.sentAt)}`,
    `DTSTART:${icalInstant(invitation.start)}`,
    `DTEND:${icalInstant(invitation.end)}`,
    `SUMMARY:${escapeText(invitation.summary)}`,
    ...(invitation.description ? [`DESCRIPTION:${escapeText(invitation.description)}`] : []),
    `ORGANIZER;CN=${parameter(invitation.organizer.name)}:${mailto(invitation.organizer.address)}`,
    `ATTENDEE;CN=${parameter(invitation.attendee.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:${mailto(invitation.attendee.address)}`,
    `URL:${withoutControls(invitation.cancelUrl)}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join(LINE_END) + LINE_END;
}

/** The address in a sender like `Riosoma <bookings@example.com>`, or null when there isn't one. */
export function senderAddress(from: string | undefined): string | null {
  if (!from) return null;
  const bracketed = /<([^<>\s]+@[^<>\s]+)>/.exec(from);
  if (bracketed) return bracketed[1]!;
  const bare = from.trim();
  return /^[^\s@<>"]+@[^\s@<>"]+$/.test(bare) ? bare : null;
}
