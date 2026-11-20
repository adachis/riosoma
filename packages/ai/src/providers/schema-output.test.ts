import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  providerFor,
  REGISTRY,
  schemaOutput,
  type ChatRequest,
  type OutputSchema,
  type ProviderAdapter,
  type StreamPart,
} from '../index.js';
import { collect, lastBody, startStub, type StubResponder, type StubServer } from './harness.test-helpers.js';
import * as wire from './wire.js';

let stub: StubServer;
const apiKey = randomBytes(24).toString('hex');
beforeAll(async () => {
  stub = await startStub();
});
afterAll(async () => {
  await stub.stop();
});
afterEach(() => {
  stub.requests.length = 0;
  vi.restoreAllMocks();
});

const jsonSchema = {
  type: 'object',
  properties: { rows: { type: 'array', items: { type: 'integer' } } },
  required: ['rows'],
  additionalProperties: false,
};
const errors = [{ code: 'invalid_type', path: ['rows', 0] }];
const schema: OutputSchema<{ rows: number[] }> = {
  jsonSchema,
  validate(value) {
    if (
      value &&
      typeof value === 'object' &&
      'rows' in value &&
      Array.isArray(value.rows) &&
      value.rows.every((row: unknown) => typeof row === 'number' && Number.isInteger(row))
    )
      return { valid: true, data: value as { rows: number[] } };
    return { valid: false, errors };
  },
};

type Dialect = 'chat' | 'messages' | 'generate' | 'converse';
const cases: Array<[string, string, Dialect]> = [
  ['openai', 'gpt-6-luna', 'chat'],
  ['mistral', 'mistral-small-latest', 'chat'],
  ['openrouter', 'test-model', 'chat'],
  ['azure', 'test-deployment', 'chat'],
  ['gateway', 'test-route', 'chat'],
  ['anthropic', 'claude-haiku-4-5-20251001', 'messages'],
  ['gemini', 'gemini-3.5-flash-lite', 'generate'],
  ['vertex', 'gemini-2.5-flash', 'generate'],
  ['bedrock', 'amazon.nova-lite-v1:0', 'converse'],
];

function reply(
  respond: StubResponder,
  dialect: Dialect,
  input: unknown,
  stop: 'tool' | 'length' | 'refused',
) {
  const stops = { tool: 'tool_calls', length: 'length', refused: 'content_filter' };
  if (dialect === 'converse') {
    respond.json(200, {
      output: { message: { content: [{ toolUse: { toolUseId: 'call_1', name: 'submit_output', input } }] } },
      stopReason: stop === 'length' ? 'max_tokens' : stop === 'refused' ? 'content_filtered' : 'tool_use',
      usage: { inputTokens: 9, outputTokens: 7 },
    });
    return;
  }
  const chunks =
    dialect === 'chat'
      ? [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      function: {
                        name: 'submit_output',
                        arguments: typeof input === 'string' ? input : JSON.stringify(input),
                      },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: stops[stop] }],
            usage: { prompt_tokens: 9, completion_tokens: 7 },
          },
        ]
      : dialect === 'messages'
        ? [
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'call_1', name: 'submit_output', input: {} },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { partial_json: typeof input === 'string' ? input : JSON.stringify(input) },
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: {
                stop_reason: stop === 'length' ? 'max_tokens' : stop === 'refused' ? 'refusal' : 'tool_use',
              },
              usage: { input_tokens: 9, output_tokens: 7 },
            },
            { type: 'message_stop' },
          ]
        : [
            {
              candidates: [
                { content: { parts: [{ functionCall: { name: 'submit_output', args: input } }] } },
              ],
            },
            {
              candidates: [
                { finishReason: stop === 'length' ? 'MAX_TOKENS' : stop === 'refused' ? 'SAFETY' : 'STOP' },
              ],
              usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 7 },
            },
          ];
  return respond.sse(chunks.map((chunk) => ({ data: JSON.stringify(chunk) })));
}

