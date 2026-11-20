import { randomUUID } from 'node:crypto';
import {
  AppError,
  newId,
  type DigestSchedule,
  type NotificationChannelPreferences,
  type NotificationKind,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { AppContext } from '../app.js';
import type { Actor } from '../http/policy.js';
import { digestSlot } from '../notifications/digest.js';
import {
  activeMember,
  notificationFor,
  toNotification,
  type NotificationRow,
} from '../notifications/store.js';
import { organizationAdmin } from '../org-units/store.js';
import { AccessScope } from './access.js';
import { dataStore, type DataSchemas } from './context.js';
import {
  channelChosen,
  channelPreferences,
  choices,
  readPolicy,
  readPreferences,
  type StoredPreferences,
} from './notifications.js';

export interface DeliveryRow {
  id: string;
  org_id: string;
  user_id: string;
  notification_id: string | null;
  channel: 'push' | 'slack' | 'teams' | 'sms' | 'digest' | 'verify';
  device_id: string | null;
  payload: { ids?: string[]; sealed?: string } | null;
}
export const CHANNEL_BATCH = 20;

/** The outbox is filled only after the producing transaction commits. */
export async function queueNotificationChannels(ctx: AppContext): Promise<void> {
  const { pool, schemas } = dataStore(ctx);
  for (;;) {
    const count = await withTransaction(pool, async (db) => {
      const rows = await query<{ id: string; org_id: string; recipient_id: string; kind: NotificationKind }>(
        db,
        sql`SELECT id, org_id, recipient_id, kind FROM ${ident(schemas.app, 'notifications')}
        WHERE channels_queued = false ORDER BY created_at, id LIMIT ${CHANNEL_BATCH} FOR UPDATE SKIP LOCKED`,
      );
      for (const row of rows.rows) {
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'notifications')} SET channels_queued = true WHERE id = ${row.id}`,
        );
        const actor = await activeMember(db, schemas, row.org_id, row.recipient_id);
        if (!actor) continue;
        let preferences: NotificationChannelPreferences;
        try {
          preferences = await channelPreferences(
            db,
            schemas,
            ctx.config.secretKey,
            actor,
            Boolean(ctx.mailer && ctx.config.baseUrl),
            Boolean(ctx.config.baseUrl),
          );
        } catch (error) {
          // Only the person's own phone record is read here.  It uses the server's own key, not a
          // vault, so it holds back that person's messages without a vault alert.
          if (!(error instanceof AppError) || error.messageKey !== 'notifications.credentials.unavailable')
            throw error;
          continue;
        }
        for (const channel of ['push', 'slack', 'teams', 'sms'] as const) {
          if (!channelChosen(preferences, row.kind, channel) || !preferences.available[channel]) continue;
          const devices = channel === 'push' ? preferences.devices.map((device) => device.id) : [null];
          for (const device of devices)
            await query(
              db,
              sql`INSERT INTO ${ident(schemas.app, 'notification_deliveries')}
            (id, org_id, user_id, notification_id, channel, device_id)
            VALUES (${randomUUID()}, ${row.org_id}, ${row.recipient_id}, ${row.id}, ${channel}, ${device})`,
            );
        }
      }
      return rows.rows.length;
    });
    if (count < CHANNEL_BATCH) return;
  }
}

export async function queueDigests(ctx: AppContext, now = new Date()): Promise<void> {
  if (!ctx.mailer || !ctx.config.baseUrl) return;
  const { pool, schemas } = dataStore(ctx);
  await withTransaction(pool, async (db) => {
    const acquired = await query<{ locked: boolean }>(
      db,
      sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`${schemas.app}:digests`}, 0)) AS locked`,
    );
    if (!acquired.rows[0]?.locked) return;
    const rows = await query<
      StoredPreferences & { org_id: string; user_id: string; digest_slot: string | null }
    >(
      db,
      sql`SELECT org_id, user_id, email, channels, digest, digest_slot FROM ${ident(schemas.app, 'notification_preferences')}
      WHERE digest ->> 'frequency' IN ('daily', 'weekly') FOR UPDATE SKIP LOCKED`,
    );
    for (const row of rows.rows) {
      const slot = digestSlot(row.digest as DigestSchedule, now);
      if (!slot || slot === row.digest_slot) continue;
      const actor = await activeMember(db, schemas, row.org_id, row.user_id);
      if (!actor || !(await readPolicy(db, schemas, actor)).digest) continue;
      const kinds = Object.entries(row.channels.digest ?? {})
        .filter(([, on]) => on)
        .map(([kind]) => kind);
      const unread = await query<{ id: string }>(
        db,
        sql`SELECT n.id FROM ${ident(schemas.app, 'notifications')} n
        WHERE n.org_id = ${row.org_id} AND n.recipient_id = ${row.user_id} AND n.read_at IS NULL
        AND n.digested_at IS NULL AND n.kind = ANY(${kinds}::text[])
        AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'notification_deliveries')} d
          WHERE d.channel = 'digest' AND d.state IN ('pending', 'sending') AND d.user_id = ${row.user_id}
          AND d.org_id = ${row.org_id} AND d.payload -> 'ids' @> to_jsonb(n.id))
        ORDER BY n.created_at, n.id`,
      );
      if (unread.rowCount)
        await query(
          db,
          sql`INSERT INTO ${ident(schemas.app, 'notification_deliveries')}(id, org_id, user_id, channel, payload)
        VALUES (${randomUUID()}, ${row.org_id}, ${row.user_id}, 'digest', ${JSON.stringify({ ids: unread.rows.map((item) => item.id) })}::jsonb)`,
        );
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'notification_preferences')} SET digest_slot = ${slot}
        WHERE org_id = ${row.org_id} AND user_id = ${row.user_id}`,
      );
    }
  });
}

export async function claimChannelDeliveries(ctx: AppContext): Promise<DeliveryRow[]> {
  const { pool, schemas } = dataStore(ctx);
  const result = await query<DeliveryRow>(
    pool,
    sql`WITH next AS (
    SELECT id FROM ${ident(schemas.app, 'notification_deliveries')} WHERE state = 'pending' ORDER BY created_at, id LIMIT ${CHANNEL_BATCH} FOR UPDATE SKIP LOCKED
    ) UPDATE ${ident(schemas.app, 'notification_deliveries')} d SET state = 'sending' FROM next WHERE d.id = next.id RETURNING d.*`,
  );
  return result.rows;
}
export async function markChannelDelivery(
  ctx: AppContext,
  id: string,
  state: 'sent' | 'failed' | 'skipped',
): Promise<void> {
  const { pool, schemas } = dataStore(ctx);
  await withTransaction(pool, async (db) => {
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'notification_deliveries')}
      SET state = ${state}, payload = NULL WHERE id = ${id}`,
    );
  });
}
/** Only what a sent digest actually listed is marked, so nothing committed late can be skipped. */
export async function markDigested(ctx: AppContext, actor: Actor, ids: string[]): Promise<void> {
  const { pool, schemas } = dataStore(ctx);
  await query(
    pool,
    sql`UPDATE ${ident(schemas.app, 'notifications')} SET digested_at = now()
    WHERE org_id = ${actor.orgId} AND recipient_id = ${actor.userId} AND id = ANY(${ids}::text[])`,
  );
}
export async function recipientInfo(db: Queryable, schemas: DataSchemas, actor: Actor) {
  await new AccessScope(db, schemas, actor).requireOrganization();
  const result = await query<{ email: string; locale: string }>(
    db,
    sql`SELECT email, locale FROM ${ident(schemas.app, 'users')} WHERE id = ${actor.userId} AND deactivated_at IS NULL`,
  );
  return result.rows[0]!;
}

