import { uploadLimit } from '../data/files/settings.js';
import { PassThrough, Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AppError,
  BROWSED_PROVIDERS,
  FieldId,
  FileImportRequest,
  newId,
  RecordId,
  TableId,
  type AttachmentMeta,
  type CloudProvider,
  type DriveListing,
  type GooglePickerConfig,
  type ImportEvent,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { z } from 'zod';
import { auditEvent, authDatabase } from '../auth/database.js';
import { requireActor } from '../auth/sessions.js';
import { AccessScope } from '../data/access.js';
import { dataStore } from '../data/context.js';
import { finishUpload } from '../data/files/finish.js';
import { attachmentMeta } from '../data/files/metadata.js';
import { fileStorage, storedInDatabase } from '../data/files/storage.js';
import { safeFileName } from '../data/imports/core/files.js';
import { loadField, loadTable } from '../data/metadata.js';
import { requireVisibleRecords } from '../data/permissions/enforce.js';
import type { Actor } from '../http/policy.js';
import { parse } from '../http/validate.js';
import { installPickerHosts, integrationRoutes } from './apps.js';
import { box, boxDrive } from './box.js';
import { connectionRoutes, driveAccess } from './connections.js';
import type { BrowsableDrive, ImportableDrive } from './drive.js';
import { dropbox, dropboxDrive } from './dropbox.js';
import { oauthFlowRoutes } from './flow.js';
import { google, googleDrive, projectNumber } from './google.js';
import { googleCalendar, microsoftCalendar } from './calendars.js';
import { github } from './github.js';
import { xero } from './xero.js';
import { quickbooks } from './quickbooks.js';
import { registerOAuthProvider } from './providers.js';

registerOAuthProvider(github);
registerOAuthProvider(xero);
registerOAuthProvider(quickbooks);
registerOAuthProvider(dropbox);
registerOAuthProvider(box);
registerOAuthProvider(google);
registerOAuthProvider(googleCalendar);
registerOAuthProvider(microsoftCalendar);

const BROWSABLE: Record<(typeof BROWSED_PROVIDERS)[number], BrowsableDrive> = {
  dropbox: dropboxDrive,
  box: boxDrive,
};
const IMPORTABLE: Record<CloudProvider, ImportableDrive> = {
  dropbox: dropboxDrive,
  box: boxDrive,
  google: googleDrive,
};

const ListQuery = z.object({
  folder: z.string().max(500).default(''),
  query: z.string().trim().max(200).default(''),
  cursor: z.string().max(4000).default(''),
});
const ImportParams = z.object({ tableId: TableId, fieldId: FieldId, recordId: RecordId });

/** How often an import says how far it has got, at most. */
const PROGRESS_MS = 250;

const tooLarge = () => new AppError('payload_too_large', 'data.file.tooLarge');

/**
 * Checks the person may add a file to this record's attachment field: they can edit records in
 * the database, see and change the field, and see the record, since attaching is an edit of it.
 */
async function checkTarget(
  request: FastifyRequest,
  actor: Actor,
  target: z.infer<typeof ImportParams>,
): Promise<void> {
  const { pool, schemas } = dataStore(request.server.ctx);
  const scope = new AccessScope(pool, schemas, actor);
  const table = await loadTable(pool, schemas, target.tableId);
  if (!table || table.trashed) throw new AppError('not_found', 'errors.notFound');
  await scope.require(table.databaseId, 'editRecords');
  const field = await loadField(pool, schemas, target.fieldId);
  if (
    !field ||
    field.trashed ||
    field.tableId !== target.tableId ||
    field.type !== 'attachment' ||
    !scope.visibleFields(target.tableId, [field]).length
  )
    throw new AppError('not_found', 'errors.notFound');
  if (!scope.canEditField(target.tableId, field)) throw new AppError('forbidden', 'data.access.fieldLocked');
  const record = await query(
    pool,
    sql`SELECT 1 FROM ${ident(schemas.data, target.tableId)} WHERE __id = ${target.recordId} AND __deleted_at IS NULL`,
  );
  if (!record.rowCount) throw new AppError('not_found', 'errors.notFound');
  await requireVisibleRecords(pool, schemas, scope, target.tableId, [target.recordId]);
}

/** Counts the bytes going by, stops at the limit, and says how far it has got now and then. */
async function* measured(
  source: AsyncIterable<unknown>,
  limit: number,
  report: (bytes: number) => void,
): AsyncGenerator<Buffer> {
  let bytes = 0;
  let last = 0;
  for await (const value of source) {
    const chunk = value as Buffer;
    bytes += chunk.length;
    if (bytes > limit) throw tooLarge();
    const now = Date.now();
    if (now - last >= PROGRESS_MS) {
      last = now;
      report(bytes);
    }
    yield chunk;
  }
  report(bytes);
}

/** An error as the person may see it: an app error's own body, and anything else as internal. */
function failure(error: unknown): ImportEvent & { kind: 'failed' } {
  const known = error instanceof AppError ? error : new AppError('internal', 'errors.internal');
  return { kind: 'failed', error: known.toBody().error };
}

export interface ImportRequest {
  actor: Actor;
  provider: CloudProvider;
  fileId: string;
  exportAs?: FileImportRequest['exportAs'];
  signal: AbortSignal;
}

/** A picked file that's open at its drive and ready to copy. */
export interface OpenedImport {
  size: number | null;
  store(
    target: { tableId: string; fieldId: string; recordId: string },
    progress: (bytes: number, total: number | null) => void,
  ): Promise<AttachmentMeta>;
}

/**
 * Opens one picked file at its drive, refusing it at once when the drive says it's over the
 * upload limit.  `store` then copies it into storage through the same finishing as an upload: the
 * same limit, counted as it goes, its type from its bytes, a checksum, and quarantine until the
 * virus scanner clears it, with previews only after that.  A failed or canceled copy leaves nothing
 * behind, and the file sits in no record until a record command names it.
 */
export async function openImport(app: FastifyInstance, request: ImportRequest): Promise<OpenedImport> {
  const ctx = app.ctx;
  const { pool, schemas } = dataStore(ctx);
  await new AccessScope(pool, schemas, request.actor).requireOrganization();
  const limit = Math.min(
    ctx.config.fileImportMaxBytes ?? Infinity,
    await uploadLimit(pool, schemas.app, request.actor.orgId),
  );
  const access = await driveAccess(ctx, request.actor, request.provider);
  const opened = await IMPORTABLE[request.provider].open(
    access,
    request.fileId,
    request.exportAs,
    request.signal,
  );
  if (opened.size !== null && opened.size > limit) {
    opened.body.destroy();
    throw tooLarge();
  }
  // A response can be canceled before copying starts, so download errors must already be observed.
  opened.body.on('error', () => undefined);
  return {
    size: opened.size,
    async store(target, progress) {
      request.signal.throwIfAborted();
      progress(0, opened.size);
      // Stopping early, for the limit or a cancel, stops the download too.
      // A cancel can reach the download after the copy has stopped reading it, and the copy has
      // already heard of it by then.
      const counted = measured(opened.body, limit, (bytes) => progress(bytes, opened.size));
      const body = Readable.from(counted, { objectMode: false });
      const { pool, schemas } = dataStore(ctx);
      const { audit } = authDatabase(ctx);
      const kind = ctx.config.filesStorage ?? 'postgres';
      const id = newId('attachment');
      const { actor } = request;
      try {
        const file = await withTransaction(pool, async (db) => {
          const stored = await finishUpload(
            db,
            schemas.app,
            ctx.config,
            {
              id,
              orgId: actor.orgId,
              userId: actor.userId,
              tableId: target.tableId,
              fieldId: target.fieldId,
              name: safeFileName(opened.name),
              storage: kind,
            },
            body,
          );
          await auditEvent(db, audit, 'data.attachment.imported', actor, {
            provider: request.provider,
            attachmentId: id,
            tableId: target.tableId,
            fieldId: target.fieldId,
            recordId: target.recordId,
            size: Number(stored.size),
          });
          // Cancellation can arrive after the last byte, while metadata and audit writes are pending.
          request.signal.throwIfAborted();
          return stored;
        });
        return attachmentMeta(file);
      } catch (error) {
        // Bytes outside the database outlive the rolled-back row, so they go the way an upload's do.
        if (!storedInDatabase(kind)) {
          const storage = fileStorage(kind, pool, schemas.app, ctx.config);
          for (const key of [id, `${id}_small`, `${id}_large`])
            await storage.delete(key).catch(() => undefined);
        }
        throw error;
      } finally {
        body.destroy();
      }
    },
  };
}

/**
 * Connecting accounts, admin settings for each provider's app, browsing Dropbox and Box, opening
 * Google's Picker, and copying picked files into attachment fields.
 */
export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const session = { config: { policy: { kind: 'session' as const } } };
  installPickerHosts(app);
  await app.register(oauthFlowRoutes);
  await app.register(connectionRoutes);
  await app.register(integrationRoutes);

  app.get('/api/connections/:provider/files', session, async (request, reply): Promise<DriveListing> => {
    const { provider } = parse(z.object({ provider: z.enum(BROWSED_PROVIDERS) }), request.params);
    const input = parse(ListQuery, request.query);
    const access = await driveAccess(ctx, requireActor(request), provider);
    reply.header('cache-control', 'no-store');
    return BROWSABLE[provider].list(access, { ...input, signal: AbortSignal.timeout(30_000) });
  });

  app.get('/api/connections/:provider/thumbnails/:fileId', session, async (request, reply) => {
    const { provider, fileId } = parse(
      z.object({ provider: z.enum(BROWSED_PROVIDERS), fileId: z.string().min(1).max(500) }),
      request.params,
    );
    const access = await driveAccess(ctx, requireActor(request), provider);
    const thumbnail = await BROWSABLE[provider].thumbnail(access, fileId, AbortSignal.timeout(20_000));
    if (!thumbnail) throw new AppError('not_found', 'errors.notFound');
    return reply
      .headers({
        'content-type': thumbnail.type,
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
      })
      .send(thumbnail.body);
  });

  app.get('/api/connections/google/picker', session, async (request, reply): Promise<GooglePickerConfig> => {
    const access = await driveAccess(ctx, requireActor(request), 'google');
    reply.header('cache-control', 'no-store');
    return {
      accessToken: access.accessToken,
      apiKey: access.app.apiKey,
      appId: projectNumber(access.app.clientId),
    };
  });

  app.post(
    '/api/tables/:tableId/fields/:fieldId/records/:recordId/imports',
    session,
    async (request, reply) => {
      const target = parse(ImportParams, request.params);
      const input = parse(FileImportRequest, request.body);
      const actor = requireActor(request);
      const controller = new AbortController();
      let finished = false;
      // The person canceled, or closed the page: the copy stops, and what it stored is removed.
      // The listener comes before the first wait, and a connection that's already gone stops it
      // at once, since a close that happened earlier is never heard.
      reply.raw.on('close', () => {
        if (!finished) controller.abort();
      });
      if (request.raw.aborted || reply.raw.destroyed) controller.abort();
      // Nobody is left to answer, so the request ends without starting the copy or logging it.
      const gone = () => {
        reply.hijack();
        reply.raw.destroy();
      };
      await checkTarget(request, actor, target);
      if (controller.signal.aborted) return gone();
      // Refusals before the first byte, such as a missing file or an account to reconnect, get an
      // ordinary status.  Later ones arrive as the last line.
      let opened: OpenedImport;
      try {
        opened = await openImport(app, {
          actor,
          provider: input.provider,
          fileId: input.fileId,
          ...(input.exportAs ? { exportAs: input.exportAs } : {}),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) return gone();
        throw error;
      }
      const out = new PassThrough();
      const line = (event: ImportEvent) => out.write(`${JSON.stringify(event)}\n`);
      // Copying waits until response authorization has finished and the stream has a reader.
      out.once('resume', () => {
        void opened
          .store(target, (bytes, total) => line({ kind: 'progress', bytes, total }))
          .then(
            (file) => {
              finished = true;
              line({ kind: 'done', file });
              out.end();
            },
            (error: unknown) => {
              finished = true;
              if (!controller.signal.aborted && !(error instanceof AppError && error.userFault))
                request.log.error({ err: error }, 'file import failed');
              line(failure(error));
              out.end();
            },
          );
      });
      return (
        reply
          .header('content-type', 'application/x-ndjson; charset=utf-8')
          .header('cache-control', 'no-store')
          // A proxy that buffers responses, such as nginx by default, would hold the progress back.
          .header('x-accel-buffering', 'no')
          .send(out)
      );
    },
  );
}