function cutOffChunks(dialect: Dialect, input: string): unknown[] {
  return dialect === 'chat'
    ? [
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { name: 'submit_output', arguments: input } }],
              },
            },
          ],
        },
        {
          choices: [{ delta: {}, finish_reason: 'length' }],
          usage: { prompt_tokens: 9, completion_tokens: 7 },
        },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]
    : dialect === 'messages'
      ? [
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'call_1', name: 'submit_output', input: {} },
          },
          { type: 'content_block_delta', index: 0, delta: { partial_json: input } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'max_tokens' },
            usage: { input_tokens: 9, output_tokens: 7 },
          },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        ]
      : [
          {
            candidates: [{ content: { parts: [{ functionCall: { name: 'submit_output', args: input } }] } }],
          },
          {
            candidates: [{ finishReason: 'MAX_TOKENS' }],
            usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 7 },
          },
          { candidates: [{ finishReason: 'STOP' }] },
        ];
}

describe.each(cases)('%s schema output', (id, model, dialect) => {
  const run = (outputSchema = schema) =>
    schemaOutput(providerFor(id), { baseUrl: stub.baseUrl, apiKey }, outputSchema, {
      model,
      messages: [{ role: 'user', content: 'Read these rows.' }],
      maxOutputTokens: 20,
    });

  it('requires the named tool in the provider format and validates one reply', async () => {
    stub.handler = (_request, respond) => reply(respond, dialect, { value: { rows: [1, 2] } }, 'tool');
    expect(await run()).toMatchObject({
      ok: true,
      value: { rows: [1, 2] },
      usage: { inputTokens: 9, outputTokens: 7, reported: true },
    });
    expect(stub.requests).toHaveLength(1);
    const body = lastBody(stub);
    if (dialect === 'chat') {
      expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'submit_output' } });
      expect(body.parallel_tool_calls).toBe(false);
    } else if (dialect === 'messages') {
      expect(body.tool_choice).toEqual({
        type: 'tool',
        name: 'submit_output',
        disable_parallel_tool_use: true,
      });
    } else if (dialect === 'generate') {
      expect(body.toolConfig).toEqual({
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['submit_output'] },
      });
    } else expect(body.toolConfig).toMatchObject({ toolChoice: { tool: { name: 'submit_output' } } });
    expect(JSON.stringify(body)).toContain('"required":["rows"]');
  });

  it('returns validation errors after one invalid reply', async () => {
    stub.handler = (_request, respond) => reply(respond, dialect, { value: { rows: ['wrong'] } }, 'tool');
    expect(await run()).toMatchObject({ ok: false, reason: 'invalid', errors });
    expect(stub.requests).toHaveLength(1);
  });

  it.each(['{"value":{"rows":', { value: { rows: [1] } }])(
    'never parses or validates output at the limit, even when it looks complete',
    async (input) => {
      stub.handler = (_request, respond) => reply(respond, dialect, input, 'length');
      const validate = vi.fn(schema.validate);
      const parse = vi.spyOn(JSON, 'parse');
      const argumentsParser = vi.spyOn(wire, 'parseToolArguments');
      const objectParser = vi.spyOn(wire, 'asArguments');
      expect(await run({ ...schema, validate })).toMatchObject({ ok: false, reason: 'cutOff' });
      expect(validate).not.toHaveBeenCalled();
      expect(argumentsParser).not.toHaveBeenCalled();
      expect(objectParser).not.toHaveBeenCalled();
      expect(parse.mock.calls.some(([text]) => text === input)).toBe(false);
      expect(stub.requests).toHaveLength(1);
    },
  );

  it('reports refusal without validating the output', async () => {
    stub.handler = (_request, respond) => reply(respond, dialect, '{broken', 'refused');
    const validate = vi.fn(schema.validate);
    expect(await run({ ...schema, validate })).toMatchObject({ ok: false, reason: 'refused' });
    expect(validate).not.toHaveBeenCalled();
    expect(stub.requests).toHaveLength(1);
  });

  it('does not retry a temporary provider failure', async () => {
    stub.handler = (_request, respond) => respond.json(503, { error: { message: 'Temporary failure' } });
    expect(await run()).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(stub.requests).toHaveLength(1);
  });

  it.each([401, 403])('reports a refused key separately for HTTP %s', async (status) => {
    stub.handler = (_request, respond) => respond.json(status, { error: { message: 'Access refused' } });
    expect(await run()).toMatchObject({
      ok: false,
      reason: 'keyRefused',
      failure: { messageKey: 'ai.provider.unauthorized', status, cause: 'ProviderError' },
      usage: { reported: false },
    });
    expect(stub.requests).toHaveLength(1);
  });

  if (dialect !== 'converse')
    it('keeps final completion after usage for existing stream callers', async () => {
      stub.handler = (_request, respond) =>
        respond.sse(cutOffChunks(dialect, '{broken').map((chunk) => ({ data: JSON.stringify(chunk) })));
      const parts = await collect(
        providerFor(id).stream({ baseUrl: stub.baseUrl, apiKey }, { model, messages: [], retries: 0 }),
      );
      expect(parts.findIndex((part) => part.type === 'usage')).toBeLessThan(
        parts.findIndex((part) => part.type === 'done'),
      );
      expect(parts.at(-1)).toEqual({ type: 'done', stop: 'length' });
      expect(stub.requests).toHaveLength(1);
    });

  if (dialect !== 'converse')
    it('reports truncation before later events and yields final usage only once', async () => {
      const laterUsage =
        dialect === 'chat'
          ? { choices: [], usage: { prompt_tokens: 9, completion_tokens: 11 } }
          : dialect === 'messages'
            ? { type: 'message_delta', usage: { input_tokens: 9, output_tokens: 11 } }
            : { usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 11 } };
      stub.handler = (_request, respond) =>
        respond.sse(
          [...cutOffChunks(dialect, '{broken'), laterUsage].map((chunk) => ({ data: JSON.stringify(chunk) })),
        );
      const parts = await collect(
        providerFor(id).stream(
          { baseUrl: stub.baseUrl, apiKey },
          { model, messages: [], retries: 0, deferToolArguments: true },
        ),
      );
      expect(parts.filter((part) => part.type === 'done')).toEqual([{ type: 'done', stop: 'length' }]);
      expect(parts.filter((part) => part.type === 'outputLimit')).toEqual([{ type: 'outputLimit' }]);
      expect(parts.filter((part) => part.type === 'usage')).toEqual([
        { type: 'usage', inputTokens: 9, outputTokens: 11 },
      ]);
      expect(parts.findIndex((part) => part.type === 'outputLimit')).toBeLessThan(
        parts.findIndex((part) => part.type === 'usage'),
      );
      expect(parts.some((part) => part.type === 'toolCall' || part.type === 'toolCallInput')).toBe(false);
      expect(stub.requests).toHaveLength(1);
    });

  if (dialect !== 'converse')
    it.each(['provider', 'malformed'] as const)(
      'preserves an output-limit stop before a later %s error',
      async (failure) => {
        const input = '{"value":{"rows":';
        const chunks = cutOffChunks(dialect, input);
        stub.handler = (_request, respond) =>
          respond.sse([
            ...chunks.map((chunk) => ({ data: JSON.stringify(chunk) })),
            {
              data:
                failure === 'malformed'
                  ? '{broken'
                  : JSON.stringify({ type: 'error', error: { message: 'Later stream failure' } }),
            },
          ]);
        const validate = vi.fn(schema.validate);
        const parse = vi.spyOn(JSON, 'parse');
        const argumentsParser = vi.spyOn(wire, 'parseToolArguments');
        const objectParser = vi.spyOn(wire, 'asArguments');
        expect(await run({ ...schema, validate })).toMatchObject({
          ok: false,
          reason: 'cutOff',
          usage: { inputTokens: 9, outputTokens: 7, reported: true },
        });
        expect(validate).not.toHaveBeenCalled();
        expect(argumentsParser).not.toHaveBeenCalled();
        expect(objectParser).not.toHaveBeenCalled();
        expect(parse.mock.calls.some(([text]) => text === input)).toBe(false);
        expect(stub.requests).toHaveLength(1);
      },
    );
});

