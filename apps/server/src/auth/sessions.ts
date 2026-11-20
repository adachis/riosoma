import { randomUUID } from 'node:crypto';
import { effectivePolicy, keepPolicyForRequest } from '../org-units/policy.js';
import { unitGrants } from '../org-units/store.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AppError,
  newId,
  type EffectiveUnitPolicy,
  type SessionInfo,
  type UnitAdminGrant,
} from '@riosoma/contracts';
import type { AppContext } from '../app.js';
import type { Actor, SessionResolver } from '../http/policy.js';
import { authDatabase, randomToken, tokenHash, type Queryable } from './database.js';
import { refuseDemoAccount } from '../demo/boundary.js';

export interface Identity {
  userId: string;
  orgId: string;
  email: string;
  name: string;
  locale: string;
  orgName: string;
  /** The organization's own settings, as it stores them */
  settings: SessionInfo['org']['settings'];
  /** The settings that apply to this person, once the organization has units or a unit policy */
  effectiveSettings?: SessionInfo['org']['settings'];
  credentialVersion?: number;
  preferences: SessionInfo['preferences'];
  kind: Actor['kind'];
  adminRoles: string[];
  unitId?: string | null;
  unitAdminGrants?: Actor['unitAdminGrants'];
  hasUnits?: boolean;
}

/**
 * Who someone is, with the settings that apply to them.  A caller that has already worked out the
 * person's policy for this request passes it along, so it isn't worked out twice.
 */
export async function findIdentity(
  db: Queryable,
  schema: string,
  userId: string,
  known: { policy?: EffectiveUnitPolicy; grants?: UnitAdminGrant[] } = {},
): Promise<Identity | null> {
  const result = await db.query<Identity>(
    `SELECT u.id AS "userId", u.email, u.name, u.locale, u.preferences, u.credential_version AS "credentialVersion",
            o.id AS "orgId", o.name AS "orgName", o.settings, m.kind, m.admin_roles AS "adminRoles",
            m.org_unit_id AS "unitId",
            EXISTS (SELECT 1 FROM ${schema}.org_units ou WHERE ou.org_id = o.id) AS "hasUnits"
     FROM ${schema}.users u
     JOIN ${schema}.memberships m ON m.user_id = u.id
     JOIN ${schema}.orgs o ON o.id = m.org_id
     WHERE u.id = $1 AND u.deactivated_at IS NULL
     ORDER BY m.created_at, m.org_id LIMIT 1`,
    [userId],
  );
  const identity = result.rows[0];
  if (!identity) return null;
  identity.settings ??= {};
  identity.unitAdminGrants = identity.hasUnits
    ? (known.grants ?? (await unitGrants(db, schema, identity.orgId, identity.userId)))
    : [];
  if (!identity.hasUnits && !identity.settings.unitPolicy) return identity;
  // The organization's own settings stay as they are, and the person's unit's defaults and limits
  // go alongside them, for everything that applies them to this person.
  const { values } = known.policy ?? (await effectivePolicy(db, schema, identity.orgId, identity));
  const {
    defaultTheme,
    allowedThemes: _allowed,
    defaultLocale: _locale,
    unitPolicy: _unit,
    ...settings
  } = identity.settings;
  identity.effectiveSettings = {
    ...settings,
    defaultLevel: values.defaultLevel,
    guestLevel: values.guestLevel,
    ...(values.defaultLocale ? { defaultLocale: values.defaultLocale } : {}),
    ...(values.allowedThemes ? { allowedThemes: values.allowedThemes } : {}),
    // A scheme and mode belong to the theme they were chosen for.
    ...(values.defaultTheme
      ? {
          defaultTheme:
            defaultTheme?.theme === values.defaultTheme ? defaultTheme : { theme: values.defaultTheme },
        }
      : {}),
  };
  // A theme the person chose that's no longer allowed where they are gives way to the default.
  if (
    values.allowedThemes &&
    identity.preferences.theme &&
    !values.allowedThemes.includes(identity.preferences.theme)
  ) {
    const { theme: _theme, scheme: _scheme, mode: _mode, ...preferences } = identity.preferences;
    identity.preferences = preferences;
  }
  return identity;
}

