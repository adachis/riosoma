import { ProviderError, type ProviderConfig } from '../types.js';
import { chatCompletionsProvider, requestBody } from './openai-compatible.js';
import { baseUrlFor, fetchJson, mergeHeaders } from './http.js';
import { messageFromBody, sanitizedProviderCause, scrubSecrets } from './errors.js';

export const isGateway = (id: string): boolean => /^gateway(?:-[a-z0-9-]+)?$/.test(id);

export function gatewayHeaders(config: ProviderConfig): Record<string, string> {
  const auth = config.auth ?? { mode: 'bearer' };
  const headers = mergeHeaders(config.headers);
  // Routing headers cannot accidentally override the selected authentication mode.
  delete headers.authorization;
  if (auth.mode === 'bearer' && config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  if (auth.mode === 'header' && auth.header && config.apiKey)
    headers[auth.header.toLowerCase()] = config.apiKey;
  return headers;
}

function configured(config: ProviderConfig): ProviderConfig {
  if (!config.baseUrl) throw new ProviderError('ai.gateway.wrongPath');
  return { ...config, headers: gatewayHeaders(config) };
}

function safeFailure(error: unknown): unknown {
  // Gateway errors can echo routing header values, including short secrets that look like words.
  return error instanceof ProviderError
    ? new ProviderError(error.messageKey, error.status, undefined, error.retryable, error.params, {
        cause: sanitizedProviderCause(error),
      })
    : error;
}

function validPrompts(init: RequestInit): boolean {
  if (typeof init.body !== 'string') return false;
  try {
    const body = JSON.parse(init.body) as {
      model?: unknown;
      messages?: Array<{ role?: unknown; content?: unknown; tool_calls?: unknown }>;
    };
    return (
      typeof body.model === 'string' &&
      Boolean(body.model.trim()) &&
      Array.isArray(body.messages) &&
      body.messages.length > 0 &&
      body.messages.every(
        (message) =>
          message &&
          ['system', 'user', 'assistant', 'tool'].includes(String(message.role)) &&
          (typeof message.content === 'string' ||
            Array.isArray(message.content) ||
            (message.role === 'assistant' &&
              message.content === null &&
              Array.isArray(message.tool_calls) &&
              message.tool_calls.length > 0)),
      ) &&
      body.messages.some((message) =>
        typeof message.content === 'string'
          ? Boolean(message.content.trim())
          : Array.isArray(message.content) && message.content.length > 0,
      )
    );
  } catch {
    return false;
  }
}

async function knownFailure(response: Response, chat: boolean, init: RequestInit): Promise<void> {
  if (response.status === 413) {
    await response.body?.cancel();
    throw new ProviderError('ai.gateway.requestTooLarge', 413);
  }
  if (response.status !== 400 || !chat) return;
  const detail = messageFromBody(await response.clone().text());
  if (detail === "request body doesn't contain valid prompts" && validPrompts(init)) {
    await response.body?.cancel();
    throw new ProviderError('ai.gateway.requestBufferTooSmall', 400);
  }
  const model = detail?.match(/^cannot use own model - must be: (.+)$/)?.[1]?.trim();
  if (model) {
    // Even short routing secrets must stay out of the model name returned to the client.
    const headers = new Headers(init.headers);
    const secrets = [
      ...headers.values(),
      headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '',
    ].filter(Boolean);
    let shown = scrubSecrets(model, secrets);
    for (const secret of secrets) shown = shown.split(secret).join('[redacted]');
    if (shown.length > 400) shown = `${shown.slice(0, 400)}…`;
    await response.body?.cancel();
    throw new ProviderError('ai.gateway.modelRestricted', 400, undefined, false, { model: shown });
  }
}

async function gatewayFetch(url: string, init: RequestInit): Promise<Response> {
  const origin = new URL(url).origin;
  let current = new URL(url);
  // A supported redirect can move the chat operation to a route with a different name.
  const chat = current.pathname.endsWith('/chat/completions');
  let request = { ...init, redirect: 'manual' as const };
  for (let redirects = 0; ; redirects++) {
    const response = await fetch(current, request);
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      await knownFailure(response, chat, request);
      return response;
    }
    const location = response.headers.get('location');
    if (!location) return response;
    await response.body?.cancel();
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new ProviderError('ai.gateway.wrongPath');
    }
    // Every routing header can be a secret, so redirects stay inside the configured origin.
    if (
      redirects >= 20 ||
      next.origin !== origin ||
      next.protocol !== current.protocol ||
      next.username ||
      next.password
    )
      throw new ProviderError('ai.gateway.wrongPath');
    const method = request.method ?? 'GET';
    if (
      ((response.status === 301 || response.status === 302) && method === 'POST') ||
      (response.status === 303 && method !== 'GET' && method !== 'HEAD')
    ) {
      const headers = new Headers(request.headers);
      headers.delete('content-type');
      headers.delete('content-length');
      request = { ...request, method: 'GET', body: undefined, headers };
    }
    current = next;
  }
}

