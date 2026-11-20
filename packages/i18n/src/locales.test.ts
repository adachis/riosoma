import { describe, expect, it } from 'vitest';
import { localeInfo, matchLocale } from './locales';

describe('matchLocale', () => {
  it('keeps both pseudo-locales distinct and gives the RTL variant its direction', () => {
    expect(matchLocale(['en-xa'])).toBe('en-XA');
    expect(matchLocale(['en-xb'])).toBe('en-XB');
    expect(localeInfo('en-XA').dir).toBe('ltr');
    expect(localeInfo('en-XB').dir).toBe('rtl');
  });
  it('prefers exact matches, then the base language', () => {
    expect(matchLocale(['fr-CA'])).toBe('fr');
    expect(matchLocale(['pt-PT'])).toBe('pt-BR');
    expect(matchLocale(['en-GB'])).toBe('en-US');
    expect(matchLocale(['xx', 'de-AT'])).toBe('de');
  });

  it('matches Chinese by script', () => {
    expect(matchLocale(['zh-TW'])).toBe('zh-Hant');
    expect(matchLocale(['zh-Hant-HK'])).toBe('zh-Hant');
    expect(matchLocale(['zh-CN'])).toBe('zh-Hans');
    expect(matchLocale(['zh'])).toBe('zh-Hans');
  });

  it('falls back to American English', () => {
    expect(matchLocale([])).toBe('en-US');
    expect(matchLocale([null, undefined, 'tlh'])).toBe('en-US');
  });
});
