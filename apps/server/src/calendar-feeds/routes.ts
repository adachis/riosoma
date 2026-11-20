import { createHash, createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  CALENDAR_FEED_LIMITS,
  CalendarFeedCreate,
  CalendarFeedPolicy,
  calendarFeedPath,
  isCalendarFeedViewType,
  ViewId,
  type CalendarFeedCreated,
  type CalendarFeedState,
} from '@riosoma/contracts';
import { withTransaction, type Queryable } from '@riosoma/db';
import { requireActor } from '../auth/sessions.js';
import { AccessScope } from '../data/access.js';
import { retry, userError } from '../data/commands/transaction.js';
import { dataStore, type DataSchemas } from '../data/context.js';
import { loadTable, loadView } from '../data/metadata.js';
import { WindowLimiter } from '../data/shared-view-reads.js';
import { badViewSetting } from '../data/view-settings.js';
import { parse } from '../http/validate.js';
import { readsLive } from '../sources/live.js';
import { CALENDAR_TYPE, writeCalendar } from './ical.js';
import { readFeed } from './read.js';
import {
  feedOf,
  feedsAllowed,
  feedTokenHash,
  liveFeed,
  makeFeed,
  markRead,
  setFeedsAllowed,
  stopFeed,
} from './store.js';

/**
 * Calendar feeds, following `packages/contracts/src/calendar-feeds.ts`: a person's own feed for a
 * view, the organization's choice, and the address calendar apps poll.  The address carries its
 * token in the path, which the logger redacts, and nothing here logs it.
 */

const ViewParams = z.object({ viewId: ViewId });
const FEED_FILE = /^([A-Za-z0-9_-]{43})\.ics$/;
const notFound = () => new AppError('not_found', 'errors.notFound');

/** Tokens are counted under a keyed hash, so the limiter never holds one. */
function tokenKey(key: Buffer, token: string): string {
  return createHmac('sha256', key).update(`riosoma.calendarFeed.token\n${token}`).digest('base64url');
}

/** Whether a request's `If-None-Match` names this tag, weak or strong, or any tag at all. */
export function matchesTag(header: string | string[] | undefined, etag: string): boolean {
  const values = Array.isArray(header) ? header : header ? [header] : [];
  return values
    .flatMap((value) => value.split(','))
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === '*' || tag === etag);
}

