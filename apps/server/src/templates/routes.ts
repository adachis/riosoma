import { createDatabase } from '../data/commands/database-create.js';
import { AccessScope } from '../data/access.js';
import { AppError, DatabaseId, Name, newId, OrgTemplateId, type TemplateSummary } from '@riosoma/contracts';
import { compile, ident, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditEvent } from '../auth/database.js';
import { requireActor } from '../auth/sessions.js';
import { restoreArchive } from '../data/archives/restore.js';
import {
  decompress,
  listOrgTemplates,
  orgTemplateBytes,
  orgTemplateSummary,
} from '../data/archives/store.js';
import type { Actor } from '../http/policy.js';
import { lock, LONG_DEADLINES, retry, userError } from '../data/commands/transaction.js';
import { dataStore } from '../data/context.js';
import { loadDatabase, loadSchema } from '../data/metadata.js';
import { parse } from '../http/validate.js';
import { templates } from './index.js';
import { instantiate } from './instantiate.js';

const Create = z.object({ id: DatabaseId, templateId: z.string().min(1).max(100), name: Name.optional() });

export async function templateRoutes(app: FastifyInstance): Promise<void> {
  /**
   * A database from one of the organization's own templates: its archive restored under new IDs,
   * with its automations off.  Asking again with the same ID answers the database already made.
   */
  async function fromOrgTemplate(actor: Actor, input: z.infer<typeof Create>) {
    const { pool, schemas } = dataStore(app.ctx);
    const secretKey = app.ctx.config.secretKey;
    const existing = await loadDatabase(pool, schemas, input.id);
    if (existing) {
      if (existing.orgId !== actor.orgId || existing.createdBy !== actor.userId)
        throw new AppError('conflict', 'errors.conflict');
      return loadSchema(pool, schemas, input.id, 'owner', {
        secretKey,
        scope: new AccessScope(pool, schemas, actor),
      });
    }
    const stored = await orgTemplateBytes(pool, schemas, input.templateId, actor.orgId);
    if (!stored) throw new AppError('not_found', 'errors.notFound');
    const archive = await decompress(stored.bytes);
    try {
      await restoreArchive(app.ctx, actor, {
        archive,
        sourceDatabaseId: stored.row.source_database_id ?? undefined,
        databaseId: input.id,
        name: input.name ?? stored.row.name,
      });
    } catch (error) {
      // Two tries with one ID race to make it, and the one that loses answers what the other made.
      if (
        error instanceof AppError &&
        error.code === 'unavailable' &&
        (await loadDatabase(pool, schemas, input.id))
      )
        return loadSchema(pool, schemas, input.id, 'owner', {
          secretKey,
          scope: new AccessScope(pool, schemas, actor),
        });
      throw error;
    }
    await auditEvent(pool, compile(sql`${ident(schemas.audit)}`).text, 'templates.used', actor, {
      templateId: input.templateId,
      databaseId: input.id,
    });
    return loadSchema(pool, schemas, input.id, 'owner', {
      secretKey,
      scope: new AccessScope(pool, schemas, actor),
    });
  }

  const session = { config: { policy: { kind: 'session' as const } } };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  app.get('/api/templates', session, async (request): Promise<TemplateSummary[]> => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(app.ctx);
    // The organization's own templates come first, newest first, then the ones Riosoma comes with.
    const own = actor.kind === 'guest' ? [] : await listOrgTemplates(pool, schemas, actor.orgId);
    return [
      ...own.map(orgTemplateSummary),
      ...templates.map(({ id, name, description, icon, color, category, tables }) => ({
        id,
        name,
        description,
        icon,
        color,
        category,
        tables: tables.map((table) => table.name),
      })),
    ];
  });
  app.post('/api/databases/from-template', session, async (request) => {
    const actor = requireActor(request);
    if (actor.kind === 'guest') throw new AppError('forbidden', 'data.access.denied');
    const input = parse(Create, request.body);
    if (OrgTemplateId.safeParse(input.templateId).success) return fromOrgTemplate(actor, input);
    const template = templates.find((value) => value.id === input.templateId);
    if (!template) throw new AppError('not_found', 'errors.notFound');
    const { pool, schemas } = dataStore(app.ctx);
    const now = new Date();
    return retry(() =>
      withTransaction(
        pool,
        async (db) => {
          // Automations need the instance key, which seals their webhook secrets.
          const secretKey = app.ctx.config.secretKey;
          const c = { secretKey, db, schemas, actor, databaseId: input.id };
          await lock(c, [`database:${input.id}`]);
          const existing = await loadDatabase(db, schemas, input.id);
          if (existing) {
            if (existing.orgId !== actor.orgId || existing.createdBy !== actor.userId)
              throw new AppError('conflict', 'errors.conflict');
            return loadSchema(db, schemas, input.id, 'owner', {
              secretKey,
              scope: new AccessScope(db, schemas, actor),
            });
          }
          try {
            const groupId = newId('action');
            await createDatabase(
              c,
              {
                id: input.id,
                name: input.name ?? template.name,
                icon: template.icon,
                color: template.color,
                folderId: null,
              },
              groupId,
            );
            await instantiate(c, groupId, template, now);
            return loadSchema(db, schemas, input.id, 'owner', {
              secretKey,
              scope: new AccessScope(db, schemas, actor),
            });
          } catch (error) {
            throw userError(error) ?? error;
          }
        },
        LONG_DEADLINES,
      ),
    );
  });
}
