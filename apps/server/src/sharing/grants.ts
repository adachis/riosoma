import type { FastifyInstance } from 'fastify';
import {
  AppError,
  DatabaseId,
  RemoveGrant,
  SetGrant,
  type DatabaseRole,
  type Grant,
  type Principal,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import { z } from 'zod';
import { auditEvent, authDatabase } from '../auth/database.js';
import { requireActor } from '../auth/sessions.js';
import { resourceGrants } from '../data/folders.js';
import { AccessScope } from '../data/access.js';
import { dataStore, type DataSchemas } from '../data/context.js';
import { homeChannel } from '../data/notify.js';
import { relatedDatabaseIds } from '../data/metadata.js';
import { notifyAccess } from '../data/permissions/notify.js';
import { retry } from '../data/commands/transaction.js';
import type { Actor } from '../http/policy.js';
import { parse } from '../http/validate.js';
import { notifyShare } from '../notifications/produce.js';
import { requirePolicy } from '../org-units/policy.js';

const DatabaseParams = z.object({ databaseId: DatabaseId });

const grants = (db: Queryable, schemas: DataSchemas, actor: Actor, databaseId: string) =>
  resourceGrants(db, schemas, actor, 'database', databaseId);

async function changeGrant(
  app: FastifyInstance,
  actor: Actor,
  databaseId: string,
  principal: Principal,
  role: DatabaseRole | null,
): Promise<Grant[]> {
  const { pool, schemas } = dataStore(app.ctx);
  const { audit } = authDatabase(app.ctx);
  return retry(() =>
    withTransaction(pool, async (db) => {
      const tables = await query<{ id: string }>(
        db,
        sql`SELECT id FROM ${ident(schemas.app, 'tables')}
        WHERE database_id = ${databaseId} AND org_id = ${actor.orgId}`,
      );
      const affected = await relatedDatabaseIds(
        db,
        schemas,
        tables.rows.map((row) => row.id),
      );
      // Access notices update linked databases too, so lock every affected row in the same order.
      // Check access afterward so a waiting request cannot act on a revoked owner grant.
      const locked = await query<{ id: string }>(
        db,
        sql`SELECT id FROM ${ident(schemas.app, 'databases')}
        WHERE id = ANY(${[databaseId, ...affected]}::text[])
          AND org_id = ${actor.orgId} AND trashed_at IS NULL ORDER BY id FOR UPDATE`,
      );
      if (!locked.rows.some((row) => row.id === databaseId))
        throw new AppError('not_found', 'errors.notFound');
      await new AccessScope(db, schemas, actor).require(databaseId, 'manage');
      const principalId = principal.kind !== 'org' ? principal.id : actor.orgId;
      if (principal.kind === 'user') {
        const member = await query<{ kind: string }>(
          db,
          sql`SELECT user_id, kind FROM ${ident(schemas.app, 'memberships')}
        WHERE org_id = ${actor.orgId} AND user_id = ${principal.id}`,
        );
        if (!member.rowCount) throw new AppError('not_found', 'errors.notFound');
        // Sharing with a guest is sharing outside the organization, which a unit may turn off.
        if (role && member.rows[0]?.kind === 'guest') {
          await requirePolicy(db, `"${schemas.app}"`, actor, 'externalSharing');
          await new AccessScope(db, schemas, actor).requireUse(databaseId, 'guestSharing');
        }
      } else if (principal.kind === 'group') {
        const group = await query(
          db,
          sql`SELECT id FROM ${ident(schemas.app, 'groups')}
        WHERE org_id = ${actor.orgId} AND id = ${principal.id}`,
        );
        if (!group.rowCount) throw new AppError('not_found', 'errors.notFound');
      } else if (role === 'owner') {
        throw new AppError('validation_failed', 'data.share.orgOwner');
      }
      const target = sql`org_id = ${actor.orgId} AND resource_kind = 'database' AND resource_id = ${databaseId}
      AND principal_kind = ${principal.kind} AND principal_id = ${principalId}`;
      const current = await query<{ role: DatabaseRole }>(
        db,
        sql`
      SELECT role FROM ${ident(schemas.app, 'grants')} WHERE ${target}`,
      );
      const previousRole = current.rows[0]?.role;
      if (principal.kind === 'user' && previousRole === 'owner' && role !== 'owner') {
        const otherOwners = await query(
          db,
          sql`SELECT g.principal_id FROM ${ident(schemas.app, 'grants')} g
        JOIN ${ident(schemas.app, 'memberships')} m ON m.user_id = g.principal_id AND m.org_id = g.org_id
        WHERE g.org_id = ${actor.orgId} AND g.resource_kind = 'database' AND g.resource_id = ${databaseId}
          AND g.principal_kind = 'user' AND g.role = 'owner' AND g.principal_id <> ${principalId} LIMIT 1`,
        );
        if (!otherOwners.rowCount) throw new AppError('conflict', 'data.share.lastOwner');
      }
      if (role) {
        await query(
          db,
          sql`INSERT INTO ${ident(schemas.app, 'grants')}
        (org_id, resource_kind, resource_id, principal_kind, principal_id, role, created_by)
        VALUES (${actor.orgId}, 'database', ${databaseId}, ${principal.kind}, ${principalId}, ${role}, ${actor.userId})
        ON CONFLICT (resource_kind, resource_id, principal_kind, principal_id) DO UPDATE SET role = EXCLUDED.role`,
        );
        await auditEvent(db, audit, 'data.grant.set', actor, { databaseId, principal, role });
        // Someone given a database of their own hears about it.  A new role for someone who had one doesn't.
        if (principal.kind === 'user' && !previousRole && principal.id !== actor.userId)
          await notifyShare(db, schemas, {
            orgId: actor.orgId,
            actorId: actor.userId,
            recipientId: principal.id,
            databaseId,
            role,
          });
      } else if (previousRole) {
        await query(db, sql`DELETE FROM ${ident(schemas.app, 'grants')} WHERE ${target}`);
        await auditEvent(db, audit, 'data.grant.removed', actor, {
          databaseId,
          principal,
          role: previousRole,
        });
      }
      // Sent on commit, so people who just lost access stop receiving the database's changes.
      if (role !== (previousRole ?? null)) {
        await notifyAccess(db, schemas, actor, databaseId, false);
        await query(db, sql`SELECT pg_notify(${homeChannel(schemas)}, ${actor.orgId})`);
      }
      return grants(db, schemas, actor, databaseId);
    }),
  );
}

export async function grantRoutes(app: FastifyInstance): Promise<void> {
  const session = { config: { policy: { kind: 'session' as const } } };
  app.get('/api/databases/:databaseId/grants', session, async (request) => {
    const actor = requireActor(request);
    const { databaseId } = parse(DatabaseParams, request.params);
    const { pool, schemas } = dataStore(app.ctx);
    return withTransaction(pool, async (db) => {
      await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      await new AccessScope(db, schemas, actor).require(databaseId, 'read');
      return grants(db, schemas, actor, databaseId);
    });
  });
  app.put('/api/databases/:databaseId/grants', session, async (request) => {
    const { databaseId } = parse(DatabaseParams, request.params);
    const input = parse(SetGrant, request.body);
    return changeGrant(app, requireActor(request), databaseId, input.principal, input.role);
  });
  app.delete('/api/databases/:databaseId/grants', session, async (request) => {
    const { databaseId } = parse(DatabaseParams, request.params);
    const input = parse(RemoveGrant, request.body);
    return changeGrant(app, requireActor(request), databaseId, input.principal, null);
  });
}
