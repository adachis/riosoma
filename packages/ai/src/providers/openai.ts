import { chatCompletionsProvider } from './openai-compatible.js';

/** The endpoint Rio talks to unless the organization points it somewhere else. */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** The Chat Completions API itself: the format every other adapter here is measured against. */
export const openaiProvider = chatCompletionsProvider({
  id: 'openai',
  name: 'OpenAI',
  baseUrl: OPENAI_BASE_URL,
  // The renamed cap is what this API accepts; the older name is refused on current models.
  maxTokensField: 'max_completion_tokens',
  // Usage only arrives in a final, otherwise empty chunk when the call asks for it.
  requestStreamUsage: true,
  // Reasoning models take only their default temperature.
  defaultTemperatureOnly: /^(o\d|gpt-5|gpt-6)/,
  // Current GPT models refuse function tools on this API while reasoning, and say to turn it off.
  toolsReasoning: { models: /^gpt-(5|6)/, effort: 'none' },
  footprintProvider: 'openai',
});
