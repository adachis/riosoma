import { effectivePolicy } from '../org-units/policy.js';
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  levelsFor,
  OrgLevelsUpdate,
  reaches,
  type Level,
  type MemberKind,
  type OrgSettings,
} from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import { parse } from '../http/validate.js';
import { auditEvent, authDatabase, type Queryable } from './database.js';
import { requireActor } from './sessions.js';

/** An organization's settings, or nothing when it doesn't exist. */
export async function orgSettings(
  db: Queryable,
  schema: string,
  orgId: string,
  lock = false,
): Promise<OrgSettings | null> {
  const result = await db.query<{ settings: OrgSettings | null }>(
    `SELECT settings FROM ${schema}.orgs WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [orgId],
  );
  const row = result.rows[0];
  return row ? (row.settings ?? {}) : null;
}

/**
 * The level a person may keep: their choice, lowered to the highest the organization allows
 * someone of their kind.  Only guests have a limit.
 */
export async function allowedLevel(
  db: Queryable,
  schema: string,
  orgId: string,
  kind: MemberKind,
  level: Level,
  userId?: string,
): Promise<Level> {
  const settings = userId
    ? (await effectivePolicy(db, schema, orgId, { userId })).values
    : ((await orgSettings(db, schema, orgId)) ?? {});
  return levelsFor(kind, settings, level).level;
}

/**
 * Refuses a guest's choice of a level above the one the organization allows guests.  Levels only
 * tidy the interface, so this keeps the choice honest rather than guarding any data.
 */
export async function checkLevelChoice(
  db: Queryable,
  schema: string,
  actor: { orgId: string; userId: string; kind: MemberKind },
  level: Level | undefined,
): Promise<void> {
  if (level === undefined || actor.kind !== 'guest') return;
  const policy = await effectivePolicy(db, schema, actor.orgId, actor);
  const allowed = levelsFor(actor.kind, policy.values, level).level;
  if (!reaches(allowed, level)) throw new AppError('forbidden', 'levels.aboveGuestLimit');
}

/**
 * Owners and admins with the People role choose where members start and how far up guests can
 * go.  Both live in the organization's settings, which every session already carries, so the
 * app applies a change the next time each person's session is read.
 */
export async function levelRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const people = {
    config: { policy: { kind: 'admin' as const, area: 'people' as const, scope: 'organization' as const } },
  };

  app.put('/api/admin/levels', people, async (request): Promise<OrgSettings> => {
    const actor = requireActor(request);
    const input = parse(OrgLevelsUpdate, request.body);
    const { pool, app: schema, audit } = authDatabase(ctx);
    return withTransaction(pool, async (db) => {
      const before = await orgSettings(db, schema, actor.orgId, true);
      if (!before) throw new AppError('not_found', 'errors.notFound');
      const result = await db.query<{ settings: OrgSettings }>(
        `UPDATE ${schema}.orgs SET settings = settings || $2::jsonb
         WHERE id = $1 RETURNING settings`,
        [actor.orgId, JSON.stringify(input)],
      );
      if (before.defaultLevel !== input.defaultLevel || before.guestLevel !== input.guestLevel)
        await auditEvent(db, audit, 'org.levels.updated', actor, {
          from: { defaultLevel: before.defaultLevel ?? null, guestLevel: before.guestLevel ?? null },
          to: input,
        });
      // The organization's unit policy is for its admins, who read it from its own screen.
      const { unitPolicy: _unitPolicy, ...settings } = result.rows[0]!.settings;
      return settings;
    });
  });
}
