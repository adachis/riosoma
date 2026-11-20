import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../auth/sessions.js';
import { parse } from '../http/validate.js';
import { CredentialCommand } from '@riosoma/contracts';
import { CredentialStore } from '../data/credentials/store.js';

export async function credentialRoutes(app: FastifyInstance) {
  const store = new CredentialStore(app.ctx);
  const unregister = store.service.register();
  const admin = { config: { policy: { kind: 'admin', area: 'security', scope: 'organization' } } } as const;
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'private, no-store');
  });
  app.get('/api/admin/credentials', admin, async (request) => store.status(requireActor(request)));
  app.get('/api/admin/credentials/preview', admin, async (request) => {
    const { profile } = parse(z.object({ profile: z.string().min(1).max(200) }), request.query);
    return store.preview(requireActor(request), profile);
  });
  app.post('/api/admin/credentials/commands', admin, async (request) => {
    const actor = requireActor(request);
    await store.command(actor, parse(CredentialCommand, request.body));
    return store.status(actor);
  });
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let initialized = false;
  const tick = () => {
    if (running || !app.ctx.pool || !app.ctx.config.database) return;
    running = (async () => {
      if (!initialized) {
        await store.initialize();
        initialized = true;
      }
      await store.tick();
    })()
      .catch(() => {})
      .finally(() => {
        running = undefined;
      });
  };
  app.addHook('onReady', async () => {
    const interval = app.ctx.config.credentialPollMs ?? 1000;
    if (interval === 0) return;
    tick();
    timer = setInterval(tick, interval);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await running;
    await store.service.drain();
    unregister();
  });
}
