import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  PAYMENT_EVENTS,
  PaymentSettings,
  RecordId,
  TableId,
  type StripeConnection,
  type RecordPayment,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { requireActor } from '../auth/sessions.js';
import { AccessScope } from '../data/access.js';
import { dataStore } from '../data/context.js';
import { lock, retry } from '../data/commands/transaction.js';
import { loadFields, loadTable, loadView } from '../data/metadata.js';
import { requireVisibleRecords } from '../data/permissions/enforce.js';
import { audit } from '../data/public-forms.js';
import { pageById, settingsOf } from '../bookings/pages.js';
import { parse } from '../http/validate.js';
import { sealCredential } from '../credentials/service.js';
import { checkKey, refused, stripeRequest } from './stripe.js';
import {
  activeConnection,
  connectionKey,
  newConnectionId,
  pageSettings,
  paymentAudit,
  priceFields,
  resultFields,
  secretContext,
  validateSettings,
  type ConnectionRow,
  type PaymentRow,
} from './store.js';
import { receiveWebhook } from './service.js';

const Target = z.object({
  kind: z.enum(['form', 'booking']),
  targetId: z.string().regex(/^[A-Za-z0-9]{17,22}$/),
});
const RecordParams = z.object({ tableId: TableId, recordId: RecordId });
const Connect = z.strictObject({
  secretKey: z.string().min(1).max(512),
  webhookSecret: z
    .string()
    .regex(/^whsec_[A-Za-z0-9]+$/)
    .max(512),
});

