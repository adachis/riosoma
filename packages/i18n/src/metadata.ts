import {
  offeredLocaleCodes,
  localeDirection,
  PSEUDO_LOCALE,
  RTL_PSEUDO_LOCALE,
  type LOCALE_CODES,
  type LocaleInfo,
} from './available';

const names: Record<(typeof LOCALE_CODES)[number], string> = {
  'en-US': 'English (US)',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  'pt-BR': 'Português (Brasil)',
  nl: 'Nederlands',
  ja: '日本語',
  ko: '한국어',
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
};

export const LOCALES: readonly LocaleInfo[] = offeredLocaleCodes.map((code) => ({
  code,
  nativeName: names[code],
  dir: localeDirection(code),
}));

const PSEUDO: LocaleInfo = { code: PSEUDO_LOCALE, nativeName: 'Pseudo', dir: 'ltr' };
const RTL_PSEUDO: LocaleInfo = { ...PSEUDO, code: RTL_PSEUDO_LOCALE, dir: 'rtl' };

export function localeInfo(code: string): LocaleInfo {
  return (
    LOCALES.find((locale) => locale.code === code) ??
    (code === PSEUDO_LOCALE ? PSEUDO : code === RTL_PSEUDO_LOCALE ? RTL_PSEUDO : LOCALES[0]!)
  );
}