export function sessionInfo(identity: Identity, csrfToken: string): SessionInfo {
  // Administrative policy and scanner diagnostics are read through their authorized endpoints.
  const publicSettings = (value: Identity['settings']) => {
    const {
      unitPolicy: _unitPolicy,
      fileScanner: _fileScanner,
      fileScannerStatus: _fileScannerStatus,
      ...settings
    } = value as Identity['settings'] & { fileScanner?: unknown; fileScannerStatus?: unknown };
    return settings;
  };
  const settings = publicSettings(identity.settings);
  return {
    user: { id: identity.userId, email: identity.email, name: identity.name, locale: identity.locale },
    org: { id: identity.orgId, name: identity.orgName, settings },
    membership: {
      kind: identity.kind,
      adminRoles: identity.adminRoles,
      ...(identity.hasUnits
        ? { unitId: identity.unitId ?? null, unitAdminGrants: identity.unitAdminGrants ?? [] }
        : {}),
    },
    hasUnits: identity.hasUnits ?? false,
    ...(identity.effectiveSettings ? { effectiveSettings: publicSettings(identity.effectiveSettings) } : {}),
    preferences: identity.preferences,
    csrfToken,
  };
}

export interface CreatedSession {
  token: string;
  expiresAt: Date;
  info: SessionInfo;
}

/**
 * How a sign-in was proven, which a session keeps so a unit's requirement for a second step or
 * single sign-on can end the sessions that don't meet it.
 */
export type SignInAssurance = 'password' | 'second-step' | 'sso' | 'sso-second-step';

export async function createSession(
  db: Queryable,
  ctx: AppContext,
  identity: Identity,
  request: FastifyRequest,
  assurance: SignInAssurance = 'password',
  /** The identity provider a single sign-on came through, which the session stays tied to */
  providerId?: string,
  method: 'password' | 'link' | 'invitation' | 'passkey' | 'sso' = assurance === 'sso' ||
  assurance === 'sso-second-step'
    ? 'sso'
    : 'password',
): Promise<CreatedSession> {
  refuseDemoAccount(ctx.config, identity.email);
  const { app } = authDatabase(ctx);
  const sso = (assurance === 'sso' || assurance === 'sso-second-step') && Boolean(providerId);
  let days = ctx.config.sessionMaxDays;
  if (identity.hasUnits || identity.settings?.unitPolicy) {
    const { values } = await effectivePolicy(db, app, identity.orgId, identity, ctx.config);
    if (values.requireSso && !sso) throw new AppError('forbidden', 'orgUnits.policy.sso');
    days = values.sessionMaxDays;
  }
  const token = randomToken();
  const csrfToken = randomToken();
  const sessionId = newId('session');
  // Serialize the person's conversation reset without conflicting with foreign-key checks from
  // a first SSO link.  The user's key never changes during session creation.
  const current = await db.query<{ version: number }>(
    `SELECT credential_version AS version FROM ${app}.users WHERE id = $1 FOR NO KEY UPDATE`,
    [identity.userId],
  );
  if (!current.rows[0] || current.rows[0].version !== (identity.credentialVersion ?? 0))
    throw new AppError('unauthenticated', 'errors.signInRequired');
  const result = await db.query<{ expires_at: Date }>(
    `INSERT INTO ${app}.sessions (id, user_id, token_hash, csrf_token, expires_at, user_agent,
       second_step_verified, sso_verified, sso_provider_id, sign_in_method)
     VALUES ($1, $2, $3, $4, clock_timestamp() + $5 * interval '24 hours', $6, $7, $8, $9, $10)
     RETURNING expires_at`,
    [
      sessionId,
      identity.userId,
      tokenHash(token),
      csrfToken,
      days,
      request.headers['user-agent'] ?? null,
      assurance === 'second-step' || assurance === 'sso-second-step',
      sso,
      sso ? providerId : null,
      method,
    ],
  );
  // Session creation is the only automatic reset. Existing sessions read the same person-wide pointer.
  const conversationId = randomUUID();
  await db.query(`INSERT INTO ${app}.rio_conversations (id, org_id, user_id) VALUES ($1, $2, $3)`, [
    conversationId,
    identity.orgId,
    identity.userId,
  ]);
  await db.query(
    `INSERT INTO ${app}.rio_active_conversations (org_id, user_id, session_id, conversation_id)
     VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, user_id)
     DO UPDATE SET session_id = EXCLUDED.session_id, conversation_id = EXCLUDED.conversation_id`,
    [identity.orgId, identity.userId, sessionId, conversationId],
  );
  return { token, expiresAt: result.rows[0]!.expires_at, info: sessionInfo(identity, csrfToken) };
}

function cookieOptions(request: FastifyRequest) {
  return { httpOnly: true, secure: request.protocol === 'https', sameSite: 'lax' as const, path: '/' };
}

export function sessionCookieName(request: FastifyRequest): string {
  return request.protocol === 'https' ? '__Host-rio_session' : 'rio_session';
}

export function sendSession(
  request: FastifyRequest,
  reply: FastifyReply,
  session: CreatedSession,
): SessionInfo {
  reply.setCookie(sessionCookieName(request), session.token, {
    ...cookieOptions(request),
    expires: session.expiresAt,
  });
  return session.info;
}

