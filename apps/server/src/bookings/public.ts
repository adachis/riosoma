import { createHmac, timingSafeEqual } from 'node:crypto';
import { clientAddress } from '../authorization/store.js';
import { publicOrigin } from '../custom-domains/store.js';
import { fromWallClock, localDay } from '../automations/schedule.js';
import {
  HOLD_FALLBACK_SECONDS,
  holding,
  pageSettings,
  reservePayment,
  sealBookingMail,
} from '../payments/store.js';
import { bookingEmail, refundedEmail } from './email.js';
import { senderAddress } from './invitation.js';
import {
  AppError,
  BOOKING_LIMITS,
  newId,
  paymentDecimals,
  type BookingCancelPreview,
  type BookingPageSettings,
  type BookingSlot,
  type PublicBookingPage,
  type PublicBookingRequest,
  type PublicBookingResult,
  type PublicQuestion,
  type PublicSlots,
  type PublicSlotsQuery,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable, type Sql } from '@riosoma/db';
import type { AppContext } from '../app.js';
import { actorFor } from '../automations/run.js';
import { AccessScope } from '../data/access.js';
import { policyRelevant } from '../org-units/policy.js';
import { applyCommand, parseCommand } from '../data/commands/index.js';
import type { CommandContext } from '../data/commands/context.js';
import { lock, recordChange, retry } from '../data/commands/transaction.js';
import { dataStore, type DataSchemas } from '../data/context.js';
import { columnRef } from '../data/physical/columns.js';
import { answerOptions, issueTicket } from '../data/public-forms.js';
import { publicTheme } from '../themes/choices.js';
import type { StoredField } from '../data/types.js';
import type { Actor } from '../http/policy.js';
import {
  audit,
  inspectPage,
  pageById,
  settingsOf,
  type PageAccess,
  type PageFields,
  type PageRow,
} from './pages.js';
import {
  bookableDays,
  byStart,
  candidateSlots,
  dayText,
  openSlots,
  overlapping,
  reach,
  slotsOnDay,
  type Span,
} from './slots.js';

/**
 * What a booking page lets anyone do: read the page, see which times are open, book one, and
 * cancel their own booking with the link from their email.  Every answer carries only the page's
 * own words and whether a time is open, never anything about another booking.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;
/** Records read for one answer about open times.  More than this in the stretch asked about is refused. */
const SPAN_LIMIT = 50_000;

export function notAvailable(): AppError {
  return new AppError('not_found', 'bookings.public.notFound');
}

/**
 * Addresses are counted under a keyed hash, so the table never holds one.  An IPv6 address counts
 * as its /64, which one subscriber usually holds whole, and an IPv4 address written as IPv6 as
 * itself, so moving around inside a network can't reset the hourly limit or hold another place.
 */
export function addressKey(key: Buffer, address: string): string {
  return createHmac('sha256', key)
    .update(`riosoma.bookingPage.address\n${clientAddress(address)}`)
    .digest('base64url');
}

/** Email addresses are counted under a keyed hash too, the same whatever their case. */
export function emailKey(key: Buffer, email: string): string {
  return createHmac('sha256', key)
    .update(`riosoma.bookingPage.email\n${email.trim().toLowerCase()}`)
    .digest('base64url');
}

function cancelMac(key: Buffer, bookingId: string): string {
  return createHmac('sha256', key).update(`riosoma.booking.cancel\n${bookingId}`).digest('base64url');
}

/** The secret part of a booking's cancel link: its ID and a signature only this server can make. */
export function cancelToken(key: Buffer, bookingId: string): string {
  return `${bookingId}.${cancelMac(key, bookingId)}`;
}

/** The booking a cancel link names, when this server signed it, or null. */
export function bookingOfToken(key: Buffer, token: string): string | null {
  const match = /^(bkg[0-9A-Za-z]{14})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const expected = Buffer.from(cancelMac(key, match[1]!));
  const given = Buffer.from(match[2]!);
  return expected.length === given.length && timingSafeEqual(expected, given) ? match[1]! : null;
}

interface LiveRow extends PageRow {
  database_settings: unknown;
  theme_policy_relevant: boolean;
}

