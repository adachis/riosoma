import {
  AirtableImportId,
  AppError,
  DatabaseId,
  IMPORT_PLATFORMS,
  isImportDone,
  PlatformBasesRequest,
  PlatformImportRequest,
  SmartsheetImportRequest,
  type ImportPlatform,
  type PlatformBases,
  type PlatformImport,
  type PlatformImportList,
  type PlatformPreview,
} from '@riosoma/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../../../auth/sessions.js';
import { parse } from '../../../http/validate.js';
import { AccessScope } from '../../access.js';
import { dataStore } from '../../context.js';
import { databaseImports, loadImport, recentImports, type ImportRow } from '../core/store.js';
import { PlatformImporter } from './importer.js';
import { importOf, PLATFORM_TABLE } from './store.js';

/** How long `?since=` waits for an import to move on */
const WAIT_MS = 20_000;
/** How often a waiting request looks again, for imports another server is running */
const LOOK_AGAIN_MS = 2_000;

const session = { config: { policy: { kind: 'session' as const } } };
const ImportParams = z.object({ importId: AirtableImportId });
const notFound = () => new AppError('not_found', 'errors.notFound');

/**
 * Importing databases and task collections from each platform, with the same routes
 * for each tool under its own name.  See `packages/contracts/src/platform-import.ts`.
 */
export async function platformImportRoutes(app: FastifyInstance): Promise<void> {
  const importer = new PlatformImporter(app);
  app.ctx.platformImports = importer;
  app.addHook('onReady', async () => {
    importer.start();
  });
  app.addHook('onClose', async () => {
    await importer.close();
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  /** An import from this tool the person started, or one that made a database they can read. */
  async function visible(request: FastifyRequest, platform: ImportPlatform, id: string): Promise<ImportRow> {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    const row = await loadImport(pool, schemas, PLATFORM_TABLE, id);
    if (!row || row.org_id !== actor.orgId || row.platform !== platform) throw notFound();
    if (row.user_id === actor.userId) return row;
    if (row.database_id && (await new AccessScope(pool, schemas, actor).databaseRole(row.database_id)))
      return row;
    throw notFound();
  }

  app.get(
    '/api/databases/:databaseId/platform-imports',
    session,
    async (request): Promise<PlatformImportList> => {
      const actor = requireActor(request);
      const { databaseId } = parse(z.object({ databaseId: DatabaseId }), request.params);
      const { pool, schemas } = dataStore(app.ctx);
      await new AccessScope(pool, schemas, actor).require(databaseId, 'read');
      return { imports: (await databaseImports(pool, schemas, PLATFORM_TABLE, databaseId)).map(importOf) };
    },
  );

  for (const platform of IMPORT_PLATFORMS) {
    app.post(`/api/imports/${platform}/preview`, session, async (request): Promise<PlatformPreview> => {
      const actor = requireActor(request);
      if (actor.kind === 'guest') throw new AppError('forbidden', 'data.access.denied');
      return importer.preview(
        platform,
        parse(platform === 'smartsheet' ? SmartsheetImportRequest : PlatformImportRequest, request.body),
      );
    });
    app.post(`/api/imports/${platform}/bases`, session, async (request): Promise<PlatformBases> => {
      const actor = requireActor(request);
      if (actor.kind === 'guest') throw new AppError('forbidden', 'data.access.denied');
      return { bases: await importer.bases(platform, parse(PlatformBasesRequest, request.body)) };
    });

    app.post(`/api/imports/${platform}`, session, async (request): Promise<PlatformImport> => {
      const actor = requireActor(request);
      return importer.begin(
        actor,
        platform,
        parse(platform === 'smartsheet' ? SmartsheetImportRequest : PlatformImportRequest, request.body),
      );
    });

    app.get(`/api/imports/${platform}`, session, async (request): Promise<PlatformImportList> => {
      const actor = requireActor(request);
      const { pool, schemas } = dataStore(app.ctx);
      await importer.sweep();
      const rows = await recentImports(pool, schemas, PLATFORM_TABLE, actor.userId, actor.orgId, platform);
      return { imports: rows.map(importOf) };
    });

    app.get(
      `/api/imports/${platform}/:importId`,
      session,
      async (request, reply): Promise<PlatformImport> => {
        const { importId } = parse(ImportParams, request.params);
        const { since } = parse(
          z.object({ since: z.coerce.number().int().min(0).optional() }),
          request.query,
        );
        let row = await visible(request, platform, importId);
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
          row = (await loadImport(pool, schemas, PLATFORM_TABLE, importId)) ?? row;
        }
        return importOf(row);
      },
    );

    app.post(
      `/api/imports/${platform}/:importId/cancel`,
      session,
      async (request): Promise<PlatformImport> => {
        const { importId } = parse(ImportParams, request.params);
        await visible(request, platform, importId);
        return importer.cancel(requireActor(request), importId);
      },
    );

    app.get(
      `/api/databases/:databaseId/imports/${platform}`,
      session,
      async (request): Promise<PlatformImportList> => {
        const actor = requireActor(request);
        const { databaseId } = parse(z.object({ databaseId: DatabaseId }), request.params);
        const { pool, schemas } = dataStore(app.ctx);
        await new AccessScope(pool, schemas, actor).require(databaseId, 'read');
        const rows = await databaseImports(pool, schemas, PLATFORM_TABLE, databaseId, platform);
        return { imports: rows.map(importOf) };
      },
    );
  }
}
