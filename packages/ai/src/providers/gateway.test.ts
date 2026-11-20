import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gatewayProvider } from './gateway.js';
import { ProviderError, type ProviderConfig } from '../types.js';
import { providerFailure } from './errors.js';
import { collect, startStub, textOf, callsOf, usageOf, type StubServer } from './harness.test-helpers.js';

const gatewayKey = randomUUID();
const routeSecret = randomUUID();
let stub: StubServer;
beforeEach(async () => {
  stub = await startStub();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await stub.stop();
});
const config = (): ProviderConfig => ({
  baseUrl: `${stub.baseUrl}/v1/`,
  apiKey: gatewayKey,
  testModel: 'route-model',
  auth: { mode: 'bearer' },
});

describe('gateway wire protocol', () => {
  const operations = {
    discovery: (connected: ProviderConfig) => gatewayProvider.listModels(connected),
    chat: (connected: ProviderConfig) =>
      collect(
        gatewayProvider.stream(connected, {
          model: 'route-model',
          messages: [{ role: 'user', content: '.' }],
        }),
      ),
    embeddings: (connected: ProviderConfig) => gatewayProvider.embed!(connected, 'embed-route', ['.']),
    testing: (connected: ProviderConfig) => gatewayProvider.testConnection!(connected),
  };

  it.each(['chat', 'discovery', 'embeddings'] as const)(
    'retains sanitized cause identifiers through the %s wrapper',
    async (operation) => {
      const privateValues = [gatewayKey, routeSecret, 'private-file.csv', 'private file content'];
      const privateText = privateValues.join(' ');
      for (const identifier of ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'TimeoutError', 'private-code']) {
        const cause = Object.assign(new Error(privateText), {
          name: identifier === 'TimeoutError' ? identifier : 'private-name',
          code: identifier,
        });
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError(privateText, { cause }));
        const error = await operations[operation](config()).catch((failure: unknown) => failure);
        expect(providerFailure(error)).toEqual({
          messageKey: 'ai.provider.unavailable',
          cause: identifier === 'private-code' ? 'TypeError' : identifier,
        });
        expect(error).toMatchObject({ detail: undefined, retryable: true });
        const diagnostic = inspect({ error, failure: providerFailure(error) }, { depth: 8 });
        for (const value of privateValues) expect(diagnostic).not.toContain(value);
        vi.restoreAllMocks();
      }
    },
  );

  it.each(['chat', 'discovery', 'embeddings'] as const)(
    'retains an idle timeout through the %s wrapper',
    async (operation) => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(new Error(routeSecret)), { once: true });
          }),
      );
      const error = await operations[operation]({ ...config(), timeoutMs: 5 }).catch(
        (failure: unknown) => failure,
      );
      expect(providerFailure(error)).toEqual({ messageKey: 'ai.provider.timeout', cause: 'TimeoutError' });
      expect(inspect(error, { depth: 8 })).not.toContain(routeSecret);
    },
  );

  it.each([
    [400, "request body doesn't contain valid prompts", 'ai.gateway.requestBufferTooSmall'],
    [400, 'cannot use own model - must be: allowed-route', 'ai.gateway.modelRestricted'],
    [413, 'Payload too large', 'ai.gateway.requestTooLarge'],
  ] as const)(
    'retains the gateway diagnostic message ID for HTTP %s (%s)',
    async (status, detail, messageKey) => {
      stub.handler = (_request, response) => response.json(status, { error: { message: detail } });
      const error = await operations.chat(config()).catch((failure: unknown) => failure);
      expect(providerFailure(error)).toEqual({ messageKey, status, cause: 'ProviderError' });
    },
  );

  it.each([
    'ai.gateway.unreachable',
    'ai.gateway.tls',
    'ai.gateway.rejectedKey',
    'ai.gateway.wrongPath',
    'ai.gateway.modelNotFound',
    'ai.gateway.requestFailed',
    'ai.gateway.invalidResponse',
  ] as const)('retains the known diagnostic message ID %s', (messageKey) => {
    expect(providerFailure(new ProviderError(messageKey))).toEqual({ messageKey, cause: 'ProviderError' });
  });

  it.each(Object.keys(operations) as Array<keyof typeof operations>)(
    'rejects a cross-origin redirect before sending credentials during %s',
    async (operation) => {
      const destination = await startStub();
      const key = randomUUID();
      const route = randomUUID();
      try {
        destination.handler = (_request, response) =>
          response.json(200, {
            data: [{ id: 'route-model', index: 0, embedding: [1] }],
            choices: [{ message: { content: 'Y' } }],
          });
        stub.handler = (request, response) =>
          response.text(302, '', {
            location: `${destination.baseUrl}${request.url}`,
          });
        await expect(
          operations[operation]({
            ...config(),
            apiKey: key,
            auth: { mode: 'header', header: 'apikey' },
            headers: { 'X-Route': route },
          }),
        ).rejects.toBeInstanceOf(ProviderError);
        expect(destination.requests).toEqual([]);
        expect(stub.requests[0]?.headers).toMatchObject({ apikey: key, 'x-route': route });
      } finally {
        await destination.stop();
      }
    },
  );

  it.each(Object.keys(operations) as Array<keyof typeof operations>)(
    'rejects a protocol downgrade before following the redirect during %s',
    async (operation) => {
      const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('', {
          status: 302,
          headers: { location: 'http://gateway.example.test/v1/models' },
        }),
      );
      await expect(
        operations[operation]({
          ...config(),
          baseUrl: 'https://gateway.example.test/v1',
        }),
      ).rejects.toBeInstanceOf(ProviderError);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('manual');
    },
  );

  it.each(Object.keys(operations) as Array<keyof typeof operations>)(
    'follows a same-origin redirect with credentials and the request body during %s',
    async (operation) => {
      const key = randomUUID();
      const route = randomUUID();
      stub.handler = async (request, response) => {
        if (request.url.startsWith('/v1/')) {
          response.text(307, '', { location: request.url.replace('/v1/', '/redirected/') });
          return;
        }
        expect(request.headers).toMatchObject({ apikey: key, 'x-route': route });
        if (operation === 'chat')
          await response.sse([
            { data: JSON.stringify({ choices: [{ delta: { content: 'Y' }, finish_reason: 'stop' }] }) },
            { data: '[DONE]' },
          ]);
        else
          response.json(200, {
            data: [{ id: 'route-model', index: 0, embedding: [1] }],
            choices: [{ message: { content: 'Y' } }],
          });
      };
      await operations[operation]({
        ...config(),
        apiKey: key,
        auth: { mode: 'header', header: 'apikey' },
        headers: { 'X-Route': route },
      });
      expect(stub.requests).toHaveLength(2);
      expect(stub.requests[1]?.method).toBe(stub.requests[0]?.method);
      expect(stub.requests[1]?.body).toBe(stub.requests[0]?.body);
    },
  );

  it('rejects an unsafe destination reached after a safe redirect and bounds redirect loops', async () => {
    const destination = await startStub();
    try {
      stub.handler = (request, response) =>
        response.text(307, '', {
          location: request.url.startsWith('/v1/') ? '/redirected/models' : `${destination.baseUrl}/models`,
        });
      await expect(gatewayProvider.listModels(config())).rejects.toBeInstanceOf(ProviderError);
      expect(destination.requests).toEqual([]);
      expect(stub.requests).toHaveLength(2);
      stub.requests.length = 0;
      stub.handler = (_request, response) => response.text(307, '', { location: '/v1/models' });
      await expect(gatewayProvider.listModels(config())).rejects.toBeInstanceOf(ProviderError);
      expect(stub.requests).toHaveLength(21);
    } finally {
      await destination.stop();
    }
  });

  it('streams text, fragmented tool calls, and usage through the shared conversation core', async () => {
    stub.handler = async (_request, response) =>
      response.sse([
        {
          data: JSON.stringify({
            choices: [
              {
                delta: {
                  content: 'Answer',
                  tool_calls: [
                    { index: 0, id: 'call-1', function: { name: 'count_records', arguments: '{"tableId":' } },
                  ],
                },
              },
            ],
          }),
        },
        {
          data: JSON.stringify({
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: '"orders"}' } }] },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 4 },
          }),
        },
        { data: '[DONE]' },
      ]);
    const parts = await collect(
      gatewayProvider.stream(config(), {
        model: 'route-model',
        messages: [{ role: 'user', content: 'Count' }],
        tools: [{ name: 'count_records', description: 'Count rows', parameters: { type: 'object' } }],
      }),
    );
    expect(textOf(parts)).toBe('Answer');
    expect(callsOf(parts)).toEqual([
      { id: 'call-1', name: 'count_records', arguments: { tableId: 'orders' } },
    ]);
    expect(usageOf(parts)).toEqual({ inputTokens: 7, outputTokens: 4 });
    expect(parts.at(-1)).toEqual({ type: 'done', stop: 'toolCalls' });
    expect(stub.requests[0]?.url).toBe('/v1/chat/completions');
    expect(stub.requests[0]?.json).toMatchObject({ tools: [{ type: 'function' }], stream: true });
  });

  it.each(['bearer', 'header', 'none'] as const)(
    'uses %s authentication and extra headers for chat, discovery, embeddings, and testing',
    async (mode) => {
      stub.handler = async (request, response) => {
        if (request.url.endsWith('/models'))
          response.json(200, { data: [{ id: 'opaque-alias' }, { id: 'embed-alias' }] });
        else if (request.url.endsWith('/embeddings'))
          response.json(200, {
            data: [
              { index: 1, embedding: [0, 1] },
              { index: 0, embedding: [1, 0] },
            ],
            usage: { prompt_tokens: 8 },
          });
        else if ((request.json as { stream: boolean }).stream)
          await response.sse([
            { data: JSON.stringify({ choices: [{ delta: { content: 'Yes' }, finish_reason: 'stop' }] }) },
            { data: '[DONE]' },
          ]);
        else response.json(200, { choices: [{ message: { content: 'Y' } }] });
      };
      const connected = {
        ...config(),
        auth: { mode, header: 'apikey' },
        headers: { 'X-Route': routeSecret },
      };
      expect(await gatewayProvider.listModels(connected)).toEqual([
        { model: 'embed-alias', name: 'embed-alias' },
        { model: 'opaque-alias', name: 'opaque-alias' },
      ]);
      expect(await gatewayProvider.embed!(connected, 'embed-alias', ['one', 'two'])).toEqual({
        vectors: [
          [1, 0],
          [0, 1],
        ],
        inputTokens: 8,
      });
      expect(
        textOf(
          await collect(
            gatewayProvider.stream(connected, {
              model: 'route-model',
              messages: [{ role: 'user', content: 'Yes?' }],
            }),
          ),
        ),
      ).toBe('Yes');
      await gatewayProvider.testConnection!(connected);
      expect(stub.requests).toHaveLength(4);
      for (const request of stub.requests) {
        expect(request.headers.authorization).toBe(mode === 'bearer' ? `Bearer ${gatewayKey}` : undefined);
        expect(request.headers.apikey).toBe(mode === 'header' ? gatewayKey : undefined);
        expect(request.headers['x-route']).toBe(routeSecret);
      }
    },
  );

  it.each([
    [
      400,
      { error: { message: "request body doesn't contain valid prompts" } },
      'ai.gateway.requestBufferTooSmall',
      undefined,
    ],
    [
      400,
      { error: { message: 'cannot use own model - must be: allowed-route' } },
      'ai.gateway.modelRestricted',
      { model: 'allowed-route' },
    ],
    [413, { error: { message: 'Payload too large' } }, 'ai.gateway.requestTooLarge', undefined],
  ])(
    'maps gateway HTTP %s (%j) consistently for chat and testing',
    async (status, body, messageKey, params) => {
      stub.handler = (_request, response) => response.json(Number(status), body);
      for (const operation of [operations.chat, operations.testing]) {
        await expect(operation(config())).rejects.toMatchObject({ messageKey, params, detail: undefined });
      }
      expect(stub.requests).toHaveLength(2);
    },
  );

  it('maps a plain-text model restriction and an HTML 413 response', async () => {
    stub.handler = (_request, response) =>
      response.text(400, 'cannot use own model - must be: allowed-route');
    await expect(operations.chat(config())).rejects.toMatchObject({
      messageKey: 'ai.gateway.modelRestricted',
      params: { model: 'allowed-route' },
    });
    stub.handler = (_request, response) => response.text(413, '<html>Request Entity Too Large</html>');
    await expect(operations.chat(config())).rejects.toMatchObject({
      messageKey: 'ai.gateway.requestTooLarge',
    });
    await expect(operations.testing(config())).rejects.toMatchObject({
      messageKey: 'ai.gateway.requestTooLarge',
    });
  });

  it.each(['chat', 'testing'] as const)(
    'recognizes chat errors after a redirect to a different path during %s',
    async (operation) => {
      for (const [detail, messageKey, params] of [
        ["request body doesn't contain valid prompts", 'ai.gateway.requestBufferTooSmall', undefined],
        [
          'cannot use own model - must be: allowed-route',
          'ai.gateway.modelRestricted',
          { model: 'allowed-route' },
        ],
      ] as const) {
        stub.handler = (request, response) => {
          if (request.url === '/v1/chat/completions') response.text(307, '', { location: '/conversation' });
          else response.json(400, { error: { message: detail } });
        };
        await expect(operations[operation](config())).rejects.toMatchObject({ messageKey, params });
        expect(stub.requests.at(-1)?.url).toBe('/conversation');
        expect(stub.requests.at(-1)?.body).toBe(stub.requests.at(-2)?.body);
      }
    },
  );

  it.each(['bearer', 'header', 'route', 'short'] as const)(
    'redacts the entire %s credential before shortening the required model',
    async (credential) => {
      const secret = randomUUID()
        .replaceAll('-', '')
        .slice(0, credential === 'short' ? 3 : 32);
      const lead = 'cannot use own model - must be: ';
      const prefix = 'r'.repeat(400 - lead.length - Math.min(12, secret.length - 1));
      const connected: ProviderConfig = {
        ...config(),
        apiKey: credential === 'bearer' || credential === 'header' ? secret : gatewayKey,
        auth: { mode: credential === 'header' ? ('header' as const) : ('bearer' as const), header: 'apikey' },
        headers: credential === 'route' || credential === 'short' ? { 'X-Route': secret } : {},
      };
      for (const plainText of [false, true]) {
        stub.handler = (_request, response) => {
          const detail = `${lead}${prefix}${secret}${'z'.repeat(100)}`;
          if (plainText) response.text(400, detail);
          else response.json(400, { error: { message: detail } });
        };
        for (const operation of [operations.chat, operations.testing]) {
          const error = await operation(connected).catch((cause: unknown) => cause);
          expect(error).toMatchObject({ messageKey: 'ai.gateway.modelRestricted', detail: undefined });
          const model = (error as ProviderError).params?.model;
          expect(model).toContain(`${prefix}[redacted]`);
          expect(model).not.toContain(`${prefix}${secret.slice(0, Math.min(12, secret.length - 1))}`);
          expect(model?.length).toBeLessThanOrEqual(401);
          expect(model).toMatch(/…$/);
        }
      }
    },
  );

  it('keeps invalid prompts as a bad request instead of blaming the buffer', async () => {
    stub.handler = (_request, response) =>
      response.json(400, { error: { message: "request body doesn't contain valid prompts" } });
    await expect(
      collect(gatewayProvider.stream(config(), { model: 'route-model', messages: [] })),
    ).rejects.toMatchObject({
      messageKey: 'ai.provider.badRequest',
      detail: undefined,
    });
  });

  it('scrubs routing secrets from the required model, including short values', async () => {
    const secret = randomUUID();
    const short = 'abc';
    stub.handler = (_request, response) =>
      response.json(400, {
        error: { message: `cannot use own model - must be: ${secret}-${short}-${gatewayKey}` },
      });
    for (const operation of [operations.chat, operations.testing])
      await expect(
        operation({ ...config(), headers: { 'X-Route': secret, 'X-Flag': short } }),
      ).rejects.toMatchObject({
        messageKey: 'ai.gateway.modelRestricted',
        params: { model: '[redacted]-[redacted]-[redacted]' },
        detail: undefined,
      });
  });

  it('withholds echoed extra header values, including short secrets, from provider errors', async () => {
    const shortSecret = randomUUID().replaceAll('-', '').slice(0, 3);
    stub.handler = (_request, response) =>
      response.json(400, { error: { message: `Invalid ${routeSecret} ${shortSecret}` } });
    await expect(
      gatewayProvider.listModels({ ...config(), headers: { 'X-Route': routeSecret, 'X-Flag': shortSecret } }),
    ).rejects.toMatchObject({ detail: undefined, message: 'ai.provider.badRequest' });
  });
});

