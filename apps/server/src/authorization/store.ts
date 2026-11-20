import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import type { FastifyRequest } from 'fastify';
import { AppError, type OAuthApp, type TokenScope } from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import type { AppContext } from '../app.js';
import {
  auditEvent,
  authDatabase,
  lockKeys,
  randomToken,
  tokenHash,
  type Queryable,
} from '../auth/database.js';
import { recordAttempts, retryAfter } from '../auth/attempts.js';
import type { Actor } from '../http/policy.js';
import { checkTokenPolicy, POLICY_RELEVANT_SQL } from '../org-units/policy.js';
import { refuseDemoAccount } from '../demo/boundary.js';

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly status = 400,
  ) {
    super(error);
  }
}

export const newOAuthId = () => randomBytes(16).toString('hex');
export const MCP_SCOPES: readonly TokenScope[] = [
  'schema.bases:read',
  'schema.bases:write',
  'data.records:read',
  'data.records:write',
];

/**
 * The issuer, from the configured origin and never a caller's Host header, or null when OAuth is
 * unavailable: the base URL is missing, or is plain HTTP on anything but a loopback address.
 */
export function oauthOrigin(ctx: AppContext): string | null {
  const value = ctx.config.baseUrl;
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  return url.origin;
}

/** The issuer, for the OAuth endpoints themselves, which answer 503 while OAuth is unavailable. */
export function issuer(ctx: AppContext): string {
  const origin = oauthOrigin(ctx);
  if (!origin) throw new OAuthError('temporarily_unavailable', 503);
  return origin;
}

export const RESOURCE_PATHS = { api: 'api/v1', mcp: 'mcp' } as const;

/**
 * What a protected route's 401 says, pointing at its resource metadata, or null while OAuth is
 * unavailable, so the answer is exactly what it was before OAuth.  It never throws, since it runs
 * while an error is already being answered.
 */
export function bearerChallenge(ctx: AppContext, kind: keyof typeof RESOURCE_PATHS): string | null {
  const origin = oauthOrigin(ctx);
  if (!origin) return null;
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/${RESOURCE_PATHS[kind]}"`;
}

/**
 * The network address limits count against.  An IPv6 address counts as its /64, which one
 * subscriber usually holds whole, so moving around inside it can't reset a limit.
 */
export function clientAddress(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (isIPv4(ip) || !isIPv6(ip)) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    : left;
  const prefix = groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, ''));
  return `${prefix.join(':')}::/64`;
}

export interface ClientRow {
  id: string;
  org_id: string;
  name: string;
  icon: OAuthApp['icon'];
  homepage: string;
  redirect_uris: string[];
  scopes: TokenScope[];
  secret_hash: string | null;
  refresh_allowed: boolean;
  verified: boolean;
  import_paused: boolean;
  revoked_at: Date | null;
  created_at: Date;
  last_used_at: Date | null;
}

