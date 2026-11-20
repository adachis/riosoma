import {
  AppError,
  ROUTINE_LIMITS,
  siteOrigin,
  sameValue,
  type CellValue,
  type RoutineApprove,
  type RoutineApproval,
  type RoutineRun,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { applyCommands, validate } from '../ai/plans.js';
import { settingsFor } from '../ai/settings.js';
import { auditEvent, authDatabase } from '../auth/database.js';
import { AccessScope } from '../data/access.js';
import { parseCommand } from '../data/commands/index.js';
import { lock } from '../data/commands/transaction.js';
import { dataStore } from '../data/context.js';
import type { Actor } from '../http/policy.js';
import { policyAllows } from '../org-units/policy.js';
import { describeChanges } from './changes.js';
import { strictCommands } from './commands.js';
import { RoutineEmailError, sameList, sendRoutineEmail, type RoutineEmail } from './email.js';
import {
  discardWaiting,
  EmailDetail,
  PlanDetail,
  SitesDetail,
  loadRoutine,
  tables,
  toApproval,
  toRun,
  type ApprovalRow,
  type HeldCell,
} from './store.js';

/**
 * The owner's answers to what a routine's run left waiting.  Approving a plan runs its stored
 * commands as the owner, through their access now, in one undo group, refusing the whole plan if
 * the database changed in ways that break it.  Approving an email sends it as written, or as the
 * owner changed it, and can let the routine send to that exact list from now on without asking.
 * Changing one asks a new run to prepare it again with the owner's note.  Only the owner answers,
 * and while the routine is paused, what it left waiting can be skipped but not approved or changed.
 */

/** JSON with its keys in order, so two values stored and read back compare as equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}

/**
 * Whether every cell a plan writes holds what it held when the plan was worked out, by stored value,
 * whatever the worded changes say.  A plan stored before it kept them counts as moved.
 */
function sameHeld(stored: readonly HeldCell[] | undefined, fresh: readonly HeldCell[]): boolean {
  if (!stored || stored.length !== fresh.length) return false;
  const key = (cell: HeldCell) => `${cell.tableId}:${cell.recordId}:${cell.fieldId}`;
  const now = new Map(fresh.map((cell) => [key(cell), cell.value]));
  return stored.every(
    (cell) => now.has(key(cell)) && sameValue(cell.value as CellValue, now.get(key(cell)) as CellValue),
  );
}

/** Refuses to act for a paused routine, holding its row so a pause can't slip in meanwhile. */
async function unpaused(
  db: Queryable,
  schemas: Parameters<typeof tables>[0],
  actor: Actor,
  routineId: string,
) {
  // No key update, so a run adding an approval for the routine meanwhile never deadlocks with this.
  const routine = await loadRoutine(db, schemas, actor.orgId, routineId, 'noKeyUpdate');
  if (!routine) throw new AppError('not_found', 'errors.notFound');
  if (routine.paused) throw new AppError('conflict', 'routines.paused.refused');
  return routine;
}

async function locked(
  db: Queryable,
  approvals: ReturnType<typeof tables>['approvals'],
  actor: Actor,
  id: string,
): Promise<ApprovalRow> {
  const found = await query<ApprovalRow>(
    db,
    sql`SELECT * FROM ${approvals} WHERE id = ${id} AND org_id = ${actor.orgId} AND owner_id = ${actor.userId}
    FOR UPDATE`,
  );
  if (!found.rows[0]) throw new AppError('not_found', 'errors.notFound');
  return found.rows[0];
}

/** Refuses an answer to something already answered, or left waiting too long. */
async function stillWaiting(
  db: Queryable,
  approvals: ReturnType<typeof tables>['approvals'],
  row: ApprovalRow,
) {
  if (row.status !== 'pending') throw new AppError('conflict', 'routines.approval.decided');
  if (row.expires_at.getTime() <= Date.now()) {
    await query(
      db,
      sql`UPDATE ${approvals} SET status = 'expired', decided_at = clock_timestamp() WHERE id = ${row.id}`,
    );
    return false;
  }
  return true;
}

async function routinesOn(app: FastifyInstance, actor: Actor) {
  const settings = await settingsFor(app.ctx, actor.orgId, actor);
  if (!settings.enabled) throw new AppError('unavailable', 'rio.disabled');
  if (!settings.routines) throw new AppError('unavailable', 'routines.off');
  return settings;
}

/**
 * Refuses an owner who can no longer open the routine's database, throwing away what the routine
 * left waiting, since a run read it while they could.
 */
export async function stillOpens(app: FastifyInstance, actor: Actor, routineId: string, databaseId: string) {
  const { pool, schemas } = dataStore(app.ctx);
  if (await new AccessScope(pool, schemas, actor).databaseRole(databaseId)) return;
  await discardWaiting(pool, schemas, routineId);
  throw new AppError('forbidden', 'routines.lostAccess');
}

export async function loadApproval(app: FastifyInstance, actor: Actor, id: string): Promise<RoutineApproval> {
  const { pool, schemas } = dataStore(app.ctx);
  const find = () =>
    query<ApprovalRow>(
      pool,
      sql`SELECT * FROM ${tables(schemas).approvals} WHERE id = ${id} AND org_id = ${actor.orgId} AND owner_id = ${actor.userId}`,
    );
  const found = await find();
  if (!found.rows[0]) throw new AppError('not_found', 'errors.notFound');
  await stillOpens(app, actor, found.rows[0].routine_id, found.rows[0].database_id);
  return toApproval(found.rows[0]);
}

export async function skipApproval(app: FastifyInstance, actor: Actor, id: string): Promise<RoutineApproval> {
  const { pool, schemas } = dataStore(app.ctx);
  const t = tables(schemas);
  await withTransaction(pool, async (db) => {
    const row = await locked(db, t.approvals, actor, id);
    if (row.status === 'skipped') return;
    if (!(await stillWaiting(db, t.approvals, row))) return;
    await query(
      db,
      sql`UPDATE ${t.approvals} SET status = 'skipped', decided_at = clock_timestamp() WHERE id = ${id}`,
    );
    // Sites the owner skipped aren't asked about again.
    if (row.kind === 'hosts') {
      const routine = await loadRoutine(db, schemas, actor.orgId, row.routine_id, 'update');
      const sites = SitesDetail.safeParse(row.detail).data?.sites ?? [];
      if (routine)
        await query(
          db,
          sql`UPDATE ${t.routines} SET declined_hosts = ${JSON.stringify(
            [...new Set([...routine.declinedSites, ...sites])].sort().slice(0, 1_000),
          )}::jsonb, updated_at = clock_timestamp() WHERE id = ${routine.id}`,
        );
    }
  });
  return loadApproval(app, actor, id);
}

/** Refuses addresses outside the organization unless the owner's policy allows sending to them. */
async function checkOutside(app: FastifyInstance, actor: Actor, to: readonly string[]): Promise<void> {
  const { pool, schemas } = dataStore(app.ctx);
  const members = await query<{ email: string }>(
    pool,
    sql`SELECT lower(u.email) AS email FROM ${ident(schemas.app, 'users')} u
    JOIN ${ident(schemas.app, 'memberships')} m ON m.user_id = u.id
    WHERE m.org_id = ${actor.orgId} AND u.deactivated_at IS NULL AND lower(u.email) = ANY(${[...to]}::text[])`,
  );
  const inside = new Set(members.rows.map((row) => row.email));
  if (
    to.some((address) => !inside.has(address)) &&
    !(await policyAllows(pool, `"${schemas.app}"`, actor, 'reportOutsideRecipients'))
  )
    throw new AppError('forbidden', 'routines.email.outsideNotAllowed');
}

export async function approve(
  app: FastifyInstance,
  actor: Actor,
  id: string,
  input: z.output<typeof RoutineApprove>,
): Promise<RoutineApproval> {
  const settings = await routinesOn(app, actor);
  const { pool, schemas } = dataStore(app.ctx);
  const t = tables(schemas);
  const current = await loadApproval(app, actor, id);
  if (current.status === 'approved') return current;
  if (current.status !== 'pending') throw new AppError('conflict', 'routines.approval.decided');
  // The bell approves in one click only a small record edit.  Anything else is read first.
  // A stricter personal choice or organization cap also requires a full review of an earlier plan.
  if (input.oneClick && (!(current.kind === 'plan' && current.changes?.small) || settings.autonomy === 'ask'))
    throw new AppError('conflict', 'routines.approval.oneClick');
  if (current.kind === 'hosts') {
    const outcome = await withTransaction(pool, async (db) => {
      const row = await locked(db, t.approvals, actor, id);
      const routine = await unpaused(db, schemas, actor, row.routine_id);
      if (!(await stillWaiting(db, t.approvals, row))) return 'expired';
      const sites = (SitesDetail.safeParse(row.detail).data?.sites ?? []).filter(
        (site) => siteOrigin(site) === site,
      );
      const approved = [...new Set([...routine.approvedSites, ...sites])].sort();
      if (approved.length > ROUTINE_LIMITS.sites)
        throw new AppError('validation_failed', 'routines.sites.tooMany', {
          params: { limit: ROUTINE_LIMITS.sites },
        });
      await query(
        db,
        sql`UPDATE ${t.routines} SET approved_hosts = ${JSON.stringify(approved)}::jsonb,
          declined_hosts = ${JSON.stringify(routine.declinedSites.filter((site) => !sites.includes(site)))}::jsonb,
          updated_at = clock_timestamp() WHERE id = ${routine.id}`,
      );
      await query(
        db,
        sql`UPDATE ${t.approvals} SET status = 'approved', decided_at = clock_timestamp() WHERE id = ${id}`,
      );
      const { audit } = authDatabase(app.ctx);
      await auditEvent(db, audit, 'rio.routine.sitesApproved', actor, {
        routineId: routine.id,
        approvalId: id,
        databaseId: routine.databaseId,
        sites,
      });
      return 'done';
    });
    if (outcome === 'expired') throw new AppError('conflict', 'routines.approval.expired');
    return loadApproval(app, actor, id);
  }
  if (current.kind === 'email') {
    const stored = EmailDetail.parse(current.email);
    const email: RoutineEmail = input.email ?? stored;
    await checkOutside(app, actor, email.to);
    if (!app.ctx.mailer) throw new AppError('unavailable', 'routines.email.unavailable');
    // Marked approved before it goes, so a second approval can't send it again.
    const claimed = await withTransaction(pool, async (db) => {
      const row = await locked(db, t.approvals, actor, id);
      await unpaused(db, schemas, actor, row.routine_id);
      if (!(await stillWaiting(db, t.approvals, row))) return null;
      await query(
        db,
        sql`UPDATE ${t.approvals} SET status = 'approved', decided_at = clock_timestamp(),
          detail = ${JSON.stringify(email)}::jsonb WHERE id = ${id}`,
      );
      if (input.always) {
        const routine = await loadRoutine(db, schemas, actor.orgId, row.routine_id, 'update');
        if (
          routine &&
          !routine.approvedRecipients.some((list) => sameList(list, email.to)) &&
          routine.approvedRecipients.length < ROUTINE_LIMITS.approvedLists
        )
          await query(
            db,
            sql`UPDATE ${t.routines} SET approved_recipients = ${JSON.stringify([
              ...routine.approvedRecipients,
              [...email.to].sort(),
            ])}::jsonb, updated_at = clock_timestamp() WHERE id = ${routine.id}`,
          );
      }
      return row;
    });
    if (!claimed) throw new AppError('conflict', 'routines.approval.expired');
    const routine = await loadRoutine(pool, schemas, actor.orgId, claimed.routine_id);
    const owner = await query<{ name: string }>(
      pool,
      sql`SELECT name FROM ${ident(schemas.app, 'users')} WHERE id = ${actor.userId}`,
    );
    let sent: string[] = [];
    try {
      const scope = new AccessScope(pool, schemas, actor);
      await scope.requireUse(claimed.database_id, 'external');
      await scope.requireUse(claimed.database_id, 'export');
      sent = await sendRoutineEmail(app.ctx.mailer, email, {
        name: routine?.name ?? '',
        ownerName: owner.rows[0]?.name ?? '',
      });
    } catch (error) {
      if (error instanceof RoutineEmailError) sent = error.sent;
      const key = error instanceof AppError ? error.messageKey : 'routines.email.failed';
      await query(
        pool,
        sql`UPDATE ${t.approvals} SET status = 'failed', message_key = ${key} WHERE id = ${id}`,
      );
    }
    if (sent.length) {
      const { audit } = authDatabase(app.ctx);
      await auditEvent(pool, audit, 'rio.routine.emailSent', actor, {
        routineId: claimed.routine_id,
        runId: claimed.run_id,
        approvalId: id,
        databaseId: claimed.database_id,
        to: sent,
        subject: email.subject.slice(0, 200),
      });
    }
    return loadApproval(app, actor, id);
  }
  const outcome = await withTransaction(pool, async (db) => {
    const row = await locked(db, t.approvals, actor, id);
    if (row.status === 'approved') return 'done';
    const routine = await unpaused(db, schemas, actor, row.routine_id);
    if (!(await stillWaiting(db, t.approvals, row))) return 'expired';
    const plan = PlanDetail.parse(row.detail);
    const fail = async (key: string) => {
      await query(
        db,
        sql`UPDATE ${t.approvals} SET status = 'failed', message_key = ${key}, decided_at = clock_timestamp()
        WHERE id = ${id}`,
      );
      return 'done' as const;
    };
    // Only the keys a routine may use, and only the tables it says it changes as saved now,
    // whatever an older plan may hold.
    let stored: Array<Record<string, unknown>>;
    try {
      stored = strictCommands(plan.commands, 'stored');
    } catch (error) {
      if (error instanceof AppError) return fail(error.messageKey);
      throw error;
    }
    if (stored.some((command) => !routine.plan.writes.includes(command.tableId as string)))
      return fail('routines.changes.notInPlan');
    // Only the revision of the plan the owner was shown is approved.
    if (input.revision !== plan.revision) return 'moved';
    const owner: Actor = { ...actor, routine: { id: row.routine_id, runId: row.run_id, approved: true } };
    await query(db, sql`SAVEPOINT routine_approval`);
    try {
      // What the plan does now, worked out again at the click from the database as it is, which
      // has to be what the owner was shown.  Anything else is refused, and they're shown it anew.
      const commands = stored.map(parseCommand);
      const c = { db, schemas, actor: owner, databaseId: row.database_id };
      await lock(c, [`database:${row.database_id}`]);
      const impact = await validate(c, commands, { effects: true });
      const fresh = await describeChanges(
        db,
        schemas,
        actor,
        row.database_id,
        commands,
        impact,
        routine.locale,
        settings.autonomy,
        routine.timeZone,
      );
      if (fresh.changes.tables.some((table) => !routine.plan.writes.includes(table.tableId))) {
        await query(db, sql`ROLLBACK TO SAVEPOINT routine_approval`);
        return fail('routines.changes.notInPlan');
      }
      if (
        canonical(fresh.changes) !== canonical(plan.changes ?? null) ||
        canonical(fresh.commands) !== canonical(stored) ||
        !sameHeld(plan.held, fresh.held) ||
        canonical(plan.targets) !== canonical(fresh.targets) ||
        canonical(plan.effects) !== canonical(fresh.effects) ||
        canonical(plan.signatures) !== canonical(fresh.signatures)
      ) {
        await query(db, sql`ROLLBACK TO SAVEPOINT routine_approval`);
        // Nothing left to do closes it, and never leaves an empty plan waiting.
        if (!fresh.commands.length) {
          await query(
            db,
            sql`UPDATE ${t.approvals} SET status = 'skipped', message_key = 'routines.approval.nothingLeft',
              decided_at = clock_timestamp() WHERE id = ${id}`,
          );
          return 'nothingLeft';
        }
        await query(
          db,
          sql`UPDATE ${t.approvals} SET detail = ${JSON.stringify({
            ...plan,
            commands: fresh.commands,
            changes: fresh.changes,
            held: fresh.held,
            targets: fresh.targets,
            effects: fresh.effects,
            signatures: fresh.signatures,
            revision: plan.revision + 1,
          })}::jsonb WHERE id = ${id}`,
        );
        return 'moved';
      }
      if (input.oneClick && !fresh.changes.small)
        throw new AppError('conflict', 'routines.approval.oneClick');
      // Approved by its owner, it's their change, and sets off automations as theirs would.
      const groupId = await applyCommands(app, owner, db, row.database_id, { commands: stored });
      await query(
        db,
        sql`UPDATE ${t.approvals} SET status = 'approved', group_id = ${groupId}, decided_at = clock_timestamp()
        WHERE id = ${id}`,
      );
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        !error.userFault ||
        error.messageKey === 'routines.approval.oneClick'
      )
        throw error;
      await query(db, sql`ROLLBACK TO SAVEPOINT routine_approval`);
      // Access the owner no longer has says so, and anything else reads as a database that moved on.
      const key =
        error.messageKey.startsWith('data.access.') || error.messageKey === 'routines.changes.incomplete'
          ? error.messageKey
          : 'rio.plan.stale';
      await query(
        db,
        sql`UPDATE ${t.approvals} SET status = 'failed', message_key = ${key}, decided_at = clock_timestamp()
        WHERE id = ${id}`,
      );
    }
    return 'done';
  });
  if (outcome === 'expired') throw new AppError('conflict', 'routines.approval.expired');
  // Nothing was made, and the owner reads what the plan would do now before answering again.
  if (outcome === 'moved') throw new AppError('conflict', 'routines.approval.stale');
  if (outcome === 'nothingLeft') throw new AppError('conflict', 'routines.approval.nothingLeft');
  return loadApproval(app, actor, id);
}

