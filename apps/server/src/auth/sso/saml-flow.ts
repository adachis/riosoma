import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, SsoProviderId } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { dataStore } from '../../data/context.js';
import { seal, unseal } from '../../secrets.js';
import { sendFirstStep } from '../mfa/pending.js';
import { refuseDemoAuthentication } from '../database.js';
import { INVITATION_COOKIE } from '../invitation-cookie.js';
import { clearCookie, readCookie } from '../mfa/cookies.js';
import { lockedFor, refuse, safeNext, signInClaimed, signInPath, type Outcome } from './accounts.js';
import type { FlowFailure } from './oidc.js';
import {
  authorizeUrl,
  checkResponse,
  newRequestId,
  RESPONSE_LIMIT,
  SAML_FLOW_MS,
  serviceProvider,
} from './saml.js';
import { enabledProvider, providersTable, serverOrigin, type ProviderRow } from './store.js';

const FLOW_CONTEXT = 'riosoma:saml-flow';
/** The form an identity provider posts is its answer and a little more. */
const ACS_BODY_LIMIT = RESPONSE_LIMIT + 16 * 1024;

const Params = z.object({ providerId: SsoProviderId });

/** What the browser carries from start to answer, sealed so it can be neither read nor forged. */
const SamlFlow = z.object({
  invitationToken: z.string().min(20).max(200).optional(),
  providerId: SsoProviderId,
  /** The ID of the request sent, which the answer must name */
  requestId: z.string().regex(/^_[0-9a-f]{40}$/),
  next: z.string().max(2048),
  startedAt: z.number().int(),
  expires: z.number().int(),
});
type SamlFlow = z.infer<typeof SamlFlow>;

function flowCookieName(request: FastifyRequest): string {
  return request.protocol === 'https' ? '__Host-rio_saml' : 'rio_saml';
}

/**
 * The identity provider posts its answer from its own site, and a browser sends a cookie along
 * with a cross-site post only when the cookie says SameSite=None, which in turn needs Secure.  The
 * value is sealed and names one request, so carrying it across sites gives nothing away.
 */
const FLOW_COOKIE = { httpOnly: true, secure: true, sameSite: 'none' as const, path: '/' };

function readFlow(ctx: AppContext, request: FastifyRequest): SamlFlow | null {
  const sealed = request.cookies[flowCookieName(request)];
  if (!sealed) return null;
  try {
    const flow = SamlFlow.safeParse(JSON.parse(unseal(ctx.config.secretKey, sealed, FLOW_CONTEXT)));
    return flow.success && flow.data.expires > Date.now() ? flow.data : null;
  } catch {
    return null;
  }
}

/**
 * Sign-in with a SAML identity provider: `start` sends the browser there with an authentication
 * request, and the Assertion Consumer Service checks the signed answer the identity provider
 * posts back, then signs the person in with an ordinary session.  Every failure lands on the
 * sign-in page with a message key, exactly as it does for OpenID Connect.
 */
