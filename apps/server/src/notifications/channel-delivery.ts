import { AppError, newId, adminNotification, type NotificationConnection } from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import type { Actor } from '../http/policy.js';
import { dataStore } from '../data/context.js';
import { rotateTeamsCredential, runNotificationCommand } from '../data/commands/notifications.js';
import {
  CHANNEL_BATCH,
  claimChannelDeliveries,
  claimSmsSlot,
  deliverableNotifications,
  markChannelDelivery,
  markDigested,
  queueAdminAlerts,
  queueDigests,
  queueNotificationChannels,
  recipientInfo,
  recordCredentialAlert,
  type DeliveryRow,
} from '../data/notification-delivery.js';
import {
  canReceiveSms,
  channelChosen,
  channelPreferences,
  connectionFor,
  credential,
  phoneFor,
  readNotificationDevices,
} from '../data/notifications.js';
import { unseal } from '../secrets.js';
import { digestEmail, notificationMessage, privatePayload } from './messages.js';
import { sendPush, type VapidKeys } from './push.js';
import { activeMember } from './store.js';
import {
  NotificationDeliveryError,
  sendSlack,
  sendSms,
  sendTeams,
  type ChannelRequest,
} from './transports.js';

export async function deliverChannels(
  app: FastifyInstance,
  request: ChannelRequest = fetch,
  now = new Date(),
): Promise<void> {
  if (!app.ctx.pool || !app.ctx.config.database) return;
  await queueAdminAlerts(app.ctx);
  await queueNotificationChannels(app.ctx);
  await queueDigests(app.ctx, now);
  for (;;) {
    const rows = await claimChannelDeliveries(app.ctx);
    for (const row of rows) {
      let state: 'sent' | 'failed' | 'skipped';
      try {
        state = await deliver(app, row, request);
      } catch (error) {
        state = 'failed';
        app.log.warn(
          {
            deliveryId: row.id,
            channel: row.channel,
            messageKey: 'notifications.delivery.failed',
            ...(error instanceof NotificationDeliveryError
              ? {
                  serviceMethod: error.serviceMethod,
                  ...(error.serviceError !== undefined ? { serviceError: error.serviceError } : {}),
                }
              : {}),
          },
          'notification delivery failed',
        );
      }
      await markChannelDelivery(app.ctx, row.id, state);
    }
    if (rows.length < CHANNEL_BATCH) return;
  }
}

/**
 * Reads one of the organization's own connections.  A vault holds those, so one that can't be read
 * is the only delivery failure that records a vault alert.  A person's phone record and the
 * installation's push key use the server's own key instead.
 */
async function organizationConnection(
  app: FastifyInstance,
  actor: Actor,
  channel: 'slack' | 'teams' | 'sms',
): Promise<NotificationConnection | null> {
  const { pool, schemas } = dataStore(app.ctx);
  try {
    return await connectionFor(pool, schemas, app.ctx.config.secretKey, actor, channel);
  } catch (error) {
    if (error instanceof AppError && error.messageKey === 'notifications.credentials.unavailable')
      await recordCredentialAlert(app.ctx, actor.orgId);
    throw error;
  }
}

async function deliver(
  app: FastifyInstance,
  row: DeliveryRow,
  request: ChannelRequest,
): Promise<'sent' | 'skipped'> {
  const ctx = app.ctx;
  const { pool, schemas } = dataStore(ctx);
  const actor = await activeMember(pool, schemas, row.org_id, row.user_id);
  if (!actor) return 'skipped';
  const key = ctx.config.secretKey;
  const preferences = await channelPreferences(
    pool,
    schemas,
    key,
    actor,
    Boolean(ctx.mailer && ctx.config.baseUrl),
    Boolean(ctx.config.baseUrl),
  );
  const person = await recipientInfo(pool, schemas, actor);
  if (row.channel === 'verify') {
    if (!canReceiveSms(actor) || !preferences.enabled.sms || !row.payload?.sealed) return 'skipped';
    const phone = await phoneFor(pool, schemas, key, actor);
    const payload = JSON.parse(unseal(key, row.payload.sealed, `notifications.verify:${row.id}`)) as {
      number: string;
      code: string;
      requestedAt: number;
    };
    if (
      !phone ||
      phone.verified ||
      phone.number !== payload.number ||
      phone.requestedAt !== payload.requestedAt ||
      !phone.expires ||
      phone.expires < Date.now()
    )
      return 'skipped';
    const connection = await organizationConnection(app, actor, 'sms');
    if (connection?.channel !== 'sms') return 'skipped';
    await sendSms(
      connection,
      phone.number,
      notificationMessage(person.locale, 'notifications.phone.code', { code: payload.code }),
      request,
    );
    return 'sent';
  }
  const base = ctx.config.baseUrl;
  if (!base) return 'skipped';
  const notifications = await deliverableNotifications(
    pool,
    schemas,
    actor,
    row.notification_id ? [row.notification_id] : (row.payload?.ids ?? []),
  );
  if (row.channel === 'digest') {
    if (!ctx.mailer || !preferences.enabled.digest || preferences.digest.frequency === 'off')
      return 'skipped';
    const selected = notifications.filter((notification) =>
      channelChosen(preferences, notification.kind, 'digest'),
    );
    if (!selected.length) return 'skipped';
    await ctx.mailer.send(digestEmail(selected, person.email, person.locale, base));
    await markDigested(
      ctx,
      actor,
      selected.map((notification) => notification.id),
    );
    return 'sent';
  }
  const notification = notifications[0];
  if (!notification || !channelChosen(preferences, notification.kind, row.channel)) return 'skipped';
  const payload = privatePayload(notification, person.locale, base);
  if (row.channel === 'push') {
    const device = (await readNotificationDevices(pool, schemas, key, actor)).find(
      (item) => item.id === row.device_id,
    );
    const keys = await credential<VapidKeys>(pool, schemas, key, 'install', 'vapid');
    if (!device || !keys) return 'skipped';
    const expired =
      Boolean(device.subscription.expirationTime && device.subscription.expirationTime <= Date.now()) ||
      (await sendPush(device.subscription, keys, payload, new URL(base).origin, request)) === 'expired';
    if (expired) {
      await runNotificationCommand(app, actor, {
        id: newId('command'),
        kind: 'notifications.push.unsubscribe',
        deviceId: device.id,
      });
      return 'skipped';
    }
  } else {
    const connection: NotificationConnection | null = await organizationConnection(app, actor, row.channel);
    if (!connection || connection.channel !== row.channel) return 'skipped';
    switch (connection.channel) {
      case 'slack':
        await sendSlack(connection, person.email, payload, request);
        break;
      case 'teams':
        await sendTeams(connection, person.email, payload, request, (token) =>
          rotateTeamsCredential(app, actor, connection, token),
        );
        break;
      case 'sms': {
        if (!adminNotification(notification.kind) || !canReceiveSms(actor) || !preferences.phone?.verified)
          return 'skipped';
        if (!(await claimSmsSlot(ctx, actor, row.id))) return 'skipped';
        await sendSms(
          connection,
          preferences.phone.number,
          `${payload.title}\n${payload.body}\n${payload.url}`,
          request,
        );
      }
    }
  }
  return 'sent';
}
