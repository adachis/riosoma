import type { FastifyInstance } from 'fastify';
import { AppError, type OrganizationGroup } from '@riosoma/contracts';
import { authDatabase } from '../auth/database.js';
import { requireActor } from '../auth/sessions.js';

/** Provisioning owns group names and membership, and sharing owns their resource roles. */
export async function groupRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/org/groups',
    { config: { policy: { kind: 'session' } } },
    async (request): Promise<OrganizationGroup[]> => {
      const actor = requireActor(request);
      if (actor.kind === 'guest') return [];
      const { pool, app: schema } = authDatabase(app.ctx);
      const result = await pool.query<OrganizationGroup>(
        `SELECT g.id, g.name, g.scim_managed AS managed,
      COALESCE(array_agg(m.user_id ORDER BY m.user_id) FILTER (WHERE m.user_id IS NOT NULL), '{}') AS members
      FROM ${schema}.groups g LEFT JOIN ${schema}.group_members m ON m.org_id = g.org_id AND m.group_id = g.id
      WHERE g.org_id = $1 GROUP BY g.id ORDER BY g.name, g.id`,
        [actor.orgId],
      );
      return result.rows;
    },
  );
  for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
    app.route({
      method,
      url: '/api/org/groups/:groupId',
      config: { policy: { kind: 'admin', area: 'people', scope: 'organization' } },
      handler: async (request) => {
        const actor = requireActor(request);
        const { pool, app: schema } = authDatabase(app.ctx);
        const groupId = (request.params as { groupId: string }).groupId;
        const result = await pool.query(`SELECT id FROM ${schema}.groups WHERE org_id = $1 AND id = $2`, [
          actor.orgId,
          groupId,
        ]);
        if (!result.rowCount) throw new AppError('not_found', 'errors.notFound');
        throw new AppError('forbidden', 'scim.errors.managed');
      },
    });
  }
}
