import { AppError, newId, type AccountSession, type PasswordResetAvailability } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { AppContext } from '../app.js';
import { dataStore, type DataSchemas } from '../data/context.js';
import { AccessScope } from '../data/access.js';
import { organizationChannel } from '../data/notify.js';
import type { Actor } from '../http/policy.js';
import { lockKeys, tokenHash } from './database.js';
import { attemptKey } from './attempts.js';

export const sessionsChannel = (schemas: DataSchemas) => `${schemas.app}_sessions`.slice(0, 63);

export async function resetAvailability(ctx: AppContext): Promise<PasswordResetAvailability> {
  if (!ctx.pool || !ctx.config.database) return { enabled: false, email: false };
  const result = await query<{ enabled: boolean }>(
    ctx.pool,
    sql`SELECT
    COALESCE((settings ->> 'passwordResetEnabled')::boolean, true) AS enabled
    FROM ${ident(ctx.config.database.schemas.app, 'orgs')} ORDER BY created_at, id LIMIT 1`,
  );
  return { enabled: result.rows[0]?.enabled ?? true, email: Boolean(ctx.mailer && ctx.config.baseUrl) };
}

export async function accountByEmail(db: Queryable, schemas: DataSchemas, email: string) {
  const result = await query<{ id: string }>(
    db,
    sql`SELECT id FROM ${ident(schemas.app, 'users')}
    WHERE lower(email) = ${email} AND deactivated_at IS NULL`,
  );
  return result.rows[0]?.id ?? null;
}

export async function lockAccount(db: Queryable, schemas: DataSchemas, userId: string) {
  const result = await query<{ passwordHash: string | null; credentialVersion: number }>(
    db,
    sql`SELECT password_hash AS "passwordHash", credential_version AS "credentialVersion"
      FROM ${ident(schemas.app, 'users')} WHERE id = ${userId} AND deactivated_at IS NULL FOR UPDATE`,
  );
  return result.rows[0] ?? null;
}

export async function nextResetRequest(db: Queryable, schemas: DataSchemas): Promise<string> {
  const sequence = '"' + schemas.app.replaceAll('"', '""') + '".password_reset_requests';
  const result = await query<{ number: string }>(
    db,
    sql`SELECT nextval(${sequence}::regclass)::text AS number`,
  );
  return result.rows[0]!.number;
}

export async function recordResetRequest(
  db: Queryable,
  schemas: DataSchemas,
  email: string,
  requestNumber: string,
) {
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.app, 'password_reset_latest_requests')} AS latest
    (address_hash, request_number) VALUES (${tokenHash(email.toLowerCase())}, ${requestNumber}::bigint)
    ON CONFLICT (address_hash) DO UPDATE
    SET request_number = GREATEST(latest.request_number, EXCLUDED.request_number)`,
  );
}

export async function issueReset(
  db: Queryable,
  schemas: DataSchemas,
  userId: string,
  email: string,
  token: string,
  requestedAt: Date,
  requestNumber: string,
  source: 'request' | 'admin' | 'server',
) {
  await lockKeys(db, [attemptKey('reset', email.toLowerCase())]);
  // A slower delivery task cannot replace a link from a later request, even in the same millisecond.
  const newer = await query(
    db,
    sql`SELECT 1 WHERE EXISTS (
      SELECT 1 FROM ${ident(schemas.app, 'login_tokens')}
      WHERE user_id = ${userId} AND purpose = 'recover' AND reset_request > ${requestNumber}::bigint
    ) OR EXISTS (
      SELECT 1 FROM ${ident(schemas.app, 'password_reset_latest_requests')}
      WHERE address_hash = ${tokenHash(email.toLowerCase())} AND request_number > ${requestNumber}::bigint
    )`,
  );
  if (newer.rowCount) return false;
  await recordResetRequest(db, schemas, email, requestNumber);
  await query(
    db,
    sql`UPDATE ${ident(schemas.app, 'login_tokens')} SET used_at = clock_timestamp()
    WHERE user_id = ${userId} AND purpose = 'recover' AND used_at IS NULL`,
  );
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.app, 'login_tokens')}
    (id, user_id, email, purpose, token_hash, expires_at, created_at, reset_request, reset_source)
    VALUES (${newId('token')}, ${userId}, ${email}, 'recover', ${tokenHash(token)},
      clock_timestamp() + interval '30 minutes', ${requestedAt}, ${requestNumber}::bigint, ${source})`,
  );
  return true;
}

