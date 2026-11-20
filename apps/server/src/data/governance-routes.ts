import { DatabaseId } from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../auth/sessions.js';
import { parse } from '../http/validate.js';
import { AccessScope } from './access.js';
import { runGovernanceCommand } from './commands/governance.js';
import { dataStore } from './context.js';
import { governanceView } from './governance.js';

export async function governanceRoutes(app: FastifyInstance): Promise<void> {
  const admin = { config: { policy: { kind: 'admin', area: 'security', scope: 'organization' } } } as const;
  app.get('/api/admin/governance', admin, async (request) => {
    const actor = requireActor(request);
    const { databaseId } = parse(z.object({ databaseId: DatabaseId.optional() }), request.query);
    const { pool, schemas } = dataStore(app.ctx);
    return governanceView(new AccessScope(pool, schemas, actor), pool, schemas, databaseId);
  });
  app.post('/api/admin/governance/commands', admin, async (request) =>
    runGovernanceCommand(app, requireActor(request), request.body),
  );
}
