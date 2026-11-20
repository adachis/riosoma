import { refuseDemo, refuseDemoAccount } from '../../demo/boundary.js';
import { z } from 'zod';
import {
  AppError,
  AdminPasswordReset,
  ChangePassword,
  EndSessions,
  PASSWORD_MIN_LENGTH,
  RequestPasswordReset,
  ResetPassword,
} from '@riosoma/contracts';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../../app.js';
import type { Actor } from '../../http/policy.js';
import { parse } from '../../http/validate.js';
import { effectivePolicy } from '../../org-units/policy.js';
import { lockUnits } from '../../org-units/store.js';
import { AccessScope } from '../access.js';
import { dataStore } from '../context.js';
import {
  auditEvent,
  authDatabase,
  lockKeys,
  randomToken,
  withSignInTransaction,
} from '../../auth/database.js';
import {
  attemptKey,
  EMAIL_LIMIT,
  IP_LIMIT,
  pruneAttempts,
  recordAttempts,
  retryAfter,
} from '../../auth/attempts.js';
import {
  accountByEmail,
  consumeReset,
  endSessions,
  issueReset,
  lockAccount,
  nextResetRequest,
  recordResetRequest,
  resetOwner,
  savePassword,
  setResetPolicy,
  soleOwner,
} from '../../auth/account-store.js';
import { findIdentity } from '../../auth/sessions.js';
import { hashPassword, verifyPassword } from '../../auth/passwords.js';
import { userLock } from '../../auth/mfa/store.js';
import { passwordChangedMessage, passwordResetMessage, passwordSsoMessage } from '../../mail/messages.js';
import type { MailMessage } from '../../mail/index.js';

const UserId = z.string().min(1).max(100);
export const AuthenticationCommand = z.discriminatedUnion('kind', [
  RequestPasswordReset.extend({ kind: z.literal('auth.reset.request') }),
  RequestPasswordReset.extend({
    kind: z.literal('auth.reset.deliver'),
    requestedAt: z.date(),
    requestNumber: z.string().regex(/^[0-9]+$/),
  }),
  ResetPassword.extend({ kind: z.literal('auth.reset.redeem') }),
  ChangePassword.extend({ kind: z.literal('auth.password.change') }),
  EndSessions.extend({ kind: z.literal('auth.sessions.end'), userId: UserId.optional() }),
  AdminPasswordReset.extend({ kind: z.literal('auth.reset.admin'), userId: UserId }),
  z.object({ kind: z.literal('auth.reset.policy'), enabled: z.boolean() }),
  RequestPasswordReset.extend({ kind: z.literal('auth.reset.owner') }),
]);

interface AuthenticationResult {
  undoable: false;
  accepted?: boolean;
  requestedAt?: Date;
  requestNumber?: string;
  link?: string;
  message?: MailMessage;
}

/**
 * Account commands commit authorization, credentials, session revocation, audit, and delivery
 * notices together.  Credentials and ended sessions cannot be restored by undo.
 */