export const gatewayProvider = chatCompletionsProvider({
  id: 'gateway',
  name: 'AI gateway',
  baseUrl: '',
  requestStreamUsage: true,
  fetch: gatewayFetch,
  headers: (config) => gatewayHeaders(configured(config)),
  listModels: async (config, signal) => {
    const safe = configured(config);
    try {
      const reply = await fetchJson<{ data?: Array<{ id?: unknown }> }>({
        url: `${baseUrlFor(safe, '')}/models`,
        fetch: gatewayFetch,
        config: safe,
        signal,
      });
      return [
        ...new Set(
          (reply.data ?? []).flatMap((row) => (typeof row.id === 'string' && row.id ? [row.id] : [])),
        ),
      ]
        .sort()
        .map((model) => ({ model, name: model }));
    } catch (error) {
      throw safeFailure(error);
    }
  },
});

gatewayProvider.testConnection = async (config, signal) => {
  const safe = configured(config);
  if (!safe.testModel) throw new ProviderError('ai.gateway.modelNotFound');
  try {
    const response = await gatewayFetch(`${baseUrlFor(safe, '')}/chat/completions`, {
      method: 'POST',
      headers: { ...safe.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...requestBody(
          {
            model: safe.testModel,
            messages: safe.testRequest?.messages ?? [{ role: 'user', content: '.' }],
            tools: safe.testRequest?.tools,
            maxOutputTokens: 1,
          },
          {},
          'max_tokens',
        ),
        stream: false,
        // A connection probe checks tool support without asking the model to execute a tool.
        ...(safe.testRequest?.tools?.length ? { tool_choice: 'none' } : {}),
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(safe.timeoutMs ?? 15_000)])
        : AbortSignal.timeout(safe.timeoutMs ?? 15_000),
    });
    if (response.status === 401 || response.status === 403) throw new ProviderError('ai.gateway.rejectedKey');
    const body = await response.text();
    if (!response.ok) {
      if (
        /model[_ -]?(?:not[_ -]?found|does not exist|unknown)|(?:unknown|invalid|not found|does not exist).*model|model.*(?:not found|does not exist|unknown)/i.test(
          body,
        )
      )
        throw new ProviderError('ai.gateway.modelNotFound');
      if (response.status === 404) throw new ProviderError('ai.gateway.wrongPath');
      throw new ProviderError('ai.gateway.requestFailed');
    }
    const reply = JSON.parse(body) as { choices?: Array<{ message?: { content?: unknown } }> };
    if (!reply.choices?.some((choice) => typeof choice.message?.content === 'string'))
      throw new ProviderError('ai.gateway.requestFailed');
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    signal?.throwIfAborted();
    const cause = error instanceof Error ? error.cause : undefined;
    const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : '';
    if (/TLS|SSL|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) throw new ProviderError('ai.gateway.tls');
    if (error instanceof SyntaxError) throw new ProviderError('ai.gateway.requestFailed');
    throw new ProviderError('ai.gateway.unreachable');
  }
};

const stream = gatewayProvider.stream;
gatewayProvider.stream = async function* (config, request) {
  try {
    yield* stream(configured(config), request);
  } catch (error) {
    throw safeFailure(error);
  }
};
const embed = gatewayProvider.embed!;
gatewayProvider.embed = async (config, model, input, signal) => {
  try {
    return await embed(configured(config), model, input, signal);
  } catch (error) {
    throw safeFailure(error);
  }
};
