import type {
  ChatMessage,
  ChatRequest,
  FootprintModel,
  ModelInfo,
  ProviderAdapter,
  ProviderConfig,
  StreamPart,
  ToolCall,
} from '../types.js';
import { errorFromWire, parseJson, secretsOf, unexpectedResponse } from './errors.js';
import { baseUrlFor, fetchJson, streamSse, type HttpRequest } from './http.js';
import { registerProvider } from './registry.js';
import { retryStream, withRetry } from './retry.js';
import {
  isChatModel,
  parseToolArguments,
  schemaFor,
  sortModels,
  stopFrom,
  tokenCount,
  toolsFor,
  type StopReason,
} from './wire.js';

/** How one provider's Chat Completions dialect differs from the shared one. */
export interface ChatCompletionsOptions {
  id: string;
  name: string;
  /** Where `/chat/completions` and `/models` live, unless `ProviderConfig.baseUrl` says otherwise */
  baseUrl: string;
  /** Runs on the organization's own hardware, so data never leaves it */
  local?: boolean;
  forcedToolChoice?: boolean;
  /** The field the provider reads the output cap from; the Chat Completions API renamed it */
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';
  /** Models that accept only their default temperature, so none is sent */
  defaultTemperatureOnly?: RegExp;
  /** Models that refuse function tools while reasoning, and the effort that lets them use tools */
  toolsReasoning?: { models: RegExp; effort: string };
  /** Ask for a final chunk carrying usage; providers that always send it in the stream don't need it */
  requestStreamUsage?: boolean;
  /** Catalog listing, for a provider whose own catalog isn't the Chat Completions one */
  listModels?: (config: ProviderConfig, signal?: AbortSignal) => Promise<ModelInfo[]>;
  /** The provider's name in the footprint estimate's data, when its models are named the same there */
  footprintProvider?: string;
  /** How the footprint estimate's data names a model, for a provider whose names need mapping */
  footprintModel?: (model: string) => FootprintModel | null;
  headers?: (config: ProviderConfig) => Record<string, string>;
  chatUrl?: (config: ProviderConfig, request: ChatRequest) => string;
  fetch?: HttpRequest['fetch'];
}

interface WireFunctionCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireMessage {
  role: string;
  content: string | null | Array<Record<string, unknown>>;
  tool_calls?: WireFunctionCall[];
  tool_call_id?: string;
  name?: string;
}

interface WireChunk {
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      refusal?: string | null;
      tool_calls?: WireFunctionCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string; type?: string; code?: string | number | null; status?: number } | null;
}

interface WireCatalog {
  data?: Array<{ id?: unknown; name?: unknown } | null>;
}

/** A tool call being assembled from streamed fragments. */
interface PendingToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

/**
 * Builds and registers an adapter for a provider that speaks the Chat Completions wire format.
 * Each provider's own module names itself and its quirks here, so the format is written once.
 */
export function chatCompletionsProvider(options: ChatCompletionsOptions): ProviderAdapter {
  const maxTokensField = options.maxTokensField ?? 'max_tokens';
  const adapter: ProviderAdapter = {
    id: options.id,
    name: options.name,
    local: options.local ?? false,
    supportsForcedToolChoice: () => options.forcedToolChoice ?? true,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    listModels:
      options.listModels ??
      ((config, signal) =>
        listCatalog(config, baseUrlFor(config, options.baseUrl), signal, options.headers?.(config))),
    stream: (config, request) =>
      retryStream(() => chatStream(config, request, options, maxTokensField), {
        signal: request.signal,
        retries: request.retries,
      }),
    embed: (config, model, input, signal) => embed(config, options, model, input, signal),
  };
  const footprintProvider = options.footprintProvider;
  const footprintModel =
    options.footprintModel ??
    (footprintProvider ? (model: string) => ({ provider: footprintProvider, model }) : undefined);
  if (footprintModel) adapter.footprintModel = footprintModel;
  registerProvider(adapter);
  return adapter;
}

function authHeaders(config: ProviderConfig): Record<string, string> {
  // A local server needs no key, and a proxy may want none sent at all.
  return config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
}

