import {
  AppError,
  DatabaseId,
  WEBHOOK_LIMITS,
  WebhookCreate,
  WebhookDeliveryId,
  WebhookId,
  WebhookUpdate,
  newId,
  type WebhookCreated,
  type WebhookDeliveriesPage,
  type WebhookDelivery,
  type WebhookList,
  type WebhookMeta,
  type WebhookSecret,
} from '@riosoma/contracts';
import { compile, ident, join, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auditEvent } from '../auth/database.js';
import { bindWebhook } from '../authorization/store.js';
import { requireActor } from '../auth/sessions.js';
import { AccessScope } from '../data/access.js';
import { dataStore, type DataSchemas } from '../data/context.js';
import { refuseWhileInReview } from '../data/organization-archives/review-guard.js';
import type { Actor, Policy } from '../http/policy.js';
import { parse } from '../http/validate.js';
import {
  attemptsFor,
  DELIVERY_COLUMNS,
  deliveryOf,
  holdDeliveries,
  loadWebhook,
  newSecret,
  orderedEvents,
  releaseDeliveries,
  sealSecret,
  webhookMeta,
  type DeliverySummaryRow,
  type WebhookRow,
} from './store.js';
import { checkedUrl } from './url.js';
import { LEASE_MS } from './worker.js';

/**
 * Webhook routes, the same for the REST API and the app: `/api/v1/…` with a token that may change
 * schemas, and `/api/…` with a session.  Either way the person needs a role that can change the
 * database's schema.  See `webhooks.ts` in the contracts for the list.
 */

const PAGE = 20;
const Params = z.object({ databaseId: DatabaseId });
const WebhookParams = Params.extend({ webhookId: WebhookId });
const DeliveryParams = WebhookParams.extend({ deliveryId: WebhookDeliveryId });
const Cursor = z.object({ webhookId: WebhookId, seq: z.number().int().positive().safe() });
const notFound = () => new AppError('not_found', 'errors.notFound');
const SUMMARY = join(
  DELIVERY_COLUMNS.map((column) => sql`${ident(column)}`),
  ', ',
);

const VARIANTS: Array<{ prefix: string; policy: Policy }> = [
  { prefix: '/api/v1', policy: { kind: 'token', scope: 'schema.bases:write' } },
  { prefix: '/api', policy: { kind: 'session' } },
];

/** Records a change to a webhook in the audit log. */
async function audit(
  db: Queryable,
  schemas: DataSchemas,
  action: string,
  actor: Actor,
  metadata: Record<string, unknown>,
): Promise<void> {
  await auditEvent(db, compile(sql`${ident(schemas.audit)}`).text, action, actor, metadata);
}

/** The tables a webhook listens to, each checked to be in this database. */
async function checkedTables(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
  tableIds: string[] | null,
): Promise<string[] | null> {
  if (tableIds === null) return null;
  const unique = [...new Set(tableIds)];
  const found = await query(
    db,
    sql`SELECT id FROM ${ident(schemas.app, 'tables')}
    WHERE database_id = ${databaseId} AND trashed_at IS NULL AND id = ANY(${unique}::text[])`,
  );
  if (found.rowCount !== unique.length)
    throw new AppError('validation_failed', 'webhooks.table.unknown', {
      fields: { tableIds: 'webhooks.table.unknown' },
    });
  return unique;
}

