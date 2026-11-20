import type {
  CalendarFeedCreate,
  CalendarFeedCreated,
  CalendarFeedPolicy,
  CalendarFeedState,
} from '@riosoma/contracts';
import { api } from '../../api';

/** Calendar feeds: a person's own feed for a view, and the organization's choice about them. */

const feed = (viewId: string) => `/api/views/${encodeURIComponent(viewId)}/calendar-feed`;

export const calendarFeedKey = (viewId: string) => ['views', viewId, 'calendarFeed'] as const;
export const calendarFeedPolicyKey = ['admin', 'calendarFeeds', 'policy'] as const;

export const readCalendarFeed = (viewId: string, signal?: AbortSignal) =>
  api<CalendarFeedState>(feed(viewId), signal ? { signal } : {});

export const makeCalendarFeed = (viewId: string, body: CalendarFeedCreate) =>
  api<CalendarFeedCreated>(feed(viewId), { method: 'POST', body });

export const stopCalendarFeed = (viewId: string) => api<void>(feed(viewId), { method: 'DELETE' });

export const readCalendarFeedPolicy = (signal?: AbortSignal) =>
  api<CalendarFeedPolicy>('/api/admin/calendar-feeds/policy', signal ? { signal } : {});

export const saveCalendarFeedPolicy = (body: CalendarFeedPolicy) =>
  api<CalendarFeedPolicy>('/api/admin/calendar-feeds/policy', { method: 'PUT', body });

/** The address a calendar app subscribes to, from the path the server sent once. */
export function feedAddress(path: string, origin = window.location.origin): string {
  return new URL(path, origin).href;
}

/** The same address as a `webcal:` link, which hands it to the device's calendar app. */
export function webcalAddress(address: string): string {
  return address.replace(/^https?:/i, 'webcal:');
}
