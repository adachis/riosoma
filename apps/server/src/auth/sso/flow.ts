import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as client from 'openid-client';
import { SsoProviderId, type SsoButton } from '@riosoma/contracts';
import { query, sql } from '@riosoma/db';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { dataStore } from '../../data/context.js';
import { seal, unseal } from '../../secrets.js';
import { sendFirstStep } from '../mfa/pending.js';
import { INVITATION_COOKIE } from '../invitation-cookie.js';
import { clearCookie, readCookie } from '../mfa/cookies.js';
import { lockedFor, refuse, safeNext, signInClaimed, signInPath, type Outcome } from './accounts.js';
import {
  DiscoveryCache,
  discover,
  oidcFetch,
  failureDetail,
  grantFailure,
  type FlowFailure,
} from './oidc.js';
import {
  clientFingerprint,
  enabledProvider,
  providerSecret,
  providersTable,
  redirectUri,
  type ProviderRow,
} from './store.js';

export { safeNext } from './accounts.js';

/** How long someone has at the provider before the sign-in has to start over. */
const FLOW_SECONDS = 10 * 60;
const FLOW_CONTEXT = 'riosoma:sso-flow';
const SCOPE = 'openid email profile';

/** What the browser carries from start to callback, sealed so it can be neither read nor forged. */
const Flow = z.object({
  invitationToken: z.string().min(20).max(200).optional(),
  providerId: SsoProviderId,
  state: z.string().min(1).max(200),
  nonce: z.string().min(1).max(200),
  verifier: z.string().min(43).max(128),
  next: z.string().max(2048),
  expires: z.number().int(),
});
type Flow = z.infer<typeof Flow>;

function flowCookieName(request: FastifyRequest): string {
  return request.protocol === 'https' ? '__Host-rio_sso' : 'rio_sso';
}

function flowCookieOptions(ctx: AppContext, request: FastifyRequest) {
  return {
    httpOnly: true,
    secure: ctx.config.production || request.protocol === 'https',
    // Lax still rides along on the provider's top-level redirect back to the callback.
    sameSite: 'lax' as const,
    path: '/',
  };
}

