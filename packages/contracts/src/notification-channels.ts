import { z } from 'zod';
import { CommandId } from './data/fields.js';
import { MarkNotificationsRead, NotificationKind, type NotificationEmail } from './notifications.js';

export const NOTIFICATION_CHANNELS = ['bell', 'email', 'push', 'digest', 'sms', 'slack', 'teams'] as const;
export const NotificationChannel = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof NotificationChannel>;
export const ADMIN_NOTIFICATION_KINDS = [
  'securityEvent',
  'backupFailed',
  'credentialVaultUnavailable',
  'vaultUnavailable',
  'updateFailed',
] as const;
export function adminNotification(kind: string): boolean {
  return (ADMIN_NOTIFICATION_KINDS as readonly string[]).includes(kind);
}
export const NotificationTimeZone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  });
export const DigestSchedule = z.object({
  frequency: z.enum(['off', 'daily', 'weekly']).default('off'),
  hour: z.number().int().min(0).max(23).default(9),
  timeZone: NotificationTimeZone.default('UTC'),
});
export type DigestSchedule = z.infer<typeof DigestSchedule>;
export const ChannelChoices = z.partialRecord(
  NotificationChannel,
  z.partialRecord(NotificationKind, z.boolean()),
);
export const NotificationChannelsUpdate = z
  .object({
    channels: ChannelChoices.optional(),
    digest: DigestSchedule.optional(),
  })
  .refine((value) => value.channels !== undefined || value.digest !== undefined);
export type NotificationChannelsUpdate = z.infer<typeof NotificationChannelsUpdate>;
export const NotificationOrganizationUpdate = z.object({
  enabled: z.partialRecord(NotificationChannel, z.boolean()),
});
export const PushSubscriptionInput = z.object({
  endpoint: z
    .url()
    .max(2048)
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.port;
    }),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  }),
  expirationTime: z.number().nonnegative().nullable().optional(),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInput>;
export const NotificationPhone = z.string().regex(/^\+[1-9][0-9]{7,14}$/);
export const NotificationConnection = z.discriminatedUnion('channel', [
  z.object({ channel: z.literal('slack'), token: z.string().min(10).max(4096) }),
  z.object({
    channel: z.literal('sms'),
    accountSid: z.string().regex(/^AC[0-9a-fA-F]{32}$/),
    authToken: z.string().min(10).max(4096),
    from: NotificationPhone,
  }),
  z.object({
    channel: z.literal('teams'),
    tenantId: z.uuid(),
    clientId: z.uuid(),
    clientSecret: z.string().min(1).max(4096),
    refreshToken: z.string().min(1).max(8192),
  }),
]);
export type NotificationConnection = z.infer<typeof NotificationConnection>;
export interface NotificationChannelPreferences {
  channels: Record<NotificationChannel, NotificationEmail>;
  digest: DigestSchedule;
  enabled: Record<NotificationChannel, boolean>;
  available: Record<NotificationChannel, boolean>;
  devices: Array<{ id: string; createdAt: string }>;
  phone: { number: string; verified: boolean } | null;
  canAdminister: boolean;
  canReceiveSms: boolean;
}
export const NotificationCommand = z.discriminatedUnion('kind', [
  z.object({
    id: CommandId,
    kind: z.literal('notifications.preferences'),
    update: NotificationChannelsUpdate,
  }),
  z.object({
    id: CommandId,
    kind: z.literal('notifications.organization'),
    update: NotificationOrganizationUpdate,
  }),
  z.object({
    id: CommandId,
    kind: z.literal('notifications.connection'),
    connection: NotificationConnection,
  }),
  z.object({
    id: CommandId,
    kind: z.literal('notifications.disconnect'),
    channel: z.enum(['slack', 'teams', 'sms']),
  }),
  z.object({ id: CommandId, kind: z.literal('notifications.push.prepare') }),
  z.object({
    id: CommandId,
    kind: z.literal('notifications.push.subscribe'),
    subscription: PushSubscriptionInput,
  }),
  z.object({
    id: CommandId,
    kind: z.literal('notifications.push.unsubscribe'),
    deviceId: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({ id: CommandId, kind: z.literal('notifications.phone.request'), number: NotificationPhone }),
  z.object({
    id: CommandId,
    kind: z.literal('notifications.phone.verify'),
    code: z.string().regex(/^[0-9]{6}$/),
  }),
  z.object({ id: CommandId, kind: z.literal('notifications.phone.remove') }),
  z.object({ id: CommandId, kind: z.literal('notifications.read'), read: MarkNotificationsRead }),
  z.object({ id: CommandId, kind: z.literal('notifications.undo'), actionId: CommandId }),
]);
export type NotificationCommand = z.infer<typeof NotificationCommand>;
export interface NotificationCommandResult {
  status: 'applied' | 'duplicate' | 'rejected';
  actionId: string;
  publicKey?: string;
  deviceId?: string;
  error?: { code: string; messageKey: string };
}
