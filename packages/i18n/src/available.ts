/** American English is the source.  The pseudo-locales exercise stretched and RTL layouts. */
export interface LocaleInfo {
  code: string;
  /** The language's name in itself, shown in the language picker */
  nativeName: string;
  dir: 'ltr' | 'rtl';
}

export const SOURCE_LOCALE = 'en-US';
export const PSEUDO_LOCALE = 'en-XA';
export const RTL_PSEUDO_LOCALE = 'en-XB';

export const LOCALE_CODES = [
  'en-US',
  'es',
  'fr',
  'de',
  'it',
  'pt-BR',
  'nl',
  'ja',
  'ko',
  'zh-Hans',
  'zh-Hant',
] as const;

declare const __RIOSOMA_LOCALES__: readonly string[] | undefined;
const enabled = typeof __RIOSOMA_LOCALES__ === 'undefined' ? undefined : __RIOSOMA_LOCALES__;

export const offeredLocaleCodes = enabled
  ? LOCALE_CODES.filter((code) => enabled.includes(code))
  : LOCALE_CODES;
export const supportedLocaleCodes = enabled ?? [...LOCALE_CODES, PSEUDO_LOCALE, RTL_PSEUDO_LOCALE];
export const HAS_LANGUAGE_CHOICE = offeredLocaleCodes.length > 1;

/** Direction belongs to negotiation.  Language names load with the feature that displays them. */
export function localeDirection(code: string): LocaleInfo['dir'] {
  return code === RTL_PSEUDO_LOCALE ? 'rtl' : 'ltr';
}

/** Picks the closest enabled locale, matching Chinese by script and other tags by base language. */
export function matchLocale(requested: readonly (string | null | undefined)[]): string {
  const supported = new Map(supportedLocaleCodes.map((code) => [code.toLowerCase(), code]));
  for (const tag of requested) {
    if (!tag) continue;
    const lower = tag.toLowerCase();
    const exact = supported.get(lower);
    if (exact) return exact;
    const base = lower.startsWith('zh')
      ? /hant|tw|hk|mo/.test(lower)
        ? 'zh-Hant'
        : 'zh-Hans'
      : lower.startsWith('pt')
        ? 'pt-BR'
        : lower.startsWith('en')
          ? SOURCE_LOCALE
          : lower.split('-')[0]!;
    const byBase = supported.get(base.toLowerCase());
    if (byBase) return byBase;
  }
  return SOURCE_LOCALE;
}
