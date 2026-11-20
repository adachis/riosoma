import { demoPages, demoSitePageSettings, demoSiteSettings } from '../demo/metadata.js';
import { createHash, createHmac } from 'node:crypto';
import { AppError, SiteSlug } from '@riosoma/contracts';
import { withTransaction, query, sql } from '@riosoma/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { themesRoot, type AppContext } from '../app.js';
import { clientAddress } from '../authorization/store.js';
import { dataStore } from '../data/context.js';
import { addressKey, WindowLimiter } from '../data/shared-view-reads.js';
import { serveForm } from './forms.js';
import { policyFor, siteTransportSecurity } from './headers.js';
import { serveImage } from './media.js';
import { checkAddress, invalid, readPage, SITE_LIMITS } from './reads.js';
import { escape, renderPage, SITE_SCRIPT } from './render.js';
import { liveSite, unavailable, type LiveSite } from './store.js';
import { readSiteTheme, siteCss } from './site.css.js';

declare module 'fastify' {
  interface FastifyRequest {
    siteDomainSlug: string | null;
  }
}

export interface SiteRates {
  visitor: number;
  renders: number;
  windowMs: number;
  cacheMs: number;
  cacheBytes: number;
}

/**
 * How much one visitor, and one site, may ask of each server process.  A server reads these as it
 * starts, so a test may lower them before starting one.
 *
 * - `visitor`: requests a minute from one address to any site, cached or not.  An IPv6 address
 *   counts as its /64, so moving around inside one network doesn't reset it.  Search engines are
 *   visitors like any other: beyond this they get 429 with a `Retry-After`, which they honor.
 * - `renders`: pages a minute one site renders anew.  Only pages the cache can't answer count, and
 *   the ceiling is well above what one address may ask for, so no one visitor can spend it and
 *   lock everyone else out.
 * - `cacheMs`: how long a rendered page may answer while its database hasn't changed.  Access is
 *   checked on every request whatever this says.  It bounds what the change log doesn't cover,
 *   such as a filter on today's date or a person's new name.
 */
export const SITE_RATES: SiteRates = {
  visitor: 240,
  renders: 1200,
  windowMs: 60_000,
  cacheMs: 5 * 60_000,
  cacheBytes: 16 * 1024 * 1024,
};

const publicSitePath = (path: string) => /^\/(?:sites(?:\/|$)|api\/public\/sites(?:\/|$))/.test(path);
/** A record's address: its ID, after its slug when the page has a field for them */
const RECORD_ADDRESS = /^(?:[a-z0-9-]{1,64}~)?[0-9A-Za-z_-]{1,40}$/;

export function installSiteProtection(app: FastifyInstance): void {
  app.decorateRequest('siteDomainSlug', null);
  app.addHook('onRequest', async (request) => {
    if (!publicSitePath(request.url) && !request.url.startsWith('/themes/')) return;
    delete request.headers.cookie;
    delete request.headers.authorization;
    delete request.headers['x-csrf-token'];
    request.cookies = {};
    if (!request.actor?.demo) request.actor = null;
  });
}
export function installSiteResponses(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply) => {
    if (!publicSitePath(request.url) && !request.siteDomainSlug) return;
    siteTransportSecurity(request, reply);
    reply.removeHeader('set-cookie');
    reply.header('cache-control', 'no-store');
    reply.header('content-security-policy', policyFor(request));
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-content-type-options', 'nosniff');
  });
}

const handlers = new WeakMap<AppContext, ReturnType<typeof createSiteHandler>>();
export function siteHandler(app: FastifyInstance) {
  let handler = handlers.get(app.ctx);
  if (!handler) {
    handler = createSiteHandler(app);
    handlers.set(app.ctx, handler);
  }
  return handler;
}

interface Rendered {
  /** The database's change sequence the page was read at */
  version: string;
  at: number;
  body: string;
  bytes: number;
}

