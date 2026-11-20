import { DEFAULT_THEME, ThemeController, type ThemeChoice } from '@riosoma/tokens';
import type { OrgSettings, Preferences } from '@riosoma/contracts';
import { HAS_LANGUAGE_CHOICE } from '../../../packages/i18n/src/available';

export const themes = new ThemeController('/themes/');

const LOCALE_KEY = 'rio.locale';

export function rememberedLocale(): string | null {
  try {
    return localStorage.getItem(LOCALE_KEY);
  } catch {
    return null;
  }
}

export function rememberLocale(code: string): void {
  // A release fallback must preserve the person's choice for a later multilingual build.
  if (!HAS_LANGUAGE_CHOICE) return;
  try {
    localStorage.setItem(LOCALE_KEY, code);
  } catch {
    // Storage off: the language still applies for this visit.
  }
}

/** A person's own theme wins, then the organization's default, then Nature. */
export function themeFor(preferences: Preferences | undefined, org: OrgSettings | undefined): ThemeChoice {
  if (preferences?.theme)
    return { theme: preferences.theme, scheme: preferences.scheme, mode: preferences.mode };
  return org?.defaultTheme ?? DEFAULT_THEME;
}
