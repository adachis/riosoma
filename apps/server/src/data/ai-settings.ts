import { aiDestination, AiSettings, AppError, RIO_TIERS, type GatewayChange } from '@riosoma/contracts';
import { isGateway, providerFor } from '@riosoma/ai';
import { ident, query, sql } from '@riosoma/db';
import {
  readGatewaySecret,
  registeredModel,
  sameDestination,
  validateGateway,
} from '../ai/gateway-config.js';
import { checkZone } from '../ai/footprint.js';
import { sealCredential, unsealCredential } from '../credentials/service.js';
import { AccessScope } from './access.js';
import { digest } from './organization-admin/store.js';
import { organizationChannel } from './notify.js';
import { organizationAdmin } from '../org-units/store.js';
import type { CommandContext } from './commands/context.js';

export interface StoredAiSettings {
  settings: AiSettings;
  keys: Record<string, string | null>;
}

/**
 * The AI settings and the sealed keys saved with them.  A paid search service's key isn't one of
 * them: it belongs to the knowledge settings, which keep it with the address it was entered for,
 * so saving or undoing these settings never writes it back.
 */
export async function readAiSettings(c: CommandContext): Promise<StoredAiSettings> {
  await new AccessScope(c.db, c.schemas, c.actor).requireOrganizationAdmin('ai');
  const result = await query<{ settings: unknown; keys: Record<string, string> }>(
    c.db,
    sql`
    SELECT a.settings,
      COALESCE((SELECT jsonb_object_agg(provider_id, sealed) FROM ${ident(c.schemas.app, 'ai_keys')}
        WHERE org_id = o.id AND provider_id NOT IN ('search-subscription', 'search-research')),
        '{}'::jsonb) AS keys
    FROM ${ident(c.schemas.app, 'orgs')} o
    LEFT JOIN ${ident(c.schemas.app, 'ai_settings')} a ON a.org_id = o.id
    WHERE o.id = ${c.actor.orgId}`,
  );
  const row = result.rows[0];
  if (!row) throw new AppError('not_found', 'errors.notFound');
  return {
    settings: AiSettings.parse(row.settings ?? { models: { everyday: null, power: null } }),
    keys: row.keys,
  };
}

export const aiSettingsRevision = (state: StoredAiSettings) => digest(state);

