import { effectivePolicy } from '../../org-units/policy.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AppError,
  AuthenticatorConfirm,
  AuthenticatorTurnOn,
  FreshProof,
  MfaRemoval,
  newId,
  PasskeyAdd,
  PasskeyCreate,
  PasskeyRename,
  PasskeySignIn,
  SecondStepProof,
  type AuthenticatorConfirmed,
  type AuthenticatorSetup,
  type MfaOverview,
  type Passkey,
  type PasskeyAdded,
  type RecoveryCodes,
  type SecondStepSetupDone,
  type SecondStepStatus,
} from '@riosoma/contracts';
import { query, sql, withTransaction, type Queryable } from '@riosoma/db';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import type { Actor } from '../../http/policy.js';
import { parse } from '../../http/validate.js';
import {
  attemptKey,
  clearEmailFailures,
  IP_LIMIT,
  pruneAttempts,
  recordAttempts,
  retryAfter,
} from '../attempts.js';
import { auditEvent, authDatabase, lockKeys, withSignInTransaction } from '../database.js';
import { createSession, findIdentity, requireActor, sendSession, type Identity } from '../sessions.js';
import { mfaAdminRoutes } from './admin.js';
import {
  authenticatorUri,
  matchingStep,
  newAuthenticatorSecret,
  replaceRecoveryCodes,
  sealAuthenticatorSecret,
  unsealAuthenticatorSecret,
} from './codes.js';
import {
  clearPending,
  completeSignIn,
  pendingKey,
  readPending,
  secondStepView,
  type Pending,
} from './pending.js';
import {
  addWayIn,
  noteProof,
  refusal,
  Refused,
  sessionPerson,
  usePasskey,
  useProof,
  withFreshProof,
  withinLimits,
  type ProofUsed,
} from './proof.js';
import {
  hasSecondStep,
  isSpent,
  mfaStore,
  orgPolicy,
  passkeyOwner,
  passkeysOf,
  passkeyView,
  requiredBy,
  secondStepsOf,
  spend,
  userLock,
  type MfaTables,
  type PasskeyRow,
} from './store.js';
import {
  creationOptions,
  relyingParty,
  requestOptions,
  requireRelyingParty,
  takeChallenge,
  userHandle,
  verifyNewPasskey,
  type NewPasskey,
} from './webauthn.js';

const PasskeyParams = z.object({ passkeyId: z.string().regex(/^pky[0-9A-Za-z]{14}$/) });

/** Whoever the request is for, whether it arrived with a session or a pending sign-in. */
type Someone = Identity | Actor;

/**
 * Someone who has taken away their last second step no longer has sessions proven by one, so a
 * unit that requires a second step ends them.
 */
async function noSecondStepLeft(db: Queryable, tables: MfaTables, userId: string): Promise<void> {
  await query(db, sql`UPDATE ${tables.sessions} SET second_step_verified = false WHERE user_id = ${userId}`);
}

/**
 * Passkeys, authenticator apps, recovery codes, and the second step of signing in.  Every change
 * to someone's second steps holds a lock for that person, so two changes never race.
 */
