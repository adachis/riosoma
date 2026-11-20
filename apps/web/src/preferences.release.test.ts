import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('preserves a saved language while an English-only release hides the choice', async () => {
  vi.stubGlobal('__RIOSOMA_LOCALES__', ['en-US']);
  localStorage.setItem('rio.locale', 'fr');
  const { rememberLocale, rememberedLocale } = await import('./preferences');
  rememberLocale('en-US');
  expect(rememberedLocale()).toBe('fr');
});

it('remembers a language when a build offers a choice', async () => {
  vi.stubGlobal('__RIOSOMA_LOCALES__', ['en-US', 'fr']);
  const { rememberLocale, rememberedLocale } = await import('./preferences');
  rememberLocale('fr');
  expect(rememberedLocale()).toBe('fr');
});
