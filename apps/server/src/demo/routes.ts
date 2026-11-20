import { allowDemoExchange } from '../authorization/protocol.js';
import { authenticateToken } from '../auth/tokens.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '@riosoma/contracts';
import { SITE_RATES } from '../sites/routes.js';
import { addressKey, WindowLimiter } from '../data/shared-view-reads.js';
import { clientAddress } from '../authorization/store.js';
import { demoRequest, demoReadOnly, protectDemoOutbound, protectDemoPool, refuseDemo } from './boundary.js';
import { clearDemoCookie, resolveDemo } from './sessions.js';
import { refuseDemoAuthentication } from '../auth/database.js';
import { readPending } from '../auth/mfa/pending.js';
import { readCookie } from '../auth/mfa/cookies.js';
import { INVITATION_COOKIE } from '../auth/invitation-cookie.js';
import { demoBrowserPolicy } from './browser-policy.js';
import { boundPublicAuthority } from '../custom-domains/serving.js';

/** Safe reads are reviewed individually.  Everything else, including a new route, is refused. */
export const DEMO_READS = new Set([
  'GET /healthz',
  'GET /readyz',
  'GET /api/config',
  'GET /api/setup/status',
  'GET /api/auth/session',
  'GET /api/auth/logo/:key',
  'GET /api/org/logo/:key',
  'GET /api/home',
  'GET /api/databases',
  'GET /api/files',
  'GET /api/files/:attachmentId/:name',
  'GET /api/files/:attachmentId/thumbnails/:size',
  'GET /api/databases/:databaseId/schema',
  'GET /api/views/:viewId/rows',
  'GET /api/views/:viewId/stacks',
  'GET /api/views/:viewId/ranges',
  'GET /api/views/:viewId/position',
  'POST /api/views/:viewId/search',
  'GET /api/tables/:tableId/records/:recordId',
  'POST /api/tables/:tableId/records/names',
  'POST /api/tables/:tableId/records/history',
  'GET /api/tables/:tableId/records/search',
  'POST /api/dashboards/:dashboardId/tiles/:tileId/records',
  'GET /api/interfaces/code-frame',
  'GET /sites/:slug',
  'GET /sites/:slug/*',
  'GET /api/public/sites/:slug',
  'GET /api/public/sites/:slug/*',
  'GET /api/tables/:tableId/records/:recordId/history',
  'GET /api/tables/:tableId/records/:recordId/comments',
  'GET /api/fields/:fieldId/select-options',
  'POST /api/fields/:fieldId/link-options',
  'POST /api/dashboards/:dashboardId/data',
  'POST /api/databases/:databaseId/views/:viewId/aggregate',
  'POST /api/interfaces/:interfaceId/data',
  'POST /api/interfaces/:interfaceId/records',
]);

export function demoRouteDecision(method: string, url: string): 'read' | 'internal' | 'refuse' {
  const verb = method === 'HEAD' ? 'GET' : method;
  if (verb === 'GET' && url === '/internal/tls/allow') return 'internal';
  if (url === '/*' || url === '/themes/*') return verb === 'GET' ? 'read' : 'refuse';
  return DEMO_READS.has(`${verb} ${url}`) ? 'read' : 'refuse';
}

