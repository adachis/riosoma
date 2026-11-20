import type { PaymentSettings } from './payments.js';
import { z } from 'zod';
import { ChoiceId, FieldId, isTimeZone, LIMITS } from './data/fields.js';
import type { PublicQuestion } from './public-forms.js';
import { ThemePick } from './themes.js';

/**
 * Booking pages: a public page, made from a table, where anyone picks an open time and books it.
 * Each booking lands as a record in the table.
 *
 * A page says which date field (with a time) or date range field (with times) holds a booking's
 * time, how long a booking lasts, the gap to keep between bookings, the weekly hours in a time
 * zone, days that are blocked off, how far ahead and how soon people can book, how many bookings
 * one time takes (one, or more for a class), and which fields the booker fills in.  An optional
 * "open to" single select lets the booker pick a resource first, such as a room or a person, and
 * then each resource's times are counted on their own.
 *
 * A page reads and writes as its owner, the person who last saved its settings: a time is open
 * when fewer records than its places overlap it, counting every record the owner can see, and a
 * booking adds a record as the owner would, so their record rules apply and automations run.  The
 * page stops working when the owner can no longer add records to the table.  Nothing about any
 * other booking ever reaches a visitor: a time is only open or not.
 *
 * Managing pages takes the right to change the database's schema.  Abuse limits, since the public
 * routes are open: a ticket from the page's `GET`, at least 2 seconds and at most 24 hours old, a
 * hidden field that must stay empty, at most `BOOKING_LIMITS.hourly` booking attempts an hour
 * from one address to one page, and at most the page's `dailyPerEmail` bookings a day for one
 * email address.
 *
 * Routes:
 * - `GET /api/tables/:tableId/booking-pages` (session, change schema) → `TableBookingPages`
 * - `POST /api/tables/:tableId/booking-pages` (session, change schema, `BookingPageInput`) → `BookingPage`
 * - `PUT /api/booking-pages/:pageId` (session, change schema, `BookingPageInput`) → `BookingPage`
 * - `DELETE /api/booking-pages/:pageId` (session, change schema)
 * - `GET /api/public/bookings/:pageId` (public) → `PublicBookingPage`
 * - `GET /api/public/bookings/:pageId/slots` (public, `PublicSlotsQuery`) → `PublicSlots`
 * - `POST /api/public/bookings/:pageId/bookings` (public, `PublicBookingRequest`) → `PublicBookingResult`
 * - `GET /api/public/bookings/cancel?token=` (public) → `BookingCancelPreview`
 * - `POST /api/public/bookings/cancel` (public, `BookingCancelRequest`) → `BookingCancelPreview`
 *
 * The page itself is `/b/:pageId` in the web app, and the confirmation email's cancel link opens
 * `/bookings/cancel?token=`, both outside the signed-in shell.
 */

export const BookingPageId = z.string().regex(/^[0-9A-Za-z]{22}$/);

export const BOOKING_LIMITS = {
  /** The shortest and longest a booking can last, in minutes */
  minLength: 15,
  maxLength: 8 * 60,
  maxBuffer: 4 * 60,
  maxPlaces: 500,
  maxDaysAhead: 365,
  /** The most notice a page can ask for, in minutes: 30 days */
  maxNotice: 30 * 24 * 60,
  /** Opening hours on one weekday */
  intervalsPerDay: 4,
  blockedDays: 500,
  questions: 50,
  /** Booking attempts one address may make to one page in an hour */
  hourly: 10,
  /** The most bookings a page can let one email address make in a day */
  maxDailyPerEmail: 50,
  /** Days of open times one request may ask for */
  slotRangeDays: 45,
  /** Open times offered when the time someone chose was just taken */
  nextTimes: 5,
  bodyBytes: 64 * 1024,
} as const;

/** A time of day, `HH:MM`, from `00:00` to `24:00`. */
export const TimeOfDay = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/);

