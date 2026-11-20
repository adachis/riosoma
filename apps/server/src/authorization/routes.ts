import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, TOKEN_SCOPES, oauthRedirectAllowed } from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import { z } from 'zod';
import { recordAttempts, retryAfter } from '../auth/attempts.js';
import { authDatabase, lockKeys, randomToken, tokenHash } from '../auth/database.js';
import { oauthAdminRoutes } from './admin.js';
import { oauthConsentRoutes } from './consent.js';
import { exchange, parameters, revoke, scopesOf, validateAuthorization } from './protocol.js';
import {
  clientAddress,
  expireDynamicClients,
  issuer,
  MCP_SCOPES,
  newOAuthId,
  OAuthError,
  RESOURCE_PATHS,
  throttle,
} from './store.js';

/** Authorization requests one network address may have waiting for one app.  More replace its oldest. */
const PENDING_PER_ADDRESS = 20;
/** Dynamic registrations one network address may make in a day. */
const REGISTRATIONS_PER_DAY = 5;

function formBody(value: unknown): Record<string, string> {
  const parsed = z.record(z.string(), z.string().max(2_048)).safeParse(value);
  if (!parsed.success) throw new OAuthError('invalid_request');
  return parsed.data;
}

const publicRoute = { config: { policy: { kind: 'public' as const } }, bodyLimit: 16_384 };
const Registration = z.object({
  client_name: z.string().trim().min(1).max(120),
  client_uri: z
    .string()
    .max(2_048)
    .url()
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    })
    .optional(),
  // Dynamic clients are always public.
  redirect_uris: z
    .array(
      z
        .string()
        .max(2_048)
        .refine((value) => oauthRedirectAllowed(value, { publicClient: true })),
    )
    .min(1)
    .max(20),
  token_endpoint_auth_method: z.literal('none').default('none'),
  grant_types: z
    .array(z.enum(['authorization_code', 'refresh_token']))
    .refine((v) => v.includes('authorization_code'))
    .default(['authorization_code', 'refresh_token']),
  response_types: z.array(z.literal('code')).length(1).default(['code']),
  scope: z.string().max(200).optional(),
});

/** With one issuer, registration needs exactly one eligible organization, never an arbitrary tenant. */
async function registrationOrg(app: FastifyInstance): Promise<string | null> {
  const { pool, app: schema } = authDatabase(app.ctx);
  const result = await pool.query<{ org_id: string }>(
    `SELECT org_id FROM ${schema}.oauth_settings WHERE dynamic_registration LIMIT 2`,
  );
  return result.rows.length === 1 ? result.rows[0]!.org_id : null;
}

