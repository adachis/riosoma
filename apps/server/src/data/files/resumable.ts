import { Readable } from 'node:stream';
import { AppError, AttachmentId, FieldId, RecordId, TableId, newId } from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../../auth/sessions.js';
import { parse } from '../../http/validate.js';
import { AccessScope } from '../access.js';
import { dataStore } from '../context.js';
import { loadField, loadTable } from '../metadata.js';
import { uploadLimit } from './settings.js';
import { fileName } from './detect.js';
import { finishUpload } from './finish.js';
import { fileStorage, storedInDatabase, type StorageKind } from './storage.js';

const session = { config: { policy: { kind: 'session' as const } } };
const missing = () => new AppError('not_found', 'errors.notFound');
const invalid = () => new AppError('validation_failed', 'errors.validationFailed');
const tooLarge = () => new AppError('payload_too_large', 'data.file.tooLarge');
const collection = '/api/tables/:tableId/fields/:fieldId/records/:recordId/uploads';
const resource = '/api/uploads/:attachmentId';
interface Upload {
  id: string;
  org_id: string;
  created_by: string;
  table_id: string;
  field_id: string;
  record_id: string;
  name: string;
  metadata: string;
  length: string;
  offset_bytes: string;
  storage: StorageKind;
  completed: boolean;
}

export async function checkUploadTarget(
  app: FastifyInstance,
  request: FastifyRequest,
  db: Queryable,
  tableId: string,
  fieldId: string,
  recordId: string,
): Promise<void> {
  const { schemas } = dataStore(app.ctx);
  const scope = new AccessScope(db, schemas, requireActor(request));
  const table = await loadTable(db, schemas, tableId);
  if (!table || table.trashed) throw missing();
  await scope.require(table.databaseId, 'editRecords');
  const field = await loadField(db, schemas, fieldId);
  if (
    !field ||
    field.trashed ||
    field.tableId !== tableId ||
    field.type !== 'attachment' ||
    !scope.visibleFields(tableId, [field]).length
  )
    throw missing();
  if (!scope.canEditField(tableId, field)) throw new AppError('forbidden', 'data.access.fieldLocked');
  const record = await query(
    db,
    sql`SELECT 1 FROM ${ident(schemas.data, tableId)}
    WHERE __id = ${recordId} AND __deleted_at IS NULL AND NOT __source_gone
      AND (${scope.recordPredicate(tableId)})`,
  );
  if (!record.rowCount) throw missing();
}

function integer(value: unknown): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw invalid();
  return Number(value);
}

function metadata(value: unknown): { raw: string; name: string | null } {
  if (value === undefined) return { raw: '', name: null };
  if (typeof value !== 'string' || value.length > 8192) throw invalid();
  const keys = new Set<string>();
  let name: string | null = null;
  for (const entry of value.split(',')) {
    const match = /^([\x21-\x2b\x2d-\x7e]+)(?: ([A-Za-z0-9+/]*={0,2}))?$/.exec(entry.trim());
    if (!match || keys.has(match[1]!)) throw invalid();
    keys.add(match[1]!);
    const encoded = match[2] ?? '';
    if (Buffer.from(encoded, 'base64').toString('base64') !== encoded) throw invalid();
    if (match[1] === 'filename')
      name = fileName(encodeURIComponent(Buffer.from(encoded, 'base64').toString('utf8')));
  }
  return { raw: value, name };
}

