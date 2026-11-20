import {
  AppError,
  type AiFeature,
  type AiFootprint,
  type AiFootprintMine,
  type AiFootprintReport,
  type AiModelFootprint,
  type AiSettings,
  type ModelRef,
  type AiUsageTotals,
} from '@riosoma/contracts';
import { providerFor, type FootprintModel } from '@riosoma/ai';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import { ELECTRICITY_ZONES, estimate, hasModel, isElectricityZone, METHOD_VERSION } from '@riosoma/ecologits';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { requireActor } from '../auth/sessions.js';
import { dataStore, type DataSchemas } from '../data/context.js';
import { BYTE_ORDER_MARK, csvRecord } from '../data/export/text.js';
import { CSV_TYPE } from '../data/export/csv.js';
import { disposition } from '../data/files/detect.js';
import { settingsFor } from './settings.js';

/** The zone estimates use when neither the server nor the organization names one: the world average. */
export const DEFAULT_ZONE = 'WOR';

/** The output tokens of the typical reply the model picker's ratings assume. */
export const TYPICAL_REPLY_TOKENS = 500;

/**
 * The most watt-hours a typical reply's estimate may reach, at its high end, for three leaves and
 * for two.  Anything above the second gets one.
 */
export const LEAF_LIMITS_WH = [0.5, 5] as const;

/** A call's model and what it produced, as far as an estimate needs them. */
export interface CallShape {
  estimateRef?: ModelRef | null;
  providerId: string;
  model: string;
  outputTokens: number;
  /** How long the call took, which caps the generation time the method assumes */
  ms?: number;
}

/** What a call cost and used, and its estimate, as every AI feature records it. */
export interface RecordedUsage {
  providerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  /** Set when the provider reported no usage and the tokens were estimated */
  tokensEstimated?: boolean;
  footprint?: AiFootprint | null;
}

/** The server's zone, from `RIOSOMA_AI_ELECTRICITY_ZONE`. */
export function serverZone(ctx: AppContext): string {
  const zone = ctx.config.aiElectricityZone;
  return zone && isElectricityZone(zone) ? zone : DEFAULT_ZONE;
}

/** The zone an organization's estimates use: its own choice when it made one, or the server's. */
export function zoneFor(ctx: AppContext, settings: Pick<AiSettings, 'electricityZone'>): string {
  const own = settings.electricityZone;
  return own && isElectricityZone(own) ? own : serverZone(ctx);
}

/** The model as the method's data names it, when its provider knows how and the data has it. */
function knownModel(providerId: string, model: string) {
  let name: FootprintModel | null | undefined;
  try {
    name = providerFor(providerId).footprintModel?.(model);
  } catch {
    return null;
  }
  return name && hasModel(name.provider, name.model) ? name : null;
}

/**
 * One call's estimated footprint: null when the method has no estimate for the model, and
 * undefined when the call generated nothing, so there's nothing to estimate.
 */
export function estimateCall(call: CallShape, zone: string): AiFootprint | null | undefined {
  const ref = call.estimateRef;
  const name = ref === null ? null : knownModel(ref?.providerId ?? call.providerId, ref?.model ?? call.model);
  if (!name) return null;
  if (!(call.outputTokens > 0)) return undefined;
  try {
    const result = estimate({
      provider: name.provider,
      model: name.model,
      outputTokens: call.outputTokens,
      ...(call.ms !== undefined && call.ms >= 0 ? { requestLatencyMs: call.ms } : {}),
      zone,
    });
    if (result.kind !== 'estimate') return null;
    return { energyWh: result.energyWh, gwpG: result.gwpGCo2eq, method: result.method, zone: result.zone };
  } catch {
    // An estimate never stands in the way of the work it describes.
    return null;
  }
}

/**
 * Two parts of one piece of work together, such as the rounds of a reply.  A part without an
 * estimate leaves the whole without one, and a part that generated nothing adds nothing.
 */
export function combineFootprints(
  a: AiFootprint | null | undefined,
  b: AiFootprint | null | undefined,
): AiFootprint | null | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a === null || b === null) return null;
  return {
    energyWh: { min: a.energyWh.min + b.energyWh.min, max: a.energyWh.max + b.energyWh.max },
    gwpG: { min: a.gwpG.min + b.gwpG.min, max: a.gwpG.max + b.gwpG.max },
    method: a.method,
    zone: a.zone,
  };
}

