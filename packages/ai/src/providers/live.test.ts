import { describe, expect, it } from 'vitest';
import { providerFor, type ChatMessage, type ChatRequest, type ProviderConfig } from '../index.js';
import { callsOf, collect, stopOf, textOf, TOOL, usageOf } from './harness.test-helpers.js';

/**
 * A smoke check against the real providers, so a changed wire format is caught before Rio is.  Each
 * suite runs only when its key is in the environment, which keeps an ordinary test run on this
 * machine, off the network, and free.
 *
 * Set `RIOSOMA_TEST_AI_<PROVIDER>_KEY` to turn a provider on, `RIOSOMA_TEST_AI_<PROVIDER>_MODEL`
 * to point it at a model the account can reach, and `RIOSOMA_TEST_AI_<PROVIDER>_URL` to send it
 * through a gateway.  For a local provider the key only has to exist; it is never sent.
 */

function variable(id: string, what: 'KEY' | 'MODEL' | 'URL'): string {
  return `RIOSOMA_TEST_AI_${id.toUpperCase().replace(/-/g, '_')}_${what}`;
}

function optional(id: string, what: 'KEY' | 'MODEL' | 'URL'): string | undefined {
  const value = process.env[variable(id, what)];
  return value && value.trim() ? value.trim() : undefined;
}

function keyFor(id: string): string | undefined {
  return optional(id, 'KEY');
}

function modelFor(id: string, fallback: string): string {
  return optional(id, 'MODEL') ?? fallback;
}

function liveSuite(id: string, fallbackModel: string): void {
  const key = keyFor(id);
  const accessKeyId = process.env.RIOSOMA_TEST_AI_BEDROCK_ACCESS_KEY_ID;
  const secretAccessKey = process.env.RIOSOMA_TEST_AI_BEDROCK_SECRET_ACCESS_KEY;
  const aws =
    id === 'bedrock' && accessKeyId && secretAccessKey
      ? {
          accessKeyId,
          secretAccessKey,
          sessionToken: process.env.RIOSOMA_TEST_AI_BEDROCK_SESSION_TOKEN,
          region: process.env.RIOSOMA_TEST_AI_BEDROCK_REGION ?? 'us-east-1',
        }
      : undefined;
  const provider = providerFor(id);
  describe.skipIf(!key && !aws)(`${id}, live`, () => {
    const config: ProviderConfig = {
      // A local server wants no credential, and a key it never asked for is one more thing to leak.
      apiKey: provider.local ? undefined : key,
      ...(aws ? { aws } : {}),
      baseUrl: optional(id, 'URL'),
      timeoutMs: 60_000,
    };
    const ask: ChatRequest = {
      model: modelFor(id, fallbackModel),
      messages: [
        { role: 'system', content: 'Answer in one short sentence. Use a tool when one fits.' },
        { role: 'user', content: 'How many records are in the Orders table?' },
      ],
      tools: [TOOL],
      maxOutputTokens: 300,
      temperature: 0,
    };

    it('streams a reply the person can read', async () => {
      const parts = await collect(provider.stream(config, ask));
      const calls = callsOf(parts);
      // Either an answer or a call for the records proves the wire works end to end.
      expect(calls.length > 0 || textOf(parts).length > 0).toBe(true);
      expect(['end', 'toolCalls', 'length']).toContain(stopOf(parts));
      for (const call of calls) {
        expect(call.id.length).toBeGreaterThan(0);
        expect(call.name).toBe(TOOL.name);
        expect(call.arguments).toBeTypeOf('object');
      }
      const usage = usageOf(parts);
      if (usage) {
        expect(usage.inputTokens).toBeGreaterThan(0);
        expect(usage.outputTokens).toBeGreaterThan(0);
      }
    }, 120_000);

    it('takes a tool result back and finishes the answer', async () => {
      // Send back the model's own call, so anything it attached, like a thought signature, goes too.
      const first = await collect(provider.stream(config, ask));
      const call = callsOf(first)[0] ?? {
        id: 'call_1',
        name: TOOL.name,
        arguments: { tableId: 'tblOrders' },
      };
      const messages: ChatMessage[] = [
        ...ask.messages,
        { role: 'assistant', content: textOf(first), toolCalls: [call] },
        { role: 'tool', toolCallId: call.id, name: call.name, content: '{"count":42}' },
      ];
      const parts = await collect(provider.stream(config, { ...ask, messages }));
      expect(textOf(parts).length + callsOf(parts).length).toBeGreaterThan(0);
      expect(['end', 'length', 'toolCalls']).toContain(stopOf(parts));
    }, 120_000);

    it('lists the models the account can use', async () => {
      const models = await provider.listModels(config);
      expect(models.length).toBeGreaterThan(0);
      for (const model of models.slice(0, 5)) {
        expect(model.model.length).toBeGreaterThan(0);
        expect(model.name.length).toBeGreaterThan(0);
      }
    }, 120_000);
  });
}

liveSuite('openai', 'gpt-6-luna');
liveSuite('gemini', 'gemini-3.5-flash-lite');
liveSuite('mistral', 'mistral-small-latest');
liveSuite('anthropic', 'claude-haiku-4-5-20251001');
liveSuite('openrouter', 'openai/gpt-6-luna');
liveSuite('ollama', 'llama3.2');
liveSuite('bedrock', 'amazon.nova-lite-v1:0');
liveSuite('vertex', 'gemini-2.5-flash');
liveSuite('azure', 'team-chat');