/** A page whose table and database are out of the trash, on or off. */
async function loadPage(db: Queryable, schemas: DataSchemas, pageId: string): Promise<LiveRow> {
  const result = await query<LiveRow>(
    db,
    sql`SELECT p.id, p.org_id, p.database_id, p.table_id, p.owner_id, p.settings, p.enabled,
        p.created_at, p.updated_at, d.settings AS database_settings,
        ${policyRelevant(schemas.app, sql`p.org_id`)} AS policy_relevant,
        ${policyRelevant(schemas.app, sql`p.org_id`, { unitsOnly: true })} AS theme_policy_relevant
      FROM ${ident(schemas.app, 'booking_pages')} p
      JOIN ${ident(schemas.app, 'tables')} t ON t.id = p.table_id
      JOIN ${ident(schemas.app, 'databases')} d ON d.id = t.database_id
     WHERE p.id = ${pageId} AND d.id = p.database_id AND d.org_id = p.org_id
       AND t.trashed_at IS NULL AND d.trashed_at IS NULL`,
  );
  const row = result.rows[0];
  if (!row) throw notAvailable();
  return row;
}

/** A page taking bookings right now, with the access it runs with. */
export async function livePage(
  db: Queryable,
  schemas: DataSchemas,
  pageId: string,
): Promise<{ row: LiveRow; access: PageAccess }> {
  const row = await loadPage(db, schemas, pageId);
  if (!row.enabled) throw new AppError('not_found', 'bookings.public.off');
  const inspection = await inspectPage(db, schemas, row);
  if (!inspection.ok) throw notAvailable();
  return { row, access: inspection.access };
}

/** Whether a page is turned on, before any heavier work is done for it. */
export async function pageIsOn(
  db: Queryable,
  schemas: DataSchemas,
  pageId: string,
): Promise<BookingPageSettings> {
  const row = await loadPage(db, schemas, pageId);
  if (!row.enabled) throw new AppError('not_found', 'bookings.public.off');
  const settings = settingsOf(row.settings);
  if (!settings) throw notAvailable();
  return settings;
}

function question(field: StoredField, required: boolean): PublicQuestion {
  return {
    fieldId: field.id,
    type: field.type as PublicQuestion['type'],
    label: field.name,
    help: '',
    required,
    options: answerOptions(field),
  };
}

export async function publicPage(
  ctx: AppContext,
  pageId: string,
  now = Date.now(),
): Promise<PublicBookingPage> {
  const { pool, schemas } = dataStore(ctx);
  const { row, access } = await withTransaction(pool, async (db) => {
    await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    return livePage(db, schemas, pageId);
  });
  const { settings, fields } = access;
  const { first, last } = bookableDays(settings, now);
  const resource = fields.resource?.type === 'singleSelect' ? fields.resource : null;
  const payment = await pageSettings(pool, schemas, row.id);
  // The page's own theme wins over its database's, as far as the page's owner may choose them.
  const theme = await publicTheme(
    pool,
    `"${schemas.app}"`,
    { orgId: row.org_id, sharerId: row.owner_id, hasUnits: row.theme_policy_relevant },
    settings.theme,
    row.database_settings,
    ctx.config,
  );
  return {
    ...(payment ? { payment } : {}),
    pageId: row.id,
    title: settings.title,
    description: settings.description,
    lengthMinutes: settings.lengthMinutes,
    timeZone: settings.timeZone,
    resources: resource ? resource.options.choices.map(({ id, name }) => ({ id, name })) : null,
    questions: [
      question(fields.name, true),
      question(fields.email, true),
      ...fields.questions.map(({ field, required }) => question(field, required)),
    ],
    nameFieldId: fields.name.id,
    emailFieldId: fields.email.id,
    firstDay: dayText(first),
    lastDay: dayText(Math.max(first, last)),
    theme,
    ticket: issueTicket(ctx.config.secretKey, row.id, Date.now(), 'bookingPage'),
  };
}

/** The resource asked for, which a page with resources needs and one without refuses. */
function resourceOf(fields: PageFields, resource: string | undefined): string | null {
  const field = fields.resource;
  if (!field || field.type !== 'singleSelect') {
    if (resource) throw new AppError('validation_failed', 'bookings.public.resource');
    return null;
  }
  if (!resource || !field.options.choices.some((choice) => choice.id === resource))
    throw new AppError('validation_failed', 'bookings.public.resource');
  return resource;
}