export async function mfaRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const publicRoute = { config: { policy: { kind: 'public' as const } } };
  const sessionRoute = { config: { policy: { kind: 'session' as const } } };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  await app.register(mfaAdminRoutes);

  async function identityOf(userId: string): Promise<Identity | null> {
    const { pool, app: schema } = authDatabase(ctx);
    return findIdentity(pool, schema, userId);
  }

  function currentPerson(actor: Actor): Promise<Identity> {
    return sessionPerson(ctx, actor);
  }

  /** The pending sign-in this browser carries, at the stage the route serves. */
  async function pendingAt(request: FastifyRequest, stage: Pending['stage']): Promise<Pending> {
    const pending = readPending(ctx, request);
    if (!pending || pending.stage !== stage) throw new AppError('unauthenticated', 'mfa.pending.expired');
    const { pool, tables } = mfaStore(ctx);
    if (await isSpent(pool, tables, pendingKey(pending)))
      throw new AppError('unauthenticated', 'mfa.pending.expired');
    return pending;
  }

  async function pendingPerson(pending: Pending): Promise<Identity> {
    const identity = await identityOf(pending.userId);
    if (!identity || (identity.credentialVersion ?? 0) !== pending.credentialVersion)
      throw new AppError('unauthenticated', 'mfa.pending.expired');
    return identity;
  }

  async function audit(db: Queryable, action: string, who: Someone, details: Record<string, unknown> = {}) {
    await auditEvent(db, authDatabase(ctx).audit, action, who, details);
  }

  /** A new set of recovery codes, recorded without the codes themselves. */
  async function recoveryCodesFor(
    db: Queryable,
    tables: MfaTables,
    who: Someone,
    details: Record<string, unknown> = {},
  ): Promise<string[]> {
    const codes = await replaceRecoveryCodes(db, tables, who.userId);
    await audit(db, 'auth.recovery_codes.generated', who, { count: codes.length, ...details });
    return codes;
  }

  /** A new passkey that didn't check out: recorded, then refused. */
  async function refuseNewPasskey(request: FastifyRequest, who: Someone): Promise<never> {
    await audit(authDatabase(ctx).pool, 'auth.passkey.refused', who, { ip: request.ip });
    throw new AppError('bad_request', 'mfa.passkey.failed');
  }

  /**
   * A new secret for an authenticator app.  One that was never confirmed gives way to it.  One that's
   * on stays on, and with `replace` the new secret waits beside it as its replacement.
   */
  async function startAuthenticator(person: Identity, replace: boolean): Promise<AuthenticatorSetup> {
    const { pool, tables } = mfaStore(ctx);
    const secret = newAuthenticatorSecret();
    const sealed = sealAuthenticatorSecret(ctx.config.secretKey, person.userId, secret);
    await withTransaction(pool, async (db) => {
      await lockKeys(db, [userLock(person.userId)]);
      const stored = await query(
        db,
        sql`INSERT INTO ${tables.authenticators} (user_id, sealed_secret) VALUES (${person.userId}, ${sealed})
        ON CONFLICT (user_id) DO UPDATE SET sealed_secret = EXCLUDED.sealed_secret,
          created_at = clock_timestamp(), last_step = NULL
        WHERE ${tables.authenticators}.confirmed_at IS NULL
        RETURNING user_id`,
      );
      if (!stored.rowCount && !replace) throw new AppError('conflict', 'mfa.authenticator.alreadyOn');
      if (!stored.rowCount)
        await query(
          db,
          sql`UPDATE ${tables.authenticators}
          SET replacement_sealed_secret = ${sealed}, replacement_created_at = clock_timestamp()
          WHERE user_id = ${person.userId}`,
        );
      await audit(db, 'auth.authenticator.started', person, stored.rowCount ? {} : { replacing: true });
    });
    return { secret, uri: authenticatorUri(secret, person.email) };
  }

  // Signing in with a passkey, which needs nothing else.

  app.post('/api/auth/passkey/options', publicRoute, async (request, reply) =>
    requestOptions(ctx, request, reply, null, 'sign-in', ''),
  );

  app.post('/api/auth/passkey', publicRoute, async (request, reply) => {
    const rp = requireRelyingParty(ctx);
    const { response } = parse(PasskeySignIn, request.body);
    const challenge = await takeChallenge(ctx, request, reply, 'sign-in', '');
    const { pool, app: schema, audit: events } = authDatabase(ctx);
    const { tables } = mfaStore(ctx);
    const ipKey = attemptKey('ip', request.ip);
    const result = await withSignInTransaction(pool, async (db) => {
      const owner = await passkeyOwner(db, tables, response.id);
      await lockKeys(db, owner ? [attemptKey('email', owner.email.toLowerCase()), ipKey] : [ipKey]);
      await pruneAttempts(db, schema);
      const retryAfterSeconds = await retryAfter(
        db,
        schema,
        ipKey,
        IP_LIMIT.attempts,
        IP_LIMIT.windowSeconds,
      );
      if (retryAfterSeconds) {
        await auditEvent(db, events, 'auth.sign_in_failed', null, {
          reason: 'locked',
          method: 'passkey',
          ip: request.ip,
        });
        return new AppError('rate_limited', 'mfa.locked', { params: { retryAfterSeconds } });
      }
      const passkey = owner ? await usePasskey(db, tables, rp, response, challenge, owner.userId) : null;
      const identity = passkey ? await findIdentity(db, schema, passkey.user_id) : null;
      if (!passkey || !identity) {
        await recordAttempts(db, schema, [ipKey]);
        await auditEvent(db, events, 'auth.sign_in_failed', null, {
          reason: 'passkey',
          method: 'passkey',
          ip: request.ip,
        });
        // Returned rather than thrown, so the failed attempt commits.
        return new AppError('unauthenticated', 'mfa.passkey.failed');
      }
      await clearEmailFailures(db, schema, identity.email);
      const session = await createSession(db, ctx, identity, request, 'second-step', undefined, 'passkey');
      await auditEvent(db, events, 'auth.sign_in', identity, {
        ip: request.ip,
        method: 'passkey',
        passkeyId: passkey.id,
      });
      return session;
    });
    if (result instanceof AppError) {
      if (result.code === 'rate_limited') reply.header('retry-after', result.params!.retryAfterSeconds);
      throw result;
    }
    return sendSession(request, reply, result);
  });

  // The second step after a password, an emailed link, or an invitation.

  app.get('/api/auth/second-step', publicRoute, async (request): Promise<SecondStepStatus> => {
    const pending = readPending(ctx, request);
    if (!pending || !ctx.pool || !ctx.config.database) return { secondStep: null };
    const { pool, tables } = mfaStore(ctx);
    if (await isSpent(pool, tables, pendingKey(pending))) return { secondStep: null };
    const identity = await identityOf(pending.userId);
    if (!identity || (identity.credentialVersion ?? 0) !== pending.credentialVersion)
      return { secondStep: null };
    const steps = await secondStepsOf(pool, tables, pending.userId);
    return { secondStep: secondStepView(ctx, pending, identity.email, steps) };
  });

  app.delete('/api/auth/second-step', publicRoute, async (request, reply) => {
    const pending = readPending(ctx, request);
    clearPending(ctx, request, reply);
    if (pending && ctx.pool && ctx.config.database) {
      const { pool, tables } = mfaStore(ctx);
      await withTransaction(pool, async (db) => {
        // Spent, so a copy of the cookie can't carry on where this one stopped.
        if (!(await spend(db, tables, pendingKey(pending), pending.expires))) return;
        const identity = await findIdentity(db, authDatabase(ctx).app, pending.userId);
        if (identity) await audit(db, 'auth.second_step.canceled', identity, { ip: request.ip });
      });
    }
    return reply.status(204).send();
  });

  app.post('/api/auth/second-step/options', publicRoute, async (request, reply) => {
    const pending = await pendingAt(request, 'verify');
    const { pool, tables } = mfaStore(ctx);
    const passkeys = await passkeysOf(pool, tables, pending.userId);
    if (!passkeys.length) throw new AppError('conflict', 'mfa.passkey.none');
    return requestOptions(ctx, request, reply, passkeys, 'second-step', pending.id);
  });

  app.post('/api/auth/second-step', publicRoute, async (request, reply) => {
    const pending = await pendingAt(request, 'verify');
    const proof = parse(SecondStepProof, request.body);
    const person = await pendingPerson(pending);
    const challenge =
      proof.method === 'passkey' ? await takeChallenge(ctx, request, reply, 'second-step', pending.id) : null;
    const { tables } = mfaStore(ctx);
    const session = await withinLimits(
      ctx,
      request,
      reply,
      person,
      proof.method,
      async (db) => {
        await lockKeys(db, [userLock(person.userId)]);
        const used = await useProof(db, ctx, tables, person.userId, proof, challenge);
        if (!used) return null;
        await noteProof(db, ctx, tables, person, used);
        return completeSignIn(
          db,
          ctx,
          request,
          pending,
          person,
          used.method,
          used.passkeyId ? { passkeyId: used.passkeyId } : {},
        );
      },
      refusal(proof, true),
    );
    clearPending(ctx, request, reply);
    return sendSession(request, reply, session);
  });

  // Adding a first second step, when the organization requires one before anything else.

  /** Someone at the setup stage who has since added a second step elsewhere has to use that one. */
  async function stillWithout(db: Queryable, tables: MfaTables, person: Identity): Promise<void> {
    await lockKeys(db, [userLock(person.userId)]);
    if (hasSecondStep(await secondStepsOf(db, tables, person.userId)))
      throw new AppError('conflict', 'mfa.setup.notNeeded');
  }

  app.post('/api/auth/second-step/passkeys/options', publicRoute, async (request, reply) => {
    const pending = await pendingAt(request, 'setup');
    const person = await pendingPerson(pending);
    const { pool, tables } = mfaStore(ctx);
    const existing = await passkeysOf(pool, tables, person.userId);
    return creationOptions(ctx, request, reply, person, existing, 'setup', pending.id);
  });

  app.post(
    '/api/auth/second-step/passkeys',
    publicRoute,
    async (request, reply): Promise<SecondStepSetupDone> => {
      const pending = await pendingAt(request, 'setup');
      const input = parse(PasskeyCreate, request.body);
      const person = await pendingPerson(pending);
      const rp = requireRelyingParty(ctx);
      const challenge = await takeChallenge(ctx, request, reply, 'setup', pending.id);
      const created = await verifyNewPasskey(rp, input.response, challenge);
      if (!created) return refuseNewPasskey(request, person);
      const { pool, tables } = mfaStore(ctx);
      const done = await withTransaction(pool, async (db) => {
        await stillWithout(db, tables, person);
        const passkey = await insertPasskey(db, ctx, tables, person.userId, input.name, created);
        await audit(db, 'auth.passkey.added', person, { passkeyId: passkey.id });
        const recoveryCodes = await recoveryCodesFor(db, tables, person);
        const session = await completeSignIn(db, ctx, request, pending, person, 'passkey', {
          passkeyId: passkey.id,
        });
        return { session, recoveryCodes };
      });
      clearPending(ctx, request, reply);
      return { session: sendSession(request, reply, done.session), recoveryCodes: done.recoveryCodes };
    },
  );

  app.post(
    '/api/auth/second-step/authenticator',
    publicRoute,
    async (request): Promise<AuthenticatorSetup> => {
      const pending = await pendingAt(request, 'setup');
      return startAuthenticator(await pendingPerson(pending), false);
    },
  );

  app.post(
    '/api/auth/second-step/authenticator/confirm',
    publicRoute,
    async (request, reply): Promise<SecondStepSetupDone> => {
      const pending = await pendingAt(request, 'setup');
      const { code } = parse(AuthenticatorConfirm, request.body);
      const person = await pendingPerson(pending);
      const { tables } = mfaStore(ctx);
      const done = await withinLimits(
        ctx,
        request,
        reply,
        person,
        'authenticator',
        async (db) => {
          await stillWithout(db, tables, person);
          if (!(await confirmAuthenticator(db, ctx, tables, person.userId, code))) return null;
          await audit(db, 'auth.authenticator.enabled', person);
          const recoveryCodes = await recoveryCodesFor(db, tables, person);
          const session = await completeSignIn(db, ctx, request, pending, person, 'authenticator');
          return { session, recoveryCodes };
        },
        new AppError('unauthenticated', 'mfa.code.invalid'),
      );
      clearPending(ctx, request, reply);
      return { session: sendSession(request, reply, done.session), recoveryCodes: done.recoveryCodes };
    },
  );

  // Your own second steps, from a session.

  app.get('/api/me/mfa', sessionRoute, async (request): Promise<MfaOverview> => {
    const actor = requireActor(request);
    const { pool, tables } = mfaStore(ctx);
    const passkeys = await passkeysOf(pool, tables, actor.userId);
    const authenticator = await query<{ confirmed_at: Date | null; last_used_at: Date | null }>(
      pool,
      sql`SELECT confirmed_at, last_used_at FROM ${tables.authenticators} WHERE user_id = ${actor.userId}`,
    );
    const codes = await query<{ remaining: number; created_at: Date | null }>(
      pool,
      sql`SELECT count(*) FILTER (WHERE used_at IS NULL)::int AS remaining, max(created_at) AS created_at
      FROM ${tables.recoveryCodes} WHERE user_id = ${actor.userId}`,
    );
    const confirmed = authenticator.rows[0]?.confirmed_at ?? null;
    const lastUsed = confirmed ? (authenticator.rows[0]?.last_used_at ?? null) : null;
    return {
      passkeys: passkeys.map(passkeyView),
      authenticator: {
        enabled: confirmed !== null,
        since: confirmed?.toISOString() ?? null,
        lastUsedAt: lastUsed?.toISOString() ?? null,
      },
      recoveryCodes: {
        remaining: codes.rows[0]?.remaining ?? 0,
        createdAt: codes.rows[0]?.created_at?.toISOString() ?? null,
      },
      required:
        (await effectivePolicy(pool, authDatabase(ctx).app, actor.orgId, actor, ctx.config)).values
          .requireMfa || requiredBy(await orgPolicy(pool, tables, actor.orgId), actor),
      passkeysAvailable: relyingParty(ctx) !== null,
    };
  });

  app.post('/api/me/mfa/passkeys/options', sessionRoute, async (request, reply) => {
    const actor = requireActor(request);
    const person = await currentPerson(actor);
    const { pool, tables } = mfaStore(ctx);
    const existing = await passkeysOf(pool, tables, actor.userId);
    return creationOptions(ctx, request, reply, person, existing, 'register', actor.sessionId);
  });

  app.post('/api/me/mfa/passkeys', sessionRoute, async (request, reply): Promise<PasskeyAdded> => {
    const actor = requireActor(request);
    const input = parse(PasskeyAdd, request.body);
    const rp = requireRelyingParty(ctx);
    const challenge = await takeChallenge(ctx, request, reply, 'register', actor.sessionId);
    const created = await verifyNewPasskey(rp, input.response, challenge);
    if (!created) return refuseNewPasskey(request, actor);
    const person = await currentPerson(actor);
    const { tables } = mfaStore(ctx);
    return addWayIn(ctx, request, reply, person, actor.sessionId, input.proof, async (db, used, first) => {
      const passkey = await insertPasskey(db, ctx, tables, actor.userId, input.name, created);
      await audit(db, 'auth.passkey.added', actor, {
        passkeyId: passkey.id,
        ...(used ? { proof: used.method } : {}),
      });
      return {
        passkey: passkeyView(passkey),
        recoveryCodes: first ? await recoveryCodesFor(db, tables, actor) : null,
      };
    });
  });

  app.patch('/api/me/mfa/passkeys/:passkeyId', sessionRoute, async (request): Promise<Passkey> => {
    const actor = requireActor(request);
    const { passkeyId } = parse(PasskeyParams, request.params);
    const { name } = parse(PasskeyRename, request.body);
    const { pool, tables } = mfaStore(ctx);
    return withTransaction(pool, async (db) => {
      const renamed = await query<PasskeyRow>(
        db,
        sql`UPDATE ${tables.passkeys} SET name = ${name}
        WHERE id = ${passkeyId} AND user_id = ${actor.userId} RETURNING *`,
      );
      const passkey = renamed.rows[0];
      if (!passkey) throw new AppError('not_found', 'errors.notFound');
      await audit(db, 'auth.passkey.renamed', actor, { passkeyId });
      return passkeyView(passkey);
    });
  });

  app.delete('/api/me/mfa/passkeys/:passkeyId', sessionRoute, async (request, reply) => {
    const actor = requireActor(request);
    const { passkeyId } = parse(PasskeyParams, request.params);
    const { proof } = parse(MfaRemoval, request.body ?? {});
    const person = await currentPerson(actor);
    const { tables } = mfaStore(ctx);
    await withFreshProof(ctx, request, reply, person, actor.sessionId, proof, async (db, used) => {
      const steps = await secondStepsOf(db, tables, actor.userId);
      const removed = await query(
        db,
        sql`DELETE FROM ${tables.passkeys} WHERE id = ${passkeyId} AND user_id = ${actor.userId}`,
      );
      if (!removed.rowCount) throw new AppError('not_found', 'errors.notFound');
      // Taking away the last second step needs a fresh one.  Recovery codes go with it, since
      // they'd have nothing left to stand in for.
      const last = steps.passkeys === 1 && !steps.authenticator;
      if (last && !used) throw new AppError('forbidden', 'mfa.proof.required');
      if (last) {
        await query(db, sql`DELETE FROM ${tables.recoveryCodes} WHERE user_id = ${actor.userId}`);
        await noSecondStepLeft(db, tables, actor.userId);
      }
      await audit(db, 'auth.passkey.removed', actor, { passkeyId, ...(used ? { proof: used.method } : {}) });
    });
    return reply.status(204).send();
  });

  app.post('/api/me/mfa/authenticator', sessionRoute, async (request): Promise<AuthenticatorSetup> =>
    startAuthenticator(await currentPerson(requireActor(request)), true),
  );

  app.post(
    '/api/me/mfa/authenticator/confirm',
    sessionRoute,
    async (request, reply): Promise<AuthenticatorConfirmed> => {
      const actor = requireActor(request);
      const { code, proof } = parse(AuthenticatorTurnOn, request.body);
      const person = await currentPerson(actor);
      const { tables } = mfaStore(ctx);
      const challenge =
        proof?.method === 'passkey'
          ? await takeChallenge(ctx, request, reply, 'proof', actor.sessionId)
          : null;
      return withinLimits(
        ctx,
        request,
        reply,
        person,
        'authenticator',
        async (db) => {
          await lockKeys(db, [userLock(actor.userId)]);
          const first = !hasSecondStep(await secondStepsOf(db, tables, actor.userId));
          const waiting = await awaitingAuthenticator(db, ctx, tables, actor.userId);
          // Another way in, or a new app in place of the one that's on, takes a fresh second step.
          if (!first && !proof) throw new AppError('forbidden', 'mfa.proof.required');
          let used: ProofUsed | null = null;
          if (proof) {
            used = await useProof(db, ctx, tables, actor.userId, proof, challenge);
            if (!used) return new Refused(refusal(proof, false), proof.method);
            await noteProof(db, ctx, tables, actor, used);
          }
          // A wrong code from the new app undoes the proof's use, so the same proof works next time.
          const step = await matchingStep(waiting.secret, code, null);
          if (step === null) return new Refused(newAppCodeRefused(), 'authenticator');
          await turnOnAuthenticator(db, tables, actor.userId, step, waiting.replacing);
          await audit(
            db,
            waiting.replacing ? 'auth.authenticator.replaced' : 'auth.authenticator.enabled',
            actor,
            used ? { proof: used.method } : {},
          );
          return { recoveryCodes: first ? await recoveryCodesFor(db, tables, actor) : null };
        },
        newAppCodeRefused(),
      );
    },
  );

  app.delete('/api/me/mfa/authenticator', sessionRoute, async (request, reply) => {
    const actor = requireActor(request);
    const { proof } = parse(MfaRemoval, request.body ?? {});
    // Turning the app off always takes a fresh second step, whatever else the person has.
    if (!proof) throw new AppError('forbidden', 'mfa.proof.required');
    const person = await currentPerson(actor);
    const { tables } = mfaStore(ctx);
    await withFreshProof(ctx, request, reply, person, actor.sessionId, proof, async (db, used) => {
      const steps = await secondStepsOf(db, tables, actor.userId);
      const removed = await query(
        db,
        sql`DELETE FROM ${tables.authenticators} WHERE user_id = ${actor.userId} AND confirmed_at IS NOT NULL`,
      );
      if (!removed.rowCount) throw new AppError('not_found', 'errors.notFound');
      if (steps.passkeys === 0) {
        await query(db, sql`DELETE FROM ${tables.recoveryCodes} WHERE user_id = ${actor.userId}`);
        await noSecondStepLeft(db, tables, actor.userId);
      }
      await audit(db, 'auth.authenticator.disabled', actor, used ? { proof: used.method } : {});
    });
    return reply.status(204).send();
  });

  app.post('/api/me/mfa/recovery-codes', sessionRoute, async (request, reply): Promise<RecoveryCodes> => {
    const actor = requireActor(request);
    const { proof } = parse(FreshProof, request.body ?? {});
    const person = await currentPerson(actor);
    const { tables } = mfaStore(ctx);
    const codes = await withFreshProof(
      ctx,
      request,
      reply,
      person,
      actor.sessionId,
      proof,
      async (db, used) => {
        if (!hasSecondStep(await secondStepsOf(db, tables, actor.userId)))
          throw new AppError('conflict', 'mfa.recovery.noSecondStep');
        // Each new code is a way in, so a new set always takes a fresh second step.
        if (!used) throw new AppError('forbidden', 'mfa.proof.required');
        return recoveryCodesFor(db, tables, actor, { proof: used.method });
      },
    );
    return { codes };
  });

  app.post('/api/me/mfa/proof/options', sessionRoute, async (request, reply) => {
    const actor = requireActor(request);
    const { pool, tables } = mfaStore(ctx);
    const passkeys = await passkeysOf(pool, tables, actor.userId);
    if (!passkeys.length) throw new AppError('conflict', 'mfa.passkey.none');
    return requestOptions(ctx, request, reply, passkeys, 'proof', actor.sessionId);
  });
}

