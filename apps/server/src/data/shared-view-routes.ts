import { publicLink } from '../custom-domains/store.js';
import { createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  newId,
  embedAncestors,
  AttachmentId,
  FieldId,
  isShareableViewType,
  RecordId,
  sameTheme,
  SharedDownloadQuery,
  SharedFileQuery,
  SharedFileVariant,
  SharedPositionQuery,
  SharedRowsQuery,
  SharedStacksQuery,
  SharedViewId,
  SharedViewUnlock,
  SharedViewUpdate,
  ViewAggregateRequest,
  isTimeZone,
  ViewId,
  type PositionResult,
  type SharedRowsPage,
  type SharedStackCounts,
  type SharedView,
  type SharedViewEmbed,
  type SharedViewLink,
} from '@riosoma/contracts';
import { query, sql, withTransaction, type Queryable } from '@riosoma/db';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { requireActor } from '../auth/sessions.js';
import { clientAddress } from '../authorization/store.js';
import type { Actor } from '../http/policy.js';
import { sendShell } from '../http/shell.js';
import { parse } from '../http/validate.js';
import { AccessScope } from './access.js';
import { retry } from './commands/transaction.js';
import { dataStore, type DataSchemas } from './context.js';
import { disposition } from './files/detect.js';
import type { FileRow } from './files/metadata.js';
import { fileStorage } from './files/storage.js';
import { loadFields, loadTable, loadView } from './metadata.js';
import {
  addressKey,
  DEFAULT_MINUTE_LIMIT,
  fileAccepted,
  fileSigner,
  loadLiveShare,
  notAvailable,
  passAccepted,
  passCookie,
  passCookieName,
  passCookieOptions,
  PASSWORD_LINK_TRIES,
  PASSWORD_TRIES,
  passwordRequired,
  sharedDownload,
  sharedAggregate,
  sharedFile,
  sharedLayout,
  sharedPage,
  sharedPosition,
  sharedRead,
  sharedStacks,
  WindowLimiter,
  type LiveShare,
} from './shared-view-reads.js';
import { publicSharingPolicy } from './public-sharing.js';
import { runPublicSharingCommand } from './commands/public-sharing.js';
import { linkOf, liveShare, publishShare, shareSettings, stopShare, updateShare } from './shared-views.js';
import { publicTheme, requireThemeChoice } from '../themes/choices.js';
import { SnapshotCache } from './snapshots.js';
import { badViewSetting } from './view-settings.js';

const ViewParams = z.object({ viewId: ViewId });
const FileParams = z.object({
  recordId: RecordId,
  fieldId: FieldId,
  attachmentId: AttachmentId,
  variant: SharedFileVariant,
});
const FILE_POLICY =
  "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'";

/** Any malformed link reads as a missing one, so the page can say so calmly. */
function linkIdOf(params: unknown): string {
  const parsed = z.object({ linkId: SharedViewId }).safeParse(params);
  if (!parsed.success) throw notAvailable();
  return parsed.data.linkId;
}

/**
 * Only exact listed origins may frame an enabled page.  Every other page stays same-origin.  The
 * header is built from the origins read again, so a stored site that no longer fits, or one that
 * could carry a directive of its own, names nobody instead of reaching the response.
 */
export function frameHeaders(reply: FastifyReply, embed: SharedViewEmbed | null): void {
  const sites = embedAncestors(embed);
  const ancestors = sites.length ? sites.join(' ') : "'self'";
  const current = reply.raw.getHeader('content-security-policy');
  const directives = (typeof current === 'string' ? current : '')
    .split(';')
    .map((directive) => directive.trim())
    .filter((directive) => directive && !/^frame-ancestors\b/i.test(directive));
  directives.push(`frame-ancestors ${ancestors}`);
  reply.header('content-security-policy', directives.join('; '));
  if (sites.length) {
    reply.removeHeader('x-frame-options');
    reply.raw.removeHeader('x-frame-options');
  } else reply.header('x-frame-options', 'SAMEORIGIN');
}

