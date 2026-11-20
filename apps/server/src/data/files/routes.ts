import { demoReadOnly } from '../../demo/boundary.js';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, AttachmentId, FILE_LIMITS, FieldId, TableId, newId } from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { apiV1Headers } from '../../api-v1/headers.js';
import { requireActor } from '../../auth/sessions.js';
import { parse } from '../../http/validate.js';
import { AccessScope } from '../access.js';
import { dataStore } from '../context.js';
import { loadField, loadTable } from '../metadata.js';
import { installFileCleanup } from './cleanup.js';
import { disposition, fileName } from './detect.js';
import { attachmentMeta, loadFiles, type FileRow } from './metadata.js';
import { finishUpload } from './finish.js';
import { resumableRoutes, checkUploadTarget } from './resumable.js';
import { uploadLimit } from './settings.js';
import { installFileScanner } from './scanning.js';
import {
  fileStorage,
  redirectDownload,
  signedDownload,
  storedInDatabase,
  type ByteRange,
} from './storage.js';

const sessionRoute = { config: { policy: { kind: 'session' as const } } };
const notFound = () => new AppError('not_found', 'errors.notFound');
const tooLarge = () => new AppError('payload_too_large', 'data.file.tooLarge');
const FileParams = z.object({ attachmentId: AttachmentId });
const PreviewParams = FileParams.extend({ size: z.enum(['small', 'large']) });

