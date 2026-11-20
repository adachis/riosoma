import { budgetReached } from './budget.js';
import { refuseDemo } from '../demo/boundary.js';
import { permissions, type PolicyPerson } from '../org-units/policy.js';
import { createHash } from 'node:crypto';
import {
  aiDestination,
  AiSettings,
  Autonomy,
  effectiveAutonomy,
  GatewayChange,
  AppError,
  ProviderId,
  RIO_TIERS,
  type AiSettingsView,
  type RioStatus,
  type RioTier,
} from '@riosoma/contracts';
import {
  defaultModel,
  providerFor,
  providers,
  ProviderError,
  REGISTRY,
  isGateway,
  type ModelInfo,
  type ProviderConfig,
} from '@riosoma/ai';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resumePausedRuns } from '../ai-fields/queue.js';
import { modelFootprint } from './footprint.js';
import type { AppContext } from '../app.js';
import { requireActor } from '../auth/sessions.js';
import { dataStore } from '../data/context.js';
import { parse } from '../http/validate.js';
import { runAiSettingsCommand, runAiKeyCommand } from '../data/commands/ai-settings.js';
import { readAiSettings, aiSettingsRevision } from '../data/ai-settings.js';
import { unsealCredential } from '../credentials/service.js';
import { gatewaySettingsRoutes, registeredModel, readGatewaySecret } from './gateway-settings.js';
import { configuredAddress, validateGateway } from './gateway-config.js';
import { instructions } from './prompt.js';

export const defaults = (): AiSettings => AiSettings.parse({ models: { everyday: null, power: null } });
export const messageKey = (error: unknown): string =>
  error instanceof ProviderError || (error instanceof AppError && error.messageKey.startsWith('rio.'))
    ? error.messageKey
    : 'rio.toolFailed';

export async function settingsFor(
  ctx: AppContext,
  orgId: string,
  person?: string | PolicyPerson,
  db?: Queryable,
): Promise<AiSettings> {
  const { pool, schemas } = dataStore(ctx);
  const result = await query<{ settings: unknown }>(
    db ?? pool,
    sql`SELECT settings FROM ${ident(schemas.app, 'ai_settings')} WHERE org_id = ${orgId}`,
  );
  const settings = result.rows[0] ? AiSettings.parse(result.rows[0].settings) : defaults();
  // For a person, what their unit allows narrows what the organization turned on.  Someone who
  // has left the organization isn't narrowed here, so whatever runs as them reports them gone.
  const who = typeof person === 'string' ? { orgId, userId: person } : person;
  const allowed = who ? await permissions(db ?? pool, `"${schemas.app}"`, who) : null;
  if (allowed) {
    settings.enabled &&= allowed.aiEnabled;
    settings.aiFields &&= allowed.aiFields;
    settings.automationDiagnose &&= allowed.aiDiagnose;
    settings.automationAi &&= allowed.automationAi;
    settings.routines &&= allowed.aiRoutines;
  }
  if (who) {
    const personal = await query<{ preferences: { rioAutonomy?: unknown } }>(
      db ?? pool,
      sql`SELECT preferences FROM ${ident(schemas.app, 'users')} WHERE id = ${who.userId}`,
    );
    const choice = Autonomy.safeParse(personal.rows[0]?.preferences.rioAutonomy);
    settings.autonomy = effectiveAutonomy(choice.success ? choice.data : undefined, settings.autonomy);
  }
  return settings;
}

export async function spent(ctx: AppContext, orgId: string): Promise<number> {
  const { pool, schemas } = dataStore(ctx);
  const result = await query<{ cost_usd: string }>(
    pool,
    sql`SELECT cost_usd FROM ${ident(schemas.app, 'ai_spend')}
    WHERE org_id = ${orgId} AND month = date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`,
  );
  return Number(result.rows[0]?.cost_usd ?? 0);
}