/**
 * The records that could overlap a stretch of time, as the owner sees them, as spans.  Records in
 * the trash don't count, and with resources only the chosen resource's records do.  A booking
 * that takes payment counts like any other, by its record's time, while it's paid or its payment
 * is still pending: until Stripe says the Checkout Session expired, or an hour past its expiry if
 * that word never comes.  Once the payment expires, fails, or is refunded, its time is free.
 * `except` leaves one record out, to ask whether a time is full without it.
 */
async function readSpans(
  db: Queryable,
  schemas: DataSchemas,
  access: PageAccess,
  window: Span,
  resource: string | null,
  except: string | null = null,
): Promise<Span[]> {
  const { table, fields, scope, settings } = access;
  const column = columnRef(fields.time);
  const from = new Date(window.start).toISOString();
  const to = new Date(window.end).toISOString();
  const which: Sql = fields.resource ? sql`AND ${columnRef(fields.resource)} = ${resource}` : sql``;
  const where = sql`__deleted_at IS NULL AND NOT __source_gone AND (${scope.recordPredicate(table.id)}) ${which}
    AND (${except}::text IS NULL OR __id <> ${except})
    AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'payments')} p
      WHERE p.record_id = __id AND NOT ${holding('p')})`;
  const length = settings.lengthMinutes * MINUTE;
  if (fields.time.type === 'date') {
    // A booking's record holds only its start, so each lasts the page's length.
    const result = await query<{ start: number }>(
      db,
      sql`SELECT (extract(epoch FROM ${column}) * 1000)::float8 AS start FROM ${ident(schemas.data, table.id)}
        WHERE ${column} IS NOT NULL AND ${column} > ${from}::timestamptz - make_interval(mins => ${settings.lengthMinutes})
          AND ${column} < ${to}::timestamptz AND ${where}
        LIMIT ${SPAN_LIMIT + 1}`,
    );
    if (result.rows.length > SPAN_LIMIT) throw new AppError('unavailable', 'bookings.public.busy');
    return result.rows.map((row) => ({ start: Number(row.start), end: Number(row.start) + length }));
  }
  const result = await query<{ start: number; end: number }>(
    db,
    sql`SELECT (extract(epoch FROM lower(${column})) * 1000)::float8 AS start,
        (extract(epoch FROM COALESCE(upper(${column}), lower(${column}))) * 1000)::float8 AS "end"
      FROM ${ident(schemas.data, table.id)}
      WHERE ${column} IS NOT NULL AND NOT isempty(${column}) AND lower(${column}) IS NOT NULL
        AND ${column} && tstzrange(${from}::timestamptz, ${to}::timestamptz, '[]') AND ${where}
      LIMIT ${SPAN_LIMIT + 1}`,
  );
  if (result.rows.length > SPAN_LIMIT) throw new AppError('unavailable', 'bookings.public.busy');
  return result.rows.map((row) => ({ start: Number(row.start), end: Number(row.end) }));
}

/**
 * Whether a booking whose payment Stripe just confirmed still has its place.  It doesn't when its
 * record, table, or database went to the trash.  Nor does it when its hold ended before the
 * payment was confirmed, `lapsed`, and its time, as its record holds it now, is full without it.
 * While the hold stood, nobody could book the place through the page, so a time someone filled by
 * hand in the table keeps the booking too.
 */