function rangeOf(header: string, length: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || length === 0) return null;
  const suffix = !match[1];
  const start = suffix ? Math.max(0, length - Number(match[2])) : Number(match[1]);
  const end = suffix || !match[2] ? length - 1 : Math.min(length - 1, Number(match[2]));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= length)
    return null;
  return { start, end };
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  installFileCleanup(app);
  installFileScanner(app);
  // Parser changes stay inside this plugin: all other API bodies keep their normal validation.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_request, payload, done) => {
    done(null, payload);
  });

  await resumableRoutes(app);

  const upload = async (request: FastifyRequest) => {
    const { tableId, fieldId } = parse(z.object({ tableId: TableId, fieldId: FieldId }), request.params);
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    const scope = new AccessScope(pool, schemas, actor);
    const table = await loadTable(pool, schemas, tableId);
    if (!table || table.trashed) throw notFound();
    await scope.require(table.databaseId, 'editRecords');
    const field = await loadField(pool, schemas, fieldId);
    if (!field || field.trashed || field.tableId !== tableId || field.type !== 'attachment') throw notFound();
    // A field the person can't see doesn't exist for them, and a locked one takes no new files.
    if (!scope.visibleFields(tableId, [field]).length) throw notFound();
    if (!scope.canEditField(tableId, field)) throw new AppError('forbidden', 'data.access.fieldLocked');
    if (request.headers['x-record-id'])
      await checkUploadTarget(app, request, pool, tableId, fieldId, String(request.headers['x-record-id']));
    const name = fileName(request.headers['x-file-name']);
    const limit = await uploadLimit(pool, schemas.app, actor.orgId);
    if (Number(request.headers['content-length'] ?? 0) > limit) throw tooLarge();
    const id = newId('attachment');
    const kind = app.ctx.config.filesStorage ?? 'postgres';
    const payload = request.body instanceof Readable ? request.body : Readable.from([]);
    try {
      return await withTransaction(pool, async (db) => {
        const file = await finishUpload(
          db,
          schemas.app,
          app.ctx.config,
          { id, orgId: actor.orgId, userId: actor.userId, tableId, fieldId, name, storage: kind },
          payload,
        );
        return attachmentMeta(file);
      });
    } catch (error) {
      if (!storedInDatabase(kind)) {
        const storage = fileStorage(kind, pool, schemas.app, app.ctx.config);
        for (const key of [id, `${id}_small`, `${id}_large`])
          await storage.delete(key).catch((failure: unknown) => {
            request.log.warn({ err: failure }, 'failed upload cleanup');
          });
      }
      throw error;
    } finally {
      payload.resume();
    }
  };
  app.post('/api/tables/:tableId/fields/:fieldId/files', sessionRoute, upload);
  // The bearer upload lives here beside its session twin, so it adds the headers the API plugin
  // gives every other /api/v1 route.
  app.post(
    '/api/v1/tables/:tableId/fields/:fieldId/files',
    {
      config: { policy: { kind: 'token', scope: 'data.records:write' } },
      onSend: apiV1Headers(app),
    },
    upload,
  );

  async function readable(request: FastifyRequest, ids: readonly string[]): Promise<FileRow[]> {
    const { pool, schemas } = dataStore(app.ctx);
    const actor = requireActor(request);
    const scope = new AccessScope(pool, schemas, actor);
    const files = await loadFiles(pool, schemas.app, ids);
    const allowed = new Set<string>();
    for (const tableId of new Set(
      files.filter((file) => file.org_id === actor.orgId).map((file) => file.table_id),
    )) {
      const table = await loadTable(pool, schemas, tableId);
      if (table && !table.trashed && (await scope.databaseRole(table.databaseId))) allowed.add(tableId);
    }
    const readable: FileRow[] = [];
    for (const file of files) {
      if (!allowed.has(file.table_id)) continue;
      // A file is readable only through a field the person can see, in a record they can see, or
      // when they uploaded it and it isn't in a record yet.
      const table = (await loadTable(pool, schemas, file.table_id))!;
      await scope.prepare(table.databaseId);
      const field = await loadField(pool, schemas, file.field_id);
      if (!field || !scope.visibleFields(table.id, [field]).length) continue;
      if (!scope.allowsUse(table.databaseId, 'export', { fieldIds: [field.id] })) continue;
      if (scope.limitsRecords(table.id)) {
        const held = await query(
          pool,
          sql`SELECT 1 FROM ${ident(schemas.data, table.id)}
            WHERE ${ident(field.columnName)} @> ARRAY[${file.id}]::text[] LIMIT 1`,
        );
        const seen = await query(
          pool,
          sql`SELECT 1 FROM ${ident(schemas.data, table.id)}
            WHERE ${ident(field.columnName)} @> ARRAY[${file.id}]::text[]
              AND (${scope.recordPredicate(table.id)}) LIMIT 1`,
        );
        if (!seen.rowCount && (held.rowCount || file.created_by !== actor.userId)) continue;
      }
      readable.push(file);
    }
    return readable;
  }

  app.get('/api/files', sessionRoute, async (request, reply) => {
    const { ids } = parse(
      z.object({
        ids: z
          .string()
          .transform((value) => value.split(','))
          .pipe(z.array(AttachmentId).max(FILE_LIMITS.detailsPerRequest)),
      }),
      request.query,
    );
    reply.header('cache-control', 'no-store');
    return (await readable(request, ids)).map(attachmentMeta);
  });

  async function serve(request: FastifyRequest, reply: FastifyReply, preview?: 'small' | 'large') {
    const { attachmentId } = parse(FileParams, request.params);
    const [file] = await readable(request, [attachmentId]);
    if (!file || (file.scan_state !== 'clean' && (preview || file.scan_state !== 'too_large_allowed')))
      throw notFound();
    const thumbnail = preview ? file.thumbnails?.[preview] : undefined;
    if (preview && !thumbnail) throw notFound();
    const key = thumbnail?.key ?? file.storage_key;
    const length = thumbnail?.size ?? Number(file.size);
    const type = preview ? 'image/webp' : file.type;
    const etag = `"${thumbnail?.sha256 ?? file.sha256}"`;
    const attachment = disposition(type, preview ? `${file.name}.webp` : file.name);
    reply.headers({
      'content-type': type,
      'content-length': length,
      etag,
      'content-disposition': attachment,
      'x-content-type-options': 'nosniff',
      'content-security-policy':
        "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
      'cache-control':
        file.scan_state === 'too_large_allowed'
          ? 'private, no-store'
          : 'private, max-age=31536000, immutable',
    });
    if (
      request.headers['if-none-match']
        ?.split(',')
        .map((tag) => tag.trim())
        .includes(etag)
    ) {
      reply.removeHeader('content-length');
      return reply.code(304).send();
    }
    const { pool, schemas } = dataStore(app.ctx);
    if (requireActor(request).demo && (file.storage === 's3' || file.storage === 'azure-blob'))
      throw demoReadOnly();
    const storage = fileStorage(file.storage, pool, schemas.app, app.ctx.config);
    const location =
      file.scan_state === 'clean'
        ? await signedDownload(storage, key, app.ctx.config, { type, disposition: attachment })
        : null;
    if (location) return redirectDownload(reply, location);
    let range: ByteRange | undefined;
    if (type.startsWith('audio/') || type.startsWith('video/')) {
      reply.header('accept-ranges', 'bytes');
      if (request.headers.range && (!request.headers['if-range'] || request.headers['if-range'] === etag)) {
        const parsed = rangeOf(request.headers.range, length);
        if (!parsed) {
          reply.removeHeader('content-length');
          reply.header('content-range', `bytes */${length}`);
          return reply
            .code(416)
            .type('application/json')
            .send(new AppError('bad_request', 'data.file.range').toBody());
        }
        range = parsed;
        reply
          .code(206)
          .header('content-range', `bytes ${range.start}-${range.end}/${length}`)
          .header('content-length', range.end - range.start + 1);
      }
    }
    // Detected media types use safe dispositions, nosniff, and a sandboxed CSP.
    // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
    return reply.send(storage.read(key, range));
  }

  app.get('/api/files/:attachmentId/thumbnails/:size', sessionRoute, async (request, reply) => {
    const { size } = parse(PreviewParams, request.params);
    return serve(request, reply, size);
  });
  app.get('/api/files/:attachmentId/:name', sessionRoute, (request, reply) => serve(request, reply));
}
