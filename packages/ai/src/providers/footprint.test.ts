import { describe, expect, it } from 'vitest';
import { anthropicProvider } from './anthropic.js';
import { geminiProvider } from './gemini.js';
import { mistralProvider } from './mistral.js';
import { ollamaProvider } from './ollama.js';
import { openaiProvider } from './openai.js';
import { openrouterProvider } from './openrouter.js';

describe('the names footprint estimates look models up by', () => {
  it('names each hosted provider’s models the way the estimate’s data does', () => {
    expect(openaiProvider.footprintModel?.('gpt-4o')).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(mistralProvider.footprintModel?.('mistral-small-latest')).toEqual({
      provider: 'mistralai',
      model: 'mistral-small-latest',
    });
    expect(geminiProvider.footprintModel?.('gemini-2.5-pro')).toEqual({
      provider: 'google_genai',
      model: 'gemini-2.5-pro',
    });
    expect(anthropicProvider.footprintModel?.('claude-sonnet-4-6')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
  });

  it('maps a gateway model to its vendor only when the vendor prefix is known', () => {
    expect(openrouterProvider.footprintModel?.('openai/gpt-4o')).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
    });
    expect(openrouterProvider.footprintModel?.('google/gemini-2.5-pro')).toEqual({
      provider: 'google_genai',
      model: 'gemini-2.5-pro',
    });
    expect(openrouterProvider.footprintModel?.('someone/their-model')).toBeNull();
    expect(openrouterProvider.footprintModel?.('constructor/model')).toBeNull();
    expect(openrouterProvider.footprintModel?.('no-prefix')).toBeNull();
  });

  it('offers no name for tuned or local models, so they get no estimate rather than a guess', () => {
    expect(geminiProvider.footprintModel?.('tunedModels/mine')).toBeNull();
    expect(ollamaProvider.footprintModel).toBeUndefined();
  });
});
