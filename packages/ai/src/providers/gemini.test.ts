import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { providerFor, type ChatRequest, type ProviderConfig } from '../index.js';
import type { ProviderError } from '../types.js';
import { PROVIDER_MESSAGE_KEYS } from './errors.js';
import {
  callsOf,
  collect,
  conversation,
  failureOf,
  lastBody,
  lastRequest,
  startStub,
  stopOf,
  textOf,
  TOOL,
  usageOf,
  type StubServer,
} from './harness.test-helpers.js';

const KEY = 'synthetic-gemini-key';
const provider = providerFor('gemini');

let stub: StubServer;

beforeAll(async () => {
  stub = await startStub();
});

afterEach(() => {
  stub.requests.length = 0;
  stub.handler = (_request, respond) => respond.json(500, { error: { message: 'No handler was set' } });
});

afterAll(async () => {
  await stub.stop();
});

function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { apiKey: KEY, baseUrl: stub.baseUrl, ...overrides };
}

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return { model: 'gemini-test', messages: [{ role: 'user', content: 'Hello' }], ...overrides };
}

function chunk(payload: Record<string, unknown>): { data: string } {
  return { data: JSON.stringify(payload) };
}

function text(delta: string, finish?: string, usage?: Record<string, number>): { data: string } {
  return chunk({
    candidates: [{ content: { role: 'model', parts: [{ text: delta }] }, index: 0, finishReason: finish }],
    ...(usage ? { usageMetadata: usage } : {}),
  });
}

