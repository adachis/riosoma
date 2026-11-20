import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UserId, type Member } from '@riosoma/contracts';
import { requireActor } from '../auth/sessions.js';
import { dataStore } from '../data/context.js';
import { listPeople } from '../data/people.js';
import { runOrganizationCommand } from '../data/commands/organization.js';
import { peopleRoutes } from '../data/people-routes.js';
import { parse } from '../http/validate.js';

const MemberParams = z.object({ userId: UserId });

export async function memberRoutes(app: FastifyInstance): Promise<void> {
  await app.register(peopleRoutes);
  app.get(
    '/api/org/members',
    { config: { policy: { kind: 'session' } } },
    async (request): Promise<Member[]> => {
      const actor = requireActor(request);
      const { pool, schemas } = dataStore(app.ctx);
      return listPeople({ db: pool, schemas, actor });
    },
  );

  /**
   * Removes a deactivated person's account, as deleting them from the directory does when deletion
   * means removal, so the directory can give their login name to someone new.  Only an account
   * provisioning manages, and never an active person, the owner, or someone another organization
   * shares.
   */
  app.delete(
    '/api/org/members/:userId',
    { config: { policy: { kind: 'admin', area: 'people', scope: 'person' } } },
    async (request, reply) => {
      const actor = requireActor(request);
      const { userId } = parse(MemberParams, request.params);
      await runOrganizationCommand(app, actor, { kind: 'people.remove', userId });
      return reply.code(204).send();
    },
  );
}
