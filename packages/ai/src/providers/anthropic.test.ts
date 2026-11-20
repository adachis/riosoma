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
  type SseChunk,
  type StubServer,
} from './harness.test-helpers.js';

const KEY = 'synthetic-anthropic-key';
const VERSION = '2023-06-01';
const provider = providerFor('anthropic');

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
  return { model: 'claude-test', messages: [{ role: 'user', content: 'Hello' }], ...overrides };
}

/** One of the API's named streaming events. */
function event(name: string, payload: Record<string, unknown> = {}): SseChunk {
  return { event: name, data: JSON.stringify({ type: name, ...payload }) };
}

const start = (inputTokens: number): SseChunk =>
  event('message_start', {
    message: {
      id: 'msg_1',
      role: 'assistant',
      model: 'claude-test',
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  });
const textStart = (index: number): SseChunk =>
  event('content_block_start', { index, content_block: { type: 'text', text: '' } });
const textDelta = (index: number, text: string): SseChunk =>
  event('content_block_delta', { index, delta: { type: 'text_delta', text } });
const toolStart = (index: number, id: string, name: string): SseChunk =>
  event('content_block_start', { index, content_block: { type: 'tool_use', id, name, input: {} } });
const inputDelta = (index: number, json: string): SseChunk =>
  event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: json } });