describe('the Gemini wire format', () => {
  it('sends tool schemas as JSON Schema, without the dialect marker Gemini refuses', async () => {
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { filter: { $ref: '#/definitions/Group' } },
      definitions: { Group: { type: 'object', propertyNames: { type: 'string' } } },
    };
    stub.handler = (_request, respond) => void respond.sse([text('Done.', 'STOP')]);
    await collect(
      provider.stream(
        config(),
        request({ tools: [{ name: 'find', description: 'Find', parameters: schema }] }),
      ),
    );
    const body = lastBody(stub) as { tools: Array<{ functionDeclarations: Array<Record<string, unknown>> }> };
    const declaration = body.tools[0]!.functionDeclarations[0]!;
    expect(declaration.parameters).toBeUndefined();
    expect(declaration.parametersJsonSchema).toEqual({
      type: 'object',
      properties: { filter: { $ref: '#/definitions/Group' } },
      definitions: { Group: { type: 'object', propertyNames: { type: 'string' } } },
    });
  });

  it('sends the key in a header and never in the address', async () => {
    stub.handler = (_request, respond) => void respond.sse([text('Hello', 'STOP')]);
    await collect(provider.stream(config(), request()));

    const sent = lastRequest(stub);
    expect(sent.url).toBe('/models/gemini-test:streamGenerateContent?alt=sse');
    expect(sent.url).not.toContain(KEY);
    expect(sent.headers['x-goog-api-key']).toBe(KEY);
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.body).not.toContain(KEY);
  });

  it('leaves a tuned model address alone', async () => {
    stub.handler = (_request, respond) => void respond.sse([text('Hello', 'STOP')]);
    await collect(provider.stream(config(), request({ model: 'tunedModels/rio-9' })));
    expect(lastRequest(stub).url).toBe('/tunedModels/rio-9:streamGenerateContent?alt=sse');
  });

  it('maps a conversation, its instructions, and its tools', async () => {
    stub.handler = (_request, respond) => void respond.sse([text('Forty-two.', 'STOP')]);
    await collect(
      provider.stream(
        config(),
        request({ messages: conversation(), tools: [TOOL], maxOutputTokens: 700, temperature: 0.4 }),
      ),
    );

    expect(lastBody(stub)).toEqual({
      contents: [
        { role: 'user', parts: [{ text: 'How many rows are in Orders?' }] },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'count_records', args: { tableId: 'tblOrders' } } }],
        },
        // A result comes back in a person turn, which is the only role the API has for one, and
        // neighboring turns of one role join up so the sequence still alternates.
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'count_records', response: { count: 42 } } },
            { text: 'And last month?' },
          ],
        },
      ],
      systemInstruction: { parts: [{ text: 'You are Rio.' }] },
      tools: [
        {
          functionDeclarations: [
            { name: TOOL.name, description: TOOL.description, parametersJsonSchema: TOOL.parameters },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 700, temperature: 0.4 },
    });
  });

  it('groups two results for two calls into one turn', async () => {
    stub.handler = (_request, respond) => void respond.sse([text('Both counted.', 'STOP')]);
    await collect(
      provider.stream(
        config(),
        request({
          messages: [
            { role: 'user', content: 'Count both' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [
                { id: 'call_1', name: 'count_records', arguments: { tableId: 'tbl1' } },
                { id: 'call_2', name: 'count_records', arguments: { tableId: 'tbl2' } },
              ],
            },
            { role: 'tool', toolCallId: 'call_1', name: 'count_records', content: '{"count":1}' },
            { role: 'tool', toolCallId: 'call_2', name: 'count_records', content: '{"count":2}' },
          ],
        }),
      ),
    );

    const body = lastBody(stub);
    const contents = body.contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents).toHaveLength(3);
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [
        { functionResponse: { name: 'count_records', response: { count: 1 } } },
        { functionResponse: { name: 'count_records', response: { count: 2 } } },
      ],
    });
  });

  it('wraps a result that is plain text', async () => {
    stub.handler = (_request, respond) => void respond.sse([text('Noted.', 'STOP')]);
    await collect(
      provider.stream(
        config(),
        request({
          messages: [
            { role: 'user', content: 'Ask' },
            { role: 'tool', toolCallId: 'call_1', name: 'ask_question', content: 'Nothing matched' },
          ],
        }),
      ),
    );
    expect(lastBody(stub).contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'Ask' },
          { functionResponse: { name: 'ask_question', response: { result: 'Nothing matched' } } },
        ],
      },
    ]);
  });

  it('streams text and usage, counting reasoning as output', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        // The model's own reasoning is billed but is not part of the reply.
        chunk({
          candidates: [{ content: { parts: [{ text: 'Thinking aloud', thought: true }] }, index: 0 }],
        }),
        text('Hello'),
        text(' there', 'STOP', {
          promptTokenCount: 11,
          candidatesTokenCount: 7,
          thoughtsTokenCount: 3,
          totalTokenCount: 21,
        }),
        // A gateway in between may close the stream with the Chat Completions sentinel.
        { data: '[DONE]' },
      ]);

    const parts = await collect(provider.stream(config(), request()));
    expect(textOf(parts)).toBe('Hello there');
    expect(usageOf(parts)).toEqual({ inputTokens: 11, outputTokens: 10 });
    expect(stopOf(parts)).toBe('end');
  });

  it('assembles function calls and numbers them', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        text('Working.'),
        chunk({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { functionCall: { name: 'count_records', args: { tableId: 'tbl1' } } },
                  { functionCall: { name: 'get_schema', args: { databaseId: 'db1' } } },
                ],
              },
              index: 0,
            },
          ],
        }),
        chunk({
          candidates: [{ content: { parts: [] }, finishReason: 'STOP', index: 0 }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 9 },
        }),
      ]);

    const parts = await collect(provider.stream(config(), request({ tools: [TOOL] })));
    expect(textOf(parts)).toBe('Working.');
    expect(callsOf(parts)).toEqual([
      { id: 'call_0', name: 'count_records', arguments: { tableId: 'tbl1' } },
      { id: 'call_1', name: 'get_schema', arguments: { databaseId: 'db1' } },
    ]);
    expect(usageOf(parts)).toEqual({ inputTokens: 20, outputTokens: 9 });
    expect(stopOf(parts)).toBe('toolCalls');
  });

  it('treats a call with no arguments as an empty object', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        chunk({
          candidates: [{ content: { parts: [{ functionCall: { name: 'list_databases' } }] }, index: 0 }],
        }),
        chunk({ candidates: [{ content: { parts: [] }, finishReason: 'STOP', index: 0 }] }),
      ]);
    const parts = await collect(provider.stream(config(), request()));
    expect(callsOf(parts)).toEqual([{ id: 'call_0', name: 'list_databases', arguments: {} }]);
  });

  it('reports every finish reason the same way', async () => {
    for (const [reason, stop] of [
      ['STOP', 'end'],
      ['MAX_TOKENS', 'length'],
      ['SAFETY', 'filtered'],
      ['PROHIBITED_CONTENT', 'filtered'],
      ['RECITATION', 'filtered'],
    ] as Array<[string, string]>) {
      stub.handler = (_request, respond) => void respond.sse([text('Partly.', reason)]);
      const parts = await collect(provider.stream(config(), request()));
      expect(stopOf(parts), reason).toBe(stop);
    }
  });

  it('reports a blocked prompt rather than an empty reply', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([chunk({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] })]);

    const error = (await failureOf(collect(provider.stream(config(), request())))) as ProviderError;
    expect(error.messageKey).toBe(PROVIDER_MESSAGE_KEYS.filtered);
    expect(error.detail).toContain('SAFETY');
  });

  it('carries an error the provider sent inside a healthy stream', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        chunk({ error: { code: 429, message: 'Quota spent', status: 'RESOURCE_EXHAUSTED' } }),
      ]);

    const error = (await failureOf(collect(provider.stream(config(), request())))) as ProviderError;
    expect(error.messageKey).toBe(PROVIDER_MESSAGE_KEYS.rateLimited);
    expect(error.detail).toBe('Quota spent');
  });

  it('maps a refused key and a missing model', async () => {
    stub.handler = (_request, respond) =>
      respond.json(403, {
        error: { code: 403, message: 'The API key is not valid', status: 'PERMISSION_DENIED' },
      });
    const denied = (await failureOf(collect(provider.stream(config(), request())))) as ProviderError;
    expect(denied.messageKey).toBe(PROVIDER_MESSAGE_KEYS.unauthorized);
    expect(denied.detail).toBe('The API key is not valid');

    stub.requests.length = 0;
    stub.handler = (_request, respond) =>
      respond.json(404, {
        error: { code: 404, message: 'models/gpt-test is not found', status: 'NOT_FOUND' },
      });
    const missing = (await failureOf(collect(provider.stream(config(), request())))) as ProviderError;
    expect(missing.messageKey).toBe(PROVIDER_MESSAGE_KEYS.badRequest);
    expect(missing.status).toBe(404);
  });
});

