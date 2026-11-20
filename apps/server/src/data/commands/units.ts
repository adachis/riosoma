import { refuseDemo } from '../../demo/boundary.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AppError, CommandId } from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { authDatabase } from '../../auth/database.js';
import type { Actor } from '../../http/policy.js';
import { parse } from '../../http/validate.js';
import { updateUnit } from '../../org-units/routes.js';
import { lockUnits, requireUnit, subtreeOf, units, type StoredUnit } from '../../org-units/store.js';
import { AccessScope } from '../access.js';
import { dataStore } from '../context.js';
import { organizationChannel } from '../notify.js';
import { runStored } from './transaction.js';

const Input = z.object({
  id: CommandId,
  parentId: z.string().nullable(),
  name: z.string().trim().min(1).max(120).optional(),
  undoOf: CommandId.optional(),
  preview: z.boolean().optional(),
});
interface Result {
  id: string;
  status: 'applied' | 'duplicate' | 'rejected';
  unitId?: string;
  before?: StoredUnit[];
  guard?: string;
  error?: ReturnType<AppError['toBody']>['error'];
}
const hash = (values: StoredUnit[]) =>
  createHash('sha256')
    .update(JSON.stringify([...values].sort((a, b) => a.id.localeCompare(b.id))))
    .digest('hex');

export async function runUnitMove(app: FastifyInstance, actor: Actor, unitId: string, value: unknown) {
  refuseDemo(actor);
  const input = parse(Input, value);
  const { pool } = dataStore(app.ctx);
  return withTransaction(pool, async (db) => {
    if (input.preview) await query(db, sql`SAVEPOINT unit_move_preview`);
    const result = await runStored<Result>(
      app,
      actor,
      actor.orgId,
      {
        transaction: db,
        commandId: input.id,
        groupId: input.id,
        duplicate: (result) => ({ ...(result as Result), status: 'duplicate' }),
        rejected: (error) => ({ id: input.id, status: 'rejected', error: error.toBody().error }),
      },
      async (c) => {
        await new AccessScope(db, c.schemas, actor).requireOrganization();
        await lockUnits(db, actor.orgId);
        const { app: schema, audit } = authDatabase(app.ctx);
        await requireUnit(db, schema, actor, unitId, 'people', true);
        const before = await units(db, schema, actor.orgId);
        const current = before.find((unit) => unit.id === unitId);
        if (!current) throw new AppError('not_found', 'errors.notFound');
        let parentId = input.parentId;
        let restored: StoredUnit[] | undefined;
        if (input.undoOf) {
          const prior = await query<{ result: Result }>(
            db,
            sql`SELECT result FROM ${ident(c.schemas.app, 'commands')} WHERE id = ${input.undoOf} AND org_id = ${actor.orgId} AND actor_id = ${actor.userId}`,
          );
          const stored = prior.rows[0]?.result;
          if (
            stored?.unitId !== unitId ||
            !stored.before ||
            stored.guard !==
              hash(before.filter((unit) => stored.before!.some((prior) => prior.id === unit.id)))
          )
            throw new AppError('conflict', 'errors.conflict');
          restored = stored.before;
          parentId = restored.find((unit) => unit.id === unitId)?.parentId ?? null;
        }
        await updateUnit(
          db,
          schema,
          audit,
          actor,
          unitId,
          {
            name: restored?.find((unit) => unit.id === unitId)?.name ?? input.name ?? current.name,
            parentId,
          },
          {
            commandId: input.id,
            ...(input.undoOf ? { undoOf: input.undoOf } : {}),
            ...(restored
              ? { restoredLevels: restored.map((unit) => ({ unitId: unit.id, levels: unit.levels })) }
              : {}),
          },
        );
        if (restored)
          for (const unit of restored) {
            await query(
              db,
              sql`UPDATE ${ident(c.schemas.app, 'org_units')} SET policy_levels = ${JSON.stringify(unit.levels)}::jsonb WHERE org_id = ${actor.orgId} AND id = ${unit.id}`,
            );
          }
        const after = await units(db, schema, actor.orgId);
        const changed = before.filter(
          (unit) =>
            unit.id === unitId ||
            JSON.stringify(unit) !== JSON.stringify(after.find((next) => next.id === unit.id)),
        );
        const descendants = [...subtreeOf(before, unitId)];
        // Members see every unit, so one notice reaches them all.  Guests hear only about their own.
        await query(
          db,
          sql`SELECT pg_notify(${organizationChannel(c.schemas)}, notice) FROM (
            SELECT ${JSON.stringify({ orgId: actor.orgId, audience: 'members' })}::text AS notice
            UNION ALL
            SELECT json_build_object('orgId', m.org_id, 'userId', m.user_id)::text
            FROM ${ident(c.schemas.app, 'memberships')} m
            WHERE m.org_id = ${actor.orgId} AND m.kind = 'guest' AND m.org_unit_id = ANY(${descendants}::text[])
          ) notices`,
        );
        return {
          id: input.id,
          status: 'applied',
          unitId,
          before: changed,
          guard: hash(after.filter((unit) => changed.some((prior) => prior.id === unit.id))),
        };
      },
    );
    if (input.preview) {
      await query(db, sql`ROLLBACK TO SAVEPOINT unit_move_preview`);
      await query(db, sql`RELEASE SAVEPOINT unit_move_preview`);
    }
    if (result.error)
      throw new AppError(result.error.code, result.error.messageKey, { params: result.error.params });
    return { id: result.id, status: result.status };
  });
}