/** An address's path or query can carry a secret of the receiver's, so the audit log keeps its host. */
function hostOf(url: string): string {
  return new URL(url).host;
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  /** The data store, the actor, and their access, once the actor may change the database's schema. */
  async function access(request: FastifyRequest, databaseId: string) {
    const { pool, schemas } = dataStore(app.ctx);
    const actor = requireActor(request);
    const scope = new AccessScope(pool, schemas, actor);
    await scope.require(databaseId, 'editSchema');
    return { pool, schemas, actor, scope };
  }

  /**
   * A webhook hears what the person who made it can see.  Someone a field or record rule limits
   * changes only the ones they made, so they can't point another person's at an address of their
   * own, or take its secret, and hear what the rules keep from them.
   */
  function requireOwnWhenLimited(scope: AccessScope, webhook: WebhookRow): void {
    if (webhook.created_by !== scope.actor.userId && scope.limited(webhook.database_id))
      throw new AppError('forbidden', 'webhooks.rulesLimited');
  }

  async function summary(db: Queryable, schemas: DataSchemas, deliveryId: string, webhookId: string) {
    const result = await query<DeliverySummaryRow>(
      db,
      sql`SELECT ${SUMMARY} FROM ${ident(schemas.app, 'webhook_deliveries')}
      WHERE id = ${deliveryId} AND webhook_id = ${webhookId}`,
    );
    const row = result.rows[0];
    if (!row) return null;
    const attempts = await attemptsFor(db, schemas, [row.id]);
    return deliveryOf(row, attempts.get(row.id) ?? []);
  }

  for (const { prefix, policy } of VARIANTS) {
    const route = { config: { policy } };
    const base = `${prefix}/databases/:databaseId/webhooks`;

    app.get(base, route, async (request): Promise<WebhookList> => {
      const { databaseId } = parse(Params, request.params);
      const { pool, schemas } = await access(request, databaseId);
      const result = await query<WebhookRow>(
        pool,
        sql`SELECT * FROM ${ident(schemas.app, 'webhooks')} WHERE database_id = ${databaseId}
        ORDER BY created_at, id`,
      );
      return { webhooks: result.rows.map(webhookMeta) };
    });

    app.post(base, route, async (request): Promise<WebhookCreated> => {
      const { databaseId } = parse(Params, request.params);
      const { pool, schemas, actor } = await access(request, databaseId);
      const input = parse(WebhookCreate, request.body);
      const url = checkedUrl(input.url, app.ctx.config);
      const id = newId('webhook');
      const secret = newSecret();
      return withTransaction(pool, async (db) => {
        // One request at a time counts a database's webhooks, so the limit holds.
        await query(
          db,
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:webhooks:${databaseId}`}, 0))`,
        );
        const count = await query<{ count: string }>(
          db,
          sql`SELECT count(*) AS count FROM ${ident(schemas.app, 'webhooks')} WHERE database_id = ${databaseId}`,
        );
        if (Number(count.rows[0]!.count) >= WEBHOOK_LIMITS.perDatabase)
          throw new AppError('validation_failed', 'webhooks.limit', {
            params: { limit: WEBHOOK_LIMITS.perDatabase },
          });
        const tableIds = await checkedTables(db, schemas, databaseId, input.tableIds);
        const inserted = await query<WebhookRow>(
          db,
          sql`INSERT INTO ${ident(schemas.app, 'webhooks')}
          (id, org_id, database_id, url, events, table_ids, enabled, secret, created_by)
          VALUES (${id}, ${actor.orgId}, ${databaseId}, ${url}, ${orderedEvents(input.events)}::text[],
            ${tableIds}::text[], ${input.enabled}, ${await sealSecret(app.ctx.config.secretKey, id, secret, actor.orgId, db)},
            ${actor.userId})
          RETURNING *`,
        );
        // One an app makes with an OAuth token belongs to that installation and ends with it.
        if (actor.token?.grantId) await bindWebhook(db, schemas.app, id, actor.token.grantId);
        await audit(db, schemas, 'data.webhook.created', actor, {
          databaseId,
          webhookId: id,
          host: hostOf(url),
          ...(actor.token?.grantId ? { grantId: actor.token.grantId } : {}),
        });
        return { ...webhookMeta(inserted.rows[0]!), secret };
      });
    });

    app.patch(`${base}/:webhookId`, route, async (request): Promise<WebhookMeta> => {
      const { databaseId, webhookId } = parse(WebhookParams, request.params);
      const { pool, schemas, actor, scope } = await access(request, databaseId);
      const input = parse(WebhookUpdate, request.body);
      const url = input.url === undefined ? undefined : checkedUrl(input.url, app.ctx.config);
      return withTransaction(pool, async (db) => {
        const before = await loadWebhook(db, schemas, webhookId, { databaseId, lock: true });
        if (!before) throw notFound();
        const enabled = input.enabled ?? before.enabled;
        // An imported webhook waits for the owner's review, and anyone who tries to turn it on
        // hears that first, whatever else would stop them.
        if (enabled && !before.enabled)
          await refuseWhileInReview(db, schemas.app, actor.orgId, 'webhook', webhookId);
        requireOwnWhenLimited(scope, before);
        const tableIds =
          input.tableIds === undefined
            ? before.table_ids
            : await checkedTables(db, schemas, databaseId, input.tableIds);
        const address = url ?? before.url;
        // Turning it back on, or pointing it somewhere new, starts its record of failures afresh.
        const fresh = (enabled && !before.enabled) || address !== before.url;
        // Why it turned itself off stays until someone turns it back on.
        const reason = enabled || before.enabled ? null : before.disabled_reason;
        const updated = await query<WebhookRow>(
          db,
          sql`UPDATE ${ident(schemas.app, 'webhooks')} SET url = ${address},
          events = ${input.events === undefined ? before.events : orderedEvents(input.events)}::text[],
          table_ids = ${tableIds}::text[], enabled = ${enabled}, disabled_reason = ${reason},
          failing_since = CASE WHEN ${fresh} THEN NULL ELSE failing_since END, updated_at = now()
          WHERE id = ${webhookId} RETURNING *`,
        );
        // Turned off, it holds what it hasn't sent.  Turned back on, it sends that first.
        if (before.enabled && !enabled) await holdDeliveries(db, schemas, webhookId);
        if (!before.enabled && enabled) {
          // Whoever turns it back on keeps it: an app's installation, or no installation at all.
          await bindWebhook(db, schemas.app, webhookId, actor.token?.grantId);
          await releaseDeliveries(db, schemas, webhookId, new Date());
        }
        await audit(db, schemas, 'data.webhook.updated', actor, {
          databaseId,
          webhookId,
          changed: Object.keys(input).filter((key) => input[key as keyof typeof input] !== undefined),
          host: hostOf(address),
        });
        return webhookMeta(updated.rows[0]!);
      });
    });

    app.delete(`${base}/:webhookId`, route, async (request, reply) => {
      const { databaseId, webhookId } = parse(WebhookParams, request.params);
      const { pool, schemas, actor } = await access(request, databaseId);
      await withTransaction(pool, async (db) => {
        const removed = await query(
          db,
          sql`DELETE FROM ${ident(schemas.app, 'webhooks')} WHERE id = ${webhookId} AND database_id = ${databaseId}`,
        );
        if (!removed.rowCount) throw notFound();
        await audit(db, schemas, 'data.webhook.deleted', actor, { databaseId, webhookId });
      });
      return reply.code(204).send();
    });

    app.post(`${base}/:webhookId/secret`, route, async (request): Promise<WebhookSecret> => {
      const { databaseId, webhookId } = parse(WebhookParams, request.params);
      const { pool, schemas, actor, scope } = await access(request, databaseId);
      return withTransaction(pool, async (db) => {
        const before = await loadWebhook(db, schemas, webhookId, { databaseId, lock: true });
        if (!before) throw notFound();
        requireOwnWhenLimited(scope, before);
        const secret = newSecret();
        // The old secret keeps signing beside the new one for a while, so the receiver can switch
        // without missing a delivery.
        const until = new Date(Date.now() + WEBHOOK_LIMITS.previousSecretHours * 3_600_000);
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'webhooks')}
          SET secret = ${await sealSecret(app.ctx.config.secretKey, webhookId, secret, actor.orgId, db)}, previous_secret = ${before.secret},
            previous_secret_until = ${until}, updated_at = now()
          WHERE id = ${webhookId}`,
        );
        await audit(db, schemas, 'data.webhook.secretReplaced', actor, { databaseId, webhookId });
        return { secret, previousExpiresAt: until.toISOString() };
      });
    });

    app.get(`${base}/:webhookId/deliveries`, route, async (request): Promise<WebhookDeliveriesPage> => {
      const { databaseId, webhookId } = parse(WebhookParams, request.params);
      const input = parse(z.object({ cursor: z.string().max(200).optional() }), request.query);
      let before: number | undefined;
      if (input.cursor !== undefined) {
        try {
          const cursor = Cursor.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
          if (cursor.webhookId !== webhookId) throw new Error('cursor for another webhook');
          before = cursor.seq;
        } catch {
          throw new AppError('validation_failed', 'errors.validationFailed');
        }
      }
      const { pool, schemas } = await access(request, databaseId);
      if (!(await loadWebhook(pool, schemas, webhookId, { databaseId }))) throw notFound();
      const result = await query<DeliverySummaryRow>(
        pool,
        sql`SELECT ${SUMMARY} FROM ${ident(schemas.app, 'webhook_deliveries')} WHERE webhook_id = ${webhookId}
        AND ${before === undefined ? sql`TRUE` : sql`seq < ${before}`} ORDER BY seq DESC LIMIT ${PAGE + 1}`,
      );
      const page = result.rows.slice(0, PAGE);
      const attempts = await attemptsFor(
        pool,
        schemas,
        page.map((row) => row.id),
      );
      const last = page.at(-1);
      return {
        deliveries: page.map((row) => deliveryOf(row, attempts.get(row.id) ?? [])),
        next:
          result.rows.length > PAGE && last
            ? Buffer.from(JSON.stringify({ webhookId, seq: Number(last.seq) })).toString('base64url')
            : null,
      };
    });

    app.post(
      `${base}/:webhookId/deliveries/:deliveryId/redeliver`,
      route,
      async (request): Promise<WebhookDelivery> => {
        const { databaseId, webhookId, deliveryId } = parse(DeliveryParams, request.params);
        const { pool, schemas } = await access(request, databaseId);
        if (!(await loadWebhook(pool, schemas, webhookId, { databaseId }))) throw notFound();
        const now = new Date();
        // A delivery in flight finishes first, and asking again meanwhile changes nothing.
        await query(
          pool,
          sql`UPDATE ${ident(schemas.app, 'webhook_deliveries')} SET state = 'pending', manual = true,
          next_attempt_at = ${now}, lease_at = NULL, lease_token = NULL, updated_at = ${now}
          WHERE id = ${deliveryId} AND webhook_id = ${webhookId}
            AND (lease_at IS NULL OR lease_at <= ${new Date(now.getTime() - LEASE_MS)})`,
        );
        const delivery = await summary(pool, schemas, deliveryId, webhookId);
        if (!delivery) throw notFound();
        return delivery;
      },
    );
  }
}
