import { AppError, TelemetryChoice, UpdateApply } from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import { requireActor } from '../auth/sessions.js';
import { ADMIN_AREAS } from '../http/policy.js';
import { parse } from '../http/validate.js';
import { Telemetry } from '../telemetry/service.js';
import { runsServer, Updates } from './service.js';

/**
 * Update notices, the updater, and usage counts.  They're about the server, not any one area of
 * the organization, so any organization admin of the organization that set the server up may look,
 * and the handlers keep what changes the server to its owner.  Unit admins never reach them.
 */
export async function updateRoutes(app: FastifyInstance): Promise<void> {
  const updates = new Updates(app);
  const telemetry = new Telemetry(app);
  app.ctx.updates = updates;
  app.ctx.telemetry = telemetry;
  const admin = {
    config: { policy: { kind: 'admin' as const, area: ADMIN_AREAS, scope: 'organization' as const } },
  };
  const serverAdmin = async (request: Parameters<typeof requireActor>[0]) => {
    const actor = requireActor(request);
    if (!(await runsServer(app.ctx, actor))) throw new AppError('forbidden', 'updates.serverOnly');
    return actor;
  };

  let running: Promise<unknown> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const tick = () => {
    if (running || !app.ctx.pool || !app.ctx.config.database) return;
    running = Promise.allSettled([updates.tick(), telemetry.tick()])
      .then((results) => {
        for (const result of results)
          if (result.status === 'rejected')
            app.log.warn({ err: result.reason }, 'update check or usage count failed');
      })
      .finally(() => {
        running = undefined;
      });
  };
  app.addHook('onReady', async () => {
    const every = app.ctx.config.updatesPollMs ?? 60 * 60_000;
    if (every === 0) return;
    tick();
    timer = setInterval(tick, every);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    updates.close();
    await running;
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'private, no-store');
  });

  app.get('/api/admin/updates', admin, async (request) => {
    const actor = await serverAdmin(request);
    await updates.reconcile();
    return updates.status(actor);
  });
  app.post('/api/admin/updates/check', admin, async (request) => {
    const actor = await serverAdmin(request);
    await updates.check('person', actor);
    return updates.status(actor);
  });
  app.post('/api/admin/updates/apply', admin, async (request) => {
    const actor = await serverAdmin(request);
    const { version } = parse(UpdateApply, request.body);
    await updates.apply(actor, version);
    return updates.status(actor);
  });

  app.get('/api/admin/telemetry', admin, async (request) => telemetry.status(await serverAdmin(request)));
  app.put('/api/admin/telemetry', admin, async (request) => {
    const actor = await serverAdmin(request);
    return telemetry.choose(actor, parse(TelemetryChoice, request.body).enabled);
  });
  app.post('/api/admin/telemetry/install-id', admin, async (request) =>
    telemetry.resetInstallId(await serverAdmin(request)),
  );
}