async function listCatalog(
  config: ProviderConfig,
  baseUrl: string,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<ModelInfo[]> {
  return withRetry(
    async () => {
      const catalog = await fetchJson<WireCatalog>({
        url: `${baseUrl}/models`,
        method: 'GET',
        headers: headers ?? authHeaders(config),
        config,
        signal,
      });
      const models: ModelInfo[] = [];
      for (const entry of catalog.data ?? []) {
        const id = typeof entry?.id === 'string' ? entry.id : undefined;
        if (!id || !isChatModel(id)) continue;
        const label = typeof entry?.name === 'string' ? entry.name.trim() : '';
        models.push({ model: id, name: label || id });
      }
      return sortModels(models);
    },
    { signal },
  );
}

async function embed(
  config: ProviderConfig,
  options: ChatCompletionsOptions,
  model: string,
  input: string[],
  signal?: AbortSignal,
) {
  const reply = await fetchJson<{
    data?: Array<{ index: number; embedding: number[] }>;
    usage?: { prompt_tokens?: number };
  }>({
    url: `${baseUrlFor(config, options.baseUrl)}/embeddings`,
    fetch: options.fetch,
    headers: options.headers?.(config) ?? authHeaders(config),
    body: { model, input },
    config,
    signal,
  });
  const rows = reply.data?.sort((a, b) => a.index - b.index);
  if (
    !rows ||
    rows.length !== input.length ||
    rows.some(
      (row, index) =>
        row.index !== index ||
        !Array.isArray(row.embedding) ||
        !row.embedding.length ||
        row.embedding.some((value) => !Number.isFinite(value)) ||
        row.embedding.length !== rows[0]!.embedding.length,
    )
  )
    throw unexpectedResponse('ai.gateway.invalidResponse');
  return { vectors: rows.map((row) => row.embedding), inputTokens: tokenCount(reply.usage?.prompt_tokens) };
}

export function requestBody(
  request: ChatRequest,
  options: Pick<ChatCompletionsOptions, 'requestStreamUsage' | 'defaultTemperatureOnly' | 'toolsReasoning'>,
  maxTokensField: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: toWireMessages(request.messages),
    stream: true,
  };
  if (options.requestStreamUsage) body.stream_options = { include_usage: true };
  const tools = toolsFor(request);
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: schemaFor(tool.parameters),
      },
    }));
    body.tool_choice = request.toolChoice
      ? { type: 'function', function: { name: request.toolChoice.name } }
      : 'auto';
    if (request.toolChoice) body.parallel_tool_calls = false;
  }
  if (request.maxOutputTokens) body[maxTokensField] = request.maxOutputTokens;
  if (request.temperature !== undefined && !options.defaultTemperatureOnly?.test(request.model))
    body.temperature = request.temperature;
  if (tools.length > 0 && options.toolsReasoning?.models.test(request.model))
    body.reasoning_effort = options.toolsReasoning.effort;
  return body;
}

/** Turns Riosoma's conversation into the wire's messages, tool calls and results included. */
function toWireMessages(messages: readonly ChatMessage[]): WireMessage[] {
  const wire: WireMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        wire.push({ role: 'system', content: message.content });
        break;
      case 'user':
        wire.push({
          role: 'user',
          content: message.attachments?.length
            ? [
                { type: 'text', text: message.content },
                ...message.attachments.map((file) =>
                  file.mediaType === 'application/pdf'
                    ? {
                        type: 'file',
                        file: {
                          filename: 'document.pdf',
                          file_data: `data:${file.mediaType};base64,${file.data}`,
                        },
                      }
                    : { type: 'image_url', image_url: { url: `data:${file.mediaType};base64,${file.data}` } },
                ),
              ]
            : message.content,
        });
        break;
      case 'assistant': {
        // A turn that only calls tools has no text, and the API wants that said with null.
        const turn: WireMessage = { role: 'assistant', content: message.content || null };
        const calls = (message.toolCalls ?? []).map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        }));
        if (calls.length > 0) turn.tool_calls = calls;
        wire.push(turn);
        break;
      }
      case 'tool':
        wire.push({
          role: 'tool',
          content: message.content,
          tool_call_id: message.toolCallId,
          name: message.name,
        });
        break;
    }
  }
  return wire;
}