/**
 * Rendered pages, by everything that decides what they show but the data: the site as stored,
 * its publisher and what their access lets them see, and the address.  The oldest go first once
 * the pages together pass the byte limit.
 */
class RenderCache {
  private readonly pages = new Map<string, Rendered>();
  private bytes = 0;

  /** A page read at this version, while it's recent enough */
  get(key: string, version: string, now = Date.now()): string | null {
    const page = this.pages.get(key);
    return page && page.version === version && now - page.at < SITE_RATES.cacheMs ? page.body : null;
  }

  set(key: string, version: string, body: string, now = Date.now()): void {
    this.drop(key);
    const bytes = Buffer.byteLength(body);
    for (const oldest of this.pages.keys()) {
      if (this.bytes + bytes <= SITE_RATES.cacheBytes) break;
      this.drop(oldest);
    }
    this.pages.set(key, { version, at: now, body, bytes });
    this.bytes += bytes;
  }

  private drop(key: string): void {
    const page = this.pages.get(key);
    if (!page) return;
    this.pages.delete(key);
    this.bytes -= page.bytes;
  }
}

async function cacheKey(live: LiveSite, address: unknown[], demo: boolean): Promise<string> {
  const { row, scope } = live;
  const access = await scope.fingerprint(row.database_id);
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.slug,
        row.publisher_id,
        row.updated_at,
        row.settings,
        row.pages,
        access,
        address,
        demo,
      ]),
    )
    .digest('hex');
}

