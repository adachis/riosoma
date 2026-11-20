import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AppError, PAYMENT_EVENTS, newId, type PaymentState } from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { AppContext } from '../app.js';
import { applyCommand, parseCommand } from '../data/commands/index.js';
import type { CommandContext } from '../data/commands/context.js';
import { lock, recordChange, retry } from '../data/commands/transaction.js';
import { dataStore, type DataSchemas } from '../data/context.js';
import type { Actor } from '../http/policy.js';
import type { MailMessage } from '../mail/types.js';
import { unseal } from '../secrets.js';
import { unsealCredential } from '../credentials/service.js';
import {
  connectionKey,
  holdLapsed,
  paymentAudit,
  paymentValues,
  secretContext,
  type ConnectionRow,
  type PaymentRow,
} from './store.js';
import { refused, stripeRequest, unavailable, verifyEvent } from './stripe.js';

/** Where Stripe Checkout takes a payer, and the one origin a checkout address may have */
export const CHECKOUT_ORIGIN = 'https://checkout.stripe.com';

const Session = z.object({
  id: z.string().regex(/^cs_[A-Za-z0-9_]+$/),
  object: z.literal('checkout.session'),
  mode: z.literal('payment'),
  livemode: z.boolean(),
  client_reference_id: z.string(),
  metadata: z.object({ record_id: z.string(), connection_id: z.string() }),
  currency: z.string(),
  amount_total: z.number().int(),
  expires_at: z.number().int(),
  payment_intent: z
    .string()
    .regex(/^pi_[A-Za-z0-9]+$/)
    .nullable(),
  payment_status: z.string(),
  status: z.string(),
  url: z.string().nullable().optional(),
});

export function checkedSession(object: unknown, payment: PaymentRow, connection: ConnectionRow) {
  const parsed = Session.safeParse(object);
  if (!parsed.success) throw refused();
  const session = parsed.data;
  if (
    session.livemode !== connection.live ||
    session.amount_total !== payment.amount ||
    session.currency !== payment.currency ||
    session.client_reference_id !== payment.record_id ||
    session.metadata.record_id !== payment.record_id ||
    session.metadata.connection_id !== connection.id ||
    session.expires_at !== payment.expires_at.getTime() / 1000 ||
    (payment.session_id && session.id !== payment.session_id) ||
    (payment.intent_id && session.payment_intent !== payment.intent_id)
  )
    throw refused();
  return session;
}

/** The Checkout Session request, exactly as production sends it */
export function checkoutBody(payment: PaymentRow, baseUrl: string): URLSearchParams {
  return new URLSearchParams({
    mode: 'payment',
    'payment_method_types[0]': 'card',
    'adaptive_pricing[enabled]': 'false',
    'line_items[0][price_data][currency]': payment.currency,
    'line_items[0][price_data][unit_amount]': String(payment.amount),
    'line_items[0][price_data][product_data][name]': payment.description,
    'line_items[0][quantity]': '1',
    client_reference_id: payment.record_id,
    'metadata[record_id]': payment.record_id,
    'metadata[connection_id]': payment.connection_id,
    'payment_intent_data[metadata][record_id]': payment.record_id,
    'payment_intent_data[metadata][connection_id]': payment.connection_id,
    expires_at: String(payment.expires_at.getTime() / 1000),
    success_url: `${baseUrl.replace(/\/+$/, '')}/payments/confirm`,
    cancel_url: `${baseUrl.replace(/\/+$/, '')}/payments/confirm`,
  });
}

/** No one in particular: the payment service writes what Stripe reported, not any person. */
function nobodyIn(orgId: string): Actor {
  return { userId: '', orgId, sessionId: '', kind: 'guest', adminRoles: [], csrfToken: '' };
}

async function connectionById(db: Queryable, schemas: DataSchemas, id: string) {
  return (
    await query<ConnectionRow>(
      db,
      sql`SELECT * FROM ${ident(schemas.app, 'stripe_connections')} WHERE id = ${id}`,
    )
  ).rows[0];
}

/**
 * Writes a payment's state into its record's result fields as a system change, with a grant for
 * exactly those fields in exactly that record.  A record or table gone for good leaves only the
 * payment's own row to change.
 */
