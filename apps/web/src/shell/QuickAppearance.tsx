import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { LEVELS, themeAllowed, type PreferencesUpdate } from '@riosoma/contracts';
import { LEVEL_NAMES } from '../levels/words';
import { Dialog, DialogBody, DialogTitle, ListBoxItem, Modal, Select } from '@riosoma/ui';
import { themeFor, themes } from '../preferences';
import { appliedSettings, useSession } from '../session';
import { useOverriddenTheme } from '../features/themes/override';
import { useSavePreferences } from '../screens/settings/usePreferences';
import { useServerMessage } from '../messages/shellMessage';
import { ApiError } from '../api';

export function QuickAppearance({ onClose }: { onClose(): void }) {
  const { t, i18n } = useLingui();
  const session = useSession();
  const save = useSavePreferences();
  const message = useServerMessage();
  const override = useOverriddenTheme();
  const current = themeFor(session?.preferences, appliedSettings(session));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const index = useQuery({
    queryKey: ['themes', 'index'],
    queryFn: () => themes.list(),
    staleTime: Infinity,
  });
  const manifest = useQuery({
    queryKey: ['themes', 'manifest', current.theme],
    queryFn: () => themes.manifest(current.theme),
    staleTime: Infinity,
  });
  const choices = (index.data ?? []).filter(
    (theme) => themeAllowed(theme.id, appliedSettings(session)?.allowedThemes) || theme.id === current.theme,
  );
  const change = async (patch: PreferencesUpdate) => {
    setError(null);
    try {
      await save.mutateAsync(patch);
    } catch (failure) {
      setError(message(failure instanceof ApiError ? failure.info.messageKey : 'errors.internal'));
    }
  };
  const chooseTheme = async (theme: string) => {
    setLoading(true);
    setError(null);
    try {
      const next = await themes.manifest(theme);
      await change({
        theme,
        scheme: next.defaultScheme,
        ...(next.defaultMode ? { mode: next.defaultMode } : {}),
      });
    } catch {
      setError(t({ id: 'shell.appearance.failed', message: 'Couldn’t load this theme.' }));
    } finally {
      setLoading(false);
    }
  };
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="sm"
    >
      <Dialog>
        <DialogTitle>
          <Trans id="settings.nav.appearance">Appearance</Trans>
        </DialogTitle>
        <DialogBody className="rio-quick-appearance">
          {override && (
            <p role="note">
              {t({
                id: 'shell.appearance.forced',
                message:
                  'This database uses a fixed theme.  Your appearance changes apply when you leave it.',
              })}
            </p>
          )}
          <Select
            label={t({ id: 'settings.appearance.theme', message: 'Theme' })}
            selectedKey={current.theme}
            isDisabled={!index.data || loading || save.isPending}
            onSelectionChange={(key) => {
              if (key !== null) void chooseTheme(String(key));
            }}
          >
            {choices.map((theme) => (
              <ListBoxItem key={theme.id} id={theme.id}>
                {theme.name}
              </ListBoxItem>
            ))}
          </Select>
          <Select
            label={t({ id: 'settings.appearance.scheme', message: 'Color scheme' })}
            selectedKey={current.scheme ?? manifest.data?.defaultScheme}
            isDisabled={!manifest.data || loading || save.isPending}
            onSelectionChange={(key) => {
              if (key !== null) void change({ theme: current.theme, scheme: String(key) });
            }}
          >
            {(manifest.data?.schemes ?? []).map((scheme) => (
              <ListBoxItem key={scheme.id} id={scheme.id}>
                {scheme.name}
              </ListBoxItem>
            ))}
          </Select>
          {session?.demo && (
            <>
              <Select
                label={t({ id: 'levels.settings.label', message: 'How much to show' })}
                selectedKey={session.preferences.level ?? 'default'}
                onSelectionChange={(key) => {
                  if (key === 'default') void change({ level: null });
                  else {
                    const level = LEVELS.find((level) => level === key);
                    if (level) void change({ level });
                  }
                }}
              >
                <ListBoxItem id="default">
                  {t({ id: 'levels.settings.default', message: 'Use the organization default' })}
                </ListBoxItem>
                {LEVELS.map((level) => (
                  <ListBoxItem key={level} id={level}>
                    {i18n._(LEVEL_NAMES[level])}
                  </ListBoxItem>
                ))}
              </Select>
              <Select
                label={t({ id: 'record.layout', message: 'Record layout' })}
                selectedKey={session.preferences.recordLayout ?? 'card'}
                onSelectionChange={(key) => {
                  if (key === 'card' || key === 'panel') void change({ recordLayout: key });
                }}
              >
                <ListBoxItem id="card">{t({ id: 'record.layout.card', message: 'Card' })}</ListBoxItem>
                <ListBoxItem id="panel">
                  {t({ id: 'record.layout.panel', message: 'Side panel' })}
                </ListBoxItem>
              </Select>
            </>
          )}
          {error && <p role="alert">{error}</p>}
        </DialogBody>
      </Dialog>
    </Modal>
  );
}
