import { z } from 'zod';
import { isTimeZone } from './data/fields.js';

/**
 * Calendar feeds: a calendar, timeline, or Gantt view's records as an iCalendar document that
 * Apple Calendar, Google Calendar, and Outlook subscribe to and poll.
 *
 * Each person has at most one feed per view.  Its address holds a long random token, and the
 * server keeps only the token's hash, so the address is shown once, when it's made.  Making a new
 * address stops the old one at once.  The feed reads the view as the person who made it would,
 * through their role and the database's field and record rules, and it answers 410 Gone once they
 * can no longer open the view, the view or anything around it is deleted, the feed is turned off,
 * or the organization turns feeds off.  Turning feeds off for the organization stops every feed,
 * and turning them back on doesn't bring those back.
 *
 * Routes:
 * - `GET /api/views/:viewId/calendar-feed` (session, read) → `CalendarFeedState`
 * - `POST /api/views/:viewId/calendar-feed` (session, read, `CalendarFeedCreate`) →
 *   `CalendarFeedCreated` (makes a feed, or a new address for the one there is)
 * - `DELETE /api/views/:viewId/calendar-feed` (session) (turns the person's feed off)
 * - `GET /api/admin/calendar-feeds/policy` (security admins) → `CalendarFeedPolicy`
 * - `PUT /api/admin/calendar-feeds/policy` (security admins, `CalendarFeedPolicy`) → `CalendarFeedPolicy`
 * - `GET /feeds/:token.ics` (no sign-in) → `text/calendar`, with `ETag` and `If-None-Match`
 */

export const CALENDAR_FEED_VIEW_TYPES = ['calendar', 'timeline', 'gantt'] as const;
export type CalendarFeedViewType = (typeof CALENDAR_FEED_VIEW_TYPES)[number];

export function isCalendarFeedViewType(type: string): type is CalendarFeedViewType {
  return (CALENDAR_FEED_VIEW_TYPES as readonly string[]).includes(type);
}

export const CALENDAR_FEED_LIMITS = {
  /** Events in one document.  A bigger view keeps the ones nearest to today. */
  events: 5_000,
  /** Requests one address may make in a window before it has to wait */
  requests: 30,
  windowMinutes: 15,
  /** How often the document asks calendar apps to check again, in minutes */
  refreshMinutes: 60,
} as const;

/** The random part of a feed's address: 32 bytes, base64url. */
export const CalendarFeedToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** Where a feed is served, from its token. */
export function calendarFeedPath(token: string): string {
  return `/feeds/${token}.ics`;
}

export interface CalendarFeed {
  viewId: string;
  createdAt: string;
  /** When a calendar app last read it, to within a few minutes, or null before the first time */
  lastReadAt: string | null;
}

export interface CalendarFeedState {
  /** False when the organization has turned calendar feeds off */
  allowed: boolean;
  /** The person's own feed for the view, when it's on */
  feed: CalendarFeed | null;
}

export const CalendarFeedCreate = z.object({
  /**
   * The person's time zone, for dates that follow each viewer's own zone.  A calendar app can't
   * say where it is, so the feed keeps the zone it was made in.
   */
  timeZone: z.string().refine(isTimeZone),
});
export type CalendarFeedCreate = z.infer<typeof CalendarFeedCreate>;

export interface CalendarFeedCreated {
  feed: CalendarFeed;
  /** The address's path, `calendarFeedPath(token)`.  It's never sent again. */
  path: string;
}

export const CalendarFeedPolicy = z.object({
  /** Whether people may subscribe to views in calendar apps.  On by default. */
  enabled: z.boolean(),
});
export type CalendarFeedPolicy = z.infer<typeof CalendarFeedPolicy>;
