import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import { AppError, OAuthAppCreate, type OAuthGrant, type OAuthSettings } from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import { z } from 'zod';
import { auditEvent, authDatabase, lockKeys, randomToken, tokenHash } from '../auth/database.js';
import { requireActor } from '../auth/sessions.js';
import { parse } from '../http/validate.js';
import { lockUnits, reachablePeople, requirePerson } from '../org-units/store.js';
import {
  appView,
  expireDynamicClients,
  newOAuthId,
  oauthOrigin,
  revokeConsents,
  type ClientRow,
  type ConsentRow,
} from './store.js';

const Id = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/) });
const admin = {
  config: {
    policy: { kind: 'admin' as const, area: 'integrations' as const, scope: 'organization' as const },
  },
};
const session = { config: { policy: { kind: 'session' as const } } };

export async function oauthAdminRoutes(app: FastifyInstance) {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  // Without an HTTPS base URL there's no issuer to name, so the screen says why apps can't connect.
  const available = () => oauthOrigin(app.ctx) !== null;
  app.get('/api/admin/oauth/settings', admin, async (request): Promise<OAuthSettings> => {
    const { pool, app: schema } = authDatabase(app.ctx);
    const result = await pool.query<{ dynamic_registration: boolean }>(
      `SELECT dynamic_registration FROM ${schema}.oauth_settings WHERE org_id = $1`,
      [requireActor(request).orgId],
    );
    return { dynamicRegistration: result.rows[0]?.dynamic_registration ?? false, available: available() };
  });
  app.put('/api/admin/oauth/settings', admin, async (request): Promise<OAuthSettings> => {
    const actor = requireActor(request);
    const input = parse(z.object({ dynamicRegistration: z.boolean() }), request.body);
    const { pool, app: schema, audit } = authDatabase(app.ctx);
    await withTransaction(pool, async (db) => {
      await lockKeys(db, ['oauth:registration']);
      await db.query(
        `INSERT INTO ${schema}.oauth_settings(org_id, dynamic_registration) VALUES ($1, $2)
        ON CONFLICT (org_id) DO UPDATE SET dynamic_registration = EXCLUDED.dynamic_registration`,
        [actor.orgId, input.dynamicRegistration],
      );
      await auditEvent(db, audit, 'oauth.settings.changed', actor, input);
    });
    return { ...input, available: available() };
  });
  app.get('/api/admin/oauth/apps', admin, async (request) => {
    const actor = requireActor(request);
    const { pool, app: schema } = authDatabase(app.ctx);
    const rows = await withTransaction(pool, async (db) => {
      // Registrations past their time show as revoked, as they are.
      await lockKeys(db, ['oauth:registration']);
      await expireDynamicClients(db, app.ctx, actor.orgId);
      const result = await db.query<ClientRow>(
        `SELECT * FROM ${schema}.oauth_clients WHERE org_id = $1 ORDER BY created_at DESC, id`,
        [actor.orgId],
      );
      return result.rows;
    });
    return rows.map(appView);
  });
  app.post('/api/admin/oauth/apps', admin, async (request, reply) => {
    const actor = requireActor(request);
    const input = parse(OAuthAppCreate, request.body);
    const { pool, app: schema, audit } = authDatabase(app.ctx);
    const id = newOAuthId();
    const secret = input.confidential ? randomToken() : null;
    const redirectUris = [...new Set(input.redirectUris)];
    const scopes = [...new Set(input.scopes)].sort();
    const result = await withTransaction(pool, async (db) => {
      const created = await db.query<ClientRow>(
        `INSERT INTO ${schema}.oauth_clients
        (id, org_id, name, icon, homepage, redirect_uris, scopes, secret_hash, verified)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true) RETURNING *`,
        [
          id,
          actor.orgId,
          input.name,
          input.icon,
          input.homepage,
          redirectUris,
          scopes,
          secret ? tokenHash(secret) : null,
        ],
      );
      await auditEvent(db, audit, 'oauth.app.registered', actor, {
        clientId: id,
        verified: true,
        dynamic: false,
        name: input.name,
        homepage: input.homepage,
        redirectUris,
        scopes,
        confidential: input.confidential,
      });
      return created.rows[0]!;
    });
    return reply.code(201).send({ ...appView(result), ...(secret ? { clientSecret: secret } : {}) });
  });
  app.post('/api/admin/oauth/apps/:id/secret', admin, async (request) => {
    const actor = requireActor(request);
    const { id } = parse(Id, request.params);
    const { pool, app: schema, audit } = authDatabase(app.ctx);
    const secret = randomToken();
    await withTransaction(pool, async (db) => {
      const result = await db.query(
        `UPDATE ${schema}.oauth_clients SET secret_hash = $1
        WHERE id = $2 AND org_id = $3 AND secret_hash IS NOT NULL AND revoked_at IS NULL`,
        [tokenHash(secret), id, actor.orgId],
      );
      if (!result.rowCount) throw new AppError('not_found', 'errors.notFound');
      await auditEvent(db, audit, 'oauth.app.secret_rotated', actor, { clientId: id });
    });
    return { clientSecret: secret };
  });
  app.delete('/api/admin/oauth/apps/:id', admin, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = parse(Id, request.params);
    const { pool, app: schema, audit } = authDatabase(app.ctx);
    await withTransaction(pool, async (db) => {
      const result = await db.query(
        `UPDATE ${schema}.oauth_clients SET revoked_at = clock_timestamp()
        WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL`,
        [id, actor.orgId],
      );
      if (!result.rowCount) throw new AppError('not_found', 'errors.notFound');
      await revokeConsents(db, { app: schema, audit }, { clientId: id }, 'app_revoked', {
        actorId: actor.userId,
      });
      await auditEvent(db, audit, 'oauth.app.revoked', actor, { clientId: id });
    });
    return reply.code(204).send();
  });
  for (const isAdmin of [false, true]) {
    const path = isAdmin ? '/api/admin/oauth/grants' : '/api/oauth/grants';
    const policy: RouteShorthandOptions = isAdmin
      ? { config: { policy: { kind: 'admin', area: 'integrations', scope: 'subtree' } } }
      : session;
    // A connection is a person's consent for an app, with the installations that share it.
    app.get(path, policy, async (request): Promise<OAuthGrant[]> => {
      const actor = requireActor(request);
      const { pool, app: schema } = authDatabase(app.ctx);
      // A unit's Integrations admin sees the connections of the people their units reach.
      const reached = isAdmin ? await reachablePeople(pool, schema, actor, 'integrations') : null;
      const result = await pool.query<
        ConsentRow & { app_name: string; person_name: string; installations: number; resources: string[] }
      >(
        `SELECT s.*, c.name AS app_name, u.name AS person_name,
          count(g.id) FILTER (WHERE g.revoked_at IS NULL)::int AS installations,
          COALESCE(array_agg(DISTINCT g.resource) FILTER (WHERE g.revoked_at IS NULL), '{}') AS resources
        FROM ${schema}.oauth_consents s
        JOIN ${schema}.oauth_clients c ON c.id = s.client_id JOIN ${schema}.users u ON u.id = s.user_id
        LEFT JOIN ${schema}.oauth_grants g ON g.consent_id = s.id
        WHERE s.org_id = $1 ${isAdmin ? 'AND ($2::text[] IS NULL OR s.user_id = ANY($2::text[]))' : 'AND s.user_id = $2 AND s.revoked_at IS NULL'}
        GROUP BY s.id, c.name, u.name ORDER BY s.created_at DESC, s.id`,
        isAdmin ? [actor.orgId, reached && [...reached]] : [actor.orgId, actor.userId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        clientId: row.client_id,
        appName: row.app_name,
        userId: row.user_id,
        personName: row.person_name,
        scopes: row.scopes,
        databases: row.databases ?? 'all',
        resources: [...row.resources].sort(),
        installations: row.installations,
        createdAt: row.created_at.toISOString(),
        revokedAt: row.revoked_at?.toISOString() ?? null,
      }));
    });
    // Revoking a connection ends every installation of the app for that person.
    app.delete(`${path}/:id`, policy, async (request, reply) => {
      const actor = requireActor(request);
      const { id } = parse(Id, request.params);
      const { pool, app: schema, audit } = authDatabase(app.ctx);
      await withTransaction(pool, async (db) => {
        if (isAdmin) await lockUnits(db, actor.orgId);
        const result = await db.query<ConsentRow>(
          `SELECT * FROM ${schema}.oauth_consents WHERE id = $1 AND org_id = $2 ${isAdmin ? '' : 'AND user_id = $3'} FOR UPDATE`,
          isAdmin ? [id, actor.orgId] : [id, actor.orgId, actor.userId],
        );
        const consent = result.rows[0];
        if (!consent) throw new AppError('not_found', 'errors.notFound');
        if (isAdmin)
          actor.auditUnitId = await requirePerson(db, schema, actor, consent.user_id, 'integrations');
        await revokeConsents(
          db,
          { app: schema, audit },
          { consentId: consent.id },
          isAdmin ? 'admin_request' : 'person_request',
          { actorId: actor.userId },
        );
        if (!consent.revoked_at)
          await auditEvent(db, audit, 'oauth.consent.revoked', actor, {
            consentId: consent.id,
            clientId: consent.client_id,
            userId: consent.user_id,
            reason: isAdmin ? 'admin_request' : 'person_request',
          });
      });
      return reply.code(204).send();
    });
  }
}
