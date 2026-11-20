import type { ProviderError } from '@riosoma/ai';
import { newId, type RioBlock } from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import type { AppContext } from '../app.js';
import { dataStore } from '../data/context.js';
import type { Actor } from '../http/policy.js';
import { organizationAdmin } from '../org-units/store.js';

type ErrorBlock = Extract<RioBlock, { kind: 'error' }>;

export async function gatewayChatError(
  ctx: AppContext,
  actor: Actor,
  providerId: string,
  error: ProviderError,
): Promise<ErrorBlock> {
  const { pool, schemas } = dataStore(ctx);
  await withTransaction(pool, async (db) => {
    // Concurrent failed conversations share one alert per gateway, recipient, and hour.
    await query(
      db,
      sql`SELECT pg_advisory_xact_lock(hashtext(${`gateway-error:${actor.orgId}:${providerId}`}))`,
    );
    const admins = await query<{ user_id: string }>(
      db,
      sql`SELECT m.user_id FROM ${ident(schemas.app, 'memberships')} m
      JOIN ${ident(schemas.app, 'users')} u ON u.id = m.user_id
      WHERE m.org_id = ${actor.orgId} AND u.deactivated_at IS NULL
      AND (m.kind = 'owner' OR (m.kind <> 'guest' AND 'ai' = ANY(m.admin_roles)))`,
    );
    const target = {
      gatewayProviderId: providerId,
      reason: { messageKey: error.messageKey, ...(error.params ? { params: error.params } : {}) },
    };
    for (const admin of admins.rows)
      // These alerts stay in the bell, where the reason is localized and linked to gateway settings.
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'notifications')}
        (id, org_id, recipient_id, kind, actor_id, subject_id, target, email, channels_queued, digested_at)
        SELECT ${newId('notification')}, ${actor.orgId}, ${admin.user_id}, 'securityEvent', NULL,
          ${providerId}, ${JSON.stringify(target)}::jsonb, 'none', true, now()
        WHERE NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'notifications')}
          WHERE org_id = ${actor.orgId} AND recipient_id = ${admin.user_id} AND kind = 'securityEvent'
          AND subject_id = ${providerId} AND created_at > now() - interval '1 hour')`,
      );
  });
  return organizationAdmin(actor, 'ai')
    ? {
        kind: 'error',
        messageKey: error.messageKey,
        providerId,
        ...(error.params ? { params: error.params } : {}),
      }
    : { kind: 'error', messageKey: 'rio.serviceUnavailable' };
}