export async function calendarFeedRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const session = { config: { policy: { kind: 'session' as const } } };
  const security = {
    config: { policy: { kind: 'admin' as const, area: 'security' as const, scope: 'organization' as const } },
  };
  const requests = new WindowLimiter(
    CALENDAR_FEED_LIMITS.requests,
    CALENDAR_FEED_LIMITS.windowMinutes * 60_000,
  );

  app.addHook('onSend', async (_request, reply) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  /** A view the person can read that a calendar app could subscribe to. */
  async function feedView(db: Queryable, schemas: DataSchemas, scope: AccessScope, viewId: string) {
    const loaded = await loadView(db, schemas, viewId);
    if (!loaded || loaded.trashed) throw notFound();
    await scope.require(loaded.databaseId, 'read');
    if (!isCalendarFeedViewType(loaded.view.type)) badViewSetting('type');
    return loaded;
  }

  app.get('/api/views/:viewId/calendar-feed', session, async (request): Promise<CalendarFeedState> => {
    const { viewId } = parse(ViewParams, request.params);
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    await feedView(pool, schemas, new AccessScope(pool, schemas, actor), viewId);
    const row = await liveFeed(pool, schemas, actor.userId, viewId);
    return {
      allowed: await feedsAllowed(pool, schemas, actor.orgId, actor),
      feed: row ? feedOf(row) : null,
    };
  });

  app.post('/api/views/:viewId/calendar-feed', session, async (request): Promise<CalendarFeedCreated> => {
    const { viewId } = parse(ViewParams, request.params);
    const { timeZone } = parse(CalendarFeedCreate, request.body);
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    return retry(() =>
      withTransaction(pool, async (db) => {
        const loaded = await feedView(db, schemas, new AccessScope(db, schemas, actor), viewId);
        if (!(await feedsAllowed(db, schemas, actor.orgId, actor)))
          throw new AppError('forbidden', 'calendarFeeds.off');
        const table = await loadTable(db, schemas, loaded.view.tableId);
        if (!table || table.trashed) throw notFound();
        if (readsLive(table)) throw new AppError('validation_failed', 'sources.live.viewUnsupported');
        const target = { databaseId: loaded.databaseId, tableId: table.id, viewId };
        try {
          const { row, token } = await makeFeed(db, schemas, actor, target, timeZone);
          return { feed: feedOf(row), path: calendarFeedPath(token) };
        } catch (error) {
          // Two new addresses at once meet at the unique index, and the later one is refused.
          throw userError(error) ?? error;
        }
      }),
    );
  });

  // Turning one's own feed off needs no access to the view, so someone who lost it can still stop it.
  app.delete('/api/views/:viewId/calendar-feed', session, async (request, reply) => {
    const { viewId } = parse(ViewParams, request.params);
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    await withTransaction(pool, (db) => stopFeed(db, schemas, actor, viewId));
    return reply.status(204).send();
  });

  app.get('/api/admin/calendar-feeds/policy', security, async (request): Promise<CalendarFeedPolicy> => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    return { enabled: await feedsAllowed(pool, schemas, actor.orgId) };
  });

  app.put('/api/admin/calendar-feeds/policy', security, async (request): Promise<CalendarFeedPolicy> => {
    const actor = requireActor(request);
    const { enabled } = parse(CalendarFeedPolicy, request.body);
    const { pool, schemas } = dataStore(ctx);
    const saved = await withTransaction(pool, (db) => setFeedsAllowed(db, schemas, actor, enabled));
    if (saved === undefined) throw notFound();
    return { enabled: saved };
  });

  /** Where the app is, for each event's link back to its record. */
  function origin(request: FastifyRequest): string {
    return ctx.config.baseUrl?.replace(/\/+$/, '') || `${request.protocol}://${request.host}`;
  }

  /**
   * The feed itself.  Calendar apps read only the status and the body, so every answer but the
   * document has an empty body: 404 for an address that never worked or a view that can't be a
   * calendar right now, 410 for one that stopped, and 429 with `Retry-After` when polled too often.
   */
  app.get(
    '/feeds/:file',
    { config: { policy: { kind: 'public' } } },
    async (request, reply: FastifyReply) => {
      reply.header('x-robots-tag', 'noindex, nofollow');
      const file = (request.params as { file?: unknown }).file;
      const token = typeof file === 'string' ? FEED_FILE.exec(file)?.[1] : undefined;
      if (!token) return reply.code(404).send();
      const wait = requests.take(tokenKey(ctx.config.secretKey, token));
      if (wait) return reply.code(429).header('retry-after', String(wait)).send();
      if (!ctx.pool || !ctx.config.database) return reply.code(503).send();
      const { pool, schemas } = dataStore(ctx);
      const read = await readFeed(pool, schemas, feedTokenHash(token), origin(request));
      if (read.status === 'missing' || read.status === 'unavailable') return reply.code(404).send();
      if (read.status === 'gone') return reply.code(410).send();
      await markRead(pool, schemas, read.feed.id);
      const body = writeCalendar(read.document);
      const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
      reply.headers({
        etag,
        'content-type': CALENDAR_TYPE,
        'content-disposition': 'attachment; filename="calendar.ics"',
        // Private to whoever holds the address, and checked again on every poll.
        'cache-control': 'private, no-cache',
        'x-content-type-options': 'nosniff',
      });
      if (matchesTag(request.headers['if-none-match'], etag)) return reply.code(304).send();
      // Calendar data uses text/calendar, attachment disposition, and nosniff.
      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
      return reply.send(body);
    },
  );
}