const blockStop = (index: number): SseChunk => event('content_block_stop', { index });
const messageDelta = (stopReason: string, outputTokens: number): SseChunk =>
  event('message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
const messageStop = (): SseChunk => event('message_stop');

describe('the Messages wire format', () => {
  it('names its version, its key, and any account header', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        start(5),
        textStart(0),
        textDelta(0, 'Hello'),
        blockStop(0),
        messageDelta('end_turn', 2),
        messageStop(),
      ]);
    await collect(provider.stream(config({ headers: { 'anthropic-workspace-id': 'ws_123' } }), request()));

    const sent = lastRequest(stub);
    expect(sent.url).toBe('/v1/messages');
    expect(sent.method).toBe('POST');
    expect(sent.headers['x-api-key']).toBe(KEY);
    expect(sent.headers['anthropic-version']).toBe(VERSION);
    // Some accounts only work with a workspace named, so what the admin stored is passed on.
    expect(sent.headers['anthropic-workspace-id']).toBe('ws_123');
    expect(sent.body).not.toContain(KEY);
  });

  it('lets a gateway header through', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([start(5), textStart(0), textDelta(0, 'Hello'), blockStop(0), messageStop()]);
    await collect(
      provider.stream(
        config({ apiKey: undefined, headers: { authorization: 'Bearer gateway-token' } }),
        request(),
      ),
    );
    expect(lastRequest(stub).headers.authorization).toBe('Bearer gateway-token');
    expect(lastRequest(stub).headers['x-api-key']).toBeUndefined();
  });

  it('maps instructions, tool calls, and results into blocks', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        start(20),
        textStart(0),
        textDelta(0, 'Forty-two.'),
        blockStop(0),
        messageDelta('end_turn', 4),
        messageStop(),
      ]);
    await collect(provider.stream(config(), request({ messages: conversation(), tools: [TOOL] })));

    expect(lastBody(stub)).toEqual({
      model: 'claude-test',
      max_tokens: 4_096,
      stream: true,
      // Instructions sit beside the messages rather than inside them.
      system: 'You are Rio.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'How many rows are in Orders?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'count_records', input: { tableId: 'tblOrders' } },
          ],
        },
        // Results and the person's next words share one turn, so the roles still alternate.
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: '{"count":42}' },
            { type: 'text', text: 'And last month?' },
          ],
        },
      ],
      tools: [{ name: TOOL.name, description: TOOL.description, input_schema: TOOL.parameters }],
    });
  });

  it('puts results for several calls in the one turn that follows them', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([start(9), textStart(0), textDelta(0, 'Both counted.'), blockStop(0), messageStop()]);
    await collect(
      provider.stream(
        config(),
        request({
          messages: [
            { role: 'user', content: 'Count both' },
            {
              role: 'assistant',
              content: 'Counting',
              toolCalls: [
                { id: 'call_1', name: 'count_records', arguments: { tableId: 'tbl1' } },
                { id: 'call_2', name: 'count_records', arguments: { tableId: 'tbl2' } },
              ],
            },
            { role: 'tool', toolCallId: 'call_1', name: 'count_records', content: '{"count":1}' },
            { role: 'tool', toolCallId: 'call_2', name: 'count_records', content: '{"count":2}' },
            { role: 'user', content: 'Thanks' },
          ],
          model: 'claude-haiku-4-5',
          maxOutputTokens: 800,
          temperature: 0.1,
        }),
      ),
    );

    const body = lastBody(stub);
    expect(body.max_tokens).toBe(800);
    expect(body.temperature).toBe(0.1);
    const messages = body.messages as Array<{ role: string; content: unknown[] }>;
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Counting' },
        { type: 'tool_use', id: 'call_1', name: 'count_records', input: { tableId: 'tbl1' } },
        { type: 'tool_use', id: 'call_2', name: 'count_records', input: { tableId: 'tbl2' } },
      ],
    });
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: '{"count":1}' },
        { type: 'tool_result', tool_use_id: 'call_2', content: '{"count":2}' },
        { type: 'text', text: 'Thanks' },
      ],
    });
  });

  it('sends a temperature only to models that take one', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([start(9), textStart(0), textDelta(0, 'Hi.'), blockStop(0), messageStop()]);
    const sent = async (model: string) => {
      await collect(provider.stream(config(), request({ model, temperature: 0.2 })));
      return lastBody(stub).temperature;
    };
    for (const model of [
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-6',
      'claude-opus-4-6',
      'claude-opus-4-20250514',
    ])
      expect(await sent(model), model).toBe(0.2);
    // These refuse the whole request when it names a temperature.
    for (const model of ['claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-opus-5-5'])
      expect(await sent(model), model).toBeUndefined();
  });

  it('streams text, usage, and a stop reason', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        event('ping'),
        start(11),
        textStart(0),
        textDelta(0, 'Hello'),
        textDelta(0, ', world'),
        blockStop(0),
        messageDelta('end_turn', 7),
        messageStop(),
      ]);

    const parts = await collect(provider.stream(config(), request()));
    expect(textOf(parts)).toBe('Hello, world');
    expect(usageOf(parts)).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(stopOf(parts)).toBe('end');
    expect(parts.filter((part) => part.type === 'usage')).toHaveLength(1);
    expect(parts.at(-1)?.type).toBe('done');
  });

  it('assembles a tool call from argument fragments', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        start(30),
        textStart(0),
        textDelta(0, 'Looking.'),
        blockStop(0),
        toolStart(1, 'toolu_9', 'find_records'),
        inputDelta(1, '{"tab'),
        inputDelta(1, 'leId":"tblOrders"'),
        inputDelta(1, ',"filter":"open"}'),
        blockStop(1),
        messageDelta('tool_use', 14),
        messageStop(),
      ]);

    const parts = await collect(provider.stream(config(), request({ tools: [TOOL] })));
    expect(textOf(parts)).toBe('Looking.');
    expect(callsOf(parts)).toEqual([
      { id: 'toolu_9', name: 'find_records', arguments: { tableId: 'tblOrders', filter: 'open' } },
    ]);
    expect(usageOf(parts)).toEqual({ inputTokens: 30, outputTokens: 14 });
    expect(stopOf(parts)).toBe('toolCalls');
  });

  it('keeps several tool calls in one turn apart', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        start(30),
        toolStart(0, 'toolu_1', 'count_records'),
        inputDelta(0, '{"tableId":"tbl1"}'),
        blockStop(0),
        toolStart(1, 'toolu_2', 'get_schema'),
        inputDelta(1, '{"databaseId"'),
        inputDelta(1, ':"db1"}'),
        blockStop(1),
        messageDelta('tool_use', 20),
        messageStop(),
      ]);

    const parts = await collect(provider.stream(config(), request({ tools: [TOOL] })));
    expect(callsOf(parts)).toEqual([
      { id: 'toolu_1', name: 'count_records', arguments: { tableId: 'tbl1' } },
      { id: 'toolu_2', name: 'get_schema', arguments: { databaseId: 'db1' } },
    ]);
  });

  it('treats a call with no arguments as an empty object', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        start(4),
        toolStart(0, 'toolu_1', 'list_databases'),
        blockStop(0),
        messageDelta('tool_use', 3),
        messageStop(),
      ]);
    const parts = await collect(provider.stream(config(), request()));
    expect(callsOf(parts)).toEqual([{ id: 'toolu_1', name: 'list_databases', arguments: {} }]);
  });

  it('fails rather than guess when arguments are not JSON', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        start(4),
        toolStart(0, 'toolu_1', 'find_records'),
        inputDelta(0, '{"tableId":'),
        blockStop(0),
        messageStop(),
      ]);

    const error = (await failureOf(collect(provider.stream(config(), request())))) as ProviderError;
    expect(error.messageKey).toBe(PROVIDER_MESSAGE_KEYS.unavailable);
    expect(error.message).toContain('find_records');
  });

  it('reports every stop reason the same way', async () => {
    for (const [reason, stop] of [
      ['end_turn', 'end'],
      ['stop_sequence', 'end'],
      ['max_tokens', 'length'],
      ['tool_use', 'toolCalls'],
      ['refusal', 'filtered'],
    ] as Array<[string, string]>) {
      stub.handler = (_request, respond) =>
        void respond.sse([
          start(3),
          textStart(0),
          textDelta(0, 'Partly.'),
          blockStop(0),
          messageDelta(reason, 2),
          messageStop(),
        ]);
      const parts = await collect(provider.stream(config(), request()));
      expect(stopOf(parts), reason).toBe(stop);
    }
  });

  it('infers tool calls when no stop reason arrives, and ignores a foreign sentinel', async () => {
    // A gateway in between may end the stream the Chat Completions way instead of with message_stop.
    stub.handler = (_request, respond) =>
      void respond.sse([
        start(3),
        toolStart(0, 'toolu_1', 'count_records'),
        inputDelta(0, '{}'),
        blockStop(0),
        { data: '[DONE]' },
      ]);
    const parts = await collect(provider.stream(config(), request()));
    expect(stopOf(parts)).toBe('toolCalls');
  });

  it('carries an error the provider sent inside a healthy stream', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        start(3),
        textStart(0),
        textDelta(0, 'Half'),
        event('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }),
      ]);

    const error = (await failureOf(collect(provider.stream(config(), request())))) as ProviderError;
    expect(error.messageKey).toBe(PROVIDER_MESSAGE_KEYS.unavailable);
    expect(error.detail).toBe('Overloaded');
  });

  it('maps a refused key and a rate limit', async () => {
    stub.handler = (_request, respond) =>
      respond.json(401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      });
    const denied = (await failureOf(collect(provider.stream(config(), request())))) as ProviderError;
    expect(denied.messageKey).toBe(PROVIDER_MESSAGE_KEYS.unauthorized);
    expect(denied.detail).toBe('invalid x-api-key');

    stub.requests.length = 0;
    stub.handler = (_request, respond) =>
      respond.json(
        429,
        { type: 'error', error: { type: 'rate_limit_error', message: 'Slow down' } },
        { 'retry-after': '0' },
      );
    const limited = (await failureOf(collect(provider.stream(config(), request())))) as ProviderError;
    expect(limited.messageKey).toBe(PROVIDER_MESSAGE_KEYS.rateLimited);
    expect(stub.requests).toHaveLength(3);
  });
});

