import type { MailMessage } from '../mail/index.js';
import { usableLocale } from '../reports/email.js';
import { escapeHtml, formatMessage, type MessageValue } from '../reports/messages.js';
import { INVITATION_TYPE, writeInvitation, type Invitation } from './invitation.js';

/**
 * The email a booker gets: what they booked and when, in their own time zone and language, the
 * page's own confirmation note, an invitation for their calendar, and the link that cancels it.
 *
 * The copy is written as the app's other strings are, as messages with explicit IDs that the
 * catalog extraction collects, so the email translates with everything else.  Values people typed
 * are escaped and never read as markup.
 */

interface Descriptor {
  id: string;
  message: string;
}

export const BOOKING_EMAIL_COPY = {
  subject: /*i18n*/ { id: 'bookings.email.subject', message: 'Booked: {page}, {time}' },
  intro: /*i18n*/ { id: 'bookings.email.intro', message: 'You’re booked for {page}.' },
  when: /*i18n*/ { id: 'bookings.email.when', message: 'When: {time} ({zone})' },
  with: /*i18n*/ { id: 'bookings.email.with', message: 'With: {resource}' },
  calendar: /*i18n*/ {
    id: 'bookings.email.calendar',
    message: 'The attached invitation adds it to your calendar.',
  },
  cancel: /*i18n*/ {
    id: 'bookings.email.cancel',
    message: 'Can’t make it?  Cancel your booking here: {link}',
  },
  footer: /*i18n*/ {
    id: 'bookings.email.footer',
    message:
      'You’re getting this because this address was used to book on {page}.  If that wasn’t you, the link above cancels the booking.',
  },
} satisfies Record<string, Descriptor>;

export interface BookingEmailInput {
  to: string;
  name: string;
  locale: string;
  /** The booker's zone, which the email's times are written in */
  timeZone: string;
  pageTitle: string;
  resource: string | null;
  /** The page's own note for people who booked, as its owner wrote it */
  confirmation: string;
  start: Date;
  end: Date;
  bookingId: string;
  cancelUrl: string;
  /** The server's sending address, which the invitation comes from */
  sender: string;
  sentAt: Date;
}

/** One line, and short enough for a subject: names can be long, and can't break a header. */
function subjectPart(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim();
  const characters = Array.from(line);
  return characters.length <= 60 ? line : `${characters.slice(0, 59).join('').trimEnd()}…`;
}

function link(href: string): MessageValue {
  const safe = escapeHtml(href);
  return { html: `<a href="${safe}">${safe}</a>`, text: href };
}

/** The booked time as the booker's language writes a stretch of time, in their zone. */
export function bookedTime(start: Date, end: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short', timeZone }).formatRange(
    start,
    end,
  );
}

export function bookingEmail(input: BookingEmailInput): MailMessage {
  const locale = usableLocale(input.locale);
  const copy = BOOKING_EMAIL_COPY;
  const time = bookedTime(input.start, input.end, locale, input.timeZone);
  const text = (descriptor: Descriptor, values: Record<string, MessageValue>) =>
    formatMessage(descriptor.message, values, { locale, html: false });
  const html = (descriptor: Descriptor, values: Record<string, MessageValue>) =>
    formatMessage(descriptor.message, values, { locale, html: true });
  const paragraphs: Array<[Descriptor, Record<string, MessageValue>]> = [
    [copy.intro, { page: input.pageTitle }],
    [copy.when, { time, zone: input.timeZone }],
    ...(input.resource
      ? [[copy.with, { resource: input.resource }] as [Descriptor, Record<string, MessageValue>]]
      : []),
  ];
  const after: Array<[Descriptor, Record<string, MessageValue>]> = [
    [copy.calendar, {}],
    [copy.cancel, { link: link(input.cancelUrl) }],
  ];
  const footer: [Descriptor, Record<string, MessageValue>] = [copy.footer, { page: input.pageTitle }];
  const note = input.confirmation.trim();
  const invitation: Invitation = {
    bookingId: input.bookingId,
    domain: new URL(input.cancelUrl).hostname,
    summary: input.resource ? `${input.pageTitle} (${input.resource})` : input.pageTitle,
    start: input.start,
    end: input.end,
    description: [note, text(copy.cancel, { link: input.cancelUrl })].filter(Boolean).join('\n\n'),
    organizer: { name: input.pageTitle, address: input.sender },
    attendee: { name: input.name, address: input.to },
    cancelUrl: input.cancelUrl,
    sentAt: input.sentAt,
  };
  const textBody = [
    ...paragraphs.map(([descriptor, values]) => text(descriptor, values)),
    ...(note ? [note] : []),
    ...after.map(([descriptor, values]) => text(descriptor, values)),
    '--',
    text(...footer),
  ].join('\n\n');
  const htmlBody = [
    ...paragraphs.map(([descriptor, values]) => `<p>${html(descriptor, values)}</p>`),
    ...(note ? [`<p style="white-space: pre-wrap">${escapeHtml(note)}</p>`] : []),
    ...after.map(([descriptor, values]) => `<p>${html(descriptor, values)}</p>`),
    '<hr>',
    `<p><small>${html(...footer)}</small></p>`,
  ].join('');
  return {
    to: input.to,
    subject: formatMessage(
      copy.subject.message,
      { page: subjectPart(input.pageTitle), time: subjectPart(time) },
      { locale, html: false },
    ),
    text: textBody,
    html: htmlBody,
    attachments: [
      {
        filename: 'invite.ics',
        content: Buffer.from(writeInvitation(invitation)),
        contentType: INVITATION_TYPE,
      },
    ],
    headers: { 'Auto-Submitted': 'auto-generated' },
  };
}