/** A footprint for many records at once, from each one's low estimate to each one's high one. */
export function scaleFootprint(
  low: AiFootprint | null | undefined,
  high: AiFootprint | null | undefined,
  count: number,
): AiFootprint | null {
  if (!low || !high) return null;
  return {
    energyWh: { min: low.energyWh.min * count, max: high.energyWh.max * count },
    gwpG: { min: low.gwpG.min * count, max: high.gwpG.max * count },
    method: low.method,
    zone: low.zone,
  };
}

/** How a model rates in the picker, from its estimated energy for a typical reply. */
export function modelFootprint(providerId: string, model: string): AiModelFootprint | null {
  const typical = estimateCall({ providerId, model, outputTokens: TYPICAL_REPLY_TOKENS }, DEFAULT_ZONE);
  if (!typical) return null;
  const high = typical.energyWh.max;
  return {
    leaves: high <= LEAF_LIMITS_WH[0] ? 3 : high <= LEAF_LIMITS_WH[1] ? 2 : 1,
    energyWh: typical.energyWh,
    outputTokens: TYPICAL_REPLY_TOKENS,
  };
}

/**
 * Counts one AI call toward the month's totals, with its cost and its estimate, in the same
 * transaction that adds its cost to the organization's spend.
 */
export async function recordAiUse(
  db: Queryable,
  schemas: DataSchemas,
  use: { orgId: string; userId: string | null; feature: AiFeature; usage: RecordedUsage },
): Promise<void> {
  const { usage } = use;
  const footprint = usage.footprint ?? null;
  const cost = usage.costUsd;
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.app, 'ai_usage')} AS used (org_id, month, user_id, feature, provider_id,
      model, method, zone, calls, estimated_calls, priced_calls, token_estimated_calls, input_tokens,
      output_tokens, cost_usd, energy_wh_min, energy_wh_max, gwp_g_min, gwp_g_max)
    VALUES (${use.orgId}, date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, ${use.userId ?? ''},
      ${use.feature}, ${usage.providerId}, ${usage.model}, ${footprint?.method ?? ''}, ${footprint?.zone ?? ''},
      1, ${footprint ? 1 : 0}, ${cost === null ? 0 : 1}, ${usage.tokensEstimated ? 1 : 0},
      ${Math.max(0, Math.round(usage.inputTokens))},
      ${Math.max(0, Math.round(usage.outputTokens))}, ${cost ?? 0}, ${footprint?.energyWh.min ?? 0},
      ${footprint?.energyWh.max ?? 0}, ${footprint?.gwpG.min ?? 0}, ${footprint?.gwpG.max ?? 0})
    ON CONFLICT (org_id, month, user_id, feature, provider_id, model, method, zone) DO UPDATE SET
      calls = used.calls + 1,
      estimated_calls = used.estimated_calls + EXCLUDED.estimated_calls,
      priced_calls = used.priced_calls + EXCLUDED.priced_calls,
      token_estimated_calls = used.token_estimated_calls + EXCLUDED.token_estimated_calls,
      input_tokens = used.input_tokens + EXCLUDED.input_tokens,
      output_tokens = used.output_tokens + EXCLUDED.output_tokens,
      cost_usd = used.cost_usd + EXCLUDED.cost_usd,
      energy_wh_min = used.energy_wh_min + EXCLUDED.energy_wh_min,
      energy_wh_max = used.energy_wh_max + EXCLUDED.energy_wh_max,
      gwp_g_min = used.gwp_g_min + EXCLUDED.gwp_g_min,
      gwp_g_max = used.gwp_g_max + EXCLUDED.gwp_g_max`,
  );
}

/** The sums every total reads, in the order `totals` expects them. */
const SUMS = sql`sum(calls)::float8 AS calls, sum(estimated_calls)::float8 AS estimated_calls,
  sum(priced_calls)::float8 AS priced_calls, sum(cost_usd)::float8 AS cost_usd,
  sum(energy_wh_min) AS energy_wh_min, sum(energy_wh_max) AS energy_wh_max,
  sum(gwp_g_min) AS gwp_g_min, sum(gwp_g_max) AS gwp_g_max`;

interface SumRow {
  calls: number | null;
  estimated_calls: number | null;
  priced_calls: number | null;
  cost_usd: number | null;
  energy_wh_min: number | null;
  energy_wh_max: number | null;
  gwp_g_min: number | null;
  gwp_g_max: number | null;
}

const totals = (row: SumRow | undefined): AiUsageTotals => ({
  calls: Number(row?.calls ?? 0),
  estimatedCalls: Number(row?.estimated_calls ?? 0),
  pricedCalls: Number(row?.priced_calls ?? 0),
  costUsd: Number(row?.cost_usd ?? 0),
  energyWh: { min: Number(row?.energy_wh_min ?? 0), max: Number(row?.energy_wh_max ?? 0) },
  gwpG: { min: Number(row?.gwp_g_min ?? 0), max: Number(row?.gwp_g_max ?? 0) },
});

const THIS_MONTH = sql`date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`;
/** A month as text, so no time zone of the server's can move it a day */
const DAY = sql`to_char(month, 'YYYY-MM-DD') AS day`;

/** A person's own use this month, for the totals the shell shows them. */
export async function footprintMine(
  ctx: AppContext,
  orgId: string,
  userId: string,
): Promise<AiFootprintMine> {
  const { pool, schemas } = dataStore(ctx);
  const table = ident(schemas.app, 'ai_usage');
  const [month, used, features] = await Promise.all([
    query<{ month: string }>(pool, sql`SELECT to_char(${THIS_MONTH}, 'YYYY-MM-DD') AS month`),
    query(pool, sql`SELECT 1 FROM ${table} WHERE org_id = ${orgId} AND user_id = ${userId} LIMIT 1`),
    query<SumRow & { feature: AiFeature }>(
      pool,
      sql`SELECT feature, ${SUMS} FROM ${table}
      WHERE org_id = ${orgId} AND user_id = ${userId} AND month = ${THIS_MONTH}
      GROUP BY feature ORDER BY feature`,
    ),
  ]);
  const byFeature = features.rows.map((row) => ({ feature: row.feature, ...totals(row) }));
  const all = byFeature.reduce<AiUsageTotals>((sum, row) => add(sum, row), totals(undefined));
  return { used: Boolean(used.rowCount), month: month.rows[0]!.month, ...all, byFeature };
}

function add(a: AiUsageTotals, b: AiUsageTotals): AiUsageTotals {
  return {
    calls: a.calls + b.calls,
    estimatedCalls: a.estimatedCalls + b.estimatedCalls,
    pricedCalls: a.pricedCalls + b.pricedCalls,
    costUsd: a.costUsd + b.costUsd,
    energyWh: { min: a.energyWh.min + b.energyWh.min, max: a.energyWh.max + b.energyWh.max },
    gwpG: { min: a.gwpG.min + b.gwpG.min, max: a.gwpG.max + b.gwpG.max },
  };
}

/** How many months the admin report covers, this one included. */
export const REPORT_MONTHS = 12;

/** The organization's totals for the last twelve months, by month, by feature, and by model. */
export async function footprintReport(ctx: AppContext, orgId: string): Promise<AiFootprintReport> {
  const { pool, schemas } = dataStore(ctx);
  const table = ident(schemas.app, 'ai_usage');
  const since = sql`(${THIS_MONTH} - ${REPORT_MONTHS - 1}::int * interval '1 month')::date`;
  const [months, features, models, settings] = await Promise.all([
    query<SumRow & { day: string }>(
      pool,
      sql`SELECT ${DAY}, ${SUMS} FROM ${table} WHERE org_id = ${orgId} AND month >= ${since}
      GROUP BY month ORDER BY month DESC`,
    ),
    query<SumRow & { day: string; feature: AiFeature }>(
      pool,
      sql`SELECT ${DAY}, feature, ${SUMS} FROM ${table} WHERE org_id = ${orgId} AND month >= ${since}
      GROUP BY month, feature ORDER BY month DESC, feature`,
    ),
    query<SumRow & { day: string; provider_id: string; model: string }>(
      pool,
      sql`SELECT ${DAY}, provider_id, model, ${SUMS} FROM ${table} WHERE org_id = ${orgId} AND month >= ${since}
      GROUP BY month, provider_id, model ORDER BY month DESC, sum(calls) DESC, provider_id, model`,
    ),
    settingsFor(ctx, orgId),
  ]);
  const organization = settings.electricityZone;
  return {
    method: METHOD_VERSION,
    zone: {
      effective: zoneFor(ctx, settings),
      server: serverZone(ctx),
      organization: organization && isElectricityZone(organization) ? organization : null,
    },
    zones: [...ELECTRICITY_ZONES],
    months: months.rows.map((row) => ({ month: row.day, ...totals(row) })),
    byFeature: features.rows.map((row) => ({ month: row.day, feature: row.feature, ...totals(row) })),
    byModel: models.rows.map((row) => ({
      month: row.day,
      providerId: row.provider_id,
      model: row.model,
      ...totals(row),
    })),
  };
}

/** Every month's totals as CSV, one line for each month, feature, model, method, and zone. */
export async function footprintCsv(ctx: AppContext, orgId: string): Promise<string> {
  const { pool, schemas } = dataStore(ctx);
  const rows = await query<
    SumRow & {
      day: string;
      feature: AiFeature;
      provider_id: string;
      model: string;
      method: string;
      zone: string;
      token_estimated_calls: string;
      input_tokens: string;
      output_tokens: string;
    }
  >(
    pool,
    sql`SELECT ${DAY}, feature, provider_id, model, method, zone, ${SUMS},
      sum(token_estimated_calls)::text AS token_estimated_calls,
      sum(input_tokens)::text AS input_tokens, sum(output_tokens)::text AS output_tokens
    FROM ${ident(schemas.app, 'ai_usage')} WHERE org_id = ${orgId}
    GROUP BY month, feature, provider_id, model, method, zone
    ORDER BY month DESC, feature, provider_id, model, method, zone`,
  );
  let text =
    BYTE_ORDER_MARK +
    csvRecord([
      'Month',
      'Feature',
      'Provider',
      'Model',
      'Estimate method',
      'Electricity zone',
      'Calls',
      'Calls with an estimate',
      'Calls with a known price',
      'Input tokens',
      'Output tokens',
      'Cost (USD)',
      'Energy, low estimate (Wh)',
      'Energy, high estimate (Wh)',
      'Carbon, low estimate (g CO2e)',
      'Carbon, high estimate (g CO2e)',
      'Calls with estimated tokens',
    ]);
  for (const row of rows.rows) {
    const sum = totals(row);
    text += csvRecord([
      row.day,
      row.feature,
      row.provider_id,
      row.model,
      row.method,
      row.zone,
      String(sum.calls),
      String(sum.estimatedCalls),
      String(sum.pricedCalls),
      row.input_tokens,
      row.output_tokens,
      String(sum.costUsd),
      String(sum.energyWh.min),
      String(sum.energyWh.max),
      String(sum.gwpG.min),
      String(sum.gwpG.max),
      row.token_estimated_calls,
    ]);
  }
  return text;
}

/** Refuses a zone the method has no electricity mix for. */
export function checkZone(zone: string | null): void {
  if (zone !== null && !isElectricityZone(zone)) throw new AppError('validation_failed', 'ai.zoneUnknown');
}

export async function footprintRoutes(app: FastifyInstance) {
  const admin = { config: { policy: { kind: 'admin', area: 'ai', scope: 'organization' } } } as const;
  const session = { config: { policy: { kind: 'session' } } } as const;
  app.get('/api/ai/footprint/mine', session, async (request): Promise<AiFootprintMine> => {
    const actor = requireActor(request);
    return footprintMine(app.ctx, actor.orgId, actor.userId);
  });
  app.get('/api/ai/footprint', admin, async (request): Promise<AiFootprintReport> => {
    return footprintReport(app.ctx, requireActor(request).orgId);
  });
  app.get('/api/ai/footprint.csv', admin, async (request, reply) => {
    const text = await footprintCsv(app.ctx, requireActor(request).orgId);
    return reply
      .header('content-type', CSV_TYPE)
      .header('content-disposition', disposition(CSV_TYPE, 'ai-footprint.csv'))
      .header('cache-control', 'no-store')
      .send(text);
  });
}
