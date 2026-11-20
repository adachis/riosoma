import { z } from 'zod';
import { DatabaseId, FieldId, LIMITS, RecordId, TableId } from './data/fields.js';

/**
 * Outbound webhooks.  After a change commits, Riosoma posts what changed to each address that
 * subscribed to it.  A call names the change, never the values: the event, the database, table,
 * and record IDs, the changed field IDs, the change's sequence number, and when it happened.  A
 * receiver then reads what it's allowed to see through the REST API.
 *
 * The same routes serve the REST API (`/api/v1/…`, with a token holding `schema.bases:write`) and
 * the app (`/api/…`, with a session), for people who can change the database's schema:
 * - `GET …/databases/:databaseId/webhooks` → `WebhookList`
 * - `POST …/databases/:databaseId/webhooks` (`WebhookCreate`) → `WebhookCreated`, the secret shown once
 * - `PATCH …/databases/:databaseId/webhooks/:webhookId` (`WebhookUpdate`) → `WebhookMeta`
 * - `DELETE …/databases/:databaseId/webhooks/:webhookId`
 * - `POST …/databases/:databaseId/webhooks/:webhookId/secret` → `WebhookSecret`, a new secret shown once
 * - `GET …/databases/:databaseId/webhooks/:webhookId/deliveries?cursor=` → `WebhookDeliveriesPage`
 * - `POST …/databases/:databaseId/webhooks/:webhookId/deliveries/:deliveryId/redeliver` → `WebhookDelivery`
 *
 * Each call is a `WebhookPayload` of up to 100 events, gathered for up to a second.  It carries
 * `Riosoma-Signature: t=<unix seconds>,v1=<hex>`, an HMAC-SHA256 of `<t>.<body>` keyed with the
 * webhook's secret, and `Riosoma-Delivery-Id`, which stays the same on every attempt.  While a
 * replaced secret still works, the header carries a second `v1` signed with it.
 */
export const WEBHOOK_EVENTS = [
  'record.created',
  'record.updated',
  'record.deleted',
  'field.changed',
  'table.changed',
] as const;
export const WebhookEventType = z.enum(WEBHOOK_EVENTS);
export type WebhookEventType = z.infer<typeof WebhookEventType>;

export const WebhookId = z.string().regex(/^whk[0-9A-Za-z]{14}$/);
export const WebhookDeliveryId = z.string().regex(/^dlv[0-9A-Za-z]{14}$/);

export const WEBHOOK_LIMITS = {
  perDatabase: 20,
  tables: 100,
  eventsPerDelivery: 100,
  /** How long a batch waits for more events before it goes */
  batchSeconds: 1,
  timeoutSeconds: 10,
  /** Deliveries and their attempts are kept this long */
  retentionDays: 7,
  /** A webhook failing this long with no success turns itself off */
  failingHours: 24,
  /** A replaced secret keeps signing beside the new one this long */
  previousSecretHours: 24,
} as const;

export const WEBHOOK_SECRET_PREFIX = 'rio_whsec_';
export const WEBHOOK_SIGNATURE_HEADER = 'Riosoma-Signature';
export const WEBHOOK_DELIVERY_HEADER = 'Riosoma-Delivery-Id';

/**
 * What's wrong with a webhook address on its face, or null: it must be an absolute http or https
 * address, with no user name or password.  The server also requires https, except for localhost
 * while developing, and refuses private networks.
 */
export function webhookUrlProblem(value: string): 'invalid' | 'credentials' | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return 'invalid';
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) return 'invalid';
  if (url.username || url.password) return 'credentials';
  return null;
}

export const WebhookUrl = z.string().trim().min(1).max(LIMITS.urlLength);

const Events = z.array(WebhookEventType).min(1).max(WEBHOOK_EVENTS.length);
/** Only changes in these tables, or in every table, including ones added later, when null */
const Tables = z.array(TableId).min(1).max(WEBHOOK_LIMITS.tables).nullable();

export const WebhookCreate = z.object({
  url: WebhookUrl,
  events: Events,
  tableIds: Tables.default(null),
  enabled: z.boolean().default(true),
});
export type WebhookCreate = z.infer<typeof WebhookCreate>;