export async function authorizationRoutes(app: FastifyInstance) {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        done(null, parameters(String(body)));
      } catch (error) {
        done(error as Error);
      }
    },
  );
  app.addHook('onSend', async (request, reply) => {
    reply
      .header('cache-control', 'no-store')
      .header('pragma', 'no-cache')
      .header('referrer-policy', 'no-referrer');
    if (!request.url.startsWith('/api/')) reply.header('access-control-allow-origin', '*');
  });
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (request.url.startsWith('/api/')) {
      const known =
        error instanceof AppError
          ? error
          : new AppError(
              error instanceof OAuthError ? 'bad_request' : 'internal',
              error instanceof OAuthError ? 'errors.badRequest' : 'errors.internal',
            );
      if (!known.userFault) request.log.error({ err: error }, 'authorization failed');
      return reply.code(known.status).send(known.toBody(request.id));
    }
    if (error instanceof AppError && error.messageKey === 'demo.readOnly')
      return reply.code(error.status).send(error.toBody(request.id));
    if (error instanceof OAuthError) {
      if (error.status === 401) reply.header('www-authenticate', 'Basic realm="oauth"');
      if (error.status === 429) reply.header('retry-after', '60');
      return reply.code(error.status).send({ error: error.error });
    }
    if (error.statusCode && error.statusCode < 500)
      return reply.code(error.statusCode).send({ error: 'invalid_request' });
    request.log.error({ err: error }, 'authorization failed');
    return reply.code(500).send({ error: 'server_error' });
  });
  const metadata = Object.entries(RESOURCE_PATHS).map(([kind, path]) => ({
    path: `/.well-known/oauth-protected-resource/${path}`,
    resource: path,
    mcp: kind === 'mcp',
  }));
  for (const path of [
    '/oauth/token',
    '/oauth/revoke',
    '/oauth/register',
    '/.well-known/oauth-authorization-server',
    ...metadata.map((entry) => entry.path),
  ]) {
    app.options(path, publicRoute, async (_request, reply) =>
      reply
        .header('access-control-allow-methods', 'GET, POST, OPTIONS')
        .header('access-control-allow-headers', 'Content-Type, Authorization')
        .code(204)
        .send(),
    );
  }
  app.get('/.well-known/oauth-authorization-server', publicRoute, async () => {
    const origin = issuer(app.ctx);
    return {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      ...((await registrationOrg(app)) ? { registration_endpoint: `${origin}/oauth/register` } : {}),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      scopes_supported: TOKEN_SCOPES,
      authorization_response_iss_parameter_supported: true,
    };
  });
  // Each document names the resource its address was built from, as RFC 9728 section 3.3
  // requires.  The origin itself is no resource, so it has no document.
  for (const entry of metadata) {
    app.get(entry.path, publicRoute, async () => {
      const origin = issuer(app.ctx);
      return {
        resource: `${origin}/${entry.resource}`,
        authorization_servers: [origin],
        scopes_supported: entry.mcp ? MCP_SCOPES : TOKEN_SCOPES,
        bearer_methods_supported: ['header'],
      };
    });
  }
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    await throttle(app.ctx, request, 'authorize');
    const { pool, app: schema } = authDatabase(app.ctx);
    const { input, client } = await validateAuthorization(
      pool,
      app.ctx,
      parameters(request.url.split('?')[1] ?? ''),
    );
    const id = randomToken();
    const address = tokenHash(clientAddress(request.ip));
    await withTransaction(pool, async (db) => {
      // Each address has its own allowance for each app, so no one address can fill another's.
      await lockKeys(db, [`oauth:requests:${client.id}:${address}`]);
      await db.query(`DELETE FROM ${schema}.oauth_requests WHERE expires_at <= clock_timestamp()`);
      await db.query(
        `DELETE FROM ${schema}.oauth_requests WHERE id IN (
          SELECT id FROM ${schema}.oauth_requests WHERE client_id = $1 AND address = $2 AND used_at IS NULL
          ORDER BY created_at DESC, id OFFSET $3)`,
        [client.id, address, PENDING_PER_ADDRESS - 1],
      );
      await db.query(
        `INSERT INTO ${schema}.oauth_requests(id, client_id, address, parameters) VALUES ($1, $2, $3, $4)`,
        [tokenHash(id), client.id, address, JSON.stringify(input)],
      );
    });
    if (request.routeOptions.url === '/api/oauth/authorize') return { request: id };
    return reply.redirect(`/oauth/consent?request=${encodeURIComponent(id)}`, 303);
  };
  app.get('/oauth/authorize', publicRoute, authorize);
  // The installed app handles navigations offline, while API requests always reach the server.
  app.get('/api/oauth/authorize', publicRoute, authorize);
  app.post('/oauth/token', publicRoute, async (request) => {
    await throttle(app.ctx, request, 'token');
    if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded'))
      throw new OAuthError('invalid_request');
    return exchange(app.ctx, request, formBody(request.body));
  });
  app.post('/oauth/revoke', publicRoute, async (request, reply) => {
    await throttle(app.ctx, request, 'revoke');
    if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded'))
      throw new OAuthError('invalid_request');
    await revoke(app.ctx, request, formBody(request.body));
    return reply.code(200).send();
  });
  app.post('/oauth/register', publicRoute, async (request, reply) => {
    const orgId = await registrationOrg(app);
    if (!orgId) throw new OAuthError('access_denied', 403);
    issuer(app.ctx);
    await throttle(app.ctx, request, 'register');
    const parsed = Registration.safeParse(request.body);
    if (!parsed.success) throw new OAuthError('invalid_client_metadata');
    const input = parsed.data;
    const scopes = input.scope === undefined ? [...MCP_SCOPES].sort() : scopesOf(input.scope);
    if (scopes.some((scope) => !MCP_SCOPES.includes(scope))) throw new OAuthError('invalid_scope');
    const { pool, app: schema, audit } = authDatabase(app.ctx);
    const id = newOAuthId();
    const made = `oauth:registered:${tokenHash(clientAddress(request.ip))}`;
    await withTransaction(pool, async (db) => {
      await lockKeys(db, ['oauth:registration', made]);
      const eligible = await db.query<{ org_id: string }>(
        `SELECT org_id FROM ${schema}.oauth_settings WHERE dynamic_registration LIMIT 2`,
      );
      if (eligible.rows.length !== 1 || eligible.rows[0]!.org_id !== orgId)
        throw new OAuthError('access_denied', 403);
      const settings = await db.query(
        `SELECT org_id FROM ${schema}.oauth_settings WHERE org_id = $1 AND dynamic_registration FOR UPDATE`,
        [orgId],
      );
      if (!settings.rowCount) throw new OAuthError('access_denied', 403);
      if (await retryAfter(db, schema, made, REGISTRATIONS_PER_DAY, 86_400))
        throw new OAuthError('temporarily_unavailable', 429);
      // Registrations nobody used give their places back before the allowance is counted.
      await expireDynamicClients(db, app.ctx, orgId);
      const count = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${schema}.oauth_clients WHERE org_id = $1 AND NOT verified AND revoked_at IS NULL`,
        [orgId],
      );
      if (count.rows[0]!.count >= 500) throw new OAuthError('temporarily_unavailable', 429);
      await db.query(
        `INSERT INTO ${schema}.oauth_clients(id, org_id, name, icon, homepage, redirect_uris, scopes, verified, refresh_allowed)
        VALUES ($1, $2, $3, 'app', $4, $5, $6, false, $7)`,
        [
          id,
          orgId,
          input.client_name,
          input.client_uri ?? '',
          input.redirect_uris,
          scopes,
          input.grant_types.includes('refresh_token'),
        ],
      );
      await db.query(
        `DELETE FROM ${schema}.auth_attempts WHERE key = $1 AND at < clock_timestamp() - interval '1 day'`,
        [made],
      );
      await recordAttempts(db, schema, [made]);
      await db.query(
        `INSERT INTO ${audit}.events(org_id, action, target, metadata) VALUES ($1, 'oauth.app.registered', $2, $3)`,
        [
          orgId,
          id,
          JSON.stringify({
            clientId: id,
            verified: false,
            dynamic: true,
            name: input.client_name,
            homepage: input.client_uri ?? null,
            redirectUris: input.redirect_uris,
            scopes,
            confidential: false,
          }),
        ],
      );
    });
    return reply.code(201).send({
      ...input,
      scope: scopes.join(' '),
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1_000),
    });
  });
  await app.register(oauthAdminRoutes);
  await app.register(oauthConsentRoutes);
}