async function insertPasskey(
  db: Queryable,
  ctx: AppContext,
  tables: MfaTables,
  userId: string,
  name: string,
  created: NewPasskey,
): Promise<PasskeyRow> {
  const handle = Buffer.from(userHandle(ctx, userId)).toString('base64url');
  const inserted = await query<PasskeyRow>(
    db,
    sql`INSERT INTO ${tables.passkeys}
      (id, user_id, credential_id, public_key, sign_count, transports, user_handle, name, synced)
    VALUES (${newId('passkey')}, ${userId}, ${created.credentialId}, ${created.publicKey}, ${created.signCount},
      ${created.transports}::text[], ${handle}, ${name}, ${created.synced})
    ON CONFLICT (credential_id) DO NOTHING RETURNING *`,
  );
  const passkey = inserted.rows[0];
  if (!passkey) throw new AppError('conflict', 'mfa.passkey.duplicate');
  return passkey;
}

/** A wrong code from the app being turned on, told apart from a wrong proof sent with it. */
function newAppCodeRefused(): AppError {
  return new AppError('forbidden', 'mfa.code.invalid', { fields: { code: 'mfa.code.invalid' } });
}

/** The secret waiting for its first code: a new app's, or the replacement for the one that's on. */
async function awaitingAuthenticator(
  db: Queryable,
  ctx: AppContext,
  tables: MfaTables,
  userId: string,
): Promise<{ secret: string; replacing: boolean }> {
  const found = await query<{
    sealed_secret: string;
    confirmed_at: Date | null;
    replacement_sealed_secret: string | null;
  }>(
    db,
    sql`SELECT sealed_secret, confirmed_at, replacement_sealed_secret FROM ${tables.authenticators}
    WHERE user_id = ${userId} FOR UPDATE`,
  );
  const row = found.rows[0];
  const replacing = Boolean(row?.confirmed_at);
  const sealed = replacing ? row?.replacement_sealed_secret : row?.sealed_secret;
  if (!sealed) throw new AppError('conflict', 'mfa.authenticator.notStarted');
  return { secret: unsealAuthenticatorSecret(ctx.config.secretKey, userId, sealed), replacing };
}

