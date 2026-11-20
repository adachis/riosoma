import { readColumnSuggestions } from './joined-api.js';
import {
  DatabaseId,
  ColumnSuggestionsRequest,
  JoinSuggestionsRequest,
  type JoinSuggestions,
} from '@riosoma/contracts';
import { query, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../auth/sessions.js';
import { parse } from '../http/validate.js';
import { AccessScope } from './access.js';
import { dataStore } from './context.js';
import { suggestJoins } from './joins.js';

/** Join discovery: suggested links between tables, for people who can change fields. */
export async function joinRoutes(app: FastifyInstance): Promise<void> {
  const session = { config: { policy: { kind: 'session' as const } } };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.post('/api/databases/:databaseId/column-suggestions', session, async (request) => {
    const { databaseId } = parse(z.object({ databaseId: DatabaseId }), request.params);
    return readColumnSuggestions(
      app.ctx,
      requireActor(request),
      databaseId,
      parse(ColumnSuggestionsRequest, request.body),
    );
  });
  app.post(
    '/api/databases/:databaseId/join-suggestions',
    session,
    async (request): Promise<JoinSuggestions> => {
      const { databaseId } = parse(z.object({ databaseId: DatabaseId }), request.params);
      const input = parse(JoinSuggestionsRequest, request.body ?? {});
      const actor = requireActor(request);
      const { pool, schemas } = dataStore(app.ctx);
      return withTransaction(pool, async (db) => {
        // One snapshot for every table, and nothing here can write.
        await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
        const scope = new AccessScope(db, schemas, actor);
        await scope.require(databaseId, 'editSchema');
        return suggestJoins(db, schemas, scope, databaseId, input.tableIds);
      });
    },
  );
}
