import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ProviderError, providers, providerFor, type ChatRequest, type ProviderConfig } from '../index.js';
import { PROVIDER_MESSAGE_KEYS } from './errors.js';
import type { StopReason } from './wire.js';
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

const KEY = 'synthetic-provider-key';
const provider = providerFor('openai');

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
  return { model: 'gpt-test', messages: [{ role: 'user', content: 'Hello' }], ...overrides };
}

/** The chunk shape the Chat Completions API streams, kept short so the tests stay readable. */
function chunk(payload: Record<string, unknown>): { data: string } {
  return { data: JSON.stringify(payload) };
}

function delta(payload: Record<string, unknown>, finish: string | null = null): { data: string } {
  return chunk({ choices: [{ index: 0, delta: payload, finish_reason: finish }] });
}

const DONE = { data: '[DONE]' };

describe('registration', () => {
  it('registers every provider Riosoma ships with', () => {
    const ids = providers()
      .map((adapter) => adapter.id)
      .sort();
    expect(ids).toEqual([
      'anthropic',
      'azure',
      'bedrock',
      'fal',
      'gateway',
      'gemini',
      'mistral',
      'ollama',
      'openai',
      'openrouter',
      'vertex',
    ]);
  });

  it('says which providers run on local hardware', () => {
    expect(providerFor('ollama').local).toBe(true);
    expect(providerFor('openai').local).toBe(false);
  });
});

describe('the Chat Completions wire format', () => {
  it('streams text, usage, and a stop reason', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        delta({ role: 'assistant', content: '' }),
        delta({ content: 'Hello' }),
        delta({ content: ', world' }),
        delta({}, 'stop'),
        chunk({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }),
        DONE,
      ]);

    const parts = await collect(provider.stream(config(), request()));
    expect(textOf(parts)).toBe('Hello, world');
    expect(usageOf(parts)).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(stopOf(parts)).toBe('end');
    // The person sees the stop last, after everything it refers to.
    expect(parts.at(-1)?.type).toBe('done');
    expect(parts.filter((part) => part.type === 'usage')).toHaveLength(1);
  });

  it('asks for the stream, usage, an output cap, and the tools', async () => {
    stub.handler = (_request, respond) => void respond.sse([delta({}, 'stop'), DONE]);
    await collect(
      provider.stream(
        config(),
        request({ messages: conversation(), tools: [TOOL], maxOutputTokens: 900, temperature: 0.3 }),
      ),
    );
    const sent = lastRequest(stub);
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/chat/completions');
    expect(sent.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(sent.headers['content-type']).toBe('application/json');
    expect(lastBody(stub)).toMatchObject({
      model: 'gpt-test',
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 900,
      temperature: 0.3,
      tool_choice: 'auto',
    });
    expect(lastBody(stub).tools).toEqual([
      {
        type: 'function',
        function: {
          name: TOOL.name,
          description: TOOL.description,
          parameters: TOOL.parameters,
        },
      },
    ]);
  });

  it('sends a conversation back the way the API expects it', async () => {
    stub.handler = (_request, respond) => void respond.sse([delta({ content: 'Forty-two.' }, 'stop'), DONE]);
    await collect(provider.stream(config(), request({ messages: conversation(), tools: [TOOL] })));
    expect(lastBody(stub).messages).toEqual([
      { role: 'system', content: 'You are Rio.' },
      { role: 'user', content: 'How many rows are in Orders?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'count_records', arguments: '{"tableId":"tblOrders"}' },
          },
        ],
      },
      { role: 'tool', content: '{"count":42}', tool_call_id: 'call_1', name: 'count_records' },
      { role: 'user', content: 'And last month?' },
    ]);
  });

  it('assembles a tool call from argument fragments', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        delta({
          content: 'Looking.',
          tool_calls: [
            { index: 0, id: 'call_9', type: 'function', function: { name: 'find_records', arguments: '' } },
          ],
        }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"tab' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'leId":"tbl' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'Orders","fil' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'ter":"open"}' } }] }),
        delta({}, 'tool_calls'),
        chunk({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 12 } }),
        DONE,
      ]);

    const parts = await collect(provider.stream(config(), request({ tools: [TOOL] })));
    expect(textOf(parts)).toBe('Looking.');
    expect(callsOf(parts)).toEqual([
      { id: 'call_9', name: 'find_records', arguments: { tableId: 'tblOrders', filter: 'open' } },
    ]);
    expect(usageOf(parts)).toEqual({ inputTokens: 30, outputTokens: 12 });
    expect(stopOf(parts)).toBe('toolCalls');
  });

  it('keeps several tool calls in one turn apart', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        delta({
          tool_calls: [
            { index: 0, id: 'call_a', type: 'function', function: { name: 'count_records', arguments: '' } },
          ],
        }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"tableId":"tbl1"}' } }] }),
        delta({
          tool_calls: [
            { index: 1, id: 'call_b', type: 'function', function: { name: 'count_records', arguments: '' } },
          ],
        }),
        // The two calls interleave, which is how a provider saves a round trip.
        delta({ tool_calls: [{ index: 0, function: { arguments: '' } }] }),
        delta({ tool_calls: [{ index: 1, function: { arguments: '{"tableId"' } }] }),
        delta({ tool_calls: [{ index: 1, function: { arguments: ':"tbl2"}' } }] }),
        delta({}, 'tool_calls'),
        DONE,
      ]);

    const parts = await collect(provider.stream(config(), request({ tools: [TOOL] })));
    expect(callsOf(parts)).toEqual([
      { id: 'call_a', name: 'count_records', arguments: { tableId: 'tbl1' } },
      { id: 'call_b', name: 'count_records', arguments: { tableId: 'tbl2' } },
    ]);
    expect(stopOf(parts)).toBe('toolCalls');
  });

  it('assembles calls from a provider that numbers nothing', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        delta({
          tool_calls: [
            { id: 'call_a', function: { name: 'count_records', arguments: '{"tableId":"tbl1"}' } },
          ],
        }),
        delta({ tool_calls: [{ id: 'call_b', function: { name: 'get_schema' } }] }),
        delta({ tool_calls: [{ function: { arguments: '{"databaseId":"db1"}' } }] }),
        delta({}, 'tool_calls'),
        DONE,
      ]);

    const parts = await collect(provider.stream(config(), request({ tools: [TOOL] })));
    expect(callsOf(parts)).toEqual([
      { id: 'call_a', name: 'count_records', arguments: { tableId: 'tbl1' } },
      { id: 'call_b', name: 'get_schema', arguments: { databaseId: 'db1' } },
    ]);
  });

  it('treats a call with no arguments as an empty object', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        delta({
          tool_calls: [{ index: 0, id: 'call_a', function: { name: 'list_databases', arguments: '' } }],
        }),
        delta({}, 'tool_calls'),
        DONE,
      ]);
    const parts = await collect(provider.stream(config(), request()));
    expect(callsOf(parts)).toEqual([{ id: 'call_a', name: 'list_databases', arguments: {} }]);
  });

  it('fails rather than guess when arguments are not JSON', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        delta({
          tool_calls: [
            { index: 0, id: 'call_a', function: { name: 'find_records', arguments: '{"tableId":' } },
          ],
        }),
        delta({}, 'tool_calls'),
        DONE,
      ]);

    const error = await failureOf(collect(provider.stream(config(), request())));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).messageKey).toBe(PROVIDER_MESSAGE_KEYS.unavailable);
    expect((error as ProviderError).message).toContain('find_records');
  });

  it('reports every stop reason the same way', async () => {
    const cases: Array<[string, StopReason]> = [
      ['stop', 'end'],
      ['length', 'length'],
      ['content_filter', 'filtered'],
      ['tool_calls', 'toolCalls'],
    ];
    for (const [reason, stop] of cases) {
      stub.requests.length = 0;
      stub.handler = (_request, respond) => void respond.sse([delta({ content: 'Partly.' }, reason), DONE]);
      const parts = await collect(provider.stream(config(), request()));
      expect(stopOf(parts), reason).toBe(stop);
    }
  });

  it('says a call ended in tool calls even without a finish reason', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        delta({
          tool_calls: [{ index: 0, id: 'call_a', function: { name: 'count_records', arguments: '{}' } }],
        }),
        DONE,
      ]);
    const parts = await collect(provider.stream(config(), request()));
    expect(stopOf(parts)).toBe('toolCalls');
  });

  it('carries an error the provider sent inside a healthy stream', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        chunk({ error: { message: 'The prompt was invalid', type: 'invalid_request_error' } }),
      ]);

    const error = await failureOf(collect(provider.stream(config(), request())));
    expect((error as ProviderError).messageKey).toBe(PROVIDER_MESSAGE_KEYS.badRequest);
    expect((error as ProviderError).detail).toBe('The prompt was invalid');
    expect(stub.requests).toHaveLength(1);
  });

  it('copes with a stream that ends without the sentinel', async () => {
    stub.handler = (_request, respond) => void respond.sse([delta({ content: 'Done.' })]);
    const parts = await collect(provider.stream(config(), request()));
    expect(textOf(parts)).toBe('Done.');
    expect(stopOf(parts)).toBe('end');
  });
});

