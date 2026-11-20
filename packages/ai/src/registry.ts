import type { ModelCapability, RegistryModel } from './types.js';

/**
 * Models Riosoma suggests, cheapest capable first within each tier.  Admins can pick any model a
 * provider offers; these are the defaults and the ones whose tool use has been checked.  Prices
 * come from each provider's own price list (standard tier, checked September 27, 2026) and stay
 * unknown until confirmed there, so the app shows tokens rather than a guessed cost.
 */
export const REGISTRY: readonly RegistryModel[] = [
  {
    providerId: 'openai',
    model: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    tiers: ['everyday', 'vision'],
    price: { input: 0.1, output: 0.5 },
    contextTokens: 400_000,
    maxOutputTokens: 32_768,
    tools: true,
    forcedToolChoice: true,
  },
  {
    providerId: 'gemini',
    model: 'gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash-Lite',
    tiers: ['everyday', 'vision'],
    price: { input: 0.3, output: 2.5 },
    contextTokens: 1_000_000,
    maxOutputTokens: 65_536,
    tools: true,
    forcedToolChoice: true,
  },
  {
    providerId: 'gemini',
    model: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    tiers: ['power', 'vision'],
    // Doubles to $1.50 and $7.50 on January 1, 2027.
    price: { input: 0.75, output: 3.75 },
    contextTokens: 1_000_000,
    maxOutputTokens: 65_536,
    tools: true,
    forcedToolChoice: true,
  },
  {
    providerId: 'openai',
    model: 'gpt-6.2-sol',
    name: 'GPT-6.2 Sol',
    tiers: ['power', 'vision'],
    price: { input: 2, output: 10 },
    contextTokens: 400_000,
    maxOutputTokens: 32_768,
    tools: true,
    forcedToolChoice: true,
  },
  {
    providerId: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    tiers: ['everyday', 'vision'],
    // From the provider's price list as of June 2026, not rechecked with the others above.
    price: { input: 1, output: 5 },
    contextTokens: 200_000,
    maxOutputTokens: 8192,
    tools: true,
    forcedToolChoice: true,
  },
  {
    providerId: 'mistral',
    model: 'mistral-small-latest',
    name: 'Mistral Small',
    tiers: ['everyday'],
    price: null,
    contextTokens: 128_000,
    tools: true,
    forcedToolChoice: true,
  },
  {
    providerId: 'bedrock',
    model: 'amazon.nova-lite-v1:0',
    name: 'Amazon Nova Lite',
    tiers: ['everyday', 'vision'],
    price: null,
    contextTokens: 300_000,
    tools: true,
    forcedToolChoice: true,
  },
  {
    providerId: 'vertex',
    model: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    tiers: ['everyday', 'vision'],
    price: null,
    contextTokens: 1_000_000,
    tools: true,
    forcedToolChoice: true,
  },
  ...capabilityEntries(),
];

function capabilityEntries(): RegistryModel[] {
  const entries: Array<[string, string, ModelCapability, number, boolean]> = [
    ['openai', 'text-embedding-3-small', 'embeddings', 8191, false],
    ['ollama', 'qwen3-embedding:0.6b', 'embeddings', 32_768, false],
    ['mistral', 'mistral-ocr-latest', 'ocr', 0, false],
    ['ollama', 'glm-ocr', 'ocr', 0, false],
    ['anthropic', 'claude-sonnet-4-6', 'code', 200_000, true],
    ['fal', 'fal-ai/flux-2/klein/4b', 'image', 0, false],
    ['fal', 'fal-ai/ltx-2.3/text-to-video/fast', 'video', 0, false],
  ];
  // Media has no token context or token price; its later executor supplies the billing unit.
  return entries.map(([providerId, model, capability, contextTokens, tools]) => ({
    providerId,
    model,
    name: model,
    tiers: [],
    capabilities: [capability],
    price: null,
    contextTokens,
    tools,
    forcedToolChoice: tools,
  }));
}

/** Capability candidates preserve the registry's preference order and provider consent. */
export function modelsForCapability(
  capability: ModelCapability,
  enabled: readonly string[],
): RegistryModel[] {
  return REGISTRY.filter(
    (model) => model.capabilities?.includes(capability) && enabled.includes(model.providerId),
  );
}

/** The first registry model for a tier whose provider is enabled. */
export function defaultModel(
  tier: RegistryModel['tiers'][number],
  enabled: readonly string[],
): RegistryModel | null {
  return REGISTRY.find((model) => model.tiers.includes(tier) && enabled.includes(model.providerId)) ?? null;
}
