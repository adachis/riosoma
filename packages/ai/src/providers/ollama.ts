import type { ModelInfo, ProviderConfig } from '../types.js';
import { baseUrlFor, fetchJson } from './http.js';
import { chatCompletionsProvider } from './openai-compatible.js';
import { withRetry } from './retry.js';
import { isChatModel, sortModels } from './wire.js';

/** Where a local server listens, unless the organization points Rio at one of its own machines. */
export const OLLAMA_BASE_URL = 'http://localhost:11434/v1';

interface TagsResponse {
  models?: Array<{ name?: unknown; model?: unknown } | null>;
}

/** Models pulled to the machine, from the server's own catalog rather than the chat endpoint's. */
async function listLocalModels(config: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]> {
  return withRetry(
    async () => {
      const url = new URL('/api/tags', baseUrlFor(config, OLLAMA_BASE_URL)).toString();
      const tags = await fetchJson<TagsResponse>({ url, method: 'GET', config, signal });
      const models: ModelInfo[] = [];
      for (const entry of tags.models ?? []) {
        const id =
          typeof entry?.name === 'string' && entry.name
            ? entry.name
            : typeof entry?.model === 'string'
              ? entry.model
              : undefined;
        if (!id || !isChatModel(id)) continue;
        models.push({ model: id, name: id });
      }
      return sortModels(models);
    },
    { signal },
  );
}

/**
 * Models running on the organization's own hardware.  They need no key, so nothing leaves the
 * building, and the admin page says so.
 */
export const ollamaProvider = chatCompletionsProvider({
  id: 'ollama',
  name: 'Ollama',
  baseUrl: OLLAMA_BASE_URL,
  local: true,
  forcedToolChoice: false,
  // The chat endpoint is the compatible one, but the catalog is the server's own and sits at its root.
  listModels: listLocalModels,
});
