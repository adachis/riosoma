import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  IngestOriginalCommand,
  IngestOrganizationCommand,
  TableId,
  TOKEN_SCOPES,
  roleAllows,
} from '@riosoma/contracts';
import { compile, ident, query, sql } from '@riosoma/db';
import { auditEvent } from '../../auth/database.js';
import { requireActor } from '../../auth/sessions.js';
import { authenticateToken } from '../../auth/tokens.js';
import { actorFor } from '../../automations/run.js';
import { AccessScope } from '../../data/access.js';
import { dataStore } from '../../data/context.js';
import { blockTableId } from '../../data/interfaces/config.js';
import { loadFields, loadTable } from '../../data/metadata.js';
import type { OriginalRow } from '../../data/files/originals.js';
import { loadLiveShare, passAccepted, passCookieName, sharedRead } from '../../data/shared-view-reads.js';
import { publicSharingPolicy } from '../../data/public-sharing.js';
import { isDemoRequest, refuseDemo } from '../../demo/boundary.js';
import type { Actor } from '../../http/policy.js';
import { parse } from '../../http/validate.js';
import { liveSite } from '../../sites/store.js';
import { IngestTableStore } from '../tables/store.js';
import { runIngestOrganizationCommand, runOriginalCommand } from './commands.js';
import { downloadOriginal } from './download.js';
import { installOriginalSweep, organizationIngest } from './retention.js';

const notFound = () => new AppError('not_found', 'errors.notFound');
const FileParams = z.object({ tableId: TableId, fileId: z.string().min(1).max(200) });
const session = { config: { policy: { kind: 'session' as const, beforeBody: true as const } } };
const open = { config: { policy: { kind: 'public' as const } } };