export async function resetOwner(db: Queryable, schemas: DataSchemas, token: string) {
  const result = await query<{
    userId: string;
    email: string;
    source: 'request' | 'admin' | 'server' | null;
  }>(
    db,
    sql`SELECT user_id AS "userId", email, reset_source AS source FROM ${ident(schemas.app, 'login_tokens')}
    WHERE token_hash = ${tokenHash(token)} AND purpose = 'recover' AND used_at IS NULL AND expires_at > clock_timestamp()`,
  );
  return result.rows[0] ?? null;
}

export async function consumeReset(db: Queryable, schemas: DataSchemas, token: string) {
  const grant = await resetOwner(db, schemas, token);
  if (!grant) throw new AppError('unauthenticated', 'auth.reset.invalid');
  // Acceptance and redemption share the address lock, even while delivery has not found an account.
  await lockKeys(db, [attemptKey('reset', grant.email.toLowerCase())]);
  const result = await query(
    db,
    sql`UPDATE ${ident(schemas.app, 'login_tokens')} AS token
    SET used_at = clock_timestamp() WHERE token_hash = ${tokenHash(token)}
    AND purpose = 'recover' AND used_at IS NULL AND expires_at > clock_timestamp()
    AND NOT EXISTS (
      SELECT 1 FROM ${ident(schemas.app, 'password_reset_latest_requests')}
      WHERE address_hash = ${tokenHash(grant.email.toLowerCase())}
        AND request_number > COALESCE(token.reset_request, 0)
    ) RETURNING id`,
  );
  if (!result.rowCount) throw new AppError('unauthenticated', 'auth.reset.invalid');
}

export async function savePassword(db: Queryable, schemas: DataSchemas, userId: string, hash: string) {
  await query(
    db,
    sql`UPDATE ${ident(schemas.app, 'users')}
    SET password_hash = ${hash}, credential_version = credential_version + 1 WHERE id = ${userId}`,
  );
  // Emailed first steps issued before the change must not reopen the account.
  await query(
    db,
    sql`UPDATE ${ident(schemas.app, 'login_tokens')} SET used_at = clock_timestamp()
    WHERE user_id = ${userId} AND used_at IS NULL`,
  );
}

export async function endSessions(
  db: Queryable,
  schemas: DataSchemas,
  userId: string,
  options: { sessionId?: string; except?: string } = {},
) {
  const result = await query<{ id: string }>(
    db,
    sql`UPDATE ${ident(schemas.app, 'sessions')}
    SET revoked_at = clock_timestamp() WHERE user_id = ${userId} AND revoked_at IS NULL
    ${options.sessionId ? sql`AND id = ${options.sessionId}` : sql``}
    ${options.except ? sql`AND id <> ${options.except}` : sql``} RETURNING id`,
  );
  await query(
    db,
    sql`SELECT pg_notify(${sessionsChannel(schemas)}, id)
    FROM unnest(${result.rows.map((row) => row.id)}::text[]) AS ended(id)`,
  );
  return result.rowCount ?? 0;
}

export async function activeSession(db: Queryable, schemas: DataSchemas, sessionId: string) {
  const result = await query(
    db,
    sql`SELECT s.id FROM ${ident(schemas.app, 'sessions')} s
    JOIN ${ident(schemas.app, 'users')} u ON u.id = s.user_id WHERE s.id = ${sessionId}
    AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() AND u.deactivated_at IS NULL`,
  );
  return Boolean(result.rowCount);
}