export function appView(row: ClientRow): OAuthApp {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    homepage: row.homepage,
    redirectUris: row.redirect_uris,
    scopes: row.scopes,
    confidential: row.secret_hash !== null,
    verified: row.verified,
    paused: row.import_paused,
    secretNeeded: row.secret_hash === '',
    revokedAt: row.revoked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * An unverified app that never received tokens lasts 7 days, and one left idle lasts 90, so
 * registrations nobody uses can't fill the organization's allowance for good.
 */
const IN_TIME = `(verified
  OR (last_used_at IS NULL AND created_at > clock_timestamp() - interval '168 hours')
  OR (last_used_at IS NOT NULL AND last_used_at > clock_timestamp() - interval '2160 hours'))`;

export async function clientById(
  db: Queryable,
  schema: string,
  id: string,
  lock = false,
): Promise<ClientRow> {
  const result = await db.query<ClientRow>(
    `SELECT * FROM ${schema}.oauth_clients WHERE id = $1 AND revoked_at IS NULL AND NOT import_paused AND ${IN_TIME}
    ${lock ? 'FOR UPDATE' : ''}`,
    [id],
  );
  if (!result.rows[0]) throw new OAuthError('invalid_client', 401);
  return result.rows[0];
}

export function matchesSecret(value: string, hash: string): boolean {
  return timingSafeEqual(Buffer.from(tokenHash(value), 'hex'), Buffer.from(hash, 'hex'));
}

/** A person's consent for an app, which every installation of it shares. */
export interface ConsentRow {
  id: string;
  client_id: string;
  org_id: string;
  user_id: string;
  scopes: TokenScope[];
  databases: string[] | null;
  created_at: Date;
  revoked_at: Date | null;
}

/** One installation: an authorization of its own, with its own refresh tokens. */
export interface GrantRow {
  id: string;
  consent_id: string;
  client_id: string;
  org_id: string;
  user_id: string;
  scopes: TokenScope[];
  resource: string;
  revoked_at: Date | null;
  created_at: Date;
}

/** What an installation may do: what it asked for, as far as the shared consent still allows. */
export function effectiveScopes(asked: readonly TokenScope[], consent: readonly TokenScope[]): TokenScope[] {
  return asked.filter((scope) => consent.includes(scope)).sort();
}

/**
 * Names who is acting for the database triggers that end grants in this transaction, so their
 * audit events credit that person, or no one, and never the person whose access ended.
 */
export async function oauthActing(
  db: Queryable,
  actorId: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db.query(`SELECT set_config('riosoma.acting', $1, true)`, [JSON.stringify({ actorId, metadata })]);
}

/** Who ended a grant, as the audit log records them. */
export interface Revoker {
  actorId: string | null;
  metadata?: Record<string, unknown>;
}

async function revokedEvent(db: Queryable, audit: string, grant: GrantRow, reason: string, by: Revoker) {
  await db.query(
    `INSERT INTO ${audit}.events (org_id, actor_id, action, target, metadata) VALUES ($1, $2, $3, $4, $5)`,
    [
      grant.org_id,
      by.actorId,
      'oauth.grant.revoked',
      grant.client_id,
      JSON.stringify({
        ...by.metadata,
        grantId: grant.id,
        consentId: grant.consent_id,
        clientId: grant.client_id,
        userId: grant.user_id,
        reason,
      }),
    ],
  );
}

/** Ends one installation.  The consent it shares, and every other installation, stay. */
export async function revokeGrant(
  db: Queryable,
  ctx: AppContext,
  grant: GrantRow,
  reason: string,
  by: Revoker = { actorId: null },
) {
  const { app, audit } = authDatabase(ctx);
  await oauthActing(db, by.actorId, by.metadata);
  const result = await db.query(
    `UPDATE ${app}.oauth_grants SET revoked_at = clock_timestamp() WHERE id = $1 AND revoked_at IS NULL`,
    [grant.id],
  );
  if (result.rowCount) await revokedEvent(db, audit, grant, reason, by);
}

/**
 * Ends consents and every installation that shares them: a person's connection to one app, every
 * connection to an app, or everything a person has in an organization.  Answers how many
 * installations ended.
 */
export async function revokeConsents(
  db: Queryable,
  schemas: { app: string; audit: string },
  where: { consentId?: string; clientId?: string; orgId?: string; userId?: string },
  reason: string,
  by: Revoker,
): Promise<number> {
  const { app, audit } = schemas;
  await oauthActing(db, by.actorId, by.metadata);
  const values = [where.consentId ?? null, where.clientId ?? null, where.orgId ?? null, where.userId ?? null];
  const matching = `($2::text IS NULL OR client_id = $2) AND ($3::text IS NULL OR org_id = $3)
    AND ($4::text IS NULL OR user_id = $4) AND revoked_at IS NULL`;
  await db.query(
    `UPDATE ${app}.oauth_consents SET revoked_at = clock_timestamp()
    WHERE ($1::text IS NULL OR id = $1) AND ${matching}`,
    values,
  );
  const grants = await db.query<GrantRow>(
    `UPDATE ${app}.oauth_grants SET revoked_at = clock_timestamp()
    WHERE ($1::text IS NULL OR consent_id = $1) AND ${matching} RETURNING *`,
    values,
  );
  for (const grant of grants.rows) await revokedEvent(db, audit, grant, reason, by);
  return grants.rowCount ?? 0;
}

/**
 * Ends everything a person reached Riosoma with through OAuth apps in one organization, for a
 * suspension or removal.  `audit` is quoted and `schema` isn't, as the provisioning code keeps them.
 */
export async function endPersonOAuth(
  db: Queryable,
  schema: string,
  acting: { orgId: string; audit: string; actorId: string | null; metadata: Record<string, unknown> },
  userId: string,
  reason: 'person_inactive' | 'person_removed',
): Promise<void> {
  await revokeConsents(
    db,
    { app: `"${schema.replaceAll('"', '""')}"`, audit: acting.audit },
    { orgId: acting.orgId, userId },
    reason,
    { actorId: acting.actorId, metadata: acting.metadata },
  );
}

/** Row locks serialize issuance with suspension and membership removal. */
export async function activePerson(db: Queryable, schema: string, userId: string, orgId: string) {
  const user = await db.query(
    `SELECT id FROM ${schema}.users WHERE id = $1 AND deactivated_at IS NULL FOR SHARE`,
    [userId],
  );
  if (!user.rowCount) throw new OAuthError('invalid_grant');
  const member = await db.query(
    `SELECT user_id FROM ${schema}.memberships WHERE user_id = $1 AND org_id = $2 AND kind <> 'guest' FOR SHARE`,
    [userId, orgId],
  );
  if (!member.rowCount) throw new OAuthError('invalid_grant');
}

/**
 * Issues an access token, and a refresh token when the app may refresh.  `scopes` is what the
 * access token may do, which a refresh may narrow.  A refresh token always keeps its grant's
 * scopes, as RFC 6749 section 6 requires.
 */
export async function issueTokens(
  db: Queryable,
  ctx: AppContext,
  grant: GrantRow,
  refreshAllowed: boolean,
  scopes: TokenScope[],
  narrowed: boolean,
) {
  const { app, audit } = authDatabase(ctx);
  const access = randomToken();
  const refresh = refreshAllowed ? randomToken() : null;
  await db.query(
    `INSERT INTO ${app}.oauth_credentials(hash, grant_id, kind, scopes, expires_at) VALUES
     ($1, $2, 'access', $3, clock_timestamp() + interval '1 hour')`,
    [tokenHash(access), grant.id, narrowed ? scopes : null],
  );
  if (refresh)
    await db.query(
      `INSERT INTO ${app}.oauth_credentials(hash, grant_id, kind, expires_at)
    VALUES ($1, $2, 'refresh', clock_timestamp() + interval '720 hours')`,
      [tokenHash(refresh), grant.id],
    );
  // Receiving tokens is what keeps an unverified registration from expiring.
  await db.query(`UPDATE ${app}.oauth_clients SET last_used_at = clock_timestamp() WHERE id = $1`, [
    grant.client_id,
  ]);
  await auditEvent(
    db,
    audit,
    'oauth.token.issued',
    { userId: grant.user_id, orgId: grant.org_id },
    { clientId: grant.client_id, grantId: grant.id, consentId: grant.consent_id, scopes },
  );
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: 3_600,
    ...(refresh ? { refresh_token: refresh } : {}),
    scope: scopes.join(' '),
    resource: grant.resource,
  };
}

