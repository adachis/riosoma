import { WindowLimiter } from '../data/shared-view-reads.js';
import { knowledgeRoutes } from './knowledge-routes.js';
import { AppError, RioAsk, isTimeZone } from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../auth/sessions.js';
import { parse } from '../http/validate.js';
import {
  activeConversation,
  selectConversation,
  createConversation,
  deleteConversation,
  listConversations,
  messagesFor,
  ownConversation,
} from './conversations.js';
import { diagnoseRoutes } from './diagnose.js';
import { footprintRoutes } from './footprint.js';
import { finishPlan, previewPlan } from './plans.js';
import { settingsRoutes, statusFor } from './settings.js';
import { compactConversation } from './compact.js';
import { streamReply } from './stream.js';

export async function rioRoutes(app: FastifyInstance) {
  await app.register(settingsRoutes);
  await app.register(knowledgeRoutes);
  await app.register(diagnoseRoutes);
  await app.register(footprintRoutes);
  const session = { config: { policy: { kind: 'session' } } } as const;
  const conversationParams = z.object({ conversationId: z.string().uuid() });
  const planParams = z.object({ planId: z.string().uuid() });
  const previewStarts = new WindowLimiter(30, 60_000);
  const previews = new Set<string>();
  app.get('/api/rio/status', session, async (request) =>
    statusFor(app.ctx, requireActor(request).orgId, requireActor(request)),
  );
  app.get('/api/rio/active-conversation', session, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const actor = requireActor(request);
    const conversation = await activeConversation(app.ctx, actor);
    return { conversation, messages: await messagesFor(app.ctx, actor, conversation.id) };
  });
  app.put('/api/rio/active-conversation', session, async (request) => {
    const actor = requireActor(request);
    const { conversationId } = parse(conversationParams, request.body);
    const conversation = await selectConversation(app.ctx, actor, conversationId);
    return { conversation, messages: await messagesFor(app.ctx, actor, conversation.id) };
  });
  app.post('/api/rio/conversations/:conversationId/compact', session, async (request, reply) => {
    const { conversationId } = parse(conversationParams, request.params);
    parse(RioAsk.omit({ text: true }), request.body);
    return compactConversation(app, request, reply, conversationId);
  });
  app.get('/api/rio/conversations', session, async (request) =>
    listConversations(app.ctx, requireActor(request)),
  );
  app.post('/api/rio/conversations', session, async (request) =>
    createConversation(app.ctx, requireActor(request)),
  );
  app.get('/api/rio/conversations/:conversationId', session, async (request) => {
    const { conversationId } = parse(conversationParams, request.params);
    const actor = requireActor(request);
    return {
      conversation: await ownConversation(app.ctx, actor, conversationId),
      messages: await messagesFor(app.ctx, actor, conversationId),
    };
  });
  app.delete('/api/rio/conversations/:conversationId', session, async (request, reply) => {
    await deleteConversation(
      app.ctx,
      requireActor(request),
      parse(conversationParams, request.params).conversationId,
    );
    return reply.status(204).send();
  });
  app.post('/api/rio/conversations/:conversationId/messages', session, async (request, reply) =>
    streamReply(
      app,
      request,
      reply,
      parse(conversationParams, request.params).conversationId,
      parse(RioAsk, request.body),
    ),
  );
  app.get('/api/rio/plans/:planId/preview', session, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const { timeZone, includeSamples } = parse(
      z.object({
        timeZone: z.string().refine(isTimeZone),
        includeSamples: z.enum(['true', 'false']).default('true'),
      }),
      request.query,
    );
    const { planId } = parse(planParams, request.params);
    const actor = requireActor(request);
    const key = `${actor.orgId}:${actor.userId}`;
    const wait = previews.has(key) ? 1 : previewStarts.take(key);
    if (wait) {
      reply.header('retry-after', String(wait));
      throw new AppError('rate_limited', 'rio.plan.preview.busy');
    }
    previews.add(key);
    try {
      return await previewPlan(app, actor, planId, timeZone, includeSamples === 'true');
    } finally {
      previews.delete(key);
    }
  });
  for (const action of ['apply', 'dismiss'] as const)
    app.post(`/api/rio/plans/:planId/${action}`, session, async (request, reply) => {
      const result = await finishPlan(
        app,
        requireActor(request),
        parse(planParams, request.params).planId,
        action === 'dismiss',
        parse(z.object({ includeSamples: z.boolean().default(true) }), request.body ?? {}).includeSamples,
      );
      return action === 'dismiss' ? reply.status(204).send() : result;
    });
}
