import {
  ProviderError,
  type ChatRequest,
  type ProviderAdapter,
  type ProviderConfig,
  type StreamPart,
} from './types.js';
import { PROVIDER_MESSAGE_KEYS, providerFailure, type ProviderFailure } from './providers/errors.js';
import { REGISTRY } from './registry.js';

/** Validation stays with the caller, which can retain checks not expressible in JSON Schema. */
export interface OutputSchema<T> {
  jsonSchema: Record<string, unknown>;
  validate(
    value: unknown,
  ): { valid: true; data: T } | { valid: false; errors: readonly OutputValidationError[] };
}

export interface OutputValidationError {
  code: string;
  path: readonly PropertyKey[];
  detail?: string;
}

export interface SchemaOutputUsage {
  inputTokens: number;
  outputTokens: number;
  reported: boolean;
  outputCharacters: number;
  ms: number;
  started: boolean;
}

export type SchemaOutputResult<T> = (
  | { ok: true; value: T }
  | { ok: false; reason: 'cutOff' | 'refused' | 'unavailable' | 'keyRefused' }
  | { ok: false; reason: 'invalid'; errors: readonly OutputValidationError[] }
) & { usage: SchemaOutputUsage; failure?: ProviderFailure };

const OUTPUT_TOOL = 'submit_output';

/** Schema resources keep their own roots.  Literal data and property names are preserved. */
function nestedSchema(value: unknown, rewriteReferences = true): unknown {
  if (Array.isArray(value)) return value.map((child) => nestedSchema(child, rewriteReferences));
  if (!value || typeof value !== 'object') return value;
  const rewrite = rewriteReferences && typeof (value as Record<string, unknown>).$id !== 'string';
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === '$ref' && rewrite && typeof child === 'string' && (child === '#' || child.startsWith('#/'))
        ? `#/properties/value${child.slice(1)}`
        : ['const', 'enum', 'default', 'examples'].includes(key)
          ? child
          : [
                '$defs',
                'definitions',
                'properties',
                'patternProperties',
                'dependentSchemas',
                'dependencies',
              ].includes(key) &&
              child &&
              typeof child === 'object' &&
              !Array.isArray(child)
            ? Object.fromEntries(
                Object.entries(child).map(([name, entry]) => [name, nestedSchema(entry, rewrite)]),
              )
            : nestedSchema(child, rewrite),
    ]),
  );
}

/** A local repair removes wrappers and trailing commas without changing quoted data. */
function parseReply(text: string): unknown {
  const bare = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(bare) as unknown;
  } catch {
    let repaired = '';
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < bare.length; index++) {
      const char = bare[index]!;
      if (!quoted && char === ',' && /^\s*[}\]]/.test(bare.slice(index + 1))) continue;
      repaired += char;
      if (escaped) escaped = false;
      else if (quoted && char === '\\') escaped = true;
      else if (char === '"') quoted = !quoted;
    }
    return JSON.parse(repaired) as unknown;
  }
}

