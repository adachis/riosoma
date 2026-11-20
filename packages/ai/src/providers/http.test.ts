import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ProviderError,
  providerFor,
  type ChatRequest,
  type ProviderConfig,
  type StreamPart,
} from '../index.js';
import {
  PROVIDER_MESSAGE_KEYS,
  RetryableProviderError,
  retryAfterMs,
  scrubSecrets,
  providerFailure,
} from './errors.js';
import { streamSse, fetchJson, timeoutFor, DEFAULT_TIMEOUT_MS, type SseEvent } from './http.js';
import {
  collect,
  failureOf,
  lastRequest,
  startStub,
  stopOf,
  textOf,
  unusedPort,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { apiKey: KEY, baseUrl: stub.baseUrl, ...overrides };
}

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return { model: 'gpt-test', messages: [{ role: 'user', content: 'Hello' }], ...overrides };
}

function textChunk(text: string): string {
  return JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
}

async function runStream(overrides: Partial<ChatRequest> = {}): Promise<StreamPart[]> {
  return collect(provider.stream(config(), request(overrides)));
}

describe('how a failed call is reported', () => {
  it.each(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'])(
    'retains the underlying %s identifier',
    async (code) => {
      const cause = new TypeError('private request data', {
        cause: Object.assign(new Error('private request data'), { code }),
      });
      const error = await fetchJson({
        url: 'https://example.invalid',
        config: {},
        fetch: async () => {
          throw cause;
        },
      }).catch((error: unknown) => error);
      expect(error).toMatchObject({ cause });
      expect(providerFailure(error)).toEqual({ messageKey: PROVIDER_MESSAGE_KEYS.unavailable, cause: code });
    },
  );

  it('retains an idle timeout identifier without its private error text', async () => {
    const error = await fetchJson({
      url: 'https://example.invalid',
      config: { timeoutMs: 5 },
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new Error('private request data')), {
            once: true,
          });
        }),
    }).catch((error: unknown) => error);
    expect(providerFailure(error)).toEqual({
      messageKey: PROVIDER_MESSAGE_KEYS.timeout,
      cause: 'TimeoutError',
    });
  });

  it('drops custom names and codes that might contain private data', () => {
    const error = new ProviderError('private input', undefined, 'private details', false, undefined, {
      cause: Object.assign(new Error('private content'), { name: 'private-key', code: 'private-file.csv' }),
    });
    expect(providerFailure(error)).toEqual({
      messageKey: PROVIDER_MESSAGE_KEYS.unavailable,
      cause: 'ProviderError',
    });
  });
  it.each([
    [401, PROVIDER_MESSAGE_KEYS.unauthorized, false],
    [403, PROVIDER_MESSAGE_KEYS.unauthorized, false],
    [400, PROVIDER_MESSAGE_KEYS.badRequest, false],
    [404, PROVIDER_MESSAGE_KEYS.badRequest, false],
    [422, PROVIDER_MESSAGE_KEYS.badRequest, false],
    [500, PROVIDER_MESSAGE_KEYS.unavailable, true],
    [503, PROVIDER_MESSAGE_KEYS.unavailable, true],
  ])('maps %i to %s', async (status, messageKey, retryable) => {
    stub.handler = (_request, respond) =>
      respond.json(status, { error: { message: `Failed with ${status}` } });

    const error = (await failureOf(runStream())) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.messageKey).toBe(messageKey);
    expect(error.status).toBe(status);
    expect(error.retryable).toBe(retryable);
    // A retry only wastes the person's time on a fault that will not fix itself.
    expect(stub.requests).toHaveLength(retryable ? 3 : 1);
  });

  it('passes on what the provider said about a bad request', async () => {
    stub.handler = (_request, respond) =>
      respond.json(400, {
        error: { message: "The model 'gpt-test' does not exist", type: 'invalid_request_error' },
      });

    const error = (await failureOf(runStream())) as ProviderError;
    expect(error.messageKey).toBe(PROVIDER_MESSAGE_KEYS.badRequest);
    expect(error.detail).toBe("The model 'gpt-test' does not exist");
    expect(error.message).toBe("The model 'gpt-test' does not exist");
  });

  it('leaves a key out of an error, even when the provider echoes it back', async () => {
    stub.handler = (_request, respond) =>
      respond.json(400, { error: { message: `Rejected the key ${KEY} for this account` } });

    const error = (await failureOf(runStream())) as ProviderError;
    expect(error.detail).toBe('Rejected the key [redacted] for this account');
    expect(error.detail).not.toContain(KEY);
  });

  it("says nothing rather than repeat a proxy's HTML", async () => {
    stub.handler = (_request, respond) => {
      respond.text(502, '<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>', {
        'content-type': 'text/html',
      });
    };

    const error = (await failureOf(runStream())) as ProviderError;
    expect(error.messageKey).toBe(PROVIDER_MESSAGE_KEYS.unavailable);
    expect(error.detail).toBeUndefined();
  });

  it('reports a refusal as a refusal', async () => {
    stub.handler = (_request, respond) =>
      respond.json(400, { error: { message: 'The request was rejected', code: 'content_policy_violation' } });

    const error = (await failureOf(runStream())) as ProviderError;
    expect(error.messageKey).toBe(PROVIDER_MESSAGE_KEYS.filtered);
  });

  it('treats a rate limit as worth another try, and waits as long as asked', async () => {
    stub.handler = (_request, respond) => {
      respond.json(429, { error: { message: 'Too many requests' } }, { 'retry-after': '0' });
    };

    const error = (await failureOf(runStream())) as ProviderError;
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect(error.messageKey).toBe(PROVIDER_MESSAGE_KEYS.rateLimited);
    expect((error as RetryableProviderError).retryAfterMs).toBe(0);
    expect(stub.requests).toHaveLength(3);
  });

  it('reads a wait told in seconds or as a date', () => {
    expect(retryAfterMs(new Headers({ 'retry-after': '2' }))).toBe(2_000);
    expect(retryAfterMs(new Headers({ 'retry-after': '0.5' }))).toBe(500);
    expect(retryAfterMs(new Headers({ 'retry-after': 'not a wait' }))).toBeUndefined();
    expect(
      retryAfterMs(new Headers({ 'retry-after': new Date(Date.now() + 1_500).toUTCString() })),
    ).toBeGreaterThan(0);
    expect(retryAfterMs(new Headers())).toBeUndefined();
  });

  it('reports a provider that cannot be reached', async () => {
    const port = await unusedPort();
    const error = (await failureOf(
      collect(provider.stream({ baseUrl: `http://127.0.0.1:${port}` }, request())),
    )) as ProviderError;
    expect(error.messageKey).toBe(PROVIDER_MESSAGE_KEYS.unavailable);
    expect(error.retryable).toBe(true);
    expect(error.detail).toBeTruthy();
  });

  it('gives up after two retries and then succeeds on a later call', async () => {
    let calls = 0;
    stub.handler = (_request, respond) => {
      calls += 1;
      if (calls <= 2) {
        respond.json(500, { error: { message: 'Upstream had a moment' } });
        return;
      }
      void respond.sse([{ data: textChunk('Back.') }, { data: '[DONE]' }]);
    };

    const parts = await runStream();
    expect(textOf(parts)).toBe('Back.');
    expect(stub.requests).toHaveLength(3);
  });

  it('never retries once the person has seen something', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        { data: textChunk('Part of an answer') },
        // A failure inside a healthy stream, of a kind that would otherwise be retried.
        { data: JSON.stringify({ error: { message: 'Overloaded', type: 'overloaded_error' } }) },
      ]);

    const parts: StreamPart[] = [];
    const error = (await failureOf(
      (async () => {
        for await (const part of provider.stream(config(), request())) parts.push(part);
      })(),
    )) as ProviderError;
    expect(error.messageKey).toBe(PROVIDER_MESSAGE_KEYS.unavailable);
    expect(error.retryable).toBe(true);
    expect(stub.requests).toHaveLength(1);
    expect(textOf(parts)).toBe('Part of an answer');
  });

  it('reports a stream that dies mid-sentence as the provider being unavailable', async () => {
    stub.handler = async (_request, respond) => {
      const writer = respond.stream();
      writer.event({ data: textChunk('Half') });
      await sleep(10);
      writer.destroy();
    };

    const parts: StreamPart[] = [];
    const error = await failureOf(
      (async () => {
        for await (const part of provider.stream(config(), request())) parts.push(part);
      })(),
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).messageKey).toBe(PROVIDER_MESSAGE_KEYS.unavailable);
    expect(textOf(parts)).toBe('Half');
  });
});

