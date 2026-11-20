import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  defaultModel,
  modelsForCapability,
  providerFor,
  ProviderError,
  type ModelCapability,
  type ProviderConfig,
} from '../index.js';
import {
  callsOf,
  collect,
  conversation,
  lastBody,
  lastRequest,
  startStub,
  stopOf,
  textOf,
  TOOL,
  usageOf,
  type StubServer,
} from './harness.test-helpers.js';

let stub: StubServer;
const key = randomUUID();
const config = (): ProviderConfig => ({ apiKey: key, baseUrl: stub.baseUrl });
const ask = {
  model: 'test-model',
  messages: conversation(),
  tools: [TOOL],
  maxOutputTokens: 300,
  temperature: 0,
};
beforeAll(async () => {
  stub = await startStub();
});
afterAll(async () => {
  await stub.stop();
});
afterEach(() => {
  stub.requests.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([
  ['test-model', '1efcaa7356b80c367343413f6491e610949168f7072e2910dc7cd3d670ca6d6a'],
  ['test-model:v1', '986a5a438012402ca5390e0983b955645e8c0abc0a94045b5a9d13ecaac68b04'],
  [
    'arn:aws:bedrock:us-west-2:123456789012:inference-profile/test-model:v1',
    '590f1a0e4ec4f155dabeff70f14e2c903602a4c305cc5033999b9a6117942981',
  ],
  ['test-model%3Av1', 'a5d88e71e10ec6f68c64033a456b5cc95ca182b7e630d605c9a01d7275bb9c85'],
])('matches an independent SigV4 signature for %s', async (model, signature) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
  const fetcher = vi.fn(async () =>
    Response.json({ output: { message: { content: [{ text: 'ok' }] } }, stopReason: 'end_turn' }),
  );
  vi.stubGlobal('fetch', fetcher);
  // Fixed signatures from the independently installed SigV4 signer detect escaping regressions.
  await collect(
    providerFor('bedrock').stream(
      {
        aws: {
          accessKeyId: ['test', 'access'].join('-'),
          secretAccessKey: ['test', 'secret'].join('-'),
          sessionToken: ['test', 'session'].join('-'),
          region: 'us-west-2',
        },
      },
      { model, messages: [{ role: 'user', content: 'Check' }], maxOutputTokens: 10 },
    ),
  );
  const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
  expect(new URL(url).pathname).toBe(`/model/${encodeURIComponent(model)}/converse`);
  expect(new Headers(init.headers).get('authorization')).toBe(
    `AWS4-HMAC-SHA256 Credential=test-access/20261001/us-west-2/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=${signature}`,
  );
});

it.each(['http', 'stream', 'catalog'])('redacts a bare Vertex token echoed in a %s failure', async (kind) => {
  const token = randomUUID();
  const vertex = { ...config(), apiKey: token };
  stub.handler = (_, respond) =>
    kind === 'stream'
      ? void respond.sse([{ data: `invalid ${token}` }])
      : respond.json(403, { message: `Denied ${token}` });
  const failure = await (
    kind === 'catalog'
      ? providerFor('vertex').listModels(vertex)
      : collect(providerFor('vertex').stream(vertex, ask))
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ProviderError);
  expect((failure as ProviderError).detail).toContain('[redacted]');
  expect((failure as ProviderError).detail).not.toContain(token);
  expect(lastRequest(stub).headers.authorization).toBe(`Bearer ${token}`);
  expect(lastRequest(stub).headers['x-goog-api-key']).toBeUndefined();
});

it('maps Converse instructions, documents, tools, results, and usage', async () => {
  stub.handler = (_, respond) =>
    respond.json(200, {
      output: {
        message: {
          content: [
            { text: 'Counted.' },
            { toolUse: { toolUseId: 'next', name: TOOL.name, input: { tableId: 'orders' } } },
          ],
        },
      },
      usage: { inputTokens: 12, outputTokens: 4 },
      stopReason: 'tool_use',
    });
  const parts = await collect(
    providerFor('bedrock').stream(config(), {
      ...ask,
      model: 'us.test:v1',
      messages: [
        ...ask.messages,
        { role: 'user', content: 'Scan', attachments: [{ mediaType: 'application/pdf', data: 'YQ==' }] },
      ],
    }),
  );
  expect(lastRequest(stub).url).toBe('/model/us.test%3Av1/converse');
  expect(lastRequest(stub).headers.authorization).toBe(`Bearer ${key}`);
  expect(lastBody(stub)).toMatchObject({
    system: [{ text: 'You are Rio.' }],
    inferenceConfig: { maxTokens: 300, temperature: 0 },
    toolConfig: { tools: [{ toolSpec: { name: TOOL.name, inputSchema: { json: TOOL.parameters } } }] },
  });
  expect(JSON.stringify(lastBody(stub))).toContain('toolUseId');
  expect(JSON.stringify(lastBody(stub))).toContain('toolResult');
  expect(JSON.stringify(lastBody(stub))).toContain('"document":{"format":"pdf"');
  expect(callsOf(parts)).toEqual([{ id: 'next', name: TOOL.name, arguments: { tableId: 'orders' } }]);
  expect(textOf(parts)).toBe('Counted.');
  expect(usageOf(parts)).toEqual({ inputTokens: 12, outputTokens: 4 });
  expect(stopOf(parts)).toBe('toolCalls');
});

it.each(['content_filtered', 'guardrail_intervened'])(
  'rejects %s before yielding blocked text',
  async (stopReason) => {
    stub.handler = (_, respond) =>
      respond.json(200, { output: { message: { content: [{ text: 'blocked' }] } }, stopReason });
    await expect(collect(providerFor('bedrock').stream(config(), ask))).rejects.toMatchObject({
      messageKey: 'ai.provider.filtered',
    });
  },
);

it('keeps long Converse replies intact', async () => {
  const text = 'x'.repeat(100_000);
  stub.handler = (_, respond) =>
    respond.json(200, {
      output: { message: { content: [{ text }] } },
      stopReason: 'end_turn',
    });
  expect(textOf(await collect(providerFor('bedrock').stream(config(), ask)))).toBe(text);
});

it('signs identity requests and scrubs all temporary credentials from failures', async () => {
  const identity = {
    ...config(),
    headers: { 'x-tenant-key': randomUUID() },
    aws: {
      accessKeyId: randomUUID(),
      secretAccessKey: randomUUID(),
      sessionToken: randomUUID(),
      region: 'us-west-2',
    },
  };
  stub.handler = (_, respond) =>
    respond.json(403, {
      message: [
        identity.aws.accessKeyId,
        identity.aws.secretAccessKey,
        identity.aws.sessionToken,
        identity.headers['x-tenant-key'],
      ].join(' '),
    });
  await expect(collect(providerFor('bedrock').stream(identity, ask))).rejects.toMatchObject({
    detail: '[redacted] [redacted] [redacted] [redacted]',
  });
  expect(lastRequest(stub).headers.authorization).toMatch(
    /^AWS4-HMAC-SHA256 Credential=[a-f0-9-]+\/\d{8}\/us-west-2\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-tenant-key, Signature=[a-f0-9]{64}$/,
  );
  expect(lastRequest(stub).headers['x-amz-security-token']).toBe(identity.aws.sessionToken);
});

it('retries safe Converse failures but rejects malformed replies', async () => {
  let attempts = 0;
  stub.handler = (_, respond) =>
    ++attempts === 1
      ? respond.json(429, {}, { 'retry-after': '0' })
      : respond.json(200, { output: { message: { content: [{ text: 'ok' }] } }, stopReason: 'max_tokens' });
  expect(stopOf(await collect(providerFor('bedrock').stream(config(), ask)))).toBe('length');
  expect(attempts).toBe(2);
  stub.handler = (_, respond) => respond.json(200, {});
  await expect(collect(providerFor('bedrock').stream(config(), ask))).rejects.toBeInstanceOf(ProviderError);
});

it('uses the Vertex project endpoint and bearer identity with the native wire format', async () => {
  stub.handler = (_, respond) =>
    void respond.sse([
      {
        data: JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'ok' },
                  { functionCall: { name: TOOL.name, args: {} }, thoughtSignature: 'signature' },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, thoughtsTokenCount: 1 },
        }),
      },
    ]);
  const vertex = {
    ...config(),
    baseUrl: `${stub.baseUrl}/v1/projects/project/locations/global/publishers/google`,
  };
  const parts = await collect(providerFor('vertex').stream(vertex, ask));
  expect(lastRequest(stub).url).toBe(
    '/v1/projects/project/locations/global/publishers/google/models/test-model:streamGenerateContent?alt=sse',
  );
  expect(lastRequest(stub).headers.authorization).toBe(`Bearer ${key}`);
  expect(lastRequest(stub).headers['x-goog-api-key']).toBeUndefined();
  expect(callsOf(parts)[0]?.providerData).toEqual({ thoughtSignature: 'signature' });
  expect(usageOf(parts)).toEqual({ inputTokens: 8, outputTokens: 3 });
  stub.handler = (_, respond) => respond.json(200, { totalTokens: 1 });
  expect((await providerFor('vertex').listModels(vertex)).length).toBeGreaterThan(0);
  expect(lastRequest(stub).url).toContain(':countTokens');
});

