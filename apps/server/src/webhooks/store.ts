import { createHmac, randomBytes } from 'node:crypto';
import {
  WEBHOOK_EVENTS,
  WEBHOOK_SECRET_PREFIX,
  type WebhookAttempt,
  type WebhookDelivery,
  type WebhookDeliveryState,
  type WebhookEventType,
  type WebhookMeta,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { DataSchemas } from '../data/context.js';
import { sealCredential, unsealCredential } from '../credentials/service.js';

/**
 * Reads webhooks and their deliveries into the shapes the rest of the server uses, and keeps the
 * signing secrets: sealed with the instance key at rest, and shown to people only when made.
 */

const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();

export interface WebhookRow {
  id: string;
  org_id: string;
  database_id: string;
  url: string;
  events: WebhookEventType[];
  table_ids: string[] | null;
  enabled: boolean;
  secret: string;
  previous_secret: string | null;
  previous_secret_until: Date | null;
  disabled_reason: string | null;
  failing_since: Date | null;
  last_success_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DeliveryRow {
  id: string;
  seq: string;
  webhook_id: string;
  payload: string;
  event_count: number;
  event_types: WebhookEventType[];
  state: WebhookDeliveryState;
  attempts: number;
  manual: boolean;
  next_attempt_at: Date | null;
  lease_at: Date | null;
  lease_token: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AttemptRow {
  delivery_id: string;
  at: Date;
  status: number | null;
  ms: number | null;
  error: string | null;
  manual: boolean;
}

/** Events in the contract's order, whatever order they were chosen in. */
export function orderedEvents(events: readonly WebhookEventType[]): WebhookEventType[] {
  return WEBHOOK_EVENTS.filter((event) => events.includes(event));
}

export function webhookMeta(row: WebhookRow): WebhookMeta {
  return {
    id: row.id,
    databaseId: row.database_id,
    url: row.url,
    events: orderedEvents(row.events),
    tableIds: row.table_ids,
    enabled: row.enabled,
    disabledReason: row.disabled_reason,
    failingSince: row.failing_since ? iso(row.failing_since) : null,
    lastSuccessAt: row.last_success_at ? iso(row.last_success_at) : null,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

/** The columns a delivery's summary needs, leaving out its payload. */
export const DELIVERY_COLUMNS = [
  'id',
  'seq',
  'webhook_id',
  'state',
  'event_count',
  'event_types',
  'created_at',
  'next_attempt_at',
] as const;
export type DeliverySummaryRow = Pick<DeliveryRow, (typeof DELIVERY_COLUMNS)[number]>;

export function deliveryOf(row: DeliverySummaryRow, attempts: readonly AttemptRow[]): WebhookDelivery {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    state: row.state,
    eventCount: row.event_count,
    eventTypes: orderedEvents(row.event_types),
    createdAt: iso(row.created_at),
    nextAttemptAt: row.state === 'pending' && row.next_attempt_at ? iso(row.next_attempt_at) : null,
    attempts: attempts.map((attempt): WebhookAttempt => ({
      at: iso(attempt.at),
      status: attempt.status,
      ms: attempt.ms,
      error: attempt.error,
      manual: attempt.manual,
    })),
  };
}

export async function loadWebhook(
  db: Queryable,
  schemas: DataSchemas,
  id: string,
  options: { databaseId?: string; lock?: boolean } = {},
): Promise<WebhookRow | null> {
  const result = await query<WebhookRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'webhooks')} WHERE id = ${id}
    AND ${options.databaseId === undefined ? sql`TRUE` : sql`database_id = ${options.databaseId}`}
    ${options.lock ? sql`FOR UPDATE` : sql``}`,
  );
  return result.rows[0] ?? null;
}

/** Each delivery's attempts, newest first. */
export async function attemptsFor(
  db: Queryable,
  schemas: DataSchemas,
  deliveryIds: readonly string[],
): Promise<Map<string, AttemptRow[]>> {
  const byDelivery = new Map<string, AttemptRow[]>(deliveryIds.map((id) => [id, []]));
  if (!deliveryIds.length) return byDelivery;
  const result = await query<AttemptRow>(
    db,
    sql`SELECT delivery_id, at, status, ms, error, manual FROM ${ident(schemas.app, 'webhook_attempts')}
    WHERE delivery_id = ANY(${deliveryIds}::text[]) ORDER BY id DESC`,
  );
  for (const row of result.rows) byDelivery.get(row.delivery_id)?.push(row);
  return byDelivery;
}

export function newSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

// The webhook's ID is bound into the seal, so one webhook's secret can't be moved to another.
const context = (webhookId: string) => `riosoma.webhooks.secret:${webhookId}`;

export function sealSecret(
  key: Buffer,
  webhookId: string,
  secret: string,
  orgId: string,
  db?: Queryable,
): Promise<string> {
  return sealCredential(key, secret, context(webhookId), orgId, db);
}

/** The secrets to sign with now: the current one, and the one it replaced while that still works. */
export async function signingSecrets(key: Buffer, row: WebhookRow, now: Date): Promise<string[]> {
  const secrets = [await unsealCredential(key, row.secret, context(row.id), row.org_id)];
  if (row.previous_secret && row.previous_secret_until && row.previous_secret_until > now)
    secrets.push(await unsealCredential(key, row.previous_secret, context(row.id), row.org_id));
  return secrets;
}

/**
 * The `Riosoma-Signature` header: the time in Unix seconds, and an HMAC-SHA256 of `<t>.<body>`
 * for each secret.
 */
export function signatureHeader(secrets: readonly string[], timestamp: number, body: string): string {
  return [
    `t=${timestamp}`,
    ...secrets.map(
      (secret) => `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`,
    ),
  ].join(',');
}

/**
 * Holds a webhook's unsent deliveries while it's off, by taking away their time.  A delivery
 * someone asked to send again keeps its time and still goes.
 */
export async function holdDeliveries(db: Queryable, schemas: DataSchemas, webhookId: string): Promise<void> {
  await query(
    db,
    sql`UPDATE ${ident(schemas.app, 'webhook_deliveries')} SET next_attempt_at = NULL
    WHERE webhook_id = ${webhookId} AND state = 'pending' AND NOT manual`,
  );
}

/** Sends a webhook's held deliveries, in order, now that it's back on. */
export async function releaseDeliveries(
  db: Queryable,
  schemas: DataSchemas,
  webhookId: string,
  now: Date,
): Promise<void> {
  await query(
    db,
    sql`UPDATE ${ident(schemas.app, 'webhook_deliveries')} SET next_attempt_at = ${now}
    WHERE webhook_id = ${webhookId} AND state = 'pending' AND next_attempt_at IS NULL`,
  );
}
