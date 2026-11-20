import type {
  ChatMessage,
  ChatRequest,
  ModelInfo,
  ProviderAdapter,
  ProviderConfig,
  StreamPart,
  ToolCall,
} from '../types.js';
import { errorFromWire, parseJson, secretsOf, unexpectedResponse } from './errors.js';
import { baseUrlFor, fetchJson, streamSse } from './http.js';
import { registerProvider } from './registry.js';
import { retryStream, withRetry } from './retry.js';
import {
  parseToolArguments,
  schemaFor,
  toolsFor,
  sortModels,
  stopFrom,
  tokenCount,
  type StopReason,
} from './wire.js';

/** The endpoint Rio talks to unless the organization points it somewhere else. */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
/** Every request names the wire format it expects; the API refuses one it doesn't know. */
const API_VERSION = '2023-06-01';
/** The Messages API insists on an output cap even when the caller has no opinion. */
const DEFAULT_MAX_TOKENS = 4_096;
const MAX_CATALOG_PAGES = 10;
/**
 * Models that still take a temperature.  Claude Opus 4.7 and every model after it refuse one
 * outright, so a model not named here runs at its default.
 */
const TAKES_TEMPERATURE = /^claude-(?:3|haiku-4|sonnet-4|opus-4(?:-[0-6])?(?:-\d{8})?$)/;

type WireBlock =
  | { type: 'image' | 'document'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface WireMessage {
  role: 'user' | 'assistant';
  content: WireBlock[];
}

interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface WireEvent {
  type?: string;
  index?: number;
  message?: { usage?: WireUsage; stop_reason?: string | null };
  content_block?: { type?: string; id?: string; name?: string; text?: string; input?: unknown };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null };
  usage?: WireUsage;
  error?: { message?: string; type?: string };
}

interface WireCatalog {
  data?: Array<{ id?: unknown; display_name?: unknown } | null> | null;
  has_more?: boolean;
}

/** A tool call whose argument JSON is still arriving, a fragment at a time. */
interface OpenToolCall {
  id: string;
  name: string;
  input: string;
}

function apiHeaders(config: ProviderConfig): Record<string, string> {
  const wire: Record<string, string> = { 'anthropic-version': API_VERSION };
  if (config.apiKey) wire['x-api-key'] = config.apiKey;
  // `ProviderConfig.headers` is merged over these, which is how an account that needs a workspace
  // header, or a gateway that wants its own authorization, gets one.
  return wire;
}

function push(wire: WireMessage[], role: 'user' | 'assistant', blocks: WireBlock[]): void {
  // Results for several calls in one round share the next person turn, and the API wants the roles
  // to alternate, so neighboring turns of one role become a single turn.
  const last = wire.at(-1);
  if (last && last.role === role) last.content.push(...blocks);
  else wire.push({ role, content: blocks });
}

function toWire(messages: readonly ChatMessage[]): { system?: string; messages: WireMessage[] } {
  const wire: WireMessage[] = [];
  const system: string[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'system': {
        // Instructions live beside the messages here, not inside them.
        const text = message.content.trim();
        if (text) system.push(text);
        break;
      }
      case 'user':
        push(wire, 'user', [
          { type: 'text', text: message.content },
          ...(message.attachments ?? []).map((file): WireBlock => ({
            type: file.mediaType === 'application/pdf' ? 'document' : 'image',
            source: { type: 'base64', media_type: file.mediaType, data: file.data },
          })),
        ]);
        break;
      case 'assistant': {
        const blocks: WireBlock[] = [];
        if (message.content) blocks.push({ type: 'text', text: message.content });
        for (const call of message.toolCalls ?? []) {
          blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {} });
        }
        if (blocks.length > 0) push(wire, 'assistant', blocks);
        break;
      }
      case 'tool':
        push(wire, 'user', [
          { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content },
        ]);
        break;
    }
  }
  return { system: system.length > 0 ? system.join('\n\n') : undefined, messages: wire };
}

function requestBody(request: ChatRequest): Record<string, unknown> {
  const wire = toWire(request.messages);
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
    messages: wire.messages,
  };
  if (wire.system !== undefined) body.system = wire.system;
  const tools = toolsFor(request);
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: schemaFor(tool.parameters),
    }));
  }
  if (request.toolChoice)
    body.tool_choice = { type: 'tool', name: request.toolChoice.name, disable_parallel_tool_use: true };
  if (request.temperature !== undefined && TAKES_TEMPERATURE.test(request.model))
    body.temperature = request.temperature;
  return body;
}

function completeToolCall(index: number, open: OpenToolCall, secrets: readonly string[]): ToolCall {
  if (!open.name) {
    throw unexpectedResponse(`A tool call arrived without a name: ${open.id || '(no id)'}`);
  }
  return {
    id: open.id || `call_${index}`,
    name: open.name,
    arguments: parseToolArguments(open.input, secrets, open.name),
  };
}

