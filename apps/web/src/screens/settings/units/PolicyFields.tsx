import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import {
  LEVELS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SESSION_IDLE_DAYS_FLOOR,
  SESSION_MAX_DAYS_FLOOR,
  UNIT_POLICY_RULES,
  type UnitPolicyKey,
  type UnitPolicyValues,
} from '@riosoma/contracts';
import { HAS_LANGUAGE_CHOICE, LOCALES } from '@riosoma/i18n';
import { Checkbox, CheckboxGroup, ListBoxItem, NumberField, Select, Switch, TextField } from '@riosoma/ui';
import { useState } from 'react';
import { LEVEL_NAMES } from '../../../levels/words';
import { themes } from '../../../preferences';
import { unitSettings, sharingSettings } from './labels';
import { SettingItem } from '../Setting';

function DomainField({
  label,
  value,
  isDisabled,
  onChange,
}: {
  label: string;
  value: string[] | null;
  isDisabled: boolean;
  onChange: (value: string[] | null) => void;
}) {
  const { t } = useLingui();
  const [input, setInput] = useState<string | null>(null);
  const normalized = (text: string) =>
    text
      .split(/[\s,]+/)
      .map((domain) => domain.toLowerCase())
      .filter(Boolean);
  const stored = (value ?? []).join(', ');
  const displayed =
    input !== null && JSON.stringify(normalized(input)) === JSON.stringify(value ?? []) ? input : stored;
  return (
    <TextField
      label={label}
      value={displayed}
      isDisabled={isDisabled}
      description={t({
        id: 'share.policy.domainsHelp',
        message:
          'Separate domains with commas.  Leave this empty to allow any domain.  Subdomains must be listed separately.',
      })}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.preventDefault();
      }}
      onChange={(next) => {
        setInput(next);
        const domains = normalized(next);
        onChange(domains.length ? domains : null);
      }}
    />
  );
}

/** The settings in the order the policy screens show them, grouped by what they're about */
export const POLICY_GROUPS: ReadonlyArray<{ id: string; keys: readonly UnitPolicyKey[] }> = [
  {
    id: 'signIn',
    keys: [
      'auditRetentionDays',
      'requireMfa',
      'requireSso',
      'passwordMinLength',
      'sessionMaxDays',
      'sessionIdleDays',
    ],
  },
  {
    id: 'sharing',
    keys: [
      'publicLinks',
      'externalSharing',
      'guestInvitations',
      'newPeopleSharing',
      'newPeopleAdministratorsOnly',
      'newPeopleRole',
      'allowedEmailDomains',
      'calendarFeeds',
      'reportOutsideRecipients',
      'syncOut',
      'automationSms',
      'feedbackPublishing',
    ],
  },
  { id: 'ai', keys: ['aiEnabled', 'aiFields', 'aiDiagnose', 'automationAi', 'aiRoutines'] },
  {
    id: 'preferences',
    keys: [
      'allowedThemes',
      'defaultTheme',
      'defaultLevel',
      'guestLevel',
      ...(HAS_LANGUAGE_CHOICE ? (['defaultLocale'] as const) : []),
    ],
  },
];

const NUMBER_LIMITS: Partial<Record<UnitPolicyKey, { min: number; max: number; step?: number }>> = {
  auditRetentionDays: { min: 365, max: 36500, step: 1 },
  passwordMinLength: { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH, step: 1 },
  sessionMaxDays: { min: SESSION_MAX_DAYS_FLOOR, max: 365 },
  sessionIdleDays: { min: SESSION_IDLE_DAYS_FLOOR, max: 365 },
};

/** How a value reads in a preview or an audit entry */
export function useShowValue(): (key: UnitPolicyKey, value: unknown) => string {
  const { t, i18n } = useLingui();
  return (key, value) => {
    if (typeof value === 'boolean')
      return UNIT_POLICY_RULES[key].direction === 'require'
        ? value
          ? t({ id: 'orgUnits.value.required', message: 'Required' })
          : t({ id: 'orgUnits.value.notRequired', message: 'Not required' })
        : value
          ? t({ id: 'orgUnits.value.on', message: 'On' })
          : t({ id: 'orgUnits.value.off', message: 'Off' });
    if (typeof value === 'number') return i18n.number(value);
    if (Array.isArray(value)) return value.join(', ');
    if (value === null || value === undefined)
      return key === 'defaultLocale'
        ? t({ id: 'orgUnits.value.ownLanguage', message: 'Each person’s own' })
        : key === 'defaultTheme'
          ? t({ id: 'orgUnits.value.serverTheme', message: 'The server’s default' })
          : t({ id: 'orgUnits.value.noLimit', message: 'No limit' });
    if (key === 'defaultLevel' || key === 'guestLevel')
      return i18n._(LEVEL_NAMES[value as (typeof LEVELS)[number]]);
    if (key === 'defaultLocale')
      return LOCALES.find((locale) => locale.code === value)?.nativeName ?? String(value);
    if (key === 'newPeopleRole')
      return value === 'guest'
        ? t({ id: 'people.kind.guest', message: 'Guest' })
        : t({ id: 'people.kind.member', message: 'Member' });
    return String(value);
  };
}

/**
 * The control for one setting.  Each kind of value gets the control that fits it, and a setting
 * that can't change here shows its value in a disabled control, so it still reads the same way.
 */
