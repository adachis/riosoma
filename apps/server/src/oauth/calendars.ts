import { createHash } from 'node:crypto';
import { AppError, isTimeZone, type AutomationStep } from '@riosoma/contracts';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import type { Actor } from '../http/policy.js';
import { driveAccess, type DriveAccess } from './connections.js';
import { driveFetch, providerFailed } from './drive.js';
import { GOOGLE_API, GOOGLE_OAUTH } from './google.js';
import { limited, type OAuthProvider } from './providers.js';

export const googleCalendar: OAuthProvider = {
  id: 'google-calendar',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: `${GOOGLE_OAUTH}/token`,
  scope: 'openid email profile https://www.googleapis.com/auth/calendar.events',
  authorizeParams: { access_type: 'offline', prompt: 'consent' },
  async account(accessToken, signal) {
    const response = await fetch(`${GOOGLE_API}/oauth2/v3/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal,
    });
    if (!response.ok) throw providerFailed();
    const value = z
      .object({ sub: z.string(), name: z.string(), email: z.string().optional() })
      .parse(await response.json());
    return { id: value.sub, name: value.name, email: value.email ?? null };
  },
};

const GRAPH = 'https://graph.microsoft.com/v1.0';
export const microsoftCalendar: OAuthProvider = {
  id: 'microsoft-calendar',
  authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  scope: 'offline_access User.Read Calendars.ReadWrite',
  async account(accessToken, signal) {
    const response = await fetch(`${GRAPH}/me?$select=id,displayName,mail,userPrincipalName`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal,
    });
    if (!response.ok) throw providerFailed();
    const value = z
      .object({
        id: z.string(),
        displayName: z.string(),
        mail: z.string().nullable().optional(),
        userPrincipalName: z.string().optional(),
      })
      .parse(await response.json());
    return { id: value.id, name: value.displayName, email: value.mail ?? value.userPrincipalName ?? null };
  },
};

export type CalendarInput = Pick<
  Extract<AutomationStep, { kind: 'createCalendarEvent' }>,
  'provider' | 'calendarId' | 'title' | 'description' | 'start' | 'end' | 'timeZone'
>;

export function checkCalendar(input: CalendarInput): void {
  const date = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (
    !input.title.trim() ||
    !isTimeZone(input.timeZone) ||
    !(
      (date.test(input.start) && date.test(input.end)) ||
      (/^\d{4}-\d{2}-\d{2}$/.test(input.start) && /^\d{4}-\d{2}-\d{2}$/.test(input.end))
    ) ||
    !Number.isFinite(Date.parse(input.start)) ||
    !(Date.parse(input.end) > Date.parse(input.start))
  )
    throw new AppError('validation_failed', 'automations.calendar.invalid');
}

/** A stable event identity prevents a recovered run from creating a second event. */
export async function createCalendarEvent(
  ctx: AppContext,
  actor: Actor,
  input: CalendarInput,
  identity: string,
  accountId?: string,
) {
  checkCalendar(input);
  const access = await driveAccess(ctx, actor, input.provider);
  if (accountId && accountId !== access.accountId) throw new AppError('conflict', 'drives.reconnect');
  return { ...(await insertEvent(access, input, identity)), accountId: access.accountId! };
}

export async function insertEvent(access: DriveAccess, input: CalendarInput, identity: string) {
  checkCalendar(input);
  const id = createHash('sha256').update(identity).digest('hex');
  const google = input.provider === 'google-calendar';
  const calendar = encodeURIComponent(input.calendarId.trim() || 'primary');
  const url = google
    ? `${GOOGLE_API}/calendar/v3/calendars/${calendar}/events`
    : input.calendarId.trim()
      ? `${GRAPH}/me/calendars/${encodeURIComponent(input.calendarId.trim())}/events`
      : `${GRAPH}/me/calendar/events`;
  const allDay = input.start.length === 10;
  const wallTime = (value: string) => {
    if (allDay) return `${value}T00:00:00`;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: input.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(value));
    const part = (type: string) => parts.find((item) => item.type === type)!.value;
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
  };
  const body = google
    ? {
        id,
        summary: input.title,
        description: input.description,
        start: allDay ? { date: input.start } : { dateTime: input.start, timeZone: input.timeZone },
        end: allDay ? { date: input.end } : { dateTime: input.end, timeZone: input.timeZone },
      }
    : {
        transactionId: id,
        subject: input.title,
        body: { contentType: 'text', content: input.description },
        isAllDay: allDay,
        start: { dateTime: wallTime(input.start), timeZone: input.timeZone },
        end: { dateTime: wallTime(input.end), timeZone: input.timeZone },
      };
  let conflict = false;
  const response = await driveFetch(access, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: limited(),
    redirect: 'error',
    missing: [],
    explain: async (response) => {
      conflict = response.status === 409;
      return null;
    },
  }).catch(async (error: unknown) => {
    // Reading by the deterministic ID also recovers an event created before a lost response.
    const transport =
      error instanceof AppError
        ? error.cause !== undefined
        : error instanceof Error && ['TimeoutError', 'AbortError', 'TypeError'].includes(error.name);
    if (!google || (!conflict && !transport)) throw error;
    return driveFetch(access, `${url}/${id}`, { signal: limited(), redirect: 'error' }).catch(() => {
      throw error;
    });
  });
  const event = z
    .object({ id: z.string().min(1), htmlLink: z.string().optional(), webLink: z.string().optional() })
    .parse(await response.json());
  return {
    eventId: event.id,
    calendarId: input.calendarId,
    provider: input.provider,
    url: event.htmlLink ?? event.webLink ?? null,
  };
}

/** The person's connection to a calendar service, refused when they've since connected another account. */
export async function calendarAccess(
  ctx: AppContext,
  actor: Actor,
  provider: CalendarInput['provider'],
  accountId: string,
): Promise<DriveAccess> {
  const access = await driveAccess(ctx, actor, provider);
  if (access.accountId !== accountId) throw new AppError('conflict', 'drives.reconnect');
  return access;
}

export async function deleteCalendarEvent(
  ctx: AppContext,
  actor: Actor,
  input: Pick<CalendarInput, 'provider' | 'calendarId'>,
  eventId: string,
  accountId: string,
): Promise<void> {
  await removeEvent(await calendarAccess(ctx, actor, input.provider, accountId), input, eventId);
}

/** Removes an event with a connection already in hand.  An event that's already gone is fine. */
export async function removeEvent(
  access: DriveAccess,
  input: Pick<CalendarInput, 'provider' | 'calendarId'>,
  eventId: string,
): Promise<void> {
  const url =
    input.provider === 'google-calendar'
      ? `${GOOGLE_API}/calendar/v3/calendars/${encodeURIComponent(input.calendarId.trim() || 'primary')}/events/${encodeURIComponent(eventId)}`
      : `${GRAPH}/me/events/${encodeURIComponent(eventId)}`;
  try {
    const response = await driveFetch(access, url, {
      method: 'DELETE',
      missing: [404, 410],
      signal: limited(),
      redirect: 'error',
    });
    await response.body?.cancel();
  } catch (error) {
    if (!(error instanceof AppError && error.code === 'not_found')) throw error;
  }
}
