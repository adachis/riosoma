import { siteHandler } from '../sites/routes.js';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CustomDomainHost, type PublicPageKind } from '@riosoma/contracts';
import { authDatabase } from '../auth/database.js';
import { bookingOfToken } from '../bookings/public.js';
import { fileStoreOrigins, mapOrigins } from '../http/app-config.js';
import { downloadClaims, signingClaims } from '../signatures/token.js';
import { knownDomain, unavailable, type DomainRow } from './store.js';
import { addressAllowed } from './settings.js';

declare module 'fastify' {
  interface FastifyRequest {
    customDomain: DomainRow | null;
    publicDomainRequest: boolean;
  }
}

/**
 * The host a request names, lowercased, without its port or trailing dots, and with an IPv6
 * literal's brackets removed.  Forwarded host headers never select a tenant, even when the peer is
 * a trusted proxy.
 */
export function hostname(host: string | undefined): string | null {
  if (!host || !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::\d{1,5})?$/i.test(host)) return null;
  try {
    return new URL(`http://${host}`).hostname
      .toLowerCase()
      .replace(/\.+$/, '')
      .replace(/^\[(.*)\]$/, '$1');
  } catch {
    return null;
  }
}

/** Only the private TLS ingress can attest the authority that the visitor actually connected to. */
export function boundPublicAuthority(request: FastifyRequest): boolean {
  const { config } = request.server.ctx;
  const expected = config.tlsAskToken;
  const token = request.headers['x-riosoma-authority-token'];
  const authority = request.headers['x-riosoma-public-authority'];
  return Boolean(
    request.customDomain &&
    typeof authority === 'string' &&
    hostname(authority) === request.customDomain.host &&
    hostname(request.headers.host) === request.customDomain.host &&
    expected &&
    typeof token === 'string' &&
    Buffer.byteLength(token) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(token), Buffer.from(expected)) &&
    addressAllowed(request.raw.socket.remoteAddress, config.tlsAskAddresses ?? ''),
  );
}

interface PublicRoute {
  kind: PublicPageKind;
  table?: 'public_forms' | 'shared_views' | 'booking_pages' | 'signature_requests';
  id?: string;
  cancel?: boolean;
  signature?: boolean;
}

/** An explicit method and path allowlist prevents new public APIs from becoming tenant escapes. */
function publicRoute(path: string, method: string): PublicRoute | null {
  const read = method === 'GET' || method === 'HEAD';
  let match: RegExpExecArray | null;
  if (read && (match = /^\/f\/([A-Za-z0-9]+)(?:\/edit)?$/.exec(path)))
    return { kind: 'forms', table: 'public_forms', id: match[1] };
  if (read && (match = /^\/v\/([A-Za-z0-9]+)$/.exec(path)))
    return { kind: 'views', table: 'shared_views', id: match[1] };
  if (read && (match = /^\/b\/([A-Za-z0-9]+)$/.exec(path)))
    return { kind: 'bookings', table: 'booking_pages', id: match[1] };
  if (read && path === '/signatures') return { kind: 'signing' };
  if (
    (read && path === '/bookings/cancel') ||
    ((read || method === 'POST') && path === '/api/public/bookings/cancel')
  )
    return { kind: 'bookings', cancel: true };
  if (
    (match =
      /^\/api\/public\/forms\/([A-Za-z0-9]+)(\/submissions|\/edit-session|\/edits|\/files\/[A-Za-z0-9]+)?$/.exec(
        path,
      )) &&
    (['/submissions', '/edit-session', '/edits'].includes(match[2] ?? '') ? method === 'POST' : read)
  )
    return { kind: 'forms', table: 'public_forms', id: match[1] };
  if (
    (match = /^\/api\/public\/views\/([A-Za-z0-9]+)(.*)$/.exec(path)) &&
    ((read &&
      /^(?:|\/rows|\/position|\/stacks|\/download|\/ingest\/files\/[A-Za-z0-9_-]+\/original|\/files\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/(?:file|small|large))$/.test(
        match[2]!,
      )) ||
      (method === 'POST' && (match[2] === '/password' || match[2] === '/aggregate')))
  )
    return { kind: 'views', table: 'shared_views', id: match[1] };
  if (
    read &&
    /^\/api\/public\/sites\/[A-Za-z0-9_-]+\/tables\/[A-Za-z0-9]+\/ingest\/files\/[A-Za-z0-9_-]+\/original$/.test(
      path,
    )
  )
    return { kind: 'sites' };
  if (
    (match = /^\/api\/public\/bookings\/([A-Za-z0-9]+)(\/slots|\/bookings)?$/.exec(path)) &&
    (match[2] === '/bookings' ? method === 'POST' : read)
  )
    return { kind: 'bookings', table: 'booking_pages', id: match[1] };
  if (
    (read && /^\/api\/public\/signatures(?:\/document|\/download)?$/.test(path)) ||
    (method === 'POST' && /^\/api\/public\/signatures\/(sign|decline)$/.test(path))
  )
    return { kind: 'signing', signature: true };
  if (read && path === '/api/public/config') return { kind: 'views' };
  return null;
}