describe('the model catalog', () => {
  it('lists chat models and leaves the rest out', async () => {
    stub.handler = (sent, respond) => {
      expect(sent.method).toBe('GET');
      expect(sent.url).toBe('/models');
      expect(sent.headers.authorization).toBe(`Bearer ${KEY}`);
      respond.json(200, {
        object: 'list',
        data: [
          { id: 'gpt-test', object: 'model' },
          { id: 'gpt-test-mini', object: 'model' },
          { id: 'gpt-4o-audio-preview', object: 'model' },
          { id: 'text-embedding-3-large', object: 'model' },
          { id: 'whisper-1', object: 'model' },
          { id: 'tts-1-hd', object: 'model' },
          { id: 'dall-e-3', object: 'model' },
          { id: 'gpt-realtime', object: 'model' },
          { id: 'gpt-3.5-turbo-instruct', object: 'model' },
          { id: 'davinci-002', object: 'model' },
          { object: 'model' },
        ],
      });
    };

    const models = await provider.listModels(config());
    expect(models).toEqual([
      { model: 'gpt-4o-audio-preview', name: 'gpt-4o-audio-preview' },
      { model: 'gpt-test', name: 'gpt-test' },
      { model: 'gpt-test-mini', name: 'gpt-test-mini' },
    ]);
  });

  it('keeps a display name the catalog gives', async () => {
    stub.handler = (_request, respond) =>
      respond.json(200, { data: [{ id: 'router/model', name: 'A Router Model' }] });
    expect(await provider.listModels(config())).toEqual([{ model: 'router/model', name: 'A Router Model' }]);
  });

  it('says why a refused key was refused', async () => {
    stub.handler = (_request, respond) =>
      respond.json(401, {
        error: { message: `Incorrect API key provided: ${KEY}`, type: 'invalid_request_error' },
      });

    const error = await failureOf(provider.listModels(config()));
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).messageKey).toBe(PROVIDER_MESSAGE_KEYS.unauthorized);
    expect((error as ProviderError).status).toBe(401);
    // The key came from the organization, so it never travels back out in an error.
    expect((error as ProviderError).detail).toContain('Incorrect API key');
    expect((error as ProviderError).detail).not.toContain(KEY);
    expect((error as ProviderError).detail).toContain('[redacted]');
  });
});
