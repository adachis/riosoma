import { demoSession } from '../demo/metadata.js';
import { AccessScope } from '../data/access.js';
import { accountRoutes } from './account-routes.js';
import { runAuthenticationCommand } from '../data/commands/authentication.js';
import { effectivePolicy, memberPolicy } from '../org-units/policy.js';
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  OrganizationBranding,
  newId,
  PreferencesUpdate,
  RedeemSignInLink,
  RequestSignInLink,
  safeSignInNext,
  SignInWithPassword,
  type Preferences,
  type SignInMethods,
} from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import { parse } from '../http/validate.js';
import { mailFailureFields } from '../mail/index.js';
import { signInMessage } from '../mail/messages.js';
import { attemptKey, EMAIL_LIMIT, IP_LIMIT, pruneAttempts, recordAttempts, retryAfter } from './attempts.js';
import {
  auditEvent,
  authDatabase,
  lockKeys,
  randomToken,
  savePreferences,
  tokenHash,
  withSignInTransaction,
} from './database.js';
import { afterFirstStep, sendFirstStep } from './mfa/pending.js';
import { relyingParty } from './mfa/webauthn.js';
import { checkLevelChoice } from './levels.js';
import { verifyPassword } from './passwords.js';
import { clearSessionCookie, findIdentity, requireActor, sessionInfo } from './sessions.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  await app.register(accountRoutes);
  const publicRoute = { config: { policy: { kind: 'public' as const } } };
  const sessionRoute = { config: { policy: { kind: 'session' as const } } };

  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get('/api/auth/methods', publicRoute, async (): Promise<SignInMethods> => {
    const branding = ctx.pool
      ? OrganizationBranding.nullable().parse(
          await AccessScope.signInBranding(authDatabase(ctx).pool, authDatabase(ctx).app.replaceAll('"', '')),
        )
      : null;
    return {
      ...(branding?.logo ? { branding } : {}),
      password: true,
      link: Boolean(ctx.mailer && ctx.config.baseUrl),
      passkey: relyingParty(ctx) !== null,
    };
  });

  app.post('/api/auth/sign-in', publicRoute, async (request, reply) => {
    const input = parse(SignInWithPassword, request.body);
    const { pool, app: schema, audit } = authDatabase(ctx);
    const emailKey = attemptKey('email', input.email);
    const ipKey = attemptKey('ip', request.ip);
    const result = await withSignInTransaction(pool, async (db) => {
      await lockKeys(db, [emailKey, ipKey]);
      await pruneAttempts(db, schema);
      const retryAfterSeconds = Math.max(
        await retryAfter(db, schema, emailKey, EMAIL_LIMIT.attempts, EMAIL_LIMIT.windowSeconds),
        await retryAfter(db, schema, ipKey, IP_LIMIT.attempts, IP_LIMIT.windowSeconds),
      );
      if (retryAfterSeconds) {
        await auditEvent(db, audit, 'auth.sign_in_failed', null, { reason: 'locked', ip: request.ip });
        return new AppError('rate_limited', 'auth.signIn.locked', { params: { retryAfterSeconds } });
      }
      const users = await db.query<{
        id: string;
        password_hash: string | null;
        deactivated_at: Date | null;
        credential_version: number;
      }>(
        `SELECT id, password_hash, deactivated_at, credential_version FROM ${schema}.users WHERE lower(email) = $1`,
        [input.email],
      );
      const user = users.rows[0];
      const valid = await verifyPassword(input.password, user?.password_hash ?? null);
      const identity = user && valid && !user.deactivated_at ? await findIdentity(db, schema, user.id) : null;
      if (!identity || identity.credentialVersion !== user?.credential_version) {
        await recordAttempts(db, schema, [emailKey, ipKey]);
        await auditEvent(db, audit, 'auth.sign_in_failed', null, {
          reason: 'invalid_credentials',
          ip: request.ip,
        });
        // Return the error so the failed attempt commits before it crosses the HTTP boundary.
        return new AppError('unauthenticated', 'auth.signIn.invalid');
      }
      // Passwords are checked against the minimum where the person is now, which a unit may
      // have raised since the password was set.  A sign-in link or a passkey still works.
      if (
        (identity.hasUnits || identity.settings.unitPolicy) &&
        input.password.length <
          (await effectivePolicy(db, schema, identity.orgId, identity, ctx.config)).values.passwordMinLength
      )
        return new AppError('forbidden', 'orgUnits.policy.password');
      // Someone with a second step, or whose organization requires one, isn't signed in yet.
      const outcome = await afterFirstStep(db, ctx, identity, request, 'password');
      if ('session' in outcome) await auditEvent(db, audit, 'auth.sign_in', identity, { ip: request.ip });
      return outcome;
    });
    if (result instanceof AppError) {
      if (result.code === 'rate_limited') reply.header('retry-after', result.params!.retryAfterSeconds);
      throw result;
    }
    return sendFirstStep(ctx, request, reply, result);
  });

  app.post('/api/auth/link', publicRoute, async (request, reply) => {
    const input = parse(RequestSignInLink, request.body);
    // The public response stays the same when delivery is unavailable or the account is unknown.
    const mailer = ctx.mailer;
    const base = ctx.config.baseUrl?.replace(/\/+$/, '');
    if (!mailer || !base) return reply.status(202).send();
    const { pool, app: schema, audit } = authDatabase(ctx);
    const key = attemptKey('link', input.email);
    const delivery = await withTransaction(pool, async (db) => {
      await lockKeys(db, [key]);
      await pruneAttempts(db, schema);
      if (await retryAfter(db, schema, key, 5, 3600)) return null;
      await recordAttempts(db, schema, [key]);
      const users = await db.query<{ id: string }>(
        `SELECT id FROM ${schema}.users WHERE lower(email) = $1 AND deactivated_at IS NULL`,
        [input.email],
      );
      const user = users.rows[0];
      const identity = user ? await findIdentity(db, schema, user.id) : null;
      await auditEvent(db, audit, 'auth.link_requested', identity);
      if (!identity) return null;
      const token = randomToken();
      await db.query(
        `INSERT INTO ${schema}.login_tokens (id, user_id, email, purpose, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, clock_timestamp() + interval '15 minutes')`,
        [newId('token'), identity.userId, identity.email, 'magic_link', tokenHash(token)],
      );
      const next = safeSignInNext(input.next);
      const search = next === '/' ? '' : `?${new URLSearchParams({ next })}`;
      return signInMessage(identity.email, identity.locale, `${base}/sign-in/link${search}#token=${token}`);
    });
    if (delivery) {
      // Not awaited: waiting on the mail server would make known emails answer measurably slower.
      mailer.send(delivery).catch((error: unknown) => {
        // Provider errors can contain the entire message, including its one-time credential, so
        // only a transport's own reason, which never quotes the message, rides along.
        request.log.warn(
          { code: 'mail_delivery_failed', ...mailFailureFields(error) },
          'sign-in email delivery failed',
        );
      });
    }
    return reply.status(202).send();
  });

  app.post('/api/auth/link/redeem', publicRoute, async (request, reply) => {
    const input = parse(RedeemSignInLink, request.body);
    const { pool, app: schema, audit } = authDatabase(ctx);
    const outcome = await withSignInTransaction(pool, async (db) => {
      const tokens = await db.query<{ user_id: string }>(
        `UPDATE ${schema}.login_tokens SET used_at = clock_timestamp()
         WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > clock_timestamp()
         RETURNING user_id`,
        [tokenHash(input.token), 'magic_link'],
      );
      const token = tokens.rows[0];
      const identity = token ? await findIdentity(db, schema, token.user_id) : null;
      if (!identity) throw new AppError('unauthenticated', 'auth.link.invalid');
      const next = await afterFirstStep(db, ctx, identity, request, 'link');
      await auditEvent(db, audit, 'auth.link_redeemed', identity, { ip: request.ip });
      if ('session' in next)
        await auditEvent(db, audit, 'auth.sign_in', identity, { ip: request.ip, method: 'link' });
      return next;
    });
    return sendFirstStep(ctx, request, reply, outcome);
  });

  app.get('/api/auth/session', sessionRoute, async (request) => {
    const actor = requireActor(request);
    const { pool, app: schema } = authDatabase(ctx);
    // The session check already worked out the person's policy and grants for this request.
    const identity = await findIdentity(pool, schema, actor.userId, {
      ...(actor.policy ? { policy: actor.policy } : {}),
      ...(actor.unitAdminGrants ? { grants: actor.unitAdminGrants } : {}),
    });
    if (!identity) throw new AppError('unauthenticated', 'errors.signInRequired');
    const ordinary = sessionInfo(identity, actor.csrfToken);
    const info = actor.demo ? demoSession(ordinary) : ordinary;
    return {
      ...info,
      ...(actor.demo ? { demo: true, demoLink: ctx.config.demoLink, expiresAt: actor.demoExpiresAt } : {}),
    };
  });

  app.post('/api/auth/sign-out', sessionRoute, async (request, reply) => {
    const actor = requireActor(request);
    await runAuthenticationCommand(
      ctx,
      { kind: 'auth.sessions.end', sessionId: actor.sessionId },
      { actor, request },
    );
    clearSessionCookie(request, reply);
    return reply.status(204).send();
  });

  app.patch('/api/me/preferences', sessionRoute, async (request) => {
    const actor = requireActor(request);
    const { level, ...rest } = parse(PreferencesUpdate, request.body);
    const { pool, app: schema } = authDatabase(ctx);
    await checkLevelChoice(pool, schema, actor, level ?? undefined);
    // A theme has to be one the organization, or the person's unit, allows.
    if (rest.theme) {
      const allowed = (await memberPolicy(pool, schema, actor))?.values.allowedThemes;
      if (allowed && !allowed.includes(rest.theme)) throw new AppError('forbidden', 'orgUnits.policy.theme');
    }
    // A null level clears the person's choice, so the organization's default applies again.
    const preferences: Partial<Preferences> = level ? { ...rest, level } : rest;
    const cleared = level === null ? ['level'] : [];
    return savePreferences(ctx, actor, preferences, cleared);
  });
}
