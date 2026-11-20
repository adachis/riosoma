import { REGISTRY } from '../registry.js';
import {
  ProviderError,
  type ProviderAdapter,
  type ProviderConfig,
  type QueueAdapter,
  type QueueJob,
} from '../types.js';
import { unexpectedResponse } from './errors.js';
import { baseUrlFor, fetchJson } from './http.js';
import { registerProvider } from './registry.js';
import { withRetry } from './retry.js';

function path(model: string): string {
  if (
    !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(model) ||
    model.split('/').some((part) => part === '.' || part === '..')
  )
    throw new ProviderError('ai.provider.badRequest');
  return model;
}
function url(config: ProviderConfig, job: QueueJob): string {
  // Subroutes select a variant for submission.  Request management lives at the app's root.
  return `${baseUrlFor(config, 'https://queue.fal.run')}/${path(job.model).split('/').slice(0, 2).join('/')}/requests/${encodeURIComponent(job.requestId)}`;
}
const headers = (config: ProviderConfig): Record<string, string> =>
  config.apiKey ? { authorization: `Key ${config.apiKey}` } : {};
const queue: QueueAdapter = {
  async submit(config, model, input, signal) {
    // A timed-out submission may have been accepted, so retrying could create and bill two jobs.
    const response = await fetchJson<{ request_id?: string }>({
      url: `${baseUrlFor(config, 'https://queue.fal.run')}/${path(model)}`,
      body: input,
      headers: headers(config),
      config,
      signal,
    });
    if (!response.request_id) throw unexpectedResponse('The queue response had no request ID');
    return { model, requestId: response.request_id };
  },
  async status(config, job, signal) {
    const response = await withRetry(
      () =>
        fetchJson<{ status?: string }>({
          url: `${url(config, job)}/status`,
          headers: headers(config),
          config,
          signal,
        }),
      { signal },
    );
    switch (response.status) {
      case 'IN_QUEUE':
        return 'queued';
      case 'IN_PROGRESS':
        return 'running';
      case 'COMPLETED':
        return 'completed';
      default:
        throw unexpectedResponse('The queue returned an unknown status');
    }
  },
  result: (config, job, signal) =>
    withRetry(
      () =>
        fetchJson<Record<string, unknown>>({
          url: url(config, job),
          headers: headers(config),
          config,
          signal,
        }),
      { signal },
    ),
  async cancel(config, job, signal) {
    await fetchJson({
      url: `${url(config, job)}/cancel`,
      method: 'PUT',
      headers: headers(config),
      config,
      signal,
    });
  },
};
export const falProvider: ProviderAdapter = {
  id: 'fal',
  name: 'FAL',
  local: false,
  queue,
  async testConnection(config) {
    if (!config.apiKey) throw new ProviderError('ai.provider.unauthorized');
    throw new ProviderError('ai.test.unverified');
  },
  async listModels(config) {
    if (!config.apiKey) throw new ProviderError('ai.provider.unauthorized');
    return REGISTRY.filter((model) => model.providerId === 'fal').map(({ model, name }) => ({ model, name }));
  },
  stream: () => {
    throw new ProviderError('ai.provider.badRequest');
  },
};
registerProvider(falProvider);