/** Shared database counters keep registration and credential guessing bounded across replicas. */
export async function throttle(
  ctx: AppContext,
  request: FastifyRequest,
  kind: string,
  limit = 120,
  seconds = 60,
) {
  const { pool, app } = authDatabase(ctx);
  const key = `oauth:${kind}:${tokenHash(clientAddress(request.ip))}`;
  const wait = await withTransaction(pool, async (db) => {
    await lockKeys(db, [key]);
    const delay = await retryAfter(db, app, key, limit, seconds);
    if (!delay) {
      await db.query(
        `DELETE FROM ${app}.auth_attempts WHERE key = $1 AND at < clock_timestamp() - interval '1 day'`,
        [key],
      );
      await recordAttempts(db, app, [key]);
    }
    return delay;
  });
  if (wait) throw new OAuthError('temporarily_unavailable', 429);
}

/**
 * Revokes unverified apps past their time, with every connection to them, so they stop counting
 * toward the organization's allowance.  The caller holds the registration lock.
 */
export async function expireDynamicClients(db: Queryable, ctx: AppContext, orgId: string): Promise<void> {
  const { app, audit } = authDatabase(ctx);
  const expired = await db.query<{ id: string; name: string; used: boolean }>(
    `UPDATE ${app}.oauth_clients SET revoked_at = clock_timestamp()
    WHERE org_id = $1 AND NOT verified AND revoked_at IS NULL AND NOT ${IN_TIME}
    RETURNING id, name, last_used_at IS NOT NULL AS used`,
    [orgId],
  );
  for (const client of expired.rows) {
    await revokeConsents(db, { app, audit }, { clientId: client.id }, 'app_expired', { actorId: null });
    await db.query(
      `INSERT INTO ${audit}.events (org_id, action, target, metadata) VALUES ($1, 'oauth.app.expired', $2, $3)`,
      [
        orgId,
        client.id,
        JSON.stringify({ clientId: client.id, name: client.name, reason: client.used ? 'idle' : 'unused' }),
      ],
    );
  }
}

