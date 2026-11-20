import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { providerFor, type ChatRequest, type ProviderConfig } from '../index.js';
import {
  callsOf,
  collect,
  lastBody,
  lastRequest,
  startStub,
  stopOf,
  textOf,
  TOOL,
  usageOf,
  type StubServer,
} from './harness.test-helpers.js';
import { ANTHROPIC_BASE_URL } from './anthropic.js';
import { GEMINI_BASE_URL } from './gemini.js';
import { MISTRAL_BASE_URL } from './mistral.js';
import { OLLAMA_BASE_URL, ollamaProvider } from './ollama.js';
import { OPENAI_BASE_URL } from './openai.js';
import { OPENROUTER_BASE_URL } from './openrouter.js';

const KEY = 'synthetic-compatible-key';

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
  return { model: 'test-model', messages: [{ role: 'user', content: 'Hello' }], ...overrides };
}

function delta(payload: Record<string, unknown>, finish: string | null = null): { data: string } {
  return { data: JSON.stringify({ choices: [{ index: 0, delta: payload, finish_reason: finish }] }) };
}

const DONE = { data: '[DONE]' };

describe('where each provider lives', () => {
  it('points at the endpoint its documentation names', () => {
    expect(OPENAI_BASE_URL).toBe('https://api.openai.com/v1');
    expect(MISTRAL_BASE_URL).toBe('https://api.mistral.ai/v1');
    expect(OPENROUTER_BASE_URL).toBe('https://openrouter.ai/api/v1');
    expect(OLLAMA_BASE_URL).toBe('http://localhost:11434/v1');
    expect(GEMINI_BASE_URL).toBe('https://generativelanguage.googleapis.com/v1beta');
    expect(ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
  });

  it('says which providers keep data in the building', () => {
    expect(providerFor('ollama').local).toBe(true);
    for (const id of ['openai', 'mistral', 'openrouter', 'gemini', 'anthropic']) {
      expect(providerFor(id).local, id).toBe(false);
    }
  });

  it('names each provider for the admin page', () => {
    expect(providerFor('mistral').name).toBe('Mistral');
    expect(providerFor('openrouter').name).toBe('OpenRouter');
    expect(ollamaProvider.name).toBe('Ollama');
  });
});

describe('the compatible providers', () => {
  it.each(['mistral', 'openrouter'])('%s streams the shared format', async (id) => {
    const provider = providerFor(id);
    stub.handler = (_request, respond) =>
      void respond.sse([
        delta({ role: 'assistant', content: 'Hel' }),
        delta({ content: 'lo' }),
        delta({}, 'stop'),
        { data: JSON.stringify({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 2 } }) },
        DONE,
      ]);

    const parts = await collect(provider.stream(config(), request()));
    expect(textOf(parts)).toBe('Hello');
    expect(usageOf(parts)).toEqual({ inputTokens: 8, outputTokens: 2 });
    expect(stopOf(parts)).toBe('end');
    expect(lastRequest(stub).url).toBe('/chat/completions');
    expect(lastRequest(stub).headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it.each(['mistral', 'openrouter'])('%s assembles tool calls the same way', async (id) => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        delta({
          tool_calls: [{ index: 0, id: 'call_1', function: { name: 'count_records', arguments: '{"tab' } }],
        }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'leId":"tbl1"}' } }] }),
        delta({}, 'tool_calls'),
        DONE,
      ]);

    const parts = await collect(providerFor(id).stream(config(), request({ tools: [TOOL] })));
    expect(callsOf(parts)).toEqual([{ id: 'call_1', name: 'count_records', arguments: { tableId: 'tbl1' } }]);
    expect(stopOf(parts)).toBe('toolCalls');
  });

  it('caps output with the field each provider reads', async () => {
    for (const [id, field] of [
      ['openai', 'max_completion_tokens'],
      ['mistral', 'max_tokens'],
      ['openrouter', 'max_tokens'],
      ['ollama', 'max_tokens'],
    ] as Array<[string, string]>) {
      stub.requests.length = 0;
      stub.handler = (_request, respond) => void respond.sse([delta({}, 'stop'), DONE]);
      await collect(providerFor(id).stream(config(), request({ maxOutputTokens: 640 })));
      expect(lastBody(stub)[field], id).toBe(640);
    }
  });

  it('asks for usage only from the providers that need asking', async () => {
    for (const [id, asked] of [
      ['openai', true],
      ['openrouter', true],
      ['mistral', false],
      ['ollama', false],
    ] as Array<[string, boolean]>) {
      stub.requests.length = 0;
      stub.handler = (_request, respond) => void respond.sse([delta({}, 'stop'), DONE]);
      await collect(providerFor(id).stream(config(), request()));
      expect(lastBody(stub).stream_options, id).toEqual(asked ? { include_usage: true } : undefined);
    }
  });

  it('still reads usage a provider sends without being asked', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([
        delta({ content: 'Counted.' }, 'stop'),
        { data: JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }) },
        DONE,
      ]);
    const parts = await collect(providerFor('mistral').stream(config(), request()));
    expect(usageOf(parts)).toEqual({ inputTokens: 12, outputTokens: 3 });
  });

  it('lists a catalog with display names', async () => {
    stub.handler = (_request, respond) =>
      respond.json(200, {
        data: [
          { id: 'writer/small', name: 'A Small Writer' },
          { id: 'writer/embed-1', name: 'An Embedder' },
          { id: 'writer/large-3-instruct', name: 'An Instruction Model' },
        ],
      });

    // An instruction-tuned open model is a chat model, even though the name looks like a legacy one.
    expect(await providerFor('openrouter').listModels(config())).toEqual([
      { model: 'writer/large-3-instruct', name: 'An Instruction Model' },
      { model: 'writer/small', name: 'A Small Writer' },
    ]);
  });

  it('lists what an account may use, embeddings and rerankers left out', async () => {
    stub.handler = (sent, respond) => {
      expect(sent.url).toBe('/models');
      respond.json(200, {
        object: 'list',
        data: [
          { id: 'mistral-small-latest', object: 'model' },
          { id: 'magistral-medium-latest', object: 'model' },
          { id: 'mistral-embed', object: 'model' },
          { id: 'mistral-moderation-latest', object: 'model' },
          { id: 'rerank-latest', object: 'model' },
          { id: 'devstral-small', object: 'model' },
        ],
      });
    };

    expect(await providerFor('mistral').listModels(config())).toEqual([
      { model: 'devstral-small', name: 'devstral-small' },
      { model: 'magistral-medium-latest', name: 'magistral-medium-latest' },
      { model: 'mistral-small-latest', name: 'mistral-small-latest' },
    ]);
  });
});

