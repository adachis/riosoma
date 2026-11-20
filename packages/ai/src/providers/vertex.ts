import { REGISTRY } from '../registry.js';
import { ProviderError, type ProviderAdapter, type ProviderConfig } from '../types.js';
import { geminiProvider } from './gemini.js';
import { baseUrlFor, fetchJson } from './http.js';
import { registerProvider } from './registry.js';
import { withRetry } from './retry.js';

function authenticated(config: ProviderConfig): ProviderConfig {
  if (!config.baseUrl) throw new ProviderError('ai.provider.badRequest');
  // Keep the raw token available to redact bare-token echoes from provider failures.
  return {
    ...config,
    headers: { authorization: `Bearer ${config.apiKey ?? ''}`, ...config.headers },
  };
}

export const vertexProvider: ProviderAdapter = {
  id: 'vertex',
  name: 'Vertex AI',
  local: false,
  supportsForcedToolChoice: geminiProvider.supportsForcedToolChoice,
  async listModels(config, signal) {
    const known = REGISTRY.filter((model) => model.providerId === 'vertex');
    const auth = authenticated(config);
    // Token counting validates project access without generating or billing a reply.
    await withRetry(
      () =>
        fetchJson({
          url: `${baseUrlFor(auth, '')}/models/${encodeURIComponent(known[0]!.model)}:countTokens`,
          body: { contents: [{ role: 'user', parts: [{ text: 'connection' }] }] },
          config: auth,
          signal,
        }),
      { signal },
    );
    return known.map(({ model, name }) => ({ model, name }));
  },
  stream: (config, request) => geminiProvider.stream(authenticated(config), request),
  footprintModel: geminiProvider.footprintModel,
};
registerProvider(vertexProvider);