export async function paymentRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const admin = {
    config: {
      policy: { kind: 'admin' as const, area: 'integrations' as const, scope: 'organization' as const },
    },
  };
  const session = { config: { policy: { kind: 'session' as const } } };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  async function connectionView(orgId: string): Promise<StripeConnection> {
    const { pool, schemas } = dataStore(ctx);
    const connection = await activeConnection(pool, schemas, orgId);
    return {
      connected: Boolean(connection),
      mode: connection ? (connection.live ? 'live' : 'test') : null,
      webhookUrl:
        connection && ctx.config.baseUrl
          ? `${ctx.config.baseUrl.replace(/\/+$/, '')}/api/payments/webhooks/${connection.id}`
          : '',
      events: PAYMENT_EVENTS,
    };
  }
  app.get('/api/admin/payments/stripe', admin, async (request) =>
    connectionView(requireActor(request).orgId),
  );
  app.put('/api/admin/payments/stripe', { ...admin, bodyLimit: 2048 }, async (request) => {
    const actor = requireActor(request);
    const input = parse(Connect, request.body);
    if (!ctx.config.baseUrl) throw new AppError('validation_failed', 'payments.baseUrl');
    const live = await checkKey(input.secretKey);
    const { pool, schemas } = dataStore(ctx);
    const id = newConnectionId();
    await withTransaction(pool, async (db) => {
      await query(
        db,
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:stripe:${actor.orgId}`}, 0))`,
      );
      const previous = await activeConnection(db, schemas, actor.orgId);
      if (previous) {
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'stripe_connections')} SET enabled = false WHERE id = ${previous.id}`,
        );
        await paymentAudit(db, schemas, actor.orgId, actor.userId, 'disconnected', {
          connectionId: previous.id,
        });
      }
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'stripe_connections')} (id, org_id, secret_key, webhook_secret, live) VALUES (${id}, ${actor.orgId}, ${await sealCredential(ctx.config.secretKey, input.secretKey, secretContext(id, 'key'), actor.orgId, db)}, ${await sealCredential(ctx.config.secretKey, input.webhookSecret, secretContext(id, 'webhook'), actor.orgId, db)}, ${live})`,
      );
      await paymentAudit(db, schemas, actor.orgId, actor.userId, 'connected', { connectionId: id, live });
    });
    return connectionView(actor.orgId);
  });
  app.delete('/api/admin/payments/stripe', admin, async (request, reply) => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    await withTransaction(pool, async (db) => {
      await query(
        db,
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:stripe:${actor.orgId}`}, 0))`,
      );
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'stripe_connections')} SET enabled = false WHERE org_id = ${actor.orgId} AND enabled`,
      );
      await paymentAudit(db, schemas, actor.orgId, actor.userId, 'disconnected');
    });
    return reply.status(204).send();
  });

  for (const method of ['GET', 'PUT'] as const)
    app.route({
      method,
      url: '/api/payment-pages/:kind/:targetId',
      ...session,
      handler: async (request) => {
        const { kind, targetId } = parse(Target, request.params);
        const actor = requireActor(request);
        const { pool, schemas } = dataStore(ctx);
        return retry(() =>
          withTransaction(pool, async (db) => {
            const form = kind === 'form' ? await loadView(db, schemas, targetId) : null;
            const booking = kind === 'booking' ? await pageById(db, schemas, targetId) : null;
            const tableId = form?.view.tableId ?? booking?.table_id;
            if (!tableId || (form && (form.trashed || form.view.type !== 'form'))) throw refused();
            const table = await loadTable(db, schemas, tableId);
            if (!table || table.trashed || table.orgId !== actor.orgId || table.source || table.joined)
              throw refused();
            const c = { db, schemas, actor, databaseId: table.databaseId, secretKey: ctx.config.secretKey };
            await lock(c, [`database:${table.databaseId}`]);
            const scope = new AccessScope(db, schemas, actor);
            await scope.require(table.databaseId, 'editSchema');
            if (method === 'GET') return { settings: await pageSettings(db, schemas, targetId) };
            const { settings } = parse(
              z.strictObject({ settings: PaymentSettings.nullable() }),
              request.body,
            );
            const priced = priceFields(await pageSettings(db, schemas, targetId));
            if (settings) {
              if (!(await activeConnection(db, schemas, actor.orgId)))
                throw new AppError('validation_failed', 'payments.notConnected');
              const bookingSettings = booking ? settingsOf(booking.settings) : null;
              const questions = form?.view.config.form.questions ?? bookingSettings?.questions ?? [];
              const fields = await loadFields(db, schemas, [tableId]);
              const asked = new Set(
                questions
                  .filter((question) => {
                    const field = fields.find((field) => field.id === question.fieldId);
                    return (
                      field &&
                      scope.canEditField(tableId, field) &&
                      !scope.restrictedForAnyone(tableId, field)
                    );
                  })
                  .map((question) => question.fieldId),
              );
              await validateSettings(c, tableId, settings, asked);
              await resultFields(c, tableId, settings.currency);
              await query(
                db,
                sql`INSERT INTO ${ident(schemas.app, 'payment_pages')} (target_id, kind, table_id, settings) VALUES (${targetId}, ${kind}, ${tableId}, ${JSON.stringify(settings)}::jsonb) ON CONFLICT (target_id) DO UPDATE SET settings = EXCLUDED.settings`,
              );
            } else
              await query(
                db,
                sql`DELETE FROM ${ident(schemas.app, 'payment_pages')} WHERE target_id = ${targetId}`,
              );
            await paymentAudit(db, schemas, actor.orgId, actor.userId, 'pageConfigured', {
              targetId,
              enabled: Boolean(settings),
            });
            // An edit link leaves alone the answers its response was priced by, which are the ones
            // the page names now.  When the page stops naming one, the links sent so far end, so
            // an earlier response can't be repriced through its link.
            const naming = priceFields(settings);
            if (form && [...priced].some((id) => !naming.has(id))) {
              const revoked = await query(
                db,
                sql`UPDATE ${ident(schemas.app, 'public_forms')} SET edit_version = edit_version + 1 WHERE view_id = ${targetId}`,
              );
              if (revoked.rowCount)
                await audit(db, schemas, actor.orgId, actor.userId, 'data.form.editsRevoked', {
                  databaseId: table.databaseId,
                  tableId,
                  viewId: targetId,
                });
            }
            return { settings };
          }),
        );
      },
    });

  for (const method of ['GET', 'POST'] as const)
    app.route({
      method,
      url: '/api/tables/:tableId/records/:recordId/payment',
      ...admin,
      handler: async (request) => {
        const { tableId, recordId } = parse(RecordParams, request.params);
        const actor = requireActor(request);
        const { pool, schemas } = dataStore(ctx);
        return withTransaction(pool, async (db): Promise<RecordPayment | null> => {
          const table = await loadTable(db, schemas, tableId);
          if (!table || table.orgId !== actor.orgId || table.trashed) throw refused();
          const scope = new AccessScope(db, schemas, actor);
          await scope.require(table.databaseId, 'editRecords');
          await requireVisibleRecords(db, schemas, scope, tableId, [recordId]);
          const payment = (
            await query<PaymentRow>(
              db,
              sql`SELECT * FROM ${ident(schemas.app, 'payments')} WHERE record_id = ${recordId} AND table_id = ${tableId} AND org_id = ${actor.orgId} FOR UPDATE`,
            )
          ).rows[0];
          if (!payment) return null;
          if (method === 'POST') {
            if (payment.state !== 'paid' || !payment.intent_id) throw refused();
            const connection = (
              await query<ConnectionRow>(
                db,
                sql`SELECT * FROM ${ident(schemas.app, 'stripe_connections')} WHERE id = ${payment.connection_id}`,
              )
            ).rows[0]!;
            await stripeRequest(
              await connectionKey(ctx, connection, db),
              'refunds',
              new URLSearchParams({ payment_intent: payment.intent_id }),
              `refund:${recordId}`,
            );
            await paymentAudit(db, schemas, actor.orgId, actor.userId, 'refundRequested', { recordId });
          }
          return {
            state: payment.state,
            amount: payment.amount,
            currency: payment.currency,
            refundable: payment.state === 'paid',
          };
        });
      },
    });
}

/**
 * A separate parser scope keeps the signature's bytes untouched.  Refusals reach the audit log only
 * for a connection of ours, and then as one entry an hour with a count, so unauthenticated posts
 * can't fill it.
 */
export async function paymentWebhookRoutes(app: FastifyInstance) {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body),
  );
  app.post(
    '/api/payments/webhooks/:connectionId',
    { bodyLimit: 1024 * 1024, config: { policy: { kind: 'public' } } },
    async (request) => {
      const { connectionId } = parse(
        z.object({ connectionId: z.string().regex(/^[a-f0-9]{48}$/) }),
        request.params,
      );
      if (!Buffer.isBuffer(request.body)) throw refused();
      await receiveWebhook(app.ctx, connectionId, request.body, request.headers['stripe-signature']);
      return { received: true };
    },
  );
}
