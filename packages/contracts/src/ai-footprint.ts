import { z } from 'zod';

/**
 * Estimates of the energy use and carbon of AI work, shown beside its cost.  Every figure is an
 * estimate by a published method, named in `method`, so every figure is a range from the low end
 * of the method's assumptions to the high end.  A model the method's data lacks has no estimate,
 * never a guess.
 *
 * Routes:
 * - `GET /api/ai/footprint/mine` (session) → `AiFootprintMine`, the person's own use this month
 * - `GET /api/ai/footprint` (admin, AI area) → `AiFootprintReport`, the organization's last twelve
 *   months by feature and by model
 * - `GET /api/ai/footprint.csv` (admin, AI area) → the same totals as a CSV file
 * - The electricity zone an organization's estimates use is `electricityZone` in the AI settings.
 */

/** A low and a high end. */
export interface AiRange {
  min: number;
  max: number;
}

/** One AI call's estimated footprint. */
export interface AiFootprint {
  /** Watt-hours */
  energyWh: AiRange;
  /** Grams of CO2 equivalent */
  gwpG: AiRange;
  /** The method and its version, such as `EcoLogits 0.11.1` */
  method: string;
  /** The electricity zone the carbon figure used */
  zone: string;
}

/** The kinds of AI work Riosoma counts. */
export const AI_FEATURES = [
  'rio',
  'aiFields',
  'diagnose',
  'routines',
  'embedding',
  'search',
  'automations',
  'ingest',
] as const;
export const AiFeature = z.enum(AI_FEATURES);
export type AiFeature = z.infer<typeof AiFeature>;

/**
 * An electricity zone: an ISO 3166-1 alpha-3 country code, `WOR` for the world average, or `EEE`
 * for Europe.  The server checks it against the zones the method has data for.
 */
export const ElectricityZone = z.string().regex(/^[A-Z]{3}$/);

/** Totals over some AI calls. */
export interface AiUsageTotals {
  calls: number;
  /** Calls with a footprint estimate */
  estimatedCalls: number;
  /** Calls whose model's price is known, which are the ones `costUsd` counts */
  pricedCalls: number;
  costUsd: number;
  /** Over the estimated calls only */
  energyWh: AiRange;
  /** Over the estimated calls only */
  gwpG: AiRange;
}

export interface AiFootprintMine extends AiUsageTotals {
  /** Whether the person has used AI at all, which is when the shell shows their totals */
  used: boolean;
  /** The first day of this month, as YYYY-MM-DD */
  month: string;
  byFeature: Array<AiUsageTotals & { feature: AiFeature }>;
}

/** How a model rates for the picker, from its estimated energy for a typical reply. */
export interface AiModelFootprint {
  /** Three for the least energy, one for the most */
  leaves: 1 | 2 | 3;
  energyWh: AiRange;
  /** The output tokens of the typical reply the rating assumes */
  outputTokens: number;
}

export interface AiFootprintReport {
  method: string;
  /** The zone estimates use now, and where it comes from */
  zone: { effective: string; server: string; organization: string | null };
  /** Every zone the method has data for */
  zones: string[];
  /** Newest first, each month as YYYY-MM-DD */
  months: Array<AiUsageTotals & { month: string }>;
  byFeature: Array<AiUsageTotals & { month: string; feature: AiFeature }>;
  byModel: Array<AiUsageTotals & { month: string; providerId: string; model: string }>;
}
