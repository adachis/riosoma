import { chatCompletionsProvider } from './openai-compatible.js';

/** The endpoint Rio talks to unless the organization points it somewhere else. */
export const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';

/** Mistral speaks the Chat Completions format and reports usage in its last streamed chunk. */
export const mistralProvider = chatCompletionsProvider({
  id: 'mistral',
  name: 'Mistral',
  baseUrl: MISTRAL_BASE_URL,
  // It rejects parameters it doesn't know, so the usage option stays out of the request.
  requestStreamUsage: false,
  footprintProvider: 'mistralai',
});