async function writeResult(
  db: Queryable,
  schemas: DataSchemas,
  secretKey: Buffer,
  payment: PaymentRow,
  state: PaymentState,
  reference: string | null,
): Promise<void> {
  if (!payment.table_id || !payment.database_id) return;
  const kept = await query(
    db,
    sql`SELECT 1 FROM ${ident(schemas.app, 'tables')} t
      WHERE t.id = ${payment.table_id} AND to_regclass(${`"${schemas.data}"."${payment.table_id}"`}) IS NOT NULL`,
  );
  if (!kept.rowCount) return;
  const record = await query(
    db,
    sql`SELECT 1 FROM ${ident(schemas.data, payment.table_id)} WHERE __id = ${payment.record_id}`,
  );
  if (!record.rowCount) return;
  const { values, grant } = await paymentValues(db, schemas, payment, state, reference);
  const c: CommandContext = {
    db,
    schemas,
    actor: nobodyIn(payment.org_id),
    databaseId: payment.database_id,
    secretKey,
    managedWrite: grant,
  };
  const command = parseCommand({
    id: newId('command'),
    groupId: newId('action'),
    kind: 'record.update',
    tableId: payment.table_id,
    records: [{ id: payment.record_id, values }],
  });
  await recordChange(c, await applyCommand(c, command), {
    commandId: command.id,
    groupId: command.groupId,
    clientId: null,
    system: true,
  });
}

export async function createCheckout(ctx: AppContext, recordId: string): Promise<string> {
  const { pool, schemas } = dataStore(ctx);
  if (!ctx.config.baseUrl) throw unavailable();
  const payment = (
    await query<PaymentRow>(
      pool,
      sql`SELECT * FROM ${ident(schemas.app, 'payments')} WHERE record_id = ${recordId}`,
    )
  ).rows[0];
  if (!payment) throw unavailable();
  if (payment.checkout_url) return payment.checkout_url;
  if (payment.state !== 'pending' || payment.expires_at.getTime() <= Date.now()) throw unavailable();
  const connection = await connectionById(pool, schemas, payment.connection_id);
  if (!connection) throw unavailable();
  const object = await stripeRequest(
    await connectionKey(ctx, connection),
    'checkout/sessions',
    checkoutBody(payment, ctx.config.baseUrl),
    `checkout:${payment.record_id}`,
  );
  const session = checkedSession(object, payment, connection);
  if (!session.url || session.status !== 'open') throw unavailable();
  const url = new URL(session.url);
  if (url.origin !== CHECKOUT_ORIGIN || url.username || url.password) throw unavailable();
  const saved = await withTransaction(pool, async (db) => {
    const changed = await query(
      db,
      sql`UPDATE ${ident(schemas.app, 'payments')} SET session_id = ${session.id}, checkout_url = ${session.url}
        WHERE record_id = ${recordId} AND state = 'pending' AND checkout_url IS NULL
          AND (session_id IS NULL OR session_id = ${session.id})`,
    );
    if (changed.rowCount)
      await paymentAudit(db, schemas, payment.org_id, null, 'sessionCreated', {
        recordId,
        sessionId: session.id,
      });
    return Boolean(changed.rowCount);
  });
  if (!saved) throw unavailable();
  return session.url;
}

/**
 * Ends a payment whose Checkout Session couldn't be made: it's marked Failed, in its record too, so
 * a booking's place is free at once and no Pending record waits for a webhook that never comes.
 */
export async function failCheckout(ctx: AppContext, recordId: string): Promise<void> {
  const { pool, schemas } = dataStore(ctx);
  await retry(() =>
    withTransaction(pool, async (db) => {
      const found = (
        await query<PaymentRow>(
          db,
          sql`SELECT * FROM ${ident(schemas.app, 'payments')} WHERE record_id = ${recordId}`,
        )
      ).rows[0];
      if (!found) return;
      if (found.database_id)
        await lock({ db, schemas, actor: nobodyIn(found.org_id), databaseId: found.database_id }, [
          `database:${found.database_id}`,
        ]);
      const failed = (
        await query<PaymentRow>(
          db,
          sql`UPDATE ${ident(schemas.app, 'payments')} SET state = 'failed'
            WHERE record_id = ${recordId} AND state = 'pending' AND checkout_url IS NULL RETURNING *`,
        )
      ).rows[0];
      if (!failed) return;
      await writeResult(db, schemas, ctx.config.secretKey, failed, 'failed', null);
      await paymentAudit(db, schemas, failed.org_id, null, 'sessionFailed', { recordId });
    }),
  );
}