function readFlow(ctx: AppContext, request: FastifyRequest): Flow | null {
  const sealed = request.cookies[flowCookieName(request)];
  if (!sealed) return null;
  try {
    const flow = Flow.safeParse(JSON.parse(unseal(ctx.config.secretKey, sealed, FLOW_CONTEXT)));
    return flow.success && flow.data.expires > Date.now() ? flow.data : null;
  } catch {
    return null;
  }
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * Whether the provider vouches for the email address.  Microsoft Entra ID never sends
 * `email_verified`, so for it the optional `xms_edov` claim counts: it says the tenant has verified
 * the domain the address is in.
 */
export function emailVerified(claims: client.IDToken, kind: ProviderRow['kind']): boolean {
  if (isTrue(claims.email_verified)) return true;
  return (
    kind === 'microsoft' && (isTrue(claims.xms_edov) || claims.xms_edov === '1' || claims.xms_edov === 1)
  );
}

/** Only an OpenID Connect provider signs in here, since a SAML one has its own routes. */
function isOidc(provider: ProviderRow | null): provider is ProviderRow {
  return provider !== null && provider.kind !== 'saml';
}

/**
 * Sign-in with an OpenID Connect provider: `start` sends the browser to the provider with PKCE, a
 * state, and a nonce, and `callback` checks what comes back and signs the person in with an
 * ordinary session.  Every failure lands on the sign-in page with a message key.
 */
export async function ssoRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const publicRoute = { config: { policy: { kind: 'public' as const } } };
  const transport = oidcFetch(ctx.config);
  const discovery = new DiscoveryCache(transport);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  // Resolve credentials on both start and callback so discovery caching cannot extend their lifetime
  async function configuration(provider: ProviderRow): Promise<client.Configuration> {
    const secret = await providerSecret(ctx.config.secretKey, provider);
    return discovery.get(clientFingerprint(provider), (fetchDiscovery) =>
      discover(provider.issuer, provider.client_id, secret, fetchDiscovery, transport),
    );
  }

  /** The provider's client, or null when its discovery document can't be had right now. */
  async function reachable(request: FastifyRequest, provider: ProviderRow) {
    try {
      return await configuration(provider);
    } catch (error) {
      request.log.warn(
        { ...failureDetail(error), providerId: provider.id },
        'single sign-on discovery failed',
      );
      return null;
    }
  }

  app.get('/api/auth/sso', publicRoute, async (): Promise<SsoButton[]> => {
    if (!ctx.pool || !ctx.config.database) return [];
    const { pool, schemas } = dataStore(ctx);
    const result = await query<SsoButton>(
      pool,
      sql`SELECT id, kind, name FROM ${providersTable(schemas)} WHERE enabled ORDER BY created_at, id`,
    );
    return result.rows;
  });

  app.get('/api/auth/sso/:providerId/start', publicRoute, async (request, reply) => {
    const next = safeNext((request.query as Record<string, unknown>).next);
    const fail = (failure: FlowFailure) => reply.redirect(signInPath(failure, next));
    const params = z.object({ providerId: SsoProviderId }).safeParse(request.params);
    if (!params.success) return fail('sso.unavailable');
    if (await lockedFor(ctx, request)) return fail('sso.locked');
    const { pool, schemas } = dataStore(ctx);
    const provider = await enabledProvider(pool, schemas, params.data.providerId);
    if (!isOidc(provider)) return fail('sso.unavailable');
    const config = await reachable(request, provider);
    if (!config) return fail('sso.unavailable');
    const verifier = client.randomPKCECodeVerifier();
    const flow: Flow = {
      invitationToken: readCookie(ctx, request, INVITATION_COOKIE)?.token,
      providerId: provider.id,
      state: client.randomState(),
      nonce: client.randomNonce(),
      verifier,
      next,
      expires: Date.now() + FLOW_SECONDS * 1000,
    };
    const destination = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri(ctx, request),
      scope: SCOPE,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state: flow.state,
      nonce: flow.nonce,
    });
    clearCookie(ctx, request, reply, INVITATION_COOKIE);
    reply.setCookie(flowCookieName(request), seal(ctx.config.secretKey, JSON.stringify(flow), FLOW_CONTEXT), {
      ...flowCookieOptions(ctx, request),
      maxAge: FLOW_SECONDS,
    });
    return reply.redirect(destination.href);
  });

  app.get('/api/auth/sso/callback', publicRoute, async (request, reply) => {
    const flow = readFlow(ctx, request);
    // One flow, one callback: whatever happens next, the browser forgets it.
    reply.clearCookie(flowCookieName(request), flowCookieOptions(ctx, request));
    const next = flow ? safeNext(flow.next) : '/';
    const outcome = await complete(request, flow);
    if ('failure' in outcome) {
      await refuse(ctx, request, outcome.failure, flow?.providerId);
      return reply.redirect(signInPath(outcome.failure, next));
    }
    sendFirstStep(ctx, request, reply, outcome);
    if ('pending' in outcome) return reply.redirect(`/sign-in?${new URLSearchParams({ next })}`);
    return reply.redirect(next);
  });

  async function complete(request: FastifyRequest, flow: Flow | null): Promise<Outcome> {
    if (await lockedFor(ctx, request)) return { failure: 'sso.locked' };
    const parameters = request.query as Record<string, unknown>;
    if (!flow || typeof parameters.state !== 'string' || !sameText(parameters.state, flow.state))
      return { failure: 'sso.state' };
    if (parameters.error !== undefined) return { failure: 'sso.denied' };
    const { pool, schemas } = dataStore(ctx);
    const provider = await enabledProvider(pool, schemas, flow.providerId);
    if (!isOidc(provider)) return { failure: 'sso.unavailable' };
    const config = await reachable(request, provider);
    if (!config) return { failure: 'sso.unavailable' };
    let claims: client.IDToken | undefined;
    try {
      // The token request must name the same callback address the authorization request did.
      const callback = new URL(redirectUri(ctx, request));
      callback.search = new URL(request.url, callback).search;
      const tokens = await client.authorizationCodeGrant(config, callback, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch (error) {
      const failure = grantFailure(error);
      request.log.warn(
        { ...failureDetail(error), providerId: provider.id, failure },
        'single sign-on refused',
      );
      return { failure };
    }
    if (!claims) return { failure: 'sso.token' };
    return signInClaimed(ctx, request, provider, {
      invitationToken: flow.invitationToken,
      issuer: claims.iss,
      subject: claims.sub,
      email: claims.email,
      emailVerified: emailVerified(claims, provider.kind),
      name: claims.name,
    });
  }
}