export async function runAuthenticationCommand(
  ctx: AppContext,
  input: unknown,
  caller: { actor?: Actor; request?: FastifyRequest; serverShell?: true } = {},
): Promise<AuthenticationResult> {
  refuseDemo(caller.actor);
  const command = parse(AuthenticationCommand, input);
  if ('email' in command) refuseDemoAccount(ctx.config, command.email);
  const { pool, schemas } = dataStore(ctx);
  const { app: schema, audit } = authDatabase(ctx);
  return withSignInTransaction(pool, async (db) => {
    const actor = caller.actor;
    if (command.kind === 'auth.reset.request') {
      if (!caller.request) throw new AppError('forbidden', 'data.access.denied');
      const keys = [attemptKey('reset', command.email), attemptKey('reset-ip', caller.request.ip)];
      await lockKeys(db, keys);
      await pruneAttempts(db, schema);
      const limited =
        Boolean(await retryAfter(db, schema, keys[0]!, 5, 3600)) ||
        Boolean(await retryAfter(db, schema, keys[1]!, IP_LIMIT.attempts, IP_LIMIT.windowSeconds));
      const requestNumber = await nextResetRequest(db, schemas);
      if (!limited) {
        await recordAttempts(db, schema, keys);
        await recordResetRequest(db, schemas, command.email, requestNumber);
      }
      await auditEvent(db, audit, 'auth.password_reset.requested', null, { limited });
      // No account-dependent work occurs before the public response is sent.
      return {
        undoable: false,
        accepted: !limited,
        requestedAt: new Date(),
        requestNumber,
      };
    }
    if (command.kind === 'auth.reset.policy') {
      if (!actor) throw new AppError('unauthenticated', 'errors.signInRequired');
      await lockUnits(db, actor.orgId);
      const scope = new AccessScope(db, schemas, actor);
      await scope.requireAccount(actor.userId);
      await scope.requireOrganizationAdmin('security');
      await setResetPolicy(db, schemas, actor.orgId, command.enabled);
      await auditEvent(db, audit, 'auth.password_reset.policy_changed', actor, { enabled: command.enabled });
      return { undoable: false };
    }
    let userId: string | null;
    let serverRecovery = false;
    const copiedLink = command.kind === 'auth.reset.admin' && command.delivery === 'copy';
    if (command.kind === 'auth.reset.owner') {
      if (!caller.serverShell) throw new AppError('forbidden', 'data.access.denied');
      userId = (await soleOwner(db, schemas, command.email)).userId;
    } else if (command.kind === 'auth.reset.deliver') {
      userId = await accountByEmail(db, schemas, command.email);
    } else if (command.kind === 'auth.reset.redeem') {
      const grant = await resetOwner(db, schemas, command.token);
      userId = grant?.userId ?? null;
      serverRecovery = grant?.source === 'server';
      if (!userId) throw new AppError('unauthenticated', 'auth.reset.invalid');
    } else {
      if (!actor) throw new AppError('unauthenticated', 'errors.signInRequired');
      userId = 'userId' in command ? (command.userId ?? actor.userId) : actor.userId;
      await lockUnits(db, actor.orgId);
      await new AccessScope(db, schemas, actor).requireAccount(userId, copiedLink);
      if (command.kind === 'auth.reset.admin' && userId === actor.userId)
        throw new AppError('forbidden', 'auth.reset.self');
    }
    if (!userId) return { undoable: false };
    if (!actor) {
      const target = await findIdentity(db, schema, userId);
      if (target) await lockUnits(db, target.orgId);
    }
    if (command.kind === 'auth.reset.owner') await soleOwner(db, schemas, command.email);
    await lockKeys(db, [userLock(userId)]);
    const account = await lockAccount(db, schemas, userId);
    const identity = account ? await findIdentity(db, schema, userId) : null;
    if (!account || !identity) {
      if (command.kind === 'auth.reset.deliver') return { undoable: false };
      throw new AppError('unauthenticated', 'auth.reset.invalid');
    }
    refuseDemoAccount(ctx.config, identity.email);
    if (actor) await new AccessScope(db, schemas, actor).requireAccount(userId, copiedLink);
    const who = actor ?? { orgId: identity.orgId, userId: null };
    if (command.kind === 'auth.sessions.end') {
      const count = await endSessions(db, schemas, userId, {
        ...(command.sessionId ? { sessionId: command.sessionId } : {}),
        ...(command.others ? { except: actor!.sessionId } : {}),
      });
      await auditEvent(
        db,
        audit,
        command.sessionId === actor?.sessionId && !command.others ? 'auth.sign_out' : 'auth.sessions.ended',
        who,
        { userId, count, others: command.others },
      );
      return { undoable: false };
    }
    const policy = await effectivePolicy(db, schema, identity.orgId, identity, ctx.config);
    const allowed = identity.settings.passwordResetEnabled !== false;
    const passwordAllowed = account.passwordHash !== null && !policy.values.requireSso;
    if (
      command.kind === 'auth.reset.deliver' ||
      command.kind === 'auth.reset.admin' ||
      command.kind === 'auth.reset.owner'
    ) {
      if (!allowed && command.kind !== 'auth.reset.owner') {
        if (command.kind === 'auth.reset.deliver') return { undoable: false };
        throw new AppError('forbidden', 'auth.reset.disabled');
      }
      if (!passwordAllowed) {
        if (command.kind === 'auth.reset.deliver' && ctx.mailer && ctx.config.baseUrl)
          return {
            undoable: false,
            message: passwordSsoMessage(identity.email, identity.locale, ctx.config.baseUrl),
          };
        throw new AppError('forbidden', 'auth.reset.sso');
      }
      if (!ctx.config.baseUrl) throw new AppError('unavailable', 'auth.reset.addressRequired');
      if (command.kind === 'auth.reset.admin' && command.delivery === 'email' && !ctx.mailer)
        throw new AppError('unavailable', 'auth.reset.emailUnavailable');
      const token = randomToken();
      const requestedAt = command.kind === 'auth.reset.deliver' ? command.requestedAt : new Date();
      if (
        !(await issueReset(
          db,
          schemas,
          userId,
          identity.email,
          token,
          requestedAt,
          command.kind === 'auth.reset.deliver' ? command.requestNumber : await nextResetRequest(db, schemas),
          command.kind === 'auth.reset.owner'
            ? 'server'
            : command.kind === 'auth.reset.admin'
              ? 'admin'
              : 'request',
        ))
      )
        return { undoable: false };
      const link = `${ctx.config.baseUrl.replace(/\/+$/, '')}/sign-in/reset#token=${token}`;
      await auditEvent(
        db,
        audit,
        command.kind === 'auth.reset.owner'
          ? 'auth.password_reset.server_created'
          : 'auth.password_reset.link_created',
        who,
        { userId },
      );
      const copy = command.kind === 'auth.reset.owner' || copiedLink;
      return {
        undoable: false,
        ...(copy ? { link } : { message: passwordResetMessage(identity.email, identity.locale, link) }),
      };
    }
    if (!passwordAllowed) throw new AppError('forbidden', 'auth.reset.sso');
    if (command.kind === 'auth.reset.redeem' && !allowed && !serverRecovery)
      throw new AppError('forbidden', 'auth.reset.disabled');
    if (command.password.length < Math.max(PASSWORD_MIN_LENGTH, policy.values.passwordMinLength))
      throw new AppError('validation_failed', 'auth.reset.tooShort', {
        params: { min: policy.values.passwordMinLength },
      });
    if (command.kind === 'auth.password.change') {
      const emailKey = attemptKey('email', identity.email);
      const ipKey = attemptKey('ip', caller.request?.ip ?? '');
      await lockKeys(db, [emailKey, ipKey]);
      if (
        (await retryAfter(db, schema, emailKey, EMAIL_LIMIT.attempts, EMAIL_LIMIT.windowSeconds)) ||
        (await retryAfter(db, schema, ipKey, IP_LIMIT.attempts, IP_LIMIT.windowSeconds))
      )
        return { undoable: false, accepted: false };
      if (!(await verifyPassword(command.currentPassword, account.passwordHash))) {
        await recordAttempts(db, schema, [emailKey, ipKey]);
        await auditEvent(db, audit, 'auth.password_change.refused', who, { userId });
        return { undoable: false, accepted: false };
      }
    } else await consumeReset(db, schemas, command.token);
    await savePassword(db, schemas, userId, await hashPassword(command.password));
    const all = command.kind === 'auth.reset.redeem';
    const count =
      all || command.endOtherSessions
        ? await endSessions(db, schemas, userId, all ? {} : { except: actor!.sessionId })
        : 0;
    await auditEvent(db, audit, all ? 'auth.password_reset.completed' : 'auth.password.changed', who, {
      userId,
      sessionsEnded: count,
    });
    return {
      undoable: false,
      accepted: true,
      message: passwordChangedMessage(identity.email, identity.locale),
    };
  });
}