export async function prepareAiSettings(
  c: CommandContext,
  before: StoredAiSettings,
  update: Partial<AiSettings>,
  keys: Record<string, string>,
  changedGatewayIds: string[] = [],
): Promise<StoredAiSettings> {
  const settings = AiSettings.parse({ ...before.settings, ...update });
  for (const tier of RIO_TIERS) {
    const ref = settings.models[tier];
    if (
      ref &&
      changedGatewayIds.includes(ref.providerId) &&
      !registeredModel(settings, ref.providerId, ref.model)?.tiers.includes(tier)
    )
      settings.models[tier] = null;
  }
  const changed = { ...before.keys };
  // A key belongs to the address it was saved for, and a provider with no address in the settings
  // uses its own.  A key from the server's environment never goes to an address chosen here.  A
  // stored key is entered again when its provider's address changes, and it is dropped when the
  // provider is no longer listed or the environment's key has taken its place.
  const addressOf = (list: AiSettings['providers'], providerId: string) =>
    aiDestination(list.find((entry) => entry.providerId === providerId)?.baseUrl);
  const listed = [...before.settings.providers, ...settings.providers].map((entry) => entry.providerId);
  for (const providerId of new Set(listed)) {
    if (isGateway(providerId)) continue;
    const address = addressOf(settings.providers, providerId);
    if (addressOf(before.settings.providers, providerId) === address) continue;
    const locked = Boolean(c.appContext?.config.providerApiKeys?.[providerId]);
    if (locked && address !== null) throw new AppError('validation_failed', 'ai.provider.addressLocked');
    if (!changed[providerId] || Object.hasOwn(keys, providerId)) continue;
    if (!locked && settings.providers.some((entry) => entry.providerId === providerId))
      throw new AppError('validation_failed', 'ai.provider.keyReenter');
    delete changed[providerId];
  }
  for (const [providerId, key] of Object.entries(keys)) {
    providerFor(providerId);
    if (c.appContext?.config.providerApiKeys?.[providerId])
      throw new AppError('validation_failed', 'ai.key.environmentLocked');
    const previous = isGateway(providerId) ? await gatewaySecret(c, before, providerId) : null;
    const secret = previous ? JSON.stringify({ ...previous, key }) : key;
    changed[providerId] = await sealCredential(
      c.appContext!.config.secretKey,
      secret,
      `ai:${c.actor.orgId}:${providerId}`,
      c.actor.orgId,
      c.db,
    );
  }
  for (const provider of settings.providers) {
    if (
      !Object.hasOwn(update, 'providers') &&
      !(update.enabled && !before.settings.enabled) &&
      !Object.hasOwn(keys, provider.providerId)
    )
      continue;
    try {
      const gateway = settings.gateways?.find((entry) => entry.providerId === provider.providerId);
      if (isGateway(provider.providerId) && !gateway)
        throw new AppError('validation_failed', 'ai.providerUnavailable');
      if (gateway?.auth.mode === 'none') continue;
      if (
        !providerFor(provider.providerId).local &&
        !changed[provider.providerId] &&
        !c.appContext?.config.providerApiKeys?.[provider.providerId]
      )
        throw new AppError('validation_failed', 'ai.provider.missingKey');
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('validation_failed', 'ai.providerUnavailable');
    }
  }
  for (const model of Object.values(settings.models))
    if (model && !settings.providers.some((provider) => provider.providerId === model.providerId))
      throw new AppError('validation_failed', 'rio.disabled');
  if (Object.hasOwn(update, 'electricityZone')) checkZone(settings.electricityZone);
  return { settings, keys: changed };
}

export async function writeAiSettings(c: CommandContext, state: StoredAiSettings) {
  await new AccessScope(c.db, c.schemas, c.actor).requireOrganizationAdmin('ai');
  const current = await readAiSettings(c);
  for (const providerId of new Set([...Object.keys(current.keys), ...Object.keys(state.keys)])) {
    const sealed = state.keys[providerId];
    if (sealed === current.keys[providerId]) continue;
    if (sealed)
      await query(
        c.db,
        sql`INSERT INTO ${ident(c.schemas.app, 'ai_keys')} (org_id, provider_id, sealed)
        VALUES (${c.actor.orgId}, ${providerId}, ${sealed})
        ON CONFLICT (org_id, provider_id) DO UPDATE SET sealed = EXCLUDED.sealed`,
      );
    else
      await query(
        c.db,
        sql`DELETE FROM ${ident(c.schemas.app, 'ai_keys')}
        WHERE org_id = ${c.actor.orgId} AND provider_id = ${providerId}`,
      );
  }
  await query(
    c.db,
    sql`INSERT INTO ${ident(c.schemas.app, 'ai_settings')} (org_id, settings)
    VALUES (${c.actor.orgId}, ${JSON.stringify(state.settings)}::jsonb)
    ON CONFLICT (org_id) DO UPDATE SET settings = EXCLUDED.settings`,
  );
  const readers = await query<Pick<CommandContext['actor'], 'userId' | 'kind' | 'adminRoles'>>(
    c.db,
    sql`
    SELECT user_id AS "userId", kind, admin_roles AS "adminRoles" FROM ${ident(c.schemas.app, 'memberships')}
    WHERE org_id = ${c.actor.orgId} AND (kind = 'owner' OR cardinality(admin_roles) > 0)`,
  );
  for (const reader of readers.rows)
    if (organizationAdmin(reader, 'ai'))
      await query(
        c.db,
        sql`SELECT pg_notify(${organizationChannel(c.schemas)},
        ${JSON.stringify({ orgId: c.actor.orgId, userId: reader.userId })})`,
      );
}