it('routes Azure requests by deployment and authenticates the catalog separately', async () => {
  const azure = { ...config(), baseUrl: `${stub.baseUrl}/openai/deployments/team-chat` };
  stub.handler = (_, respond) => respond.json(200, { data: [{ id: 'underlying-model' }] });
  expect(await providerFor('azure').listModels(azure)).toEqual([{ model: 'team-chat', name: 'team-chat' }]);
  expect(lastRequest(stub).url).toBe('/openai/v1/models');
  stub.handler = (_, respond) =>
    void respond.sse([
      { data: JSON.stringify({ choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] }) },
      { data: '[DONE]' },
    ]);
  expect(textOf(await collect(providerFor('azure').stream(azure, { ...ask, model: 'team chat' })))).toBe(
    'hello',
  );
  expect(lastRequest(stub).url).toBe(
    '/openai/deployments/team%20chat/chat/completions?api-version=2024-10-21',
  );
  expect(lastRequest(stub).headers['api-key']).toBe(key);
  expect(lastRequest(stub).headers.authorization).toBeUndefined();
  expect(lastBody(stub).max_completion_tokens).toBe(300);
  expect(lastBody(stub).temperature).toBeUndefined();
  await expect(providerFor('azure').listModels(config())).rejects.toMatchObject({
    messageKey: 'ai.provider.badRequest',
  });
});

