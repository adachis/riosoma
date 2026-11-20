// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.  If a copy
// of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Ported from EcoLogits 0.11.1 (https://github.com/genai-impact/ecologits), by Samuel Rincé,
// Adrien Banse, and the GenAI Impact contributors: ecologits/impacts/llm.py and the parts of
// ecologits/impacts/dag.py it runs on.  The original evaluates its steps as a graph in dependency
// order.  Each step is a pure function, so here they run in that same order, written out.

import { add, high, isRange, low, multiply, range, type ValueOrRange } from './range.js';

export const MODEL_QUANTIZATION_BITS = 16;

export const GPU_ENERGY_ALPHA = 1.1665273170451914e-6;
export const GPU_ENERGY_BETA = -0.011205921025579175;
export const GPU_ENERGY_GAMMA = 4.052928146734005e-5;

export const LATENCY_ALPHA = 0.0006785088094353663;
export const LATENCY_BETA = 0.0003119310311688259;
export const LATENCY_GAMMA = 0.019473717579473387;

/** Gigabytes */
export const GPU_MEMORY = 80;
export const GPU_EMBODIED_IMPACT_GWP = 273;
export const GPU_EMBODIED_IMPACT_ADPE = 0.00895;
export const GPU_EMBODIED_IMPACT_PE = 3721;

export const SERVER_GPUS = 8;
/** Kilowatts */
export const SERVER_POWER = 1.2;
export const SERVER_EMBODIED_IMPACT_GWP = 5700;
export const SERVER_EMBODIED_IMPACT_ADPE = 0.37;
export const SERVER_EMBODIED_IMPACT_PE = 70000;

/** Seconds */
export const HARDWARE_LIFESPAN = 3 * 365 * 24 * 60 * 60;

export const BATCH_SIZE = 64;

/** The inputs of one request, in the original's units: billions of parameters, seconds, and kWh. */
export interface LlmInputs {
  modelActiveParameterCount: ValueOrRange;
  modelTotalParameterCount: ValueOrRange;
  outputTokenCount: number;
  /** kgSbeq per kWh */
  ifElectricityMixAdpe: number;
  /** MJ per kWh */
  ifElectricityMixPe: number;
  /** kgCO2eq per kWh */
  ifElectricityMixGwp: number;
  datacenterPue: ValueOrRange;
  /** Seconds, or no cap when absent */
  requestLatency?: number;
  /** Tokens a second the deployed model generates, when measured */
  tps?: number | null;
  /** Seconds to the first token, when measured */
  ttft?: number | null;
}

/** The request's impacts, each a total of its usage and embodied parts, as the original sums them. */
export interface LlmImpacts {
  /** kWh */
  energy: ValueOrRange;
  /** kgCO2eq */
  gwp: ValueOrRange;
  /** kgSbeq */
  adpe: ValueOrRange;
  /** MJ */
  pe: ValueOrRange;
  usage: { energy: ValueOrRange; gwp: ValueOrRange; adpe: ValueOrRange; pe: ValueOrRange };
  embodied: { gwp: ValueOrRange; adpe: ValueOrRange; pe: ValueOrRange };
}

/** Energy of a single GPU in kWh. */
function gpuEnergy(modelActiveParameterCount: number, outputTokenCount: number, batchSize: number): number {
  let gpuEnergyPerToken =
    GPU_ENERGY_ALPHA * Math.exp(GPU_ENERGY_BETA * batchSize) * modelActiveParameterCount + GPU_ENERGY_GAMMA;
  gpuEnergyPerToken /= 1000;
  return outputTokenCount * gpuEnergyPerToken;
}

/** Token generation latency in seconds, never longer than the request took. */
function generationLatency(
  modelActiveParameterCount: number,
  outputTokenCount: number,
  batchSize: number,
  requestLatency: number,
  tps: number | null | undefined,
  ttft: number | null | undefined,
): number {
  const latencyPerToken =
    tps === null || tps === undefined
      ? LATENCY_ALPHA * modelActiveParameterCount + LATENCY_BETA * batchSize + LATENCY_GAMMA
      : 1 / tps;
  const latencyFirstToken = ttft || 0;
  const gpuLatency = outputTokenCount * latencyPerToken + latencyFirstToken;
  if (requestLatency < gpuLatency) return requestLatency;
  return gpuLatency;
}

/** Memory needed to load the model on GPUs, in gigabytes. */
const modelRequiredMemory = (modelTotalParameterCount: number, modelQuantizationBits: number): number =>
  (1.2 * modelTotalParameterCount * modelQuantizationBits) / 8;

/** GPUs needed to hold the model, rounded up to a power of two. */
function gpuRequiredCount(requiredMemory: number, gpuMemory: number): number {
  const gpuNb = Math.ceil(requiredMemory / gpuMemory);
  return 2 ** Math.ceil(Math.log2(gpuNb));
}

/** Energy of the server apart from its GPUs, in kWh. */
const serverEnergy = (
  latency: number,
  serverPower: number,
  serverGpuCount: number,
  requiredGpus: number,
  batchSize: number,
): number => (latency / 3600) * serverPower * (requiredGpus / serverGpuCount) * (1 / batchSize);

