import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { z } from 'zod';
import { AppError, type SecondStepMethod, type SecondStepProof } from '@riosoma/contracts';
import { query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { AppContext } from '../../app.js';
import type { Actor } from '../../http/policy.js';
import { attemptKey, EMAIL_LIMIT, IP_LIMIT, pruneAttempts, recordAttempts, retryAfter } from '../attempts.js';
import { auditEvent, authDatabase, lockKeys } from '../database.js';
import { findIdentity, type Identity } from '../sessions.js';
import { matchingStep, unsealAuthenticatorSecret, useRecoveryCode } from './codes.js';
import {
  hasSecondStep,
  mfaStore,
  secondStepsOf,
  userLock,
  type MfaTables,
  type PasskeyRow,
} from './store.js';
import { relyingParty, takeChallenge, verifyPasskeyAnswer, type RelyingParty } from './webauthn.js';

/** A proof as the server sees it, after the contract has tidied what was typed. */
export type Proof = z.output<typeof SecondStepProof>;

export interface Person {
  userId: string;
  orgId: string;
  email: string;
}

/** A failed check with an answer of its own, for a request that makes more than one check. */
export class Refused {
  constructor(
    readonly error: AppError,
    readonly method: SecondStepMethod,
  ) {}
}

/**
 * Checks something only the person has, inside the sign-in attempt limits.  While the person or
 * the address is locked out, the answer is 429 before anything is checked.  A failed check counts
 * against both, as a wrong password does, and commits even though the request fails, while
 * everything `work` changed before it failed is undone.  `work` answers null (or a `Refused`) for
 * a failed check, and throws only for a request that was never a real attempt.
 */
export async function withinLimits<T>(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  person: Person,
  method: SecondStepMethod,
  work: (db: pg.PoolClient) => Promise<T | Refused | null>,
  failure: AppError,
): Promise<T> {
  const { pool, app: schema, audit } = authDatabase(ctx);
  const emailKey = attemptKey('email', person.email.toLowerCase());
  const ipKey = attemptKey('ip', request.ip);
  const outcome = await withTransaction(pool, async (db) => {
    await lockKeys(db, [emailKey, ipKey]);
    await pruneAttempts(db, schema);
    const retryAfterSeconds = Math.max(
      await retryAfter(db, schema, emailKey, EMAIL_LIMIT.attempts, EMAIL_LIMIT.windowSeconds),
      await retryAfter(db, schema, ipKey, IP_LIMIT.attempts, IP_LIMIT.windowSeconds),
    );
    if (retryAfterSeconds) {
      await auditEvent(db, audit, 'auth.second_step.failed', person, {
        reason: 'locked',
        method,
        ip: request.ip,
      });
      return new AppError('rate_limited', 'mfa.locked', { params: { retryAfterSeconds } });
    }
    // A proof used up before a later check failed must still work next time.
    await query(db, sql`SAVEPOINT second_step`);
    const value = await work(db);
    if (value === null || value instanceof Refused) {
      await query(db, sql`ROLLBACK TO SAVEPOINT second_step`);
      const refused = value instanceof Refused ? value : new Refused(failure, method);
      await recordAttempts(db, schema, [emailKey, ipKey]);
      await auditEvent(db, audit, 'auth.second_step.failed', person, {
        reason: 'invalid',
        method: refused.method,
        ip: request.ip,
      });
      // Returned rather than thrown, so the failed attempt commits.
      return refused.error;
    }
    await query(db, sql`RELEASE SAVEPOINT second_step`);
    return { value };
  });
  if (outcome instanceof AppError) {
    if (outcome.code === 'rate_limited') reply.header('retry-after', outcome.params!.retryAfterSeconds);
    throw outcome;
  }
  return outcome.value;
}

/** Uses up a code from someone's confirmed authenticator app: its time step works once. */
export async function useAuthenticatorCode(
  db: Queryable,
  ctx: AppContext,
  tables: MfaTables,
  userId: string,
  code: string,
): Promise<boolean> {
  const found = await query<{ sealed_secret: string; last_step: string | null }>(
    db,
    sql`SELECT sealed_secret, last_step FROM ${tables.authenticators}
    WHERE user_id = ${userId} AND confirmed_at IS NOT NULL FOR UPDATE`,
  );
  const row = found.rows[0];
  if (!row) return false;
  const secret = unsealAuthenticatorSecret(ctx.config.secretKey, userId, row.sealed_secret);
  const step = await matchingStep(secret, code, row.last_step === null ? null : Number(row.last_step));
  if (step === null) return false;
  await query(
    db,
    sql`UPDATE ${tables.authenticators} SET last_step = ${step}, last_used_at = clock_timestamp()
    WHERE user_id = ${userId}`,
  );
  return true;
}

/**
 * Checks a passkey's answer and records its new signature counter.  With a user ID, only that
 * person's passkeys count.  Answers the passkey, or null.
 */
export async function usePasskey(
  db: Queryable,
  tables: MfaTables,
  rp: RelyingParty,
  answer: Extract<Proof, { method: 'passkey' }>['response'],
  challenge: string,
  userId: string | null,
): Promise<PasskeyRow | null> {
  const found = await query<PasskeyRow>(
    db,
    sql`SELECT * FROM ${tables.passkeys} WHERE credential_id = ${answer.id}
    AND (${userId}::text IS NULL OR user_id = ${userId}) FOR UPDATE`,
  );
  const passkey = found.rows[0];
  if (!passkey) return null;
  const verified = await verifyPasskeyAnswer(rp, answer, challenge, passkey);
  if (!verified) return null;
  await query(
    db,
    sql`UPDATE ${tables.passkeys}
    SET sign_count = ${verified.signCount}, synced = ${verified.synced}, last_used_at = clock_timestamp()
    WHERE id = ${passkey.id}`,
  );
  return passkey;
}

export interface ProofUsed {
  method: SecondStepMethod;
  passkeyId?: string;
}

/**
 * Checks a proof against someone's own second steps and uses it up.  A passkey's challenge has to
 * be taken from the browser beforehand.  Null when it doesn't hold.
 */
export async function useProof(
  db: Queryable,
  ctx: AppContext,
  tables: MfaTables,
  userId: string,
  proof: Proof,
  challenge: string | null,
): Promise<ProofUsed | null> {
  if (proof.method === 'authenticator')
    return (await useAuthenticatorCode(db, ctx, tables, userId, proof.code))
      ? { method: 'authenticator' }
      : null;
  if (proof.method === 'recovery')
    return (await useRecoveryCode(db, tables, userId, proof.code)) ? { method: 'recovery' } : null;
  const rp = relyingParty(ctx);
  if (!rp || challenge === null) return null;
  const passkey = await usePasskey(db, tables, rp, proof.response, challenge, userId);
  return passkey ? { method: 'passkey', passkeyId: passkey.id } : null;
}

/** The signed-in person behind a session, with the email the attempt limits count against. */
export async function sessionPerson(ctx: AppContext, actor: Actor): Promise<Identity> {
  const { pool, app: schema } = authDatabase(ctx);
  const identity = await findIdentity(pool, schema, actor.userId);
  if (!identity) throw new AppError('unauthenticated', 'errors.signInRequired');
  return identity;
}

/**
 * A refused proof.  From a session it's 403 rather than 401, so the app doesn't take it for a
 * session that ended.
 */
export function refusal(proof: Proof, signingIn: boolean): AppError {
  if (signingIn)
    return proof.method === 'passkey'
      ? new AppError('unauthenticated', 'mfa.passkey.failed')
      : new AppError('unauthenticated', 'mfa.code.invalid');
  return proof.method === 'passkey'
    ? new AppError('forbidden', 'mfa.passkey.failed')
    : new AppError('forbidden', 'mfa.code.invalid');
}

/** What a used proof leaves in the audit log: for a recovery code, how many remain. */
export async function noteProof(
  db: Queryable,
  ctx: AppContext,
  tables: MfaTables,
  who: { userId: string; orgId: string },
  used: ProofUsed,
): Promise<void> {
  if (used.method !== 'recovery') return;
  const steps = await secondStepsOf(db, tables, who.userId);
  await auditEvent(db, authDatabase(ctx).audit, 'auth.recovery_code.used', who, {
    remaining: steps.recoveryCodes,
  });
}

/**
 * Makes a change for a signed-in person under the lock on their second steps.  A proof, when one
 * came, is checked and used up in the change's own transaction, inside the attempt limits, and a
 * refused one undoes everything but the count of the failure.  The change hears which proof was
 * used, or null, and decides whether it needed one.
 */
export async function withFreshProof<T>(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  person: Person,
  sessionId: string,
  proof: Proof | undefined,
  change: (db: pg.PoolClient, used: ProofUsed | null) => Promise<T>,
): Promise<T> {
  const { pool, tables } = mfaStore(ctx);
  if (!proof)
    return withTransaction(pool, async (db) => {
      await lockKeys(db, [userLock(person.userId)]);
      return change(db, null);
    });
  const challenge =
    proof.method === 'passkey' ? await takeChallenge(ctx, request, reply, 'proof', sessionId) : null;
  const done = await withinLimits(
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
      return { result: await change(db, used) };
    },
    refusal(proof, false),
  );
  return done.result;
}

/**
 * Makes a change that adds a way into someone's account, like a new passkey or a personal access
 * token.  Once they have a second step, a fresh one has to come with the change, or nothing
 * changes.  Someone without one makes the change as before.  The change hears which proof was
 * used, and whether the person had no second step yet.
 */
export async function addWayIn<T>(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  person: Person,
  sessionId: string,
  proof: Proof | undefined,
  change: (db: pg.PoolClient, used: ProofUsed | null, first: boolean) => Promise<T>,
): Promise<T> {
  return withFreshProof(ctx, request, reply, person, sessionId, proof, async (db, used) => {
    const first = !hasSecondStep(await secondStepsOf(db, mfaStore(ctx).tables, person.userId));
    // A new way in takes a fresh second step from anyone who already has one.
    if (!first && !used) throw new AppError('forbidden', 'mfa.proof.required');
    return change(db, used, first);
  });
}
