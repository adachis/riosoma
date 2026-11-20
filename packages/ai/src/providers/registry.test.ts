import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderConfig,
  type StreamPart,
} from '../types.js';
import { openaiProvider } from './openai.js';
import { providerFor, providers, registerProvider } from './registry.js';

/** A stand-in an app or a test can register in place of a real provider. */
function fake(id: string): ProviderAdapter {
  return {
    id,
    name: 'Fake',
    local: true,
    listModels: async (_config: ProviderConfig): Promise<ModelInfo[]> => [
      { model: 'fake-1', name: 'Fake One' },
    ],
    stream: (): AsyncIterable<StreamPart> =>
      (async function* stream(): AsyncGenerator<StreamPart> {
        yield { type: 'text', delta: 'from the fake' };
        yield { type: 'done', stop: 'end' };
      })(),
  };
}

describe('the provider registry', () => {
  it('hands out an adapter by id', () => {
    expect(providerFor('openai')).toBe(openaiProvider);
  });

  it('fails with a message key when an organization enables a provider Riosoma lacks', () => {
    let caught: unknown;
    try {
      providerFor('no-such-provider');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).messageKey).toBe('ai.providerUnavailable');
  });

  it('lets a caller add or replace one', async () => {
    registerProvider(fake('fake-provider'));
    expect(providerFor('fake-provider').local).toBe(true);
    expect(providers().some((adapter) => adapter.id === 'fake-provider')).toBe(true);

    registerProvider(fake('openai'));
    expect(providerFor('openai').name).toBe('Fake');
    // Putting the real one back leaves nothing else in this file seeing the stand-in.
    registerProvider(openaiProvider);
    expect(providerFor('openai')).toBe(openaiProvider);
  });
});
