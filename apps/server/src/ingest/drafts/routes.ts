import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, TableId } from '@riosoma/contracts';
import { requireActor } from '../../auth/sessions.js';
import { parse } from '../../http/validate.js';
import { refuseDemo } from '../../demo/boundary.js';
import { dataStore } from '../../data/context.js';
import { AccessScope } from '../../data/access.js';
import { loadTable } from '../../data/metadata.js';
import type { CommandContext } from '../../data/commands/context.js';
import { requireEvidenceAccess, requireSettings } from '../setup/evidence.js';
import { draftResponse, listDrafts, readDraft } from './store.js';
import { waitForDraftWork } from './worker.js';

const session = { config: { policy: { kind: 'session' as const, beforeBody: true as const } } };
const base = '/api/tables/:tableId/ingest/drafts';
export async function ingestDraftRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onClose', () => waitForDraftWork(app));
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  for (const detail of [false, true])
    app.get(detail ? `${base}/:draftId` : base, session, async (request) => {
      const actor = requireActor(request);
      refuseDemo(actor);
      const { tableId, draftId } = parse(
        z.object({ tableId: TableId, draftId: z.string().min(1).max(200).optional() }),
        request.params,
      );
      const { pool, schemas } = dataStore(app.ctx);
      const table = await loadTable(pool, schemas, tableId);
      if (!table || table.orgId !== actor.orgId || table.trashed)
        throw new AppError('not_found', 'errors.notFound');
      requireSettings(table.ingest);
      await new AccessScope(pool, schemas, actor).require(table.databaseId, 'read');
      const c: CommandContext = {
        db: pool,
        schemas,
        actor,
        databaseId: table.databaseId,
        appContext: app.ctx,
        fileConfig: app.ctx.config,
      };
      let evidence = true;
      try {
        await requireEvidenceAccess(c, tableId);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'forbidden') throw error;
        evidence = false;
      }
      return detail
        ? draftResponse(await readDraft(c, tableId, draftId!), evidence)
        : { drafts: (await listDrafts(c, tableId)).map((draft) => draftResponse(draft, evidence)) };
    });
}