describe('the Gemini catalog', () => {
  it('keeps the models that can hold a conversation', async () => {
    stub.handler = (sent, respond) => {
      expect(sent.method).toBe('GET');
      expect(sent.url).toContain('/models?');
      expect(sent.url).not.toContain(KEY);
      expect(sent.headers['x-goog-api-key']).toBe(KEY);
      respond.json(200, {
        models: [
          {
            name: 'models/gemini-test',
            displayName: 'Gemini Test',
            supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
          },
          {
            name: 'models/embed-001',
            displayName: 'Embed 001',
            supportedGenerationMethods: ['embedContent'],
          },
          { name: 'models/imagine-1', displayName: 'Imagine', supportedGenerationMethods: ['predict'] },
          { name: 'models/no-methods', displayName: 'Unknown' },
        ],
      });
    };

    expect(await provider.listModels(config())).toEqual([{ model: 'gemini-test', name: 'Gemini Test' }]);
  });

  it('follows pages to the end of the catalog', async () => {
    stub.handler = (sent, respond) => {
      if (sent.url.includes('pageToken')) {
        respond.json(200, {
          models: [
            { name: 'models/second', displayName: 'Second', supportedGenerationMethods: ['generateContent'] },
          ],
        });
        return;
      }
      respond.json(200, {
        models: [
          { name: 'models/first', displayName: 'First', supportedGenerationMethods: ['generateContent'] },
        ],
        nextPageToken: 'next-page',
      });
    };

    expect(await provider.listModels(config())).toEqual([
      { model: 'first', name: 'First' },
      { model: 'second', name: 'Second' },
    ]);
    expect(stub.requests).toHaveLength(2);
    expect(lastRequest(stub).url).toContain('pageToken=next-page');
  });

  it('falls back to the model id when the catalog has no name for it', async () => {
    stub.handler = (_request, respond) =>
      respond.json(200, {
        models: [{ name: 'models/gemini-test', supportedGenerationMethods: ['generateContent'] }],
      });
    expect(await provider.listModels(config())).toEqual([{ model: 'gemini-test', name: 'gemini-test' }]);
  });
});
