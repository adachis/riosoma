import {
  DEFAULT_NOTIFICATION_EMAIL,
  NOTIFICATION_KINDS,
  NOTIFICATION_RETENTION_DAYS,
  NotificationTarget,
  type Notification,
  type NotificationEmail,
  type NotificationKind,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import { scopedNotificationContent } from '../data/automation-notifications.js';
import { AccessScope } from '../data/access.js';
import { sourceDiagnostic } from '../data/permissions/redact.js';
import { commentFields } from '../data/comments.js';
import type { DataSchemas } from '../data/context.js';
import type { Actor } from '../http/policy.js';

/**
 * Reads and writes notifications and each person's email choices.  Notifications are written by
 * the producers in `produce.ts`, inside the transactions of the changes that cause them.
 */

export interface NotificationRow {
  id: string;
  kind: NotificationKind;
  actor_id: string | null;
  /** The actor's name as it is now, joined in by the reader */
  actor_name: string | null;
  target: unknown;
  created_at: Date;
  read_at: Date | null;
}

/** The public shape, or null for a stored target that no longer fits the contract. */
export function toNotification(row: NotificationRow): Notification | null {
  const target = NotificationTarget.safeParse(row.target);
  if (!target.success) return null;
  // A routine's report stays on its run's page, behind its owner's access to the database, so a
  // report notice saved with the report's start shows it no longer.
  if (row.kind === 'routineReport') delete target.data.excerpt;
  return {
    id: row.id,
    kind: row.kind,
    createdAt: row.created_at.toISOString(),
    readAt: row.read_at?.toISOString() ?? null,
    actor: row.actor_id ? { id: row.actor_id, name: row.actor_name ?? '' } : null,
    target: target.data,
  };
}

/** Stored cell excerpts follow the recipient's current access, including queued delivery. */
export async function notificationVisible(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  notification: Notification,
): Promise<boolean> {
  const target = notification.target;
  if (target.fieldId && (!target.databaseId || !target.tableId || !target.recordId)) return false;
  if (!target.databaseId) return true;
  if (!(await scope.databaseRole(target.databaseId))) return false;
  await scope.prepare(target.databaseId);
  if (
    target.tableId &&
    (target.recordId || notification.kind === 'syncFailed' || notification.kind === 'automationNotification')
  ) {
    const table = await query(
      db,
      sql`SELECT 1 FROM ${ident(schemas.app, 'tables')}
      WHERE id = ${target.tableId} AND database_id = ${target.databaseId} AND trashed_at IS NULL`,
    );
    if (!table.rowCount) return false;
    if (!target.recordId) return true;
    if (target.fieldId && !(await commentFields(db, schemas, scope, target.tableId)).has(target.fieldId))
      return false;
    const visible = await query(
      db,
      sql`SELECT 1 FROM ${ident(schemas.data, target.tableId)}
      WHERE __id = ${target.recordId} AND __deleted_at IS NULL AND NOT __source_gone
      AND (${scope.recordPredicate(target.tableId)})`,
    );
    if (!visible.rowCount) return false;
  }
  return true;
}

/** A notification with source diagnostics limited by the recipient's current access. */
export async function notificationFor(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  notification: Notification,
): Promise<Notification | null> {
  if (notification.kind === 'automationNotification' && notification.target.automationContent) {
    const rendered = await scopedNotificationContent(
      db,
      schemas,
      scope,
      notification.target.automationContent,
    );
    return {
      ...notification,
      target: { title: rendered.title, message: rendered.message, link: rendered.link },
    };
  }
  if (!(await notificationVisible(db, schemas, scope, notification))) return null;
  const { target } = notification;
  if (notification.kind !== 'syncFailed' || !target.reason || !target.databaseId || !target.tableId)
    return notification;
  const reason = sourceDiagnostic(
    target.reason,
    scope.limitsRecords(target.tableId),
    scope.hiddenFieldIds(target.databaseId, target.tableId),
  );
  return reason === target.reason ? notification : { ...notification, target: { ...target, reason } };
}

async function visibleCellRows(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  rows: NotificationRow[],
): Promise<NotificationRow[]> {
  const visible: NotificationRow[] = [];
  for (const row of rows) {
    const notification = toNotification(row);
    if (
      notification &&
      (notification.target.fieldId ||
        notification.kind === 'syncFailed' ||
        notification.kind === 'automationNotification')
    ) {
      const shown = await notificationFor(db, schemas, scope, notification);
      if (!shown) continue;
      visible.push({ ...row, target: shown.target });
    } else visible.push(row);
  }
  return visible;
}

/** The person as an actor while they're an active member of the organization, or null. */
export async function activeMember(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  userId: string,
): Promise<Actor | null> {
  const result = await query<{ kind: Actor['kind']; admin_roles: string[] }>(
    db,
    sql`SELECT m.kind, m.admin_roles FROM ${ident(schemas.app, 'memberships')} m
    JOIN ${ident(schemas.app, 'users')} u ON u.id = m.user_id
    WHERE m.org_id = ${orgId} AND m.user_id = ${userId} AND u.deactivated_at IS NULL`,
  );
  const row = result.rows[0];
  return row
    ? { userId, orgId, kind: row.kind, adminRoles: row.admin_roles, sessionId: '', csrfToken: '' }
    : null;
}

/** Every kind, each from the person's own choice where they made one and the default elsewhere. */
function withDefaults(stored: Record<string, unknown>): NotificationEmail {
  const email = { ...DEFAULT_NOTIFICATION_EMAIL };
  for (const kind of NOTIFICATION_KINDS) {
    const chosen = stored[kind];
    if (typeof chosen === 'boolean') email[kind] = chosen;
  }
  return email;
}

/** Which kinds the person gets by email as well as in the app. */
export async function emailChoices(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  userId: string,
): Promise<NotificationEmail> {
  const result = await query<{ email: Record<string, unknown> }>(
    db,
    sql`SELECT email FROM ${ident(schemas.app, 'notification_preferences')}
    WHERE org_id = ${orgId} AND user_id = ${userId}`,
  );
  return withDefaults(result.rows[0]?.email ?? {});
}

/**
 * Saves the kinds given and keeps the rest.  The merge happens in one statement, so two switches
 * flipped at once both stick.
 */
export async function saveEmailChoices(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  userId: string,
  changes: Partial<Record<NotificationKind, boolean>>,
): Promise<NotificationEmail> {
  const result = await query<{ email: Record<string, unknown> }>(
    db,
    sql`INSERT INTO ${ident(schemas.app, 'notification_preferences')} AS p (org_id, user_id, email)
    VALUES (${orgId}, ${userId}, ${JSON.stringify(changes)}::jsonb)
    ON CONFLICT (org_id, user_id) DO UPDATE SET email = p.email || EXCLUDED.email, updated_at = now()
    RETURNING email`,
  );
  return withDefaults(result.rows[0]!.email);
}

/** How many of the person's notifications are unread. */
export async function unreadCount(db: Queryable, schemas: DataSchemas, actor: Actor): Promise<number> {
  const scope = new AccessScope(db, schemas, actor);
  await scope.requireOrganization();
  const result = await query<{ count: string }>(
    db,
    sql`SELECT count(*) AS count FROM ${ident(schemas.app, 'notifications')} n
    LEFT JOIN ${ident(schemas.app, 'notification_preferences')} p ON p.org_id = n.org_id AND p.user_id = n.recipient_id
    LEFT JOIN ${ident(schemas.app, 'notification_organizations')} o ON o.org_id = n.org_id
    WHERE n.org_id = ${actor.orgId} AND n.recipient_id = ${actor.userId} AND n.read_at IS NULL
    AND COALESCE((p.channels -> 'bell' ->> n.kind)::boolean, true) AND COALESCE((o.enabled ->> 'bell')::boolean, true)`,
  );
  const cells = await query<NotificationRow>(
    db,
    sql`SELECT n.id, n.kind, n.actor_id, NULL AS actor_name, n.target, n.created_at, n.read_at
    FROM ${ident(schemas.app, 'notifications')} n
    LEFT JOIN ${ident(schemas.app, 'notification_preferences')} p ON p.org_id = n.org_id AND p.user_id = n.recipient_id
    LEFT JOIN ${ident(schemas.app, 'notification_organizations')} o ON o.org_id = n.org_id
    WHERE n.org_id = ${actor.orgId} AND n.recipient_id = ${actor.userId} AND n.read_at IS NULL
    AND (n.target ? 'fieldId' OR n.kind IN ('syncFailed', 'automationNotification'))
    AND COALESCE((p.channels -> 'bell' ->> n.kind)::boolean, true) AND COALESCE((o.enabled ->> 'bell')::boolean, true)`,
  );
  const visible = await visibleCellRows(db, schemas, scope, cells.rows);
  return Number(result.rows[0]!.count) - (cells.rows.length - visible.length);
}

/** Deletes notifications older than the retention period, a batch at a time. */
export async function purgeNotifications(
  db: Queryable,
  schemas: DataSchemas,
  now = new Date(),
): Promise<number> {
  const table = ident(schemas.app, 'notifications');
  const cutoff = new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * 86_400_000);
  let removed = 0;
  for (;;) {
    const result = await query(
      db,
      sql`DELETE FROM ${table} WHERE id IN (
        SELECT n.id FROM ${table} n WHERE n.created_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'databases')} d WHERE d.org_id = n.org_id AND d.legal_hold) LIMIT 5000
      )`,
    );
    removed += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < 5000) break;
  }
  return removed;
}

