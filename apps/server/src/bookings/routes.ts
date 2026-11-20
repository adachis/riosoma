import { publicLink, publicOrigin } from '../custom-domains/store.js';
import { startCheckout } from '../payments/service.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  BOOKING_LIMITS,
  BookingCancelRequest,
  BookingPageId,
  BookingPageInput,
  PublicBookingRequest,
  PublicSlotsQuery,
  TableId,
  type BookingCancelPreview,
  type BookingPage,
  type PublicBookingPage,
  type PublicBookingResult,
  type PublicSlots,
  type TableBookingPages,
} from '@riosoma/contracts';
import { query, sql, withTransaction } from '@riosoma/db';
import { requireActor } from '../auth/sessions.js';
import { AccessScope } from '../data/access.js';
import { retry } from '../data/commands/transaction.js';
import { dataStore } from '../data/context.js';
import { ticketAccepted } from '../data/public-forms.js';
import { WindowLimiter } from '../data/shared-view-reads.js';
import { parse } from '../http/validate.js';
import { bookingEmail } from './email.js';
import { senderAddress } from './invitation.js';
import { createPage, deletePage, listPages, pageById, pageOf, pageTable, updatePage } from './pages.js';
import {
  addressKey,
  admit,
  cancelBooking,
  cancelPreview,
  cancelToken,
  notAvailable,
  pageIsOn,
  placeBooking,
  publicPage,
  publicSlots,
} from './public.js';

/**
 * Booking pages, following `packages/contracts/src/booking-pages.ts`: the routes that set pages
 * up, and the open ones visitors use.  Cancel links carry their token in the query string, which
 * the logger leaves out.
 */

/** Reads of one page one address may make in a minute: the page, and its open times */
const READS_PER_MINUTE = 120;
/** Cancel attempts one address may make in a quarter hour */
const CANCELS = { limit: 30, windowMs: 15 * 60_000 } as const;

const TableParams = z.object({ tableId: TableId });

/** Any malformed page ID reads as a missing page, so the page can say so calmly. */
function pageIdOf(params: unknown): string {
  const parsed = z.object({ pageId: BookingPageId }).safeParse(params);
  if (!parsed.success) throw notAvailable();
  return parsed.data.pageId;
}

