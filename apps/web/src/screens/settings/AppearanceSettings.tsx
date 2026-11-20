import { useTheme } from '../../shell/useAppliedTheme';
import { useEffect, useRef } from 'react';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from './Setting';

import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { Radio as AriaRadio, RadioGroup as AriaRadioGroup } from 'react-aria-components';
import { ComboBox, ListBoxItem, Select, Spinner, Text } from '@riosoma/ui';
import { themeFor, themes } from '../../preferences';
import { appliedSettings, useSession } from '../../session';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../setup/useSetup';
import { useDraftPreferences } from './useDraftPreferences';

const settingsPage = defineSettingsPage({
  area: 'personal',
  section: 'preferences',
  page: 'appearance',
  label: msg({ id: 'settings.nav.appearance', message: 'Appearance' }),
  roles: ['personal'],
  keywords: msg({
    id: 'settings.search.keywords.appearance',
    message: 'theme color scheme layout light dark',
  }),
});

/**
 * Theme and color scheme.  Every scheme of the chosen theme is previewed with its own colors,
 * which works because a scheme is only an attribute once the theme's stylesheet is loaded.
 */
export function AppearanceSettings() {
  const { t } = useLingui();
  const session = useSession();
  const save = useDraftPreferences();
  useTheme(themeFor(save.preferences, appliedSettings(session)), { remember: false });
  const storedTheme = themeFor(session?.preferences, appliedSettings(session));
  const storedKey = JSON.stringify(storedTheme);
  const restoreTheme = useRef(storedTheme);
  useEffect(() => {
    restoreTheme.current = JSON.parse(storedKey);
  }, [storedKey]);
  useEffect(
    () => () => {
      void themes.apply(restoreTheme.current, { remember: false });
    },
    [],
  );
  const current = themeFor(save.preferences, appliedSettings(session));
  const manifestQuery = useQuery({
    queryKey: ['themes', 'manifest', current.theme],
    queryFn: () => themes.manifest(current.theme),
    staleTime: Infinity,
  });
  const manifest = manifestQuery.data;

  const index = useQuery({
    queryKey: ['themes', 'index'],
    queryFn: () => themes.list(),
    staleTime: Infinity,
  });
  const allowed = appliedSettings(session)?.allowedThemes;
  const choices = (index.data ?? []).filter((th) => !allowed || allowed.includes(th.id));

  // A new theme starts at its own default scheme and mode; the old theme's scheme would be
  // meaningless there, and a missing key in a save would keep it.
  const chooseTheme = async (theme: string) => {
    const next = await themes.manifest(theme);
    save.mutate({
      theme,
      scheme: next.defaultScheme,
      ...(next.modes.length && next.defaultMode ? { mode: next.defaultMode } : {}),
    });
  };
  const chooseScheme = (scheme: string) => {
    save.mutate({ theme: current.theme, scheme, ...(current.mode ? { mode: current.mode } : {}) });
  };

  // The scheme grid determines the height of this form, so its controls appear together.
  if (index.isPending || manifestQuery.isPending)
    return (
      <Spinner label={t({ id: 'settings.appearance.loading', message: 'Loading appearance settings' })} />
    );
  if (index.error || manifestQuery.error)
    return <ErrorBanner error={errorInfo(index.error ?? manifestQuery.error)} />;

  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'settings.nav.appearance', message: 'Appearance' })}
      help={msg({
        id: 'settings.appearance.note',
        message: 'Your theme follows you to every device where you sign in.',
      })}
    >
      {
        <div className="rio-appearance">
          <div data-anchor="settings.appearance.theme">
            <Setting
              page={settingsPage}
              id="theme"
              label={msg({ id: 'settings.appearance.theme', message: 'Theme' })}
            >
              <ComboBox
                label={t({ id: 'settings.appearance.theme', message: 'Theme' })}
                selectedKey={current.theme}
                onSelectionChange={(key) => key && void chooseTheme(String(key))}
              >
                {choices.map((th) => (
                  <ListBoxItem key={th.id} id={th.id} textValue={th.name}>
                    {th.name}
                  </ListBoxItem>
                ))}
              </ComboBox>
            </Setting>
          </div>
          {manifest ? (
            <Setting
              page={settingsPage}
              id="color-scheme"
              label={msg({ id: 'settings.appearance.scheme', message: 'Color scheme' })}
            >
              <AriaRadioGroup
                className="rio-appearance__schemes"
                data-anchor="settings.appearance.scheme"
                aria-label={t({ id: 'settings.appearance.scheme', message: 'Color scheme' })}
                value={current.scheme ?? manifest.defaultScheme}
                onChange={chooseScheme}
              >
                <div className="rio-appearance__legend" aria-hidden="true">
                  <Trans id="settings.appearance.scheme">Color scheme</Trans>
                </div>
                <div className="rio-appearance__grid">
                  {manifest.schemes.map((scheme) => (
                    // Each card carries its own scheme, so it previews that scheme's real colors.
                    <AriaRadio
                      key={scheme.id}
                      value={scheme.id}
                      className="rio-scheme-card"
                      data-scheme={scheme.id}
                    >
                      <span className="rio-scheme-card__swatches" aria-hidden="true">
                        <span className="rio-swatch-bg" />
                        <span className="rio-swatch-surface" />
                        <span className="rio-swatch-accent" />
                        <span className="rio-swatch-text" />
                      </span>
                      <span className="rio-scheme-card__name">{scheme.name}</span>
                    </AriaRadio>
                  ))}
                </div>
              </AriaRadioGroup>
            </Setting>
          ) : null}
          <Setting
            page={settingsPage}
            id="record-layout"
            label={msg({ id: 'record.layout', message: 'Record layout' })}
          >
            <Select
              label={t({ id: 'record.layout', message: 'Record layout' })}
              selectedKey={save.preferences.recordLayout ?? 'card'}
              onSelectionChange={(key) => save.mutate({ recordLayout: key === 'panel' ? 'panel' : 'card' })}
            >
              <ListBoxItem id="card">{t({ id: 'record.layout.card', message: 'Card' })}</ListBoxItem>
              <ListBoxItem id="panel">{t({ id: 'record.layout.panel', message: 'Side panel' })}</ListBoxItem>
            </Select>
          </Setting>
          {save.isError ? <ErrorBanner error={errorInfo(save.error)} /> : null}
          <Text variant="muted">
            <Trans id="settings.appearance.note">
              Your theme follows you to every device where you sign in.
            </Trans>
          </Text>
        </div>
      }
    </Setting>
  );
}
