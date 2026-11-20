import { policyAllows, type PolicyPerson } from '../org-units/policy.js';
import {
  ReportFrequency,
  type ReportDelivery,
  type ReportError,
  type ReportFormat,
  type ReportRecipient,
  type ReportRecipientInfo,
  type ReportRun,
  type ReportRunState,
  type ReportSchedule,
} from '@riosoma/contracts';
import { EMPTY, ident, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { DataSchemas } from '../data/context.js';

/**
 * Reading and writing report schedules, their recipients, and their runs.  A schedule is read
 * with the names of its database, table, view, and owner joined in, so the app can list one
 * without another request.
 */

export interface StoredSchedule {
  id: string;
  orgId: string;
  databaseId: string;
  tableId: string;
  viewId: string;
  ownerId: string;
  ownerName: string;
  databaseName: string;
  tableName: string;
  viewName: string;
  name: string;
  format: ReportFormat;
  frequency: ReportFrequency;
  timeZone: string;
  locale: string;
  enabled: boolean;
  stoppedBecause: string | null;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  recipients: StoredRecipient[];
}

export type StoredRecipient =
  | { kind: 'member'; userId: string; name: string; email: string; locale: string }
  | { kind: 'address'; address: string };

interface ScheduleRow {
  id: string;
  org_id: string;
  database_id: string;
  table_id: string;
  view_id: string;
  owner_id: string;
  owner_name: string;
  database_name: string;
  table_name: string;
  view_name: string;
  name: string;
  format: ReportFormat;
  frequency: unknown;
  time_zone: string;
  locale: string;
  enabled: boolean;
  stopped_because: string | null;
  next_run_at: Date | null;
  last_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface RecipientRow {
  report_id: string;
  user_id: string | null;
  name: string | null;
  email: string | null;
  locale: string | null;
  address: string | null;
}

export interface RunRow {
  id: string;
  seq: string;
  report_id: string;
  org_id: string;
  trigger: 'schedule' | 'manual';
  state: ReportRunState;
  actor_id: string | null;
  due_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  attempts: number;
  retry_at: Date | null;
  lease_at: Date | null;
  lease_token: string | null;
  deliveries: StoredDelivery[];
  error: string | null;
}

/** A delivery as a run keeps it: the recipient by ID or address, never by a record's values. */
export interface StoredDelivery {
  recipient: ReportRecipient;
  state: ReportDelivery['state'];
  records: number | null;
  attachment: ReportDelivery['attachment'];
  attempts: number;
  error: ReportError | null;
  notes?: string[];
}

export function tables(schemas: DataSchemas) {
  return {
    schedules: ident(schemas.app, 'report_schedules'),
    recipients: ident(schemas.app, 'report_recipients'),
    runs: ident(schemas.app, 'report_runs'),
    orgs: ident(schemas.app, 'orgs'),
    users: ident(schemas.app, 'users'),
    memberships: ident(schemas.app, 'memberships'),
  };
}

function scheduleSelect(schemas: DataSchemas, where: Sql, lock = false): Sql {
  const t = tables(schemas);
  return sql`SELECT s.*, u.name AS owner_name, d.name AS database_name, tb.name AS table_name,
    v.name AS view_name
    FROM ${t.schedules} s
    JOIN ${t.users} u ON u.id = s.owner_id
    JOIN ${ident(schemas.app, 'databases')} d ON d.id = s.database_id
    JOIN ${ident(schemas.app, 'tables')} tb ON tb.id = s.table_id
    JOIN ${ident(schemas.app, 'views')} v ON v.id = s.view_id
    WHERE ${where}
    ORDER BY s.created_at, s.id
    ${lock ? sql`FOR NO KEY UPDATE OF s` : EMPTY}`;
}

async function withRecipients(
  db: Queryable,
  schemas: DataSchemas,
  rows: readonly ScheduleRow[],
): Promise<StoredSchedule[]> {
  if (!rows.length) return [];
  const t = tables(schemas);
  const found = await query<RecipientRow>(
    db,
    sql`SELECT r.report_id, r.user_id, u.name, u.email, u.locale, r.address FROM ${t.recipients} r
    LEFT JOIN ${t.users} u ON u.id = r.user_id
    WHERE r.report_id = ANY(${rows.map((row) => row.id)}::text[]) ORDER BY r.report_id, r.position`,
  );
  const byReport = new Map<string, StoredRecipient[]>();
  for (const row of found.rows) {
    const list = byReport.get(row.report_id) ?? [];
    list.push(
      row.user_id
        ? {
            kind: 'member',
            userId: row.user_id,
            name: row.name ?? '',
            email: row.email ?? '',
            locale: row.locale ?? 'en-US',
          }
        : { kind: 'address', address: row.address ?? '' },
    );
    byReport.set(row.report_id, list);
  }
  return rows.map((row) => ({
    id: row.id,
    orgId: row.org_id,
    databaseId: row.database_id,
    tableId: row.table_id,
    viewId: row.view_id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    databaseName: row.database_name,
    tableName: row.table_name,
    viewName: row.view_name,
    name: row.name,
    format: row.format,
    frequency: ReportFrequency.parse(row.frequency),
    timeZone: row.time_zone,
    locale: row.locale,
    enabled: row.enabled,
    stoppedBecause: row.stopped_because,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    recipients: byReport.get(row.id) ?? [],
  }));
}

export async function loadSchedule(
  db: Queryable,
  schemas: DataSchemas,
  reportId: string,
  options: { lock?: boolean } = {},
): Promise<StoredSchedule | null> {
  const result = await query<ScheduleRow>(db, scheduleSelect(schemas, sql`s.id = ${reportId}`, options.lock));
  return (await withRecipients(db, schemas, result.rows))[0] ?? null;
}

export async function viewSchedules(
  db: Queryable,
  schemas: DataSchemas,
  viewId: string,
): Promise<StoredSchedule[]> {
  const result = await query<ScheduleRow>(db, scheduleSelect(schemas, sql`s.view_id = ${viewId}`));
  return withRecipients(db, schemas, result.rows);
}

/** Every schedule in the organization the person owns or receives. */
export async function personSchedules(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  userId: string,
): Promise<StoredSchedule[]> {
  const t = tables(schemas);
  const result = await query<ScheduleRow>(
    db,
    scheduleSelect(
      schemas,
      sql`s.org_id = ${orgId} AND (s.owner_id = ${userId} OR EXISTS (
        SELECT 1 FROM ${t.recipients} r WHERE r.report_id = s.id AND r.user_id = ${userId}))`,
    ),
  );
  return withRecipients(db, schemas, result.rows);
}

/** Replaces a schedule's recipients, keeping the order given. */
export async function saveRecipients(
  db: Queryable,
  schemas: DataSchemas,
  reportId: string,
  recipients: readonly ReportRecipient[],
): Promise<void> {
  const t = tables(schemas);
  await query(db, sql`DELETE FROM ${t.recipients} WHERE report_id = ${reportId}`);
  if (!recipients.length) return;
  await query(
    db,
    sql`INSERT INTO ${t.recipients} (report_id, position, user_id, address)
    SELECT ${reportId}, r.position, r.user_id, r.address
    FROM unnest(${recipients.map((_, index) => index)}::int[],
      ${recipients.map((recipient) => (recipient.kind === 'member' ? recipient.userId : null))}::text[],
      ${recipients.map((recipient) => (recipient.kind === 'address' ? recipient.address : null))}::text[])
      AS r(position, user_id, address)`,
  );
}

/** Whether the organization lets reports go to addresses outside it. */
export async function outsideRecipientsAllowed(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  person?: string | PolicyPerson,
): Promise<boolean> {
  // For a person, their unit's policy decides, which starts from the organization's switch.
  const who = typeof person === 'string' ? { orgId, userId: person } : person;
  if (who) return policyAllows(db, `"${schemas.app}"`, who, 'reportOutsideRecipients', 'externalSharing');
  const result = await query<{ allowed: boolean }>(
    db,
    sql`SELECT report_outside_recipients AS allowed FROM ${tables(schemas).orgs} WHERE id = ${orgId}`,
  );
  return result.rows[0]?.allowed ?? false;
}

export function recipientInfo(recipient: StoredRecipient): ReportRecipientInfo {
  return recipient.kind === 'member'
    ? { kind: 'member', userId: recipient.userId, name: recipient.name }
    : { kind: 'address', address: recipient.address };
}

/** What the person asking may see and do with a schedule. */
export interface Viewer {
  userId: string;
  /** Whether they can change the schedule's view */
  canChangeView: boolean;
  /** Whether they manage the schedule's database */
  canManage: boolean;
}

export function toSchedule(stored: StoredSchedule, viewer: Viewer): ReportSchedule {
  const owner = stored.ownerId === viewer.userId;
  return {
    id: stored.id,
    databaseId: stored.databaseId,
    tableId: stored.tableId,
    viewId: stored.viewId,
    databaseName: stored.databaseName,
    tableName: stored.tableName,
    viewName: stored.viewName,
    name: stored.name,
    format: stored.format,
    frequency: stored.frequency,
    timeZone: stored.timeZone,
    enabled: stored.enabled,
    // Who else gets it is for the people who decide that.
    recipients: owner || viewer.canChangeView ? stored.recipients.map(recipientInfo) : [],
    owner: { id: stored.ownerId, name: stored.ownerName },
    nextRunAt: stored.nextRunAt?.toISOString() ?? null,
    lastRunAt: stored.lastRunAt?.toISOString() ?? null,
    stoppedBecause: stored.stoppedBecause,
    createdAt: stored.createdAt.toISOString(),
    updatedAt: stored.updatedAt.toISOString(),
    canEdit: owner,
    canDelete: owner || viewer.canManage,
    receiving: stored.recipients.some(
      (recipient) => recipient.kind === 'member' && recipient.userId === viewer.userId,
    ),
  };
}

/** A run as the app shows it, with members named as they are now. */
export function runOf(row: RunRow, names: ReadonlyMap<string, string>): ReportRun {
  return {
    id: row.id,
    trigger: row.trigger,
    state: row.state,
    dueAt: row.due_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    retryAt: row.retry_at?.toISOString() ?? null,
    attempts: row.attempts,
    deliveries: row.deliveries.map((delivery) => ({
      recipient:
        delivery.recipient.kind === 'member'
          ? {
              kind: 'member',
              userId: delivery.recipient.userId,
              name: names.get(delivery.recipient.userId) ?? '',
            }
          : delivery.recipient,
      state: delivery.state,
      records: delivery.records,
      attachment: delivery.attachment,
      attempts: delivery.attempts,
      error: delivery.error,
      ...(delivery.notes?.length ? { notes: delivery.notes } : {}),
    })),
    error: row.error ? { messageKey: row.error } : null,
  };
}

/** The names of the members runs mention. */
export async function memberNames(
  db: Queryable,
  schemas: DataSchemas,
  rows: readonly RunRow[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      rows.flatMap((row) =>
        row.deliveries.flatMap((delivery) =>
          delivery.recipient.kind === 'member' ? [delivery.recipient.userId] : [],
        ),
      ),
    ),
  ];
  if (!ids.length) return new Map();
  const result = await query<{ id: string; name: string }>(
    db,
    sql`SELECT id, name FROM ${tables(schemas).users} WHERE id = ANY(${ids}::text[])`,
  );
  return new Map(result.rows.map((row) => [row.id, row.name]));
}