async function gatewaySecret(c: CommandContext, before: StoredAiSettings, providerId: string) {
  const sealed = before.keys[providerId];
  return readGatewaySecret(
    sealed
      ? await unsealCredential(c.secretKey!, sealed, `ai:${c.actor.orgId}:${providerId}`, c.actor.orgId, c.db)
      : undefined,
  );
}

export async function prepareAiGateways(
  c: CommandContext,
  before: StoredAiSettings,
  changes: GatewayChange[],
  removed: string[],
): Promise<StoredAiSettings> {
  const ids = changes.map((change) => change.gateway.providerId);
  if (new Set([...ids, ...removed]).size !== ids.length + removed.length)
    throw new AppError('validation_failed', 'ai.gateway.invalid');
  const settings = structuredClone(before.settings);
  const keys = { ...before.keys };
  for (const providerId of removed) {
    settings.gateways = settings.gateways?.filter((gateway) => gateway.providerId !== providerId);
    settings.providers = settings.providers.filter((provider) => provider.providerId !== providerId);
    delete keys[providerId];
  }
  for (const change of changes) {
    const { gateway, key } = change;
    const providerId = gateway.providerId;
    validateGateway(gateway);
    if (key !== undefined && c.appContext?.config.providerApiKeys?.[providerId])
      throw new AppError('validation_failed', 'ai.key.environmentLocked');
    // Stored secrets stay with the address they were saved for.  A gateway that moves, or a new
    // one, starts with none, so its key and header values come with the change.
    const stored = before.settings.gateways?.find((entry) => entry.providerId === providerId);
    const previous: Awaited<ReturnType<typeof gatewaySecret>> = sameDestination(stored, gateway)
      ? await gatewaySecret(c, before, providerId)
      : { headers: {} };
    const reenter = stored && !sameDestination(stored, gateway) ? 'ai.gateway.secretsReenter' : null;
    const names = gateway.headerNames.map((name) => name.toLowerCase());
    const merged = Object.fromEntries(
      [...Object.entries(previous.headers), ...Object.entries(change.headers ?? {})].map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    );
    const headers = Object.fromEntries(
      names.flatMap((name) => (merged[name] === undefined ? [] : [[name, merged[name]]])),
    );
    const secret = { key: key === undefined ? previous.key : key || undefined, headers };
    if (gateway.auth.mode !== 'none' && !secret.key && !c.appContext?.config.providerApiKeys?.[providerId])
      throw new AppError('validation_failed', reenter ?? 'ai.gateway.keyRequired');
    if (names.some((name) => headers[name] === undefined))
      throw new AppError('validation_failed', reenter ?? 'ai.gateway.headerRequired');
    const exists = settings.gateways?.some((entry) => entry.providerId === providerId);
    settings.gateways = [
      ...(settings.gateways ?? []).filter((entry) => entry.providerId !== providerId),
      gateway,
    ];
    if (!exists) settings.providers.push({ providerId });
    keys[providerId] = await sealCredential(
      c.secretKey!,
      JSON.stringify(secret),
      `ai:${c.actor.orgId}:${providerId}`,
      c.actor.orgId,
      c.db,
    );
  }
  if (changes.length || removed.length) {
    for (const tier of RIO_TIERS) {
      const ref = settings.models[tier];
      if (
        ref &&
        isGateway(ref.providerId) &&
        !registeredModel(settings, ref.providerId, ref.model)?.tiers.includes(tier)
      )
        settings.models[tier] = null;
    }
  }
  const parsed = AiSettings.safeParse(settings);
  if (!parsed.success) throw new AppError('validation_failed', 'ai.gateway.invalid');
  return { settings: parsed.data, keys };
}