export function minutesOf(time: string): number {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export const OpenInterval = z
  .object({ start: TimeOfDay, end: TimeOfDay })
  .refine((interval) => minutesOf(interval.start) < minutesOf(interval.end), { path: ['end'] });
export type OpenInterval = z.infer<typeof OpenInterval>;

/** One weekday's opening hours, in order and not overlapping. */
export const DayHours = z
  .array(OpenInterval)
  .max(BOOKING_LIMITS.intervalsPerDay)
  .refine((intervals) =>
    intervals.every(
      (interval, index) => index === 0 || minutesOf(intervals[index - 1]!.end) <= minutesOf(interval.start),
    ),
  );

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const BookingQuestion = z.object({ fieldId: FieldId, required: z.boolean().default(false) });
export type BookingQuestion = z.infer<typeof BookingQuestion>;

/** The field types a booking page may ask about, beyond the booker's name and email address. */
export const BOOKING_QUESTION_TYPES = [
  'text',
  'longText',
  'email',
  'url',
  'phone',
  'number',
  'currency',
  'percent',
  'duration',
  'rating',
  'checkbox',
  'date',
  'singleSelect',
  'multipleSelect',
  'json',
  'location',
] as const;

export function isBookingQuestionType(type: string): type is (typeof BOOKING_QUESTION_TYPES)[number] {
  return (BOOKING_QUESTION_TYPES as readonly string[]).includes(type);
}

export const BookingPageSettings = z.object({
  title: z.string().trim().min(1).max(LIMITS.nameLength),
  description: z.string().max(2_000).default(''),
  /** A date field that includes a time, or a date range field that includes times */
  timeFieldId: FieldId,
  /** A single select whose choices are the resources a booker picks from, or none */
  resourceFieldId: FieldId.nullable().default(null),
  lengthMinutes: z.number().int().min(BOOKING_LIMITS.minLength).max(BOOKING_LIMITS.maxLength),
  /** Kept free before and after every booking */
  bufferMinutes: z.number().int().min(0).max(BOOKING_LIMITS.maxBuffer).default(0),
  /** The zone the hours, blocked days, and "how far ahead" are read in */
  timeZone: z.string().refine(isTimeZone),
  /** Seven days of opening hours, Sunday first */
  hours: z.array(DayHours).length(7),
  /** Local days with no bookings at all, as `YYYY-MM-DD` */
  blockedDays: z.array(Day).max(BOOKING_LIMITS.blockedDays).default([]),
  /** How many days after today people can book, today included as day 0 */
  maxDaysAhead: z.number().int().min(0).max(BOOKING_LIMITS.maxDaysAhead).default(60),
  /** How long before a time people must book it */
  minNoticeMinutes: z.number().int().min(0).max(BOOKING_LIMITS.maxNotice).default(0),
  /** Bookings one time takes: one, or more for a class */
  places: z.number().int().min(1).max(BOOKING_LIMITS.maxPlaces).default(1),
  /** A text field for the booker's name, always asked */
  nameFieldId: FieldId,
  /** An email field for the booker's address, always asked, where the confirmation goes */
  emailFieldId: FieldId,
  /** Other fields the booker fills in, each optional unless marked required */
  questions: z.array(BookingQuestion).max(BOOKING_LIMITS.questions).default([]),
  /** Shown after booking, and in the confirmation email */
  confirmation: z.string().max(2_000).default(''),
  /** Bookings one email address may make on this page in a day */
  dailyPerEmail: z.number().int().min(1).max(BOOKING_LIMITS.maxDailyPerEmail).default(3),
  /** The theme the page shows in, over the database's own.  Absent or null uses the database's. */
  theme: ThemePick.nullable().optional(),
});
export type BookingPageSettings = z.infer<typeof BookingPageSettings>;

export const BookingPageInput = z.object({
  settings: BookingPageSettings,
  /** Off keeps the page and its link, and answers visitors that it isn't taking bookings */
  enabled: z.boolean().default(true),
});
export type BookingPageInput = z.infer<typeof BookingPageInput>;

export interface BookingPage {
  pageId: string;
  tableId: string;
  /** Path on this server, like `/b/<pageId>` */
  path: string;
  /** Absolute public address when the server has a configured origin */
  url?: string;
  enabled: boolean;
  settings: BookingPageSettings;
  /** Who bookings are added as: the person who last saved the settings */
  owner: { id: string; name: string } | null;
  /** Bookings made through the page that haven't started or been canceled */
  upcoming: number;
  /** Why the page can't take bookings right now, as a message key, or null when it can */
  problem: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TableBookingPages {
  pages: BookingPage[];
  /** False when the server can't send email, so bookers get no confirmation */
  emailAvailable: boolean;
}

/** A resource a booker can pick: one choice of the page's "open to" field. */
export interface BookingResource {
  id: string;
  name: string;
}

export interface PublicBookingPage {
  payment?: PaymentSettings | null;
  pageId: string;
  title: string;
  description: string;
  lengthMinutes: number;
  /** The zone the page's hours are set in, which visitors see times converted from */
  timeZone: string;
  /** What the booker picks first, or null when the page has one calendar */
  resources: BookingResource[] | null;
  /** The booker's name and email address first, both required, then the page's other questions */
  questions: PublicQuestion[];
  nameFieldId: string;
  emailFieldId: string;
  /** The first and last days, in the page's zone, that could have open times */
  firstDay: string;
  lastDay: string;
  /** The theme the page shows in: its own, else the database's forced one, else the allowed organization default */
  theme: { id: string; scheme: string } | null;
  /** Proof the page was fetched before booking.  Send it back unchanged. */
  ticket: string;
}

export const PublicSlotsQuery = z.object({
  /** Open times starting at or after this instant */
  from: z.iso.datetime(),
  /** and before this one, at most `BOOKING_LIMITS.slotRangeDays` later */
  to: z.iso.datetime(),
  resource: ChoiceId.optional(),
});
export type PublicSlotsQuery = z.infer<typeof PublicSlotsQuery>;

/** An open time, as UTC instants. */
export interface BookingSlot {
  start: string;
  end: string;
}

export interface PublicSlots {
  slots: BookingSlot[];
}

export const PublicBookingRequest = z.strictObject({
  ticket: z.string().min(1).max(500),
  /** The chosen time's start, as the slots list gave it */
  start: z.iso.datetime(),
  resource: ChoiceId.optional(),
  /** Answers by field ID, the name and email address included */
  values: z.record(z.string().max(40), z.unknown()),
  /** The booker's own zone and language, for the confirmation email */
  timeZone: z.string().refine(isTimeZone),
  locale: z.string().min(2).max(35).default('en-US'),
  /** Must stay empty.  It's hidden from people and filled only by bots. */
  website: z.string().max(200).optional(),
});
export type PublicBookingRequest = z.infer<typeof PublicBookingRequest>;

export type PublicBookingResult =
  | {
      status: 'booked';
      checkoutUrl?: string;
      start: string;
      end: string;
      resource: BookingResource | null;
      confirmation: string;
      /** Whether a confirmation email went out */
      emailed: boolean;
    }
  | {
      /** Someone took the last place while the booker was deciding */
      status: 'taken';
      /** The next open times after the one that was taken */
      next: BookingSlot[];
    };

/** The signed part of a cancel link. */
export const BookingCancelToken = z.string().regex(/^bkg[0-9A-Za-z]{14}\.[A-Za-z0-9_-]{43}$/);

export const BookingCancelRequest = z.object({ token: z.string().min(1).max(200) });
export type BookingCancelRequest = z.infer<typeof BookingCancelRequest>;

export interface BookingCancelPreview {
  title: string;
  start: string;
  end: string;
  resource: string | null;
  state: 'booked' | 'canceled' | 'started';
}
