import { ProviderError, type ChatRequest, type ModelInfo, type StreamPart, type ToolSpec } from '../types.js';
import { snippet, unexpectedResponse } from './errors.js';

/** Why a model stopped, in Riosoma's words rather than any provider's. */
export type StopReason = Extract<StreamPart, { type: 'done' }>['stop'];

/**
 * Every provider's stop reasons, mapped once.  A reason nobody has seen is treated as an ordinary
 * end: the reply is there, and guessing "truncated" would hide text that is complete.
 */
const STOPS: Readonly<Record<string, StopReason>> = {
  stop: 'end',
  end_turn: 'end',
  stop_sequence: 'end',
  pause_turn: 'end',
  tool_calls: 'toolCalls',
  tool_use: 'toolCalls',
  function_call: 'toolCalls',
  length: 'length',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  content_filter: 'filtered',
  refusal: 'filtered',
  safety: 'filtered',
  prohibited_content: 'filtered',
  recitation: 'filtered',
  blocklist: 'filtered',
  spii: 'filtered',
};

export function stopFrom(reason: string | null | undefined): StopReason {
  // Providers disagree about case as much as about names.
  return (reason ? STOPS[reason.toLowerCase()] : undefined) ?? 'end';
}

/**
 * Reads a tool call's arguments.  Every provider sends them as JSON text, sometimes a fragment at a
 * time, and Rio runs them as data: a model that produces broken JSON gets an error the person sees,
 * never a half-parsed call.
 */
export function parseToolArguments(
  raw: string,
  secrets: readonly string[],
  name: string,
): Record<string, unknown> {
  const text = raw.trim();
  // A call with no parameters arrives as an empty string from some providers.
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw unexpectedResponse(
      `The model sent arguments for ${name} that were not JSON: ${snippet(text, secrets)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw unexpectedResponse(`The model sent arguments for ${name} that were not an object`);
  }
  return parsed as Record<string, unknown>;
}

/** A provider that already parsed a call's arguments still owes us an object. */
export function asArguments(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw unexpectedResponse(`The model sent arguments for ${name} that were not an object`);
}

/** A tool's parameter schema, with the object type providers insist on even when it's obvious. */
export function schemaFor(parameters: Record<string, unknown>): Record<string, unknown> {
  return typeof parameters.type === 'string' ? parameters : { type: 'object', ...parameters };
}

/** Forced choice must name an offered tool, and other tools cannot compete with it. */
export function toolsFor(request: ChatRequest): ToolSpec[] {
  const tools = request.tools ?? [];
  if (!request.toolChoice) return tools;
  const selected = tools.filter((tool) => tool.name === request.toolChoice!.name);
  if (selected.length !== 1) throw new ProviderError('ai.provider.badRequest');
  return selected;
}

/**
 * Models worth offering from a catalog.  A provider's list also carries embeddings, speech, image,
 * and moderation models the chat endpoint cannot serve, and showing those would only produce a
 * confusing failure later.  Admins can still pick any model by hand.
 */
const NOT_CHAT: readonly RegExp[] = [
  /embed/i,
  /whisper|transcribe|translate|(^|[-.])tts([-.]|$)|speech/i,
  /dall-?e|imagen|(^|[-.])sora([-.]|$)/i,
  /realtime/i,
  /moderation|guard|rerank|(^|[-.])clip([-.]|$)/i,
  // Only the legacy completion-only models are named this way; an instruction-tuned open model
  // is very much a chat model.
  /^gpt-[a-z0-9.-]*-instruct$/i,
  /^(davinci|babbage|curie|ada)([-.]|$)/i,
];

export function isChatModel(model: string): boolean {
  return !NOT_CHAT.some((pattern) => pattern.test(model));
}

/** A catalog in a stable order, so the admin page doesn't shuffle between visits. */
export function sortModels(models: ModelInfo[]): ModelInfo[] {
  return models.sort((a, b) => a.model.localeCompare(b.model));
}

/** A count a provider reports, made safe to add up and to bill against. */
export function tokenCount(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