export async function placeKept(
  db: Queryable,
  schemas: DataSchemas,
  payment: { record_id: string; table_id: string | null; target_id: string },
  lapsed: boolean,
): Promise<'kept' | 'trashed' | 'full'> {
  if (!payment.table_id) return 'trashed';
  const table = await query(
    db,
    sql`SELECT 1 FROM ${ident(schemas.app, 'tables')} t JOIN ${ident(schemas.app, 'databases')} d ON d.id = t.database_id
      WHERE t.id = ${payment.table_id} AND t.trashed_at IS NULL AND d.trashed_at IS NULL
        AND to_regclass(${`"${schemas.data}"."${payment.table_id}"`}) IS NOT NULL`,
  );
  if (!table.rowCount) return 'trashed';
  const live = await query(
    db,
    sql`SELECT 1 FROM ${ident(schemas.data, payment.table_id)}
      WHERE __id = ${payment.record_id} AND __deleted_at IS NULL AND NOT __source_gone`,
  );
  if (!live.rowCount) return 'trashed';
  if (!lapsed) return 'kept';
  const page = await pageById(db, schemas, payment.target_id);
  // A page that's gone, or can't take bookings now, gave the place to no one else.
  const inspection = page && page.table_id === payment.table_id ? await inspectPage(db, schemas, page) : null;
  if (!inspection?.ok) return 'kept';
  const { settings, fields, table: pageTable } = inspection.access;
  const column = columnRef(fields.time);
  const resource = fields.resource ? sql`${columnRef(fields.resource)}::text` : sql`NULL::text`;
  const record = (
    await query<{ start: number | null; end: number | null; resource: string | null }>(
      db,
      fields.time.type === 'date'
        ? sql`SELECT (extract(epoch FROM ${column}) * 1000)::float8 AS start, NULL::float8 AS "end", ${resource} AS resource
          FROM ${ident(schemas.data, pageTable.id)} WHERE __id = ${payment.record_id}`
        : sql`SELECT (extract(epoch FROM lower(${column})) * 1000)::float8 AS start,
            (extract(epoch FROM COALESCE(upper(${column}), lower(${column}))) * 1000)::float8 AS "end", ${resource} AS resource
          FROM ${ident(schemas.data, pageTable.id)} WHERE __id = ${payment.record_id}`,
    )
  ).rows[0];
  if (!record || record.start === null) return 'kept';
  const start = Number(record.start);
  const span = {
    start,
    end: record.end === null ? start + settings.lengthMinutes * MINUTE : Number(record.end),
  };
  const buffer = settings.bufferMinutes * MINUTE;
  const others = await readSpans(
    db,
    schemas,
    inspection.access,
    { start: span.start - buffer, end: span.end + buffer },
    record.resource,
    payment.record_id,
  );
  return overlapping(span, byStart(others), settings.bufferMinutes) >= settings.places ? 'full' : 'kept';
}

const slotOf = (span: Span): BookingSlot => ({
  start: new Date(span.start).toISOString(),
  end: new Date(span.end).toISOString(),
});

/** Open times starting in `[from, to)`. */
async function open(
  db: Queryable,
  schemas: DataSchemas,
  access: PageAccess,
  from: number,
  to: number,
  resource: string | null,
  now: number,
): Promise<Span[]> {
  const candidates = candidateSlots(access.settings, from, to, now);
  const window = reach(access.settings, candidates);
  if (!window) return [];
  return openSlots(access.settings, candidates, await readSpans(db, schemas, access, window, resource));
}

export async function publicSlots(
  ctx: AppContext,
  pageId: string,
  input: PublicSlotsQuery,
  now = Date.now(),
): Promise<PublicSlots> {
  const from = Date.parse(input.from);
  const to = Date.parse(input.to);
  if (!(to > from) || to - from > BOOKING_LIMITS.slotRangeDays * DAY)
    throw new AppError('validation_failed', 'bookings.public.range');
  const { pool, schemas } = dataStore(ctx);
  const slots = await withTransaction(pool, async (db) => {
    await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    const { access } = await livePage(db, schemas, pageId);
    return open(db, schemas, access, from, to, resourceOf(access.fields, input.resource), now);
  });
  return { slots: slots.map(slotOf) };
}

/**
 * Counts a booking attempt from one address to one page, unless that address has used up its
 * hour.  Returns 0 when the attempt may go ahead, or the seconds until it could.
 */
export async function admit(
  ctx: AppContext,
  pageId: string,
  address: string,
  limit: number,
): Promise<number> {
  const { pool, schemas } = dataStore(ctx);
  const attempts = ident(schemas.app, 'booking_attempts');
  return withTransaction(pool, async (db) => {
    await query(
      db,
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:booking-page:${pageId}:${address}`}, 0))`,
    );
    await query(
      db,
      sql`DELETE FROM ${attempts} WHERE page_id = ${pageId} AND at <= clock_timestamp() - interval '1 hour'`,
    );
    const limiting = await query<{ seconds: number }>(
      db,
      sql`SELECT GREATEST(1, ceil(extract(epoch FROM (at + interval '1 hour' - clock_timestamp()))))::int AS seconds
        FROM ${attempts} WHERE page_id = ${pageId} AND address = ${address}
        ORDER BY at DESC OFFSET ${limit - 1} LIMIT 1`,
    );
    if (limiting.rows[0]) return limiting.rows[0].seconds;
    await query(db, sql`INSERT INTO ${attempts} (page_id, address) VALUES (${pageId}, ${address})`);
    return 0;
  });
}

