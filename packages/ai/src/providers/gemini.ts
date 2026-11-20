import type {
  ChatMessage,
  ChatRequest,
  ModelInfo,
  ProviderAdapter,
  ProviderConfig,
  StreamPart,
} from '../types.js';
import { errorFromWire, filteredResponse, parseJson, secretsOf } from './errors.js';
import { baseUrlFor, fetchJson, streamSse } from './http.js';
import { registerProvider } from './registry.js';
import { retryStream, withRetry } from './retry.js';
import {
  asArguments,
  schemaFor,
  toolsFor,
  sortModels,
  stopFrom,
  tokenCount,
  type StopReason,
} from './wire.js';

/** The endpoint Rio talks to unless the organization points it somewhere else. */
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
/** A catalog is a few pages at most; stop rather than follow a broken token forever. */
const MAX_CATALOG_PAGES = 10;

interface WirePart {
  inlineData?: { mimeType: string; data: string };
  text?: string;
  /** Marks the model's own reasoning, which is billed but isn't part of the reply */
  thought?: boolean;
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name?: string; response?: unknown };
  /** Thinking models sign each function call, and the next round must send the signature back */
  thoughtSignature?: string;
}

interface WireContent {
  role: 'user' | 'model';
  parts: WirePart[];
}

interface WireChunk {
  candidates?: Array<{
    index?: number;
    content?: { role?: string; parts?: WirePart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; code?: number; status?: string };
}

interface WireCatalog {
  models?: Array<{
    name?: unknown;
    displayName?: unknown;
    supportedGenerationMethods?: unknown;
  }> | null;
  nextPageToken?: string;
}

/** The key travels in a header.  A URL ends up in logs, in a proxy's history, and in a browser's. */
function keyHeaders(config: ProviderConfig): Record<string, string> {
  // Project credentials use the authorization header and must never become a public-service key.
  const bearer = Object.keys(config.headers ?? {}).some((name) => name.toLowerCase() === 'authorization');
  return config.apiKey && !bearer ? { 'x-goog-api-key': config.apiKey } : {};
}

/**
 * A tuned model is addressed by its own collection, so a name that already carries a path is left
 * alone rather than escaped into something the API can't route.
 */
function modelPath(model: string): string {
  return model.includes('/') ? model : `models/${encodeURIComponent(model)}`;
}

/** Rio's tool results are JSON text; the wire wants a structured response. */
function functionResponsePayload(content: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Plain text is a perfectly good result; it just needs a field to live in.
  }
  return { result: content };
}

function pushContent(contents: WireContent[], role: 'user' | 'model', parts: WirePart[]): void {
  // One role's neighboring turns become a single turn, which is how several results to several
  // calls in one round are meant to be sent.
  const last = contents.at(-1);
  if (last && last.role === role) last.parts.push(...parts);
  else contents.push({ role, parts });
}

function toWire(messages: readonly ChatMessage[]): { contents: WireContent[]; system?: string } {
  const contents: WireContent[] = [];
  const system: string[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'system': {
        const text = message.content.trim();
        if (text) system.push(text);
        break;
      }
      case 'user':
        pushContent(contents, 'user', [
          { text: message.content },
          ...(message.attachments ?? []).map((file) => ({
            inlineData: { mimeType: file.mediaType, data: file.data },
          })),
        ]);
        break;
      case 'assistant': {
        const parts: WirePart[] = [];
        if (message.content) parts.push({ text: message.content });
        for (const call of message.toolCalls ?? []) {
          const signature = call.providerData?.thoughtSignature;
          parts.push({
            functionCall: { name: call.name, args: call.arguments ?? {} },
            ...(typeof signature === 'string' ? { thoughtSignature: signature } : {}),
          });
        }
        if (parts.length > 0) pushContent(contents, 'model', parts);
        break;
      }
      case 'tool':
        // A result comes back in a user turn: the API has no role of its own for one.
        pushContent(contents, 'user', [
          { functionResponse: { name: message.name, response: functionResponsePayload(message.content) } },
        ]);
        break;
    }
  }
  return { contents, system: system.length > 0 ? system.join('\n\n') : undefined };
}

function requestBody(request: ChatRequest): Record<string, unknown> {
  const wire = toWire(request.messages);
  const body: Record<string, unknown> = { contents: wire.contents };
  if (wire.system !== undefined) body.systemInstruction = { parts: [{ text: wire.system }] };
  const tools = toolsFor(request);
  if (tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          // `parameters` takes only an OpenAPI subset, which refuses `$ref`, `propertyNames`, and
          // other ordinary JSON Schema.  This field takes JSON Schema itself.
          parametersJsonSchema: withoutDialect(schemaFor(tool.parameters)),
        })),
      },
    ];
  }
  if (request.toolChoice)
    body.toolConfig = {
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [request.toolChoice.name] },
    };
  const generation: Record<string, unknown> = {};
  if (request.maxOutputTokens) generation.maxOutputTokens = request.maxOutputTokens;
  if (request.temperature !== undefined) generation.temperature = request.temperature;
  if (Object.keys(generation).length > 0) body.generationConfig = generation;
  return body;
}

