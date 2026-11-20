import { useEffect } from 'react';
import type { SessionInfo } from '@riosoma/contracts';
import type { ThemeChoice } from '@riosoma/tokens';
import { useOverriddenTheme } from '../features/themes/override';
import { themeFor, themes } from '../preferences';
import { appliedSettings } from '../session';

/**
 * Keeps the page's theme in step with the person's preference and the organization default, or
 * with a theme shown in their place for now, such as an open database's.  A theme shown for now
 * is never remembered as the one to paint the next visit with.
 */
export function useAppliedTheme(session: SessionInfo | null): void {
  const override = useOverriddenTheme();
  useTheme(override ?? themeFor(session?.preferences, appliedSettings(session)), { remember: !override });
}

/** Applies one theme to the whole page, and again only when the choice changes.  Null waits. */
export function useTheme(choice: ThemeChoice | null, options: { remember?: boolean } = {}): void {
  const key = choice ? [choice.theme, choice.scheme ?? '', choice.mode ?? ''].join('|') : '';
  const remember = options.remember !== false;
  useEffect(() => {
    if (!key) return;
    const [theme = '', scheme, mode] = key.split('|');
    const next = { theme, scheme: scheme || undefined, mode: mode || undefined };
    (remember ? themes.apply(next) : themes.apply(next, { remember: false })).catch(() => {
      // A missing theme leaves the current one in place, and the settings screen reports it.
    });
  }, [key, remember]);
}
