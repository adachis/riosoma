import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('resolves browser tags, disabled preferences, and pseudo-locales to English in a release', async () => {
  vi.stubGlobal('__RIOSOMA_LOCALES__', ['en-US']);
  const { LOCALES, HAS_LANGUAGE_CHOICE, matchLocale } = await import('./locales');
  expect(LOCALES.map((locale) => locale.code)).toEqual(['en-US']);
  expect(HAS_LANGUAGE_CHOICE).toBe(false);
  for (const tag of ['fr', 'fr-CA', 'es', 'zh-TW', 'zh-CN', 'pt-PT', 'ja', 'en-XA', 'en-XB']) {
    expect(matchLocale([tag])).toBe('en-US');
    expect(matchLocale([tag, 'de', 'ja'])).toBe('en-US');
  }
});

it('offers exactly English and French when those languages are enabled', async () => {
  vi.stubGlobal('__RIOSOMA_LOCALES__', ['en-US', 'fr']);
  const { LOCALES, HAS_LANGUAGE_CHOICE, matchLocale } = await import('./locales');
  expect(LOCALES.map((locale) => locale.code)).toEqual(['en-US', 'fr']);
  expect(HAS_LANGUAGE_CHOICE).toBe(true);
  expect(matchLocale(['fr-CA'])).toBe('fr');
  expect(matchLocale(['zh-TW', 'fr'])).toBe('fr');
  expect(matchLocale(['pt-PT'])).toBe('en-US');
});