it('submits a variant once, manages its root queue, and ignores returned remote URLs', async () => {
  const queue = providerFor('fal').queue!;
  stub.handler = (_, respond) =>
    respond.json(200, { request_id: 'job/1', status_url: 'https://untrusted.example/status' });
  const job = await queue.submit(config(), 'fal-ai/flux-2/klein/4b', { prompt: 'A synthetic square' });
  expect(lastRequest(stub).url).toBe('/fal-ai/flux-2/klein/4b');
  expect(lastRequest(stub).headers.authorization).toBe(`Key ${key}`);
  for (const [wire, expected] of [
    ['IN_QUEUE', 'queued'],
    ['IN_PROGRESS', 'running'],
    ['COMPLETED', 'completed'],
  ]) {
    stub.handler = (_, respond) => respond.json(200, { status: wire });
    expect(await queue.status(config(), job)).toBe(expected);
    expect(lastRequest(stub).url).toBe('/fal-ai/flux-2/requests/job%2F1/status');
  }
  stub.handler = (_, respond) => respond.json(200, { images: [{ url: 'https://media.example/image.png' }] });
  expect(await queue.result(config(), job)).toHaveProperty('images');
  stub.handler = (_, respond) => respond.json(202, { status: 'CANCELLATION_REQUESTED' });
  await queue.cancel(config(), job);
  expect(lastRequest(stub)).toMatchObject({ method: 'PUT', url: '/fal-ai/flux-2/requests/job%2F1/cancel' });
  stub.requests.length = 0;
  stub.handler = (_, respond) => respond.json(503, {});
  await expect(queue.submit(config(), job.model, {})).rejects.toMatchObject({ retryable: true });
  expect(stub.requests).toHaveLength(1);
  await expect(queue.submit(config(), '../outside', {})).rejects.toBeInstanceOf(ProviderError);
});

it('honors cancellation before sending any cloud request', async () => {
  const signal = AbortSignal.abort();
  for (const id of ['bedrock', 'vertex', 'azure'])
    await expect(collect(providerFor(id).stream(config(), { ...ask, signal }))).rejects.toMatchObject({
      name: 'AbortError',
    });
  await expect(
    providerFor('fal').queue!.submit(config(), 'fal-ai/example', {}, signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(stub.requests).toHaveLength(0);
});

it.each(['bedrock', 'fal'])('keeps the %s catalog separate from credential validation', async (id) => {
  const adapter = providerFor(id);
  stub.handler = (_, respond) => respond.json(401, {});
  expect((await adapter.listModels(config())).length).toBeGreaterThan(0);
  await expect(adapter.testConnection!(config())).rejects.toMatchObject({
    messageKey: 'ai.test.unverified',
  });
  await expect(adapter.testConnection!({ baseUrl: stub.baseUrl })).rejects.toMatchObject({
    messageKey: 'ai.provider.unauthorized',
  });
  expect(stub.requests).toHaveLength(0);
});

it('authenticates identity credentials against the Bedrock control catalog', async () => {
  const identity: ProviderConfig = {
    ...config(),
    aws: { accessKeyId: randomUUID(), secretAccessKey: randomUUID(), region: 'us-west-2' },
  };
  const adapter = providerFor('bedrock');
  stub.handler = (_, respond) => respond.json(401, {});
  await expect(adapter.testConnection!(identity)).rejects.toMatchObject({
    messageKey: 'ai.provider.unauthorized',
  });
  expect(lastRequest(stub).url).toBe('/foundation-models');
  expect(lastRequest(stub).headers.authorization).toContain('AWS4-HMAC-SHA256');
  stub.handler = (_, respond) => respond.json(200, { modelSummaries: [] });
  await expect(adapter.testConnection!(identity)).resolves.toBeUndefined();
});

it.each<ModelCapability>(['embeddings', 'ocr', 'code', 'image', 'video'])(
  'selects %s only with provider consent and keeps capability-only models out of chat tiers',
  (capability) => {
    expect(modelsForCapability(capability, [])).toEqual([]);
    const models = modelsForCapability(capability, ['openai', 'ollama', 'mistral', 'anthropic', 'fal']);
    expect(models.length).toBeGreaterThan(0);
    expect(
      models.every((model) => model.capabilities?.includes(capability) && model.tiers.length === 0),
    ).toBe(true);
    expect(defaultModel('everyday', ['fal'])).toBeNull();
  },
);