function blank(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * The booker's answers, only to the page's questions, with the required ones given.  The name and
 * email address are always required.  Values are checked again, field by field, when the record
 * is added.
 */
function answersOf(fields: PageFields, values: Record<string, unknown>) {
  const asked = [
    { field: fields.name, required: true },
    { field: fields.email, required: true },
    ...fields.questions,
  ];
  const known = new Set(asked.map(({ field }) => field.id));
  for (const fieldId of Object.keys(values))
    if (!known.has(fieldId)) throw new AppError('validation_failed', 'bookings.public.unknownQuestion');
  for (const { field, required } of asked)
    if (required && blank(values[field.id]))
      throw new AppError('validation_failed', 'bookings.public.required', { params: { fieldId: field.id } });
  const answers = Object.fromEntries(Object.entries(values).filter(([, value]) => !blank(value))) as Record<
    string,
    unknown
  >;
  const name = String(answers[fields.name.id]).trim();
  const email = String(answers[fields.email.id]).trim();
  return { answers: { ...answers, [fields.name.id]: name, [fields.email.id]: email }, name, email };
}

/** What a booking needs after it commits: the email to its booker. */
export interface Booked {
  bookingId: string;
  name: string;
  email: string;
  settings: BookingPageSettings;
  resource: string | null;
  start: number;
  end: number;
}

/** No one in particular, for taking a lock before the page's owner is known. */
function nobodyIn(orgId: string): Actor {
  return { userId: '', orgId, sessionId: '', kind: 'guest', adminRoles: [], csrfToken: '' };
}

/**
 * When to try again: a minute after the session closes, when Stripe's word that it expired
 * usually frees the hold.  A session already closed is waiting only for that word.
 */
const holdWait = (expires: Date | null) =>
  Math.max(60, Math.ceil(((expires?.getTime() ?? Date.now()) + 60_000 - Date.now()) / 1000));

/**
 * Pending payments hold places without anyone paying yet, so a page that charges lets one network
 * address hold one place at a time, and lets holds take at most a third of a day's places.
 */
async function requireHoldRoom(
  db: Queryable,
  schemas: DataSchemas,
  access: PageAccess,
  pageId: string,
  slot: Span,
  address: string | null,
): Promise<void> {
  const { settings, table } = access;
  const open = sql`p.target_id = ${pageId} AND p.state = 'pending'
    AND p.expires_at > statement_timestamp() - make_interval(secs => ${HOLD_FALLBACK_SECONDS})
    AND EXISTS (SELECT 1 FROM ${ident(schemas.data, table.id)} r WHERE r.__id = p.record_id AND r.__deleted_at IS NULL)`;
  if (address) {
    const mine = await query<{ expires_at: Date }>(
      db,
      sql`SELECT p.expires_at FROM ${ident(schemas.app, 'payments')} p
        WHERE ${open} AND p.address_key = ${address} ORDER BY p.expires_at DESC LIMIT 1`,
    );
    if (mine.rows[0])
      throw new AppError('rate_limited', 'payments.holdWaiting', {
        params: { retryAfterSeconds: holdWait(mine.rows[0].expires_at) },
      });
  }
  const day = localDay(slot.start, settings.timeZone);
  const from = new Date(fromWallClock(day, settings.timeZone)).toISOString();
  const to = new Date(fromWallClock(day + DAY, settings.timeZone)).toISOString();
  const places = slotsOnDay(settings, day).length * settings.places;
  const waiting = await query<{ count: string; soonest: Date | null }>(
    db,
    sql`SELECT count(*) AS count, min(p.expires_at) AS soonest FROM ${ident(schemas.app, 'payments')} p
      JOIN ${ident(schemas.app, 'bookings')} b ON b.record_id = p.record_id
      WHERE ${open} AND b.canceled_at IS NULL
        AND b.starts_at >= ${from}::timestamptz AND b.starts_at < ${to}::timestamptz`,
  );
  if (Number(waiting.rows[0]!.count) >= Math.max(1, Math.floor(places / 3)))
    throw new AppError('rate_limited', 'payments.holdsFull', {
      params: { retryAfterSeconds: holdWait(waiting.rows[0]!.soonest) },
    });
}

/**
 * Books a time, checking it again with the database locked, so two people can't take the last
 * place at once: record changes in a database wait for its lock, so nothing can land between the
 * count and the new record.  The loser hears the time was taken, with the next open times.
 *
 * On a page that charges, the record goes in with its payment Pending, which holds the place
 * until the Checkout Session ends, and the confirmation waits, sealed, for the payment.  `address`
 * is the booker's network address under a keyed hash.
 */
export async function placeBooking(
  ctx: AppContext,
  pageId: string,
  input: PublicBookingRequest,
  now = Date.now(),
  address: string | null = null,
): Promise<{ result: PublicBookingResult; booked: Booked | null; checkoutRecordId?: string }> {
  const { pool, schemas } = dataStore(ctx);
  const start = Date.parse(input.start);
  return retry(() =>
    withTransaction(pool, async (db) => {
      const first = await loadPage(db, schemas, pageId);
      await lock({ db, schemas, actor: nobodyIn(first.org_id), databaseId: first.database_id }, [
        `database:${first.database_id}`,
      ]);
      // The page may have been turned off, or its owner lost the table, while waiting for the lock.
      const { access } = await livePage(db, schemas, pageId);
      const { settings, fields, table } = access;
      const resource = resourceOf(fields, input.resource);
      const { answers, name, email } = answersOf(fields, input.values);
      const taken = async (): Promise<{ result: PublicBookingResult; booked: null }> => {
        const { last } = bookableDays(settings, now);
        const until = Math.min(start + 31 * DAY, last + 2 * DAY);
        const next = until > start ? await open(db, schemas, access, start + 1, until, resource, now) : [];
        return {
          result: { status: 'taken', next: next.slice(0, BOOKING_LIMITS.nextTimes).map(slotOf) },
          booked: null,
        };
      };
      const slot = candidateSlots(settings, start, start + 1, now).find(
        (candidate) => candidate.start === start,
      );
      if (!slot) return taken();
      const buffer = settings.bufferMinutes * MINUTE;
      const spans = await readSpans(
        db,
        schemas,
        access,
        { start: slot.start - buffer, end: slot.end + buffer },
        resource,
      );
      if (overlapping(slot, byStart(spans), settings.bufferMinutes) >= settings.places) return taken();

      const key = emailKey(ctx.config.secretKey, email);
      const today = await query<{ count: string }>(
        db,
        sql`SELECT count(*) FROM ${ident(schemas.app, 'bookings')} WHERE page_id = ${pageId}
          AND email_key = ${key} AND canceled_at IS NULL AND created_at > statement_timestamp() - interval '1 day'`,
      );
      if (Number(today.rows[0]!.count) >= settings.dailyPerEmail)
        throw new AppError('rate_limited', 'bookings.public.dailyLimit');

      // The record goes in as the page's owner would add it, so their rules apply and automations run.
      const c: CommandContext = {
        secretKey: ctx.config.secretKey,
        db,
        schemas,
        actor: access.owner,
        databaseId: table.databaseId,
        scope: access.scope,
      };
      await access.scope.require(table.databaseId, 'editRecords');
      const startText = new Date(slot.start).toISOString();
      const endText = new Date(slot.end).toISOString();
      const values: Record<string, unknown> = {
        ...answers,
        [fields.time.id]: fields.time.type === 'date' ? startText : { start: startText, end: endText },
        ...(fields.resource && resource ? { [fields.resource.id]: resource } : {}),
      };
      const recordId = newId('record');
      if (await pageSettings(db, schemas, pageId))
        await requireHoldRoom(db, schemas, access, pageId, slot, address);
      const payment = await reservePayment(
        c,
        { id: pageId, kind: 'booking' },
        table.id,
        recordId,
        settings.title,
        values,
        address,
      );
      if (payment) c.managedWrite = payment.grant;
      const command = parseCommand({
        id: newId('command'),
        groupId: newId('action'),
        kind: 'record.create',
        tableId: table.id,
        records: [{ id: recordId, values: payment?.values ?? values }],
      });
      const mutation = await applyCommand(c, command);
      await recordChange(c, mutation, { commandId: command.id, groupId: command.groupId, clientId: null });
      const bookingId = newId('booking');
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'bookings')}
          (id, page_id, record_id, starts_at, ends_at, resource_id, email_key)
          VALUES (${bookingId}, ${pageId}, ${recordId}, ${startText}::timestamptz, ${endText}::timestamptz,
            ${resource}, ${key})`,
      );
      await audit(db, schemas, access.owner.orgId, null, 'data.booking.created', {
        databaseId: table.databaseId,
        tableId: table.id,
        pageId,
        count: 1,
      });
      const resourceName =
        fields.resource?.type === 'singleSelect'
          ? (fields.resource.options.choices.find((choice) => choice.id === resource)?.name ?? null)
          : null;
      // A paid booking's confirmation and invitation go out once, when the payment is confirmed.  If
      // the place was given up before then, the booker hears instead that they were refunded.
      const sender = senderAddress(ctx.config.mailFrom);
      if (payment && ctx.mailer && sender) {
        const base = await publicOrigin(ctx, access.owner.orgId, 'bookings', db);
        const booked = bookingEmail({
          to: email,
          name,
          locale: input.locale,
          timeZone: input.timeZone,
          pageTitle: settings.title,
          resource: resourceName,
          confirmation: settings.confirmation,
          start: new Date(slot.start),
          end: new Date(slot.end),
          bookingId,
          sender,
          sentAt: new Date(),
          cancelUrl: `${base}/bookings/cancel?${new URLSearchParams({ token: cancelToken(ctx.config.secretKey, bookingId) }).toString()}`,
        });
        const refunded = refundedEmail({
          to: email,
          locale: input.locale,
          timeZone: input.timeZone,
          pageTitle: settings.title,
          start: new Date(slot.start),
          end: new Date(slot.end),
          amount: payment.payment.amount,
          currency: payment.payment.currency,
          decimals: paymentDecimals(payment.payment.currency),
        });
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'payments')} SET booking_mail = ${sealBookingMail(ctx, recordId, { booked, refunded })} WHERE record_id = ${recordId}`,
        );
      }
      return {
        ...(payment ? { checkoutRecordId: recordId } : {}),
        result: {
          status: 'booked',
          start: startText,
          end: endText,
          resource: resource && resourceName !== null ? { id: resource, name: resourceName } : null,
          confirmation: settings.confirmation,
          emailed: false,
        },
        booked: payment
          ? null
          : {
              bookingId,
              name,
              email,
              settings,
              resource: resourceName,
              start: slot.start,
              end: slot.end,
            },
      };
    }),
  );
}