describe('the Messages catalog', () => {
  it('lists what the account can use', async () => {
    stub.handler = (sent, respond) => {
      expect(sent.method).toBe('GET');
      expect(sent.url).toContain('/v1/models?');
      expect(sent.headers['x-api-key']).toBe(KEY);
      expect(sent.headers['anthropic-version']).toBe(VERSION);
      respond.json(200, {
        data: [
          {
            type: 'model',
            id: 'claude-test',
            display_name: 'Claude Test',
            created_at: '2026-01-01T00:00:00Z',
          },
          { type: 'model', id: 'claude-older', display_name: '  ' },
        ],
        has_more: false,
      });
    };

    expect(await provider.listModels(config())).toEqual([
      { model: 'claude-older', name: 'claude-older' },
      { model: 'claude-test', name: 'Claude Test' },
    ]);
  });

  it('follows pages to the end of the catalog', async () => {
    stub.handler = (sent, respond) => {
      if (sent.url.includes('after_id')) {
        respond.json(200, {
          data: [{ type: 'model', id: 'claude-second', display_name: 'Second' }],
          has_more: false,
        });
        return;
      }
      respond.json(200, {
        data: [{ type: 'model', id: 'claude-first', display_name: 'First' }],
        has_more: true,
      });
    };

    expect(await provider.listModels(config())).toEqual([
      { model: 'claude-first', name: 'First' },
      { model: 'claude-second', name: 'Second' },
    ]);
    expect(lastRequest(stub).url).toContain('after_id=claude-first');
  });
});
