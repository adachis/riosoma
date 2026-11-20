import { demoReadOnly, refuseDemoAccount } from '../demo/boundary.js';
import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { oauthRedirectMatches, TOKEN_SCOPES, type TokenScope } from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { auditEvent, authDatabase, tokenHash, type Queryable } from '../auth/database.js';
import {
  activePerson,
  clientById,
  effectiveScopes,
  issuer,
  issueTokens,
  matchesSecret,
  MCP_SCOPES,
  OAuthError,
  revokeGrant,
  type ClientRow,
  type ConsentRow,
  type GrantRow,
} from './store.js';

const Text = z.string().min(1).max(2_048);
export const AuthorizationParameters = z.object({
  response_type: z.literal('code'),
  client_id: z.string().min(1).max(100),
  redirect_uri: Text,
  scope: z.string().min(1).max(200),
  state: Text,
  resource: Text,
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal('S256'),
});
export type AuthorizationParameters = z.infer<typeof AuthorizationParameters>;

export function parameters(value: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, entry] of new URLSearchParams(value)) {
    if (Object.hasOwn(result, key)) throw new OAuthError('invalid_request');
    result[key] = entry;
  }
  return result;
}

export function scopesOf(value: string): TokenScope[] {
  const values = value.split(' ');
  if (!values.length || values.some((v) => !(TOKEN_SCOPES as readonly string[]).includes(v)))
    throw new OAuthError('invalid_scope');
  return [...new Set(values)].sort() as TokenScope[];
}

export async function validateAuthorization(db: Queryable, ctx: AppContext, value: unknown) {
  const parsed = AuthorizationParameters.safeParse(value);
  if (!parsed.success) throw new OAuthError('invalid_request');
  const input = parsed.data;
  const { app } = authDatabase(ctx);
  const client = await clientById(db, app, input.client_id, true);
  if (!oauthRedirectMatches(client.redirect_uris, input.redirect_uri, { publicClient: !client.secret_hash }))
    throw new OAuthError('invalid_request');
  const scopes = scopesOf(input.scope);
  if (scopes.some((scope) => !client.scopes.includes(scope))) throw new OAuthError('invalid_scope');
  const origin = issuer(ctx);
  if (![`${origin}/api/v1`, `${origin}/mcp`].includes(input.resource)) throw new OAuthError('invalid_target');
  if (input.resource === `${origin}/mcp` && scopes.some((scope) => !MCP_SCOPES.includes(scope)))
    throw new OAuthError('invalid_scope');
  if (!client.verified) {
    const settings = await db.query(
      `SELECT org_id FROM ${app}.oauth_settings WHERE org_id = $1 AND dynamic_registration FOR SHARE`,
      [client.org_id],
    );
    if (input.resource !== `${origin}/mcp` || !settings.rowCount) throw new OAuthError('unauthorized_client');
  }
  return { input, client, scopes };
}

/** Only one authentication method may appear in a request. */
export function clientCredentials(request: FastifyRequest, input: Record<string, string>) {
  const header = request.headers.authorization;
  let clientId = input.client_id;
  let secret = input.client_secret;
  let method = secret === undefined ? 'none' : 'client_secret_post';
  if (header !== undefined) {
    if (secret !== undefined || !/^Basic [A-Za-z0-9+/]+=*$/i.test(header))
      throw new OAuthError('invalid_client', 401);
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) throw new OAuthError('invalid_client', 401);
    try {
      const basicId = decodeURIComponent(decoded.slice(0, separator).replaceAll('+', ' '));
      secret = decodeURIComponent(decoded.slice(separator + 1).replaceAll('+', ' '));
      if (clientId !== undefined && clientId !== basicId) throw new OAuthError('invalid_client', 401);
      clientId = basicId;
    } catch {
      throw new OAuthError('invalid_client', 401);
    }
    method = 'client_secret_basic';
  }
  if (!clientId || clientId.length > 100 || (secret?.length ?? 0) > 1_024)
    throw new OAuthError('invalid_client', 401);
  return { clientId, secret, method };
}

