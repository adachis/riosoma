import { AppError, type TransferOwnership } from '@riosoma/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { AppContext } from '../app.js';
import type { Actor } from '../http/policy.js';
import { withFreshProof, sessionPerson } from './mfa/proof.js';
import { auditEvent, authDatabase, lockKeys, withSignInTransaction } from './database.js';
import { attemptKey, EMAIL_LIMIT, IP_LIMIT, pruneAttempts, recordAttempts, retryAfter } from './attempts.js';
import { dataStore } from '../data/context.js';
import { profilePassword } from '../data/people.js';
import { verifyPassword } from './passwords.js';

/** Fresh proof and the transfer commit together, so a replay cannot spend proof on two transfers. */
export async function withOwnershipProof<T>(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  actor: Actor,
  input: TransferOwnership,
  work: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const person = await sessionPerson(ctx, actor);
  if (input.proof)
    return withFreshProof(ctx, request, reply, person, actor.sessionId, input.proof, async (db, used) => {
      if (!used) throw new AppError('forbidden', 'people.guard.reauthenticate');
      return work(db);
    });
  if (!input.password) throw new AppError('forbidden', 'people.guard.reauthenticate');
  const { pool, app, audit } = authDatabase(ctx);
  const keys = [attemptKey('email', person.email.toLowerCase()), attemptKey('ip', request.ip)];
  const result = await withSignInTransaction(pool, async (db) => {
    await lockKeys(db, keys);
    await pruneAttempts(db, app);
    const seconds = Math.max(
      await retryAfter(db, app, keys[0]!, EMAIL_LIMIT.attempts, EMAIL_LIMIT.windowSeconds),
      await retryAfter(db, app, keys[1]!, IP_LIMIT.attempts, IP_LIMIT.windowSeconds),
    );
    if (seconds)
      return new AppError('rate_limited', 'auth.signIn.locked', { params: { retryAfterSeconds: seconds } });
    const hash = await profilePassword({ db, schemas: dataStore(ctx).schemas, actor });
    if (!(await verifyPassword(input.password!, hash))) {
      await recordAttempts(db, app, keys);
      await auditEvent(db, audit, 'people.transfer.proof.failed', actor);
      return new AppError('forbidden', 'people.guard.reauthenticate');
    }
    return { value: await work(db) };
  });
  if (result instanceof AppError) {
    if (result.code === 'rate_limited') reply.header('retry-after', result.params!.retryAfterSeconds);
    throw result;
  }
  return result.value;
}
