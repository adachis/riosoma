import { lockUnits, requirePerson } from '../../org-units/store.js';
import type { FastifyInstance } from 'fastify';
import { AppError, MfaPolicyUpdate, type MfaPolicy, type SecondStepPolicy } from '@riosoma/contracts';
import { query, sql, withTransaction } from '@riosoma/db';
import { z } from 'zod';
import { parse } from '../../http/validate.js';
import { auditEvent, authDatabase, lockKeys } from '../database.js';
import { requireActor } from '../sessions.js';
import { mfaStore, orgPolicy, userLock } from './store.js';

const PersonParams = z.object({ userId: z.string().min(1).max(100) });

/**
 * Owners and admins with the Security role choose who must use a second step, and can clear a
 * person's second steps when they've lost them, which also signs that person out everywhere.
 * Nothing here ever shows a passkey, a secret, or a code: an admin can take second steps away,
 * never read them.
 */
export async function mfaAdminRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const security = {
    config: { policy: { kind: 'admin' as const, area: 'security' as const, scope: 'organization' as const } },
  };

  app.get('/api/admin/mfa/policy', security, async (request): Promise<MfaPolicy> => {
    const actor = requireActor(request);
    const { pool, tables } = mfaStore(ctx);
    return { policy: await orgPolicy(pool, tables, actor.orgId) };
  });

  app.put('/api/admin/mfa/policy', security, async (request): Promise<MfaPolicy> => {
    const actor = requireActor(request);
    const { policy } = parse(MfaPolicyUpdate, request.body);
    const { pool, tables } = mfaStore(ctx);
    const { audit } = authDatabase(ctx);
    return withTransaction(pool, async (db) => {
      const found = await query<{ policy: SecondStepPolicy }>(
        db,
        sql`SELECT second_step_policy AS policy FROM ${tables.orgs} WHERE id = ${actor.orgId} FOR UPDATE`,
      );
      const before = found.rows[0]?.policy;
      if (!before) throw new AppError('not_found', 'errors.notFound');
      if (before !== policy) {
        await query(
          db,
          sql`UPDATE ${tables.orgs} SET second_step_policy = ${policy} WHERE id = ${actor.orgId}`,
        );
        await auditEvent(db, audit, 'org.second_step.policy_updated', actor, { from: before, to: policy });
      }
      return { policy };
    });
  });

  app.delete(
    '/api/admin/mfa/people/:userId',
    { config: { policy: { kind: 'admin', area: 'security', scope: 'person' } } },
    async (request, reply) => {
      const actor = requireActor(request);
      const { userId } = parse(PersonParams, request.params);
      // Your own go through Sign-in and security, which asks for a fresh second step first.
      if (userId === actor.userId) throw new AppError('forbidden', 'mfa.reset.self');
      const { pool, tables } = mfaStore(ctx);
      const { audit } = authDatabase(ctx);
      await withTransaction(pool, async (db) => {
        // A unit admin's reach is checked again once placements can't move.
        await lockUnits(db, actor.orgId);
        actor.auditUnitId = await requirePerson(db, authDatabase(ctx).app, actor, userId, 'security');
        const member = await query<{ kind: string }>(
          db,
          sql`SELECT kind FROM ${tables.memberships} WHERE org_id = ${actor.orgId} AND user_id = ${userId}`,
        );
        const kind = member.rows[0]?.kind;
        if (!kind) throw new AppError('not_found', 'errors.notFound');
        if (kind === 'owner' && actor.kind !== 'owner') throw new AppError('forbidden', 'mfa.reset.owner');
        await lockKeys(db, [userLock(userId)]);
        const passkeys = await query(db, sql`DELETE FROM ${tables.passkeys} WHERE user_id = ${userId}`);
        const authenticator = await query(
          db,
          sql`DELETE FROM ${tables.authenticators} WHERE user_id = ${userId} AND confirmed_at IS NOT NULL`,
        );
        await query(db, sql`DELETE FROM ${tables.authenticators} WHERE user_id = ${userId}`);
        await query(db, sql`DELETE FROM ${tables.recoveryCodes} WHERE user_id = ${userId}`);
        // Whoever holds one of their sessions may be why their second steps are being reset, so every
        // session ends and they sign in again.  Admins can't reset themselves, so none of these is the
        // admin's own.
        const sessions = await query(
          db,
          sql`UPDATE ${tables.sessions} SET revoked_at = clock_timestamp()
        WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > clock_timestamp()`,
        );
        await auditEvent(db, audit, 'org.second_step.reset', actor, {
          userId,
          passkeys: passkeys.rowCount ?? 0,
          authenticator: Boolean(authenticator.rowCount),
          sessionsEnded: sessions.rowCount ?? 0,
        });
      });
      return reply.status(204).send();
    },
  );
}