/** A view's link for the people who can change its views, and the open routes that read through it. */
export async function sharedViewRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const key = ctx.config.secretKey;
  const session = { config: { policy: { kind: 'session' as const } } };
  const open = { config: { policy: { kind: 'public' as const } } };
  // Public reads keep their own orders, apart from signed-in people's, in a quarter of the budget.
  const cache = new SnapshotCache(() => dataStore(ctx), (ctx.config.snapshotCacheMb ?? 256) / 4, app.log);
  const requests = new WindowLimiter(ctx.config.sharedViewMinuteLimit ?? DEFAULT_MINUTE_LIMIT, 60_000);
  const tries = new WindowLimiter(PASSWORD_TRIES.limit, PASSWORD_TRIES.windowMs);
  // One network holds more addresses than any count per address can cover, so each link also
  // takes only so many wrong passwords in all.
  const linkTries = new WindowLimiter(PASSWORD_LINK_TRIES.limit, PASSWORD_LINK_TRIES.windowMs);

  // Direct file requests cannot carry a pass header, so their signatures bind to the host and current password.
  const fileKey = (request: FastifyRequest, live: LiveShare) =>
    createHmac('sha256', key)
      .update(JSON.stringify(['riosoma.publicFile', request.customDomain?.host ?? null, live.passwordHash]))
      .digest();

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/public/views/') && !request.url.startsWith('/v/')) return;
    const wait = requests.take(addressKey(key, clientAddress(request.ip)));
    if (wait) {
      reply.header('retry-after', String(wait));
      throw new AppError('rate_limited', 'shareView.rateLimited');
    }
  });
  app.addHook('onSend', async (_request, reply) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  /**
   * The view and what of it the person may share.  A link reads with its sharer's access, so its
   * address and settings stay with the sharer and the people no rule limits: anyone else would be
   * shown, through the link, what the rules keep from them.  Stopping a link only narrows what the
   * public reads, so `stopping` leaves that open to everyone who can change the view.
   */
  async function shareable(
    db: Queryable,
    schemas: DataSchemas,
    actor: Actor,
    viewId: string,
    options: { stopping?: boolean } = {},
  ) {
    const loaded = await loadView(db, schemas, viewId);
    if (!loaded || loaded.trashed) throw new AppError('not_found', 'errors.notFound');
    const scope = new AccessScope(db, schemas, actor);
    await scope.require(loaded.databaseId, 'editSchema');
    const limited = scope.limited(loaded.databaseId);
    if (!options.stopping && limited) {
      const link = await liveShare(db, schemas, viewId);
      if (link && link.created_by !== actor.userId)
        throw new AppError('forbidden', 'data.access.linkLimited');
    }
    const table = await loadTable(db, schemas, loaded.view.tableId);
    if (!table || table.trashed) throw new AppError('not_found', 'errors.notFound');
    const fields = scope.visibleFields(table.id, await loadFields(db, schemas, [table.id]));
    return {
      view: loaded.view,
      table,
      fields,
      // A field restricted from anyone never goes out through a public link.
      restricted: new Set(
        fields.filter((field) => scope.restrictedForAnyone(table.id, field)).map((field) => field.id),
      ),
      target: { databaseId: loaded.databaseId, tableId: table.id, viewId },
      // Sharing and changing ask again of the link they lock, in case one was shared since.
      limited,
    };
  }

  app.get('/api/views/:viewId/shared-view', session, async (request): Promise<SharedViewLink | null> => {
    const { viewId } = parse(ViewParams, request.params);
    const { pool, schemas } = dataStore(ctx);
    return withTransaction(pool, async (db) => {
      await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const { view, table, fields } = await shareable(db, schemas, requireActor(request), viewId);
      const row = isShareableViewType(view.type) ? await liveShare(db, schemas, viewId) : undefined;
      return row
        ? publicLink(ctx, row.org_id, 'views', linkOf(row, view, fields, table.primaryFieldId), db)
        : null;
    });
  });

  app.put('/api/views/:viewId/shared-view', session, async (request): Promise<SharedViewLink> => {
    const { viewId } = parse(ViewParams, request.params);
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    return retry(() =>
      withTransaction(pool, async (db) => {
        const { view, table, fields, target, limited } = await shareable(db, schemas, actor, viewId);
        if (!isShareableViewType(view.type)) badViewSetting('type');
        const row = await publishShare(db, schemas, actor, target, limited);
        return publicLink(ctx, row.org_id, 'views', linkOf(row, view, fields, table.primaryFieldId), db);
      }),
    );
  });

  app.patch('/api/views/:viewId/shared-view', session, async (request): Promise<SharedViewLink> => {
    const { viewId } = parse(ViewParams, request.params);
    const { password, ...update } = parse(SharedViewUpdate, request.body ?? {});
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    // Hashing is slow on purpose, so it waits for the access check and stays out of the transaction.
    if (typeof password === 'string') await shareable(pool, schemas, actor, viewId);
    const passwordHash =
      password === undefined ? undefined : password === null ? null : await hashPassword(password);
    return retry(() =>
      withTransaction(pool, async (db) => {
        const { view, table, fields, restricted, target, limited } = await shareable(
          db,
          schemas,
          actor,
          viewId,
        );
        if (!isShareableViewType(view.type)) badViewSetting('type');
        if (update.fieldIds?.some((id) => restricted.has(id)))
          throw new AppError('validation_failed', 'data.access.restrictedShare');
        const { embed, ...settings } = update;
        // A link's page may pick its own theme, which has to be one the person sharing may choose.
        if (settings.theme) {
          const existing = await liveShare(db, schemas, viewId);
          if (!sameTheme(settings.theme, existing ? shareSettings(existing.settings).theme : null))
            await requireThemeChoice(db, `"${schemas.app}"`, actor, settings.theme, ctx.config);
        }
        if (embed) {
          const existing = await liveShare(db, schemas, viewId);
          if (!existing) throw notAvailable();
          await runPublicSharingCommand(
            app,
            actor,
            {
              id: newId('command'),
              action: { kind: 'embed', target: { kind: 'view', linkId: existing.id }, embed },
            },
            db,
          );
        }
        const row = await updateShare(
          db,
          schemas,
          actor,
          target,
          { ...settings, passwordHash },
          fields,
          limited,
        );
        return publicLink(ctx, row.org_id, 'views', linkOf(row, view, fields, table.primaryFieldId), db);
      }),
    );
  });

  app.delete('/api/views/:viewId/shared-view', session, async (request, reply) => {
    const { viewId } = parse(ViewParams, request.params);
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    await retry(() =>
      withTransaction(pool, async (db) => {
        const { target } = await shareable(db, schemas, actor, viewId, { stopping: true });
        await stopShare(db, schemas, actor, target);
      }),
    );
    return reply.status(204).send();
  });

  /** A live link, once this browser has given its password when it has one. */
  async function unlocked(request: FastifyRequest, linkId: string): Promise<LiveShare> {
    const { pool, schemas } = dataStore(ctx);
    const live = await loadLiveShare(pool, schemas, linkId);
    if (
      live.passwordHash &&
      !passAccepted(
        key,
        linkId,
        live.passwordHash,
        request.customDomain
          ? (request.headers['x-public-view-pass'] as string | undefined)
          : request.cookies[passCookieName(linkId)],
      )
    )
      throw passwordRequired();
    return live;
  }

  app.get('/api/public/views/:linkId', open, async (request): Promise<SharedView> => {
    const linkId = linkIdOf(request.params);
    const { pool, schemas } = dataStore(ctx);
    const live = await loadLiveShare(pool, schemas, linkId);
    const theme = await publicTheme(
      pool,
      `"${schemas.app}"`,
      { orgId: live.orgId, sharerId: live.createdBy, hasUnits: live.hasUnits },
      live.settings.theme,
      live.databaseSettings,
      ctx.config,
    );
    if (
      live.passwordHash &&
      !passAccepted(
        key,
        linkId,
        live.passwordHash,
        request.customDomain
          ? (request.headers['x-public-view-pass'] as string | undefined)
          : request.cookies[passCookieName(linkId)],
      )
    )
      return { status: 'locked', theme };
    const read = await sharedRead(pool, schemas, live);
    const stackField = read.fields.find((field) => field.id === live.view.config.kanban.stackFieldId);
    // Stacks of people name only the people with cards, so the layout keeps its order for them alone.
    const people =
      live.view.type === 'kanban' && stackField?.type === 'user'
        ? new Set(
            Object.keys((await sharedStacks(pool, read, undefined, await cache.readContext())).people ?? {}),
          )
        : new Set<string>();
    return sharedLayout(read, theme, people);
  });

  app.post('/api/public/views/:linkId/password', { ...open, bodyLimit: 4096 }, async (request, reply) => {
    const linkId = linkIdOf(request.params);
    const input = parse(SharedViewUnlock, request.body);
    const { pool, schemas } = dataStore(ctx);
    const live = await loadLiveShare(pool, schemas, linkId);
    if (!live.passwordHash) return reply.status(204).send();
    // Each try is counted against the link before its slow check, so tries sent together can't
    // all slip under the limit, and a right one is given back so visitors never use the count up.
    const wait =
      tries.take(`${linkId}\n${addressKey(key, clientAddress(request.ip))}`) || linkTries.take(linkId);
    if (wait) {
      reply.header('retry-after', String(wait));
      throw new AppError('rate_limited', 'shareView.tooManyTries');
    }
    if (!(await verifyPassword(input.password, live.passwordHash)))
      throw new AppError('forbidden', 'shareView.passwordWrong');
    linkTries.refund(linkId);
    if (request.customDomain) return { pass: passCookie(key, linkId, live.passwordHash) };
    reply.setCookie(
      passCookieName(linkId),
      passCookie(key, linkId, live.passwordHash),
      passCookieOptions(linkId, request.protocol === 'https', live.settings.embed.enabled),
    );
    return reply.status(204).send();
  });

  app.get('/api/public/views/:linkId/rows', open, async (request): Promise<SharedRowsPage> => {
    const linkId = linkIdOf(request.params);
    const input = parse(SharedRowsQuery, request.query);
    const live = await unlocked(request, linkId);
    const { pool, schemas } = dataStore(ctx);
    const read = await sharedRead(pool, schemas, live);
    const context = await cache.readContext(input.tz);
    return sharedPage(
      pool,
      cache,
      read,
      input,
      context,
      fileSigner(
        fileKey(request, live),
        linkId,
        context.timeZone,
        Date.now(),
        (await publicSharingPolicy(pool, schemas, live.orgId)).fileLifetimeSeconds,
      ),
    );
  });

  app.post('/api/public/views/:linkId/aggregate', open, async (request) => {
    const linkId = linkIdOf(request.params);
    const input = parse(
      ViewAggregateRequest.omit({ where: true }).extend({
        timeZone: z.string().refine(isTimeZone),
        q: z.string().max(200).optional(),
      }),
      request.body,
    );
    const live = await unlocked(request, linkId);
    const { pool, schemas } = dataStore(ctx);
    return withTransaction(pool, async (db) => {
      await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      await query(db, sql`SELECT set_config('statement_timeout', '5000', true)`);
      const read = await sharedRead(db, schemas, live);
      return sharedAggregate(
        db,
        read,
        input,
        await cache.readContext(input.timeZone),
        input.q,
        fileSigner(
          fileKey(request, live),
          linkId,
          input.timeZone,
          Date.now(),
          (await publicSharingPolicy(db, schemas, live.orgId)).fileLifetimeSeconds,
        ),
      );
    });
  });

  app.get('/api/public/views/:linkId/position', open, async (request): Promise<PositionResult> => {
    const linkId = linkIdOf(request.params);
    const input = parse(SharedPositionQuery, request.query);
    const live = await unlocked(request, linkId);
    const { pool, schemas } = dataStore(ctx);
    const read = await sharedRead(pool, schemas, live);
    return sharedPosition(cache, read, input, await cache.readContext(input.tz));
  });

  app.get('/api/public/views/:linkId/stacks', open, async (request): Promise<SharedStackCounts> => {
    const linkId = linkIdOf(request.params);
    const input = parse(SharedStacksQuery, request.query);
    const live = await unlocked(request, linkId);
    const { pool, schemas } = dataStore(ctx);
    const read = await sharedRead(pool, schemas, live);
    return sharedStacks(pool, read, input.q, await cache.readContext(input.tz));
  });

  app.get('/api/public/views/:linkId/download', open, async (request, reply) => {
    const linkId = linkIdOf(request.params);
    const input = parse(SharedDownloadQuery, request.query);
    const live = await unlocked(request, linkId);
    if (!live.settings.allowCopy) throw new AppError('forbidden', 'shareView.noDownload');
    const { pool, schemas } = dataStore(ctx);
    const read = await sharedRead(pool, schemas, live);
    return sharedDownload(reply, pool, cache, read, input, await cache.readContext(input.timeZone));
  });

  app.get(
    '/api/public/views/:linkId/files/:recordId/:fieldId/:attachmentId/:variant',
    open,
    async (request, reply) => {
      const linkId = linkIdOf(request.params);
      const params = FileParams.safeParse(request.params);
      const signed = SharedFileQuery.safeParse(request.query);
      const place =
        params.success && signed.success ? { linkId, ...params.data, timeZone: signed.data.tz } : null;
      // A forged, altered, or expired address reads like one that never existed.
      if (!place || !signed.success) throw notAvailable();
      const { pool, schemas } = dataStore(ctx);
      const live = request.customDomain
        ? await loadLiveShare(pool, schemas, linkId)
        : await unlocked(request, linkId);
      const policy = await publicSharingPolicy(pool, schemas, live.orgId);
      if (
        !policy.publicFiles ||
        !fileAccepted(fileKey(request, live), place, signed.data, Date.now(), policy.fileLifetimeSeconds)
      )
        throw notAvailable();
      const read = await sharedRead(pool, schemas, live);
      // Hiding the field, or the record leaving the view, takes the file back at once.
      const file = await sharedFile(pool, read, place, await cache.readContext(place.timeZone));
      if (!file) throw notAvailable();
      return sendFile(request, reply, file, place.variant);
    },
  );

  async function sendFile(
    request: FastifyRequest,
    reply: FastifyReply,
    file: FileRow,
    variant: SharedFileVariant,
  ) {
    const { pool, schemas } = dataStore(ctx);
    const preview = variant === 'file' ? undefined : file.thumbnails?.[variant];
    if (variant !== 'file' && !preview) throw notAvailable();
    const type = preview ? 'image/webp' : file.type;
    const etag = `"${preview?.sha256 ?? file.sha256}"`;
    const attachment = disposition(type, preview ? `${file.name}.webp` : file.name);
    reply.headers({
      'content-type': type,
      'content-length': preview?.size ?? Number(file.size),
      etag,
      'content-disposition': attachment,
      'x-content-type-options': 'nosniff',
      'content-security-policy': FILE_POLICY,
      'cache-control': 'no-store',
    });
    if (
      request.headers['if-none-match']
        ?.split(',')
        .map((tag) => tag.trim())
        .includes(etag)
    ) {
      reply.removeHeader('content-length');
      return reply.code(304).send();
    }
    const storage = fileStorage(file.storage, pool, schemas.app, ctx.config);
    const key = preview?.key ?? file.storage_key;
    return reply.send(storage.read(key));
  }

  /** The page, with a frame policy that follows the link's embedding settings. */
  app.get('/v/:linkId', async (request, reply) => {
    let embed: SharedViewEmbed | null = null;
    const parsed = z.object({ linkId: SharedViewId }).safeParse(request.params);
    if (parsed.success && ctx.pool && ctx.config.database) {
      try {
        const { pool, schemas } = dataStore(ctx);
        const live = await loadLiveShare(pool, schemas, parsed.data.linkId);
        await sharedRead(pool, schemas, live);
        if ((await publicSharingPolicy(pool, schemas, live.orgId)).embeddingEnabled)
          embed = live.settings.embed;
      } catch (error) {
        // A missing or stopped link still gets its error page, with same-origin framing.
        if (!(error instanceof AppError)) request.log.warn({ err: error }, 'shared view frame lookup failed');
      }
    }
    frameHeaders(reply, embed);
    if (typeof reply.sendFile !== 'function')
      return reply.status(404).send(new AppError('not_found', 'errors.notFound').toBody());
    if (request.customDomain) return sendShell(reply, ctx.publicPageHtml!());
    return sendShell(reply.header('cache-control', 'no-cache'), ctx.appPageHtml!());
  });
}
