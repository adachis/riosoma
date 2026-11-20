import {
  AppError,
  RoutinePlan,
  RoutineSchedule,
  type AdminRoutine,
  type AiFootprint,
  type Routine,
  type RoutineActivity,
  type RoutineApproval,
  type RoutineChanges,
  type RoutineApprovalStatus,
  type RoutineRun,
  type RoutineRunState,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable, type Sql } from '@riosoma/db';
import { z } from 'zod';
import { AccessScope } from '../data/access.js';
import type { DataSchemas } from '../data/context.js';
import { loadFields, loadTables } from '../data/metadata.js';
import type { Actor } from '../http/policy.js';

/**
 * Reads and shapes routines, their runs, and what their runs left for approval.  Everything here
 * reads by organization as well as by ID, so nothing crosses from one organization to another.
 */

export function tables(schemas: DataSchemas) {
  return {
    routines: ident(schemas.app, 'rio_routines'),
    runs: ident(schemas.app, 'rio_routine_runs'),
    approvals: ident(schemas.app, 'rio_routine_approvals'),
  };
}

/** Why a routine is paused, as the message keys the app words */
export const PAUSED = {
  failures: 'routines.paused.failures',
  lostAccess: 'routines.paused.lostAccess',
  ownerLeft: 'routines.paused.ownerLeft',
  admin: 'routines.paused.admin',
  owner: 'routines.paused.owner',
} as const;