// Published sites also serve shared build and theme assets outside their visitor request budget.
function sharedAsset(url: string, path: string): boolean {
  return url === '/themes/*' || (url === '/*' && /^\/(?:assets|icons|brand)\//.test(path));
}

const registered = new WeakMap<FastifyInstance, string[]>();
// Refused requests also need the browser policy, before a demo actor has been resolved.
const restrictedRequests = new WeakSet<FastifyRequest>();
export function demoRoutes(app: FastifyInstance): readonly string[] {
  return registered.get(app) ?? [];
}

export function installDemoBoundary(app: FastifyInstance): void {
  protectDemoOutbound();
  if (app.ctx.pool) protectDemoPool(app.ctx.pool);
  const routes: string[] = [];
  registered.set(app, routes);
  const requests = new WindowLimiter(SITE_RATES.visitor, SITE_RATES.windowMs);
  app.addHook('onRequest', (request, reply, done) => {
    if (request.headers.upgrade?.toLowerCase() === 'websocket') {
      const socket = reply.raw.socket;
      // Early refusals precede the socket plugin's request marker and its cleanup hook.
      reply.raw.once('finish', () => socket?.end(() => socket.destroy()));
    }
    done();
  });
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) routes.push(`${method} ${route.url}`);
    const handler = route.handler;
    route.handler = function (request, reply) {
      const work = () => handler.call(this, request, reply);
      return request.actor?.demo ? demoRequest(work) : work();
    };
  });
  // This runs after cookie parsing and before access policies or body parsing.
  app.addHook('onRequest', async (request, reply) => {
    if (!app.ctx.config.demoMode) return;
    const url = request.routeOptions.url ?? '';
    // Certificate checks authenticate the proxy's token and socket address in their handler.
    // They must stay available without a visitor session or its request budget.
    const decision =
      request.customDomain && request.method !== 'GET' && request.method !== 'HEAD'
        ? 'refuse'
        : demoRouteDecision(request.method, url);
    if (decision === 'internal') return;
    // The private TLS ingress binds the classified Host to its connection's authority.
    // Site routing still requires a published site, page, and form before recording an answer.
    if (
      request.customDomain?.kinds.includes('sites') &&
      request.method === 'POST' &&
      url === '/forms/:pageId/:blockId' &&
      /^\/forms\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(request.url.split('?')[0]!) &&
      boundPublicAuthority(request)
    )
      return;
    if (
      !request.publicDomainRequest &&
      request.method === 'GET' &&
      request.url.split('?')[0] === '/sign-in'
    ) {
      clearDemoCookie(request, reply);
      return;
    }
    const policy = request.routeOptions.config.policy;
    const real =
      policy?.kind === 'token' && request.headers.authorization
        ? await authenticateToken(app.ctx, request, policy.scope).catch((error: unknown) => {
            if (error instanceof AppError && error.messageKey === 'demo.readOnly') throw error;
            return null;
          })
        : await app.ctx.sessions.resolve(request);
    if (real && !real.demo) {
      request.actor = real;
      return;
    }
    // OAuth exchanges carry their own identity in the body, which is available at preValidation.
    if (request.method === 'POST' && url === '/oauth/token') return;
    // Real authentication stays available at /sign-in after that page clears the demo cookie.
    const hasDemoCookie = Boolean(request.cookies.rio_demo || request.cookies['__Host-rio_demo']);
    if (!hasDemoCookie && policy?.kind === 'public' && url.startsWith('/api/auth/')) return;
    restrictedRequests.add(request);
    if (hasDemoCookie && /^\/(?:sign-in\/|join(?:\?|$)|oauth\/)/.test(request.url))
      return reply.code(403).send(demoReadOnly().toBody(request.id));
    const wait = sharedAsset(url, request.url)
      ? 0
      : requests.take(addressKey(app.ctx.config.secretKey, clientAddress(request.ip)));
    if (wait) {
      reply.header('retry-after', String(wait));
      throw new AppError('rate_limited', 'demo.tryLater');
    }
    if (decision !== 'read') {
      reply.header('cache-control', 'no-store');
      return reply.code(403).send(demoReadOnly().toBody(request.id));
    }
    try {
      request.actor = await resolveDemo(app.ctx, request, reply);
    } catch (error) {
      if (error instanceof AppError && error.status === 429) reply.header('retry-after', '60');
      throw error;
    }
    reply.header('cache-control', 'no-store');
  });
  app.addHook('onRequest', (request, _reply, done) => {
    if (request.actor?.demo) demoRequest(done);
    else done();
  });
  app.addHook('preValidation', async (request) => {
    if (!app.ctx.config.demoMode) return;
    if (request.method === 'POST' && request.routeOptions.url === '/oauth/token') {
      try {
        await allowDemoExchange(app.ctx, request, (request.body ?? {}) as Record<string, string>);
      } catch {
        throw demoReadOnly();
      }
      return;
    }
    if (!request.routeOptions.url?.startsWith('/api/auth/')) return;
    const input = request.body as { email?: unknown; token?: unknown; response?: { id?: unknown } } | null;
    const params = request.params as { token?: unknown } | null;
    const query = request.query as { email?: unknown } | null;
    const invitation = /^\/api\/auth\/(?:sso|saml)\/[^/]+\/start$/.test(request.routeOptions.url)
      ? readCookie(app.ctx, request, INVITATION_COOKIE)?.token
      : undefined;
    await refuseDemoAuthentication(app.ctx, {
      email: input?.email ?? query?.email,
      token: input?.token ?? params?.token ?? invitation,
      credentialId: input?.response?.id,
      userId: readPending(app.ctx, request)?.userId,
    });
  });
  app.addHook('onSend', async (request, reply) => {
    if (request.actor?.demo) {
      if (!sharedAsset(request.routeOptions.url ?? '', request.url))
        reply.header('cache-control', 'no-store');
      if (reply.statusCode === 429) reply.header('retry-after', String(SITE_RATES.windowMs / 1000));
    }
  });
  if (app.ctx.mailer) {
    const mailer = app.ctx.mailer;
    app.ctx.mailer = {
      send: (message) => {
        refuseDemo();
        return mailer.send(message);
      },
    };
  }
}

/** Runs after published response policies so no demo response can reopen external destinations. */
export function installDemoResponses(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply) => {
    if (!request.actor?.demo && !restrictedRequests.has(request)) return;
    reply.header(
      'content-security-policy',
      demoBrowserPolicy(String(reply.getHeader('content-security-policy') ?? '')),
    );
  });
}