interface BookingRow {
  id: string;
  page_id: string;
  record_id: string;
  starts_at: Date;
  ends_at: Date;
  resource_id: string | null;
  canceled_at: Date | null;
  org_id: string;
  database_id: string;
  table_id: string;
  owner_id: string | null;
  settings: unknown;
}

async function bookingById(
  db: Queryable,
  schemas: DataSchemas,
  bookingId: string,
  options: { forUpdate?: boolean } = {},
): Promise<BookingRow | undefined> {
  const columns = sql`b.id, b.page_id, b.record_id, b.starts_at, b.ends_at, b.resource_id, b.canceled_at,
    p.org_id, p.database_id, p.table_id, p.owner_id, p.settings`;
  const from = sql`${ident(schemas.app, 'bookings')} b JOIN ${ident(schemas.app, 'booking_pages')} p ON p.id = b.page_id`;
  const result = await query<BookingRow>(
    db,
    options.forUpdate
      ? sql`SELECT ${columns} FROM ${from} WHERE b.id = ${bookingId} FOR UPDATE OF b`
      : sql`SELECT ${columns} FROM ${from} WHERE b.id = ${bookingId}`,
  );
  return result.rows[0];
}

/** Whether the booking's record is still out of the trash. */
async function recordKept(db: Queryable, schemas: DataSchemas, row: BookingRow): Promise<boolean> {
  const table = await query<{ id: string }>(
    db,
    sql`SELECT id FROM ${ident(schemas.app, 'tables')} WHERE id = ${row.table_id}`,
  );
  if (!table.rowCount) return false;
  const record = await query<{ kept: boolean }>(
    db,
    sql`SELECT __deleted_at IS NULL AS kept FROM ${ident(schemas.data, row.table_id)} WHERE __id = ${row.record_id}`,
  );
  return Boolean(record.rows[0]?.kept);
}

