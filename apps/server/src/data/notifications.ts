import {
  AppError,
  DEFAULT_NOTIFICATION_EMAIL,
  DigestSchedule,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  adminNotification,
  type NotificationChannel,
  type NotificationChannelPreferences,
  type NotificationConnection,
  type NotificationEmail,
  type NotificationKind,
  type PushSubscriptionInput,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import { organizationAdmin } from '../org-units/store.js';
import { seal, unseal } from '../secrets.js';
import { unsealCredential } from '../credentials/service.js';
import type { Actor } from '../http/policy.js';
import { AccessScope } from './access.js';
import type { DataSchemas } from './context.js';
import type { CommandContext } from './commands/context.js';
import { createVapidKeys, type VapidKeys } from '../notifications/push.js';

export type ChannelMap = Record<NotificationChannel, NotificationEmail>;
export const channelDefaults = (): ChannelMap =>
  Object.fromEntries(
    NOTIFICATION_CHANNELS.map((channel) => [
      channel,
      Object.fromEntries(
        NOTIFICATION_KINDS.map((kind) => [
          kind,
          channel === 'bell' || (channel === 'email' && DEFAULT_NOTIFICATION_EMAIL[kind]),
        ]),
      ),
    ]),
  ) as ChannelMap;
export const channelPolicy = (stored: Partial<Record<NotificationChannel, boolean>> = {}) =>
  Object.fromEntries(NOTIFICATION_CHANNELS.map((channel) => [channel, stored[channel] ?? true])) as Record<
    NotificationChannel,
    boolean
  >;
export const canReceiveSms = (actor: Actor): boolean =>
  actor.kind === 'owner' || (actor.kind !== 'guest' && actor.adminRoles.length > 0);

export interface StoredPreferences {
  email: Partial<NotificationEmail>;
  channels: Partial<ChannelMap>;
  digest: DigestSchedule;
}
export async function readPreferences(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
): Promise<StoredPreferences> {
  await new AccessScope(db, schemas, actor).requireOrganization();
  const result = await query<StoredPreferences>(
    db,
    sql`SELECT email, channels, digest FROM ${ident(schemas.app, 'notification_preferences')}
    WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
  );
  return result.rows[0] ?? { email: {}, channels: {}, digest: DigestSchedule.parse({}) };
}
export function choices(stored: StoredPreferences): ChannelMap {
  const result = channelDefaults();
  for (const channel of NOTIFICATION_CHANNELS)
    Object.assign(result[channel], channel === 'email' ? stored.email : stored.channels[channel]);
  return result;
}
export async function readPolicy(db: Queryable, schemas: DataSchemas, actor: Actor) {
  await new AccessScope(db, schemas, actor).requireOrganization();
  const result = await query<{ enabled: Partial<Record<NotificationChannel, boolean>> }>(
    db,
    sql`SELECT enabled FROM ${ident(schemas.app, 'notification_organizations')} WHERE org_id = ${actor.orgId}`,
  );
  return channelPolicy(result.rows[0]?.enabled);
}

export const credentialContext = (scope: string, name: string) => `notifications.credential:${scope}:${name}`;
/** Organization connections follow the credential store's policy.  The install-wide push key has no organization to apply one to. */
export async function openCredential(
  key: Buffer,
  sealed: string,
  scope: string,
  name: string,
  db?: Queryable,
): Promise<string> {
  const context = credentialContext(scope, name);
  return scope === 'install'
    ? unseal(key, sealed, context)
    : unsealCredential(key, sealed, context, scope, db);
}
export async function credential<T>(
  db: Queryable,
  schemas: DataSchemas,
  key: Buffer,
  scope: string,
  name: string,
): Promise<T | null> {
  const result = await query<{ sealed: string }>(
    db,
    sql`SELECT sealed FROM ${ident(schemas.app, 'notification_credentials')}
    WHERE scope_key = ${scope} AND name = ${name}`,
  );
  try {
    return result.rows[0]
      ? (JSON.parse(await openCredential(key, result.rows[0].sealed, scope, name, db)) as T)
      : null;
  } catch {
    throw new AppError('unavailable', 'notifications.credentials.unavailable');
  }
}
export async function ensureVapid(c: CommandContext): Promise<VapidKeys> {
  const keys = createVapidKeys();
  await query(
    c.db,
    sql`INSERT INTO ${ident(c.schemas.app, 'notification_credentials')}(scope_key, name, sealed)
    VALUES ('install', 'vapid', ${seal(c.secretKey!, JSON.stringify(keys), credentialContext('install', 'vapid'))})
    ON CONFLICT (scope_key, name) DO NOTHING`,
  );
  return (await credential<VapidKeys>(c.db, c.schemas, c.secretKey!, 'install', 'vapid'))!;
}

export interface PhoneState {
  number: string;
  verified: boolean;
  hash?: string;
  expires?: number;
  attempts?: number;
  requestedAt?: number;
}
export const phoneContext = (actor: Actor) => `notifications.phone:${actor.orgId}:${actor.userId}`;
export const deviceContext = (id: string) => `notifications.device:${id}`;
export async function phoneFor(
  db: Queryable,
  schemas: DataSchemas,
  key: Buffer,
  actor: Actor,
): Promise<PhoneState | null> {
  await new AccessScope(db, schemas, actor).requireOrganization();
  const result = await query<{ sealed: string }>(
    db,
    sql`SELECT sealed FROM ${ident(schemas.app, 'notification_phones')}
    WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
  );
  try {
    return result.rows[0]
      ? (JSON.parse(unseal(key, result.rows[0].sealed, phoneContext(actor))) as PhoneState)
      : null;
  } catch {
    throw new AppError('unavailable', 'notifications.credentials.unavailable');
  }
}
export async function channelPreferences(
  db: Queryable,
  schemas: DataSchemas,
  key: Buffer,
  actor: Actor,
  emailAvailable: boolean,
  pushAvailable: boolean,
): Promise<NotificationChannelPreferences> {
  const stored = await readPreferences(db, schemas, actor);
  const enabled = await readPolicy(db, schemas, actor);
  const connections = await query<{ name: string }>(
    db,
    sql`SELECT name FROM ${ident(schemas.app, 'notification_credentials')}
    WHERE scope_key = ${actor.orgId} AND name IN ('sms', 'slack', 'teams')`,
  );
  const available = new Set(connections.rows.map((row) => row.name));
  const devices = await query<{ id: string; created_at: Date }>(
    db,
    sql`SELECT id, created_at FROM ${ident(schemas.app, 'notification_devices')}
    WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId} ORDER BY created_at`,
  );
  const phone = await phoneFor(db, schemas, key, actor);
  return {
    channels: choices(stored),
    digest: stored.digest,
    enabled,
    available: {
      bell: true,
      email: emailAvailable,
      digest: emailAvailable,
      push: pushAvailable,
      sms: available.has('sms'),
      slack: available.has('slack'),
      teams: available.has('teams'),
    },
    devices: devices.rows.map((row) => ({ id: row.id, createdAt: row.created_at.toISOString() })),
    phone: phone ? { number: phone.number, verified: phone.verified } : null,
    canAdminister: organizationAdmin(actor, 'integrations'),
    canReceiveSms: canReceiveSms(actor),
  };
}

export type NotificationState = {
  resource: 'preferences' | 'organization' | 'credential' | 'device' | 'phone' | 'read';
  target: string;
  value: unknown;
};
export async function currentNotificationState(
  c: CommandContext,
  state: NotificationState,
): Promise<NotificationState> {
  const { db, schemas, actor } = c;
  let value: unknown;
  if (state.resource === 'preferences') value = await readPreferences(db, schemas, actor);
  else if (state.resource === 'organization') value = await readPolicy(db, schemas, actor);
  else if (state.resource === 'credential') {
    const result = await query<{ sealed: string }>(
      db,
      sql`SELECT sealed FROM ${ident(schemas.app, 'notification_credentials')}
      WHERE scope_key = ${actor.orgId} AND name = ${state.target}`,
    );
    value = result.rows[0]?.sealed ?? null;
  } else if (state.resource === 'device') {
    const result = await query<{ org_id: string; user_id: string; sealed: string }>(
      db,
      sql`SELECT org_id, user_id, sealed FROM ${ident(schemas.app, 'notification_devices')} WHERE id = ${state.target}`,
    );
    const row = result.rows[0];
    if (row && (row.org_id !== actor.orgId || row.user_id !== actor.userId))
      throw new AppError('not_found', 'errors.notFound');
    value = row?.sealed ?? null;
  } else if (state.resource === 'phone') {
    const result = await query<{ sealed: string }>(
      db,
      sql`SELECT sealed FROM ${ident(schemas.app, 'notification_phones')}
      WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
    );
    value = result.rows[0]?.sealed ?? null;
  } else {
    const rows = await query<{ id: string; read_at: Date | null }>(
      db,
      sql`SELECT id, read_at FROM ${ident(schemas.app, 'notifications')}
      WHERE org_id = ${actor.orgId} AND recipient_id = ${actor.userId} AND id = ANY(${Object.keys(state.value as object)}::text[]) ORDER BY id`,
    );
    value = Object.fromEntries(rows.rows.map((row) => [row.id, row.read_at?.toISOString() ?? null]));
  }
  return { ...state, value };
}
export async function writeNotificationState(c: CommandContext, state: NotificationState): Promise<void> {
  const { db, schemas, actor } = c;
  switch (state.resource) {
    case 'preferences': {
      const value = state.value as StoredPreferences;
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'notification_preferences')} (org_id, user_id, email, channels, digest)
        VALUES (${actor.orgId}, ${actor.userId}, ${JSON.stringify(value.email)}::jsonb, ${JSON.stringify(value.channels)}::jsonb, ${JSON.stringify(value.digest)}::jsonb)
        ON CONFLICT (org_id, user_id) DO UPDATE SET email = EXCLUDED.email, channels = EXCLUDED.channels, digest = EXCLUDED.digest, updated_at = now()`,
      );
      break;
    }
    case 'organization':
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'notification_organizations')}(org_id, enabled)
        VALUES (${actor.orgId}, ${JSON.stringify(state.value)}::jsonb) ON CONFLICT (org_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
      );
      break;
    case 'credential':
      if (state.value === null)
        await query(
          db,
          sql`DELETE FROM ${ident(schemas.app, 'notification_credentials')} WHERE scope_key = ${actor.orgId} AND name = ${state.target}`,
        );
      else
        await query(
          db,
          sql`INSERT INTO ${ident(schemas.app, 'notification_credentials')}(scope_key, org_id, name, sealed)
        VALUES (${actor.orgId}, ${actor.orgId}, ${state.target}, ${state.value as string}) ON CONFLICT (scope_key, name) DO UPDATE SET sealed = EXCLUDED.sealed`,
        );
      break;
    case 'device':
      if (state.value === null)
        await query(
          db,
          sql`DELETE FROM ${ident(schemas.app, 'notification_devices')} WHERE id = ${state.target} AND org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
        );
      else
        await query(
          db,
          sql`INSERT INTO ${ident(schemas.app, 'notification_devices')}(id, org_id, user_id, sealed)
        VALUES (${state.target}, ${actor.orgId}, ${actor.userId}, ${state.value as string}) ON CONFLICT (id) DO UPDATE SET sealed = EXCLUDED.sealed`,
        );
      break;
    case 'phone':
      if (state.value === null)
        await query(
          db,
          sql`DELETE FROM ${ident(schemas.app, 'notification_phones')} WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
        );
      else
        await query(
          db,
          sql`INSERT INTO ${ident(schemas.app, 'notification_phones')}(org_id, user_id, sealed)
        VALUES (${actor.orgId}, ${actor.userId}, ${state.value as string}) ON CONFLICT (org_id, user_id) DO UPDATE SET sealed = EXCLUDED.sealed`,
        );
      break;
    case 'read':
      for (const [id, readAt] of Object.entries(state.value as Record<string, string | null>))
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'notifications')} SET read_at = ${readAt}::timestamptz
          WHERE id = ${id} AND org_id = ${actor.orgId} AND recipient_id = ${actor.userId}`,
        );
  }
}
export async function readNotificationDevices(
  db: Queryable,
  schemas: DataSchemas,
  key: Buffer,
  actor: Actor,
) {
  await new AccessScope(db, schemas, actor).requireOrganization();
  const rows = await query<{ id: string; sealed: string }>(
    db,
    sql`SELECT id, sealed FROM ${ident(schemas.app, 'notification_devices')}
    WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId}`,
  );
  return rows.rows.map((row) => ({
    id: row.id,
    subscription: JSON.parse(unseal(key, row.sealed, deviceContext(row.id))) as PushSubscriptionInput,
  }));
}
export async function connectionFor(
  db: Queryable,
  schemas: DataSchemas,
  key: Buffer,
  actor: Actor,
  channel: 'slack' | 'teams' | 'sms',
) {
  await new AccessScope(db, schemas, actor).requireOrganization();
  try {
    return await credential<NotificationConnection>(db, schemas, key, actor.orgId, channel);
  } catch {
    throw new AppError('unavailable', 'notifications.credentials.unavailable');
  }
}
export function channelChosen(
  preferences: NotificationChannelPreferences,
  kind: NotificationKind,
  channel: NotificationChannel,
): boolean {
  return (
    preferences.enabled[channel] &&
    preferences.channels[channel][kind] &&
    (channel !== 'sms' ||
      (preferences.canReceiveSms && adminNotification(kind) && Boolean(preferences.phone?.verified)))
  );
}