export async function samlRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const publicRoute = { config: { policy: { kind: 'public' as const } } };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  // Identity providers post a form.  Only these routes read one, and it arrives as
  // URLSearchParams, where a crafted field name can't reach an object's prototype.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: ACS_BODY_LIMIT },
    (_request, body, done) => {
      done(null, new URLSearchParams(String(body)));
    },
  );

  /** An enabled SAML provider, whichever organization it belongs to. */
  async function samlProvider(providerId: string): Promise<ProviderRow | null> {
    const { pool, schemas } = dataStore(ctx);
    const provider = await enabledProvider(pool, schemas, providerId);
    return provider?.kind === 'saml' && provider.sso_url ? provider : null;
  }

  /** Records an assertion as used until it expires, and says whether this was its first use. */
  async function firstUse(provider: ProviderRow, assertionId: string, expiresAt: Date): Promise<boolean> {
    const { pool, schemas } = dataStore(ctx);
    const assertions = ident(schemas.app, 'saml_assertions');
    await query(pool, sql`DELETE FROM ${assertions} WHERE expires_at < clock_timestamp()`);
    const recorded = await query(
      pool,
      sql`INSERT INTO ${assertions} (provider_id, assertion_id, expires_at)
      VALUES (${provider.id}, ${assertionId}, ${expiresAt}) ON CONFLICT DO NOTHING`,
    );
    return recorded.rowCount === 1;
  }

  app.get('/api/auth/saml/:providerId/start', publicRoute, async (request, reply) => {
    const next = safeNext((request.query as Record<string, unknown>).next);
    const fail = (failure: FlowFailure) => reply.redirect(signInPath(failure, next));
    const params = Params.safeParse(request.params);
    if (!params.success) return fail('sso.unavailable');
    if (await lockedFor(ctx, request)) return fail('sso.locked');
    const provider = await samlProvider(params.data.providerId);
    if (!provider) return fail('sso.unavailable');
    const startedAt = Date.now();
    const flow: SamlFlow = {
      invitationToken: readCookie(ctx, request, INVITATION_COOKIE)?.token,
      providerId: provider.id,
      requestId: newRequestId(),
      next,
      startedAt,
      expires: startedAt + SAML_FLOW_MS,
    };
    clearCookie(ctx, request, reply, INVITATION_COOKIE);
    let destination: string;
    try {
      destination = await authorizeUrl(
        provider,
        serviceProvider(serverOrigin(ctx, request), provider.id),
        flow.requestId,
      );
    } catch {
      request.log.warn({ providerId: provider.id }, 'SAML request failed');
      return fail('sso.unavailable');
    }
    reply.setCookie(flowCookieName(request), seal(ctx.config.secretKey, JSON.stringify(flow), FLOW_CONTEXT), {
      ...FLOW_COOKIE,
      maxAge: SAML_FLOW_MS / 1000,
    });
    return reply.redirect(destination);
  });

  app.post(
    '/api/auth/saml/:providerId/acs',
    { ...publicRoute, bodyLimit: ACS_BODY_LIMIT },
    async (request, reply) => {
      const flow = readFlow(ctx, request);
      // One flow, one answer: whatever happens next, the browser forgets it.
      reply.clearCookie(flowCookieName(request), FLOW_COOKIE);
      const next = flow ? safeNext(flow.next) : '/';
      const outcome = await complete(request, flow);
      if ('failure' in outcome) {
        const params = Params.safeParse(request.params);
        await refuse(ctx, request, outcome.failure, flow?.providerId ?? params.data?.providerId);
        // A 303, so the browser follows with a GET instead of posting the answer again.
        return reply.redirect(signInPath(outcome.failure, next), 303);
      }
      sendFirstStep(ctx, request, reply, outcome);
      if ('pending' in outcome) return reply.redirect(`/sign-in?${new URLSearchParams({ next })}`, 303);
      return reply.redirect(next, 303);
    },
  );

  async function complete(request: FastifyRequest, flow: SamlFlow | null): Promise<Outcome> {
    if (await lockedFor(ctx, request)) return { failure: 'sso.locked' };
    const params = Params.safeParse(request.params);
    // An answer counts only at the address of the provider this browser started with.
    if (!flow || !params.success || params.data.providerId !== flow.providerId)
      return { failure: 'sso.state' };
    const provider = await samlProvider(flow.providerId);
    if (!provider) return { failure: 'sso.unavailable' };
    const answers = request.body instanceof URLSearchParams ? request.body.getAll('SAMLResponse') : [];
    if (answers.length !== 1) return { failure: 'sso.token' };
    const checked = await checkResponse(
      provider,
      serviceProvider(serverOrigin(ctx, request), provider.id),
      flow,
      answers[0]!,
    );
    if (!checked.ok) {
      // The reason is a word, never anything from the assertion.
      request.log.warn(
        { providerId: provider.id, failure: checked.failure, reason: checked.reason },
        'SAML sign-in refused',
      );
      return { failure: checked.failure };
    }
    await refuseDemoAuthentication(ctx, { ...checked.claimed, token: flow.invitationToken });
    if (!(await firstUse(provider, checked.assertionId, checked.expiresAt))) {
      request.log.warn(
        { providerId: provider.id, failure: 'sso.token', reason: 'replayed' },
        'SAML sign-in refused',
      );
      return { failure: 'sso.token' };
    }
    return signInClaimed(ctx, request, provider, {
      ...checked.claimed,
      invitationToken: flow.invitationToken,
    });
  }

  // Riosoma's metadata, for identity providers that read it from an address.  It holds only the
  // entity ID and the Assertion Consumer Service URL, so it's served before the provider is on.
  app.get('/api/auth/saml/:providerId/metadata', publicRoute, async (request, reply) => {
    const params = Params.safeParse(request.params);
    if (!params.success) throw new AppError('not_found', 'errors.notFound');
    const { pool, schemas } = dataStore(ctx);
    const found = await query<{ id: string }>(
      pool,
      sql`SELECT id FROM ${providersTable(schemas)} WHERE id = ${params.data.providerId} AND kind = 'saml'`,
    );
    const provider = found.rows[0];
    if (!provider) throw new AppError('not_found', 'errors.notFound');
    return reply
      .type('application/samlmetadata+xml; charset=utf-8')
      .send(serviceProvider(serverOrigin(ctx, request), provider.id).metadata);
  });
}