export async function accountSessions(ctx: AppContext, actor: Actor): Promise<AccountSession[]> {
  const { pool, schemas } = dataStore(ctx);
  await new AccessScope(pool, schemas, actor).requireAccount(actor.userId);
  const result = await query<{
    id: string;
    userAgent: string | null;
    lastSeenAt: Date;
    method: AccountSession['method'];
  }>(
    pool,
    sql`SELECT id, user_agent AS "userAgent", last_seen_at AS "lastSeenAt", sign_in_method AS method
      FROM ${ident(schemas.app, 'sessions')} WHERE user_id = ${actor.userId} AND revoked_at IS NULL
      AND expires_at > clock_timestamp()
      AND created_at > clock_timestamp() - ${ctx.config.sessionMaxDays} * interval '24 hours'
      AND last_seen_at > clock_timestamp() - ${ctx.config.sessionIdleDays} * interval '24 hours'
      ORDER BY last_seen_at DESC, id`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    current: row.id === actor.sessionId,
    ...deviceWords(row.userAgent ?? ''),
    lastSeenAt: row.lastSeenAt.toISOString(),
    method: row.method,
  }));
}

export function deviceWords(agent: string): Pick<AccountSession, 'browser' | 'system'> {
  return {
    browser: /Edg\//.test(agent)
      ? 'edge'
      : /Firefox\//.test(agent)
        ? 'firefox'
        : /(?:Chrome|CriOS)\//.test(agent)
          ? 'chrome'
          : /Safari\//.test(agent)
            ? 'safari'
            : 'unknown',
    system: /Android/.test(agent)
      ? 'android'
      : /iPhone|iPad|iPod/.test(agent)
        ? 'ios'
        : /Windows/.test(agent)
          ? 'windows'
          : /Macintosh|Mac OS/.test(agent)
            ? 'macos'
            : /Linux/.test(agent)
              ? 'linux'
              : 'unknown',
  };
}

export async function setResetPolicy(db: Queryable, schemas: DataSchemas, orgId: string, enabled: boolean) {
  await query(
    db,
    sql`UPDATE ${ident(schemas.app, 'orgs')}
    SET settings = jsonb_set(settings, '{passwordResetEnabled}', ${JSON.stringify(enabled)}::jsonb)
    WHERE id = ${orgId}`,
  );
  if (!enabled)
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'login_tokens')} t SET used_at = clock_timestamp()
    WHERE purpose = 'recover' AND used_at IS NULL AND reset_source IS DISTINCT FROM 'server'
      AND EXISTS (SELECT 1 FROM ${ident(schemas.app, 'memberships')} m
        WHERE m.user_id = t.user_id AND m.org_id = ${orgId})`,
    );
  await query(db, sql`SELECT pg_notify(${organizationChannel(schemas)}, ${orgId})`);
}

export async function soleOwner(db: Queryable, schemas: DataSchemas, email: string) {
  const result = await query<{ userId: string; orgId: string }>(
    db,
    sql`SELECT u.id AS "userId", m.org_id AS "orgId"
    FROM ${ident(schemas.app, 'users')} u JOIN ${ident(schemas.app, 'memberships')} m ON m.user_id = u.id
    WHERE lower(u.email) = ${email} AND u.deactivated_at IS NULL AND m.kind = 'owner'
    AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'memberships')} other
      JOIN ${ident(schemas.app, 'users')} person ON person.id = other.user_id
      WHERE other.org_id = m.org_id AND other.kind = 'owner' AND other.user_id <> u.id
        AND person.deactivated_at IS NULL)`,
  );
  if (result.rows.length !== 1) throw new AppError('forbidden', 'auth.reset.soleOwner');
  return result.rows[0]!;
}

export async function activeSessionIds(db: Queryable, schemas: DataSchemas, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const result = await query<{ id: string }>(
    db,
    sql`SELECT s.id FROM ${ident(schemas.app, 'sessions')} s
    JOIN ${ident(schemas.app, 'users')} u ON u.id = s.user_id WHERE s.id = ANY(${ids}::text[])
    AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() AND u.deactivated_at IS NULL`,
  );
  return new Set(result.rows.map((row) => row.id));
}