/**
 * Makes a webhook belong to the installation whose token made it or turned it on, so it turns off
 * when that grant ends.  Without a grant, it belongs to no installation.  The share lock waits for
 * a revocation in flight, which then wins.  `schema` is the unquoted app schema.
 */
export async function bindWebhook(
  db: Queryable,
  schema: string,
  webhookId: string,
  grantId: string | undefined,
): Promise<void> {
  const app = `"${schema.replaceAll('"', '""')}"`;
  if (!grantId) {
    await db.query(`DELETE FROM ${app}.oauth_webhooks WHERE webhook_id = $1`, [webhookId]);
    return;
  }
  const live = await db.query(
    `SELECT id FROM ${app}.oauth_grants WHERE id = $1 AND revoked_at IS NULL FOR SHARE`,
    [grantId],
  );
  if (!live.rowCount) throw new AppError('unauthenticated', 'errors.tokenInvalid');
  await db.query(
    `INSERT INTO ${app}.oauth_webhooks (webhook_id, grant_id) VALUES ($1, $2)
    ON CONFLICT (webhook_id) DO UPDATE SET grant_id = EXCLUDED.grant_id`,
    [webhookId, grantId],
  );
}

export async function authenticateOAuthToken(
  ctx: AppContext,
  request: FastifyRequest,
  scope: TokenScope | readonly TokenScope[],
): Promise<Actor> {
  const invalid = () => new AppError('unauthenticated', 'errors.tokenInvalid');
  const origin = oauthOrigin(ctx);
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization ?? '');
  if (!origin || !match || !ctx.pool || !ctx.config.database) throw invalid();
  const path = request.routeOptions.url;
  const resource =
    path === '/mcp' ? `${origin}/mcp` : path?.startsWith('/api/v1/') ? `${origin}/api/v1` : null;
  if (!resource) throw invalid();
  const { pool, app } = authDatabase(ctx);
  const result = await pool.query<{
    id: string;
    user_id: string;
    org_id: string;
    email: string;
    grant_scopes: TokenScope[];
    token_scopes: TokenScope[] | null;
    consent_scopes: TokenScope[];
    databases: string[] | null;
    kind: Actor['kind'];
    admin_roles: string[];
    policy_relevant: boolean;
  }>(
    `SELECT g.id, g.user_id, g.org_id, u.email, g.scopes AS grant_scopes, t.scopes AS token_scopes,
       s.scopes AS consent_scopes, s.databases, m.kind, m.admin_roles,
       ${POLICY_RELEVANT_SQL(app)} AS policy_relevant
     FROM ${app}.oauth_credentials t
     JOIN ${app}.oauth_grants g ON g.id = t.grant_id
     JOIN ${app}.oauth_consents s ON s.id = g.consent_id
     JOIN ${app}.oauth_clients c ON c.id = g.client_id
     JOIN ${app}.users u ON u.id = g.user_id
     JOIN ${app}.memberships m ON m.user_id = g.user_id AND m.org_id = g.org_id
     JOIN ${app}.orgs o ON o.id = g.org_id
     WHERE t.hash = $1 AND t.kind = 'access' AND t.expires_at > clock_timestamp()
       AND g.revoked_at IS NULL AND s.revoked_at IS NULL AND c.revoked_at IS NULL AND NOT c.import_paused
       AND u.deactivated_at IS NULL AND m.kind <> 'guest' AND g.resource = $2`,
    [tokenHash(match[1]!), resource],
  );
  const row = result.rows[0];
  if (!row) throw invalid();
  refuseDemoAccount(ctx.config, row.email);
  // The consent is read on every request, so narrowing it narrows every installation at once.
  const granted = effectiveScopes(row.token_scopes ?? row.grant_scopes, row.consent_scopes);
  const scopes = typeof scope === 'string' ? [scope] : scope;
  if (!scopes.some((s) => granted.includes(s))) throw new AppError('forbidden', 'errors.tokenScope');
  return checkTokenPolicy(
    pool,
    app,
    {
      userId: row.user_id,
      orgId: row.org_id,
      kind: row.kind,
      adminRoles: row.admin_roles,
      sessionId: '',
      csrfToken: '',
      token: { id: row.id, databases: row.databases, scopes: granted, grantId: row.id },
    } as Actor,
    row.policy_relevant,
    ctx.config,
  );
}