export interface RoutineRow {
  id: string;
  org_id: string;
  database_id: string;
  owner_id: string;
  name: string;
  instructions: string;
  plan: unknown;
  schedule: unknown;
  time_zone: string;
  locale: string;
  cost_cap_usd: string;
  approved_recipients: unknown;
  paused_at: Date | null;
  paused_reason: string | null;
  paused_by: string | null;
  admin_paused_at: Date | null;
  admin_paused_by: string | null;
  approved_hosts: unknown;
  declined_hosts: unknown;
  failures: number;
  next_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** A routine as the worker and the routes use it, with its stored JSON read back. */
export interface StoredRoutine {
  id: string;
  orgId: string;
  databaseId: string;
  ownerId: string;
  name: string;
  instructions: string;
  plan: RoutinePlan;
  schedule: RoutineSchedule;
  timeZone: string;
  locale: string;
  costCapUsd: number;
  approvedRecipients: string[][];
  /** Sites, as origins, whose root it may read */
  approvedSites: string[];
  /** Sites its owner skipped, which a run doesn't ask about again */
  declinedSites: string[];
  /** Paused by anyone, so it runs by no path */
  paused: boolean;
  /** Paused by an admin, which only an admin lifts */
  adminPaused: boolean;
  /** Why it's paused: an admin's pause first, then its owner's or its own */
  pausedReason: string | null;
  failures: number;
  nextRunAt: Date | null;
}

const Lists = z.array(z.array(z.string()));
const Sites = z.array(z.string());

export function storedRoutine(row: RoutineRow): StoredRoutine {
  const lists = Lists.safeParse(row.approved_recipients);
  return {
    id: row.id,
    orgId: row.org_id,
    databaseId: row.database_id,
    ownerId: row.owner_id,
    name: row.name,
    instructions: row.instructions,
    plan: RoutinePlan.parse(row.plan),
    schedule: RoutineSchedule.parse(row.schedule),
    timeZone: row.time_zone,
    locale: row.locale,
    costCapUsd: Number(row.cost_cap_usd),
    approvedRecipients: lists.success ? lists.data : [],
    approvedSites: Sites.safeParse(row.approved_hosts).data ?? [],
    declinedSites: Sites.safeParse(row.declined_hosts).data ?? [],
    paused: row.paused_at !== null || row.admin_paused_at !== null,
    adminPaused: row.admin_paused_at !== null,
    pausedReason: row.admin_paused_at !== null ? PAUSED.admin : row.paused_reason,
    failures: row.failures,
    nextRunAt: row.next_run_at,
  };
}

export async function loadRoutine(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  id: string,
  /**
   * `noKeyUpdate` holds the row against pauses and edits while leaving it free for a new
   * approval's foreign key, so approving and a run's proposal never wait on each other in turn
   */
  lock?: 'update' | 'noKeyUpdate',
): Promise<StoredRoutine | null> {
  const found = await query<RoutineRow>(
    db,
    sql`SELECT * FROM ${tables(schemas).routines} WHERE id = ${id} AND org_id = ${orgId}${
      lock === 'update' ? sql` FOR UPDATE` : lock === 'noKeyUpdate' ? sql` FOR NO KEY UPDATE` : sql``
    }`,
  );
  return found.rows[0] ? storedRoutine(found.rows[0]) : null;
}

/** A routine its owner can reach: anyone else, admins included, gets not found. */
export async function ownRoutine(
  db: Queryable,
  schemas: DataSchemas,
  actor: { orgId: string; userId: string },
  id: string,
  lock?: 'update',
): Promise<StoredRoutine> {
  const routine = await loadRoutine(db, schemas, actor.orgId, id, lock);
  if (!routine || routine.ownerId !== actor.userId) throw new AppError('not_found', 'errors.notFound');
  return routine;
}

export interface RunRow {
  id: string;
  seq: string;
  routine_id: string;
  org_id: string;
  trigger: RoutineRun['trigger'];
  state: RoutineRunState;
  revision: unknown;
  message_key: string | null;
  report: string | null;
  group_id: string | null;
  receipt_summary: string | null;
  steps: number;
  provider_id: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string | null;
  ms: number | null;
  /** `{ estimate }`, where a null estimate means the method has no data for the model */
  footprint: { estimate: AiFootprint | null } | null;
  /** Emails recorded before a send kept its outcome have no `status` */
  activity: Array<
    RoutineActivity | (Omit<Extract<RoutineActivity, { kind: 'email' }>, 'status'> & { status?: undefined })
  > | null;
  lease_at: Date | null;
  lease_token: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface ApprovalRow {
  id: string;
  run_id: string;
  routine_id: string;
  org_id: string;
  owner_id: string;
  database_id: string;
  kind: 'plan' | 'email' | 'hosts';
  status: RoutineApprovalStatus;
  summary: string;
  detail: unknown;
  group_id: string | null;
  message_key: string | null;
  created_at: Date;
  decided_at: Date | null;
  expires_at: Date;
}

/** A cell a plan writes, with the value it held when the plan was worked out */
export const HeldCell = z.object({
  tableId: z.string(),
  recordId: z.string(),
  fieldId: z.string(),
  value: z.unknown(),
});
export type HeldCell = z.infer<typeof HeldCell>;

/**
 * A plan as stored: its steps, its commands, the changes they make as last worked out, which
 * `revision` of that working-out it is, and what each cell it writes held then (`held`), which
 * approving compares with the cells as they are.  Target row fingerprints and normalized effects
 * also cover deletes, restores, and derived assignments.
 */
export const PlanDetail = z.object({
  steps: z.array(z.string()),
  commands: z.array(z.unknown()),
  changes: z.custom<RoutineChanges>((value) => value !== null && typeof value === 'object').optional(),
  revision: z.number().int().min(0).default(0),
  held: z.array(HeldCell).optional(),
  targets: z.array(z.object({ tableId: z.string(), recordId: z.string(), hash: z.string() })).optional(),
  effects: z.array(z.unknown()).optional(),
  signatures: z
    .array(
      z.object({
        id: z.string(),
        tableId: z.string(),
        recordId: z.string(),
        status: z.string(),
        state: z.string(),
        cancels: z.boolean(),
      }),
    )
    .optional(),
});
export const EmailDetail = z.object({ to: z.array(z.string()), subject: z.string(), body: z.string() });
export const SitesDetail = z.object({ sites: z.array(z.string()) });

export function toApproval(row: ApprovalRow, now = new Date()): RoutineApproval {
  const plan = row.kind === 'plan' ? PlanDetail.safeParse(row.detail) : null;
  const email = row.kind === 'email' ? EmailDetail.safeParse(row.detail) : null;
  // One left waiting past its time reads as expired, even before anything marks it so.
  const status = row.status === 'pending' && row.expires_at <= now ? 'expired' : row.status;
  return {
    id: row.id,
    routineId: row.routine_id,
    runId: row.run_id,
    databaseId: row.database_id,
    kind: row.kind,
    status,
    summary: row.summary,
    steps: plan?.success ? plan.data.steps : [],
    changes: plan?.success ? (plan.data.changes ?? null) : null,
    revision: plan?.success ? plan.data.revision : 0,
    email: email?.success ? email.data : null,
    sites: row.kind === 'hosts' ? (SitesDetail.safeParse(row.detail).data?.sites ?? []) : [],
    receipt: row.group_id
      ? { databaseId: row.database_id, groupId: row.group_id, summary: row.summary }
      : null,
    messageKey: row.message_key,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
    expiresAt: row.expires_at.toISOString(),
  };
}

export function toRun(row: RunRow, databaseId: string, approvals: ApprovalRow[]): RoutineRun {
  return {
    id: row.id,
    routineId: row.routine_id,
    trigger: row.trigger,
    state: row.state,
    messageKey: row.message_key,
    report: row.report,
    // Every run holds an undo group from its start, and only one that changed something has a receipt.
    receipt:
      row.group_id && row.receipt_summary !== null
        ? { databaseId, groupId: row.group_id, summary: row.receipt_summary }
        : null,
    // Emails recorded before sends kept their outcome had all gone out.
    activity: (row.activity ?? []).map((item): RoutineActivity =>
      item.kind === 'email' ? { ...item, status: item.status ?? 'sent' } : item,
    ),
    approvals: approvals
      .filter((approval) => approval.run_id === row.id)
      .map((approval) => toApproval(approval)),
    steps: row.steps,
    usage: row.model
      ? {
          providerId: row.provider_id ?? '',
          model: row.model,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
          ms: row.ms ?? 0,
          ...(row.footprint ? { footprint: row.footprint.estimate } : {}),
        }
      : null,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

/** A routine's runs, newest first, with what each left for approval. */
export async function runsOf(
  db: Queryable,
  schemas: DataSchemas,
  routine: StoredRoutine,
  limit = 50,
): Promise<RoutineRun[]> {
  const t = tables(schemas);
  const runs = await query<RunRow>(
    db,
    sql`SELECT * FROM ${t.runs} WHERE routine_id = ${routine.id} AND org_id = ${routine.orgId}
    ORDER BY seq DESC LIMIT ${limit}`,
  );
  const approvals = await query<ApprovalRow>(
    db,
    sql`SELECT * FROM ${t.approvals} WHERE run_id = ANY(${runs.rows.map((run) => run.id)}::text[])
    ORDER BY created_at, id`,
  );
  return runs.rows.map((run) => toRun(run, routine.databaseId, approvals.rows));
}

export async function loadRun(
  db: Queryable,
  schemas: DataSchemas,
  routine: StoredRoutine,
  runId: string,
): Promise<RoutineRun | null> {
  const t = tables(schemas);
  const run = await query<RunRow>(
    db,
    sql`SELECT * FROM ${t.runs} WHERE id = ${runId} AND routine_id = ${routine.id} AND org_id = ${routine.orgId}`,
  );
  if (!run.rows[0]) return null;
  const approvals = await query<ApprovalRow>(
    db,
    sql`SELECT * FROM ${t.approvals} WHERE run_id = ${runId} ORDER BY created_at, id`,
  );
  return toRun(run.rows[0], routine.databaseId, approvals.rows);
}

interface ListedRow extends RoutineRow {
  database_name: string;
  owner_name: string;
  waiting: string;
  last_id: string | null;
  last_state: RoutineRunState | null;
  last_message_key: string | null;
  last_created_at: Date | null;
  last_finished_at: Date | null;
}

/**
 * The names of the tables and fetch fields routines' plans name, as someone sees them: a table only
 * in a database they can open, and a field only when they can see it.
 */
async function namesFor(
  db: Queryable,
  schemas: DataSchemas,
  viewer: Actor,
  routines: ReadonlyArray<{ databaseId: string; plan: RoutinePlan }>,
): Promise<Map<string, { tables: Record<string, string>; fields: Record<string, string> }>> {
  const names = new Map<string, { tables: Record<string, string>; fields: Record<string, string> }>();
  const scope = new AccessScope(db, schemas, viewer);
  for (const databaseId of new Set(routines.map((routine) => routine.databaseId))) {
    const found = { tables: {} as Record<string, string>, fields: {} as Record<string, string> };
    names.set(databaseId, found);
    try {
      await scope.require(databaseId, 'read');
    } catch {
      continue;
    }
    const tablesHere = await loadTables(db, schemas, databaseId);
    for (const table of tablesHere) found.tables[table.id] = table.name;
    const wanted = new Set(
      routines
        .filter((routine) => routine.databaseId === databaseId)
        .flatMap((routine) => routine.plan.fetches.map((fetch) => fetch.fieldId)),
    );
    if (!wanted.size) continue;
    const fields = await loadFields(
      db,
      schemas,
      tablesHere.map((table) => table.id),
    );
    for (const table of tablesHere)
      for (const field of scope.visibleFields(
        table.id,
        fields.filter((item) => item.tableId === table.id && wanted.has(item.id)),
      ))
        found.fields[field.id] = field.name;
  }
  return names;
}

/**
 * Routines as the app lists them, with their owner, database, last run, and what waits.  The names
 * of the tables and fields their plans name come as `viewer` sees them.
 */
export async function listRoutines(
  db: Queryable,
  schemas: DataSchemas,
  where: Sql,
  viewer: Actor,
): Promise<Routine[]> {
  const t = tables(schemas);
  const rows = await query<ListedRow>(
    db,
    sql`SELECT r.*, d.name AS database_name, u.name AS owner_name,
      (SELECT count(*) FROM ${t.approvals} a WHERE a.routine_id = r.id AND a.status = 'pending'
        AND a.expires_at > clock_timestamp()) AS waiting,
      last.id AS last_id, last.state AS last_state, last.message_key AS last_message_key,
      last.created_at AS last_created_at, last.finished_at AS last_finished_at
    FROM ${t.routines} r
    JOIN ${ident(schemas.app, 'databases')} d ON d.id = r.database_id
    JOIN ${ident(schemas.app, 'users')} u ON u.id = r.owner_id
    LEFT JOIN LATERAL (
      SELECT id, state, message_key, created_at, finished_at FROM ${t.runs} x
      WHERE x.routine_id = r.id ORDER BY x.seq DESC LIMIT 1
    ) last ON true
    WHERE ${where}
    ORDER BY r.created_at, r.id`,
  );
  const stored = rows.rows.map(storedRoutine);
  const names = await namesFor(db, schemas, viewer, stored);
  return rows.rows.map((row, index) => {
    const routine = stored[index]!;
    const named = names.get(row.database_id);
    return {
      id: row.id,
      databaseId: row.database_id,
      databaseName: row.database_name,
      name: row.name,
      instructions: row.instructions,
      plan: routine.plan,
      schedule: routine.schedule,
      timeZone: row.time_zone,
      locale: row.locale,
      costCapUsd: routine.costCapUsd,
      approvedRecipients: routine.approvedRecipients,
      approvedSites: routine.approvedSites,
      owner: { id: row.owner_id, name: row.owner_name },
      paused: routine.paused,
      adminPaused: routine.adminPaused,
      pausedBecause: routine.paused ? routine.pausedReason : null,
      failures: row.failures,
      nextRunAt: routine.paused ? null : (row.next_run_at?.toISOString() ?? null),
      lastRun: row.last_id
        ? {
            id: row.last_id,
            state: row.last_state!,
            messageKey: row.last_message_key,
            createdAt: row.last_created_at!.toISOString(),
            finishedAt: row.last_finished_at?.toISOString() ?? null,
          }
        : null,
      waiting: Number(row.waiting),
      tableNames: named?.tables ?? {},
      fieldNames: named?.fields ?? {},
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  });
}

/** One routine as its owner sees it. */
export async function routineView(
  db: Queryable,
  schemas: DataSchemas,
  routine: StoredRoutine,
  owner: Actor,
): Promise<Routine> {
  const [view] = await listRoutines(
    db,
    schemas,
    sql`r.id = ${routine.id} AND r.org_id = ${routine.orgId}`,
    owner,
  );
  if (!view) throw new AppError('not_found', 'errors.notFound');
  return view;
}

/**
 * Routines as an admin with the AI role sees them: each one's name, owner, database, and where it
 * stands, and its words, plan, and recipients only in a database the admin can open themselves.
 */
export async function adminRoutines(
  db: Queryable,
  schemas: DataSchemas,
  admin: Actor,
  where: Sql,
): Promise<AdminRoutine[]> {
  const listed = await listRoutines(db, schemas, sql`r.org_id = ${admin.orgId} AND ${where}`, admin);
  const scope = new AccessScope(db, schemas, admin);
  const opens = new Map<string, boolean>();
  for (const databaseId of new Set(listed.map((routine) => routine.databaseId)))
    opens.set(databaseId, (await scope.databaseRole(databaseId)) !== null);
  return listed.map((routine) => ({
    id: routine.id,
    databaseId: routine.databaseId,
    databaseName: routine.databaseName,
    name: routine.name,
    owner: routine.owner,
    paused: routine.paused,
    adminPaused: routine.adminPaused,
    pausedBecause: routine.pausedBecause,
    failures: routine.failures,
    nextRunAt: routine.nextRunAt,
    lastRun: routine.lastRun,
    waiting: routine.waiting,
    details: opens.get(routine.databaseId)
      ? {
          instructions: routine.instructions,
          plan: routine.plan,
          schedule: routine.schedule,
          timeZone: routine.timeZone,
          costCapUsd: routine.costCapUsd,
          approvedRecipients: routine.approvedRecipients,
          approvedSites: routine.approvedSites,
        }
      : null,
  }));
}

/**
 * Throws away what a routine left waiting, words and all, once its owner can't open its database:
 * what a run read while they could stays out of their reach from then on.
 */
export async function discardWaiting(db: Queryable, schemas: DataSchemas, routineId: string): Promise<void> {
  await query(
    db,
    sql`UPDATE ${tables(schemas).approvals} SET status = 'expired', summary = '', detail = '{}'::jsonb,
      message_key = 'routines.lostAccess', decided_at = clock_timestamp()
    WHERE routine_id = ${routineId} AND status = 'pending'`,
  );
}
