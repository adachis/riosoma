import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, CustomDomainHost, CustomDomainInput, CustomDomainKinds } from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import { authDatabase, lockKeys } from '../auth/database.js';
import { requireActor } from '../auth/sessions.js';
import { parse } from '../http/validate.js';
import { mapStyleUrl } from '../http/app-config.js';
import { VERSION } from '../version.js';
import { addressAllowed, DEFAULT_CUSTOM_DOMAIN_LIMIT } from './settings.js';
import {
  activeDomain,
  domainAudit,
  domainView,
  newChallenge,
  unavailable,
  verifyDomain,
  type DomainRow,
} from './store.js';

const admin = {
  config: {
    policy: { kind: 'admin' as const, area: 'integrations' as const, scope: 'organization' as const },
  },
};
const Params = z.object({ id: z.uuid() });

export async function customDomainRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  app.get('/api/admin/custom-domains', admin, async (request) => {
    const { pool, app: schema } = authDatabase(ctx);
    const result = await pool.query<DomainRow>(
      `SELECT * FROM ${schema}.custom_domains WHERE org_id = $1 AND removed_at IS NULL ORDER BY created_at, id`,
      [requireActor(request).orgId],
    );
    return result.rows.map((row) => domainView(ctx, row));
  });
  app.post('/api/admin/custom-domains', admin, async (request) => {
    const actor = requireActor(request);
    const input = parse(CustomDomainInput, request.body);
    if (!ctx.config.baseUrl) throw new AppError('validation_failed', 'customDomains.baseRequired');
    if (input.host === new URL(ctx.config.baseUrl).hostname.toLowerCase().replace(/\.$/, ''))
      throw new AppError('validation_failed', 'customDomains.mainHost');
    const { pool, app: schema, audit } = authDatabase(ctx);
    return withTransaction(pool, async (db) => {
      // One organization's additions wait for each other, so two at once can't pass its limit.
      await lockKeys(db, [`custom-domain:${input.host}`, `custom-domains:${actor.orgId}`]);
      const existing = await db.query(
        `SELECT 1 FROM ${schema}.custom_domains WHERE host = $1 AND org_id = $2 AND removed_at IS NULL`,
        [input.host, actor.orgId],
      );
      if (existing.rowCount) throw new AppError('conflict', 'customDomains.exists');
      // Every domain can ask the proxy for certificates, which share one account's rate limits.
      const limit = ctx.config.customDomainLimit ?? DEFAULT_CUSTOM_DOMAIN_LIMIT;
      const added = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${schema}.custom_domains WHERE org_id = $1 AND removed_at IS NULL`,
        [actor.orgId],
      );
      if (added.rows[0]!.count >= limit)
        throw new AppError('conflict', 'customDomains.limit', { params: { limit } });
      const result = await db.query<DomainRow>(
        `INSERT INTO ${schema}.custom_domains (id, org_id, host, challenge, kinds) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [randomUUID(), actor.orgId, input.host, newChallenge(), input.kinds],
      );
      const row = result.rows[0]!;
      await domainAudit(db, audit, 'added', row, actor.userId);
      return domainView(ctx, row);
    });
  });
  app.post('/api/admin/custom-domains/:id/verify', admin, async (request) => {
    const actor = requireActor(request);
    const { id } = parse(Params, request.params);
    const { pool, app: schema } = authDatabase(ctx);
    const result = await pool.query<DomainRow>(
      `SELECT * FROM ${schema}.custom_domains WHERE id = $1 AND org_id = $2 AND removed_at IS NULL`,
      [id, actor.orgId],
    );
    if (!result.rows[0]) throw unavailable();
    const checked = await verifyDomain(ctx, result.rows[0], actor.userId);
    if (!checked) throw unavailable();
    if (!checked.verified)
      throw new AppError('conflict', checked.taken ? 'customDomains.taken' : 'customDomains.failed');
    return domainView(ctx, checked.row);
  });
  app.patch('/api/admin/custom-domains/:id', admin, async (request) => {
    const actor = requireActor(request);
    const { id } = parse(Params, request.params);
    const { kinds } = parse(z.object({ kinds: CustomDomainKinds }), request.body);
    const { pool, app: schema, audit } = authDatabase(ctx);
    return withTransaction(pool, async (db) => {
      const result = await db.query<DomainRow>(
        `UPDATE ${schema}.custom_domains SET kinds = $3 WHERE id = $1 AND org_id = $2 AND removed_at IS NULL RETURNING *`,
        [id, actor.orgId, kinds],
      );
      if (!result.rows[0]) throw unavailable();
      await domainAudit(db, audit, 'updated', result.rows[0], actor.userId);
      return domainView(ctx, result.rows[0]);
    });
  });
  app.delete('/api/admin/custom-domains/:id', admin, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(Params, request.params);
    const { pool, app: schema, audit } = authDatabase(ctx);
    await withTransaction(pool, async (db) => {
      const result = await db.query<DomainRow>(
        `UPDATE ${schema}.custom_domains SET removed_at = clock_timestamp(), verified_at = NULL
          WHERE id = $1 AND org_id = $2 AND removed_at IS NULL RETURNING *`,
        [id, actor.orgId],
      );
      if (!result.rows[0]) throw unavailable();
      await domainAudit(db, audit, 'removed', result.rows[0], actor.userId);
    });
    return reply.status(204).send();
  });
  app.get('/api/public/config', { config: { policy: { kind: 'public' } } }, async () => ({
    map: { styleUrl: mapStyleUrl(ctx.config) },
    version: VERSION,
  }));
  app.get('/internal/tls/allow', { logLevel: 'silent' }, async (request, reply) => {
    const input = z
      .object({ domain: CustomDomainHost, token: z.string().max(512).optional() })
      .safeParse(request.query);
    const expected = ctx.config.tlsAskToken;
    const given =
      typeof request.headers['x-tls-ask-token'] === 'string'
        ? request.headers['x-tls-ask-token']
        : input.success
          ? input.data.token
          : undefined;
    if (
      !input.success ||
      !expected ||
      !given ||
      !addressAllowed(request.raw.socket.remoteAddress, ctx.config.tlsAskAddresses ?? '') ||
      Buffer.byteLength(given) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(given), Buffer.from(expected)) ||
      !(await activeDomain(ctx, input.data.domain))
    )
      throw unavailable();
    return reply.status(200).send();
  });
}