export const WebhookUpdate = z
  .object({
    url: WebhookUrl.optional(),
    events: Events.optional(),
    tableIds: Tables.optional(),
    /** Turning it back on clears why it turned itself off */
    enabled: z.boolean().optional(),
  })
  .refine((update) => Object.values(update).some((value) => value !== undefined));
export type WebhookUpdate = z.infer<typeof WebhookUpdate>;

export const WebhookMeta = z.object({
  id: WebhookId,
  databaseId: DatabaseId,
  url: z.string(),
  events: z.array(WebhookEventType),
  tableIds: z.array(TableId).nullable(),
  enabled: z.boolean(),
  /** Set when it turned itself off, with the reason's message key */
  disabledReason: z.string().nullable(),
  /** When deliveries started failing with no success since, or null while they succeed */
  failingSince: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WebhookMeta = z.infer<typeof WebhookMeta>;

export const WebhookList = z.object({ webhooks: z.array(WebhookMeta) });
export type WebhookList = z.infer<typeof WebhookList>;

export const WebhookCreated = WebhookMeta.extend({
  /** Shown once, for the receiver to keep and check signatures with */
  secret: z.string(),
});
export type WebhookCreated = z.infer<typeof WebhookCreated>;

export const WebhookSecret = z.object({
  /** Shown once */
  secret: z.string(),
  /** Until then, calls are also signed with the secret it replaced */
  previousExpiresAt: z.string(),
});
export type WebhookSecret = z.infer<typeof WebhookSecret>;

export const WEBHOOK_DELIVERY_STATES = ['pending', 'succeeded', 'failed'] as const;
export const WebhookDeliveryState = z.enum(WEBHOOK_DELIVERY_STATES);
export type WebhookDeliveryState = z.infer<typeof WebhookDeliveryState>;

export const WebhookAttempt = z.object({
  at: z.string(),
  /** The HTTP status the receiver answered with, or null when no answer came */
  status: z.number().int().nullable(),
  /** How long the call took */
  ms: z.number().int().nullable(),
  /** Why no answer came, as a message key */
  error: z.string().nullable(),
  /** Someone asked for this attempt */
  manual: z.boolean(),
});
export type WebhookAttempt = z.infer<typeof WebhookAttempt>;

export const WebhookDelivery = z.object({
  id: WebhookDeliveryId,
  webhookId: WebhookId,
  state: WebhookDeliveryState,
  eventCount: z.number().int(),
  eventTypes: z.array(WebhookEventType),
  createdAt: z.string(),
  /** When a pending delivery is tried next, or null while the webhook is off and holds it */
  nextAttemptAt: z.string().nullable(),
  /** Newest first */
  attempts: z.array(WebhookAttempt),
});
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;

export const WebhookDeliveriesPage = z.object({
  deliveries: z.array(WebhookDelivery),
  next: z.string().nullable(),
});
export type WebhookDeliveriesPage = z.infer<typeof WebhookDeliveriesPage>;

/** One change, as a receiver sees it. */
export const WebhookEvent = z.object({
  event: WebhookEventType,
  databaseId: DatabaseId,
  tableId: TableId,
  /** The record, for record events */
  recordId: RecordId.nullable(),
  /**
   * Fields the change wrote: the filled fields of a new record, the changed fields of an updated
   * one, and the field itself for field events.  Computed fields that follow along aren't listed.
   */
  fieldIds: z.array(FieldId),
  /** The change's sequence number in its database, so events can be put in order */
  seq: z.number().int(),
  at: z.string(),
});
export type WebhookEvent = z.infer<typeof WebhookEvent>;

/** The body of each call. */
export const WebhookPayload = z.object({
  /** The delivery, the same as the `Riosoma-Delivery-Id` header */
  id: WebhookDeliveryId,
  webhookId: WebhookId,
  databaseId: DatabaseId,
  events: z.array(WebhookEvent).min(1).max(WEBHOOK_LIMITS.eventsPerDelivery),
});
export type WebhookPayload = z.infer<typeof WebhookPayload>;