/** Embodied impact of the server's share and the GPUs the model needs. */
const serverGpuEmbodied = (
  serverEmbodied: number,
  serverGpuCount: number,
  gpuEmbodied: number,
  requiredGpus: number,
): number => (requiredGpus / serverGpuCount) * serverEmbodied + requiredGpus * gpuEmbodied;

/** The request's share of an embodied impact, by the time it held the hardware. */
const requestEmbodied = (
  embodied: number,
  serverLifetime: number,
  latency: number,
  batchSize: number,
): number => (latency * embodied) / (serverLifetime * batchSize);

interface DagResults {
  request_energy: ValueOrRange;
  request_usage_gwp: ValueOrRange;
  request_usage_adpe: ValueOrRange;
  request_usage_pe: ValueOrRange;
  request_embodied_gwp: ValueOrRange;
  request_embodied_adpe: ValueOrRange;
  request_embodied_pe: ValueOrRange;
}

/** One pass through the steps, for single parameter counts. */
function computeLlmImpactsDag(
  inputs: LlmInputs,
  active: number,
  total: number,
  requestLatency: number,
): DagResults {
  const gpu = gpuEnergy(active, inputs.outputTokenCount, BATCH_SIZE);
  const latency = generationLatency(
    active,
    inputs.outputTokenCount,
    BATCH_SIZE,
    requestLatency,
    inputs.tps,
    inputs.ttft,
  );
  const memory = modelRequiredMemory(total, MODEL_QUANTIZATION_BITS);
  const gpus = gpuRequiredCount(memory, GPU_MEMORY);
  const server = serverEnergy(latency, SERVER_POWER, SERVER_GPUS, gpus, BATCH_SIZE);
  const itEnergy = server + gpus * gpu;
  const energy = multiply(inputs.datacenterPue, itEnergy);
  return {
    request_energy: energy,
    request_usage_gwp: multiply(energy, inputs.ifElectricityMixGwp),
    request_usage_adpe: multiply(energy, inputs.ifElectricityMixAdpe),
    request_usage_pe: multiply(energy, inputs.ifElectricityMixPe),
    request_embodied_gwp: requestEmbodied(
      serverGpuEmbodied(SERVER_EMBODIED_IMPACT_GWP, SERVER_GPUS, GPU_EMBODIED_IMPACT_GWP, gpus),
      HARDWARE_LIFESPAN,
      latency,
      BATCH_SIZE,
    ),
    request_embodied_adpe: requestEmbodied(
      serverGpuEmbodied(SERVER_EMBODIED_IMPACT_ADPE, SERVER_GPUS, GPU_EMBODIED_IMPACT_ADPE, gpus),
      HARDWARE_LIFESPAN,
      latency,
      BATCH_SIZE,
    ),
    request_embodied_pe: requestEmbodied(
      serverGpuEmbodied(SERVER_EMBODIED_IMPACT_PE, SERVER_GPUS, GPU_EMBODIED_IMPACT_PE, gpus),
      HARDWARE_LIFESPAN,
      latency,
      BATCH_SIZE,
    ),
  };
}

const FIELDS = [
  'request_energy',
  'request_usage_gwp',
  'request_usage_adpe',
  'request_usage_pe',
  'request_embodied_gwp',
  'request_embodied_adpe',
  'request_embodied_pe',
] as const;

/**
 * The impacts of one generation request.  When either parameter count is a range, the steps run
 * once for the low counts and once for the high ones, and each result spans the two.
 */
export function computeLlmImpacts(inputs: LlmInputs): LlmImpacts {
  const requestLatency = inputs.requestLatency ?? Infinity;
  let activeParams: number[];
  let totalParams: number[];
  const active = inputs.modelActiveParameterCount;
  const total = inputs.modelTotalParameterCount;
  if (isRange(active) || isRange(total)) {
    activeParams = [low(active), high(active)];
    totalParams = [low(total), high(total)];
  } else {
    activeParams = [active];
    totalParams = [total];
  }
  let results: DagResults | undefined;
  for (let index = 0; index < activeParams.length; index += 1) {
    const res = computeLlmImpactsDag(inputs, activeParams[index]!, totalParams[index]!, requestLatency);
    if (!results) {
      results = res;
      continue;
    }
    const combined = { ...results };
    for (const field of FIELDS) combined[field] = range(low(results[field]), high(res[field]));
    results = combined;
  }
  const r = results!;
  return {
    energy: r.request_energy,
    gwp: add(r.request_usage_gwp, r.request_embodied_gwp),
    adpe: add(r.request_usage_adpe, r.request_embodied_adpe),
    pe: add(r.request_usage_pe, r.request_embodied_pe),
    usage: {
      energy: r.request_energy,
      gwp: r.request_usage_gwp,
      adpe: r.request_usage_adpe,
      pe: r.request_usage_pe,
    },
    embodied: { gwp: r.request_embodied_gwp, adpe: r.request_embodied_adpe, pe: r.request_embodied_pe },
  };
}