function previewOf(row: BookingRow, state: BookingCancelPreview['state']): BookingCancelPreview {
  const settings = settingsOf(row.settings);
  return {
    title: settings?.title ?? '',
    start: row.starts_at.toISOString(),
    end: row.ends_at.toISOString(),
    // The resource's name as the page offers it now.
    resource: null,
    state,
  };
}

function invalidLink(): AppError {
  return new AppError('not_found', 'bookings.cancel.invalid');
}

async function withResource(
  db: Queryable,
  schemas: DataSchemas,
  row: BookingRow,
  preview: BookingCancelPreview,
): Promise<BookingCancelPreview> {
  const settings = settingsOf(row.settings);
  if (!row.resource_id || !settings?.resourceFieldId) return preview;
  const field = await query<{ options: { choices?: Array<{ id: string; name: string }> } }>(
    db,
    sql`SELECT options FROM ${ident(schemas.app, 'fields')} WHERE id = ${settings.resourceFieldId}`,
  );
  const name = field.rows[0]?.options.choices?.find((choice) => choice.id === row.resource_id)?.name;
  return { ...preview, resource: name ?? null };
}

/** What a cancel link is for, without changing anything, so a mail scanner that opens it cancels nothing. */
export async function cancelPreview(
  ctx: AppContext,
  token: string,
  now = Date.now(),
): Promise<BookingCancelPreview> {
  const bookingId = bookingOfToken(ctx.config.secretKey, token);
  if (!bookingId) throw invalidLink();
  const { pool, schemas } = dataStore(ctx);
  const row = await bookingById(pool, schemas, bookingId);
  if (!row) throw invalidLink();
  const state =
    row.canceled_at || !(await recordKept(pool, schemas, row))
      ? 'canceled'
      : row.starts_at.getTime() <= now
        ? 'started'
        : 'booked';
  return withResource(pool, schemas, row, previewOf(row, state));
}