describe('timeouts and aborts', () => {
  it('waits a minute by default for a call that never answers', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(60_000);
    expect(timeoutFor({})).toBe(DEFAULT_TIMEOUT_MS);
    expect(timeoutFor({ timeoutMs: 500 })).toBe(500);
    // A nonsense timeout must not turn into "give up at once".
    expect(timeoutFor({ timeoutMs: 0 })).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('gives up on a call that never answers', async () => {
    stub.handler = (_request, respond) => {
      respond.stall();
    };

    const error = (await failureOf(
      collect(provider.stream(config({ timeoutMs: 50 }), request())),
    )) as ProviderError;
    expect(error.messageKey).toBe(PROVIDER_MESSAGE_KEYS.timeout);
    expect(error.retryable).toBe(false);
    expect(error.detail).toContain('50 ms');
    expect(stub.requests).toHaveLength(1);
  });

  it('gives up on a stream that goes quiet', async () => {
    stub.handler = async (_request, respond) => {
      const writer = respond.stream();
      writer.event({ data: textChunk('Then nothing') });
      await sleep(500);
      writer.end();
    };

    const error = (await failureOf(
      collect(provider.stream(config({ timeoutMs: 60 }), request())),
    )) as ProviderError;
    expect(error.messageKey).toBe(PROVIDER_MESSAGE_KEYS.timeout);
  });

  it('keeps going while chunks keep arriving, however slowly', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        { data: textChunk('One'), delayMs: 40 },
        { data: textChunk('Two'), delayMs: 40 },
        { data: textChunk('Three'), delayMs: 40 },
        { data: textChunk('Four'), delayMs: 40 },
        { data: JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), delayMs: 40 },
        { data: '[DONE]' },
      ]);

    // Each chunk lands well inside the timeout, so the whole call may take far longer than it.
    const parts = await collect(provider.stream(config({ timeoutMs: 90 }), request()));
    expect(textOf(parts)).toBe('OneTwoThreeFour');
    expect(stopOf(parts)).toBe('end');
  });

  it('stops when the person stops, keeping what already arrived', async () => {
    const controller = new AbortController();
    let closed = false;
    stub.handler = async (_request, respond) => {
      respond.onClose(() => {
        closed = true;
      });
      const writer = respond.stream();
      for (let index = 0; index < 40; index += 1) {
        if (writer.closed) return;
        writer.event({ data: textChunk('more ') });
        await sleep(20);
      }
      writer.end();
    };

    const parts: StreamPart[] = [];
    const error = await failureOf(
      (async () => {
        for await (const part of provider.stream(config(), request({ signal: controller.signal }))) {
          parts.push(part);
          if (parts.length === 2) controller.abort();
        }
      })(),
    );
    expect((error as Error).name).toBe('AbortError');
    expect(textOf(parts)).toBe('more more ');
    expect(parts.some((part) => part.type === 'done')).toBe(false);
    // The socket is dropped rather than left generating tokens nobody will read.
    await sleep(30);
    expect(closed).toBe(true);
  });

  it('does not even call a provider once the person has stopped', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await failureOf(runStream({ signal: controller.signal }));
    expect((error as Error).name).toBe('AbortError');
    expect(stub.requests).toHaveLength(0);
  });

  it('stops waiting between retries when the person stops', async () => {
    const controller = new AbortController();
    stub.handler = (_request, respond) => {
      // The person stops while the first answer is still on its way back.
      controller.abort();
      respond.json(500, { error: { message: 'Down' } }, { 'retry-after': '30' });
    };

    const error = await failureOf(collect(provider.stream(config(), request({ signal: controller.signal }))));
    expect((error as Error).name).toBe('AbortError');
    expect(stub.requests).toHaveLength(1);
  });
});