/**
 * Sends the visitor to Stripe, or, when Stripe won't open a session, fails the payment and says
 * plainly that nothing was charged.
 */
export async function startCheckout(
  ctx: AppContext,
  recordId: string,
  kind: 'form' | 'booking',
  log?: FastifyInstance['log'],
): Promise<string> {
  try {
    return await createCheckout(ctx, recordId);
  } catch (error) {
    try {
      await failCheckout(ctx, recordId);
    } catch (cause) {
      // The hold still ends when the session's time runs out.
      log?.warn({ err: cause }, 'payment not marked failed');
    }
    throw new AppError(
      'unavailable',
      kind === 'booking' ? 'payments.checkoutFailed.booking' : 'payments.checkoutFailed',
      { cause: error },
    );
  }
}

/** Terminal success never moves backward when deliveries arrive out of order */
export function nextState(previous: PaymentState, requested: PaymentState): PaymentState {
  if (previous === 'refunded' || requested === 'refunded') return 'refunded';
  if (previous === 'paid' || requested === 'paid') return 'paid';
  return previous === 'pending' ? requested : previous;
}

/**
 * Counts a refused webhook for its connection in the current hour.  The audit log gets one entry
 * per connection for each hour that had any, with the count, once the hour is over.
 */
export async function countRefusal(
  db: Queryable,
  schemas: DataSchemas,
  connectionId: string,
  reason: string,
): Promise<void> {
  const table = ident(schemas.app, 'payment_refusals');
  await query(
    db,
    sql`INSERT INTO ${table} AS r (connection_id, hour, count, reasons)
      VALUES (${connectionId}, date_trunc('hour', statement_timestamp()), 1, jsonb_build_object(${reason}::text, 1))
      ON CONFLICT (connection_id, hour) DO UPDATE SET count = r.count + 1,
        reasons = r.reasons || jsonb_build_object(${reason}::text, COALESCE((r.reasons ->> ${reason}::text)::int, 0) + 1)`,
  );
  await flushRefusals(db, schemas, connectionId);
}

/** Turns every hour of refusals that's over into its one audit entry. */
export async function flushRefusals(
  db: Queryable,
  schemas: DataSchemas,
  connectionId?: string,
): Promise<void> {
  const closed = await query<{
    connection_id: string;
    org_id: string;
    hour: Date;
    count: number;
    reasons: Record<string, number>;
  }>(
    db,
    sql`DELETE FROM ${ident(schemas.app, 'payment_refusals')} r USING ${ident(schemas.app, 'stripe_connections')} c
      WHERE c.id = r.connection_id AND r.hour < date_trunc('hour', statement_timestamp())
        AND (${connectionId ?? null}::text IS NULL OR r.connection_id = ${connectionId ?? null})
      RETURNING r.connection_id, c.org_id, r.hour, r.count, r.reasons`,
  );
  for (const row of closed.rows)
    await paymentAudit(db, schemas, row.org_id, null, 'webhookRefused', {
      connectionId: row.connection_id,
      from: row.hour.toISOString(),
      to: new Date(row.hour.getTime() + 3_600_000).toISOString(),
      count: row.count,
      reasons: row.reasons,
    });
}

