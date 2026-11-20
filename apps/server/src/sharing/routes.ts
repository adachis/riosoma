import type { FastifyInstance } from 'fastify';
import { grantRoutes } from './grants.js';
import { invitationRoutes } from './invitations.js';
import { memberRoutes } from './members.js';
import { groupRoutes } from './groups.js';
import { homeRoutes } from './home.js';
import { folderRoutes } from './folders.js';

export async function sharingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  await app.register(memberRoutes);
  await app.register(groupRoutes);
  await app.register(folderRoutes);
  await app.register(homeRoutes);
  await app.register(invitationRoutes);
  await app.register(grantRoutes);
}
