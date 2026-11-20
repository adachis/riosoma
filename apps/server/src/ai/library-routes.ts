import { SearchKnowledge, type TokenScope } from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../auth/sessions.js';
import { parse } from '../http/validate.js';
import { libraries, libraryDocuments, searchKnowledge } from '../data/libraries.js';
import { runLibraryCommand } from '../data/commands/libraries.js';

export async function libraryRoutes(app: FastifyInstance) {
  for (const prefix of ['/api/knowledge', '/api/v1/knowledge']) {
    const policy = (scope: TokenScope, beforeBody?: true) => ({
      config: {
        policy: prefix.includes('/v1/')
          ? { kind: 'token' as const, scope, beforeBody }
          : { kind: 'session' as const, beforeBody },
      },
    });
    app.get(`${prefix}/libraries`, policy('data.records:read'), (request) =>
      libraries(app.ctx, requireActor(request)),
    );
    app.get(`${prefix}/libraries/:libraryId/documents`, policy('data.records:read'), (request) => {
      const { libraryId } = parse(z.object({ libraryId: z.string().uuid() }), request.params);
      return libraryDocuments(app.ctx, requireActor(request), libraryId);
    });
    app.post(`${prefix}/search-documents`, policy('data.records:read'), (request) =>
      searchKnowledge(
        app.ctx,
        requireActor(request),
        parse(SearchKnowledge, request.body),
        requireActor(request).token ? null : undefined,
      ),
    );
    app.post(
      `${prefix}/library-commands`,
      { ...policy('data.records:write', true), bodyLimit: 15 * 1024 * 1024 },
      async (request, reply) => {
        const controller = new AbortController();
        const close = () => controller.abort();
        request.raw.once('aborted', close);
        reply.raw.once('close', close);
        try {
          return await runLibraryCommand(app, requireActor(request), request.body, controller.signal);
        } finally {
          request.raw.removeListener('aborted', close);
          reply.raw.removeListener('close', close);
        }
      },
    );
  }
}