/**
 * Cancels a booking: its record goes to the trash, as the page's owner would put it there, which
 * frees its time.  Canceling again changes nothing and says it's canceled.  The page can be off,
 * but its owner still has to be able to change the table's records.
 */
export async function cancelBooking(
  ctx: AppContext,
  token: string,
  now = Date.now(),
): Promise<BookingCancelPreview> {
  const bookingId = bookingOfToken(ctx.config.secretKey, token);
  if (!bookingId) throw invalidLink();
  const { pool, schemas } = dataStore(ctx);
  let databaseId: string | undefined;
  const preview = await retry(() =>
    withTransaction(pool, async (db) => {
      const found = await bookingById(db, schemas, bookingId);
      if (!found) throw invalidLink();
      databaseId = found.database_id;
      await lock({ db, schemas, actor: nobodyIn(found.org_id), databaseId: found.database_id }, [
        `database:${found.database_id}`,
      ]);
      const row = await bookingById(db, schemas, bookingId, { forUpdate: true });
      if (!row) throw invalidLink();
      if (row.canceled_at) return withResource(db, schemas, row, previewOf(row, 'canceled'));
      if (row.starts_at.getTime() <= now) throw new AppError('conflict', 'bookings.cancel.started');
      const markCanceled = async () => {
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'bookings')} SET canceled_at = statement_timestamp() WHERE id = ${row.id}`,
        );
        await audit(db, schemas, row.org_id, null, 'data.booking.canceled', {
          databaseId: row.database_id,
          tableId: row.table_id,
          pageId: row.page_id,
          count: 1,
        });
        return withResource(db, schemas, row, previewOf(row, 'canceled'));
      };
      // Someone already put the record in the trash, so the time is free.
      if (!(await recordKept(db, schemas, row))) return markCanceled();
      const owner = row.owner_id ? await actorFor(db, schemas, row.owner_id, row.org_id) : null;
      if (!owner) throw new AppError('conflict', 'bookings.cancel.unavailable');
      const scope = new AccessScope(db, schemas, owner);
      try {
        await scope.require(row.database_id, 'editRecords');
        const c: CommandContext = {
          secretKey: ctx.config.secretKey,
          db,
          schemas,
          actor: owner,
          databaseId: row.database_id,
          scope,
        };
        const command = parseCommand({
          id: newId('command'),
          groupId: newId('action'),
          kind: 'record.trash',
          tableId: row.table_id,
          recordIds: [row.record_id],
        });
        const mutation = await applyCommand(c, command);
        await recordChange(c, mutation, { commandId: command.id, groupId: command.groupId, clientId: null });
      } catch (error) {
        // The owner can't reach the record anymore, such as after a rule change.
        if (error instanceof AppError && error.userFault)
          throw new AppError('conflict', 'bookings.cancel.unavailable', { cause: error });
        throw error;
      }
      return markCanceled();
    }),
  );
  // A booker who gives up a place still waiting for payment can't pay for it afterward.
  if (databaseId) await ctx.payments?.release(databaseId);
  return preview;
}
