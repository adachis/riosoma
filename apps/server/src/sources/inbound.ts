import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  newId,
  SourceId,
  WEBHOOK_SOURCE_LIMITS,
  WebhookBodyLogging,
  type WebhookAccepted,
  type WebhookAddress,
  type WebhookConnection,
  type WebhookRefusalCode,
  type WebhookSourceLog,
} from '@riosoma/contracts';
import { parseJson } from '@riosoma/connectors';
import { compile, ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import { auditEvent } from '../auth/database.js';
import { lockUnits, requireSource } from '../org-units/store.js';
import type { Actor } from '../http/policy.js';
import { requireActor } from '../auth/sessions.js';
import { dataStore, type DataSchemas } from '../data/context.js';
import { parse } from '../http/validate.js';
import { loadSource, secretsFor, type SourceRow } from './store.js';
import {
  admitPost,
  hookByToken,
  keepSample,
  newHookAddress,
  postRecords,
  signatureProblem,
  type HookRow,
} from './webhook.js';

/**
 * A webhook source's public address, and the routes its admins manage it with.
 *
 * The address takes JSON up to 1 MB and answers every refusal with a plain code senders can read:
 * `{"error": "signature_invalid"}`.  What needs no body is checked before any of it is read, in
 * this order: the address, a pause, the pace, and the type.  Then come the size, the signature, and
 * the JSON.  So every post counts against the pace, however large.  Posts that pass are logged,
 * queued as the text that arrived, and answered with `202` at once, and the writer puts them in the
 * tables afterward.  The token is in the path, which the logger redacts, and nothing here logs it.
 */

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;
const Params = z.object({ sourceId: SourceId });

const STATUS: Record<WebhookRefusalCode, number> = {
  not_found: 404,
  paused: 503,
  rate_limited: 429,
  payload_too_large: 413,
  unsupported_content_type: 415,
  signature_missing: 401,
  signature_invalid: 401,
  timestamp_expired: 401,
  invalid_json: 400,
  records_missing: 422,
  record_not_object: 422,
  too_many_records: 413,
  bad_request: 400,
  unavailable: 503,
};

interface Delivery {
  status: number;
  refusal: WebhookRefusalCode | null;
  bytes: number;
  records: number | null;
  body: string | null;
}

/**
 * Adds a post to its webhook's log, which keeps the last 100.  A post still waiting to be written
 * keeps its place, however many come after it.
 */
async function logDelivery(
  db: Queryable,
  schemas: DataSchemas,
  sourceId: string,
  delivery: Delivery,
): Promise<string> {
  const deliveries = ident(schemas.app, 'source_hook_deliveries');
  const id = newId('delivery');
  await query(
    db,
    sql`INSERT INTO ${deliveries} (id, source_id, at, status, refusal, bytes, records, body, written)
    VALUES (${id}, ${sourceId}, statement_timestamp(), ${delivery.status}, ${delivery.refusal}, ${delivery.bytes},
      ${delivery.records}, ${delivery.body}, ${delivery.status !== 202})`,
  );
  await query(
    db,
    sql`DELETE FROM ${deliveries} d WHERE d.source_id = ${sourceId}
    AND d.seq <= (SELECT seq FROM ${deliveries} WHERE source_id = ${sourceId} ORDER BY seq DESC
      OFFSET ${WEBHOOK_SOURCE_LIMITS.deliveries} LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM ${ident(schemas.app, 'source_hook_posts')} p WHERE p.delivery_id = d.id)`,
  );
  return id;
}

/** Whether the log keeps bodies now.  The server's own clock decides, so the hour ends on time. */
function keepsBodies(hook: HookRow, now = Date.now()): boolean {
  return hook.bodies_until !== null && hook.bodies_until.getTime() > now;
}

/** Forgets every body a webhook's log kept. */
async function forgetBodies(db: Queryable, schemas: DataSchemas, sourceId: string): Promise<void> {
  await query(
    db,
    sql`UPDATE ${ident(schemas.app, 'source_hook_deliveries')} SET body = NULL WHERE source_id = ${sourceId} AND body IS NOT NULL`,
  );
}

/** The bytes a post says it holds, for the log of one refused before any of it is read. */
function declaredBytes(request: FastifyRequest): number {
  const bytes = Number(request.headers['content-length']);
  return Number.isSafeInteger(bytes) && bytes > 0 ? Math.min(bytes, 2 ** 31 - 1) : 0;
}

/** A post that passed the checks made before its body is read, with what they found. */
interface Admitted {
  hook: HookRow;
  source: SourceRow;
  settings: WebhookConnection;
}

/** The public address: posts from other systems. */
export async function inboundRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const admitted = new WeakMap<FastifyRequest, Admitted>();
  // Bodies arrive as bytes, since a signature covers exactly what was sent.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: WEBHOOK_SOURCE_LIMITS.bodyBytes },
    (_request, body, done) => done(null, body),
  );

  const refuse = (reply: FastifyReply, code: WebhookRefusalCode) =>
    reply.code(STATUS[code]).send({ error: code });

  async function tokenHook(request: FastifyRequest): Promise<HookRow | null> {
    const token = (request.params as { token?: unknown }).token;
    if (typeof token !== 'string' || !ctx.pool || !ctx.config.database) return null;
    const { pool, schemas } = dataStore(ctx);
    return hookByToken(pool, schemas, token);
  }

  // The checks that need no body, made before a byte of it is read, so a post too large to read
  // still counts against the pace, and an unknown or paused address says so whatever it's sent.
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!ctx.pool || !ctx.config.database) return refuse(reply, 'unavailable');
    const hook = await tokenHook(request);
    if (!hook) return refuse(reply, 'not_found');
    const { pool, schemas } = dataStore(ctx);
    const source = await loadSource(pool, schemas, hook.source_id, hook.org_id);
    const settings = source.connection as WebhookConnection;
    const refused = async (code: WebhookRefusalCode) => {
      await logDelivery(pool, schemas, hook.source_id, {
        status: STATUS[code],
        refusal: code,
        bytes: declaredBytes(request),
        records: null,
        body: null,
      });
      return refuse(reply, code);
    };
    // A source an import paused takes nothing until the owner turns it on.
    if (settings.paused || source.import_paused) {
      reply.header('retry-after', '60');
      return refused('paused');
    }
    const wait = await admitPost(pool, schemas, hook.source_id, settings.postsPerMinute);
    if (wait) {
      reply.header('retry-after', String(wait));
      return refused('rate_limited');
    }
    if (!JSON_TYPE.test(request.headers['content-type'] ?? '')) return refused('unsupported_content_type');
    admitted.set(request, { hook, source, settings });
  });

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    reply.header('cache-control', 'no-store');
    if (error.statusCode === 413 || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      // A post too large is logged against its webhook, so its admins can see why it went missing.
      const found = admitted.get(request);
      if (found) {
        const { pool, schemas } = dataStore(ctx);
        await logDelivery(pool, schemas, found.hook.source_id, {
          status: 413,
          refusal: 'payload_too_large',
          bytes: declaredBytes(request) || WEBHOOK_SOURCE_LIMITS.bodyBytes + 1,
          records: null,
          body: null,
        }).catch(() => undefined);
      }
      return refuse(reply, 'payload_too_large');
    }
    if (error.statusCode === 415) return refuse(reply, 'unsupported_content_type');
    if (error.statusCode && error.statusCode < 500) return refuse(reply, 'bad_request');
    request.log.error({ err: error }, 'a webhook post failed');
    return refuse(reply, 'unavailable');
  });

  app.post(
    '/api/inbound/:token',
    { config: { policy: { kind: 'public' } }, bodyLimit: WEBHOOK_SOURCE_LIMITS.bodyBytes },
    async (request, reply) => {
      const admission = admitted.get(request);
      if (!admission) return refuse(reply, 'unavailable');
      const { hook, source, settings } = admission;
      const { pool, schemas } = dataStore(ctx);
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const text = body.toString('utf8');
      const refused = async (code: WebhookRefusalCode) => {
        await logDelivery(pool, schemas, hook.source_id, {
          status: STATUS[code],
          refusal: code,
          bytes: body.length,
          records: null,
          body: keepsBodies(hook) ? text : null,
        });
        return refuse(reply, code);
      };
      if (settings.signature) {
        const secret = (await secretsFor(source, ctx.config.secretKey, pool)).signingSecret;
        const problem = secret
          ? signatureProblem(settings.signature, secret, request.headers, body)
          : 'signature_invalid';
        if (problem) return refused(problem);
      }
      let document: unknown;
      try {
        document = parseJson(text);
      } catch {
        return refused('invalid_json');
      }
      const found = postRecords(settings, document);
      if ('refusal' in found) return refused(found.refusal);
      const delivery = await withTransaction(pool, async (db) => {
        const id = await logDelivery(db, schemas, hook.source_id, {
          status: 202,
          refusal: null,
          bytes: body.length,
          records: found.records.length,
          body: keepsBodies(hook) ? text : null,
        });
        // The post waits as the text that arrived, since jsonb would round long whole numbers, with
        // where its records were, so it's written as it was accepted.
        await query(
          db,
          sql`INSERT INTO ${ident(schemas.app, 'source_hook_posts')} (delivery_id, source_id, body, records_path, split, received_at)
          VALUES (${id}, ${hook.source_id}, ${text}, ${settings.records}, ${settings.split}, statement_timestamp())`,
        );
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'source_hooks')} SET last_post_at = statement_timestamp() WHERE source_id = ${hook.source_id}`,
        );
        await keepSample(db, schemas, hook.source_id, text);
        return id;
      });
      ctx.inbound?.kick();
      const answer: WebhookAccepted = { accepted: found.records.length, delivery };
      return reply.code(202).send(answer);
    },
  );
}

function audit(db: Queryable, schemas: DataSchemas, actor: Actor, action: string, sourceId: string) {
  return auditEvent(db, compile(sql`${ident(schemas.audit)}`).text, action, actor, { sourceId });
}

/** A webhook source of the organization, for its admins, or not found. */
async function webhookSource(
  db: Queryable,
  schemas: DataSchemas,
  sourceId: string,
  orgId: string,
): Promise<SourceRow> {
  const source = await loadSource(db, schemas, sourceId, orgId);
  if (source.kind !== 'webhook') throw new AppError('not_found', 'errors.notFound');
  return source;
}

/**
 * A webhook's log: its last 100 posts, and any it still holds, like one that failed.  Bodies kept
 * during an hour that has ended are forgotten as it's read, if the writer's cleanup hasn't yet.
 */
async function deliveryLog(db: Queryable, schemas: DataSchemas, sourceId: string): Promise<WebhookSourceLog> {
  const deliveries = ident(schemas.app, 'source_hook_deliveries');
  const hook = (
    await query<HookRow>(
      db,
      sql`SELECT * FROM ${ident(schemas.app, 'source_hooks')} WHERE source_id = ${sourceId}`,
    )
  ).rows[0];
  const keeping = hook !== undefined && keepsBodies(hook);
  if (!keeping) await forgetBodies(db, schemas, sourceId);
  const rows = await query<{
    id: string;
    at: Date;
    status: number;
    refusal: WebhookRefusalCode | null;
    bytes: number;
    records: number | null;
    error: string | null;
    written: boolean;
    body: string | null;
    seq: string;
  }>(
    db,
    sql`(SELECT id, seq, at, status, refusal, bytes, records, error, written, body FROM ${deliveries}
      WHERE source_id = ${sourceId} ORDER BY seq DESC LIMIT ${WEBHOOK_SOURCE_LIMITS.deliveries})
    UNION
    (SELECT d.id, d.seq, d.at, d.status, d.refusal, d.bytes, d.records, d.error, d.written, d.body FROM ${deliveries} d
      JOIN ${ident(schemas.app, 'source_hook_posts')} p ON p.delivery_id = d.id WHERE d.source_id = ${sourceId})
    ORDER BY seq DESC`,
  );
  return {
    deliveries: rows.rows.map(({ seq: _seq, ...row }) => ({ ...row, at: row.at.toISOString() })),
    bodiesUntil: keeping ? hook.bodies_until!.toISOString() : null,
  };
}

/** The routes a webhook source's admins keep it with: its address, its log, and its log's bodies. */
export async function webhookSourceRoutes(app: FastifyInstance): Promise<void> {
  const admin = {
    config: { policy: { kind: 'admin' as const, area: 'data_sources' as const, scope: 'source' as const } },
  };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  // A new address, and the old one stops working at once.  A source an import paused gets its
  // address only when the organization's owner turns it on from the import review.
  app.post('/api/sources/:sourceId/webhook-address', admin, async (request): Promise<WebhookAddress> => {
    const actor = requireActor(request);
    const { sourceId } = parse(Params, request.params);
    const { pool, schemas } = dataStore(app.ctx);
    return withTransaction(pool, async (db) => {
      await lockUnits(db, actor.orgId);
      await requireSource(db, `"${schemas.app}"`, actor, sourceId);
      const source = await webhookSource(db, schemas, sourceId, actor.orgId);
      if (source.import_paused) throw new AppError('conflict', 'organizationArchive.sourcePaused');
      const path = await newHookAddress(db, schemas, { id: sourceId, orgId: actor.orgId });
      await audit(db, schemas, actor, 'data.source.webhookAddressChanged', sourceId);
      return { path };
    });
  });

  app.get('/api/sources/:sourceId/webhook-deliveries', admin, async (request): Promise<WebhookSourceLog> => {
    const actor = requireActor(request);
    const { sourceId } = parse(Params, request.params);
    const { pool, schemas } = dataStore(app.ctx);
    await webhookSource(pool, schemas, sourceId, actor.orgId);
    return deliveryLog(pool, schemas, sourceId);
  });

  // Bodies go into the log for the next hour, and then stop on their own.
  app.put('/api/sources/:sourceId/webhook-bodies', admin, async (request): Promise<WebhookSourceLog> => {
    const actor = requireActor(request);
    const { sourceId } = parse(Params, request.params);
    const { on } = parse(WebhookBodyLogging, request.body);
    const { pool, schemas } = dataStore(app.ctx);
    return withTransaction(pool, async (db) => {
      await lockUnits(db, actor.orgId);
      await requireSource(db, `"${schemas.app}"`, actor, sourceId);
      await webhookSource(db, schemas, sourceId, actor.orgId);
      const hook = (
        await query<HookRow>(
          db,
          sql`SELECT * FROM ${ident(schemas.app, 'source_hooks')} WHERE source_id = ${sourceId} FOR UPDATE`,
        )
      ).rows[0];
      // Turning it off forgets the bodies kept so far, and so does starting a new hour after the
      // last one ended, so no body outlives the hour it came in.
      if (!on || !hook || !keepsBodies(hook)) await forgetBodies(db, schemas, sourceId);
      const until = on ? new Date(Date.now() + WEBHOOK_SOURCE_LIMITS.bodyMinutes * 60_000) : null;
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'source_hooks')} SET bodies_until = ${until} WHERE source_id = ${sourceId}`,
      );
      await audit(
        db,
        schemas,
        actor,
        on ? 'data.source.webhookBodiesOn' : 'data.source.webhookBodiesOff',
        sourceId,
      );
      return deliveryLog(db, schemas, sourceId);
    });
  });
}