/** One attempt, with validation only after the provider says the output is complete. */
export async function schemaOutput<T>(
  adapter: ProviderAdapter,
  config: ProviderConfig,
  schema: OutputSchema<T>,
  request: ChatRequest,
): Promise<SchemaOutputResult<T>> {
  const started = performance.now();
  const usage: SchemaOutputUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reported: false,
    outputCharacters: 0,
    ms: 0,
    started: false,
  };
  const invalid = (code: string): SchemaOutputResult<T> => ({
    ok: false,
    reason: 'invalid',
    errors: [{ code, path: [] }],
    usage,
  });
  const known = REGISTRY.find((entry) => entry.providerId === adapter.id && entry.model === request.model);
  const forced =
    known?.forcedToolChoice !== false && (adapter.supportsForcedToolChoice?.(request.model) ?? false);
  // Wrapping the value allows arrays, scalars, and null while every tool still takes an object.
  const { $schema: _dialect, ...valueSchema } = schema.jsonSchema;
  const toolSchema = {
    type: 'object',
    properties: { value: nestedSchema(valueSchema) },
    required: ['value'],
    additionalProperties: false,
  };
  let messages = request.messages;
  if (!forced) {
    const instructions = `Return only JSON matching this schema: ${JSON.stringify(schema.jsonSchema)}`;
    const [first, ...rest] = request.messages;
    messages =
      first?.role === 'system'
        ? [{ ...first, content: `${first.content}\n\n${instructions}` }, ...rest]
        : [{ role: 'system', content: instructions }, ...request.messages];
  }
  const call: ChatRequest = {
    ...request,
    retries: 0,
    deferToolArguments: true,
    tools: forced
      ? [{ name: OUTPUT_TOOL, description: 'Return the requested value.', parameters: toolSchema }]
      : undefined,
    toolChoice: forced ? { name: OUTPUT_TOOL } : undefined,
    messages,
  };
  let text = '';
  let stop: Extract<StreamPart, { type: 'done' }>['stop'] | undefined;
  const inputs: Array<{ name: string; input: unknown; encoding: 'json' | 'value' }> = [];
  try {
    usage.started = true;
    for await (const part of adapter.stream(config, call)) {
      switch (part.type) {
        case 'text':
          text += part.delta;
          usage.outputCharacters += part.delta.length;
          break;
        case 'toolCallInput':
          inputs.push(part);
          usage.outputCharacters +=
            typeof part.input === 'string' ? part.input.length : JSON.stringify(part.input ?? {}).length;
          break;
        case 'toolCall':
          inputs.push({ name: part.call.name, input: part.call.arguments, encoding: 'value' });
          usage.outputCharacters += JSON.stringify(part.call.arguments).length;
          break;
        case 'usage':
          usage.inputTokens = part.inputTokens;
          usage.outputTokens = part.outputTokens;
          usage.reported = true;
          break;
        case 'outputLimit':
          stop = 'length';
          break;
        case 'done':
          // A later marker must never turn a truncated reply into a complete one.
          if (stop !== 'length') stop = part.stop;
          break;
      }
    }
    if (stop === 'length') return { ok: false, reason: 'cutOff', usage };
    if (stop === 'filtered') return { ok: false, reason: 'refused', usage };
    if (stop === undefined) return { ok: false, reason: 'unavailable', usage };
    let value: unknown;
    try {
      if (forced) {
        if (inputs.length !== 1 || inputs[0]!.name !== OUTPUT_TOOL) return invalid('toolChoice');
        const input = inputs[0]!;
        const envelope: unknown = input.encoding === 'json' ? JSON.parse(String(input.input)) : input.input;
        if (
          !envelope ||
          typeof envelope !== 'object' ||
          Array.isArray(envelope) ||
          !Object.hasOwn(envelope, 'value') ||
          Object.keys(envelope).length !== 1
        )
          return invalid('toolArguments');
        value = (envelope as { value: unknown }).value;
      } else value = parseReply(text);
    } catch {
      return invalid('json');
    }
    const checked = schema.validate(value);
    return checked.valid
      ? { ok: true, value: checked.data, usage }
      : { ok: false, reason: 'invalid', errors: checked.errors, usage };
  } catch (error) {
    const failure = providerFailure(error);
    const keyRefused =
      failure.messageKey === PROVIDER_MESSAGE_KEYS.unauthorized || [401, 403].includes(failure.status ?? 0);
    if (!keyRefused && stop === 'length') return { ok: false, reason: 'cutOff', usage, failure };
    return {
      ok: false,
      reason: keyRefused
        ? 'keyRefused'
        : error instanceof ProviderError && error.messageKey === PROVIDER_MESSAGE_KEYS.filtered
          ? 'refused'
          : 'unavailable',
      usage,
      failure,
    };
  } finally {
    usage.ms = performance.now() - started;
  }
}