async function* generate(config: ProviderConfig, request: ChatRequest): AsyncGenerator<StreamPart> {
  const secrets = secretsOf(config);
  const events = streamSse({
    url: `${baseUrlFor(config, GEMINI_BASE_URL)}/${modelPath(request.model)}:streamGenerateContent?alt=sse`,
    method: 'POST',
    headers: keyHeaders(config),
    body: requestBody(request),
    config,
    signal: request.signal,
  });
  const calls: Array<{ name: string; args: unknown; signature?: string }> = [];
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let stop: StopReason = 'end';
  let lengthReported = false;
  try {
    for await (const event of events) {
      const data = event.data.trim();
      // A gateway in between may end the stream with the Chat Completions sentinel.
      if (!data || data === '[DONE]') continue;
      const chunk = parseJson<WireChunk>(data, secrets, 'A streamed chunk');
      if (chunk.error) {
        throw errorFromWire(
          { message: chunk.error.message, type: chunk.error.status, status: chunk.error.code },
          secrets,
        );
      }
      // A blocked prompt arrives with no candidates at all, and the reason is worth repeating.
      const blocked = chunk.promptFeedback?.blockReason;
      if (blocked) throw filteredResponse(`The provider blocked the request: ${blocked}`);
      for (const candidate of chunk.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          const call = part.functionCall;
          if (call?.name) {
            calls.push({ name: call.name, args: call.args, signature: part.thoughtSignature });
            continue;
          }
          if (typeof part.text === 'string' && part.text.length > 0 && !part.thought) {
            yield { type: 'text', delta: part.text };
          }
        }
        if (candidate.finishReason && stop !== 'length') stop = stopFrom(candidate.finishReason);
      }
      // Every chunk repeats the running totals, so the last one is the whole call's.
      if (chunk.usageMetadata) {
        usage = {
          inputTokens: tokenCount(chunk.usageMetadata.promptTokenCount),
          // Reasoning tokens are billed as output even though they never reach the person.
          outputTokens:
            tokenCount(chunk.usageMetadata.candidatesTokenCount) +
            tokenCount(chunk.usageMetadata.thoughtsTokenCount),
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
  if (stop !== 'length' && stop !== 'filtered')
    for (const [index, call] of calls.entries()) {
      if (request.deferToolArguments)
        yield { type: 'toolCallInput', name: call.name, input: call.args, encoding: 'value' };
      else
        yield {
          type: 'toolCall',
          call: {
            id: `call_${index}`,
            name: call.name,
            arguments: asArguments(call.args, call.name),
            ...(call.signature ? { providerData: { thoughtSignature: call.signature } } : {}),
          },
        };
    }
  if (usage) yield { type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
  // Calling a function is a reason to stop in itself, and not every model reports one alongside it.
  yield { type: 'done', stop: calls.length > 0 && stop === 'end' ? 'toolCalls' : stop };
}

async function listModels(config: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]> {
  return withRetry(
    async () => {
      const models: ModelInfo[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
        const url = new URL(`${baseUrlFor(config, GEMINI_BASE_URL)}/models`);
        url.searchParams.set('pageSize', '1000');
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const catalog = await fetchJson<WireCatalog>({
          url: url.toString(),
          method: 'GET',
          headers: keyHeaders(config),
          config,
          signal,
        });
        for (const entry of catalog.models ?? []) {
          const name = typeof entry?.name === 'string' ? entry.name : undefined;
          if (!name) continue;
          const methods = entry?.supportedGenerationMethods;
          // The catalog also lists embedding and image models, which can't hold a conversation.
          if (!Array.isArray(methods) || !methods.includes('generateContent')) continue;
          const model = name.replace(/^models\//, '');
          const label = typeof entry?.displayName === 'string' ? entry.displayName.trim() : '';
          models.push({ model, name: label || model });
        }
        const next = catalog.nextPageToken;
        pageToken = typeof next === 'string' && next.length > 0 ? next : undefined;
        if (!pageToken) break;
      }
      return sortModels(models);
    },
    { signal },
  );
}

export const geminiProvider: ProviderAdapter = {
  id: 'gemini',
  name: 'Gemini',
  local: false,
  supportsForcedToolChoice: () => true,
  baseUrl: GEMINI_BASE_URL,
  listModels,
  stream: (config, request) =>
    retryStream(() => generate(config, request), { signal: request.signal, retries: request.retries }),
  // A tuned model's name carries its own path, and the estimate's data has no tuned models.
  footprintModel: (model) => (model.includes('/') ? null : { provider: 'google_genai', model }),
};

registerProvider(geminiProvider);

/** The dialect marker is the one JSON Schema key this field refuses at the top level. */
function withoutDialect(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = schema;
  return rest;
}