describe('server-sent events', () => {
  function events(chunks: readonly SseEvent[]): string[] {
    return chunks.map((chunk) => (chunk.event ? `${chunk.event}:${chunk.data}` : chunk.data));
  }

  async function read(body: string | readonly string[]): Promise<SseEvent[]> {
    stub.handler = (_request, respond) => {
      const writer = respond.stream();
      for (const piece of typeof body === 'string' ? [body] : body) writer.write(piece);
      writer.end();
    };
    const seen: SseEvent[] = [];
    for await (const event of streamSse({
      url: `${stub.baseUrl}/events`,
      config: config({ timeoutMs: 5_000 }),
    })) {
      seen.push(event);
    }
    return seen;
  }

  it('reads data and event names', async () => {
    const seen = await read('event: message_start\ndata: {"a":1}\n\ndata: {"b":2}\n\n');
    expect(events(seen)).toEqual(['message_start:{"a":1}', '{"b":2}']);
  });

  it('joins several data lines into one payload', async () => {
    const seen = await read('data: {"text":\ndata: "two lines"}\n\n');
    expect(seen).toEqual([{ data: '{"text":\n"two lines"}' }]);
  });

  it('ignores heartbeats and blank fields', async () => {
    const seen = await read(': keep-alive\n\ndata: real\n\n:\n\n');
    expect(events(seen)).toEqual(['real']);
  });

  it('accepts the line endings a proxy may rewrite them to', async () => {
    const seen = await read('data: one\r\n\r\ndata: two\r\n\r\n');
    expect(events(seen)).toEqual(['one', 'two']);
  });

  it('keeps an event whose bytes arrive in pieces', async () => {
    const seen = await read(['data: {"whole"', ':true}\n', '\ndata: next\n\n']);
    expect(events(seen)).toEqual(['{"whole":true}', 'next']);
  });

  it('keeps the last event even with no blank line after it', async () => {
    const seen = await read('data: first\n\ndata: last');
    expect(events(seen)).toEqual(['first', 'last']);
  });
});