describe('a local server', () => {
  it('needs no key and sends none', async () => {
    stub.handler = (_request, respond) =>
      void respond.sse([delta({ content: 'Local answer' }, 'stop'), DONE]);
    const parts = await collect(
      ollamaProvider.stream({ baseUrl: `${stub.baseUrl}/v1` }, request({ model: 'llama3.2' })),
    );
    expect(textOf(parts)).toBe('Local answer');
    expect(lastRequest(stub).url).toBe('/v1/chat/completions');
    expect(lastRequest(stub).headers.authorization).toBeUndefined();
  });

  it('sends a key when the server asks for one', async () => {
    stub.handler = (_request, respond) => void respond.sse([delta({}, 'stop'), DONE]);
    await collect(ollamaProvider.stream(config(), request()));
    expect(lastRequest(stub).headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('reads models from the server root, beside the compatible endpoint', async () => {
    stub.handler = (sent, respond) => {
      expect(sent.url).toBe('/api/tags');
      respond.json(200, {
        models: [
          { name: 'llama3.2:latest', model: 'llama3.2:latest', size: 2_000_000_000 },
          { name: 'qwen2.5-coder:7b' },
          { name: 'nomic-embed-text:latest' },
          { name: 'llava:7b' },
          { model: 'mistral:latest' },
          { size: 1 },
        ],
      });
    };

    expect(await ollamaProvider.listModels({ baseUrl: `${stub.baseUrl}/v1` })).toEqual([
      { model: 'llama3.2:latest', name: 'llama3.2:latest' },
      { model: 'llava:7b', name: 'llava:7b' },
      { model: 'mistral:latest', name: 'mistral:latest' },
      { model: 'qwen2.5-coder:7b', name: 'qwen2.5-coder:7b' },
    ]);
  });
});