/** Asks a new run to prepare what waits again, with the owner's note, and returns that run. */
export async function change(
  app: FastifyInstance,
  actor: Actor,
  id: string,
  note: string,
): Promise<RoutineRun> {
  await routinesOn(app, actor);
  const { pool, schemas } = dataStore(app.ctx);
  const t = tables(schemas);
  const current = await loadApproval(app, actor, id);
  if (current.kind === 'hosts') throw new AppError('conflict', 'routines.approval.noChange');
  const row = await withTransaction(pool, async (db) => {
    const found = await locked(db, t.approvals, actor, id);
    await unpaused(db, schemas, actor, found.routine_id);
    if (!(await stillWaiting(db, t.approvals, found))) return null;
    await query(
      db,
      sql`UPDATE ${t.approvals} SET status = 'changed', decided_at = clock_timestamp() WHERE id = ${id}`,
    );
    return found;
  });
  if (!row) throw new AppError('conflict', 'routines.approval.expired');
  const routine = await loadRoutine(pool, schemas, actor.orgId, row.routine_id);
  const worker = app.ctx.routines;
  if (!routine || !worker) throw new AppError('not_found', 'errors.notFound');
  const approval = toApproval(row);
  try {
    const run = await worker.queue(routine, 'revision', {
      approvalId: id,
      note,
      summary: approval.summary,
      steps: approval.steps,
      email: approval.email,
    });
    return toRun(run, routine.databaseId, []);
  } catch (error) {
    // Nothing was asked for after all, so it waits again as it was.
    await query(
      pool,
      sql`UPDATE ${t.approvals} SET status = 'pending', decided_at = NULL WHERE id = ${id} AND status = 'changed'`,
    );
    throw error;
  }
}
