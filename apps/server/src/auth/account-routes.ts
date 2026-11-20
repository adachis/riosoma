import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, EndSessions } from '@riosoma/contracts';
import { runAuthenticationCommand } from '../data/commands/authentication.js';
import { AccessScope } from '../data/access.js';
import { dataStore } from '../data/context.js';
import { parse } from '../http/validate.js';
import { mailFailureFields, type MailMessage } from '../mail/index.js';
import { accountSessions, resetAvailability } from './account-store.js';
import { clearSessionCookie, requireActor, findIdentity } from './sessions.js';
import { authDatabase } from './database.js';
import { clearPending } from './mfa/pending.js';

export async function accountRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  const publicRoute = { config: { policy: { kind: 'public' as const } } };
  const sessionRoute = { config: { policy: { kind: 'session' as const } } };
  const people = {
    config: { policy: { kind: 'admin' as const, area: 'people' as const, scope: 'person' as const } },
  };
  const security = {
    config: { policy: { kind: 'admin' as const, area: 'security' as const, scope: 'organization' as const } },
  };
  const work = new Set<Promise<unknown>>();
  const track = (promise: Promise<unknown>) => {
    work.add(promise);
    void promise.finally(() => work.delete(promise));
  };
  const deliver = async (message: MailMessage | undefined) => {
    if (!message || !ctx.mailer) return;
    try {
      await ctx.mailer.send(message);
    } catch (error) {
      app.log.warn(
        { code: 'mail_delivery_failed', ...mailFailureFields(error) },
        'security email delivery failed',
      );
    }
  };
  app.addHook('onClose', async () => {
    await Promise.allSettled([...work]);
  });

  app.get('/api/auth/password-reset', publicRoute, () => resetAvailability(ctx));
  app.post('/api/auth/password-reset', publicRoute, async (request, reply) => {
    const result = await runAuthenticationCommand(
      ctx,
      { ...(request.body as object), kind: 'auth.reset.request' },
      { request },
    );
    if (result.accepted && ctx.mailer && ctx.config.baseUrl) {
      // Account lookup and delivery start only after the account-independent response leaves.
      reply.raw.once('finish', () => {
        track(
          runAuthenticationCommand(ctx, {
            ...(request.body as object),
            kind: 'auth.reset.deliver',
            requestedAt: result.requestedAt,
            requestNumber: result.requestNumber,
          })
            .then((issued) => deliver(issued.message))
            .catch(() => {
              app.log.warn({ messageKey: 'errors.internal' }, 'password reset delivery failed');
            }),
        );
      });
    }
    return reply.status(202).send();
  });
  app.post('/api/auth/password-reset/redeem', publicRoute, async (request, reply) => {
    const result = await runAuthenticationCommand(
      ctx,
      { ...(request.body as object), kind: 'auth.reset.redeem' },
      { request },
    );
    clearSessionCookie(request, reply);
    clearPending(ctx, request, reply);
    track(deliver(result.message));
    return reply.status(204).send();
  });
  app.get('/api/me/sessions', sessionRoute, (request) => accountSessions(ctx, requireActor(request)));
  app.post('/api/me/sessions/end', sessionRoute, async (request, reply) => {
    const actor = requireActor(request);
    const body = parse(EndSessions, request.body);
    await runAuthenticationCommand(ctx, { ...body, kind: 'auth.sessions.end' }, { actor, request });
    if (!body.others && (!body.sessionId || body.sessionId === actor.sessionId))
      clearSessionCookie(request, reply);
    return reply.status(204).send();
  });
  app.post('/api/me/password', sessionRoute, async (request, reply) => {
    const result = await runAuthenticationCommand(
      ctx,
      { ...(request.body as object), kind: 'auth.password.change' },
      { actor: requireActor(request), request },
    );
    if (!result.accepted) throw new AppError('validation_failed', 'auth.signIn.invalid');
    track(deliver(result.message));
    return reply.status(204).send();
  });
  app.post('/api/admin/people/:userId/password-reset', people, async (request) => {
    const { userId } = parse(z.object({ userId: z.string().min(1).max(100) }), request.params);
    const result = await runAuthenticationCommand(
      ctx,
      { ...(request.body as object), kind: 'auth.reset.admin', userId },
      { actor: requireActor(request), request },
    );
    await deliver(result.message);
    return result.link ? { link: result.link } : {};
  });
  app.post('/api/admin/people/:userId/sessions/end', people, async (request, reply) => {
    const { userId } = parse(z.object({ userId: z.string().min(1).max(100) }), request.params);
    await runAuthenticationCommand(
      ctx,
      { kind: 'auth.sessions.end', userId },
      { actor: requireActor(request), request },
    );
    return reply.status(204).send();
  });
  app.get('/api/admin/password-reset/policy', security, async (request) => {
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    await new AccessScope(pool, schemas, actor).requireOrganizationAdmin('security');
    const identity = await findIdentity(pool, authDatabase(ctx).app, actor.userId);
    return { enabled: identity?.settings.passwordResetEnabled !== false };
  });
  app.put('/api/admin/password-reset/policy', security, async (request, reply) => {
    await runAuthenticationCommand(
      ctx,
      { ...(request.body as object), kind: 'auth.reset.policy' },
      { actor: requireActor(request), request },
    );
    return reply.status(204).send();
  });
}