/**
 * Turns on the app whose code matched, which also makes that code's step its first used one.  A
 * replacement takes the place of the app that was on, which stops working at once.
 */
async function turnOnAuthenticator(
  db: Queryable,
  tables: MfaTables,
  userId: string,
  step: number,
  replacing: boolean,
): Promise<void> {
  await query(
    db,
    replacing
      ? sql`UPDATE ${tables.authenticators}
        SET sealed_secret = replacement_sealed_secret, created_at = replacement_created_at,
          replacement_sealed_secret = NULL, replacement_created_at = NULL,
          confirmed_at = clock_timestamp(), last_step = ${step}, last_used_at = clock_timestamp()
        WHERE user_id = ${userId}`
      : sql`UPDATE ${tables.authenticators}
        SET confirmed_at = clock_timestamp(), last_step = ${step}, last_used_at = clock_timestamp()
        WHERE user_id = ${userId}`,
  );
}

/** Turns on a new authenticator app with its first code, for the setup stage of signing in. */
async function confirmAuthenticator(
  db: Queryable,
  ctx: AppContext,
  tables: MfaTables,
  userId: string,
  code: string,
): Promise<boolean> {
  const waiting = await awaitingAuthenticator(db, ctx, tables, userId);
  const step = await matchingStep(waiting.secret, code, null);
  if (step === null) return false;
  await turnOnAuthenticator(db, tables, userId, step, waiting.replacing);
  return true;
}