export function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(sessionCookieName(request), cookieOptions(request));
}

export function requireActor(request: FastifyRequest): Actor {
  if (!request.actor) throw new AppError('unauthenticated', 'errors.signInRequired');
  return request.actor;
}

export function sessionResolver(ctx: AppContext): SessionResolver {
  return {
    async resolve(request) {
      if (request.actor?.demo) return request.actor;
      if (!ctx.pool || !ctx.config.database) return null;
      const token = request.cookies[sessionCookieName(request)];
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const { pool, app } = authDatabase(ctx);
      const result = await pool.query<Actor & { ageDays: number; idleDays: number }>(
        `SELECT s.id AS "sessionId", s.user_id AS "userId", s.csrf_token AS "csrfToken",
                m.org_id AS "orgId", m.kind, m.admin_roles AS "adminRoles",
                extract(epoch FROM clock_timestamp() - s.created_at)::float8 / 86400 AS "ageDays",
                extract(epoch FROM clock_timestamp() - s.last_seen_at)::float8 / 86400 AS "idleDays",
                EXISTS (SELECT 1 FROM ${app}.org_units ou WHERE ou.org_id = m.org_id) AS "hasUnits",
                COALESCE(o.settings ? 'unitPolicy', false) AS "hasUnitPolicy"
         FROM ${app}.sessions s
         JOIN ${app}.users u ON u.id = s.user_id
         JOIN ${app}.memberships m ON m.user_id = u.id
         JOIN ${app}.orgs o ON o.id = m.org_id
         WHERE s.token_hash = $1 AND NOT s.demo AND s.revoked_at IS NULL AND u.deactivated_at IS NULL
           AND ($4::text IS NULL OR lower(u.email) <> lower($4))
           AND s.expires_at > clock_timestamp()
           AND s.created_at > clock_timestamp() - $2 * interval '24 hours'
           AND s.last_seen_at > clock_timestamp() - $3 * interval '24 hours'
         ORDER BY m.created_at, m.org_id LIMIT 1`,
        [
          tokenHash(token),
          ctx.config.sessionMaxDays,
          ctx.config.sessionIdleDays,
          ctx.config.demoMode ? ctx.config.demoAccount : null,
        ],
      );
      const row = result.rows[0];
      if (!row) return null;
      const { ageDays, idleDays, ...actor } = row;
      keepPolicyForRequest(actor);
      actor.unitAdminGrants = actor.hasUnits ? await unitGrants(pool, app, actor.orgId, actor.userId) : [];
      // A person's unit, and what it requires, can change while a session is open, so each
      // request checks the session against the policy that applies now.  An organization with no
      // units and no unit policy has nothing to check beyond the server's limits.
      if (actor.hasUnits || actor.hasUnitPolicy) {
        const policy = await effectivePolicy(pool, app, actor.orgId, actor, {
          ...ctx.config,
          existingSession: true,
        });
        actor.policy = policy;
        const { values } = policy;
        let ended = ageDays >= values.sessionMaxDays || idleDays >= values.sessionIdleDays;
        if (!ended && (values.requireMfa || values.requireSso)) {
          // How the session was proven counts only while it still holds: a second step the person
          // has since removed, or a provider or link since removed or turned off, no longer does.
          const proof = await pool.query<{ secondStep: boolean; sso: boolean }>(
            `SELECT s.second_step_verified AND (
                 EXISTS (SELECT 1 FROM ${app}.passkeys p WHERE p.user_id = s.user_id)
                 OR EXISTS (SELECT 1 FROM ${app}.authenticator_secrets a
                   WHERE a.user_id = s.user_id AND a.confirmed_at IS NOT NULL)) AS "secondStep",
               s.sso_verified AND EXISTS (
                 SELECT 1 FROM ${app}.sso_providers p JOIN ${app}.sso_identities i ON i.provider_id = p.id
                 WHERE p.id = s.sso_provider_id AND p.enabled AND i.user_id = s.user_id) AS sso
             FROM ${app}.sessions s WHERE s.id = $1`,
            [actor.sessionId],
          );
          const held = proof.rows[0];
          ended = (values.requireMfa && !held?.secondStep) || (values.requireSso && !held?.sso);
        }
        if (ended) {
          await pool.query(
            `UPDATE ${app}.sessions SET revoked_at = clock_timestamp() WHERE id = $1 AND revoked_at IS NULL`,
            [actor.sessionId],
          );
          return null;
        }
      }
      await pool.query(
        `UPDATE ${app}.sessions SET last_seen_at = clock_timestamp()
         WHERE id = $1 AND last_seen_at <= clock_timestamp() - interval '5 minutes'
           AND revoked_at IS NULL`,
        [actor.sessionId],
      );
      return actor;
    },
  };
}
