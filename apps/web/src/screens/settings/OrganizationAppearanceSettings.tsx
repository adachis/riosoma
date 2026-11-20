import { useState, type CSSProperties } from 'react';
import { faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LOGO_MAX_BYTES,
  type LogoUpload,
  type LogoChange,
  type UnitPolicyView,
  type OrganizationAppearance,
  type OrganizationLogo as Logo,
} from '@riosoma/contracts';
import { Banner, Button, Heading, ListBoxItem, Select, Text, Tooltip, TooltipTrigger } from '@riosoma/ui';
import { api } from '../../api';
import { appliedSettings, useSession } from '../../session';
import { themes, themeFor } from '../../preferences';
import { OrganizationLogo } from '../../brand/OrganizationLogo';
import { RiosomaLogo } from '../../brand/RiosomaLogo';
import { Setting, defineSettingsPage } from './Setting';
import { useSettingsDraft } from './SettingsDraft';
import './organization-appearance.css';
import { PolicyField } from './units/PolicyFields';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'organization',
  page: 'organization-appearance',
  label: msg({ id: 'branding.settings.title', message: 'Organization appearance' }),
  roles: ['organization-people'],
  keywords: msg({
    id: 'branding.settings.keywords',
    message: 'logo brand appearance SVG PNG compact theme colors',
  }),
});

type Draft = {
  main: LogoUpload | null | undefined;
  compact: LogoUpload | null | undefined;
  mode: 'theme' | 'original';
};
const imageUrl = (upload: LogoUpload) => `data:${upload.type};base64,${upload.data}`;

