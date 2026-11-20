import { useLingui } from '@lingui/react/macro';
import { appConnectionSchema, type AppCatalogEntry, type AccountSettingChoices } from '@riosoma/contracts';
import { ListBoxItem, Select, TextField } from '@riosoma/ui';
import { useEffect, useEffectEvent } from 'react';
import { useServerMessage } from '../../../messages/useServerMessage';

/** Field kinds and validation both come from the public catalog, including future apps. */
export function AppSourceFields({
  app,
  settings,
  onChange,
  fieldError,
  isDisabled,
  settingChoices,
}: {
  app: AppCatalogEntry;
  settings: Record<string, string>;
  onChange(settings: Record<string, string>): void;
  fieldError(name: string): string | undefined;
  isDisabled?: boolean;
  settingChoices?: AccountSettingChoices;
}) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const update = useEffectEvent(onChange);
  useEffect(() => {
    const next = { ...settings };
    for (const setting of app.settings) {
      if (setting.type !== 'account-choice') continue;
      if (!settingChoices) continue;
      const choices = settingChoices?.[setting.key] ?? [];
      if (choices.some((choice) => choice.value === next[setting.key])) continue;
      next[setting.key] = choices.length === 1 ? choices[0]!.value : '';
    }
    if (JSON.stringify(next) !== JSON.stringify(settings)) update(next);
  }, [app, settings, settingChoices]);
  const parsed = appConnectionSchema([app]).safeParse({ kind: 'app', app: app.id, settings });
  return (
    <div className="rio-sources__group" data-anchor="sources.app.settings">
      {app.settings.map((setting) => {
        const issue = parsed.error?.issues.find((issue) => issue.path[1] === setting.key);
        const error = issue ? message(issue.message) : fieldError(setting.key);
        const value = settings[setting.key] ?? '';
        const common = {
          label: i18n._(setting.labelMessageId),
          description: i18n._(setting.helpMessageId),
          isRequired: setting.required,
          isDisabled,
          isInvalid: Boolean(error),
          errorMessage: error,
          validationBehavior: 'aria' as const,
        };
        const choices =
          setting.type === 'account-choice'
            ? (settingChoices?.[setting.key] ?? [])
            : setting.type === 'choice'
              ? setting.values.map((value) => ({
                  value,
                  label: setting.valueMessageIds?.[value] ? i18n._(setting.valueMessageIds[value]!) : value,
                }))
              : [];
        return setting.type === 'choice' || setting.type === 'account-choice' ? (
          <Select
            key={setting.key}
            {...common}
            aria-label={common.label}
            label={
              <>
                {common.label}
                {setting.required ? (
                  <span className="rio-sources__app-required" aria-hidden="true">
                    *
                  </span>
                ) : null}
              </>
            }
            selectedKey={value || null}
            placeholder={t({ id: 'sources.app.chooseSetting', message: 'Choose a value' })}
            onSelectionChange={(key) =>
              onChange({ ...settings, [setting.key]: key === null ? '' : String(key) })
            }
          >
            {!setting.required ? (
              <ListBoxItem id="">{t({ id: 'sources.app.noSetting', message: 'No value' })}</ListBoxItem>
            ) : null}
            {choices.map(({ value, label }) => (
              <ListBoxItem key={value} id={value}>
                {label}
              </ListBoxItem>
            ))}
          </Select>
        ) : (
          <TextField
            key={setting.key}
            {...common}
            value={value}
            type={setting.type === 'address' ? 'url' : 'text'}
            autoComplete="off"
            onChange={(value) => onChange({ ...settings, [setting.key]: value })}
          />
        );
      })}
    </div>
  );
}
