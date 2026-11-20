import {
  AppError,
  DatabaseId,
  RoutineApprovalId,
  RoutineApprove,
  RoutineChange,
  RoutineDraftRequest,
  RoutineId,
  RoutineInput,
  RoutineSitesRequest,
  RoutineUpdate,
  ROUTINE_LIMITS,
  ROUTINE_PAGE_FIELD_TYPES,
  siteOrigin,
  newId,
  type AdminRoutine,
  type Routine,
  type RoutinePlan,
  type RoutineRun,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { settingsFor } from '../ai/settings.js';
import { databaseSchema } from '../ai/tools.js';
import { auditEvent, authDatabase } from '../auth/database.js';
import { requireActor } from '../auth/sessions.js';
import { dataStore } from '../data/context.js';
import { AccessScope } from '../data/access.js';
import { loadFields, loadTable } from '../data/metadata.js';
import type { Actor } from '../http/policy.js';
import { parse } from '../http/validate.js';
import { approve, change, loadApproval, skipApproval, stillOpens } from './approvals.js';
import { draftRoutine } from './draft.js';
import { nextRunAfter } from './schedule.js';
import {
  adminRoutines,
  listRoutines,
  loadRoutine,
  ownRoutine,
  PAUSED,
  routineView,
  runsOf,
  tables,
  toRun,
} from './store.js';

/** The most routines one person may keep */
export const ROUTINES_PER_PERSON = 50;

/** Refuses unless AI and routines are on for the person, and answers their settings. */
async function available(app: FastifyInstance, actor: Actor) {
  const settings = await settingsFor(app.ctx, actor.orgId, actor);
  if (!settings.enabled) throw new AppError('unavailable', 'rio.disabled');
  if (!settings.routines) throw new AppError('unavailable', 'routines.off');
  return settings;
}

/**
 * A plan whose tables are all in the database, and whose site sources are fields the person saving
 * it can see, of a type that holds an address.
 */
async function checkPlan(app: FastifyInstance, actor: Actor, databaseId: string, plan: RoutinePlan) {
  const schema = await databaseSchema(app, actor, databaseId);
  const ids = new Set(schema.tables.map((table) => table.id));
  if (
    [...plan.reads, ...plan.writes, ...plan.fetches.map((fetch) => fetch.tableId)].some((id) => !ids.has(id))
  )
    throw new AppError('validation_failed', 'routines.plan.unknownTable');
  if (!plan.fetches.length) return;
  const { pool, schemas } = dataStore(app.ctx);
  const stored = new Map(
    (await loadFields(pool, schemas, [...new Set(plan.fetches.map((fetch) => fetch.tableId))])).map(
      (field) => [field.id, field],
    ),
  );
  for (const fetch of plan.fetches) {
    const seen = schema.tables
      .find((table) => table.id === fetch.tableId)
      ?.fields.find((field) => field.id === fetch.fieldId);
    const field = stored.get(fetch.fieldId);
    if (!seen || !field || !(ROUTINE_PAGE_FIELD_TYPES as readonly string[]).includes(field.type))
      throw new AppError('validation_failed', 'routines.plan.pageField');
  }
}

/** Refuses anything that would start a run of a paused routine, or act for it. */
function checkRunning(routine: { paused: boolean }) {
  if (routine.paused) throw new AppError('conflict', 'routines.paused.refused');
}

/**
 * The sites the fields a plan reads sites from name now, as the person asking sees them: each
 * distinct value that names a site, as its origin, from at most a few thousand records a field.
 */
async function sitesIn(
  app: FastifyInstance,
  actor: Actor,
  databaseId: string,
  fetches: ReadonlyArray<{ tableId: string; fieldId: string }>,
): Promise<string[]> {
  const { pool, schemas } = dataStore(app.ctx);
  const scope = new AccessScope(pool, schemas, actor);
  await scope.require(databaseId, 'read');
  const sites = new Set<string>();
  for (const fetch of fetches) {
    const table = await loadTable(pool, schemas, fetch.tableId);
    if (!table || table.trashed || table.databaseId !== databaseId) continue;
    const [field] = scope.visibleFields(
      table.id,
      (await loadFields(pool, schemas, [table.id])).filter((item) => item.id === fetch.fieldId),
    );
    if (!field || !(ROUTINE_PAGE_FIELD_TYPES as readonly string[]).includes(field.type)) continue;
    const values = await query<{ value: unknown }>(
      pool,
      sql`SELECT DISTINCT ${ident(field.columnName)} AS value FROM ${ident(schemas.data, table.id)}
      WHERE __deleted_at IS NULL AND (${scope.recordPredicate(table.id)}) LIMIT 5000`,
    );
    for (const { value } of values.rows) {
      const site = typeof value === 'string' ? siteOrigin(value) : null;
      if (site) sites.add(site);
    }
  }
  return [...sites].sort().slice(0, ROUTINE_LIMITS.sites);
}

/** An admin's hold on one of the owner's routines in a database, which their others there take on */
async function adminHold(
  db: Queryable,
  t: ReturnType<typeof tables>,
  actor: Actor,
  databaseId: string,
): Promise<{ admin_paused_by: string | null } | null> {
  const held = await query<{ admin_paused_by: string | null }>(
    db,
    sql`SELECT admin_paused_by FROM ${t.routines} WHERE org_id = ${actor.orgId} AND owner_id = ${actor.userId}
      AND database_id = ${databaseId} AND admin_paused_at IS NOT NULL LIMIT 1`,
  );
  return held.rows[0] ?? null;
}

function checkCap(cap: number, limit: number) {
  if (cap > limit + 1e-9)
    throw new AppError('validation_failed', 'routines.cap.aboveLimit', { params: { limit } });
}

export async function routineRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const session = { config: { policy: { kind: 'session' } } } as const;
  const admin = { config: { policy: { kind: 'admin', area: 'ai', scope: 'organization' } } } as const;
  const routineParams = z.object({ routineId: RoutineId });
  const approvalParams = z.object({ approvalId: RoutineApprovalId });
  const worker = () => {
    if (!ctx.routines) throw new AppError('unavailable', 'routines.off');
    return ctx.routines;
  };

  app.get('/api/rio/routines', session, async (request): Promise<Routine[]> => {
    const actor = requireActor(request);
    const { databaseId } = parse(z.object({ databaseId: DatabaseId.optional() }), request.query);
    const { pool, schemas } = dataStore(ctx);
    return listRoutines(
      pool,
      schemas,
      sql`r.org_id = ${actor.orgId} AND r.owner_id = ${actor.userId}${
        databaseId ? sql` AND r.database_id = ${databaseId}` : sql``
      }`,
      actor,
    );
  });

  app.post('/api/rio/routines/draft', session, async (request) => {
    const actor = requireActor(request);
    return draftRoutine(app, actor, parse(RoutineDraftRequest, request.body));
  });

  app.post('/api/rio/routines/sites', session, async (request): Promise<{ sites: string[] }> => {
    const actor = requireActor(request);
    const input = parse(RoutineSitesRequest, request.body);
    return { sites: await sitesIn(app, actor, input.databaseId, input.fetches) };
  });

  app.post('/api/rio/routines', session, async (request): Promise<Routine> => {
    const actor = requireActor(request);
    const input = parse(RoutineInput, request.body);
    const settings = await available(app, actor);
    await checkPlan(app, actor, input.databaseId, input.plan);
    checkCap(input.costCapUsd, settings.routineRunLimitUsd);
    const { pool, schemas } = dataStore(ctx);
    const { audit } = authDatabase(ctx);
    const t = tables(schemas);
    const id = newId('routine');
    await withTransaction(pool, async (db) => {
      const count = await query<{ count: string }>(
        db,
        sql`SELECT count(*) AS count FROM ${t.routines} WHERE org_id = ${actor.orgId} AND owner_id = ${actor.userId}`,
      );
      if (Number(count.rows[0]!.count) >= ROUTINES_PER_PERSON)
        throw new AppError('validation_failed', 'routines.tooMany', {
          params: { limit: ROUTINES_PER_PERSON },
        });
      // While an admin holds one of the owner's routines in this database, a new one starts held too,
      // so deleting and saving again can't step around the pause.
      const hold = await adminHold(db, t, actor, input.databaseId);
      await query(
        db,
        sql`INSERT INTO ${t.routines} (id, org_id, database_id, owner_id, name, instructions, plan, schedule,
          time_zone, locale, cost_cap_usd, approved_recipients, approved_hosts, next_run_at,
          admin_paused_at, admin_paused_by)
        VALUES (${id}, ${actor.orgId}, ${input.databaseId}, ${actor.userId}, ${input.name}, ${input.instructions},
          ${JSON.stringify(input.plan)}::jsonb, ${JSON.stringify(input.schedule)}::jsonb, ${input.timeZone},
          ${input.locale}, ${input.costCapUsd}, ${JSON.stringify(input.approvedRecipients)}::jsonb,
          ${JSON.stringify(input.approvedSites)}::jsonb, ${nextRunAfter(input.schedule, input.timeZone, new Date())},
          ${hold ? new Date() : null}, ${hold?.admin_paused_by ?? null})`,
      );
      await auditEvent(db, audit, 'rio.routine.created', actor, {
        routineId: id,
        databaseId: input.databaseId,
        schedule: input.schedule,
        costCapUsd: input.costCapUsd,
        approvedLists: input.approvedRecipients.length,
        approvedSites: input.approvedSites,
        ...(hold ? { heldByAdmin: true } : {}),
      });
    });
    return routineView(pool, schemas, (await loadRoutine(pool, schemas, actor.orgId, id))!, actor);
  });

  app.get('/api/rio/routines/:routineId', session, async (request): Promise<Routine> => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    const routine = await ownRoutine(pool, schemas, actor, parse(routineParams, request.params).routineId);
    return routineView(pool, schemas, routine, actor);
  });

  app.patch('/api/rio/routines/:routineId', session, async (request): Promise<Routine> => {
    const actor = requireActor(request);
    const { routineId } = parse(routineParams, request.params);
    const supplied = parse(z.record(z.string(), z.unknown()), request.body);
    // Defaults in the schema must not replace what a partial update leaves out, such as the lists
    // of approved recipients and sites.
    const update = Object.fromEntries(
      Object.entries(parse(RoutineUpdate, supplied)).filter(([key]) => Object.hasOwn(supplied, key)),
    ) as z.output<typeof RoutineUpdate>;
    const settings = await available(app, actor);
    const { pool, schemas } = dataStore(ctx);
    const { audit } = authDatabase(ctx);
    const t = tables(schemas);
    const current = await ownRoutine(pool, schemas, actor, routineId);
    if (update.plan) await checkPlan(app, actor, current.databaseId, update.plan);
    if (update.costCapUsd !== undefined) checkCap(update.costCapUsd, settings.routineRunLimitUsd);
    await withTransaction(pool, async (db) => {
      const routine = await ownRoutine(db, schemas, actor, routineId, 'update');
      // Giving a routine new words, a new plan, recipients, or sites while an admin holds one of the
      // owner's routines in its database puts it under the hold too, so the held routine can't be
      // moved into another one and run from there.
      const reshaped =
        update.instructions !== undefined ||
        update.plan !== undefined ||
        update.approvedRecipients !== undefined ||
        update.approvedSites !== undefined;
      const hold =
        reshaped && !routine.adminPaused ? await adminHold(db, t, actor, routine.databaseId) : null;
      const schedule = update.schedule ?? routine.schedule;
      const timeZone = update.timeZone ?? routine.timeZone;
      const moved = update.schedule !== undefined || update.timeZone !== undefined;
      await query(
        db,
        sql`UPDATE ${t.routines} SET
          name = ${update.name ?? routine.name},
          instructions = ${update.instructions ?? routine.instructions},
          plan = ${JSON.stringify(update.plan ?? routine.plan)}::jsonb,
          schedule = ${JSON.stringify(schedule)}::jsonb,
          time_zone = ${timeZone},
          locale = ${update.locale ?? routine.locale},
          cost_cap_usd = ${update.costCapUsd ?? routine.costCapUsd},
          approved_recipients = ${JSON.stringify(update.approvedRecipients ?? routine.approvedRecipients)}::jsonb,
          approved_hosts = ${JSON.stringify(update.approvedSites ?? routine.approvedSites)}::jsonb,
          declined_hosts = ${JSON.stringify(
            routine.declinedSites.filter((site) => !(update.approvedSites ?? []).includes(site)),
          )}::jsonb,
          next_run_at = ${moved ? nextRunAfter(schedule, timeZone, new Date()) : routine.nextRunAt},
          ${hold ? sql`admin_paused_at = clock_timestamp(), admin_paused_by = ${hold.admin_paused_by},` : sql``}
          updated_at = clock_timestamp()
        WHERE id = ${routineId}`,
      );
      await auditEvent(db, audit, 'rio.routine.updated', actor, {
        routineId,
        databaseId: routine.databaseId,
        changed: Object.keys(update).sort(),
        ...(update.costCapUsd !== undefined ? { costCapUsd: update.costCapUsd } : {}),
        ...(update.approvedRecipients ? { approvedLists: update.approvedRecipients.length } : {}),
        ...(update.approvedSites ? { approvedSites: update.approvedSites } : {}),
        ...(hold ? { heldByAdmin: true } : {}),
      });
    });
    return routineView(pool, schemas, (await loadRoutine(pool, schemas, actor.orgId, routineId))!, actor);
  });

  app.delete('/api/rio/routines/:routineId', session, async (request, reply) => {
    const actor = requireActor(request);
    const { routineId } = parse(routineParams, request.params);
    const { pool, schemas } = dataStore(ctx);
    const { audit } = authDatabase(ctx);
    await withTransaction(pool, async (db) => {
      const routine = await ownRoutine(db, schemas, actor, routineId, 'update');
      // Only an admin deletes a routine an admin paused, or lifts the pause.
      if (routine.adminPaused) throw new AppError('conflict', 'routines.paused.adminOnly');
      await query(db, sql`DELETE FROM ${tables(schemas).routines} WHERE id = ${routineId}`);
      await auditEvent(db, audit, 'rio.routine.deleted', actor, {
        routineId,
        databaseId: routine.databaseId,
      });
    });
    return reply.status(204).send();
  });

  for (const action of ['pause', 'resume'] as const)
    app.post(`/api/rio/routines/:routineId/${action}`, session, async (request): Promise<Routine> => {
      const actor = requireActor(request);
      const { routineId } = parse(routineParams, request.params);
      const { pool, schemas } = dataStore(ctx);
      const { audit } = authDatabase(ctx);
      const t = tables(schemas);
      if (action === 'resume') await available(app, actor);
      await withTransaction(pool, async (db) => {
        const routine = await ownRoutine(db, schemas, actor, routineId, 'update');
        const row = await query<{ paused: boolean }>(
          db,
          sql`SELECT paused_at IS NOT NULL AS paused FROM ${t.routines} WHERE id = ${routineId}`,
        );
        const ownPause = row.rows[0]!.paused;
        if (action === 'pause' && !ownPause)
          await query(
            db,
            sql`UPDATE ${t.routines} SET paused_at = clock_timestamp(), paused_reason = ${PAUSED.owner},
              paused_by = ${actor.userId}, updated_at = clock_timestamp() WHERE id = ${routineId}`,
          );
        // Only an admin lifts an admin's pause, so the owner can't resume past one.
        if (action === 'resume' && routine.adminPaused)
          throw new AppError('conflict', 'routines.paused.adminOnly');
        // Resuming starts the failure count over and skips the runs it missed.
        if (action === 'resume' && ownPause)
          await query(
            db,
            sql`UPDATE ${t.routines} SET paused_at = NULL, paused_reason = NULL, paused_by = NULL, failures = 0,
              next_run_at = ${nextRunAfter(routine.schedule, routine.timeZone, new Date())},
              updated_at = clock_timestamp() WHERE id = ${routineId}`,
          );
        await auditEvent(
          db,
          audit,
          action === 'pause' ? 'rio.routine.paused' : 'rio.routine.resumed',
          actor,
          {
            routineId,
            databaseId: routine.databaseId,
          },
        );
      });
      return routineView(pool, schemas, (await loadRoutine(pool, schemas, actor.orgId, routineId))!, actor);
    });

  app.post('/api/rio/routines/:routineId/run', session, async (request): Promise<RoutineRun> => {
    const actor = requireActor(request);
    const { routineId } = parse(routineParams, request.params);
    await available(app, actor);
    const { pool, schemas } = dataStore(ctx);
    const routine = await ownRoutine(pool, schemas, actor, routineId);
    checkRunning(routine);
    const run = await worker().queue(routine, 'manual');
    return toRun(run, routine.databaseId, []);
  });

  app.get('/api/rio/routines/:routineId/runs', session, async (request): Promise<RoutineRun[]> => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    const routine = await ownRoutine(pool, schemas, actor, parse(routineParams, request.params).routineId);
    // What runs read and prepared stays with access to the database.
    await stillOpens(app, actor, routine.id, routine.databaseId);
    return runsOf(pool, schemas, routine);
  });

  app.get('/api/rio/routine-approvals/:approvalId', session, async (request) =>
    loadApproval(app, requireActor(request), parse(approvalParams, request.params).approvalId),
  );
  app.post('/api/rio/routine-approvals/:approvalId/approve', session, async (request) =>
    approve(
      app,
      requireActor(request),
      parse(approvalParams, request.params).approvalId,
      parse(RoutineApprove, request.body ?? {}),
    ),
  );
  app.post('/api/rio/routine-approvals/:approvalId/skip', session, async (request) =>
    skipApproval(app, requireActor(request), parse(approvalParams, request.params).approvalId),
  );
  app.post('/api/rio/routine-approvals/:approvalId/change', session, async (request) =>
    change(
      app,
      requireActor(request),
      parse(approvalParams, request.params).approvalId,
      parse(RoutineChange, request.body).note,
    ),
  );

  app.get('/api/admin/routines', admin, async (request): Promise<AdminRoutine[]> => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    return adminRoutines(pool, schemas, actor, sql`TRUE`);
  });

  for (const action of ['pause', 'resume'] as const)
    app.post(`/api/admin/routines/:routineId/${action}`, admin, async (request): Promise<AdminRoutine> => {
      const actor = requireActor(request);
      const { routineId } = parse(routineParams, request.params);
      const { pool, schemas } = dataStore(ctx);
      const { audit } = authDatabase(ctx);
      const routine = await loadRoutine(pool, schemas, actor.orgId, routineId);
      if (!routine) throw new AppError('not_found', 'errors.notFound');
      if (action === 'pause') await worker().pause(routine, PAUSED.admin, actor.userId);
      else await worker().resumeFromAdmin(routine);
      await auditEvent(
        pool,
        audit,
        action === 'pause' ? 'rio.routine.paused' : 'rio.routine.resumed',
        actor,
        {
          routineId,
          databaseId: routine.databaseId,
          ownerId: routine.ownerId,
          byAdmin: true,
        },
      );
      const [view] = await adminRoutines(pool, schemas, actor, sql`r.id = ${routineId}`);
      return view!;
    });

  app.delete('/api/admin/routines/:routineId', admin, async (request, reply) => {
    const actor = requireActor(request);
    const { routineId } = parse(routineParams, request.params);
    const { pool, schemas } = dataStore(ctx);
    const { audit } = authDatabase(ctx);
    await withTransaction(pool, async (db) => {
      const routine = await loadRoutine(db, schemas, actor.orgId, routineId, 'update');
      if (!routine) throw new AppError('not_found', 'errors.notFound');
      await query(db, sql`DELETE FROM ${tables(schemas).routines} WHERE id = ${routineId}`);
      await auditEvent(db, audit, 'rio.routine.deleted', actor, {
        routineId,
        databaseId: routine.databaseId,
        ownerId: routine.ownerId,
        byAdmin: true,
      });
    });
    return reply.status(204).send();
  });
}
