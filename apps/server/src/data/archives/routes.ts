import { promisify } from 'node:util';
import { gunzip as gunzipCallback } from 'node:zlib';
import {
  AppError,
  CopyJobId,
  DatabaseDuplicate,
  DatabaseId,
  isCopyDone,
  newId,
  OrgTemplateCreate,
  SnapshotCreate,
  SnapshotId,
  SnapshotRestore,
  SnapshotSettings,
  ARCHIVE_LIMITS,
  type DatabaseCopy,
  type SnapshotList,
  type SnapshotMeta,
  type TemplateSummary,
} from '@riosoma/contracts';
import { compile, ident, query, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { auditEvent } from '../../auth/database.js';
import { requireActor } from '../../auth/sessions.js';
import type { Actor } from '../../http/policy.js';
import { parse } from '../../http/validate.js';
import { AccessScope } from '../access.js';
import { LONG_DEADLINES } from '../commands/transaction.js';
import { dataStore } from '../context.js';
import { disposition } from '../files/detect.js';
import { archiveFileName } from '../export/filename.js';
import { DatabaseCopier } from './copier.js';
import { installSnapshotSchedule } from './schedule.js';
import {
  compress,
  decompress,
  countOrgTemplates,
  deleteOrgTemplate,
  deleteSnapshot,
  insertOrgTemplate,
  insertSnapshot,
  listSnapshots,
  loadSnapshot,
  loadSnapshotSettings,
  orgTemplateSummary,
  saveSnapshotSettings,
  snapshotBytes,
  snapshotMeta,
} from './store.js';
import { requireSnapshotRead, requireWholeRead, writeArchive } from './write.js';

const gunzip = promisify(gunzipCallback);

/** How long `?since=` waits for a copy to move on */
const WAIT_MS = 20_000;
const LOOK_AGAIN_MS = 2_000;

const session = { config: { policy: { kind: 'session' as const } } };
const DatabaseParams = z.object({ databaseId: DatabaseId });
const SnapshotParams = z.object({ snapshotId: SnapshotId });
const notFound = () => new AppError('not_found', 'errors.notFound');

/**
 * Organization admins: the owner, and anyone holding an administrator's role.  They save
 * templates for everyone and choose how automatic snapshots work.
 */
export function isOrgAdmin(actor: Actor): boolean {
  return actor.kind === 'owner' || actor.adminRoles.length > 0;
}

/**
 * Snapshots, restoring them, duplicating databases, saving databases as templates, and the
 * organization's settings for automatic snapshots.  See `packages/contracts/src/archives.ts`.
 * Every one of these needs the right to change the database's schema and to see all of it.
 */
export async function archiveRoutes(app: FastifyInstance): Promise<void> {
  const copier = new DatabaseCopier(app);
  app.ctx.databaseCopies = copier;
  installSnapshotSchedule(app);
  app.addHook('onReady', async () => {
    copier.start();
  });
  app.addHook('onClose', async () => {
    await copier.close();
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  const audit = () => compile(sql`${ident(dataStore(app.ctx).schemas.audit)}`).text;

  /** A snapshot, once the person has shown they may use it: its database's schema, and all of it. */
  async function snapshotFor(request: FastifyRequest) {
    const actor = requireActor(request);
    const { snapshotId } = parse(SnapshotParams, request.params);
    const { pool, schemas } = dataStore(app.ctx);
    const snapshot = await loadSnapshot(pool, schemas, snapshotId);
    if (!snapshot || snapshot.org_id !== actor.orgId) throw notFound();
    const bytes = await snapshotBytes(pool, schemas, snapshot.id);
    if (!bytes) throw notFound();
    await requireSnapshotRead(
      pool,
      schemas,
      new AccessScope(pool, schemas, actor),
      snapshot.database_id,
      await decompress(bytes),
    );
    return { actor, snapshot, bytes };
  }

  app.get('/api/databases/:databaseId/snapshots', session, async (request): Promise<SnapshotList> => {
    const actor = requireActor(request);
    const { databaseId } = parse(DatabaseParams, request.params);
    const { pool, schemas } = dataStore(app.ctx);
    await new AccessScope(pool, schemas, actor).require(databaseId, 'editSchema');
    return { snapshots: (await listSnapshots(pool, schemas, databaseId)).map(snapshotMeta) };
  });

  app.post('/api/databases/:databaseId/snapshots', session, async (request): Promise<SnapshotMeta> => {
    const actor = requireActor(request);
    const { databaseId } = parse(DatabaseParams, request.params);
    const { name } = parse(SnapshotCreate, request.body);
    const { pool, schemas } = dataStore(app.ctx);
    // Capture one consistent moment, then store it and its audit event against the current chain.
    const archive = await withTransaction(
      pool,
      async (db) => {
        await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
        const scope = new AccessScope(db, schemas, actor);
        await requireWholeRead(db, schemas, scope, databaseId, 'editSchema');
        return writeArchive(db, schemas, databaseId, { records: 'all', comments: true }, scope);
      },
      LONG_DEADLINES,
    );
    return withTransaction(
      pool,
      async (db) => {
        await requireWholeRead(db, schemas, new AccessScope(db, schemas, actor), databaseId, 'editSchema');
        const id = newId('snapshot');
        const row = (await insertSnapshot(db, schemas, {
          id,
          orgId: actor.orgId,
          databaseId,
          name,
          kind: 'manual',
          createdBy: actor.userId,
          archive,
          bytes: await compress(archive),
        }))!;
        await auditEvent(db, audit(), 'databases.snapshot.created', actor, {
          databaseId,
          snapshotId: id,
          tables: row.tables,
          records: Number(row.records),
          size: Number(row.size),
        });
        return snapshotMeta(row);
      },
      LONG_DEADLINES,
    );
  });

  app.get('/api/snapshots/:snapshotId/download', session, async (request, reply) => {
    const { actor, snapshot, bytes } = await snapshotFor(request);
    const { pool, schemas } = dataStore(app.ctx);
    await new AccessScope(pool, schemas, actor).requireUse(snapshot.database_id, 'export');
    await auditEvent(pool, audit(), 'databases.snapshot.downloaded', actor, {
      databaseId: snapshot.database_id,
      snapshotId: snapshot.id,
    });
    const database = await query<{ name: string }>(
      pool,
      sql`SELECT name FROM ${ident(schemas.app, 'databases')} WHERE id = ${snapshot.database_id}`,
    );
    const day = snapshot.created_at.toISOString().slice(0, 10);
    const name = archiveFileName(database.rows[0]?.name ?? '', snapshot.name || day);
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.header('content-disposition', disposition('application/json', name));
    reply.header('x-content-type-options', 'nosniff');
    // The archive is stored compressed.  A client that takes gzip gets those bytes as they are.
    const accepts = /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''));
    if (accepts) {
      reply.header('content-encoding', 'gzip');
      reply.header('vary', 'accept-encoding');
      return reply.send(bytes);
    }
    return reply.send(await gunzip(bytes));
  });

  app.post('/api/snapshots/:snapshotId/restore', session, async (request): Promise<DatabaseCopy> => {
    const actor = requireActor(request);
    const { snapshotId } = parse(SnapshotParams, request.params);
    const { name } = parse(SnapshotRestore, request.body);
    return copier.begin(actor, { kind: 'snapshot', snapshotId, name });
  });

  app.delete('/api/snapshots/:snapshotId', session, async (request) => {
    const actor = requireActor(request);
    const { snapshotId } = parse(SnapshotParams, request.params);
    const { pool, schemas } = dataStore(app.ctx);
    return withTransaction(pool, async (db) => {
      const snapshot = await loadSnapshot(db, schemas, snapshotId);
      if (!snapshot || snapshot.org_id !== actor.orgId) throw notFound();
      const bytes = await snapshotBytes(db, schemas, snapshot.id);
      if (!bytes) throw notFound();
      await requireSnapshotRead(
        db,
        schemas,
        new AccessScope(db, schemas, actor),
        snapshot.database_id,
        await decompress(bytes),
      );
      await deleteSnapshot(db, schemas, snapshotId);
      await auditEvent(db, audit(), 'databases.snapshot.deleted', actor, {
        databaseId: snapshot.database_id,
        snapshotId,
        kind: snapshot.kind,
      });
      return { deleted: true };
    });
  });

  app.post('/api/databases/:databaseId/duplicate', session, async (request): Promise<DatabaseCopy> => {
    const actor = requireActor(request);
    const { databaseId } = parse(DatabaseParams, request.params);
    const input = parse(DatabaseDuplicate, request.body);
    return copier.begin(actor, { kind: 'duplicate', databaseId, ...input });
  });

  app.get('/api/database-copies/:copyId', session, async (request, reply): Promise<DatabaseCopy> => {
    const actor = requireActor(request);
    const { copyId } = parse(z.object({ copyId: CopyJobId }), request.params);
    const { since } = parse(z.object({ since: z.coerce.number().int().min(0).optional() }), request.query);
    let copy = await copier.visible(actor, copyId);
    if (since === undefined || copy.version > since || isCopyDone(copy.state)) return copy;
    const closed = new AbortController();
    reply.raw.once('close', () => closed.abort());
    const deadline = Date.now() + WAIT_MS;
    while (copy.version <= since && !isCopyDone(copy.state) && !closed.signal.aborted) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      await copier.changed(copyId, Math.min(LOOK_AGAIN_MS, left), closed.signal);
      copy = await copier.visible(actor, copyId);
    }
    return copy;
  });

  app.post(
    '/api/databases/:databaseId/save-as-template',
    session,
    async (request): Promise<TemplateSummary> => {
      const actor = requireActor(request);
      if (!isOrgAdmin(actor)) throw new AppError('forbidden', 'errors.adminOnly');
      const { databaseId } = parse(DatabaseParams, request.params);
      const input = parse(OrgTemplateCreate, request.body);
      const { pool, schemas } = dataStore(app.ctx);
      const archive = await withTransaction(
        pool,
        async (db) => {
          await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
          const scope = new AccessScope(db, schemas, actor);
          await requireWholeRead(db, schemas, scope, databaseId, 'editSchema');
          if (await scope.hasRules(databaseId))
            throw new AppError('forbidden', 'data.access.templateRestricted');
          return writeArchive(
            db,
            schemas,
            databaseId,
            {
              records: input.samples ? { samples: input.samples } : 'none',
              comments: false,
            },
            scope,
          );
        },
        LONG_DEADLINES,
      );
      return withTransaction(
        pool,
        async (db) => {
          const scope = new AccessScope(db, schemas, actor);
          await requireWholeRead(db, schemas, scope, databaseId, 'editSchema');
          // Everyone in the organization can start from a template, whatever the rules let them
          // see here, so a database with field or record rules can't become one.
          if (await scope.hasRules(databaseId))
            throw new AppError('forbidden', 'data.access.templateRestricted');
          if ((await countOrgTemplates(db, schemas, actor.orgId)) >= ARCHIVE_LIMITS.templates)
            throw new AppError('validation_failed', 'archives.templates.tooMany', {
              params: { max: ARCHIVE_LIMITS.templates },
            });
          const id = newId('template');
          const row = await insertOrgTemplate(db, schemas, {
            id,
            orgId: actor.orgId,
            name: input.name,
            description: input.description,
            category: input.category,
            samples: input.samples,
            sourceDatabaseId: databaseId,
            createdBy: actor.userId,
            archive,
            bytes: await compress(archive),
          });
          await auditEvent(db, audit(), 'templates.saved', actor, {
            templateId: id,
            databaseId,
            samples: input.samples,
          });
          return orgTemplateSummary(row);
        },
        LONG_DEADLINES,
      );
    },
  );

  app.delete('/api/templates/:templateId', session, async (request) => {
    const actor = requireActor(request);
    if (!isOrgAdmin(actor)) throw new AppError('forbidden', 'errors.adminOnly');
    const { templateId } = parse(
      z.object({ templateId: z.string().regex(/^tpl[0-9A-Za-z]{14}$/) }),
      request.params,
    );
    const { pool, schemas } = dataStore(app.ctx);
    return withTransaction(pool, async (db) => {
      if (!(await deleteOrgTemplate(db, schemas, templateId, actor.orgId))) throw notFound();
      await auditEvent(db, audit(), 'templates.removed', actor, { templateId });
      return { deleted: true };
    });
  });

  app.get('/api/settings/snapshots', session, async (request): Promise<SnapshotSettings> => {
    const actor = requireActor(request);
    if (!isOrgAdmin(actor)) throw new AppError('forbidden', 'errors.adminOnly');
    const { pool, schemas } = dataStore(app.ctx);
    return loadSnapshotSettings(pool, schemas, actor.orgId);
  });

  app.put('/api/settings/snapshots', session, async (request): Promise<SnapshotSettings> => {
    const actor = requireActor(request);
    if (!isOrgAdmin(actor)) throw new AppError('forbidden', 'errors.adminOnly');
    const settings = parse(SnapshotSettings.strict(), request.body);
    const { pool, schemas } = dataStore(app.ctx);
    return withTransaction(pool, async (db) => {
      await saveSnapshotSettings(db, schemas, actor.orgId, settings);
      await auditEvent(db, audit(), 'settings.snapshots.changed', actor, settings);
      return settings;
    });
  });
}