describe('scrubbing', () => {
  it('replaces a credential it was never told about', () => {
    // Built at run time so the test file itself never holds anything a secret scanner would flag.
    const echoed = `sk-${'a'.repeat(24)}`;
    expect(scrubSecrets(`The provider echoed ${echoed} back`, [])).toBe(
      'The provider echoed [redacted] back',
    );
    expect(scrubSecrets('authorization: Bearer synthetic-token', [])).toBe(
      'authorization: Bearer [redacted]',
    );
    expect(scrubSecrets('nothing to hide', ['synthetic-token'])).toBe('nothing to hide');
    expect(scrubSecrets('a synthetic-token b', ['synthetic-token'])).toBe('a [redacted] b');
    // Something too short to be a credential is left alone rather than blanking ordinary words.
    expect(scrubSecrets('the key is red', ['red'])).toBe('the key is red');
  });
});

describe('plain requests', () => {
  it('reads a catalog as JSON, and its failures as errors', async () => {
    stub.handler = (_request, respond) => respond.json(200, { data: [{ id: 'gpt-test' }] });
    const body = await fetchJson<{ data: Array<{ id: string }> }>({
      url: `${stub.baseUrl}/models`,
      method: 'GET',
      config: config(),
    });
    expect(body).toEqual({ data: [{ id: 'gpt-test' }] });
    expect(lastRequest(stub).headers.accept).toBe('application/json');
    expect(lastRequest(stub).headers['content-type']).toBeUndefined();

    stub.handler = (_request, respond) => respond.json(401, { error: { message: 'No key' } });
    const error = (await failureOf(
      fetchJson({ url: `${stub.baseUrl}/models`, method: 'GET', config: config() }),
    )) as ProviderError;
    expect(error.messageKey).toBe(PROVIDER_MESSAGE_KEYS.unauthorized);
  });

  it('reports a catalog that is not JSON at all', async () => {
    stub.handler = (_request, respond) => respond.text(200, 'not json', { 'content-type': 'text/plain' });
    const error = (await failureOf(
      fetchJson({ url: `${stub.baseUrl}/models`, method: 'GET', config: config() }),
    )) as ProviderError;
    expect(error.messageKey).toBe(PROVIDER_MESSAGE_KEYS.unavailable);
    expect(error.detail).toContain('not JSON');
  });
});
