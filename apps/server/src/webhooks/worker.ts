import { AccessScope } from '../data/access.js';
import { performance } from 'node:perf_hooks';
import { WEBHOOK_LIMITS, newId } from '@riosoma/contracts';
import { compile, ident, query, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { auditEvent } from '../auth/database.js';
import {
  callOut,
  OUTBOUND_TIMEOUT_MS,
  OutboundError,
  systemResolve,
  type Resolve,
} from '../automations/outbound.js';
import { dataStore } from '../data/context.js';
import {
  holdDeliveries,
  loadWebhook,
  signatureHeader,
  signingSecrets,
  type DeliveryRow,
  type WebhookRow,
} from './store.js';
import { allowsPrivate } from './url.js';

/**
 * The webhook worker.  On an unref'd timer it gathers each webhook's waiting events into
 * deliveries of up to 100, once the oldest has waited a second or a full batch is ready, then
 * claims due deliveries with a lease and sends them, a few at a time.  A webhook has one delivery
 * in flight at a time, so its deliveries arrive in order unless one has to wait for a retry.
 *
 * Network errors, timeouts, 408, 429, and 5xx answers are tried again after 5 minutes, then 15,
 * then 1, 3, 6, 12, and 24 hours.  Any other answer outside 2xx isn't.  A webhook with no
 * success for 24 hours of failures turns itself off, and says why.  While a webhook is off its
 * unsent deliveries are held, and they go once it's back on.
 */

export const BATCH_SIZE = WEBHOOK_LIMITS.eventsPerDelivery;
export const BATCH_WINDOW_MS = WEBHOOK_LIMITS.batchSeconds * 1_000;
export const RETRY_DELAYS_MS = [5, 15, 60, 180, 360, 720, 1_440].map((minutes) => minutes * 60_000);
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
export const FAILING_LIMIT_MS = WEBHOOK_LIMITS.failingHours * 3_600_000;
export const RETENTION_MS = WEBHOOK_LIMITS.retentionDays * 86_400_000;
export const DISABLED_FAILING = 'webhooks.disabled.failing';
export const LEASE_MS = 60_000;
const CONCURRENCY = 8;
/** A payload stays well under the most an outbound call may send. */
const PAYLOAD_BUDGET = 256 * 1024;
const BATCHES_PER_PASS = 50;
const CLEANUP_EVERY_MS = 3_600_000;

interface Outcome {
  status: number | null;
  error: string | null;
  ok: boolean;
  retry: boolean;
}

function answered(status: number): Outcome {
  const ok = status >= 200 && status < 300;
  return { status, error: null, ok, retry: !ok && (status >= 500 || status === 408 || status === 429) };
}

function unanswered(error: OutboundError): Outcome {
  const failed = (key: string, retry: boolean): Outcome => ({ status: null, error: key, ok: false, retry });
  if (error.messageKey === 'automations.webhook.timeout') return failed('webhooks.delivery.timeout', true);
  if (error.messageKey === 'automations.webhook.blocked') return failed('webhooks.delivery.blocked', false);
  if (error.detail === 'resolve') return failed('webhooks.delivery.resolve', true);
  if (error.detail === 'url' || error.detail === 'header' || error.detail === 'tooLarge')
    return failed('webhooks.delivery.failed', false);
  return failed('webhooks.delivery.network', true);
}

export class WebhookWorker {
  /** How receivers' hosts are resolved.  Tests swap in their own. */
  resolve: Resolve = systemResolve;
  /** How long a call may take */
  timeoutMs = OUTBOUND_TIMEOUT_MS;
  private readonly active = new Set<Promise<unknown>>();
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private stopped = false;
  private cleanupAt = 0;

  constructor(readonly app: FastifyInstance) {}

  private get ready(): boolean {
    return !this.stopped && Boolean(this.app.ctx.pool && this.app.ctx.config.database);
  }

  start(): void {
    const every = this.app.ctx.config.webhooksPollMs ?? 500;
    if (this.timer || this.stopped || every <= 0) return;
    this.timer = setInterval(() => this.kick(), every);
    this.timer.unref();
  }

  private kick(): void {
    void this.tick().catch((error: unknown) => {
      this.app.log.warn(
        { errorName: error instanceof Error ? error.name : typeof error, messageKey: 'errors.internal' },
        'webhook worker pass failed',
      );
    });
  }

  /** One pass: old deliveries, then waiting events, then as many deliveries as there's room for. */
  tick(): Promise<void> {
    this.ticking ??= this.pass(new Date()).finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  private async pass(now: Date): Promise<void> {
    if (!this.ready) return;
    if (now.getTime() - this.cleanupAt >= CLEANUP_EVERY_MS) {
      this.cleanupAt = now.getTime();
      await this.cleanup(now);
    }
    await this.gather(now);
    const room = CONCURRENCY - this.active.size;
    if (room <= 0) return;
    for (const row of await this.claim(room, now)) {
      const work: Promise<unknown> = this.deliver(row).finally(() => {
        this.active.delete(work);
        // The webhook's next delivery can go now, rather than at the next beat of the timer.
        if (this.timer) this.kick();
      });
      this.active.add(work);
    }
  }

  /** Gathers what's ready and sends everything due at `now`, waiting for each to finish. */
  async drain(now = new Date()): Promise<void> {
    await this.gather(now);
    for (;;) {
      const rows = await this.claim(CONCURRENCY, now);
      if (!rows.length) break;
      await Promise.all(rows.map((row) => this.deliver(row)));
    }
    await Promise.allSettled(this.active);
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.ticking?.catch(() => undefined);
    await Promise.allSettled(this.active);
  }

  /** Turns waiting events into deliveries, for each webhook with a full batch or one that waited long enough. */
  async gather(now = new Date()): Promise<number> {
    if (!this.ready) return 0;
    const { pool, schemas } = dataStore(this.app.ctx);
    const cutoff = new Date(now.getTime() - BATCH_WINDOW_MS);
    const ready = await query<{ webhook_id: string }>(
      pool,
      sql`SELECT webhook_id FROM ${ident(schemas.app, 'webhook_events')} GROUP BY webhook_id
      HAVING min(queued_at) <= ${cutoff} OR count(*) >= ${BATCH_SIZE}
      ORDER BY min(id) LIMIT 100`,
    );
    let made = 0;
    for (const { webhook_id: webhookId } of ready.rows) made += await this.gatherFor(webhookId, now, cutoff);
    return made;
  }

  private async gatherFor(webhookId: string, now: Date, cutoff: Date): Promise<number> {
    const { pool, schemas } = dataStore(this.app.ctx);
    const events = ident(schemas.app, 'webhook_events');
    return withTransaction(pool, async (db) => {
      // One worker at a time gathers a webhook's events, so none is sent twice.
      const owner = await query<{ database_id: string; enabled: boolean }>(
        db,
        sql`SELECT database_id, enabled FROM ${ident(schemas.app, 'webhooks')} WHERE id = ${webhookId}
        FOR NO KEY UPDATE SKIP LOCKED`,
      );
      const webhook = owner.rows[0];
      if (!webhook) return 0;
      let made = 0;
      while (made < BATCHES_PER_PASS) {
        const waiting = await query<{ id: string; event: string; event_type: string; queued_at: Date }>(
          db,
          sql`SELECT id, event, event_type, queued_at FROM ${events} WHERE webhook_id = ${webhookId}
          ORDER BY id LIMIT ${BATCH_SIZE}`,
        );
        const first = waiting.rows[0];
        if (!first || (waiting.rows.length < BATCH_SIZE && first.queued_at > cutoff)) break;
        const taken: typeof waiting.rows = [];
        let size = 0;
        for (const row of waiting.rows) {
          if (taken.length && size + row.event.length > PAYLOAD_BUDGET) break;
          taken.push(row);
          size += row.event.length + 1;
        }
        const id = newId('delivery');
        // The events keep the text they were written with, so their keys stay in order.
        const head = JSON.stringify({ id, webhookId, databaseId: webhook.database_id, events: [] });
        const payload = `${head.slice(0, -2)}${taken.map((row) => row.event).join(',')}]}`;
        // Events queued just before the webhook was turned off wait with its other deliveries.
        await query(
          db,
          sql`INSERT INTO ${ident(schemas.app, 'webhook_deliveries')}
          (id, webhook_id, payload, event_count, event_types, state, next_attempt_at, created_at, updated_at)
          VALUES (${id}, ${webhookId}, ${payload}, ${taken.length},
            ${[...new Set(taken.map((row) => row.event_type))]}::text[], 'pending',
            ${webhook.enabled ? now : null}, ${now}, ${now})`,
        );
        await query(db, sql`DELETE FROM ${events} WHERE id = ANY(${taken.map((row) => row.id)}::bigint[])`);
        made += 1;
      }
      return made;
    });
  }

  /**
   * Claims deliveries to send: at most one per webhook, and none for a webhook that already has
   * one in flight.  A webhook that's off sends only what someone asked to send again.
   */
  async claim(limit: number, now = new Date()): Promise<DeliveryRow[]> {
    if (!this.ready) return [];
    const { pool, schemas } = dataStore(this.app.ctx);
    const deliveries = ident(schemas.app, 'webhook_deliveries');
    const webhooks = ident(schemas.app, 'webhooks');
    const stale = new Date(now.getTime() - LEASE_MS);
    // Held deliveries have no time, so only ones that can go now are ever read.
    const due = sql`d.state = 'pending' AND d.next_attempt_at <= ${now}
      AND (d.lease_at IS NULL OR d.lease_at <= ${stale}) AND (w.enabled OR d.manual)`;
    return withTransaction(pool, async (db) => {
      const ready = await query<{ id: string }>(
        db,
        sql`SELECT w.id FROM ${webhooks} w CROSS JOIN LATERAL (
          SELECT d.next_attempt_at FROM ${deliveries} d WHERE d.webhook_id = w.id AND ${due}
          ORDER BY d.next_attempt_at, d.seq LIMIT 1
        ) first ORDER BY first.next_attempt_at LIMIT ${limit * 4}`,
      );
      const claimed: DeliveryRow[] = [];
      for (const { id: webhookId } of ready.rows) {
        if (claimed.length >= limit) break;
        // One worker at a time claims for a webhook, so two of its deliveries are never in flight.
        const owner = await query(
          db,
          sql`SELECT id FROM ${webhooks} WHERE id = ${webhookId} FOR NO KEY UPDATE SKIP LOCKED`,
        );
        if (!owner.rowCount) continue;
        const busy = await query(
          db,
          sql`SELECT 1 FROM ${deliveries} WHERE webhook_id = ${webhookId} AND lease_at > ${stale} LIMIT 1`,
        );
        if (busy.rowCount) continue;
        const next = await query<DeliveryRow>(
          db,
          sql`UPDATE ${deliveries} SET lease_at = ${now}, lease_token = ${newId('job')}
          WHERE id = (
            SELECT d.id FROM ${deliveries} d JOIN ${webhooks} w ON w.id = d.webhook_id
            WHERE d.webhook_id = ${webhookId} AND ${due}
            ORDER BY d.next_attempt_at, d.seq LIMIT 1 FOR UPDATE OF d SKIP LOCKED
          ) RETURNING *`,
        );
        claimed.push(...next.rows);
      }
      return claimed;
    });
  }

  /** Sends a claimed delivery once and records how it went. */
  async deliver(row: DeliveryRow): Promise<void> {
    const { pool, schemas } = dataStore(this.app.ctx);
    try {
      const webhook = await loadWebhook(pool, schemas, row.webhook_id);
      // A deleted webhook took its deliveries with it.
      if (!webhook) return;
      const sentAt = new Date();
      const started = performance.now();
      const outcome = await this.send(webhook, row, sentAt);
      await this.record(row, webhook, outcome, sentAt, Math.round(performance.now() - started));
    } catch (error) {
      // Error messages can quote addresses, so only the error's kind is logged.
      this.app.log.error(
        {
          webhookId: row.webhook_id,
          deliveryId: row.id,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        'webhook delivery failed',
      );
      await this.release(row).catch(() => undefined);
    }
  }

  private async send(webhook: WebhookRow, row: DeliveryRow, sentAt: Date): Promise<Outcome> {
    const config = this.app.ctx.config;
    const { pool, schemas } = dataStore(this.app.ctx);
    const scope = new AccessScope(pool, schemas, {
      orgId: webhook.org_id,
      userId: webhook.created_by ?? '',
      kind: 'member',
      adminRoles: [],
      sessionId: '',
      csrfToken: '',
    });
    await scope.prepare(webhook.database_id);
    if (!scope.allowsUse(webhook.database_id, 'external') || !scope.allowsUse(webhook.database_id, 'export'))
      return { status: null, error: 'governance.classificationDenied', ok: false, retry: false };
    let secrets: string[];
    try {
      secrets = await signingSecrets(config.secretKey, webhook, sentAt);
    } catch {
      // Sealed with another instance key, so nothing can sign for it until someone makes a new secret.
      this.app.log.error({ webhookId: webhook.id }, 'webhook secret unreadable');
      return { status: null, error: 'webhooks.delivery.failed', ok: false, retry: false };
    }
    try {
      const response = await callOut(
        {
          url: webhook.url,
          method: 'POST',
          headers: {
            'user-agent': 'Riosoma-Webhooks',
            'riosoma-signature': signatureHeader(secrets, Math.floor(sentAt.getTime() / 1000), row.payload),
            'riosoma-delivery-id': row.id,
          },
          body: row.payload,
        },
        {
          resolve: this.resolve,
          allowPrivate: allowsPrivate(webhook.url, config),
          timeoutMs: this.timeoutMs,
        },
      );
      return answered(response.status);
    } catch (error) {
      if (error instanceof OutboundError) return unanswered(error);
      throw error;
    }
  }

  /** Gives up a claim without an attempt, so the delivery is tried again a little later. */
  private async release(row: DeliveryRow): Promise<void> {
    const { pool, schemas } = dataStore(this.app.ctx);
    await query(
      pool,
      sql`UPDATE ${ident(schemas.app, 'webhook_deliveries')}
      SET next_attempt_at = ${new Date(Date.now() + RETRY_DELAYS_MS[0]!)}, lease_at = NULL, lease_token = NULL
      WHERE id = ${row.id} AND lease_token = ${row.lease_token}`,
    );
  }

  private async record(
    row: DeliveryRow,
    webhook: WebhookRow,
    outcome: Outcome,
    at: Date,
    ms: number,
  ): Promise<void> {
    const { pool, schemas } = dataStore(this.app.ctx);
    const webhooks = ident(schemas.app, 'webhooks');
    const attempts = row.attempts + 1;
    const turnedOff = await withTransaction(pool, async (db) => {
      // The webhook stays locked while its health changes, so someone turning it on or off waits.
      const found = await query<{ enabled: boolean; failing_since: Date | null }>(
        db,
        sql`SELECT enabled, failing_since FROM ${webhooks} WHERE id = ${webhook.id} FOR NO KEY UPDATE`,
      );
      const health = found.rows[0];
      if (!health) return false;
      const failingSince = outcome.ok ? null : (health.failing_since ?? at);
      const turnOff =
        health.enabled && failingSince !== null && at.getTime() - failingSince.getTime() >= FAILING_LIMIT_MS;
      const enabled = health.enabled && !turnOff;
      const retry = !outcome.ok && outcome.retry && attempts < MAX_ATTEMPTS;
      // A webhook that's off holds its retries until it's back on.
      const next = retry && enabled ? new Date(at.getTime() + RETRY_DELAYS_MS[attempts - 1]!) : null;
      const updated = await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'webhook_deliveries')}
        SET state = ${outcome.ok ? 'succeeded' : retry ? 'pending' : 'failed'}, attempts = ${attempts},
          next_attempt_at = ${next}, manual = false, lease_at = NULL, lease_token = NULL, updated_at = ${at}
        WHERE id = ${row.id} AND lease_token = ${row.lease_token}`,
      );
      // Someone else took the delivery over after the lease ran out, and their attempt counts instead.
      if (!updated.rowCount) return false;
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'webhook_attempts')} (delivery_id, at, status, ms, error, manual)
        VALUES (${row.id}, ${at}, ${outcome.status}, ${ms}, ${outcome.error}, ${row.manual})`,
      );
      await query(
        db,
        sql`UPDATE ${webhooks} SET failing_since = ${failingSince},
        last_success_at = CASE WHEN ${outcome.ok} THEN ${at}::timestamptz ELSE last_success_at END
        WHERE id = ${webhook.id}`,
      );
      if (!turnOff) return false;
      await query(
        db,
        sql`UPDATE ${webhooks} SET enabled = false, disabled_reason = ${DISABLED_FAILING}, updated_at = ${at}
        WHERE id = ${webhook.id}`,
      );
      await holdDeliveries(db, schemas, webhook.id);
      await auditEvent(
        db,
        compile(sql`${ident(schemas.audit)}`).text,
        'data.webhook.disabled',
        { orgId: webhook.org_id },
        {
          databaseId: webhook.database_id,
          webhookId: webhook.id,
          reason: DISABLED_FAILING,
        },
      );
      return true;
    });
    const facts = { webhookId: webhook.id, deliveryId: row.id, status: outcome.status, attempts };
    if (!outcome.ok) this.app.log.warn({ ...facts, messageKey: outcome.error }, 'webhook delivery failed');
    else this.app.log.debug(facts, 'webhook delivered');
    if (turnedOff)
      this.app.log.warn({ webhookId: webhook.id, messageKey: DISABLED_FAILING }, 'webhook turned off');
  }

  /** Removes deliveries and attempts older than the retention period, a batch at a time. */
  async cleanup(now = new Date()): Promise<number> {
    if (!this.ready) return 0;
    const { pool, schemas } = dataStore(this.app.ctx);
    const deliveries = ident(schemas.app, 'webhook_deliveries');
    const attempts = ident(schemas.app, 'webhook_attempts');
    const heldWebhooks = sql`SELECT w.id FROM ${ident(schemas.app, 'webhooks')} w
      JOIN ${ident(schemas.app, 'databases')} d ON d.id = w.database_id WHERE d.legal_hold`;
    const cutoff = new Date(now.getTime() - RETENTION_MS);
    const stale = new Date(now.getTime() - LEASE_MS);
    let removed = 0;
    for (const statement of [
      sql`DELETE FROM ${attempts} WHERE id IN (SELECT id FROM ${attempts} WHERE at < ${cutoff}
        AND delivery_id NOT IN (SELECT id FROM ${deliveries} WHERE webhook_id IN (${heldWebhooks})) LIMIT 5000)`,
      sql`DELETE FROM ${deliveries} WHERE id IN (
        SELECT id FROM ${deliveries} WHERE updated_at < ${cutoff}
        AND webhook_id NOT IN (${heldWebhooks})
        AND (lease_at IS NULL OR lease_at <= ${stale}) LIMIT 5000
      )`,
    ])
      for (;;) {
        const result = await query(pool, statement);
        removed += result.rowCount ?? 0;
        if ((result.rowCount ?? 0) < 5000) break;
      }
    if (removed) this.app.log.info({ removed }, 'old webhook deliveries removed');
    return removed;
  }
}

export function installWebhooks(app: FastifyInstance): WebhookWorker {
  const worker = new WebhookWorker(app);
  app.ctx.webhooks = worker;
  app.addHook('onReady', async () => {
    worker.start();
  });
  app.addHook('onClose', async () => {
    await worker.close();
  });
  return worker;
}