export async function bookingPageRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const session = { config: { policy: { kind: 'session' as const } } };
  const open = { config: { policy: { kind: 'public' as const } } };
  const reads = new WindowLimiter(READS_PER_MINUTE, 60_000);
  const cancels = new WindowLimiter(CANCELS.limit, CANCELS.windowMs);

  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  function limit(
    limiter: WindowLimiter,
    key: string,
    reply: { header(name: string, value: string): unknown },
  ) {
    const wait = limiter.take(key);
    if (wait) {
      reply.header('retry-after', String(wait));
      throw new AppError('rate_limited', 'bookings.public.rateLimited');
    }
  }

  /** Where the app is, for the cancel link. */
  function origin(request: FastifyRequest): string {
    return ctx.config.baseUrl?.replace(/\/+$/, '') || `${request.protocol}://${request.host}`;
  }

  app.get('/api/tables/:tableId/booking-pages', session, async (request): Promise<TableBookingPages> => {
    const { tableId } = parse(TableParams, request.params);
    const { pool, schemas } = dataStore(ctx);
    return withTransaction(pool, async (db) => {
      await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      await pageTable(db, schemas, new AccessScope(db, schemas, requireActor(request)), tableId);
      return {
        pages: await Promise.all(
          (await listPages(db, schemas, tableId)).map((page) =>
            publicLink(ctx, requireActor(request).orgId, 'bookings', page, db),
          ),
        ),
        emailAvailable: Boolean(ctx.mailer),
      };
    });
  });

  app.post(
    '/api/tables/:tableId/booking-pages',
    { ...session, bodyLimit: BOOKING_LIMITS.bodyBytes },
    async (request): Promise<BookingPage> => {
      const { tableId } = parse(TableParams, request.params);
      const input = parse(BookingPageInput, request.body);
      const { pool, schemas } = dataStore(ctx);
      return retry(() =>
        withTransaction(pool, async (db) => {
          const scope = new AccessScope(db, schemas, requireActor(request));
          const table = await pageTable(db, schemas, scope, tableId);
          return publicLink(
            ctx,
            requireActor(request).orgId,
            'bookings',
            await pageOf(db, schemas, await createPage(db, schemas, scope, table, input, ctx.config)),
            db,
          );
        }),
      );
    },
  );

  /** A page someone in its organization may manage, with the table it's on. */
  async function managed(db: Parameters<typeof pageById>[0], request: FastifyRequest) {
    const { schemas } = dataStore(ctx);
    const actor = requireActor(request);
    const pageId = pageIdOf(request.params);
    const row = await pageById(db, schemas, pageId, { forUpdate: true });
    if (!row || row.org_id !== actor.orgId) throw new AppError('not_found', 'errors.notFound');
    const scope = new AccessScope(db, schemas, actor);
    const table = await pageTable(db, schemas, scope, row.table_id);
    return { row, scope, table };
  }

  app.put(
    '/api/booking-pages/:pageId',
    { ...session, bodyLimit: BOOKING_LIMITS.bodyBytes },
    async (request): Promise<BookingPage> => {
      const input = parse(BookingPageInput, request.body);
      const { pool, schemas } = dataStore(ctx);
      return retry(() =>
        withTransaction(pool, async (db) => {
          const { row, scope, table } = await managed(db, request);
          return publicLink(
            ctx,
            row.org_id,
            'bookings',
            await pageOf(db, schemas, await updatePage(db, schemas, scope, table, row, input, ctx.config)),
            db,
          );
        }),
      );
    },
  );

  app.delete('/api/booking-pages/:pageId', session, async (request, reply) => {
    const { pool, schemas } = dataStore(ctx);
    await retry(() =>
      withTransaction(pool, async (db) => {
        const { row } = await managed(db, request);
        await deletePage(db, schemas, requireActor(request), row);
      }),
    );
    return reply.status(204).send();
  });

  app.get('/api/public/bookings/cancel', open, async (request, reply): Promise<BookingCancelPreview> => {
    limit(cancels, addressKey(ctx.config.secretKey, request.ip), reply);
    const { token } = parse(BookingCancelRequest, request.query);
    return cancelPreview(ctx, token);
  });

  app.post('/api/public/bookings/cancel', open, async (request, reply): Promise<BookingCancelPreview> => {
    limit(cancels, addressKey(ctx.config.secretKey, request.ip), reply);
    const { token } = parse(BookingCancelRequest, request.body);
    return cancelBooking(ctx, token);
  });

  app.get('/api/public/bookings/:pageId', open, async (request, reply): Promise<PublicBookingPage> => {
    const pageId = pageIdOf(request.params);
    limit(reads, `${pageId}:${addressKey(ctx.config.secretKey, request.ip)}`, reply);
    return publicPage(ctx, pageId);
  });

  app.get('/api/public/bookings/:pageId/slots', open, async (request, reply): Promise<PublicSlots> => {
    const pageId = pageIdOf(request.params);
    limit(reads, `${pageId}:${addressKey(ctx.config.secretKey, request.ip)}`, reply);
    return publicSlots(ctx, pageId, parse(PublicSlotsQuery, request.query));
  });

  app.post(
    '/api/public/bookings/:pageId/bookings',
    { ...open, bodyLimit: BOOKING_LIMITS.bodyBytes },
    async (request, reply): Promise<PublicBookingResult> => {
      const pageId = pageIdOf(request.params);
      const input = parse(PublicBookingRequest, request.body);
      const { pool, schemas } = dataStore(ctx);
      const settings = await pageIsOn(pool, schemas, pageId);
      // Only scripts fill the hidden field.  Answer as if it worked, and keep nothing.
      if (input.website) {
        request.log.info({ dropped: 1 }, 'booking dropped');
        const start = new Date(input.start);
        return {
          status: 'booked',
          start: start.toISOString(),
          end: new Date(start.getTime() + settings.lengthMinutes * 60_000).toISOString(),
          resource: null,
          confirmation: settings.confirmation,
          emailed: false,
        };
      }
      if (!ticketAccepted(ctx.config.secretKey, pageId, input.ticket, Date.now(), 'bookingPage'))
        throw new AppError('forbidden', 'bookings.public.ticket');
      // Every attempt that gets this far counts, booked or refused, so trying costs a script too.
      const address = addressKey(ctx.config.secretKey, request.ip);
      const wait = await admit(ctx, pageId, address, BOOKING_LIMITS.hourly);
      if (wait) {
        reply.header('retry-after', String(wait));
        throw new AppError('rate_limited', 'bookings.public.rateLimited');
      }
      const placed = await placeBooking(ctx, pageId, input, Date.now(), address).catch((error: unknown) => {
        // A page that charges limits the places waiting for payment, and says when to try again.
        const seconds = error instanceof AppError ? error.params?.retryAfterSeconds : undefined;
        if (typeof seconds === 'number') reply.header('retry-after', String(seconds));
        throw error;
      });
      const { result, booked, checkoutRecordId } = placed;
      if (checkoutRecordId && result.status === 'booked')
        return { ...result, checkoutUrl: await startCheckout(ctx, checkoutRecordId, 'booking', request.log) };
      if (result.status !== 'booked' || !booked) return result;
      const mailer = ctx.mailer;
      const sender = senderAddress(ctx.config.mailFrom);
      if (!mailer || !sender) return result;
      try {
        const page = await pageById(pool, schemas, pageId);
        const base = (page && (await publicOrigin(ctx, page.org_id, 'bookings'))) || origin(request);
        await mailer.send(
          bookingEmail({
            to: booked.email,
            name: booked.name,
            locale: input.locale,
            timeZone: input.timeZone,
            pageTitle: booked.settings.title,
            resource: booked.resource,
            confirmation: booked.settings.confirmation,
            start: new Date(booked.start),
            end: new Date(booked.end),
            bookingId: booked.bookingId,
            cancelUrl: `${base}/bookings/cancel?${new URLSearchParams({
              token: cancelToken(ctx.config.secretKey, booked.bookingId),
            }).toString()}`,
            sender,
            sentAt: new Date(),
          }),
        );
        return { ...result, emailed: true };
      } catch (error) {
        // The booking stands.  Provider errors can quote the address, so only the code is logged.
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
        request.log.warn({ code }, 'booking confirmation not sent');
        return result;
      }
    },
  );
}
