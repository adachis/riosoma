import type { Preferences, PreferencesUpdate } from '@riosoma/contracts';
import { themeFor } from '../../preferences';
import { appliedSettings, useSession } from '../../session';
import { applied, useSavePreferences } from './usePreferences';
import { useSettingsDraft } from './SettingsDraft';

type Values = Partial<Record<keyof Preferences, unknown>>;

/** Settings preview locally and persist the complete preference draft from the page's save bar. */
export function useDraftPreferences() {
  const session = useSession();
  const store = useSavePreferences();
  const draft = useSettingsDraft(session?.preferences ?? {}, (preferences) => {
    const keys = new Set([...Object.keys(session?.preferences ?? {}), ...Object.keys(preferences)]);
    const patch = Object.fromEntries(
      [...keys]
        .filter(
          (key) =>
            JSON.stringify(preferences[key as keyof Preferences]) !==
            JSON.stringify(session?.preferences[key as keyof Preferences]),
        )
        .map((key) => [key, preferences[key as keyof Preferences] ?? null]),
    );
    return store.mutateAsync(patch as PreferencesUpdate);
  });
  return {
    ...store,
    preferences: draft.value,
    mutate: (patch: PreferencesUpdate) =>
      draft.setValue((current) => {
        const next = applied(current, patch);
        const defaults: Values = {
          celebrations: 'on',
          soundLevel: 'off',
          recordLayout: 'card',
          locale: appliedSettings(session)?.defaultLocale ?? 'en-US',
        };
        for (const key of Object.keys(defaults) as Array<keyof Preferences>)
          if (session?.preferences[key] === undefined && next[key] === defaults[key]) delete next[key];
        const beforeTheme = themeFor(session?.preferences, appliedSettings(session));
        const nextTheme = themeFor(next, appliedSettings(session));
        if (JSON.stringify(beforeTheme) === JSON.stringify(nextTheme))
          for (const key of ['theme', 'scheme', 'mode'] as const)
            if (session?.preferences[key] === undefined) delete next[key];
        return next;
      }),
  };
}
