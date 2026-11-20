import { McpRateSettings, type McpAppActivity } from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { auditEvent, authDatabase } from '../auth/database.js';
import { requireActor } from '../auth/sessions.js';
import { parse } from '../http/validate.js';
import { rateSettings } from './rate-limit.js';

const admin = {
  config: {
    policy: { kind: 'admin' as const, area: 'integrations' as const, scope: 'organization' as const },
  },
};

export async function mcpSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  app.get('/api/admin/mcp/settings', admin, (request) => rateSettings(app.ctx, requireActor(request).orgId));
  app.put('/api/admin/mcp/settings', admin, async (request) => {
    const actor = requireActor(request);
    const input = parse(McpRateSettings, request.body);
    const { pool, app: schema, audit } = authDatabase(app.ctx);
    await withTransaction(pool, async (db) => {
      await db.query(
        `UPDATE ${schema}.orgs SET settings = jsonb_set(settings, '{mcpRateLimit}', $2::jsonb) WHERE id = $1`,
        [actor.orgId, JSON.stringify(input)],
      );
      await auditEvent(db, audit, 'mcp.settings.changed', actor, input);
    });
    return input;
  });
  app.get('/api/admin/mcp/activity', admin, async (request): Promise<McpAppActivity[]> => {
    const { pool, app: schema } = authDatabase(app.ctx);
    const result = await pool.query<McpAppActivity>(
      `SELECT c.id AS "clientId", c.name AS "appName",
         count(a.key) FILTER (WHERE a.at > clock_timestamp() - interval '1 minute')::int AS "callsLastMinute",
         count(a.key) FILTER (WHERE a.key = 'mcp:refused:' || g.org_id || ':' || g.id)::int AS "limitedLastDay"
       FROM ${schema}.oauth_clients c
       JOIN ${schema}.oauth_grants g ON g.client_id = c.id
       LEFT JOIN ${schema}.auth_attempts a
         ON a.key IN ('mcp:call:' || g.org_id || ':' || g.id, 'mcp:refused:' || g.org_id || ':' || g.id)
         AND a.at > clock_timestamp() - interval '1 day'
       WHERE c.org_id = $1 AND c.revoked_at IS NULL AND EXISTS (
         SELECT 1 FROM ${schema}.oauth_grants live
         JOIN ${schema}.oauth_consents s ON s.id = live.consent_id
         WHERE live.client_id = c.id AND live.revoked_at IS NULL AND s.revoked_at IS NULL
       )
       GROUP BY c.id, c.name ORDER BY c.name, c.id`,
      [requireActor(request).orgId],
    );
    return result.rows;
  });
}