export async function connection(
  ctx: AppContext,
  orgId: string,
  providerId: string,
  settings: AiSettings,
  db?: Queryable,
) {
  const adapter = providerFor(providerId);
  const env = ctx.config.providerApiKeys?.[providerId];
  const { pool, schemas } = dataStore(ctx);
  const gateway = settings.gateways?.find((entry) => entry.providerId === providerId);
  // A key from the server's environment goes to the provider's own address, never to one an
  // organization chose.  A gateway's address is its own setting, and a stored key is saved for it.
  const baseUrl = env ? gateway?.baseUrl : configuredAddress(settings, providerId);
  // A stored key is read in one statement with the settings it was saved under, so the two always
  // belong together.  The settings passed in may be older than those, or a draft, and the key
  // goes with them only when they name the address it was saved for.
  const result = env
    ? undefined
    : await query<{ sealed: string; settings: unknown }>(
        db ?? pool,
        sql`SELECT k.sealed, a.settings FROM ${ident(schemas.app, 'ai_keys')} k
        LEFT JOIN ${ident(schemas.app, 'ai_settings')} a ON a.org_id = k.org_id
        WHERE k.org_id = ${orgId} AND k.provider_id = ${providerId}`,
      );
  const saved = result?.rows[0];
  const stored =
    saved &&
    aiDestination(
      configuredAddress(saved.settings ? AiSettings.parse(saved.settings) : defaults(), providerId),
    ) === aiDestination(baseUrl)
      ? saved.sealed
      : undefined;
  const secret =
    env ||
    (stored
      ? await unsealCredential(ctx.config.secretKey, stored, `ai:${orgId}:${providerId}`, orgId, db)
      : undefined);
  const credentials = isGateway(providerId) ? readGatewaySecret(secret) : { key: secret, headers: {} };
  const apiKey = credentials.key;
  const config: ProviderConfig = { ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) };
  if (gateway) {
    config.auth = gateway.auth;
    config.headers = Object.fromEntries(
      Object.entries(credentials.headers).filter(([name]) =>
        gateway.headerNames.some((allowed) => allowed.toLowerCase() === name.toLowerCase()),
      ),
    );
    config.testModel = gateway.models.find((entry) =>
      registeredModel(settings, providerId, entry.model)?.tiers.some(
        (tier) => tier === 'everyday' || tier === 'power',
      ),
    )?.model;
  }
  // Workspace routing belongs to the account configuration, never to a prompt.
  const workspace = ctx.config.providerWorkspaceId;
  if (providerId === 'anthropic' && workspace) config.headers = { 'anthropic-workspace-id': workspace };
  return {
    adapter,
    config,
    hasKey: Boolean(apiKey),
    keyFromEnvironment: Boolean(env),
    available: isGateway(providerId)
      ? Boolean(gateway && (apiKey || gateway.auth.mode === 'none'))
      : Boolean(apiKey) || adapter.local,
  };
}

export async function modelFor(ctx: AppContext, orgId: string, settings: AiSettings, tier: RioTier) {
  refuseDemo();
  const enabled: string[] = [];
  for (const provider of settings.providers) {
    try {
      if ((await connection(ctx, orgId, provider.providerId, settings)).available)
        enabled.push(provider.providerId);
    } catch {
      /* Unavailable adapters cannot serve a tier. */
    }
  }
  const ref =
    settings.models[tier] ??
    defaultModel(tier, enabled) ??
    settings.gateways
      ?.filter((gateway) => enabled.includes(gateway.providerId))
      .flatMap((gateway) =>
        gateway.models
          .filter((model) => registeredModel(settings, gateway.providerId, model.model)?.tiers.includes(tier))
          .map((model) => ({ providerId: gateway.providerId, model: model.model })),
      )[0];
  if (!ref || !enabled.includes(ref.providerId)) return null;
  const registry = registeredModel(settings, ref.providerId, ref.model);
  if (isGateway(ref.providerId) && !registry?.tiers.includes(tier)) return null;
  return {
    ref,
    ...(await connection(ctx, orgId, ref.providerId, settings)),
    registry,
    estimateRef: isGateway(ref.providerId)
      ? (settings.gateways
          ?.find((gateway) => gateway.providerId === ref.providerId)
          ?.models.find((model) => model.model === ref.model)?.mapping ?? null)
      : ref,
  };
}

