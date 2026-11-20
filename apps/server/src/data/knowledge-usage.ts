import { findElectricityMix } from '@riosoma/ecologits';
import { AppError, KnowledgeSettings, type AiFootprint } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type { AppContext } from '../app.js';
import { recordAiUse } from '../ai/footprint.js';
import type { Actor } from '../http/policy.js';
import { unseal } from '../secrets.js';
import { AccessScope } from './access.js';
import { dataStore } from './context.js';

/**
 * A paid search service's key, for the address a search is about to send it to.  The key is read
 * in one statement with the settings it was saved under, and it is handed over only when those
 * settings name that service and address.  A change that lands after the search read its settings
 * then never pairs the new key with the old address.
 */
export async function credential(
  ctx: AppContext,
  actor: Actor,
  providerId: 'search-research' | 'search-subscription',
  address: string,
) {
  const { pool, schemas } = dataStore(ctx);
  await new AccessScope(pool, schemas, actor).requireOrganization();
  const result = await query<{ sealed: string; settings: unknown }>(
    pool,
    sql`SELECT k.sealed, s.settings FROM ${ident(schemas.app, 'ai_keys')} k
    LEFT JOIN ${ident(schemas.app, 'knowledge_settings')} s ON s.org_id = k.org_id
    WHERE k.org_id = ${actor.orgId} AND k.provider_id = ${providerId}`,
  );
  const saved = result.rows[0];
  const search = saved && KnowledgeSettings.parse(saved.settings ?? {}).search;
  if (!saved || !search || `search-${search.engine}` !== providerId || search.address !== address)
    throw new AppError('unavailable', 'knowledge.searchUnavailable');
  return unseal(ctx.config.secretKey, saved.sealed, `ai:${actor.orgId}:${providerId}`);
}

export interface ServiceFootprint {
  powerWatts?: number | null;
  durationMs: number;
  zone: string;
}

/** Configured power is the service's allocated draw per request, including hosting overhead. */
export function estimateServiceFootprint(input: ServiceFootprint): AiFootprint | null {
  const { powerWatts, durationMs, zone } = input;
  const mix = findElectricityMix(zone);
  if (
    !mix ||
    powerWatts == null ||
    !Number.isFinite(powerWatts) ||
    powerWatts <= 0 ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  )
    return null;
  const energyWh = (powerWatts * durationMs) / 3_600_000;
  // The mix is in kilograms per kilowatt-hour, which equals grams per watt-hour.
  const gwpG = energyWh * mix.gwp;
  return {
    energyWh: { min: energyWh, max: energyWh },
    gwpG: { min: gwpG, max: gwpG },
    method: 'service-power-v1',
    zone,
  };
}

export async function recordKnowledgeUse(
  ctx: AppContext,
  actor: Actor,
  feature: 'embedding' | 'search',
  providerId: string,
  model: string,
  inputTokens: number,
  footprint: ServiceFootprint,
) {
  const { pool, schemas } = dataStore(ctx);
  await recordAiUse(pool, schemas, {
    orgId: actor.orgId,
    userId: actor.userId,
    feature,
    usage: {
      providerId,
      model,
      inputTokens,
      outputTokens: 0,
      costUsd: null,
      footprint: estimateServiceFootprint(footprint),
    },
  });
}
