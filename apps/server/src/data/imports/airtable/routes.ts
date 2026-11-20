import {
  AirtableBasesRequest,
  AirtableImportId,
  AirtableImportRequest,
  AppError,
  DatabaseId,
  isImportDone,
  type AirtableBases,
  type AirtableImport,
  type AirtableImportList,
} from '@riosoma/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../../../auth/sessions.js';
import { parse } from '../../../http/validate.js';
import { AccessScope } from '../../access.js';
import { dataStore } from '../../context.js';
import { AirtableImporter } from './importer.js';
import { databaseImports, importOf, loadImport, recentImports, type ImportRow } from './store.js';

/** How long `?since=` waits for an import to move on */
const WAIT_MS = 20_000;
/** How often a waiting request looks again, for imports another server is running */
const LOOK_AGAIN_MS = 2_000;

const session = { config: { policy: { kind: 'session' as const } } };
const ImportParams = z.object({ importId: AirtableImportId });
const notFound = () => new AppError('not_found', 'errors.notFound');

/** Importing whole Airtable bases.  See `packages/contracts/src/airtable-import.ts`. */
export async function airtableImportRoutes(app: FastifyInstance): Promise<void> {
  const importer = new AirtableImporter(app);
  app.ctx.airtableImports = importer;
  app.addHook('onReady', async () => {
    importer.start();
  });
  app.addHook('onClose', async () => {
    await importer.close();
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  /** An import the person started, or one that made a database they can read. */
  async function visible(request: FastifyRequest, id: string): Promise<ImportRow> {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    const row = await loadImport(pool, schemas, id);
    if (!row || row.org_id !== actor.orgId) throw notFound();
    if (row.user_id === actor.userId) return row;
    if (row.database_id && (await new AccessScope(pool, schemas, actor).databaseRole(row.database_id)))
      return row;
    throw notFound();
  }

  app.post('/api/imports/airtable/bases', session, async (request, reply): Promise<AirtableBases> => {
    const actor = requireActor(request);
    if (actor.kind === 'guest') throw new AppError('forbidden', 'data.access.denied');
    const { pool, schemas } = dataStore(app.ctx);
    await new AccessScope(pool, schemas, actor).requireOrganization();
    const { token } = parse(AirtableBasesRequest, request.body);
    const closed = new AbortController();
    const abort = () => closed.abort();
    reply.raw.once('close', abort);
    try {
      return { bases: await importer.bases(token, closed.signal) };
    } finally {
      reply.raw.off('close', abort);
    }
  });

  app.post('/api/imports/airtable', session, async (request): Promise<AirtableImport> => {
    const actor = requireActor(request);
    return importer.begin(actor, parse(AirtableImportRequest, request.body));
  });

  app.get('/api/imports/airtable', session, async (request): Promise<AirtableImportList> => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    await importer.sweep();
    return { imports: (await recentImports(pool, schemas, actor.userId, actor.orgId)).map(importOf) };
  });

  app.get('/api/imports/airtable/:importId', session, async (request, reply): Promise<AirtableImport> => {
    const { importId } = parse(ImportParams, request.params);
    const { since } = parse(z.object({ since: z.coerce.number().int().min(0).optional() }), request.query);
    let row = await visible(request, importId);
    if (since === undefined || row.version > since || isImportDone(row.state)) return importOf(row);
    // Waits for the next change, so people watching an import see it move without asking over and over.
    const { pool, schemas } = dataStore(app.ctx);
    const closed = new AbortController();
    reply.raw.once('close', () => closed.abort());
    const deadline = Date.now() + WAIT_MS;
    while (row.version <= since && !isImportDone(row.state) && !closed.signal.aborted) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      await importer.changed(importId, Math.min(LOOK_AGAIN_MS, left), closed.signal);
      row = (await loadImport(pool, schemas, importId)) ?? row;
    }
    return importOf(row);
  });

  app.post('/api/imports/airtable/:importId/cancel', session, async (request): Promise<AirtableImport> => {
    const { importId } = parse(ImportParams, request.params);
    return importer.cancel(requireActor(request), importId);
  });

  app.get(
    '/api/databases/:databaseId/imports/airtable',
    session,
    async (request): Promise<AirtableImportList> => {
      const actor = requireActor(request);
      const { databaseId } = parse(z.object({ databaseId: DatabaseId }), request.params);
      const { pool, schemas } = dataStore(app.ctx);
      await new AccessScope(pool, schemas, actor).require(databaseId, 'read');
      return { imports: (await databaseImports(pool, schemas, databaseId)).map(importOf) };
    },
  );
}
