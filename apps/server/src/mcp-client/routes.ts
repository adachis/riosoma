import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { RemoteServerCommand } from '@riosoma/contracts';
import { requireActor } from '../auth/sessions.js';
import { serverOrigin } from '../auth/sso/store.js';
import { parse } from '../http/validate.js';
import { remoteTools } from '../data/remote-tools.js';

export async function remoteToolRoutes(app: FastifyInstance) {
  const store = remoteTools(app);
  const admin = { config: { policy: { kind: 'admin', area: 'ai', scope: 'organization' } } } as const;
  const session = { config: { policy: { kind: 'session' } } } as const;
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'private, no-store');
  });
  app.get('/api/admin/remote-tools/audiences', admin, (request) =>
    store.audienceChoices(requireActor(request)),
  );
  app.get('/api/admin/remote-tools', admin, (request) => store.list(requireActor(request), true));
  app.post('/api/admin/remote-tools/commands', admin, async (request) => {
    const command = parse(RemoteServerCommand, request.body);
    const actor = requireActor(request);
    if (command.kind === 'remote.authorize')
      return store.authorize(
        actor,
        command.serverId,
        `${serverOrigin(app.ctx, request)}/api/admin/remote-tools/oauth/${command.serverId}/callback`,
        command.id,
      );
    return store.command(actor, command);
  });
  app.get('/api/admin/remote-tools/oauth/:serverId/callback', admin, async (request, reply) => {
    const { serverId } = parse(z.object({ serverId: z.string().uuid() }), request.params);
    const { state, code, error } = parse(
      z
        .object({
          state: z.string().uuid(),
          code: z.string().min(1).max(4000).optional(),
          error: z.string().min(1).max(200).optional(),
        })
        .refine((value) => Boolean(value.code) !== Boolean(value.error)),
      request.query,
    );
    await store.finishAuthorization(requireActor(request), serverId, state, code ?? null);
    const outcome = error ? `&connectionError=${error === 'access_denied' ? 'denied' : 'failed'}` : '';
    return reply.redirect(`/settings/ai?tab=tools&server=${serverId}${outcome}`);
  });
  app.post('/api/rio/conversations/:conversationId/remote-tools', session, async (request) => {
    const { conversationId } = parse(z.object({ conversationId: z.string().uuid() }), request.params);
    return store.call(requireActor(request), request.body, conversationId);
  });
  app.get('/api/remote-tools', session, (request) => store.catalog(requireActor(request)));
  app.get(
    '/api/v1/remote-tools',
    { config: { policy: { kind: 'token', scope: 'data.records:read' } } },
    (request) => store.catalog(requireActor(request)),
  );
  app.get('/api/rio/remote-approvals/:id', session, (request) =>
    store.approval(requireActor(request), parse(z.object({ id: z.string().uuid() }), request.params).id),
  );
  app.post('/api/rio/remote-approvals/:id', session, (request) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(z.object({ approve: z.boolean(), commandId: z.string().uuid() }), request.body);
    return store.decide(requireActor(request), id, input.approve, input.commandId);
  });
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (!app.ctx.pool || running) return;
    running = store
      .tick()
      .catch(() => {})
      .finally(() => {
        running = undefined;
      });
  }, 60000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await running;
  });
}
