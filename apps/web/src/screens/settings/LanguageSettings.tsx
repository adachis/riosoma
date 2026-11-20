import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from './Setting';

import { Trans, useLingui } from '@lingui/react/macro';
import { HAS_LANGUAGE_CHOICE, LOCALES, matchLocale } from '@riosoma/i18n';
import { Radio, RadioGroup, Text } from '@riosoma/ui';
import { useDraftPreferences } from './useDraftPreferences';

const settingsPage = defineSettingsPage({
  area: 'personal',
  section: 'preferences',
  page: 'language',
  label: msg({ id: 'settings.nav.language', message: 'Language' }),
  roles: ['personal'],
  keywords: msg({
    id: 'settings.search.keywords.language',
    message: 'language locale dates times numbers emails',
  }),
});

export function LanguageSettings() {
  const { t, i18n } = useLingui();
  const save = useDraftPreferences();
  const current = matchLocale([save.preferences.locale ?? i18n.locale]);
  if (!HAS_LANGUAGE_CHOICE) return null;

  const choose = async (code: string) => {
    save.mutate({ locale: code });
  };

  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'settings.nav.language', message: 'Language' })}
    >
      {
        <div data-anchor="settings.language">
          <Setting
            page={settingsPage}
            id="language"
            label={msg({ id: 'settings.language.label', message: 'Language' })}
            help={msg({
              id: 'settings.language.note',
              message: 'Dates, times, numbers, and the emails Riosoma sends you follow this choice.',
            })}
          >
            <RadioGroup
              label={t({ id: 'settings.language.label', message: 'Language' })}
              value={current}
              onChange={(code: string) => void choose(code)}
            >
              {LOCALES.map((l) => (
                <Radio key={l.code} value={l.code}>
                  <span lang={l.code}>{l.nativeName}</span>
                </Radio>
              ))}
            </RadioGroup>
          </Setting>
          <Text variant="muted">
            <Trans id="settings.language.note">
              Dates, times, numbers, and the emails Riosoma sends you follow this choice.
            </Trans>
          </Text>
        </div>
      }
    </Setting>
  );
}
