import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type pg from 'pg';
import { AppError, type Preferences } from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import type { AppContext } from '../app.js';
import { demoReadOnly, refuseDemoAccount } from '../demo/boundary.js';

export type Queryable = Pick<pg.PoolClient, 'query'>;

/**
 * Sign-in work stays entirely in the database until commit: an aborted attempt rolls back its
 * sessions, consumed credentials, counters, and audit entries.  Callers send cookies and perform
 * outside work only after this returns.  Only database-aborted transactions can run again.
 */
export async function withSignInTransaction<T>(
  pool: pg.Pool,
  work: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTransaction(pool, work);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (attempt >= 2 || (code !== '40P01' && code !== '40001')) throw error;
      // Release the connection and all locks before a bounded, jittered backoff.
      const backoffMs = 10 * 2 ** attempt;
      await delay(backoffMs + Math.floor(Math.random() * backoffMs));
    }
  }
}

export function authDatabase(ctx: AppContext) {
  if (!ctx.pool || !ctx.config.database) throw new AppError('setup_required', 'setup.database.required');
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  return {
    pool: ctx.pool,
    app: quote(ctx.config.database.schemas.app),
    audit: quote(ctx.config.database.schemas.audit),
  };
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Resolve public authentication targets before consuming tokens, recording attempts, or sending mail. */
export async function refuseDemoAuthentication(
  ctx: AppContext,
  target: {
    email?: unknown;
    token?: unknown;
    credentialId?: unknown;
    userId?: string;
    issuer?: string;
    subject?: string;
  },
): Promise<void> {
  if (!ctx.config.demoMode) return;
  refuseDemoAccount(ctx.config, target.email);
  if (!ctx.pool || !ctx.config.database) return;
  const token = typeof target.token === 'string' ? tokenHash(target.token) : null;
  const credentialId = typeof target.credentialId === 'string' ? target.credentialId : null;
  if (!token && !credentialId && !target.userId && !target.issuer) return;
  const { pool, app } = authDatabase(ctx);
  const result = await pool.query(
    `SELECT 1 FROM ${app}.users u WHERE lower(u.email) = lower($1)
       AND (u.id = $2 OR EXISTS (SELECT 1 FROM ${app}.login_tokens t
         WHERE t.user_id = u.id AND t.token_hash = $3)
       OR EXISTS (SELECT 1 FROM ${app}.passkeys p
         WHERE p.user_id = u.id AND p.credential_id = $4)
       OR EXISTS (SELECT 1 FROM ${app}.invitations i
         WHERE i.token_hash = $3 AND (lower(i.email) = lower(u.email) OR i.reserved_user_id = u.id))
       OR EXISTS (SELECT 1 FROM ${app}.sso_identities s
         WHERE s.user_id = u.id AND s.issuer = $5 AND s.subject = $6))`,
    [
      ctx.config.demoAccount,
      target.userId ?? null,
      token,
      credentialId,
      target.issuer ?? null,
      target.subject ?? null,
    ],
  );
  if (result.rowCount) throw demoReadOnly();
}

/** System events retain their organization even when no person acts. */
export async function auditEvent(
  db: Queryable,
  schema: string,
  action: string,
  identity: { userId?: string | null; orgId: string; auditUnitId?: string | null; demo?: boolean } | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  if (identity?.demo) return;
  await db.query(
    `INSERT INTO ${schema}.events (org_id, actor_id, action, metadata) VALUES ($1, $2, $3, $4)`,
    [
      identity?.orgId ?? null,
      identity?.userId ?? null,
      action,
      JSON.stringify({ ...(identity?.auditUnitId ? { unitId: identity.auditUnitId } : {}), ...metadata }),
    ],
  );
}

export async function lockKeys(db: Queryable, keys: string[]): Promise<void> {
  // Consistent ordering prevents deadlocks when requests share an email or an IP address.
  for (const key of [...keys].sort()) {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  }
}

/** A layout choice and its audit event commit together, using the person's existing preferences. */
export async function savePreferences(
  ctx: AppContext,
  actor: NonNullable<Parameters<typeof auditEvent>[3]> & { userId: string },
  preferences: Partial<Preferences>,
  cleared: string[],
): Promise<Preferences> {
  const { pool, app: schema, audit } = authDatabase(ctx);
  return withTransaction(pool, async (db) => {
    const before = await db.query<{ preferences: Preferences }>(
      `SELECT preferences FROM ${schema}.users WHERE id = $1 AND deactivated_at IS NULL FOR UPDATE`,
      [actor.userId],
    );
    if (!before.rows[0]) throw new AppError('unauthenticated', 'errors.signInRequired');
    const result = await db.query<{ preferences: Preferences }>(
      `UPDATE ${schema}.users SET preferences = (preferences || $2::jsonb) - $3::text[],
         locale = COALESCE($2::jsonb ->> 'locale', locale)
       WHERE id = $1 AND deactivated_at IS NULL RETURNING preferences`,
      [actor.userId, JSON.stringify(preferences), cleared],
    );
    const from = before.rows[0].preferences.recordLayout ?? 'card';
    if (preferences.recordLayout && preferences.recordLayout !== from)
      await auditEvent(db, audit, 'auth.record_layout.updated', actor, {
        from,
        to: preferences.recordLayout,
      });
    return result.rows[0]!.preferences;
  });
}