export async function statusFor(ctx: AppContext, orgId: string, person?: PolicyPerson): Promise<RioStatus> {
  const settings = await settingsFor(ctx, orgId, person);
  const cap = person ? (await settingsFor(ctx, orgId)).autonomy : settings.autonomy;
  const tiers: RioTier[] = [];
  if (settings.enabled)
    for (const tier of RIO_TIERS) if (await modelFor(ctx, orgId, settings, tier)) tiers.push(tier);
  return {
    enabled: tiers.length > 0,
    ...(settings.enabled && settings.providers.length === 0 ? { disabledReason: 'noProvider' as const } : {}),
    tiers,
    autonomy: effectiveAutonomy(settings.autonomy, cap),
    autonomyCap: cap,
    paused:
      settings.monthlyBudgetUsd !== null && budgetReached(await spent(ctx, orgId), settings.monthlyBudgetUsd),
    diagnose: tiers.length > 0 && settings.automationDiagnose,
    routines: tiers.length > 0 && settings.routines,
    routineRunLimitUsd: settings.routineRunLimitUsd,
  };
}

export async function settingsRoutes(app: FastifyInstance) {
  const admin = { config: { policy: { kind: 'admin', area: 'ai', scope: 'organization' } } } as const;
  const cache = new Map<string, { until: number; models: Promise<ModelInfo[]> }>();
  app.get('/api/ai/settings', admin, async (request): Promise<AiSettingsView> => {
    const actor = requireActor(request);
    const { orgId } = actor;
    const { pool, schemas } = dataStore(app.ctx);
    const snapshot = await readAiSettings({
      db: pool,
      schemas,
      actor,
      databaseId: '',
      secretKey: app.ctx.config.secretKey,
    });
    const settings = snapshot.settings;
    const entries: AiSettingsView['providers'] = [];
    for (const adapter of [
      ...providers(),
      ...(settings.gateways ?? [])
        .filter((gateway) => gateway.providerId !== 'gateway')
        .map((gateway) => ({
          ...providerFor(gateway.providerId),
          id: gateway.providerId,
          name: gateway.name,
        })),
    ]) {
      const c = await connection(app.ctx, orgId, adapter.id, settings);
      const gateway = settings.gateways?.find((entry) => entry.providerId === adapter.id);
      const known = gateway
        ? gateway.models.map((entry) => registeredModel(settings, adapter.id, entry.model)!)
        : REGISTRY.filter((m) => m.providerId === adapter.id);
      let models: ModelInfo[] = known;
      if (c.available) {
        const key = `${orgId}:${adapter.id}:${createHash('sha256').update(JSON.stringify(c.config)).digest('hex')}`;
        let cached = cache.get(key);
        if (!cached || cached.until < Date.now()) {
          if (cache.size >= 200) cache.delete(cache.keys().next().value!);
          cached = { until: Date.now() + 600_000, models: adapter.listModels(c.config) };
          cache.set(key, cached);
        }
        try {
          models = await cached.models;
        } catch {
          cache.delete(key);
        }
      }
      entries.push({
        providerId: adapter.id,
        name: gateway?.name ?? adapter.name,
        local: adapter.local,
        hasKey: c.hasKey,
        keyFromEnvironment: c.keyFromEnvironment,
        models: [...new Map([...known, ...models].map((m) => [m.model, m])).values()].map((m) => {
          const registered = known.find((k) => k.model === m.model);
          return {
            model: m.model,
            name: m.name,
            tiers: registered?.tiers ?? (adapter.id === 'azure' ? ['everyday', 'power'] : []),
            priceKnown: Boolean(registered?.price),
            footprint: gateway
              ? (() => {
                  const mapping = gateway.models.find((entry) => entry.model === m.model)?.mapping;
                  return mapping ? modelFootprint(mapping.providerId, mapping.model) : null;
                })()
              : modelFootprint(adapter.id, m.model),
          };
        }),
      });
    }
    return {
      settings,
      revision: aiSettingsRevision(snapshot),
      providers: entries,
      registryModels: REGISTRY.map(({ providerId, model, name }) => ({ providerId, model, name })),
      spentThisMonthUsd: await spent(app.ctx, orgId),
    };
  });
  app.put('/api/ai/settings', admin, async (request) => {
    const actor = requireActor(request);
    const settings = await runAiSettingsCommand(app, actor, request.body);
    const { pool, schemas } = dataStore(app.ctx);
    const { orgId } = actor;
    cache.clear();
    // AI field runs waiting for next month's budget look again, in case the budget went up.
    await resumePausedRuns(pool, schemas, orgId);
    return settings;
  });
  for (const method of ['PUT', 'DELETE'] as const)
    app.route({
      method,
      url: '/api/ai/keys/:providerId',
      ...admin,
      handler: async (request, reply) => {
        const { providerId } = parse(z.object({ providerId: ProviderId }), request.params);
        try {
          providerFor(providerId);
        } catch {
          throw new AppError('validation_failed', 'ai.providerUnavailable');
        }
        const actor = requireActor(request);
        const key =
          method === 'PUT'
            ? parse(z.object({ key: z.string().trim().min(1).max(10000) }), request.body).key
            : null;
        await runAiKeyCommand(app, actor, providerId, key);
        cache.clear();
        return reply.status(204).send();
      },
    });
  app.post('/api/ai/test', admin, async (request) => {
    const actor = requireActor(request);
    const { orgId } = actor;
    const { providerId, gateway, key, headers } = parse(
      z.object({
        providerId: ProviderId,
        gateway: GatewayChange.shape.gateway.optional(),
        key: GatewayChange.shape.key,
        headers: GatewayChange.shape.headers,
      }),
      request.body,
    );
    try {
      const { pool, schemas } = dataStore(app.ctx);
      const { settings: stored } = await readAiSettings({
        db: pool,
        schemas,
        actor,
        databaseId: '',
        secretKey: app.ctx.config.secretKey,
      });
      if (gateway) {
        if (gateway.providerId !== providerId) throw new AppError('validation_failed', 'ai.gateway.invalid');
        validateGateway(gateway);
      }
      const settings = gateway
        ? {
            ...stored,
            gateways: [
              ...(stored.gateways ?? []).filter((entry) => entry.providerId !== providerId),
              gateway,
            ],
          }
        : stored;
      // A drafted gateway at another address than the saved one gets no stored key or header
      // values from the connection, so it is tried with the ones the request carries.
      const c = await connection(app.ctx, orgId, providerId, settings);
      if (key !== undefined) c.config.apiKey = key;
      if (headers && isGateway(providerId)) {
        const names =
          (gateway ?? settings.gateways?.find((entry) => entry.providerId === providerId))?.headerNames.map(
            (name) => name.toLowerCase(),
          ) ?? [];
        c.config.headers = Object.fromEntries(
          [...Object.entries(c.config.headers ?? {}), ...Object.entries(headers)]
            .map(([name, value]) => [name.toLowerCase(), value])
            .filter(([name]) => names.includes(name!)),
        );
      }
      const started = performance.now();
      if (isGateway(providerId)) {
        const { toolSpecs } = await import('./tools.js');
        c.config.testRequest = {
          messages: [
            { role: 'system', content: instructions },
            { role: 'user', content: '.' },
          ],
          tools: toolSpecs,
        };
      }
      if (c.adapter.testConnection) await c.adapter.testConnection(c.config);
      else await c.adapter.listModels(c.config);
      return {
        success: true,
        ...(isGateway(providerId) ? { roundTripMs: Math.round(performance.now() - started) } : {}),
      };
    } catch (error) {
      return {
        success: false,
        messageKey: messageKey(error),
        ...(error instanceof ProviderError && error.params ? { params: error.params } : {}),
      };
    }
  });
  await gatewaySettingsRoutes(app);
}
