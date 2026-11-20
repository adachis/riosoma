import { libraryRoutes } from './library-routes.js';
import { DatabaseId, ImageSearchQuery, ImageSearchTarget, SimilarQuery, WebQuery } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { dataStore } from '../data/context.js';
import { imagePreview, imageSearchStatus, searchImages } from '../data/files/image-search.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../auth/sessions.js';
import { runKnowledgeCommand } from '../data/commands/knowledge.js';
import { embeddingTables, installEmbeddings, similarRecords } from '../data/embeddings.js';
import { installLibraryIndexing } from '../data/library-index.js';
import { knowledgeSettings, memories } from '../data/knowledge.js';
import { parse } from '../http/validate.js';
import { searchWeb } from './knowledge-calls.js';

export async function knowledgeRoutes(app: FastifyInstance) {
  const session = { config: { policy: { kind: 'session' } } } as const;
  const admin = { config: { policy: { kind: 'admin', area: 'ai', scope: 'organization' } } } as const;
  app.get('/api/knowledge/settings', admin, async (request) => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    const keys = await query<{ provider_id: string }>(
      pool,
      sql`SELECT provider_id FROM ${ident(schemas.app, 'ai_keys')} WHERE org_id = ${actor.orgId} AND provider_id IN ('search-subscription', 'search-research')`,
    );
    return {
      ...(await knowledgeSettings(app.ctx, actor)),
      searchKeys: Object.fromEntries(
        ['subscription', 'research'].map((engine) => [
          engine,
          keys.rows.some((row) => row.provider_id === `search-${engine}`),
        ]),
      ),
    };
  });
  app.post('/api/knowledge/commands', session, (request) =>
    runKnowledgeCommand(app, requireActor(request), request.body),
  );
  app.get('/api/knowledge/memories', session, (request) => {
    const input = parse(
      z.object({ databaseId: DatabaseId, visibility: z.enum(['personal', 'database']).optional() }),
      request.query,
    );
    return memories(app.ctx, requireActor(request), input.databaseId, input.visibility);
  });
  app.get('/api/knowledge/tables', session, (request) => {
    const { databaseId } = parse(z.object({ databaseId: DatabaseId }), request.query);
    return embeddingTables(app.ctx, requireActor(request), databaseId);
  });
  app.post('/api/knowledge/similar', session, (request) =>
    similarRecords(app, request, parse(SimilarQuery, request.body)),
  );
  app.post('/api/knowledge/search', session, (request) =>
    searchWeb(app.ctx, requireActor(request), parse(WebQuery, request.body)),
  );
  app.get('/api/knowledge/images/status', session, (request) =>
    imageSearchStatus(app.ctx, requireActor(request), parse(ImageSearchTarget, request.query)),
  );
  app.post('/api/knowledge/images', session, (request) =>
    searchImages(app.ctx, requireActor(request), parse(ImageSearchQuery, request.body)),
  );
  app.get('/api/knowledge/images/preview', session, async (request, reply) => {
    const { token } = parse(z.object({ token: z.string().min(1).max(24000) }), request.query);
    const preview = await imagePreview(app.ctx, requireActor(request), token);
    return reply
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .type(preview.type)
      .send(preview.body);
  });
  await libraryRoutes(app);
  installEmbeddings(app);
  installLibraryIndexing(app);
}