export async function deliverableNotifications(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  ids: string[],
) {
  const scope = new AccessScope(db, schemas, actor);
  await scope.requireOrganization();
  const result = await query<NotificationRow>(
    db,
    sql`SELECT id, kind, actor_id, NULL AS actor_name, target, created_at, read_at
    FROM ${ident(schemas.app, 'notifications')} WHERE org_id = ${actor.orgId} AND recipient_id = ${actor.userId}
    AND id = ANY(${ids}::text[]) AND read_at IS NULL ORDER BY created_at, id`,
  );
  const found = [];
  for (const row of result.rows) {
    const notification = toNotification(row);
    if (!notification) continue;
    const shown = await notificationFor(db, schemas, scope, notification);
    if (shown) found.push(shown);
  }
  return found;
}

/** Claiming a rate slot under one lock keeps several delivery workers within the same limit. */
export async function claimSmsSlot(
  ctx: AppContext,
  actor: Actor,
  id: string,
  now = new Date(),
): Promise<boolean> {
  const { pool, schemas } = dataStore(ctx);
  return withTransaction(pool, async (db) => {
    await new AccessScope(db, schemas, actor).requireOrganization();
    await query(
      db,
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:sms:${actor.orgId}:${actor.userId}`}, 0))`,
    );
    const recent = await query<{ count: number }>(
      db,
      sql`SELECT count(*)::int AS count FROM ${ident(schemas.app, 'notification_deliveries')}
      WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId} AND channel = 'sms'
      AND attempted_at > ${new Date(now.getTime() - 3_600_000)} AND id <> ${id}`,
    );
    if (recent.rows[0]!.count >= 3) return false;
    await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'notification_deliveries')} SET attempted_at = ${now} WHERE id = ${id}`,
    );
    return true;
  });
}

const ALERT_ACTIONS: Record<string, NotificationKind> = {
  'auth.second_step.failed': 'securityEvent',
  'auth.recovery_code.used': 'securityEvent',
  'auth.authenticator.disabled': 'securityEvent',
  'organization.export.failed': 'backupFailed',
  'backups.failed': 'backupFailed',
  // A credential profile that failed alerts the owner and Security administrators itself, with a
  // kind of its own, and is skipped below.  What reaches this map is one of the organization's own
  // notification connections that couldn't be read because its vault couldn't be reached.  Only the
  // owner and Integrations administrators hear about it, since only they can reconnect it.
  'credentials.unavailable': 'vaultUnavailable',
  'updates.update_failed': 'updateFailed',
};
/** Audit events are durable producer inputs, so failures are announced even after a restart. */
export async function queueAdminAlerts(ctx: AppContext): Promise<void> {
  const { pool, schemas } = dataStore(ctx);
  await withTransaction(pool, async (db) => {
    const events = await query<{
      id: string;
      org_id: string;
      action: string;
      metadata: { problem?: string; profile?: string };
    }>(
      db,
      sql`SELECT e.id::text, e.org_id, e.action, e.metadata FROM ${ident(schemas.audit, 'events')} e
      WHERE e.org_id IS NOT NULL AND e.action = ANY(${Object.keys(ALERT_ACTIONS)}::text[])
      AND e.at > now() - interval '1 day' AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'notification_alert_events')} p WHERE p.event_id = e.id::text)
      ORDER BY e.id LIMIT 50`,
    );
    for (const event of events.rows) {
      const claim = await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'notification_alert_events')}(event_id) VALUES (${event.id}) ON CONFLICT DO NOTHING RETURNING event_id`,
      );
      if (!claim.rowCount) continue;
      if (event.action === 'credentials.unavailable' && event.metadata.profile) continue;
      const kind =
        event.action === 'updates.update_failed' && event.metadata.problem === 'backupFailed'
          ? 'backupFailed'
          : ALERT_ACTIONS[event.action]!;
      const admins = await query<{ user_id: string }>(
        db,
        sql`SELECT m.user_id FROM ${ident(schemas.app, 'memberships')} m
        JOIN ${ident(schemas.app, 'users')} u ON u.id = m.user_id
        WHERE m.org_id = ${event.org_id} AND u.deactivated_at IS NULL AND (m.kind = 'owner' OR (m.kind <> 'guest' AND cardinality(m.admin_roles) > 0))`,
      );
      for (const admin of admins.rows) {
        const actor = await activeMember(db, schemas, event.org_id, admin.user_id);
        if (!actor) continue;
        // The organization's channels open only for the owner and Integrations administrators, as
        // with a custom domain that lost its verification.
        if (kind === 'vaultUnavailable' && !organizationAdmin(actor, 'integrations')) continue;
        const stored = await readPreferences(db, schemas, actor);
        const selected = choices(stored);
        const policy = await readPolicy(db, schemas, actor);
        const instant =
          policy.email &&
          selected.email[kind] &&
          !(stored.digest.frequency !== 'off' && policy.digest && selected.digest[kind]);
        await query(
          db,
          sql`INSERT INTO ${ident(schemas.app, 'notifications')}(id, org_id, recipient_id, kind, subject_id, target, email)
          VALUES (${newId('notification')}, ${event.org_id}, ${admin.user_id}, ${kind}, ${event.id}, '{}', ${instant ? 'pending' : 'none'})`,
        );
      }
    }
    await query(
      db,
      sql`DELETE FROM ${ident(schemas.app, 'notification_alert_events')} WHERE created_at < now() - interval '2 days'`,
    );
    await query(
      db,
      sql`DELETE FROM ${ident(schemas.app, 'notification_deliveries')} WHERE created_at < now() - interval '90 days'`,
    );
  });
}

/**
 * Records that one of an organization's own notification connections couldn't be read because the
 * vault that holds it couldn't be reached, at most once an hour.  A person's phone record and the
 * installation's push key use the server's own key, so their failures never come here, and a
 * credential profile's own failure doesn't count toward the hour.  The audit event is what the
 * admin alerts fan out from, so the notice survives a restart, and one vault failure doesn't alert
 * for every message.
 */
export async function recordCredentialAlert(ctx: AppContext, orgId: string): Promise<void> {
  const { pool, schemas } = dataStore(ctx);
  await withTransaction(pool, async (db) => {
    await query(
      db,
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:credential-alert:${orgId}`}, 0))`,
    );
    await query(
      db,
      sql`INSERT INTO ${ident(schemas.audit, 'events')}(org_id, action)
      SELECT ${orgId}, 'credentials.unavailable' WHERE NOT EXISTS (
        SELECT 1 FROM ${ident(schemas.audit, 'events')} WHERE org_id = ${orgId}
        AND action = 'credentials.unavailable' AND metadata ->> 'profile' IS NULL
        AND at > now() - interval '1 hour'
      )`,
    );
  });
}