async function* streamMessages(config: ProviderConfig, request: ChatRequest): AsyncGenerator<StreamPart> {
  const secrets = secretsOf(config);
  const events = streamSse({
    url: `${baseUrlFor(config, ANTHROPIC_BASE_URL)}/v1/messages`,
    method: 'POST',
    headers: apiHeaders(config),
    body: requestBody(request),
    config,
    signal: request.signal,
  });
  const open = new Map<number, OpenToolCall>();
  const closed = new Map<number, OpenToolCall>();
  let inputTokens = 0;
  let outputTokens = 0;
  let usageSeen = false;
  let calls = 0;
  let stop: StopReason | undefined;
  let lengthReported = false;
  try {
    reading: for await (const event of events) {
      const data = event.data.trim();
      // A gateway in between may end the stream with the Chat Completions sentinel.
      if (!data || data === '[DONE]') continue;
      const parsed = parseJson<WireEvent>(data, secrets, 'A streamed event');
      switch (parsed.type ?? event.event) {
        case 'message_start': {
          const usage = parsed.message?.usage;
          if (usage) {
            inputTokens = tokenCount(usage.input_tokens);
            outputTokens = tokenCount(usage.output_tokens);
            usageSeen = true;
          }
          break;
        }
        case 'content_block_start': {
          const block = parsed.content_block;
          const index = parsed.index ?? open.size;
          if (block?.type === 'tool_use') {
            open.set(index, {
              id: block.id ?? '',
              name: block.name ?? '',
              input: typeof block.input === 'string' ? block.input : '',
            });
          } else if (typeof block?.text === 'string' && block.text.length > 0) {
            yield { type: 'text', delta: block.text };
          }
          break;
        }
        case 'content_block_delta': {
          const delta = parsed.delta;
          if (!delta) break;
          if (typeof delta.text === 'string' && delta.text.length > 0)
            yield { type: 'text', delta: delta.text };
          const fragment = delta.partial_json;
          if (typeof fragment === 'string') {
            const call = open.get(parsed.index ?? -1);
            if (call) call.input += fragment;
          }
          break;
        }
        case 'content_block_stop': {
          const index = parsed.index ?? -1;
          const call = open.get(index);
          if (call) {
            open.delete(index);
            calls += 1;
            closed.set(index, call);
          }
          break;
        }
        case 'message_delta': {
          if (parsed.delta?.stop_reason && stop !== 'length') stop = stopFrom(parsed.delta.stop_reason);
          const usage = parsed.usage;
          if (usage) {
            if (usage.input_tokens !== undefined) inputTokens = tokenCount(usage.input_tokens);
            // The running total arrives with each delta; the largest is the last one.
            outputTokens = Math.max(outputTokens, tokenCount(usage.output_tokens));
            usageSeen = true;
          }
          if (stop === 'length') {
            // Report truncation before reading another event, which may fail.
            if (!lengthReported) yield { type: 'outputLimit' };
            lengthReported = true;
          }
          break;
        }
        case 'message_stop':
          break reading;
        case 'error':
          // A failure mid-stream, after the status was already a healthy one.
          throw errorFromWire(parsed.error ?? { message: 'The provider reported an error' }, secrets);
        default:
          // `ping` keeps the connection warm, and new event types are added over time; both are noise.
          break;
      }
    }
  } catch (error) {
    if (stop === 'length' && usageSeen) yield { type: 'usage', inputTokens, outputTokens };
    throw error;
  }
  // A stream that ends without closing its blocks still carries whole calls.
  if (stop !== 'length' && stop !== 'filtered')
    for (const [index, call] of [...closed, ...open]) {
      if (open.has(index)) calls += 1;
      if (request.deferToolArguments)
        yield { type: 'toolCallInput', name: call.name, input: call.input, encoding: 'json' };
      else yield { type: 'toolCall', call: completeToolCall(index, call, secrets) };
    }
  if (usageSeen) yield { type: 'usage', inputTokens, outputTokens };
  yield { type: 'done', stop: stop ?? (calls > 0 ? 'toolCalls' : 'end') };
}

async function listModels(config: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]> {
  return withRetry(
    async () => {
      const models: ModelInfo[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
        const url = new URL(`${baseUrlFor(config, ANTHROPIC_BASE_URL)}/v1/models`);
        url.searchParams.set('limit', '100');
        if (after) url.searchParams.set('after_id', after);
        const catalog = await fetchJson<WireCatalog>({
          url: url.toString(),
          method: 'GET',
          headers: apiHeaders(config),
          config,
          signal,
        });
        const entries = catalog.data ?? [];
        for (const entry of entries) {
          const id = typeof entry?.id === 'string' ? entry.id : undefined;
          if (!id) continue;
          const label = typeof entry?.display_name === 'string' ? entry.display_name.trim() : '';
          models.push({ model: id, name: label || id });
        }
        if (!catalog.has_more || entries.length === 0) break;
        const last = entries.at(-1);
        after = last && typeof last.id === 'string' ? last.id : undefined;
        if (!after) break;
      }
      return sortModels(models);
    },
    { signal },
  );
}

export const anthropicProvider: ProviderAdapter = {
  id: 'anthropic',
  name: 'Anthropic',
  local: false,
  supportsForcedToolChoice: (model) => TAKES_TEMPERATURE.test(model),
  baseUrl: ANTHROPIC_BASE_URL,
  listModels,
  stream: (config, request) =>
    retryStream(() => streamMessages(config, request), { signal: request.signal, retries: request.retries }),
  footprintModel: (model) => ({ provider: 'anthropic', model }),
};

registerProvider(anthropicProvider);
