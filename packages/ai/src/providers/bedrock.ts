import { createHash, createHmac } from 'node:crypto';
import { REGISTRY } from '../registry.js';
import {
  ProviderError,
  type ChatRequest,
  type ProviderAdapter,
  type ProviderConfig,
  type StreamPart,
} from '../types.js';
import { filteredResponse, unexpectedResponse } from './errors.js';
import { baseUrlFor, fetchJson, mergeHeaders } from './http.js';
import { registerProvider } from './registry.js';
import { retryStream, withRetry } from './retry.js';
import { asArguments, schemaFor, stopFrom, tokenCount, toolsFor } from './wire.js';

function endpoint(config: ProviderConfig): string {
  return baseUrlFor(config, `https://bedrock-runtime.${config.aws?.region ?? 'us-east-1'}.amazonaws.com`);
}

function canonicalPath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '..') segments.pop();
    else if (segment && segment !== '.') segments.push(segment);
  }
  const normalized = `/${segments.join('/')}${path.endsWith('/') && segments.length ? '/' : ''}`;
  // SigV4 escapes the normalized wire path again, including existing percent escapes.
  return encodeURIComponent(normalized)
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, '/');
}

/** Signs the exact JSON bytes sent over HTTP, including temporary session credentials. */
function headers(config: ProviderConfig, url: string, body?: unknown): Record<string, string> {
  if (!config.aws)
    return mergeHeaders(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}, config.headers);
  const credentials = config.aws;
  const target = new URL(url);
  const stamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = stamp.slice(0, 8);
  const scope = `${day}/${credentials.region}/bedrock/aws4_request`;
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest();
  const signed = mergeHeaders(config.headers, {
    host: target.host,
    'x-amz-date': stamp,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
  });
  delete signed.authorization;
  const names = Object.keys(signed).sort();
  const canonical = [
    body === undefined ? 'GET' : 'POST',
    canonicalPath(target.pathname),
    target.searchParams.toString(),
    names.map((name) => `${name}:${signed[name]!.trim().replace(/\s+/g, ' ')}\n`).join(''),
    names.join(';'),
    hash(body === undefined ? '' : JSON.stringify(body)),
  ].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), credentials.region), 'bedrock'),
    'aws4_request',
  );
  const signature = createHmac('sha256', key)
    .update(`AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${hash(canonical)}`)
    .digest('hex');
  return {
    ...signed,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

function bodyFor(request: ChatRequest): Record<string, unknown> {
  const tools = toolsFor(request);
  const system: Array<{ text: string }> = [];
  const messages: Array<{ role: string; content: Record<string, unknown>[] }> = [];
  for (const message of request.messages) {
    if (message.role === 'system') {
      system.push({ text: message.content });
      continue;
    }
    const content: Record<string, unknown>[] = [];
    if (message.role === 'tool')
      content.push({ toolResult: { toolUseId: message.toolCallId, content: [{ text: message.content }] } });
    else {
      if (message.content) content.push({ text: message.content });
      if (message.role === 'assistant')
        for (const call of message.toolCalls ?? [])
          content.push({ toolUse: { toolUseId: call.id, name: call.name, input: call.arguments } });
      if (message.role === 'user')
        for (const file of message.attachments ?? []) {
          content.push(
            file.mediaType === 'application/pdf'
              ? { document: { format: 'pdf', name: 'document', source: { bytes: file.data } } }
              : { image: { format: file.mediaType.slice(6), source: { bytes: file.data } } },
          );
        }
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  }
  return {
    messages,
    ...(system.length ? { system } : {}),
    inferenceConfig: {
      ...(request.maxOutputTokens ? { maxTokens: request.maxOutputTokens } : {}),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    },
    ...(tools.length
      ? {
          toolConfig: {
            ...(request.toolChoice ? { toolChoice: { tool: { name: request.toolChoice.name } } } : {}),
            tools: tools.map((tool) => ({
              toolSpec: {
                name: tool.name,
                description: tool.description,
                inputSchema: { json: schemaFor(tool.parameters) },
              },
            })),
          },
        }
      : {}),
  };
}

interface Reply {
  output?: {
    message?: {
      content?: Array<{ text?: string; toolUse?: { toolUseId: string; name: string; input: unknown } }>;
    };
  };
  usage?: { inputTokens?: number; outputTokens?: number };
  stopReason?: string;
}

async function* converse(config: ProviderConfig, request: ChatRequest): AsyncGenerator<StreamPart> {
  const url = `${endpoint(config)}/model/${encodeURIComponent(request.model)}/converse`;
  const body = bodyFor(request);
  const response = await fetchJson<Reply>({
    url,
    body,
    config: { ...config, headers: headers(config, url, body) },
    signal: request.signal,
  });
  if (['guardrail_intervened', 'content_filtered'].includes(response.stopReason ?? '')) {
    if (!request.deferToolArguments) throw filteredResponse();
    if (response.usage)
      yield {
        type: 'usage',
        inputTokens: tokenCount(response.usage.inputTokens),
        outputTokens: tokenCount(response.usage.outputTokens),
      };
    yield { type: 'done', stop: 'filtered' };
    return;
  }
  const content = response.output?.message?.content;
  if (!Array.isArray(content) || !response.stopReason)
    throw unexpectedResponse('The conversation response had no message or stop reason');
  for (const part of content) {
    if (part.text) yield { type: 'text', delta: part.text };
    if (part.toolUse && stopFrom(response.stopReason) !== 'length') {
      if (request.deferToolArguments)
        yield {
          type: 'toolCallInput',
          name: part.toolUse.name,
          input: part.toolUse.input,
          encoding: 'value',
        };
      else
        yield {
          type: 'toolCall',
          call: {
            id: part.toolUse.toolUseId,
            name: part.toolUse.name,
            arguments: asArguments(part.toolUse.input, part.toolUse.name),
          },
        };
    }
  }
  if (response.usage)
    yield {
      type: 'usage',
      inputTokens: tokenCount(response.usage.inputTokens),
      outputTokens: tokenCount(response.usage.outputTokens),
    };
  yield { type: 'done', stop: stopFrom(response.stopReason) };
}

export const bedrockProvider: ProviderAdapter = {
  id: 'bedrock',
  name: 'Amazon Bedrock',
  local: false,
  supportsForcedToolChoice: (model) => /(?:^|\.)(?:amazon\.nova-|anthropic\.claude-3)/.test(model),
  async testConnection(config, signal) {
    if (!config.aws) {
      if (!config.apiKey) throw new ProviderError('ai.provider.unauthorized');
      throw new ProviderError('ai.test.unverified');
    }
    await bedrockProvider.listModels(config, signal);
  },
  async listModels(config, signal) {
    const known = REGISTRY.filter((model) => model.providerId === 'bedrock');
    if (!config.aws) {
      // Bearer keys authorize runtime calls.  Model discovery uses the identity control plane.
      if (!config.apiKey) throw new ProviderError('ai.provider.unauthorized');
      return known.map(({ model, name }) => ({ model, name }));
    }
    return withRetry(
      async () => {
        const url = `${endpoint(config).replace('bedrock-runtime.', 'bedrock.')}/foundation-models`;
        const result = await fetchJson<{
          modelSummaries: Array<{ modelId: string; modelName: string; outputModalities: string[] }>;
        }>({ url, config: { ...config, headers: headers(config, url) }, signal });
        return result.modelSummaries
          .filter((model) => model.outputModalities.includes('TEXT'))
          .map((model) => ({ model: model.modelId, name: model.modelName }));
      },
      { signal },
    );
  },
  stream: (config, request) =>
    retryStream(() => converse(config, request), { signal: request.signal, retries: request.retries }),
};
registerProvider(bedrockProvider);