export function PolicyField<K extends UnitPolicyKey>({
  setting,
  value,
  isDisabled,
  description,
  onChange,
  sharingPage = false,
}: {
  setting: K;
  value: UnitPolicyValues[K] | undefined;
  isDisabled: boolean;
  description?: string;
  onChange: (value: UnitPolicyValues[K]) => void;
  sharingPage?: boolean;
}) {
  const { t, i18n } = useLingui();
  const index = useQuery({
    queryKey: ['themes', 'index'],
    queryFn: () => themes.list(),
    staleTime: Infinity,
    enabled: setting === 'allowedThemes' || setting === 'defaultTheme',
  });
  const label = i18n._(unitSettings[setting].label);
  const set = onChange as (value: unknown) => void;
  const definition =
    sharingPage && setting in sharingSettings
      ? sharingSettings[setting as keyof typeof sharingSettings]
      : unitSettings[setting];
  if (setting === 'allowedEmailDomains')
    return (
      <SettingItem definition={definition}>
        <DomainField label={label} value={value as string[] | null} isDisabled={isDisabled} onChange={set} />
      </SettingItem>
    );
  if (setting === 'newPeopleRole')
    return (
      <SettingItem definition={definition}>
        <Select
          label={label}
          selectedKey={String(value)}
          isDisabled={isDisabled}
          onSelectionChange={(key) => set(String(key))}
        >
          <ListBoxItem id="guest">
            <span>{t({ id: 'people.kind.guest', message: 'Guest' })}</span>
          </ListBoxItem>
          <ListBoxItem id="member">
            <span>{t({ id: 'people.kind.member', message: 'Member' })}</span>
          </ListBoxItem>
        </Select>
      </SettingItem>
    );
  if (setting === 'defaultLocale' && !HAS_LANGUAGE_CHOICE) return null;
  if (
    typeof value === 'boolean' ||
    UNIT_POLICY_RULES[setting].direction === 'require' ||
    UNIT_POLICY_RULES[setting].direction === 'restrict'
  )
    return (
      <SettingItem definition={definition}>
        {
          <Switch
            isSelected={value === true}
            isDisabled={isDisabled}
            description={description}
            onChange={set}
          >
            {label}
          </Switch>
        }
      </SettingItem>
    );
  const limits = NUMBER_LIMITS[setting];
  if (limits)
    return (
      <SettingItem definition={unitSettings[setting]}>
        {
          <NumberField
            label={label}
            description={description}
            value={typeof value === 'number' ? value : limits.min}
            minValue={limits.min}
            maxValue={limits.max}
            {...(limits.step ? { step: limits.step } : {})}
            isDisabled={isDisabled}
            onChange={(next) => {
              if (Number.isFinite(next)) set(next);
            }}
          />
        }
      </SettingItem>
    );
  if (setting === 'defaultLevel' || setting === 'guestLevel')
    return (
      <SettingItem definition={unitSettings[setting]}>
        {
          <Select
            label={label}
            description={description}
            selectedKey={String(value)}
            isDisabled={isDisabled}
            onSelectionChange={(key) => set(String(key))}
          >
            {LEVELS.map((level) => (
              <ListBoxItem key={level} id={level} textValue={i18n._(LEVEL_NAMES[level])}>
                {i18n._(LEVEL_NAMES[level])}
              </ListBoxItem>
            ))}
          </Select>
        }
      </SettingItem>
    );
  if (setting === 'defaultLocale') {
    const own = t({ id: 'orgUnits.value.ownLanguage', message: 'Each person’s own' });
    return (
      <SettingItem definition={unitSettings[setting]}>
        {
          <Select
            label={label}
            description={description}
            selectedKey={typeof value === 'string' ? value : 'own'}
            isDisabled={isDisabled}
            onSelectionChange={(key) => set(key === 'own' ? null : String(key))}
          >
            <ListBoxItem id="own" textValue={own}>
              {own}
            </ListBoxItem>
            {LOCALES.map((locale) => (
              <ListBoxItem key={locale.code} id={locale.code} textValue={locale.nativeName}>
                <span lang={locale.code}>{locale.nativeName}</span>
              </ListBoxItem>
            ))}
          </Select>
        }
      </SettingItem>
    );
  }
  const choices = index.data ?? [];
  if (setting === 'defaultTheme') {
    const server = t({ id: 'orgUnits.value.serverTheme', message: 'The server’s default' });
    return (
      <SettingItem definition={unitSettings[setting]}>
        {
          <Select
            label={label}
            description={description}
            selectedKey={typeof value === 'string' ? value : 'server'}
            isDisabled={isDisabled || !index.data}
            onSelectionChange={(key) => set(key === 'server' ? null : String(key))}
          >
            <ListBoxItem id="server" textValue={server}>
              {server}
            </ListBoxItem>
            {choices.map((theme) => (
              <ListBoxItem key={theme.id} id={theme.id} textValue={theme.name}>
                {theme.name}
              </ListBoxItem>
            ))}
          </Select>
        }
      </SettingItem>
    );
  }
  // The themes people can choose: none checked means no limit.
  const chosen = Array.isArray(value) ? value : [];
  return (
    <SettingItem definition={unitSettings[setting]}>
      {
        <CheckboxGroup
          className="rio-units__themes"
          label={label}
          description={
            description ??
            t({
              id: 'orgUnits.allowedThemes.help',
              message: 'Leave every theme unchecked to allow them all.',
            })
          }
          orientation="horizontal"
          value={chosen}
          isDisabled={isDisabled || !index.data}
          aria-busy={index.isPending}
          onChange={(next) => set(next.length ? next : null)}
        >
          <div className="rio-units__theme-choices" tabIndex={0} role="region" aria-label={label}>
            {choices.map((theme) => (
              <Checkbox key={theme.id} value={theme.id}>
                {theme.name}
              </Checkbox>
            ))}
          </div>
        </CheckboxGroup>
      }
    </SettingItem>
  );
}