export async function cleanupUploads(app: Pick<FastifyInstance, 'ctx'>): Promise<void> {
  if (!app.ctx.pool || !app.ctx.config.database) return;
  const { pool, schemas } = dataStore(app.ctx);
  for (;;) {
    const count = await withTransaction(pool, async (db) => {
      const expired = await query<Upload>(
        db,
        sql`SELECT * FROM ${ident(schemas.app, 'file_uploads')}
        WHERE expires_at <= now()
        AND table_id NOT IN (SELECT t.id FROM ${ident(schemas.app, 'tables')} t
          JOIN ${ident(schemas.app, 'databases')} d ON d.id = t.database_id WHERE d.legal_hold)
        ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
      );
      for (const upload of expired.rows) {
        if (!upload.completed && !storedInDatabase(upload.storage)) {
          const storage = fileStorage(upload.storage, db, schemas.app, app.ctx.config);
          for (const key of [upload.id, `${upload.id}_small`, `${upload.id}_large`])
            await storage.delete(key);
        }
        await query(db, sql`DELETE FROM ${ident(schemas.app, 'file_uploads')} WHERE id = ${upload.id}`);
      }
      return expired.rows.length;
    });
    if (count < 100) break;
  }
}

export async function resumableRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.routeOptions.url === collection || request.routeOptions.url === resource)
      reply.header('tus-resumable', '1.0.0').header('cache-control', 'no-store');
    return payload;
  });
  const options = async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    await new AccessScope(pool, schemas, actor).requireOrganization();
    const limit = await uploadLimit(pool, schemas.app, actor.orgId);
    return reply
      .headers({
        'tus-version': '1.0.0',
        'tus-extension': 'creation,termination',
        ...(Number.isFinite(limit) ? { 'tus-max-size': String(limit) } : {}),
      })
      .code(204)
      .send();
  };
  app.options(collection, session, options);
  app.options(resource, session, options);
  const protocol = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('tus-resumable', '1.0.0').header('cache-control', 'no-store');
    if (request.headers['tus-resumable'] !== '1.0.0')
      return reply.header('tus-version', '1.0.0').code(412).send();
  };
  const route = { ...session, preHandler: protocol };
  app.post(collection, route, async (request, reply) => {
    const target = parse(
      z.object({ tableId: TableId, fieldId: FieldId, recordId: RecordId }),
      request.params,
    );
    const length = integer(request.headers['upload-length']);
    const meta = metadata(request.headers['upload-metadata']);
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    const id = newId('attachment');
    const storage = app.ctx.config.filesStorage ?? 'postgres';
    await withTransaction(pool, async (db) => {
      await checkUploadTarget(app, request, db, target.tableId, target.fieldId, target.recordId);
      if (length > (await uploadLimit(db, schemas.app, actor.orgId))) throw tooLarge();
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'file_uploads')}
        (id, org_id, created_by, table_id, field_id, record_id, name, metadata, length, storage, completed)
        VALUES (${id}, ${actor.orgId}, ${actor.userId}, ${target.tableId}, ${target.fieldId}, ${target.recordId},
          ${meta.name ?? id}, ${meta.raw}, ${length}, ${storage}, ${length === 0})`,
      );
      if (length === 0)
        await finishUpload(
          db,
          schemas.app,
          app.ctx.config,
          { id, orgId: actor.orgId, userId: actor.userId, ...target, name: meta.name ?? id, storage },
          Readable.from([]),
        );
    }).catch(async (error: unknown) => {
      if (length === 0 && !storedInDatabase(storage)) {
        const store = fileStorage(storage, pool, schemas.app, app.ctx.config);
        await store.delete(id).catch(() => undefined);
      }
      throw error;
    });
    return reply.header('location', `/api/uploads/${id}`).code(201).send();
  });

  for (const transport of ['HEAD', 'PATCH', 'DELETE', 'POST'] as const)
    app.route({
      method: transport,
      url: resource,
      ...route,
      handler: async (request, reply) => {
        const method = request.headers['x-http-method-override'] ?? transport;
        if (!['HEAD', 'PATCH', 'DELETE'].includes(String(method))) return reply.code(405).send();
        const { attachmentId: id } = parse(z.object({ attachmentId: AttachmentId }), request.params);
        const actor = requireActor(request);
        if (method !== 'HEAD' && request.headers['x-csrf-token'] !== actor.csrfToken)
          throw new AppError('forbidden', 'errors.csrfMismatch');
        const { pool, schemas } = dataStore(app.ctx);
        const payload = request.body instanceof Readable ? request.body : Readable.from([]);
        let finishing: StorageKind | undefined;
        try {
          const status = await withTransaction(pool, async (db) => {
            const result = await query<Upload>(
              db,
              sql`SELECT * FROM ${ident(schemas.app, 'file_uploads')}
            WHERE id = ${id} AND org_id = ${actor.orgId} AND created_by = ${actor.userId}
              AND expires_at > now() FOR UPDATE`,
            );
            const upload = result.rows[0];
            if (!upload) throw missing();
            await checkUploadTarget(app, request, db, upload.table_id, upload.field_id, upload.record_id);
            if (method === 'DELETE') {
              await query(db, sql`DELETE FROM ${ident(schemas.app, 'file_uploads')} WHERE id = ${id}`);
              return 204;
            }
            let offset = Number(upload.offset_bytes);
            const length = Number(upload.length);
            if (method === 'HEAD') {
              reply.headers({
                'upload-offset': String(offset),
                'upload-length': String(length),
                ...(upload.metadata ? { 'upload-metadata': upload.metadata } : {}),
              });
              return 200;
            }
            const limit = await uploadLimit(db, schemas.app, actor.orgId);
            if (request.headers['content-type'] !== 'application/offset+octet-stream') return 415;
            if (integer(request.headers['upload-offset']) !== offset) return 409;
            if (Number(request.headers['content-length'] ?? 0) + offset > length || length > limit)
              throw tooLarge();
            for await (const value of payload.iterator({ destroyOnReturn: false })) {
              const bytes = value as Buffer;
              if (offset + bytes.length > length || offset + bytes.length > limit) throw tooLarge();
              for (let start = 0; start < bytes.length; start += 1024 * 1024) {
                const part = bytes.subarray(start, start + 1024 * 1024);
                await query(
                  db,
                  sql`INSERT INTO ${ident(schemas.app, 'file_upload_chunks')}
                (upload_id, offset_bytes, bytes) VALUES (${id}, ${offset}, ${part})`,
                );
                offset += part.length;
              }
            }
            if (offset === length && !upload.completed) {
              finishing = upload.storage;
              // A previous process may have stopped after writing an object but before committing metadata.
              const storage = fileStorage(upload.storage, db, schemas.app, app.ctx.config);
              if (!storedInDatabase(upload.storage))
                for (const key of [id, `${id}_small`, `${id}_large`]) await storage.delete(key);
              const source = Readable.from(
                (async function* () {
                  let position = 0;
                  while (position < length) {
                    const got = await query<{ bytes: Buffer }>(
                      db,
                      sql`SELECT bytes FROM ${ident(schemas.app, 'file_upload_chunks')}
                  WHERE upload_id = ${id} AND offset_bytes = ${position}`,
                    );
                    const bytes = got.rows[0]?.bytes;
                    if (!bytes?.length) throw new Error('Missing upload chunk');
                    position += bytes.length;
                    yield bytes;
                  }
                })(),
                { objectMode: false },
              );
              await finishUpload(
                db,
                schemas.app,
                app.ctx.config,
                {
                  id,
                  orgId: actor.orgId,
                  userId: actor.userId,
                  tableId: upload.table_id,
                  fieldId: upload.field_id,
                  name: upload.name,
                  storage: upload.storage,
                },
                source,
              );
              await query(
                db,
                sql`DELETE FROM ${ident(schemas.app, 'file_upload_chunks')} WHERE upload_id = ${id}`,
              );
            }
            await query(
              db,
              sql`UPDATE ${ident(schemas.app, 'file_uploads')}
            SET offset_bytes = ${offset}, completed = ${offset === length} WHERE id = ${id}`,
            );
            reply.header('upload-offset', String(offset));
            return 204;
          });
          return reply.code(status).send();
        } catch (error) {
          if (finishing && !storedInDatabase(finishing)) {
            const storage = fileStorage(finishing, pool, schemas.app, app.ctx.config);
            for (const key of [id, `${id}_small`, `${id}_large`])
              await storage.delete(key).catch(() => undefined);
          }
          throw error;
        } finally {
          payload.resume();
        }
      },
    });
}