function publicAsset(path: string, method: string): boolean {
  return (
    (method === 'GET' || method === 'HEAD') &&
    !path.includes('..') &&
    (/^\/(?:boot\.js|layers\.css|pressable\.css|icons\/(?:favicon-32\.png|icon\.svg|apple-touch-icon\.png))$/.test(
      path,
    ) ||
      /^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2?|ttf|png|webp|svg)$/.test(path) ||
      /^\/themes\/[A-Za-z0-9_./-]+\.(?:css|json|woff2?|ttf|png|jpe?g|webp|svg)$/.test(path))
  );
}

async function ownsPage(app: FastifyInstance, request: FastifyRequest, route: PublicRoute): Promise<boolean> {
  const domain = request.customDomain!;
  if (!domain.kinds.includes(route.kind)) return false;
  const { pool, app: schema } = authDatabase(app.ctx);
  let { table, id } = route;
  if (route.signature) {
    const token = (request.query as { token?: unknown }).token;
    if (typeof token !== 'string') return false;
    const claims =
      request.url.split('?')[0] === '/api/public/signatures/download'
        ? downloadClaims(app.ctx.config.secretKey, token)
        : signingClaims(app.ctx.config.secretKey, token);
    if (!claims) return false;
    table = 'signature_requests';
    id = claims.requestId;
  }
  if (route.cancel) {
    const token = ((request.method === 'POST' ? request.body : request.query) as { token?: unknown } | null)
      ?.token;
    if (typeof token !== 'string') return false;
    const bookingId = bookingOfToken(app.ctx.config.secretKey, token);
    if (!bookingId) return false;
    const result = await pool.query(
      `SELECT 1 FROM ${schema}.bookings b JOIN ${schema}.booking_pages p ON p.id = b.page_id
        WHERE b.id = $1 AND p.org_id = $2`,
      [bookingId, domain.org_id],
    );
    return Boolean(result.rowCount);
  }
  if (!table || !id) return true;
  const result = await pool.query(`SELECT 1 FROM ${schema}.${table} WHERE id = $1 AND org_id = $2`, [
    id,
    domain.org_id,
  ]);
  return Boolean(result.rowCount);
}