function verifyClient(client: ClientRow, credentials: ReturnType<typeof clientCredentials>) {
  if (client.secret_hash) {
    if (!credentials.secret || !matchesSecret(credentials.secret, client.secret_hash))
      throw new OAuthError('invalid_client', 401);
  } else if (credentials.method !== 'none') throw new OAuthError('invalid_client', 401);
}

/** A token exchange authenticates its own credentials, before request limits record any attempt. */
export async function allowDemoExchange(
  ctx: AppContext,
  request: FastifyRequest,
  input: Record<string, string>,
) {
  const { pool, app } = authDatabase(ctx);
  const credentials = clientCredentials(request, input);
  verifyClient(await clientById(pool, app, credentials.clientId), credentials);
  const kind =
    input.grant_type === 'authorization_code'
      ? 'code'
      : input.grant_type === 'refresh_token'
        ? 'refresh'
        : null;
  const value = kind === 'code' ? input.code : input.refresh_token;
  if (!kind || !value || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw demoReadOnly();
  const found = await pool.query<Pick<CredentialRow, 'challenge' | 'redirect_uri'> & { email: string }>(
    `SELECT u.email, t.challenge, t.redirect_uri FROM ${app}.oauth_credentials t
     JOIN ${app}.oauth_grants g ON g.id = t.grant_id JOIN ${app}.users u ON u.id = g.user_id
     WHERE t.hash = $1 AND t.kind = $2 AND g.client_id = $3`,
    [tokenHash(value), kind, credentials.clientId],
  );
  if (!found.rows[0]) throw demoReadOnly();
  refuseDemoAccount(ctx.config, found.rows[0].email);
  if (kind === 'code') verifyCode(input, found.rows[0]);
}

interface CredentialRow {
  hash: string;
  grant_id: string;
  kind: string;
  redirect_uri: string | null;
  challenge: string | null;
  used_at: Date | null;
  expired: boolean;
}

function verifyCode(
  input: Record<string, string>,
  credential: Pick<CredentialRow, 'challenge' | 'redirect_uri'>,
): void {
  const verifier = input.code_verifier ?? '';
  if (
    !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
    createHash('sha256').update(verifier).digest('base64url') !== credential.challenge ||
    input.redirect_uri !== credential.redirect_uri
  )
    throw new OAuthError('invalid_grant');
}

export async function exchange(ctx: AppContext, request: FastifyRequest, input: Record<string, string>) {
  const { pool, app, audit } = authDatabase(ctx);
  const credentials = clientCredentials(request, input);
  verifyClient(await clientById(pool, app, credentials.clientId), credentials);
  const kind =
    input.grant_type === 'authorization_code'
      ? 'code'
      : input.grant_type === 'refresh_token'
        ? 'refresh'
        : null;
  if (!kind) throw new OAuthError('unsupported_grant_type');
  const value = kind === 'code' ? input.code : input.refresh_token;
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new OAuthError('invalid_grant');
  const result = await withTransaction(pool, async (db) => {
    const found = await db.query<GrantRow>(
      `SELECT g.* FROM ${app}.oauth_grants g JOIN ${app}.oauth_credentials t ON t.grant_id = g.id
       WHERE t.hash = $1 AND t.kind = $2 AND g.client_id = $3`,
      [tokenHash(value), kind, credentials.clientId],
    );
    const initial = found.rows[0];
    if (!initial) throw new OAuthError('invalid_grant');
    if (ctx.config.demoMode) {
      const person = await db.query<{ email: string }>(`SELECT email FROM ${app}.users WHERE id = $1`, [
        initial.user_id,
      ]);
      if (person.rows[0]) refuseDemoAccount(ctx.config, person.rows[0].email);
    }
    // The order matches suspension and revocation: person, membership, client, consent, and grant.
    await activePerson(db, app, initial.user_id, initial.org_id);
    const client = await clientById(db, app, credentials.clientId, true);
    verifyClient(client, credentials);
    if (kind === 'refresh' && !client.refresh_allowed) throw new OAuthError('unauthorized_client');
    const consent = await db.query<ConsentRow>(
      `SELECT * FROM ${app}.oauth_consents WHERE id = $1 FOR SHARE`,
      [initial.consent_id],
    );
    const locked = await db.query<GrantRow>(`SELECT * FROM ${app}.oauth_grants WHERE id = $1 FOR UPDATE`, [
      initial.id,
    ]);
    const grant = locked.rows[0]!;
    if (grant.revoked_at) throw new OAuthError('invalid_grant');
    const stored = await db.query<CredentialRow>(
      `SELECT *, expires_at <= clock_timestamp() AS expired FROM ${app}.oauth_credentials WHERE hash = $1`,
      [tokenHash(value)],
    );
    const credential = stored.rows[0]!;
    if (credential.used_at) {
      await auditEvent(
        db,
        audit,
        'oauth.credential.reused',
        { userId: grant.user_id, orgId: grant.org_id },
        { grantId: grant.id, clientId: grant.client_id, kind },
      );
      await revokeGrant(db, ctx, grant, `${kind}_reuse`);
      // Return the refusal so the revocation commits before the error reaches the caller.
      return new OAuthError('invalid_grant');
    }
    if (credential.expired) throw new OAuthError('invalid_grant');
    const shared = consent.rows[0];
    if (!shared || shared.revoked_at) throw new OAuthError('invalid_grant');
    // The authorization named exactly one resource, so leaving it out means that one (RFC 8707).
    if (input.resource !== undefined && input.resource !== grant.resource)
      throw new OAuthError('invalid_target');
    // A narrower approval since this grant was made narrows what it may still do.
    const allowed = effectiveScopes(grant.scopes, shared.scopes);
    if (!allowed.length) throw new OAuthError('invalid_grant');
    // A request may ask for less than was granted, never for more (RFC 6749, section 6).
    const requested = input.scope === undefined ? allowed : scopesOf(input.scope);
    if (requested.some((scope) => !allowed.includes(scope))) throw new OAuthError('invalid_scope');
    if (kind === 'code') verifyCode(input, credential);
    await db.query(`UPDATE ${app}.oauth_credentials SET used_at = clock_timestamp() WHERE hash = $1`, [
      credential.hash,
    ]);
    if (kind === 'refresh')
      await auditEvent(
        db,
        audit,
        'oauth.token.refreshed',
        { userId: grant.user_id, orgId: grant.org_id },
        { grantId: grant.id, clientId: grant.client_id, scopes: requested },
      );
    return issueTokens(db, ctx, grant, client.refresh_allowed, requested, requested.length < allowed.length);
  });
  if (result instanceof OAuthError) throw result;
  return result;
}

/**
 * Ends the one installation a live token belongs to.  An expired access token, or a refresh token
 * already exchanged, is no longer a token: it answers the same success and changes nothing, as
 * RFC 7009 section 2.2 allows, so an old token from a log can't end the current connection.
 */
export async function revoke(ctx: AppContext, request: FastifyRequest, input: Record<string, string>) {
  const { pool, app } = authDatabase(ctx);
  const credentials = clientCredentials(request, input);
  await withTransaction(pool, async (db) => {
    verifyClient(await clientById(db, app, credentials.clientId, true), credentials);
    if (!input.token || input.token.length > 1_024) throw new OAuthError('invalid_request');
    const result = await db.query<GrantRow>(
      `SELECT g.* FROM ${app}.oauth_grants g JOIN ${app}.oauth_credentials t ON t.grant_id = g.id
       WHERE t.hash = $1 AND t.kind IN ('access', 'refresh') AND g.client_id = $2
         AND t.expires_at > clock_timestamp() AND t.used_at IS NULL
       FOR UPDATE OF g`,
      [tokenHash(input.token), credentials.clientId],
    );
    if (result.rows[0]) await revokeGrant(db, ctx, result.rows[0], 'client_request');
  });
}
