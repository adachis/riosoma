import { AppError, newId } from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../app.js';
import { authDatabase, randomToken, tokenHash } from '../auth/database.js';
import { findIdentity } from '../auth/sessions.js';
import { clientAddress } from '../authorization/store.js';
import { ConfigurationError } from '../configuration-error.js';
import { addressKey } from '../data/shared-view-reads.js';
import type { Actor } from '../http/policy.js';
import { protectDemoPool } from './boundary.js';
import { closePersonLogins } from '../sql/login.js';

export const DEMO_LIFETIME_MS = 2 * 60 * 60_000;
const cookieName = (request: FastifyRequest) =>
  request.protocol === 'https' ? '__Host-rio_demo' : 'rio_demo';

/** Startup calls this after migrations and before accepting visitors. */
export async function prepareDemo(ctx: AppContext): Promise<void> {
  if (!ctx.config.demoMode) return;
  const identity = await demoIdentity(ctx);
  await closePersonLogins(ctx.pool!, ctx.config.database!.schemas, identity.userId);
  protectDemoPool(ctx.pool!);
}

/** Rechecked for each visitor request so an account's later promotion never grants demo access. */
export async function demoIdentity(ctx: AppContext) {
  if (!ctx.pool || !ctx.config.database || !ctx.config.demoAccount)
    throw new ConfigurationError('RIOSOMA_DEMO_ACCOUNT', 'demoAccount');
  const { pool, app } = authDatabase(ctx);
  const result = await pool.query<{ id: string }>(
    `SELECT u.id FROM ${app}.users u
     WHERE lower(u.email) = lower($1) AND u.deactivated_at IS NULL
       AND EXISTS (SELECT 1 FROM ${app}.memberships m WHERE m.user_id = u.id AND m.kind = 'member')
       AND NOT EXISTS (SELECT 1 FROM ${app}.memberships m WHERE m.user_id = u.id
         AND (m.kind <> 'member' OR cardinality(m.admin_roles) > 0))
       AND NOT EXISTS (SELECT 1 FROM ${app}.org_unit_admins a WHERE a.user_id = u.id)`,
    [ctx.config.demoAccount],
  );
  const identity = result.rows[0] && (await findIdentity(pool, app, result.rows[0].id));
  if (!identity) throw new ConfigurationError('RIOSOMA_DEMO_ACCOUNT', 'demoAccount');
  return identity;
}

export function clearDemoCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie('rio_demo', { path: '/', secure: request.protocol === 'https', httpOnly: true });
  // Visitors may have both names after moving from HTTP to HTTPS through a trusted proxy.
  reply.clearCookie('__Host-rio_demo', { path: '/', secure: true, httpOnly: true });
}

export async function resolveDemo(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Actor> {
  const identity = await demoIdentity(ctx);
  const { pool, app } = authDatabase(ctx);
  const address = addressKey(ctx.config.secretKey, clientAddress(request.ip));
  const token = request.cookies[cookieName(request)];
  const session =
    token && /^[A-Za-z0-9_-]{43}$/.test(token)
      ? (
          await pool.query<{ id: string; csrf: string; expires: Date }>(
            `SELECT id, csrf_token AS csrf, expires_at AS expires FROM ${app}.sessions
         WHERE token_hash = $1 AND user_id = $2 AND demo AND demo_address = $3
           AND revoked_at IS NULL AND expires_at > clock_timestamp()`,
            [tokenHash(token), identity.userId, address],
          )
        ).rows[0]
      : undefined;
  let active = session;
  // Every protected read allocates capacity, so omitting a cookie cannot bypass the caps.
  if (!active && request.routeOptions.config.policy?.kind === 'session') {
    if (token) throw new AppError('rate_limited', 'demo.tryLater');
    const nextToken = randomToken();
    active = await withTransaction(pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${app}:demo-capacity`]);
      const counts = await db.query<{ total: number; address: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE demo_address = $1)::int AS address
         FROM ${app}.sessions WHERE demo AND revoked_at IS NULL AND expires_at > clock_timestamp()`,
        [address],
      );
      const used = counts.rows[0]!;
      if (used.total >= ctx.config.demoSessionLimit || used.address >= ctx.config.demoAddressLimit)
        throw new AppError('rate_limited', 'demo.tryLater');
      const created = await db.query<{ id: string; csrf: string; expires: Date }>(
        `INSERT INTO ${app}.sessions (id, user_id, token_hash, csrf_token, expires_at, demo, demo_address)
         VALUES ($1, $2, $3, $4, clock_timestamp() + interval '2 hours', true, $5)
         RETURNING id, csrf_token AS csrf, expires_at AS expires`,
        [newId('session'), identity.userId, tokenHash(nextToken), randomToken(), address],
      );
      return created.rows[0]!;
    });
    reply.setCookie(cookieName(request), nextToken, {
      path: '/',
      httpOnly: true,
      secure: request.protocol === 'https',
      sameSite: 'lax',
      expires: active.expires,
    });
  }
  if (token && !active) throw new AppError('rate_limited', 'demo.tryLater');
  return {
    userId: identity.userId,
    orgId: identity.orgId,
    kind: 'member',
    adminRoles: [],
    unitAdminGrants: [],
    hasUnits: identity.hasUnits,
    sessionId: active?.id ?? '',
    csrfToken: active?.csrf ?? '',
    demo: true,
    demoExpiresAt: active?.expires.toISOString(),
  };
}