/** Classify public hosts and discard app credentials before authentication or demo exemptions. */
export function installCustomDomainClassification(app: FastifyInstance): void {
  app.decorateRequest('customDomain', null);
  app.decorateRequest('publicDomainRequest', false);
  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0]!;
    // The ask route checks the socket address and token itself, independently of Host and forwarding.
    if (path === '/internal/tls/allow') return;
    const host = hostname(request.headers.host);
    // No Host, an address, or a name that can't be a custom domain, such as localhost or a service
    // name, is the main app, as it always was, with no lookup.  So are health checks sent that way.
    if (!host || isIP(host) || !CustomDomainHost.safeParse(host).success) return;
    const main = app.ctx.config.baseUrl ? hostname(new URL(app.ctx.config.baseUrl).host) : null;
    if (host === main) return;
    // Only a host some organization verified is a custom domain.  Every other host, including one
    // that's added but not verified yet, is the main app.
    const known = await knownDomain(app.ctx, host);
    if (!known) return;
    request.publicDomainRequest = true;
    // Public hosts never use app credentials, including parent-domain cookies supplied by browsers.
    delete request.headers.cookie;
    delete request.headers.authorization;
    delete request.headers['x-csrf-token'];
    request.cookies = {};
    if (!request.actor?.demo) request.actor = null;
    // A host that lost its verification, or was removed, serves nothing at all.
    if (!known.active) throw unavailable();
    const domain = known.row;
    request.customDomain = domain;
  });
}

export function installCustomDomainServing(app: FastifyInstance): void {
  const serveSite = siteHandler(app);
  app.addHook('onRequest', async (request, reply) => {
    const domain = request.customDomain;
    if (!domain) return;
    const path = request.url.split('?')[0]!;
    if (domain.kinds.includes('sites')) {
      const { pool, app: schema } = authDatabase(app.ctx);
      const sites = await pool.query<{ slug: string; settings: { theme: { id: string } } }>(
        `SELECT slug, settings FROM ${schema}.published_sites WHERE domain_id = $1 AND org_id = $2 AND published`,
        [domain.id, domain.org_id],
      );
      const site = sites.rows[0];
      if (site) {
        request.siteDomainSlug = site.slug;
        // Original handlers check publication and domain binding before streaming bytes.
        if (publicRoute(path, request.method)?.kind === 'sites') return;
        const themeRoot = `/themes/${site.settings.theme.id}/`;
        if (
          (request.method === 'GET' || request.method === 'HEAD') &&
          path.startsWith(themeRoot) &&
          !path.includes('..') &&
          publicAsset(path, request.method)
        )
          return;
        if (request.method === 'POST' && /^\/forms\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(path)) return;
        if (request.method !== 'GET' && request.method !== 'HEAD') throw unavailable();
        return serveSite(request, reply);
      }
    }
    const route = publicRoute(path, request.method);
    if ((!route || !domain.kinds.includes(route.kind)) && !publicAsset(path, request.method))
      throw unavailable();
  });
  app.addHook('preHandler', async (request) => {
    if (!request.customDomain || request.siteDomainSlug) return;
    const route = publicRoute(request.url.split('?')[0]!, request.method);
    if (route && !(await ownsPage(app, request, route))) throw unavailable();
  });
}

export function installCustomDomainResponses(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply) => {
    if (!request.publicDomainRequest) return;
    reply.removeHeader('set-cookie');
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    const current = String(reply.getHeader('content-security-policy') ?? '');
    if (/^sandbox\b/.test(current)) return;
    const frames = current
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('frame-ancestors '));
    const views = request.customDomain?.kinds.includes('views');
    const maps = views ? mapOrigins(app.ctx.config) : [];
    const stores = views ? fileStoreOrigins(app.ctx.config) : [];
    const hashes = (current.match(/(?:^|;)\s*script-src ([^;]+)/)?.[1]?.split(/\s+/) ?? []).filter((source) =>
      /^'sha256-[A-Za-z0-9+/]+=*'$/.test(source),
    );
    reply.header(
      'content-security-policy',
      [
        "default-src 'none'",
        ["script-src 'self'", ...hashes].join(' '),
        "style-src 'self'",
        "font-src 'self'",
        `img-src 'self' data: blob: ${[...maps, ...stores].join(' ')}`,
        `media-src 'self' ${stores.join(' ')}`,
        `connect-src 'self' ${maps.join(' ')}`,
        views ? "worker-src 'self' blob:" : "worker-src 'none'",
        "frame-src 'self' blob:",
        frames ?? "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
      ].join('; '),
    );
  });
}