async function* chatStream(
  config: ProviderConfig,
  request: ChatRequest,
  options: ChatCompletionsOptions,
  maxTokensField: string,
): AsyncGenerator<StreamPart> {
  const secrets = secretsOf(config);
  const events = streamSse({
    url: options.chatUrl?.(config, request) ?? `${baseUrlFor(config, options.baseUrl)}/chat/completions`,
    fetch: options.fetch,
    method: 'POST',
    headers: options.headers?.(config) ?? authHeaders(config),
    body: requestBody(request, options, maxTokensField),
    config,
    signal: request.signal,
  });
  const pending = new Map<number, PendingToolCall>();
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let stop: StopReason = 'end';
  let lengthReported = false;
  let refused = false;
  try {
    for await (const event of events) {
      const data = event.data.trim();
      // `[DONE]` is the sentinel that ends the stream; heartbeats arrive as comments and never get here.
      if (!data || data === '[DONE]') continue;
      const chunk = parseJson<WireChunk>(data, secrets, 'A streamed chunk');
      // Some providers report a failure inside an otherwise healthy stream.
      if (chunk.error) throw errorFromWire(chunk.error, secrets);
      for (const choice of chunk.choices ?? []) {
        const text = choice.delta?.content;
        if (typeof text === 'string' && text.length > 0) yield { type: 'text', delta: text };
        for (const fragment of choice.delta?.tool_calls ?? []) mergeToolCall(pending, fragment);
        if (choice.finish_reason && stop !== 'length') stop = stopFrom(choice.finish_reason);
        if (choice.delta?.refusal) refused = true;
      }
      // The usage chunk arrives last and alone, so the last one seen is the whole call's.
      if (chunk.usage) {
        usage = {
          inputTokens: tokenCount(chunk.usage.prompt_tokens),
          outputTokens: tokenCount(chunk.usage.completion_tokens),
        };
      }
      if (stop === 'length') {
        // Report truncation before reading another event, which may fail.
        if (!lengthReported) yield { type: 'outputLimit' };
        lengthReported = true;
      }
    }
  } catch (error) {
    if (stop === 'length' && usage) yield { type: 'usage', ...usage };
    throw error;
  }
  if (refused && stop !== 'length') stop = 'filtered';
  if (stop !== 'length' && stop !== 'filtered')
    for (const call of [...pending.values()].sort((a, b) => a.index - b.index)) {
      if (request.deferToolArguments)
        yield { type: 'toolCallInput', name: call.name, input: call.arguments, encoding: 'json' };
      else yield { type: 'toolCall', call: completeToolCall(call, secrets) };
    }
  if (usage) yield { type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
  // A provider that forgets the finish reason still told us what happened by calling a tool.
  yield { type: 'done', stop: pending.size > 0 && stop === 'end' ? 'toolCalls' : stop };
}

function highestIndex(pending: Map<number, PendingToolCall>): number {
  let highest = -1;
  for (const index of pending.keys()) highest = Math.max(highest, index);
  return highest;
}

function keyFor(pending: Map<number, PendingToolCall>, fragment: WireFunctionCall): number {
  if (typeof fragment.index === 'number') return fragment.index;
  if (fragment.id) {
    for (const call of pending.values()) if (call.id === fragment.id) return call.index;
    // A new id means a new call, even from a provider that doesn't number them.
    return highestIndex(pending) + 1;
  }
  return highestIndex(pending);
}

function mergeToolCall(pending: Map<number, PendingToolCall>, fragment: WireFunctionCall): void {
  const index = keyFor(pending, fragment);
  const existing = pending.get(index);
  if (!existing) {
    pending.set(index, {
      index,
      id: fragment.id ?? '',
      name: fragment.function?.name ?? '',
      arguments: fragment.function?.arguments ?? '',
    });
    return;
  }
  if (fragment.id) existing.id = fragment.id;
  const name = fragment.function?.name;
  if (name) {
    // Providers send a name once, repeat it on every fragment, or split it; a fragment that already
    // contains what we have replaces it, and anything else continues it.
    existing.name = name.startsWith(existing.name) ? name : existing.name + name;
  }
  if (fragment.function?.arguments) existing.arguments += fragment.function.arguments;
}

function completeToolCall(call: PendingToolCall, secrets: readonly string[]): ToolCall {
  if (!call.name) {
    throw unexpectedResponse(`A tool call arrived without a name: ${call.id || '(no id)'}`);
  }
  return {
    // A provider that withholds ids still needs one for Rio to route the result back.
    id: call.id || `call_${call.index}`,
    name: call.name,
    arguments: parseToolArguments(call.arguments, secrets, call.name),
  };
}
