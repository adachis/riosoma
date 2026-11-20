import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { bearerChallenge } from '../authorization/store.js';

/**
 * What every /api/v1 answer carries, including routes registered outside the API plugin: no caching,
 * and on a 401 the pointer to the OAuth resource metadata.
 */
export function apiV1Headers(app: FastifyInstance) {
  return async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.header('cache-control', 'no-store');
    // Only while OAuth is available does a 401 point at the metadata, so without it nothing changes.
    const challenge = reply.statusCode === 401 ? bearerChallenge(app.ctx, 'api') : null;
    if (challenge) reply.header('www-authenticate', challenge);
  };
}
