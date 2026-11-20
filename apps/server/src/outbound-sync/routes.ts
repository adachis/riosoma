import {
  AppError,
  DESTINATION_KINDS,
  DestinationLookup,
  SYNC_OUT_LIMITS,
  SyncOutCommand,
  SyncOutDatabaseParams,
  SyncOutParams,
  SyncOutPreviewRequest,
  SyncOutViewParams,
  roleAllows,
  type DestinationPlaces,
  type SyncOutPreview,
  type SyncOutRuns,
  type ViewSyncOut,
} from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import { requireActor } from '../auth/sessions.js';
import { AccessScope } from '../data/access.js';
import { dataStore } from '../data/context.js';
import { loadTable, loadView } from '../data/metadata.js';
import { parse } from '../http/validate.js';
import { policyAllows, requirePolicy } from '../org-units/policy.js';
import { readsLive } from '../sources/live.js';
import { runSyncOutCommand } from './commands.js';
import { DestinationError, destinationFor } from './destination.js';
import { syncOutPreview } from './preview.js';
import { loadSync, runActors, syncRuns, syncViewer, toOutboundSync, toRun, viewSyncs } from './store.js';

/**
 * The routes the contract names.  Every one is a session route with `cache-control: no-store`, and
 * a person who can't read the database gets `not_found`.  The places and preview routes take a
 * token in the body, answer no part of it, and never log it.
 */

const notFound = () => new AppError('not_found', 'errors.notFound');

/** Turns a destination refusal into the HTTP error the web app expects. */
function destinationError(error: unknown): AppError {
  if (!(error instanceof DestinationError))
    return error instanceof AppError ? error : new AppError('unavailable', 'syncOut.destination.unavailable');
  const { problem } = error;
  const code = problem.scope === 'run' ? 'unavailable' : 'validation_failed';
  const token = problem.messageKey.endsWith('.token');
  return new AppError(code, problem.messageKey, {
    ...(problem.params ? { params: problem.params } : {}),
    ...(token ? { fields: { token: problem.messageKey } } : {}),
  });
}

export async function outboundSyncRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const session = { config: { policy: { kind: 'session' as const } } };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  const policyOn = (orgId: string, userId: string) =>
    policyAllows(
      dataStore(ctx).pool,
      `"${dataStore(ctx).schemas.app}"`,
      { orgId, userId },
      'syncOut',
      'externalSharing',
    );

  app.get('/api/views/:viewId/sync-out', session, async (request): Promise<ViewSyncOut> => {
    const { viewId } = parse(SyncOutViewParams, request.params);
    const { pool, schemas } = dataStore(ctx);
    const actor = requireActor(request);
    const scope = new AccessScope(pool, schemas, actor);
    const view = await loadView(pool, schemas, viewId);
    if (!view || view.trashed) throw notFound();
    const role = await scope.require(view.databaseId, 'read');
    const canChangeView = roleAllows(role, 'editSchema');

    const rows = canChangeView ? await viewSyncs(pool, schemas, viewId) : [];
    const syncs = [];
    for (const row of rows)
      syncs.push(toOutboundSync(row, await syncViewer(pool, schemas, scope, row, role)));

    let unavailable: string | null = null;
    if (!canChangeView) unavailable = 'syncOut.unavailable.role';
    else if (actor.kind === 'guest') unavailable = 'syncOut.unavailable.guest';
    else if (!(await policyOn(actor.orgId, actor.userId))) unavailable = 'syncOut.unavailable.policy';
    else if (view.view.type === 'form' || view.view.type === 'chart' || view.view.type === 'pivot')
      unavailable = 'syncOut.unavailable.viewType';
    else {
      const table = await loadTable(pool, schemas, view.view.tableId);
      if (table && readsLive(table)) unavailable = 'syncOut.unavailable.live';
    }

    return {
      syncs,
      canCreate: !unavailable && rows.length < SYNC_OUT_LIMITS.perView,
      unavailable,
      kinds: DESTINATION_KINDS.filter((kind) => destinationFor(kind)),
    };
  });

  app.post('/api/views/:viewId/sync-out/places', session, async (request): Promise<DestinationPlaces> => {
    const { viewId } = parse(SyncOutViewParams, request.params);
    const lookup = parse(DestinationLookup, request.body);
    const { pool, schemas } = dataStore(ctx);
    const actor = requireActor(request);
    const scope = new AccessScope(pool, schemas, actor);
    const view = await loadView(pool, schemas, viewId);
    if (!view || view.trashed) throw notFound();
    await scope.require(view.databaseId, 'editSchema');
    await requirePolicy(pool, `"${schemas.app}"`, actor, 'syncOut', 'externalSharing');
    const adapter = destinationFor(lookup.kind);
    if (!adapter) throw new AppError('validation_failed', 'syncOut.destination.unknownKind');
    try {
      const context = ctx.outboundSyncs!.context(
        adapter,
        lookup,
        lookup.credential,
        AbortSignal.timeout(60_000),
      );
      return await adapter.places(context, lookup as never);
    } catch (error) {
      throw destinationError(error);
    }
  });

  app.post('/api/views/:viewId/sync-out/preview', session, async (request): Promise<SyncOutPreview> => {
    const { viewId } = parse(SyncOutViewParams, request.params);
    const body = parse(SyncOutPreviewRequest, request.body);
    const { pool, schemas } = dataStore(ctx);
    const actor = requireActor(request);
    const scope = new AccessScope(pool, schemas, actor);
    const view = await loadView(pool, schemas, viewId);
    if (!view || view.trashed) throw notFound();
    await scope.require(view.databaseId, 'editSchema');
    await requirePolicy(pool, `"${schemas.app}"`, actor, 'syncOut', 'externalSharing');
    try {
      return await syncOutPreview(ctx.outboundSyncs!, actor, viewId, body);
    } catch (error) {
      throw destinationError(error);
    }
  });

  app.post('/api/databases/:databaseId/sync-out/commands', session, async (request) => {
    const { databaseId } = parse(SyncOutDatabaseParams, request.params);
    const command = parse(SyncOutCommand, request.body);
    return runSyncOutCommand(app, requireActor(request), databaseId, command);
  });

  app.get('/api/sync-out/:syncId/runs', session, async (request): Promise<SyncOutRuns> => {
    const { syncId } = parse(SyncOutParams, request.params);
    const { pool, schemas } = dataStore(ctx);
    const actor = requireActor(request);
    const scope = new AccessScope(pool, schemas, actor);
    const sync = await loadSync(pool, schemas, syncId);
    if (!sync || sync.org_id !== actor.orgId) throw notFound();
    const role = await scope.databaseRole(sync.database_id);
    if (!roleAllows(role, 'editSchema')) throw notFound();
    await scope.prepare(sync.database_id);
    const viewer = await syncViewer(pool, schemas, scope, sync, role);
    const runs = await syncRuns(pool, schemas, syncId, SYNC_OUT_LIMITS.runsKept);
    const names = await runActors(pool, schemas, runs);
    return { runs: runs.map((run) => toRun(run, viewer, names)) };
  });
}