describe('a provider without forced choice', () => {
  const run = (outputSchema = schema) =>
    schemaOutput(providerFor('ollama'), { baseUrl: stub.baseUrl }, outputSchema, {
      model: 'test-local',
      messages: [{ role: 'user', content: 'Read these rows.' }],
    });
  function textReply(text: string, stop = 'stop') {
    stub.handler = (_request, respond) =>
      respond.sse([
        { data: JSON.stringify({ choices: [{ delta: { content: text } }] }) },
        { data: JSON.stringify({ choices: [{ delta: {}, finish_reason: stop }] }) },
      ]);
  }
  it('uses local parse and repair with one call', async () => {
    textReply('```json\n{"rows":[1,2,],}\n```');
    expect(await run()).toMatchObject({ ok: true, value: { rows: [1, 2] } });
    expect(stub.requests).toHaveLength(1);
    expect(lastBody(stub).tools).toBeUndefined();
    expect(lastBody(stub).tool_choice).toBeUndefined();
  });
  it('returns validation errors with one call', async () => {
    textReply('{"rows":["wrong"]}');
    expect(await run()).toMatchObject({ ok: false, reason: 'invalid', errors });
    expect(stub.requests).toHaveLength(1);
  });
  it.each(['{"rows":[', '{"rows":[1,],}'])('never parses or repairs cut-off text', async (text) => {
    textReply(text, 'length');
    const parse = vi.spyOn(JSON, 'parse');
    const validate = vi.fn(schema.validate);
    expect(await run({ ...schema, validate })).toMatchObject({ ok: false, reason: 'cutOff' });
    expect(parse.mock.calls.some(([input]) => input === text)).toBe(false);
    expect(validate).not.toHaveBeenCalled();
    expect(stub.requests).toHaveLength(1);
  });
});

