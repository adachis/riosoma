import type { RioTier } from '@riosoma/contracts';

/** One turn in the conversation sent to a model. */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; attachments?: MessageAttachment[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

/** A tool the model may call, described with JSON Schema. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Inline bytes keep uploaded documents separate from instructions and avoid remote fetching. */
export interface MessageAttachment {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf';
  data: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments; adapters never pass raw strings through */
  arguments: Record<string, unknown>;
  /** Provider data that must go back with the call on the next round, such as a thought signature */
  providerData?: Record<string, unknown>;
}

/** What a streaming call yields, the same for every provider. */
export type StreamPart =
  | { type: 'text'; delta: string }
  | { type: 'toolCall'; call: ToolCall }
  | { type: 'toolCallInput'; name: string; input: unknown; encoding: 'json' | 'value' }
  /** Truncation is authoritative even if later events fail before final usage and completion. */
  | { type: 'outputLimit' }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; stop: 'end' | 'toolCalls' | 'length' | 'filtered' };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Require one call to this tool, when the adapter supports forced choice for the model. */
  toolChoice?: { name: string };
  /** Schema calls inspect the stop reason before parsing any tool arguments. */
  deferToolArguments?: boolean;
  /** Attempts after the first, overriding the adapter's normal retry policy. */
  retries?: number;
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ProviderConfig {
  /** Absent for local providers that need none */
  apiKey?: string;
  /** Overrides the provider's own endpoint, for proxies, gateways, and local servers */
  baseUrl?: string;
  /** Extra headers some accounts require, such as a workspace ID */
  headers?: Record<string, string>;
  /** Milliseconds before a call with no progress gives up (default 60 seconds) */
  timeoutMs?: number;
  /** Deployment names belong to the account, rather than the underlying model catalog. */
  deployments?: string[];
  auth?: { mode: 'bearer' | 'header' | 'none'; header?: string };
  testModel?: string;
  /** The host supplies current conversation instructions and tools for a representative probe. */
  testRequest?: Pick<ChatRequest, 'messages' | 'tools'>;
  /** Temporary identity credentials are supplied by the host and never resolved by adapters. */
  aws?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string; region: string };
}

export type ModelCapability = 'embeddings' | 'ocr' | 'code' | 'image' | 'video';

export interface QueueJob {
  model: string;
  requestId: string;
}

export interface QueueAdapter {
  submit(
    config: ProviderConfig,
    model: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<QueueJob>;
  status(
    config: ProviderConfig,
    job: QueueJob,
    signal?: AbortSignal,
  ): Promise<'queued' | 'running' | 'completed'>;
  result(config: ProviderConfig, job: QueueJob, signal?: AbortSignal): Promise<Record<string, unknown>>;
  cancel(config: ProviderConfig, job: QueueJob, signal?: AbortSignal): Promise<void>;
}

export interface ModelInfo {
  model: string;
  name: string;
}

/**
 * One model provider.  Adapters talk HTTP with `fetch` and parse streams themselves, so there are
 * no vendor SDKs to keep up with.
 */
export interface ProviderAdapter {
  id: string;
  name: string;
  /** Runs on the organization's own hardware */
  local: boolean;
  /** The provider's own endpoint, when it has one that needs no configuration */
  baseUrl?: string;
  listModels(config: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]>;
  /** Checks credentials separately when catalog discovery cannot authenticate them */
  testConnection?(config: ProviderConfig, signal?: AbortSignal): Promise<void>;
  stream(config: ProviderConfig, request: ChatRequest): AsyncIterable<StreamPart>;
  /** False for models or protocols that cannot require a named tool. */
  supportsForcedToolChoice?(model: string): boolean;
  embed?(
    config: ProviderConfig,
    model: string,
    input: string[],
    signal?: AbortSignal,
  ): Promise<{ vectors: number[][]; inputTokens: number }>;
  queue?: QueueAdapter;
  /**
   * The name the footprint estimate's model data knows a model by: the provider there, by the
   * data's own names, and the model's exact name.  Absent, or null for a model, means no estimate.
   * It never offers a near match, since a guess would be worse than saying there's no estimate.
   */
  footprintModel?(model: string): FootprintModel | null;
}

/** A model as the footprint estimate's data names it. */
export interface FootprintModel {
  provider: string;
  model: string;
}

/** A model Riosoma knows how to use well, with what it costs when that's known. */
export interface RegistryModel {
  providerId: string;
  model: string;
  name: string;
  tiers: Array<RioTier | 'vision'>;
  /** US dollars per million tokens, or null when not known */
  price: { input: number; output: number } | null;
  contextTokens: number;
  /** Maximum output requested from this model */
  maxOutputTokens?: number;
  tools: boolean;
  forcedToolChoice?: boolean;
  capabilities?: ModelCapability[];
}

/** Why a provider call failed, as a message key people can act on plus the provider's words. */
export class ProviderError extends Error {
  constructor(
    readonly messageKey: string,
    readonly status?: number,
    readonly detail?: string,
    readonly retryable = false,
    readonly params?: Record<string, string>,
    options?: ErrorOptions,
  ) {
    super(detail ?? messageKey, options);
    this.name = 'ProviderError';
  }
}