export async function listNotifications(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  cursor: { at: string; id: string } | null,
  limit: number,
): Promise<NotificationRow[]> {
  const scope = new AccessScope(db, schemas, actor);
  await scope.requireOrganization();
  const found: NotificationRow[] = [];
  let after = cursor;
  while (found.length < limit) {
    const size = limit - found.length;
    const result = await query<NotificationRow>(
      db,
      sql`SELECT n.id, n.kind, n.actor_id, u.name AS actor_name, n.target, n.created_at, n.read_at
      FROM ${ident(schemas.app, 'notifications')} n LEFT JOIN ${ident(schemas.app, 'users')} u ON u.id = n.actor_id
      LEFT JOIN ${ident(schemas.app, 'notification_preferences')} p ON p.org_id = n.org_id AND p.user_id = n.recipient_id
      LEFT JOIN ${ident(schemas.app, 'notification_organizations')} o ON o.org_id = n.org_id
      WHERE n.org_id = ${actor.orgId} AND n.recipient_id = ${actor.userId}
      AND COALESCE((p.channels -> 'bell' ->> n.kind)::boolean, true) AND COALESCE((o.enabled ->> 'bell')::boolean, true)
      AND ${after ? sql`(n.created_at, n.id) < (${after.at}::timestamptz, ${after.id})` : sql`TRUE`}
      ORDER BY n.created_at DESC, n.id DESC LIMIT ${size}`,
    );
    found.push(...(await visibleCellRows(db, schemas, scope, result.rows)));
    const last = result.rows.at(-1);
    if (!last || result.rows.length < size) break;
    after = { at: last.created_at.toISOString(), id: last.id };
  }
  return found;
}
