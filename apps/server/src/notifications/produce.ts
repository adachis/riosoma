import { commentFields } from '../data/comments.js';
import {
  EXCERPT_LENGTH,
  MENTION_PATTERN,
  newId,
  type AutomationRun,
  type ChangeBody,
  type DatabaseRole,
  type NotificationKind,
  type NotificationReason,
  type NotificationTarget,
  type RecordComment,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import { choices, readPolicy, readPreferences } from '../data/notifications.js';
import { AccessScope } from '../data/access.js';
import type { CommandContext } from '../data/commands/context.js';
import type { DataSchemas } from '../data/context.js';
import { activeMember } from './store.js';

/**
 * The producers.  Each writes its notifications inside the transaction of the change that caused
 * them, so a change that rolls back leaves nothing behind, and each notification's email waits,
 * marked pending, until the delivery worker sees it after commit.
 */

export interface NewNotification {
  orgId: string;
  recipientId: string;
  kind: NotificationKind;
  /** The person who caused it, or null for what an automation or a sync did on its own */
  actorId: string | null;
  /** What it's about: the comment, database, automation, table, report, or feedback */
  subjectId: string;
  target: NotificationTarget;
  /** Only when the recipient can read the target's database */
  readersOnly?: boolean;
  /** Only when the recipient can see this record, as its table's record rules decide */
  record?: { tableId: string; recordId: string; fieldId?: string };
}

/**
 * Records one notification.  Nobody hears about their own doing, and people who've left the
 * organization hear nothing.  Returns whether it was recorded.
 */
export async function notify(db: Queryable, schemas: DataSchemas, input: NewNotification): Promise<boolean> {
  if (input.actorId !== null && input.actorId === input.recipientId) return false;
  const person = await activeMember(db, schemas, input.orgId, input.recipientId);
  if (!person) return false;
  const scope = new AccessScope(db, schemas, person);
  // A notification about no database, such as a reply to feedback, has no readers to check.
  const databaseId = input.target.databaseId;
  if (input.readersOnly && (!databaseId || !(await scope.databaseRole(databaseId)))) return false;
  if (input.record) {
    // Someone a record rule keeps from the record never hears about it, not even its ID.
    if (!databaseId || !(await scope.databaseRole(databaseId))) return false;
    await scope.prepare(databaseId);
    if (
      input.record.fieldId &&
      !(await commentFields(db, schemas, scope, input.record.tableId)).has(input.record.fieldId)
    )
      return false;
    const seen = await query(
      db,
      sql`SELECT 1 FROM ${ident(schemas.data, input.record.tableId)} WHERE __id = ${input.record.recordId}
        AND (${scope.recordPredicate(input.record.tableId)})`,
    );
    if (!seen.rowCount) return false;
  }
  const preferences = await readPreferences(db, schemas, person);
  const channels = choices(preferences);
  const policy = await readPolicy(db, schemas, person);
  const digest = preferences.digest.frequency !== 'off' && policy.digest && channels.digest[input.kind];
  const email = input.kind === 'adminRolesChanged' || (policy.email && channels.email[input.kind] && !digest);
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.app, 'notifications')}
    (id, org_id, recipient_id, kind, actor_id, subject_id, target, email)
    VALUES (${newId('notification')}, ${input.orgId}, ${input.recipientId}, ${input.kind}, ${input.actorId},
      ${input.subjectId}, ${JSON.stringify(input.target)}::jsonb, ${email && input.kind !== 'fileScan' ? 'pending' : 'none'})`,
  );
  return true;
}

/**
 * A comment's first characters as plain text: each mention written as `@Name`, runs of spaces and
 * line breaks as one space, and an ellipsis when there was more.
 */
export function excerpt(body: string, names: ReadonlyMap<string, string>): string {
  const text = body
    .replace(MENTION_PATTERN, (_markup: string, written: string, id: string) => {
      return `@${names.get(id) || written.trim()}`;
    })
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(text);
  if (characters.length <= EXCERPT_LENGTH) return text;
  return `${characters
    .slice(0, EXCERPT_LENGTH - 1)
    .join('')
    .trimEnd()}…`;
}

/** A table's name and database's name, and the view a link to one of its records opens in. */
async function tablePlace(
  db: Queryable,
  schemas: DataSchemas,
  tableId: string,
): Promise<{
  orgId: string;
  databaseId: string;
  databaseName: string;
  tableName: string;
  createdBy: string | null;
  viewId: string | null;
} | null> {
  const result = await query<{
    org_id: string;
    database_id: string;
    database_name: string;
    table_name: string;
    created_by: string | null;
    view_id: string | null;
  }>(
    db,
    sql`SELECT t.org_id, t.database_id, d.name AS database_name, t.name AS table_name, t.created_by, (
      SELECT v.id FROM ${ident(schemas.app, 'views')} v WHERE v.table_id = t.id AND v.trashed_at IS NULL
      ORDER BY v.type = 'form', v.position, v.id LIMIT 1
    ) AS view_id
    FROM ${ident(schemas.app, 'tables')} t
    JOIN ${ident(schemas.app, 'databases')} d ON d.id = t.database_id
    WHERE t.id = ${tableId}`,
  );
  const row = result.rows[0];
  return row
    ? {
        orgId: row.org_id,
        databaseId: row.database_id,
        databaseName: row.database_name,
        tableName: row.table_name,
        createdBy: row.created_by,
        viewId: row.view_id,
      }
    : null;
}

async function databaseName(db: Queryable, schemas: DataSchemas, databaseId: string): Promise<string | null> {
  const result = await query<{ name: string }>(
    db,
    sql`SELECT name FROM ${ident(schemas.app, 'databases')} WHERE id = ${databaseId}`,
  );
  return result.rows[0]?.name ?? null;
}

/**
 * Mentions, from each change the command bus records: everyone a new comment mentions, and the
 * people an edit mentions for the first time.  Never the author, and only people who can read the
 * database.  A deleted comment takes its mentions' notifications with it, so its words don't
 * outlive it.
 */
export async function notifyChange(c: CommandContext, body: ChangeBody): Promise<void> {
  if (body.kind === 'comment.deleted') {
    await query(
      c.db,
      sql`DELETE FROM ${ident(c.schemas.app, 'notifications')}
      WHERE subject_id = ${body.commentId} AND kind = 'mention' AND org_id = ${c.actor.orgId}`,
    );
    return;
  }
  if (body.kind === 'comment.created' || body.kind === 'comment.updated')
    await notifyMentions(c, body.comment, body.kind === 'comment.updated');
}

async function notifyMentions(c: CommandContext, comment: RecordComment, edited: boolean): Promise<void> {
  const author = comment.authorId ?? c.actor.userId;
  let recipients = comment.mentions.filter((id) => id !== author && id !== c.actor.userId);
  if (edited && recipients.length) {
    // An edit tells only the people this comment hasn't told yet.
    const told = await query<{ recipient_id: string }>(
      c.db,
      sql`SELECT recipient_id FROM ${ident(c.schemas.app, 'notifications')}
      WHERE subject_id = ${comment.id} AND kind = 'mention' AND recipient_id = ANY(${recipients}::text[])`,
    );
    const already = new Set(told.rows.map((row) => row.recipient_id));
    recipients = recipients.filter((id) => !already.has(id));
  }
  if (!recipients.length) return;
  const place = await tablePlace(c.db, c.schemas, comment.tableId);
  if (!place) return;
  // Names as the thread shows them: the person's name now, for everyone who can read the database.
  const people = await query<{ id: string; name: string }>(
    c.db,
    sql`SELECT id, name FROM ${ident(c.schemas.app, 'users')} WHERE id = ANY(${comment.mentions}::text[])`,
  );
  const names = new Map(people.rows.map((person) => [person.id, person.name.trim()]));
  const target: NotificationTarget = {
    databaseId: c.databaseId,
    databaseName: place.databaseName,
    tableId: comment.tableId,
    tableName: place.tableName,
    ...(place.viewId ? { viewId: place.viewId } : {}),
    recordId: comment.recordId,
    commentId: comment.id,
    ...(comment.fieldId ? { fieldId: comment.fieldId } : {}),
    excerpt: excerpt(comment.body, names),
  };
  for (const recipientId of recipients)
    await notify(c.db, c.schemas, {
      orgId: c.actor.orgId,
      recipientId,
      kind: 'mention',
      actorId: author,
      subjectId: comment.id,
      target,
      readersOnly: true,
      record: { tableId: comment.tableId, recordId: comment.recordId, fieldId: comment.fieldId },
    });
}

/** Someone was given a database of their own to open.  The person who gave it isn't told. */
export async function notifyShare(
  db: Queryable,
  schemas: DataSchemas,
  share: { orgId: string; actorId: string; recipientId: string; databaseId: string; role: DatabaseRole },
): Promise<boolean> {
  const name = await databaseName(db, schemas, share.databaseId);
  if (name === null) return false;
  return notify(db, schemas, {
    orgId: share.orgId,
    recipientId: share.recipientId,
    kind: 'share',
    actorId: share.actorId,
    subjectId: share.databaseId,
    target: { databaseId: share.databaseId, databaseName: name, role: share.role },
    readersOnly: true,
  });
}

/**
 * An automation turned itself off.  Its person hears about it even when losing access is why,
 * since that's exactly what they need to know.
 */
export async function notifyAutomationStopped(
  db: Queryable,
  schemas: DataSchemas,
  automation: { id: string; orgId: string; databaseId: string; name: string; runAsId: string | null },
  reason: string,
): Promise<boolean> {
  if (!automation.runAsId) return false;
  const name = await databaseName(db, schemas, automation.databaseId);
  if (name === null) return false;
  return notify(db, schemas, {
    orgId: automation.orgId,
    recipientId: automation.runAsId,
    kind: 'automationStopped',
    actorId: null,
    subjectId: automation.id,
    target: {
      databaseId: automation.databaseId,
      databaseName: name,
      automationId: automation.id,
      automationName: automation.name,
      reason: { messageKey: reason },
    },
  });
}

/**
 * A scheduled report turned itself off, because its view went or its owner can no longer open
 * the database.  Its owner hears about it either way, since that's what they need to know.
 */
export async function notifyReportStopped(
  db: Queryable,
  schemas: DataSchemas,
  report: {
    id: string;
    orgId: string;
    databaseId: string;
    databaseName: string;
    tableId: string;
    tableName: string;
    viewId: string;
    name: string;
    ownerId: string;
  },
  reason: string,
): Promise<boolean> {
  return notify(db, schemas, {
    orgId: report.orgId,
    recipientId: report.ownerId,
    kind: 'reportStopped',
    actorId: null,
    subjectId: report.id,
    target: {
      databaseId: report.databaseId,
      databaseName: report.databaseName,
      tableId: report.tableId,
      tableName: report.tableName,
      viewId: report.viewId,
      reportId: report.id,
      reportName: report.name,
      reason: { messageKey: reason },
    },
  });
}

/** How long a failing automation stays quiet after telling its person, per person */
export const FAILURE_QUIET_MS = 3_600_000;

/**
 * A run failed.  Its automation's person hears about it at most once an hour, so an automation
 * failing on every record doesn't bury everything else.
 */
export async function notifyRunFailed(
  db: Queryable,
  schemas: DataSchemas,
  run: { automation_id: string; steps: AutomationRun['steps'] },
): Promise<boolean> {
  const result = await query<{
    org_id: string;
    database_id: string;
    name: string;
    run_as_id: string | null;
    database_name: string;
  }>(
    db,
    sql`SELECT a.org_id, a.database_id, a.name, a.run_as_id, d.name AS database_name
    FROM ${ident(schemas.app, 'automations')} a
    JOIN ${ident(schemas.app, 'databases')} d ON d.id = a.database_id WHERE a.id = ${run.automation_id}`,
  );
  const automation = result.rows[0];
  if (!automation?.run_as_id) return false;
  // One failure at a time decides for each automation and person, so two can't both pass the check.
  await query(
    db,
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:notify:automationFailed:${run.automation_id}:${automation.run_as_id}`}, 0))`,
  );
  const recent = await query(
    db,
    sql`SELECT 1 FROM ${ident(schemas.app, 'notifications')}
    WHERE subject_id = ${run.automation_id} AND recipient_id = ${automation.run_as_id}
      AND kind = 'automationFailed'
      AND created_at > statement_timestamp() - ${FAILURE_QUIET_MS} * interval '1 millisecond'
    LIMIT 1`,
  );
  if (recent.rowCount) return false;
  const failure = run.steps.find((step) => step.state === 'failed')?.error;
  return notify(db, schemas, {
    orgId: automation.org_id,
    recipientId: automation.run_as_id,
    kind: 'automationFailed',
    actorId: null,
    subjectId: run.automation_id,
    target: {
      databaseId: automation.database_id,
      databaseName: automation.database_name,
      automationId: run.automation_id,
      automationName: automation.name,
      ...(failure ? { reason: { messageKey: failure.messageKey } } : {}),
    },
  });
}

/**
 * A person undid changes from an automation, but its calendar event couldn't be removed from their
 * calendar: the calendar refused, or kept failing until the tries ran out.  They hear why, since
 * the event is still there for them to remove.
 */
export async function notifyCalendarEventKept(
  db: Queryable,
  schemas: DataSchemas,
  removal: { orgId: string; userId: string; databaseId: string; automationId: string },
  reason: string,
): Promise<boolean> {
  const result = await query<{ name: string; database_name: string }>(
    db,
    sql`SELECT a.name, d.name AS database_name FROM ${ident(schemas.app, 'automations')} a
    JOIN ${ident(schemas.app, 'databases')} d ON d.id = a.database_id
    WHERE a.id = ${removal.automationId} AND a.org_id = ${removal.orgId} AND d.id = ${removal.databaseId}`,
  );
  const automation = result.rows[0];
  if (!automation) return false;
  return notify(db, schemas, {
    orgId: removal.orgId,
    recipientId: removal.userId,
    kind: 'calendarEventKept',
    actorId: null,
    subjectId: removal.automationId,
    target: {
      databaseId: removal.databaseId,
      databaseName: automation.database_name,
      automationId: removal.automationId,
      automationName: automation.name,
      reason: { messageKey: reason },
    },
  });
}

/** A reason with only the parameters a message can show: text, numbers, and yes or no. */
export function reasonOf(messageKey: string, params?: Record<string, unknown>): NotificationReason {
  const shown = Object.entries(params ?? {}).filter(
    (entry): entry is [string, string | number | boolean] =>
      typeof entry[1] === 'string' || typeof entry[1] === 'number' || typeof entry[1] === 'boolean',
  );
  return shown.length ? { messageKey, params: Object.fromEntries(shown) } : { messageKey };
}

/**
 * A synced table stopped syncing, or is waiting for someone to confirm removals.  Its creator
 * hears about it while they can still read it.  Callers send one per change of state, not one per
 * try.
 */
export async function notifySync(
  db: Queryable,
  schemas: DataSchemas,
  kind: 'syncFailed' | 'syncHeld',
  tableId: string,
  detail: { reason?: NotificationReason; held?: { removing: number; total: number } },
): Promise<boolean> {
  const place = await tablePlace(db, schemas, tableId);
  if (!place?.createdBy) return false;
  return notify(db, schemas, {
    orgId: place.orgId,
    recipientId: place.createdBy,
    kind,
    actorId: null,
    subjectId: tableId,
    target: {
      databaseId: place.databaseId,
      databaseName: place.databaseName,
      tableId,
      tableName: place.tableName,
      ...detail,
    },
    readersOnly: true,
  });
}

/**
 * An admin replied to feedback someone sent.  The sender hears about it with the reply's first
 * words, and the notification goes with the feedback if it's deleted.
 */
export async function notifyFeedbackReply(
  db: Queryable,
  schemas: DataSchemas,
  reply: { orgId: string; feedbackId: string; senderId: string; authorId: string; body: string },
): Promise<boolean> {
  return notify(db, schemas, {
    orgId: reply.orgId,
    recipientId: reply.senderId,
    kind: 'feedbackReply',
    actorId: reply.authorId,
    subjectId: reply.feedbackId,
    target: { feedbackId: reply.feedbackId, excerpt: excerpt(reply.body, new Map()) },
  });
}

/**
 * News about a routine for its owner: a run's report, something a run left for their approval, or
 * a pause and why.  The owner hears about a pause even when losing access is why, since that's
 * what they need to know.
 */
export async function notifyRoutine(
  db: Queryable,
  schemas: DataSchemas,
  kind: 'routineReport' | 'routineApproval' | 'routinePaused',
  routine: { id: string; orgId: string; databaseId: string; name: string; ownerId: string },
  detail: {
    runId?: string;
    approvalId?: string;
    groupId?: string;
    reason?: NotificationReason;
    /** Who a run emailed and how many pages it fetched, as the server recorded them */
    activity?: { sent: string[]; fetched: number };
  },
): Promise<boolean> {
  const name = await databaseName(db, schemas, routine.databaseId);
  if (name === null) return false;
  return notify(db, schemas, {
    orgId: routine.orgId,
    recipientId: routine.ownerId,
    kind,
    actorId: null,
    subjectId: detail.approvalId ?? routine.id,
    target: {
      databaseId: routine.databaseId,
      databaseName: name,
      routineId: routine.id,
      routineName: routine.name,
      ...(detail.runId ? { runId: detail.runId } : {}),
      ...(detail.approvalId ? { approvalId: detail.approvalId } : {}),
      ...(detail.groupId ? { groupId: detail.groupId } : {}),
      ...(detail.activity
        ? { routineSent: detail.activity.sent, routineFetched: detail.activity.fetched }
        : {}),
      ...(detail.reason ? { reason: detail.reason } : {}),
    },
  });
}
