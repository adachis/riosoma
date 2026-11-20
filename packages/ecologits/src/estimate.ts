// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.  If a copy
// of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Ported from EcoLogits 0.11.1 (https://github.com/genai-impact/ecologits), by Samuel Rincé,
// Adrien Banse, and the GenAI Impact contributors: `llm_impacts` and `PROVIDER_CONFIG_MAP` in
// ecologits/tracers/utils.py.  Water use, which the original also estimates, is left out.

import { findElectricityMix } from './electricity-mixes.js';
import { computeLlmImpacts } from './llm.js';
import { findModel, type Provider } from './models.js';
import { high, low, range, type Range, type ValueOrRange } from './range.js';
import { METHOD_VERSION } from './source.js';

interface ProviderConfig {
  /** The zone whose electricity the original assumes when none is given */
  datacenterLocation: string;
  datacenterPue: ValueOrRange;
}

const PROVIDER_CONFIG: Readonly<Record<Provider, ProviderConfig>> = {
  anthropic: { datacenterLocation: 'USA', datacenterPue: range(1.09, 1.14) },
  cohere: { datacenterLocation: 'USA', datacenterPue: 1.09 },
  google_genai: { datacenterLocation: 'USA', datacenterPue: 1.09 },
  huggingface_hub: { datacenterLocation: 'USA', datacenterPue: range(1.09, 1.14) },
  mistralai: { datacenterLocation: 'SWE', datacenterPue: 1.16 },
  openai: { datacenterLocation: 'USA', datacenterPue: 1.2 },
};

export interface EstimateRequest {
  /** The provider, by the model data's names, such as `huggingface_hub` */
  provider: string;
  /** The model's exact name at that provider */
  model: string;
  outputTokens: number;
  /** How long the request took.  The generation time the method assumes never exceeds it. */
  requestLatencyMs?: number;
  /**
   * The electricity zone, as an ISO 3166-1 alpha-3 code, `WOR` for the world, or `EEE` for Europe.
   * Without one, the zone the method assumes for the provider's data centers.
   */
  zone?: string;
}

/** An estimate, every figure a range from the low end of the method's assumptions to the high end. */
export interface Estimate {
  kind: 'estimate';
  /** Watt-hours */
  energyWh: Range;
  /** Grams of CO2 equivalent */
  gwpGCo2eq: Range;
  /** Kilograms of antimony equivalent */
  adpeKgSbEq: Range;
  /** Megajoules */
  peMj: Range;
  /** The zone whose electricity mix the estimate used */
  zone: string;
  method: string;
  /** Codes for where the inputs are less certain, such as an unreleased architecture */
  warnings: string[];
}

/** No estimate, rather than a guess: the model or the zone isn't in the method's data. */
export interface NoEstimate {
  kind: 'none';
  reason: 'unknownModel' | 'unknownZone';
  method: string;
}

export type EstimateResult = Estimate | NoEstimate;

const bounds = (value: ValueOrRange, scale: number): Range => ({
  min: low(value) * scale,
  max: high(value) * scale,
});

/** Estimates one generation request's energy use and impacts. */
export function estimate(request: EstimateRequest): EstimateResult {
  const { outputTokens, requestLatencyMs } = request;
  if (!Number.isFinite(outputTokens) || outputTokens < 0)
    throw new RangeError('outputTokens must be a finite number, zero or more');
  if (requestLatencyMs !== undefined && !(requestLatencyMs >= 0))
    throw new RangeError('requestLatencyMs must be zero or more');
  const model = findModel(request.provider, request.model);
  if (!model) return { kind: 'none', reason: 'unknownModel', method: METHOD_VERSION };
  const parameters = model.architecture.parameters;
  const moe = typeof parameters === 'object' && 'total' in parameters;
  const total = moe ? parameters.total : parameters;
  const active = moe ? parameters.active : parameters;
  const config = PROVIDER_CONFIG[model.provider];
  const zone = request.zone ?? config.datacenterLocation ?? 'WOR';
  const mix = findElectricityMix(zone);
  if (!mix) return { kind: 'none', reason: 'unknownZone', method: METHOD_VERSION };
  const impacts = computeLlmImpacts({
    modelActiveParameterCount: active,
    modelTotalParameterCount: total,
    outputTokenCount: outputTokens,
    ...(requestLatencyMs === undefined ? {} : { requestLatency: requestLatencyMs / 1000 }),
    ifElectricityMixAdpe: mix.adpe,
    ifElectricityMixPe: mix.pe,
    ifElectricityMixGwp: mix.gwp,
    datacenterPue: config.datacenterPue,
    tps: model.deployment?.tps ?? null,
    ttft: model.deployment?.ttft ?? null,
  });
  return {
    kind: 'estimate',
    energyWh: bounds(impacts.energy, 1000),
    gwpGCo2eq: bounds(impacts.gwp, 1000),
    adpeKgSbEq: bounds(impacts.adpe, 1),
    peMj: bounds(impacts.pe, 1),
    zone,
    method: METHOD_VERSION,
    warnings: [...new Set([...model.warnings, ...mix.warnings])],
  };
}

/** Whether the method's data has this model, so a picker can say "no estimate" without asking. */
export function hasModel(provider: string, model: string): boolean {
  return findModel(provider, model) !== null;
}