describe('gateway connection diagnostics', () => {
  it.each([
    [401, 'Unauthorized', 'rejectedKey'],
    [403, 'Forbidden', 'rejectedKey'],
    [404, 'No route matched', 'wrongPath'],
    [404, 'model not found', 'modelNotFound'],
    [400, 'Unknown model', 'modelNotFound'],
    [500, 'Upstream failed', 'requestFailed'],
  ])('reports HTTP %s (%s) after exactly one request', async (status, detail, kind) => {
    stub.handler = (_request, response) => response.json(Number(status), { error: { message: detail } });
    await expect(gatewayProvider.testConnection!(config())).rejects.toMatchObject({
      messageKey: `ai.gateway.${kind}`,
    });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.json).toMatchObject({ stream: false, max_tokens: 1 });
  });
  it('reports an unreachable socket', async () => {
    const connected = config();
    await stub.stop();
    await expect(gatewayProvider.testConnection!(connected)).rejects.toMatchObject({
      messageKey: 'ai.gateway.unreachable',
    });
  });
  it('reports a TLS trust failure without weakening certificate validation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-gateway-provider-tls-'));
    let server: ReturnType<typeof createServer> | undefined;
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          join(dir, 'key.pem'),
          '-out',
          join(dir, 'cert.pem'),
          '-days',
          '1',
          '-subj',
          '/CN=localhost',
        ],
        { stdio: 'ignore' },
      );
      server = createServer(
        { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) },
        (_request, response) => response.end('{}'),
      );
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      await expect(
        gatewayProvider.testConnection!({
          ...config(),
          baseUrl: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
        }),
      ).rejects.toMatchObject({ messageKey: 'ai.gateway.tls' });
    } finally {
      server?.closeAllConnections();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('reports a missing configured model and malformed successful response', async () => {
    await expect(
      gatewayProvider.testConnection!({ ...config(), testModel: undefined }),
    ).rejects.toBeInstanceOf(ProviderError);
    stub.handler = (_request, response) => response.text(200, 'not-json');
    await expect(gatewayProvider.testConnection!(config())).rejects.toMatchObject({
      messageKey: 'ai.gateway.requestFailed',
    });
  });
});
