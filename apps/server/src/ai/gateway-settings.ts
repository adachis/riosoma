import { AppError, GatewayChange, GatewayConfig, ProviderId } from '@riosoma/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireActor } from '../auth/sessions.js';
import { parse } from '../http/validate.js';
import { runAiGatewayCommand } from '../data/commands/ai-settings.js';
import { dataStore } from '../data/context.js';
import { readAiSettings } from '../data/ai-settings.js';
import { connection } from './settings.js';
import { GatewaySecret, validateGateway } from './gateway-config.js';
export { registeredModel, readGatewaySecret } from './gateway-config.js';

export async function gatewaySettingsRoutes(app: FastifyInstance) {
  const admin = { config: { policy: { kind: 'admin', area: 'ai', scope: 'organization' } } } as const;
  const params = z.object({ providerId: ProviderId.regex(/^gateway(?:-[a-z0-9-]+)?$/) });
  app.put('/api/ai/gateways/:providerId', admin, async (request) => {
    const actor = requireActor(request);
    const { providerId } = parse(params, request.params);
    const input = parse(GatewayChange, request.body);
    if (input.gateway.providerId !== providerId)
      throw new AppError('validation_failed', 'ai.gateway.invalid');
    return runAiGatewayCommand(app, actor, [input], []);
  });
  app.delete('/api/ai/gateways/:providerId', admin, async (request) => {
    const actor = requireActor(request);
    const { providerId } = parse(params, request.params);
    return runAiGatewayCommand(app, actor, [], [providerId]);
  });
  app.post('/api/ai/gateways/discover', admin, async (request) => {
    const actor = requireActor(request);
    const { orgId } = actor;
    const input = parse(
      z.object({
        gateway: GatewayConfig,
        key: GatewaySecret.shape.key.optional(),
        headers: GatewaySecret.shape.headers.optional(),
      }),
      request.body,
    );
    const { pool, schemas } = dataStore(app.ctx);
    const { settings } = await readAiSettings({
      db: pool,
      schemas,
      actor,
      databaseId: '',
      secretKey: app.ctx.config.secretKey,
    });
    validateGateway(input.gateway);
    // The connection is made for the drafted gateway, so the stored key and header values come
    // with it only when the draft keeps the address they were saved for.  Anywhere else, the
    // request has to carry its own.
    const c = await connection(app.ctx, orgId, input.gateway.providerId, {
      ...settings,
      gateways: [
        ...(settings.gateways ?? []).filter((entry) => entry.providerId !== input.gateway.providerId),
        input.gateway,
      ],
    });
    try {
      return {
        models: await c.adapter.listModels({
          ...c.config,
          apiKey: input.key || c.config.apiKey,
          headers: { ...c.config.headers, ...input.headers },
        }),
      };
    } catch {
      return { models: [], messageKey: 'ai.gateway.discoveryUnavailable' };
    }
  });
}