/** Public share doors and authenticated doors never consult each other's switches. */
export async function originalRoutes(app: FastifyInstance) {
  installOriginalSweep(app);
  const { ctx } = app;
  const read = async (request: FastifyRequest, target: { kind: 'view' | 'site'; id: string } | null) => {
    const { pool, schemas } = dataStore(ctx);
    let actor: Actor | null = null;
    let orgId: string | null = null;
    let tableId = '';
    const params = parse(z.object({ fileId: z.string().min(1).max(200) }), request.params);
    let outcome = 'refused';
    try {
      const routeTable = (request.params as { tableId?: string }).tableId;
      if (routeTable) {
        tableId = routeTable;
        const table = await loadTable(pool, schemas, tableId);
        orgId = table?.orgId ?? null;
      } else if (target?.kind === 'view') {
        const share = await query<{ org_id: string; table_id: string }>(
          pool,
          sql`SELECT s.org_id, v.table_id FROM ${ident(schemas.app, 'shared_views')} s
          JOIN ${ident(schemas.app, 'views')} v ON v.id = s.view_id WHERE s.id = ${target.id}`,
        );
        orgId = share.rows[0]?.org_id ?? null;
        tableId = share.rows[0]?.table_id ?? '';
      }
      if (request.customDomain && !target) throw notFound();
      // Resolve a valid token before checking its record scope so scope refusals are audited too.
      actor = request.headers.authorization
        ? await authenticateToken(ctx, request, TOKEN_SCOPES)
        : await ctx.sessions.resolve(request);
      request.actor = actor;
      refuseDemo(actor ?? undefined);
      orgId ??= actor?.orgId ?? null;
      if (target && orgId && !(await publicSharingPolicy(pool, schemas, orgId)).publicFiles) throw notFound();
      if (target?.kind === 'view') {
        const live = await loadLiveShare(pool, schemas, target.id);
        orgId = live.orgId;
        tableId = live.table.id;
        const switchRow = await query<{ originals_access: boolean }>(
          pool,
          sql`SELECT originals_access FROM ${ident(schemas.app, 'shared_views')} WHERE id = ${live.id}`,
        );
        if (
          !switchRow.rows[0]?.originals_access ||
          (live.passwordHash &&
            !passAccepted(
              ctx.config.secretKey,
              live.id,
              live.passwordHash,
              request.customDomain
                ? (request.headers['x-public-view-pass'] as string | undefined)
                : request.cookies[passCookieName(live.id)],
            ))
        )
          throw notFound();
        await sharedRead(pool, schemas, live);
        actor = live.createdBy ? await actorFor(pool, schemas, live.createdBy, live.orgId) : null;
        if (!actor) throw notFound();
        const scope = new AccessScope(pool, schemas, actor);
        await scope.requireUse(live.databaseId, 'public', { tableId });
        await scope.requireUse(live.databaseId, 'export', { tableId });
      } else if (target?.kind === 'site') {
        const live = await liveSite(pool, schemas, target.id, request.customDomain?.id);
        orgId = live.row.org_id;
        const parsed = parse(FileParams, request.params);
        tableId = parsed.tableId;
        const switchRow = await query<{ originals_access: boolean }>(
          pool,
          sql`SELECT originals_access FROM ${ident(schemas.app, 'published_sites')} WHERE slug = ${live.row.slug}`,
        );
        if (
          !switchRow.rows[0]?.originals_access ||
          !live.pages.some((page) => page.blocks.some((block) => blockTableId(block, page) === tableId))
        )
          throw notFound();
        await live.scope.requireUse(live.row.database_id, 'public', { tableId });
        await live.scope.requireUse(live.row.database_id, 'export', { tableId });
      } else {
        tableId = parse(FileParams, request.params).tableId;
        if (!actor || (actor.token && !actor.token.scopes.includes('data.records:read'))) throw notFound();
        const table = await loadTable(pool, schemas, tableId);
        if (!table || table.orgId !== actor.orgId || table.trashed || !table.ingest) throw notFound();
        const scope = new AccessScope(pool, schemas, actor);
        const role = await scope.require(table.databaseId, 'read');
        const fields = await loadFields(pool, schemas, [tableId], { includeTrashed: true });
        const partial =
          scope.limitsRecords(tableId) || scope.visibleFields(tableId, fields).length !== fields.length;
        if ((!roleAllows(role, 'editRecords') || partial) && !table.ingest.originals.readOnlyAccess)
          throw notFound();
        await scope.requireUse(table.databaseId, 'export', { tableId });
        await scope.requireMachineUse(table.databaseId, tableId);
      }
      const table = await loadTable(pool, schemas, tableId);
      if (!table || table.orgId !== orgId || table.trashed || !table.ingest) throw notFound();
      const file = await new IngestTableStore(pool, schemas).readFile(
        { orgId: orgId!, tableId },
        params.fileId,
      );
      if (!file) throw notFound();
      if (
        file.originalExpiredAt ||
        (!file.isExample && file.expiresAt && Date.parse(file.expiresAt) <= Date.now())
      ) {
        outcome = 'expired';
        return {
          expired: {
            outcome: 'expired' as const,
            tableId,
            fileId: file.id,
            messageId: 'ingest.pipeline.originalExpired' as const,
          },
        };
      }
      const found = await query<OriginalRow & { name: string }>(
        pool,
        sql`SELECT * FROM ${ident(schemas.app, 'files')} WHERE id = ${file.storedFile}
        AND org_id = ${orgId} AND table_id = ${tableId} AND ingest_file_id = ${file.id}
        AND field_id IS NULL AND scan_state = 'clean'`,
      );
      if (!found.rows[0]) throw notFound();
      outcome = 'allowed';
      return { file: found.rows[0] };
    } catch (error) {
      if (error instanceof AppError && error.messageKey === 'demo.readOnly') throw error;
      if (error instanceof AppError) throw notFound();
      throw error;
    } finally {
      if (orgId && !actor?.demo && !isDemoRequest())
        await auditEvent(
          pool,
          compile(sql`${ident(schemas.audit)}`).text,
          'data.ingest.original.opened',
          { orgId, userId: request.actor?.orgId === orgId ? request.actor.userId : null },
          { tableId, fileId: params.fileId, outcome, ...(target ? { share: target } : {}) },
        );
    }
  };
  // Authentication is resolved here because this door accepts sessions and scoped tokens, and
  // every refusal must have the same body and audit as a missing original.
  const serve = async (
    request: FastifyRequest,
    reply: FastifyReply,
    target: { kind: 'view' | 'site'; id: string } | null,
  ) => {
    try {
      const result = await read(request, target);
      if (result.expired) {
        if (target) throw notFound();
        return reply.code(410).header('cache-control', 'no-store').send(result.expired);
      }
      return downloadOriginal(app, request, reply, result.file!);
    } catch (error) {
      // Missing and inaccessible originals have the same refusal body.
      if (error instanceof AppError && error.messageKey === 'errors.notFound')
        return reply.code(404).header('cache-control', 'no-store').send(notFound().toBody());
      throw error;
    }
  };
  app.get('/api/tables/:tableId/ingest/files/:fileId/original', open, (request, reply) =>
    serve(request, reply, null),
  );
  app.get('/api/public/views/:linkId/ingest/files/:fileId/original', open, async (request, reply) => {
    const { linkId } = parse(z.object({ linkId: z.string().min(1).max(200) }), request.params);
    return serve(request, reply, { kind: 'view', id: linkId });
  });
  app.get(
    '/api/public/sites/:slug/tables/:tableId/ingest/files/:fileId/original',
    open,
    async (request, reply) => {
      const { slug } = parse(z.object({ slug: z.string().min(1).max(200) }), request.params);
      return serve(request, reply, { kind: 'site', id: slug });
    },
  );
  app.post('/api/tables/:tableId/ingest/originals/commands', session, async (request) => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    return runOriginalCommand(
      app,
      requireActor(request),
      tableId,
      parse(IngestOriginalCommand, request.body),
    );
  });
  const admin = {
    config: {
      policy: {
        kind: 'admin' as const,
        area: 'security' as const,
        scope: 'organization' as const,
        beforeBody: true as const,
      },
    },
  };
  app.get('/api/org/ingest', admin, async (request) => {
    const actor = requireActor(request);
    refuseDemo(actor);
    const { pool, schemas } = dataStore(ctx);
    return organizationIngest(pool, schemas, actor.orgId);
  });
  app.post('/api/org/ingest/commands', admin, async (request) =>
    runIngestOrganizationCommand(app, requireActor(request), parse(IngestOrganizationCommand, request.body)),
  );
}
