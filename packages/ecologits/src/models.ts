// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.  If a copy
// of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// Ported from EcoLogits 0.11.1 (https://github.com/genai-impact/ecologits), by Samuel Rincé,
// Adrien Banse, and the GenAI Impact contributors: ecologits/model_repository.py.

import data from './data/models.json' with { type: 'json' };
import { range, type ValueOrRange } from './range.js';

/** The providers the model data covers, by the original's names. */
export const PROVIDERS = [
  'anthropic',
  'mistralai',
  'openai',
  'huggingface_hub',
  'cohere',
  'google_genai',
] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface Model {
  provider: Provider;
  name: string;
  architecture: {
    type: 'dense' | 'moe';
    /** Billions of parameters, or total and active billions for a mixture of experts */
    parameters: ValueOrRange | { total: ValueOrRange; active: ValueOrRange };
  };
  /** Codes such as `model-arch-not-released` */
  warnings: string[];
  deployment: { tps: number | null; ttft: number | null } | null;
}

type RawValue = number | { min: number; max: number };
interface RawModel {
  provider: string;
  name: string;
  architecture: { type: string; parameters: RawValue | { total: RawValue; active: RawValue } };
  warnings?: string[] | null;
  deployment?: { tps?: number | null; ttft?: number | null } | null;
}
interface RawAlias {
  provider: string;
  name: string;
  alias: string;
}

const isProvider = (value: string): value is Provider => (PROVIDERS as readonly string[]).includes(value);

function valueOrRange(raw: RawValue): ValueOrRange {
  return typeof raw === 'number' ? raw : range(raw.min, raw.max);
}

/**
 * Reads a model the way the original's schema does.  Parameters are a count, a range, or total and
 * active counts, and anything else on the architecture is ignored.
 */
function readModel(raw: RawModel): Model {
  if (!isProvider(raw.provider)) throw new Error(`Unknown provider: ${raw.provider}`);
  if (raw.architecture.type !== 'dense' && raw.architecture.type !== 'moe')
    throw new Error(`Unknown architecture: ${raw.architecture.type}`);
  const parameters = raw.architecture.parameters;
  return {
    provider: raw.provider,
    name: raw.name,
    architecture: {
      type: raw.architecture.type,
      parameters:
        typeof parameters === 'object' && 'total' in parameters
          ? { total: valueOrRange(parameters.total), active: valueOrRange(parameters.active) }
          : valueOrRange(parameters),
    },
    warnings: raw.warnings ?? [],
    deployment: raw.deployment
      ? { tps: raw.deployment.tps ?? null, ttft: raw.deployment.ttft ?? null }
      : null,
  };
}

const key = (provider: string, name: string) => `${provider}\u0000${name}`;

/** Every model by provider and name, with each alias pointing at a copy under its own name. */
function repository(): Map<string, Model> {
  const file = data as unknown as { models?: RawModel[] | null; aliases?: RawAlias[] | null };
  const models = new Map<string, Model>();
  for (const raw of file.models ?? []) {
    const model = readModel(raw);
    const id = key(model.provider, model.name);
    if (models.has(id)) throw new Error(`duplicated models with: ${model.provider}/${model.name}`);
    models.set(id, model);
  }
  if (models.size === 0) throw new Error('Cannot initialize on an empty model repository.');
  for (const alias of file.aliases ?? []) {
    const target = models.get(key(alias.provider, alias.alias));
    if (!target) throw new Error(`model alias not found: ${alias.provider}/${alias.alias}`);
    models.set(key(alias.provider, alias.name), { ...target, name: alias.name });
  }
  return models;
}

const MODELS = repository();

/** The model a provider serves under this exact name, or null when the data doesn't have it. */
export function findModel(provider: string, name: string): Model | null {
  return MODELS.get(key(provider, name)) ?? null;
}

/** Every model the data holds, aliases included. */
export function listModels(): Model[] {
  return [...MODELS.values()];
}
