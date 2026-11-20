import { ProviderError, type ProviderConfig } from '../types.js';
import { baseUrlFor, fetchJson } from './http.js';
import { chatCompletionsProvider } from './openai-compatible.js';
import { withRetry } from './retry.js';

function account(config: ProviderConfig): { root: string; deployment?: string } {
  if (!config.baseUrl) throw new ProviderError('ai.provider.badRequest');
  const url = baseUrlFor(config, '');
  const match = /^(.*)\/openai\/deployments\/([^/]+)$/.exec(url);
  return match ? { root: match[1]!, deployment: decodeURIComponent(match[2]!) } : { root: url };
}
const headers = (config: ProviderConfig): Record<string, string> =>
  config.apiKey ? { 'api-key': config.apiKey } : {};

export const azureProvider = chatCompletionsProvider({
  id: 'azure',
  name: 'Azure OpenAI',
  baseUrl: '',
  maxTokensField: 'max_completion_tokens',
  requestStreamUsage: true,
  // Deployment names hide model-specific restrictions, so retain the deployed default temperature.
  defaultTemperatureOnly: /./,
  headers,
  chatUrl: (config, request) =>
    `${account(config).root}/openai/deployments/${encodeURIComponent(request.model)}/chat/completions?api-version=2024-10-21`,
  async listModels(config, signal) {
    const { root, deployment } = account(config);
    const deployments = config.deployments ?? (deployment ? [deployment] : []);
    if (!deployments.length) throw new ProviderError('ai.provider.badRequest');
    // The data catalog validates authentication; deployment names come from the account owner.
    await withRetry(
      () => fetchJson({ url: `${root}/openai/v1/models`, headers: headers(config), config, signal }),
      { signal },
    );
    return deployments.map((model) => ({ model, name: model }));
  },
});