export const REFUNDED_EMAIL_COPY = {
  subject: /*i18n*/ { id: 'bookings.refundedEmail.subject', message: 'Refunded: {page}, {time}' },
  intro: /*i18n*/ {
    id: 'bookings.refundedEmail.intro',
    message: 'We couldn’t keep your booking for {page}, so we’ve refunded your payment of {amount} in full.',
  },
  when: /*i18n*/ { id: 'bookings.refundedEmail.when', message: 'The time was {time} ({zone}).' },
  refund: /*i18n*/ {
    id: 'bookings.refundedEmail.refund',
    message: 'The refund goes back to the card you paid with.  Your bank may take a few days to show it.',
  },
  again: /*i18n*/ {
    id: 'bookings.refundedEmail.again',
    message: 'You’re welcome to book another time on the page.',
  },
  footer: /*i18n*/ {
    id: 'bookings.refundedEmail.footer',
    message: 'You’re getting this because this address was used to book on {page}.',
  },
} satisfies Record<string, Descriptor>;

export interface RefundedEmailInput {
  to: string;
  locale: string;
  timeZone: string;
  pageTitle: string;
  start: Date;
  end: Date;
  /** The amount refunded, in the currency's smallest unit */
  amount: number;
  currency: string;
  decimals: number;
}

/**
 * The email a booker gets when their time couldn't be kept after all, because the place was given
 * up before their payment was confirmed, and their payment went back to them in full.
 */
export function refundedEmail(input: RefundedEmailInput): MailMessage {
  const locale = usableLocale(input.locale);
  const copy = REFUNDED_EMAIL_COPY;
  const time = bookedTime(input.start, input.end, locale, input.timeZone);
  const amount = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: input.currency.toUpperCase(),
    minimumFractionDigits: input.decimals,
    maximumFractionDigits: input.decimals,
  }).format(input.amount / 10 ** input.decimals);
  const paragraphs: Array<[Descriptor, Record<string, MessageValue>]> = [
    [copy.intro, { page: input.pageTitle, amount }],
    [copy.when, { time, zone: input.timeZone }],
    [copy.refund, {}],
    [copy.again, {}],
  ];
  const footer: [Descriptor, Record<string, MessageValue>] = [copy.footer, { page: input.pageTitle }];
  const format = (descriptor: Descriptor, values: Record<string, MessageValue>, html: boolean) =>
    formatMessage(descriptor.message, values, { locale, html });
  return {
    to: input.to,
    subject: formatMessage(
      copy.subject.message,
      { page: subjectPart(input.pageTitle), time: subjectPart(time) },
      { locale, html: false },
    ),
    text: [...paragraphs.map(([d, v]) => format(d, v, false)), '--', format(...footer, false)].join('\n\n'),
    html: [
      ...paragraphs.map(([d, v]) => `<p>${format(d, v, true)}</p>`),
      '<hr>',
      `<p><small>${format(...footer, true)}</small></p>`,
    ].join(''),
    headers: { 'Auto-Submitted': 'auto-generated' },
  };
}