it('keeps registry capabilities consistent with the adapters', () => {
  for (const entry of REGISTRY.filter((entry) => entry.tools)) {
    expect(entry.forcedToolChoice).toBe(
      providerFor(entry.providerId).supportsForcedToolChoice?.(entry.model) ?? false,
    );
  }
  expect(providerFor('ollama').supportsForcedToolChoice?.('test-local')).toBe(false);
  expect(providerFor('bedrock').supportsForcedToolChoice?.('unsupported-model')).toBe(false);
  expect(providerFor('anthropic').supportsForcedToolChoice?.('unknown-model')).toBe(false);
});

function fixture(parts: StreamPart[], forcedToolChoice = true) {
  const requests: ChatRequest[] = [];
  const adapter: ProviderAdapter = {
    id: 'outputfixture',
    name: 'Output fixture',
    local: true,
    supportsForcedToolChoice: () => forcedToolChoice,
    listModels: async () => [],
    async *stream(_config, request) {
      requests.push(request);
      yield* parts;
    },
  };
  return { adapter, requests };
}

it.each([true, false])(
  'keeps JSON fallback instructions in the first system message with initial instructions %s',
  async (hasSystem) => {
    const { adapter, requests } = fixture(
      [
        { type: 'text', delta: '{"rows":[1,2]}' },
        { type: 'done', stop: 'end' },
      ],
      false,
    );
    const request: ChatRequest = {
      model: 'fixture',
      messages: [
        ...(hasSystem ? [{ role: 'system' as const, content: 'Keep the reading instructions.' }] : []),
        {
          role: 'user',
          content: 'Read these rows.',
          attachments: [{ mediaType: 'image/png', data: 'fixture-bytes' }],
        },
        { role: 'assistant', content: 'Ready to read.' },
        { role: 'user', content: 'Return the next rows.' },
      ],
    };
    const original = structuredClone(request);
    expect(await schemaOutput(adapter, {}, schema, request)).toMatchObject({
      ok: true,
      value: { rows: [1, 2] },
    });
    expect(requests).toHaveLength(1);
    const sent = requests[0]!;
    expect(sent.messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(sent.messages[0]!.content).toContain(
      `Return only JSON matching this schema: ${JSON.stringify(jsonSchema)}`,
    );
    if (hasSystem) expect(sent.messages[0]!.content).toContain(original.messages[0]!.content);
    expect(sent.messages.slice(1)).toEqual(original.messages.slice(hasSystem ? 1 : 0));
    expect(sent.tools).toBeUndefined();
    expect(sent.toolChoice).toBeUndefined();
    expect(request).toEqual(original);
  },
);

it.each([
  [{ type: 'toolCallInput', name: 'another_tool', input: '{}', encoding: 'json' }],
  [{ type: 'toolCallInput', name: 'submit_output', input: '{broken', encoding: 'json' }],
  [{ type: 'toolCallInput', name: 'submit_output', input: '{"rows":[1]}', encoding: 'json' }],
  [
    { type: 'toolCallInput', name: 'submit_output', input: '{"value":{"rows":[1]}}', encoding: 'json' },
    { type: 'toolCallInput', name: 'submit_output', input: '{"value":{"rows":[2]}}', encoding: 'json' },
  ],
] as StreamPart[][])(
  'rejects malformed, missing, unexpected, and duplicate tool output in one call',
  async (...parts) => {
    const { adapter, requests } = fixture([...parts, { type: 'done', stop: 'toolCalls' }]);
    const validate = vi.fn(schema.validate);
    expect(
      await schemaOutput(adapter, {}, { ...schema, validate }, { model: 'fixture', messages: [] }),
    ).toMatchObject({
      ok: false,
      reason: 'invalid',
      errors: [expect.objectContaining({ code: expect.any(String) })],
    });
    expect(validate).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  },
);

it.each([{ value: null }, { value: 42 }, { value: ['one', 'two'] }])(
  'validates scalar and array schemas through the object tool envelope',
  async ({ value }) => {
    const { adapter, requests } = fixture([
      { type: 'toolCallInput', name: 'submit_output', input: JSON.stringify({ value }), encoding: 'json' },
      { type: 'done', stop: 'toolCalls' },
    ]);
    const output: OutputSchema<unknown> = {
      jsonSchema: { type: value === null ? 'null' : Array.isArray(value) ? 'array' : 'number' },
      validate: (input) => ({ valid: true, data: input }),
    };
    expect(await schemaOutput(adapter, {}, output, { model: 'fixture', messages: [] })).toMatchObject({
      ok: true,
      value,
    });
    expect(requests).toHaveLength(1);
  },
);

it('preserves local schema references and literal reference-shaped data', async () => {
  const { adapter, requests } = fixture([
    { type: 'toolCallInput', name: 'submit_output', input: '{"value":{"rows":[1]}}', encoding: 'json' },
    { type: 'done', stop: 'toolCalls' },
  ]);
  const withRefs = {
    ...schema,
    jsonSchema: {
      type: 'object',
      $defs: { row: { type: 'integer' } },
      properties: {
        rows: { type: 'array', items: { $ref: '#/$defs/row' } },
        literal: { const: { $ref: '#/data' } },
      },
    },
  };
  expect(await schemaOutput(adapter, {}, withRefs, { model: 'fixture', messages: [] })).toMatchObject({
    ok: true,
  });
  const parameters = requests[0]!.tools![0]!.parameters;
  expect(JSON.stringify(parameters)).toContain('"$ref":"#/properties/value/$defs/row"');
  expect(JSON.stringify(parameters)).toContain('"const":{"$ref":"#/data"}');
  expect(requests).toHaveLength(1);
});

it.each(['const', 'enum', 'default', 'examples'])(
  'preserves schema references under the property name %s',
  async (name) => {
    const value = { [name]: 1 };
    const { adapter, requests } = fixture([
      { type: 'toolCallInput', name: 'submit_output', input: { value }, encoding: 'value' },
      { type: 'done', stop: 'toolCalls' },
    ]);
    const validate = vi.fn((input: unknown) => ({ valid: true as const, data: input }));
    const output = {
      jsonSchema: {
        type: 'object',
        $defs: { [name]: { type: 'integer' } },
        properties: { [name]: { $ref: `#/$defs/${name}` } },
        required: [name],
      },
      validate,
    };
    expect(await schemaOutput(adapter, {}, output, { model: 'fixture', messages: [] })).toMatchObject({
      ok: true,
      value,
    });
    expect(requests[0]!.tools![0]!.parameters).toMatchObject({
      properties: {
        value: {
          $defs: { [name]: { type: 'integer' } },
          properties: { [name]: { $ref: `#/properties/value/$defs/${name}` } },
        },
      },
    });
    expect(validate).toHaveBeenCalledExactlyOnceWith(value);
    expect(requests).toHaveLength(1);
  },
);

it.each([
  { $defs: { row: { $anchor: 'row', type: 'integer' } }, $ref: '#row' },
  { $id: 'https://schemas.example.test/row', $defs: { row: { type: 'integer' } }, $ref: '#/$defs/row' },
])('keeps references within their schema resource', async (jsonSchema) => {
  const { adapter, requests } = fixture([
    { type: 'toolCallInput', name: 'submit_output', input: { value: 1 }, encoding: 'value' },
    { type: 'done', stop: 'toolCalls' },
  ]);
  const output = { jsonSchema, validate: (input: unknown) => ({ valid: true as const, data: input }) };
  expect(await schemaOutput(adapter, {}, output, { model: 'fixture', messages: [] })).toMatchObject({
    ok: true,
    value: 1,
  });
  expect(requests[0]!.tools![0]!.parameters).toMatchObject({ properties: { value: jsonSchema } });
  expect(requests).toHaveLength(1);
});
