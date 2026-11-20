import type { FootprintModel } from '../types.js';
import { chatCompletionsProvider } from './openai-compatible.js';

/**
 * The gateway's vendor prefixes whose models the footprint estimate's data names the same way, by
 * the data's provider names.  Other vendors' models have no estimate.
 */
const FOOTPRINT_VENDORS: ReadonlyMap<string, string> = new Map([
  ['openai', 'openai'],
  ['anthropic', 'anthropic'],
  ['google', 'google_genai'],
  ['mistralai', 'mistralai'],
  ['cohere', 'cohere'],
]);

/** A gateway model, such as `openai/gpt-4o`, as the vendor's own model when the prefix is known. */
export function openrouterFootprintModel(model: string): FootprintModel | null {
  const slash = model.indexOf('/');
  const provider = slash > 0 ? FOOTPRINT_VENDORS.get(model.slice(0, slash)) : undefined;
  return provider ? { provider, model: model.slice(slash + 1) } : null;
}

/** The endpoint Rio talks to unless the organization points it somewhere else. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * A gateway to many hosted models behind one Chat Completions API and one key.  Its catalog carries
 * a display name per model, which the shared listing keeps.
 */
export const openrouterProvider = chatCompletionsProvider({
  id: 'openrouter',
  name: 'OpenRouter',
  baseUrl: OPENROUTER_BASE_URL,
  requestStreamUsage: true,
  footprintModel: openrouterFootprintModel,
});