export function OrganizationAppearanceSettings() {
  const { t } = useLingui();
  const session = useSession();
  const cache = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const logo = session?.org.settings.logo ?? null;
  const stored: Draft = { main: undefined, compact: undefined, mode: logo?.mode ?? 'theme' };
  const draft = useSettingsDraft(stored, async (change) => {
    const command: LogoChange & { kind: 'organization.logo' } = { ...change, kind: 'organization.logo' };
    await api('/api/org/admin-commands', { body: command });
    await cache.invalidateQueries({ queryKey: ['session'] });
  });
  const theme = themeFor(session?.preferences, appliedSettings(session));
  const manifest = useQuery({
    queryKey: ['themes', 'manifest', theme.theme],
    queryFn: () => themes.manifest(theme.theme),
    staleTime: Infinity,
  });
  const current = draft.value;
  const main =
    current.main === undefined
      ? logo?.main
      : current.main === null
        ? null
        : { key: '', type: current.main.type, storage: 'postgres' as const };
  const compact =
    current.compact === undefined
      ? (logo?.compact ?? null)
      : current.compact === null
        ? null
        : { key: '', type: current.compact.type, storage: 'postgres' as const };
  const previewLogo: Logo | null = main ? { main, compact, mode: current.mode } : null;
  const mainUrl = current.main ? imageUrl(current.main) : logo ? `/api/org/logo/${logo.main.key}` : '';
  const compactUrl = current.compact
    ? imageUrl(current.compact)
    : current.compact === null
      ? mainUrl
      : logo?.compact
        ? `/api/org/logo/${logo.compact.key}`
        : mainUrl;
  async function upload(file: File | undefined, part: 'main' | 'compact') {
    setError(null);
    if (!file) return;
    if (file.size === 0 || file.size > LOGO_MAX_BYTES) {
      setError(t({ id: 'branding.settings.size', message: 'Choose a logo no larger than 256 KB.' }));
      return;
    }
    const type =
      file.type === 'image/png'
        ? 'image/png'
        : file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')
          ? 'image/svg+xml'
          : null;
    if (!type) {
      setError(t({ id: 'branding.settings.type', message: 'Choose an SVG or PNG logo.' }));
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let raw = '';
    for (const byte of bytes) raw += String.fromCharCode(byte);
    draft.setValue((value) => ({ ...value, [part]: { type, data: btoa(raw) } }));
  }
  return (
    <>
      <ThemeDefaults />
      <Setting
        page={settingsPage}
        id="logo"
        label={msg({ id: 'branding.settings.logo', message: 'Organization logo' })}
      >
        <section className="rio-organization-appearance" data-anchor="branding.settings.logo">
          <Heading level={2}>
            <Trans id="branding.settings.logo">Organization logo</Trans>
          </Heading>
          <Text>
            {t({
              id: 'branding.settings.description',
              message:
                'Use an SVG or PNG no larger than 256 KB.  The logo appears in the shell, on the sign-in screen, and while the app loads.',
            })}
          </Text>
          <label>
            <Trans id="branding.settings.upload">Upload a logo</Trans>
            <input
              type="file"
              accept="image/svg+xml,image/png"
              disabled={draft.saving}
              onChange={(event) => {
                void upload(event.target.files?.[0], 'main');
                event.target.value = '';
              }}
            />
          </label>
          <label>
            <Trans id="branding.settings.compact">Optional compact mark</Trans>
            <input
              type="file"
              accept="image/svg+xml,image/png"
              disabled={!main || draft.saving}
              onChange={(event) => {
                void upload(event.target.files?.[0], 'compact');
                event.target.value = '';
              }}
            />
          </label>
          <Setting
            page={settingsPage}
            id="colors"
            label={msg({ id: 'branding.settings.colors', message: 'Logo colors' })}
          >
            <Select
              label={t({ id: 'branding.settings.colors', message: 'Logo colors' })}
              selectedKey={current.mode}
              isDisabled={!main || draft.saving}
              onSelectionChange={(key) =>
                draft.setValue((value) => ({ ...value, mode: key === 'original' ? 'original' : 'theme' }))
              }
            >
              <ListBoxItem id="theme">
                <Trans id="branding.settings.match">Match the theme</Trans>
              </ListBoxItem>
              <ListBoxItem id="original">
                <Trans id="branding.settings.keep">Keep the logo’s own colors</Trans>
              </ListBoxItem>
            </Select>
          </Setting>
          <div className="rio-logo-previews">
            {(['light', 'dark'] as const).map((appearance) => {
              const scheme = manifest.data?.schemes.find((scheme) => scheme.appearance === appearance);
              const inverted = manifest.data && !scheme;
              return (
                <div
                  key={appearance}
                  className="rio-logo-preview"
                  data-scheme={scheme?.id}
                  style={
                    {
                      '--rio-preview-background': inverted ? 'var(--rio-text)' : 'var(--rio-surface)',
                      '--rio-preview-ink': inverted ? 'var(--rio-surface)' : 'var(--rio-text)',
                    } as CSSProperties
                  }
                >
                  <Text>
                    {appearance === 'light'
                      ? t({ id: 'branding.settings.light', message: 'Light surface' })
                      : t({ id: 'branding.settings.dark', message: 'Dark surface' })}
                  </Text>
                  <div className="rio-logo-preview__art">
                    {previewLogo ? (
                      <OrganizationLogo
                        logo={previewLogo}
                        name={session?.org.name ?? ''}
                        preview={{ main: mainUrl, compact: compactUrl }}
                      />
                    ) : (
                      <RiosomaLogo />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {main && (
            <TooltipTrigger>
              <Button
                variant="quiet"
                icon={faTrashCan}
                aria-label={t({ id: 'branding.settings.remove', message: 'Remove logo' })}
                isDisabled={draft.saving}
                onPress={() => draft.setValue((value) => ({ ...value, main: null, compact: null }))}
              />
              <Tooltip>
                <Trans id="branding.settings.remove">Remove logo</Trans>
              </Tooltip>
            </TooltipTrigger>
          )}
          {compact && (
            <TooltipTrigger>
              <Button
                variant="quiet"
                icon={faTrashCan}
                aria-label={t({ id: 'branding.settings.removeCompact', message: 'Remove compact mark' })}
                isDisabled={draft.saving}
                onPress={() => draft.setValue((value) => ({ ...value, compact: null }))}
              />
              <Tooltip>
                <Trans id="branding.settings.removeCompact">Remove compact mark</Trans>
              </Tooltip>
            </TooltipTrigger>
          )}
          {error && <Banner tone="danger">{error}</Banner>}
        </section>
      </Setting>
    </>
  );
}

function ThemeDefaults() {
  const cache = useQueryClient();
  const policy = useQuery({
    queryKey: ['org', 'unit-policy'],
    queryFn: () => api<UnitPolicyView>('/api/admin/unit-policy'),
  });
  const stored: OrganizationAppearance = {
    defaultTheme: policy.data?.own.defaultTheme ?? null,
    allowedThemes: policy.data?.own.allowedThemes ?? null,
  };
  const draft = useSettingsDraft(stored, async (value) => {
    await api('/api/org/admin-commands', { body: { kind: 'organization.appearance', ...value } });
    await cache.invalidateQueries({ queryKey: ['org', 'unit-policy'] });
    await cache.invalidateQueries({ queryKey: ['session'] });
  });
  return (
    <Setting
      page={settingsPage}
      id="themes"
      label={msg({ id: 'branding.settings.themes', message: 'Organization themes' })}
    >
      <section className="rio-organization-appearance">
        <Heading level={2}>
          <Trans id="branding.settings.themes">Organization themes</Trans>
        </Heading>
        {(['defaultTheme', 'allowedThemes'] as const).map((setting) => (
          <PolicyField
            key={setting}
            setting={setting}
            value={draft.value[setting]}
            isDisabled={!policy.data || draft.saving}
            onChange={(value) => draft.setValue((current) => ({ ...current, [setting]: value }))}
          />
        ))}
      </section>
    </Setting>
  );
}