function createSiteHandler(app: FastifyInstance) {
  const visitors = new WindowLimiter(SITE_RATES.visitor, SITE_RATES.windowMs);
  const renders = new WindowLimiter(SITE_RATES.renders, SITE_RATES.windowMs);
  const cache = new RenderCache();
  const secret = app.ctx.config.secretKey;
  const limited = (reply: FastifyReply, wait: number): never => {
    reply.header('retry-after', String(wait));
    throw new AppError('rate_limited', 'shareView.rateLimited');
  };
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split('?')[0]!;
    const custom = request.siteDomainSlug;
    const api = path.startsWith('/api/public/sites/');
    const match = /^\/(?:sites|api\/public\/sites)\/([^/]+)(?:\/(.*))?$/.exec(path);
    const slug = custom ?? match?.[1];
    if (!slug || !SiteSlug.safeParse(slug).success) unavailable();
    const parts = (custom ? path.slice(1) : (match?.[2] ?? '')).split('/').filter(Boolean);
    if (request.url.length > 4096) invalid();
    const wait = visitors.take(addressKey(secret, clientAddress(request.ip)));
    if (wait) limited(reply, wait);
    const { pool, schemas } = dataStore(app.ctx);
    const domainId = custom ? request.customDomain?.id : undefined;
    const live = await liveSite(pool, schemas, slug, domainId);
    const base = custom ? '' : `/sites/${slug}`;
    const origin = custom
      ? `https://${request.customDomain!.host}`
      : app.ctx.config.baseUrl
        ? new URL(app.ctx.config.baseUrl).origin
        : '';
    if (parts[0] === 'forms' && !api) return serveForm(request, reply, live, parts, base, origin);
    if (request.method !== 'GET' && request.method !== 'HEAD') unavailable();
    if (!api && parts.length === 2 && parts[0] === 'assets') {
      if (parts[1] === 'site.css') return reply.type('text/css').send(siteCss(live.settings.motion));
      if (parts[1] === 'theme.css')
        return reply
          .type('text/css')
          .send(await readSiteTheme(themesRoot(app.ctx.config) ?? unavailable(), live.settings.theme.id));
      if (parts[1] === 'site.js') return reply.type('text/javascript').send(SITE_SCRIPT);
      unavailable();
    }
    if (!api && parts.length === 2 && parts[0] === 'media')
      return serveImage(request, reply, live, parts[1]!);
    if (!api && parts.length === 1 && parts[0] === 'robots.txt')
      return reply
        .type('text/plain')
        .send(
          `User-agent: *\n${live.settings.noIndex ? 'Disallow: /' : 'Allow: /'}\nSitemap: ${origin}${base}/sitemap.xml\n`,
        );
    if (!api && parts.length === 1 && parts[0] === 'sitemap.xml')
      return reply
        .type('application/xml')
        .send(
          `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${live.settings.pages.map((page) => `<url><loc>${escape(`${origin}${base}/${page.slug}`)}</loc></url>`).join('')}</urlset>`,
        );
    if (parts.length > 2 || (parts[1] !== undefined && !RECORD_ADDRESS.test(parts[1]))) unavailable();
    const pageOf = (site: LiveSite) => {
      const settings =
        site.settings.pages.find((page) => page.slug === parts[0]) ??
        (parts.length === 0 ? site.settings.pages[0]! : unavailable());
      return { settings, page: site.pages.find((item) => item.id === settings.pageId) ?? unavailable() };
    };
    // Everything that could make this address a new page is checked before anything is read.
    const input = checkAddress(pageOf(live).page, request.query as Record<string, unknown>);
    const address = [api, base, origin, parts, input];
    const cached = cache.get(await cacheKey(live, address, Boolean(request.actor?.demo)), live.version);
    const type = api ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8';
    if (cached !== null) return reply.type(type).send(cached);
    const delay = renders.take(slug);
    if (delay) limited(reply, delay);
    const personKey = (userId: string) =>
      createHmac('sha256', secret)
        .update(`riosoma.site.person\n${slug}\n${userId}`)
        .digest('base64url')
        .slice(0, 22);
    const { fresh, settings, page, content } = await withTransaction(pool, async (db) => {
      await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      await query(db, sql`SELECT set_config('statement_timeout', '2000', true)`);
      const fresh = await liveSite(db, schemas, slug, domainId);
      const { settings, page } = pageOf(fresh);
      const content = await readPage(
        db,
        schemas,
        fresh,
        page,
        settings,
        input,
        parts[1],
        request.log,
        personKey,
        app.ctx.config,
      );
      return { fresh, settings, page, content };
    });
    const serialized = JSON.stringify(content);
    if (Buffer.byteLength(serialized) > SITE_LIMITS.bytes)
      throw new AppError('payload_too_large', 'errors.tooLarge');
    const body = api
      ? serialized
      : renderPage(
          request.actor?.demo ? demoSiteSettings(fresh.settings) : fresh.settings,
          request.actor?.demo ? demoPages([page])[0]! : page,
          request.actor?.demo ? demoSitePageSettings(settings) : settings,
          content,
          base,
          origin,
          input,
          parts[1],
        );
    if (Buffer.byteLength(body) > SITE_LIMITS.bytes)
      throw new AppError('payload_too_large', 'errors.tooLarge');
    // Kept under what was read, at the version it was read at, so it never outlives either.
    cache.set(await cacheKey(fresh, address, Boolean(request.actor?.demo)), fresh.version, body);
    return reply.type(type).send(body);
  };
}

export async function sitePublicRoutes(app: FastifyInstance): Promise<void> {
  const handle = siteHandler(app);
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 64 * 1024 },
    (_request, body, done) => done(null, body),
  );
  app.post(
    '/forms/:pageId/:blockId',
    { config: { policy: { kind: 'public' } }, bodyLimit: 64 * 1024 },
    async (request, reply) => {
      if (!request.siteDomainSlug) unavailable();
      return handle(request, reply);
    },
  );
  const open = { config: { policy: { kind: 'public' as const } }, bodyLimit: 64 * 1024 };
  for (const url of [
    '/sites/:slug',
    '/sites/:slug/*',
    '/api/public/sites/:slug',
    '/api/public/sites/:slug/*',
  ]) {
    app.route({ method: ['GET', 'POST'], url, ...open, handler: handle });
  }
}