/** Asks Stripe to end an open Checkout Session, so nobody can pay on it any more */
export function expireSession(key: string, sessionId: string): Promise<Record<string, unknown>> {
  return stripeRequest(
    key,
    `checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
    new URLSearchParams(),
  );
}

/** Whether a pending booking's record, table, or database is gone or in the trash */
async function givenUp(db: Queryable, schemas: DataSchemas, payment: PaymentRow): Promise<boolean> {
  const { placeKept } = await import('../bookings/public.js');
  return (await placeKept(db, schemas, payment, false)) === 'trashed';
}

/**
 * Ends the Checkout Session of every pending booking whose place was given up, because its record,
 * table, or database went to the trash, so nobody can pay for a place that's free again.  The
 * payment is then Expired.  A session Stripe won't expire because it was just paid is left for
 * its webhook, which refunds it.  `databaseId` limits it to one database.
 */
export async function releaseHolds(ctx: AppContext, databaseId?: string): Promise<void> {
  const { pool, schemas } = dataStore(ctx);
  const pending = await query<PaymentRow>(
    pool,
    sql`SELECT * FROM ${ident(schemas.app, 'payments')}
      WHERE state = 'pending' AND kind = 'booking' AND session_id IS NOT NULL
        AND (${databaseId ?? null}::text IS NULL OR database_id = ${databaseId ?? null} OR database_id IS NULL)
      ORDER BY expires_at LIMIT 200`,
  );
  for (const payment of pending.rows) {
    if (!(await givenUp(pool, schemas, payment))) continue;
    const connection = await connectionById(pool, schemas, payment.connection_id);
    if (!connection) continue;
    const key = await connectionKey(ctx, connection);
    let session: ReturnType<typeof checkedSession>;
    try {
      session = checkedSession(await expireSession(key, payment.session_id!), payment, connection);
    } catch {
      // Already expired, just paid, or Stripe out of reach: read where it stands.
      try {
        session = checkedSession(
          await stripeRequest(key, `checkout/sessions/${payment.session_id!}`),
          payment,
          connection,
        );
      } catch {
        continue;
      }
    }
    if (session.status !== 'expired') continue;
    await retry(() =>
      withTransaction(pool, async (db) => {
        if (payment.database_id)
          await lock({ db, schemas, actor: nobodyIn(payment.org_id), databaseId: payment.database_id }, [
            `database:${payment.database_id}`,
          ]);
        const current = (
          await query<PaymentRow>(
            db,
            sql`UPDATE ${ident(schemas.app, 'payments')} SET state = 'expired'
              WHERE record_id = ${payment.record_id} AND state = 'pending' RETURNING *`,
          )
        ).rows[0];
        if (!current) return;
        await writeResult(db, schemas, ctx.config.secretKey, current, 'expired', current.session_id);
        await paymentAudit(db, schemas, current.org_id, null, 'released', {
          recordId: current.record_id,
          sessionId: current.session_id,
        });
      }),
    );
  }
}

/** Frees given-up holds at Stripe and at once, and each connection's refusals into the audit log. */
export interface PaymentUpkeep {
  /** Ends the Checkout Sessions of pending bookings given up in a database, after the change commits */
  release(databaseId?: string): Promise<void>;
}

/**
 * Writes each connection's closed hours of refused webhooks to the audit log every few minutes,
 * and every minute ends the sessions of pending bookings given up by any path, in case a release
 * right after the change didn't reach Stripe.
 */
export function installPaymentUpkeep(app: FastifyInstance): void {
  let running: Promise<void> | undefined;
  let timers: NodeJS.Timeout[] = [];
  const ready = () => Boolean(app.ctx.pool && app.ctx.config.database);
  const upkeep: PaymentUpkeep = {
    async release(databaseId) {
      if (!ready()) return;
      try {
        await releaseHolds(app.ctx, databaseId);
      } catch (error) {
        app.log.warn({ err: error }, 'payment holds not released');
      }
    },
  };
  app.ctx.payments = upkeep;
  const run = (work: () => Promise<void>) => {
    if (running || !ready()) return;
    running = work()
      .catch((error: unknown) => app.log.error({ err: error }, 'payment upkeep failed'))
      .finally(() => {
        running = undefined;
      });
  };
  // The database can arrive after start, through setup, so each run looks for it then.
  const flush = async () => {
    const { pool, schemas } = dataStore(app.ctx);
    await withTransaction(pool, (db) => flushRefusals(db, schemas));
  };
  app.addHook('onReady', async () => {
    timers = [
      setInterval(() => run(flush), 5 * 60_000),
      setInterval(() => run(() => upkeep.release()), 60_000),
    ];
    for (const timer of timers) timer.unref();
  });
  app.addHook('onClose', async () => {
    for (const timer of timers) clearInterval(timer);
    await running;
  });
}

export async function receiveWebhook(
  ctx: AppContext,
  connectionId: string,
  raw: Buffer,
  signature: unknown,
): Promise<void> {
  const { pool, schemas } = dataStore(ctx);
  // Posts naming no connection of ours are refused without a trace, so nobody can fill the audit log.
  const connection = await connectionById(pool, schemas, connectionId);
  if (!connection) throw refused();
  let mail: { recordId: string; sealed: string; kind: 'booked' | 'refunded' } | null;
  try {
    const event = verifyEvent(
      raw,
      signature,
      await unsealCredential(
        ctx.config.secretKey,
        connection.webhook_secret,
        secretContext(connection.id, 'webhook'),
        connection.org_id,
      ),
    );
    if (event.livemode !== connection.live) throw refused();
    if (!(PAYMENT_EVENTS as readonly string[]).includes(event.type)) return;
    mail = await retry(() =>
      withTransaction(pool, async (db) => {
        const inserted = await query(
          db,
          sql`INSERT INTO ${ident(schemas.app, 'payment_events')} (connection_id, event_id) VALUES (${connection.id}, ${event.id}) ON CONFLICT DO NOTHING RETURNING event_id`,
        );
        if (!inserted.rowCount) return null;
        const object = event.data.object;
        let payment: PaymentRow | undefined;
        if (event.type === 'charge.refunded') {
          if (typeof object.payment_intent !== 'string') throw refused();
          payment = (
            await query<PaymentRow>(
              db,
              sql`SELECT * FROM ${ident(schemas.app, 'payments')} WHERE connection_id = ${connection.id} AND intent_id = ${object.payment_intent}`,
            )
          ).rows[0];
          if (!payment) {
            // Refunds can precede completion delivery, so recover only this integration's reference
            const intent = await stripeRequest(
              await connectionKey(ctx, connection, db),
              `payment_intents/${encodeURIComponent(object.payment_intent)}`,
            );
            const metadata = z
              .object({ record_id: z.string(), connection_id: z.literal(connection.id) })
              .safeParse(intent.metadata);
            if (!metadata.success) return null;
            payment = (
              await query<PaymentRow>(
                db,
                sql`SELECT * FROM ${ident(schemas.app, 'payments')} WHERE record_id = ${metadata.data.record_id} AND connection_id = ${connection.id}`,
              )
            ).rows[0];
            if (!payment || !payment.session_id) throw refused();
            const session = checkedSession(
              await stripeRequest(
                await connectionKey(ctx, connection, db),
                `checkout/sessions/${encodeURIComponent(payment.session_id)}`,
              ),
              payment,
              connection,
            );
            if (session.payment_intent !== object.payment_intent || session.payment_status !== 'paid')
              throw refused();
          }
        } else {
          payment =
            typeof object.id === 'string'
              ? (
                  await query<PaymentRow>(
                    db,
                    sql`SELECT * FROM ${ident(schemas.app, 'payments')} WHERE session_id = ${object.id} AND connection_id = ${connection.id}`,
                  )
                ).rows[0]
              : undefined;
          if (!payment) {
            const metadata = z
              .object({ record_id: z.string(), connection_id: z.literal(connection.id) })
              .safeParse(object.metadata);
            if (!metadata.success) return null;
            payment = (
              await query<PaymentRow>(
                db,
                sql`SELECT * FROM ${ident(schemas.app, 'payments')} WHERE record_id = ${metadata.data.record_id} AND connection_id = ${connection.id}`,
              )
            ).rows[0];
            if (!payment) throw refused();
          }
        }
        if (payment.database_id)
          await lock({ db, schemas, actor: nobodyIn(payment.org_id), databaseId: payment.database_id }, [
            `database:${payment.database_id}`,
          ]);
        payment = (
          await query<PaymentRow>(
            db,
            sql`SELECT * FROM ${ident(schemas.app, 'payments')} WHERE record_id = ${payment.record_id} FOR UPDATE`,
          )
        ).rows[0]!;
        let state: PaymentState;
        let sessionId = payment.session_id;
        let intentId: string | null;
        if (event.type === 'charge.refunded') {
          if (
            object.object !== 'charge' ||
            object.livemode !== connection.live ||
            object.amount !== payment.amount ||
            object.currency !== payment.currency ||
            object.paid !== true ||
            (payment.intent_id && object.payment_intent !== payment.intent_id)
          )
            throw refused();
          if (object.refunded !== true || object.amount_refunded !== payment.amount) return null;
          state = 'refunded';
          intentId = String(object.payment_intent);
        } else {
          const session = checkedSession(object, payment, connection);
          sessionId = session.id;
          intentId = session.payment_intent;
          if (event.type === 'checkout.session.expired') {
            if (session.status !== 'expired' || session.payment_status !== 'unpaid') throw refused();
            state = 'expired';
          } else if (event.type === 'checkout.session.async_payment_failed') {
            if (session.status !== 'complete' || session.payment_status !== 'unpaid') throw refused();
            state = 'failed';
          } else {
            if (session.status !== 'complete') throw refused();
            if (session.payment_status !== 'paid') return null;
            if (!intentId) throw refused();
            state = 'paid';
          }
        }
        // A booking paid after its place was given up is refunded in full, never confirmed: its
        // record went to the trash, or its hold ended and someone else has its time now.
        let released: 'trashed' | 'full' | null = null;
        if (
          state === 'paid' &&
          payment.kind === 'booking' &&
          payment.state !== 'paid' &&
          payment.state !== 'refunded'
        ) {
          const { placeKept } = await import('../bookings/public.js');
          const place = await placeKept(db, schemas, payment, holdLapsed(payment));
          if (place !== 'kept') {
            // Asked inside the transaction, so a refusal from Stripe leaves the event unapplied
            // for its next delivery.  The key makes asking again give the same refund.
            await stripeRequest(
              await connectionKey(ctx, connection, db),
              'refunds',
              new URLSearchParams({ payment_intent: intentId! }),
              `refund:${payment.record_id}`,
            );
            released = place;
            state = 'refunded';
          }
        }
        const next = nextState(payment.state, state);
        const mailKind = released ? 'refunded' : next === 'paid' ? 'booked' : null;
        const sendMail = Boolean(mailKind) && !payment.mail_claimed && Boolean(payment.booking_mail);
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'payments')} SET state = ${next}, session_id = ${sessionId}, intent_id = ${intentId}, mail_claimed = mail_claimed OR ${sendMail} WHERE record_id = ${payment.record_id}`,
        );
        if (next !== payment.state) {
          await writeResult(db, schemas, ctx.config.secretKey, payment, next, intentId ?? sessionId);
          await paymentAudit(
            db,
            schemas,
            payment.org_id,
            null,
            released ? 'refundedAfterRelease' : next === 'paid' ? 'confirmed' : next,
            { recordId: payment.record_id, sessionId, ...(released ? { reason: released } : {}) },
          );
        }
        return sendMail
          ? { recordId: payment.record_id, sealed: payment.booking_mail!, kind: mailKind! }
          : null;
      }),
    );
  } catch (error) {
    await retry(() =>
      withTransaction(pool, (db) =>
        countRefusal(
          db,
          schemas,
          connection.id,
          error instanceof AppError ? error.messageKey : 'payments.invalid',
        ),
      ),
    );
    throw error;
  }
  if (mail && ctx.mailer) {
    try {
      const sealed = JSON.parse(
        unseal(ctx.config.secretKey, mail.sealed, `payment-mail:${mail.recordId}`),
        (_key, value: unknown) => {
          if (
            value &&
            typeof value === 'object' &&
            'type' in value &&
            value.type === 'Buffer' &&
            'data' in value &&
            Array.isArray(value.data)
          )
            return Buffer.from(value.data as number[]);
          return value;
        },
      ) as Partial<Record<'booked' | 'refunded', MailMessage>>;
      const message = sealed[mail.kind];
      if (!message) throw unavailable();
      await ctx.mailer.send(message);
    } catch {
      await paymentAudit(pool, schemas, connection.org_id, null, 'confirmationFailed', {
        recordId: mail.recordId,
      });
    }
  }
}
