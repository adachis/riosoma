import { useSettingsSection } from '../SettingsDraft';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  UNIT_ADMIN_ROLES,
  UNIT_POLICY_KEYS,
  UNIT_POLICY_RULES,
  UNIT_PRESET_NAMES,
  type OrgUnit,
  type UnitPolicy,
  type UnitPolicyKey,
  type UnitPolicyOrigin,
  type UnitPolicyView,
  type UnitPreset,
  type UnitPresetPreview,
} from '@riosoma/contracts';
import { Banner, Button, Checkbox, Heading, ListBoxItem, Select, Text, toast } from '@riosoma/ui';
import { api } from '../../../api';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { organizationRole, rolesAt } from './access';
import { policyLabels, presetLabels, roleLabels } from './labels';
import { POLICY_GROUPS, PolicyField, useShowValue } from './PolicyFields';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../Setting';
import { SettingsLoading } from '../SettingsLoading';
import './units.css';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'organization',
  page: 'org-units',
  label: msg({ id: 'settings.nav.orgUnits', message: 'Organizational units' }),
  roles: ['units-existing'],
});

const sharingSettingsPage = defineSettingsPage({
  area: 'admin',
  section: 'security',
  page: 'sign-in-policy',
  label: msg({ id: 'mfa.nav.policy', message: 'Sign-in policy' }),
  roles: ['security'],
});

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function useGroupTitles(): Record<string, string> {
  const { t } = useLingui();
  return {
    signIn: t({ id: 'orgUnits.group.signIn', message: 'Signing in' }),
    sharing: t({ id: 'orgUnits.group.sharing', message: 'Sharing and publishing' }),
    ai: t({ id: 'orgUnits.group.ai', message: 'AI' }),
    preferences: t({ id: 'orgUnits.group.preferences', message: 'Preferences' }),
  };
}

/** Where a value comes from, in the words the screens use */
function useOrigin(): (origin: UnitPolicyOrigin, here: string | null) => string {
  const { t } = useLingui();
  return (origin, here) => {
    if (origin.id === null)
      return t({ id: 'orgUnits.origin.organization', message: 'Set by the organization' });
    if (origin.id === here) return t({ id: 'orgUnits.origin.here', message: 'Set here' });
    const name = origin.name;
    return t({ id: 'orgUnits.origin.unit', message: `Set by ${name}` });
  };
}

/** Says so when single sign-on is required but can't be, since no identity provider is on */
function PolicyWarnings({ view }: { view?: UnitPolicyView }) {
  return (
    <div className="rio-units__warnings" tabIndex={view?.warnings?.length ? 0 : undefined}>
      {view?.warnings?.includes('ssoWithoutProvider') && (
        <Banner tone="warning">
          <Trans id="orgUnits.warning.ssoWithoutProvider">
            {
              'Single sign-on is required here, but no identity provider is turned on, so nobody is held to it.  Turn a provider on in Single sign-on, or turn the requirement off.'
            }
          </Trans>
        </Banner>
      )}
    </div>
  );
}

/**
 * A unit's policy: every setting, what it is, where it comes from, and, where it can't change
 * here, why.  Only what the organization lets units override, and only the way its rule allows,
 * can change, only by someone with the role for it, and a value set from above only by an admin
 * at that level or above.
 */
export function UnitPolicyPanel({ unit, tree }: { unit: OrgUnit; tree: readonly OrgUnit[] }) {
  const { t, i18n } = useLingui();
  const session = useSession();
  const cache = useQueryClient();
  const origin = useOrigin();
  const titles = useGroupTitles();
  const key = ['org', 'units', unit.id, 'policy'];
  const path = `/api/org/units/${encodeURIComponent(unit.id)}/policy`;
  const view = useQuery({ queryKey: key, queryFn: ({ signal }) => api<UnitPolicyView>(path, { signal }) });
  const [draft, setDraft] = useState<UnitPolicy | null>(null);
  const save = useMutation({
    mutationFn: (body: UnitPolicy) => api<UnitPolicyView>(path, { method: 'PUT', body }),
    onSuccess: async (saved) => {
      cache.setQueryData(key, saved);
      setDraft(null);
      await cache.invalidateQueries({ queryKey: ['org', 'units'] });
      await cache.invalidateQueries({ queryKey: ['session'] });
      toast.show({
        tone: 'success',
        title: t({ id: 'orgUnits.policy.saved', message: 'Saved the unit’s policy' }),
      });
    },
  });
  const pageDraft = useSettingsSection({
    dirty: Boolean(view.data && draft && !same(draft, view.data.own)),
    stored: view.data?.own,
    discard: () => setDraft(null),
    save: async () => {
      if (draft) await save.mutateAsync(draft);
    },
  });
  if (!view.isPending && !view.data?.values) return <ErrorBanner error={errorInfo(view.error)} />;
  const data = view.data;
  const own = draft ?? data?.own ?? {};
  const changed = Boolean(data && !same(own, data.own));
  const held = rolesAt(session, tree, unit.id, UNIT_ADMIN_ROLES);
  const reason = (setting: UnitPolicyKey): string => {
    if (!data) return '';
    const rule = UNIT_POLICY_RULES[setting];
    if (!data.overridable.includes(setting))
      return t({ id: 'orgUnits.reason.locked', message: 'The organization doesn’t let units change this.' });
    if (!held.includes(rule.area)) {
      const role = i18n._(roleLabels[rule.area]);
      return t({ id: 'orgUnits.reason.role', message: `Changing this takes the ${role} role.` });
    }
    const setter = data.setBy[setting];
    if (setting in data.own && setter && !data.changeable.includes(setting)) {
      const level = setter.name;
      return setter.id === null
        ? t({
            id: 'orgUnits.reason.setByOrganization',
            message: 'The organization set this here, so only its admins can change it.',
          })
        : t({
            id: 'orgUnits.reason.setAbove',
            message: `An admin of ${level} set this, so only an admin of ${level} or above can change it.`,
          });
    }
    if (setting in data.own && data.origins[setting].id !== unit.id)
      return t({
        id: 'orgUnits.reason.dormant',
        message: 'This unit’s own value is looser than what it inherits, so it doesn’t apply.',
      });
    return rule.direction === 'any'
      ? t({ id: 'orgUnits.reason.either', message: 'This unit can change it either way.' })
      : t({ id: 'orgUnits.reason.stricter', message: 'This unit can only make it stricter.' });
  };
  return (
    <section className="rio-units__panel" aria-labelledby={`policy-${unit.id}`}>
      <Heading level={3} id={`policy-${unit.id}`}>
        <Trans id="orgUnits.policy.title">Policy</Trans>
      </Heading>
      <SettingsLoading isPending={view.isPending}>
        <div className="rio-units__policy-content">
          <PolicyWarnings view={data} />
          <form
            className="rio-units__policy"
            onSubmit={(event) => {
              event.preventDefault();
              void pageDraft.save?.();
            }}
          >
            {POLICY_GROUPS.map((group) => (
              <fieldset key={group.id} className="rio-units__group">
                <legend>{titles[group.id]}</legend>
                {group.keys.map((setting) => {
                  const editable = Boolean(data?.changeable.includes(setting));
                  const value = setting in own ? own[setting] : data?.inherited?.[setting];
                  return (
                    <div key={setting} className="rio-units__setting">
                      <PolicyField
                        setting={setting}
                        value={value as never}
                        isDisabled={!editable || save.isPending}
                        onChange={(next) => setDraft({ ...own, [setting]: next })}
                      />
                      <div
                        className="rio-units__explanation"
                        tabIndex={data ? 0 : undefined}
                        role="region"
                        aria-label={i18n._(policyLabels[setting])}
                      >
                        <Text variant="small" className="rio-units__origin">
                          {data ? origin(data.origins[setting], unit.id) : ''}
                        </Text>
                        <Text variant="small" className="rio-units__origin">
                          {reason(setting)}
                        </Text>
                      </div>
                      <div className="rio-units__inherit">
                        {editable && setting in own ? (
                          <Button
                            size="sm"
                            variant="quiet"
                            onPress={() => {
                              const next = { ...own };
                              delete next[setting];
                              setDraft(next);
                            }}
                          >
                            <Trans id="orgUnits.inherit">Use the inherited value</Trans>
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </fieldset>
            ))}
            <ErrorBanner error={errorInfo(save.error)} />
            <div className="rio-units__actions">
              {changed ? (
                <Button variant="quiet" onPress={() => setDraft(null)}>
                  <Trans id="orgUnits.policy.discard">Discard changes</Trans>
                </Button>
              ) : null}
            </div>
          </form>
          <PresetPanel
            unit={unit}
            onApply={async (policy) => {
              setDraft(policy);
            }}
          />
        </div>
      </SettingsLoading>
    </section>
  );
}

/** A preset for a unit, shown as the changes it would make before any of them are made */
function PresetPanel({
  unit,
  onApply,
}: {
  unit: OrgUnit;
  onApply: (policy: UnitPolicy) => Promise<unknown>;
}) {
  const { t, i18n } = useLingui();
  const show = useShowValue();
  const [preset, setPreset] = useState<UnitPreset>('balanced');
  const preview = useMutation({
    mutationFn: (name: UnitPreset) =>
      api<UnitPresetPreview>(`/api/org/units/${encodeURIComponent(unit.id)}/policy/preview`, {
        body: { preset: name },
      }),
  });
  const apply = useMutation({
    mutationFn: (policy: UnitPolicy) => onApply(policy),
    onSuccess: () => preview.reset(),
  });
  const permitted =
    preview.data?.diff.filter((change) => change.allowed && !same(change.before, change.after)) ?? [];
  return (
    <div className="rio-units__presets">
      <Heading level={4}>
        <Trans id="orgUnits.preset.title">Start from a preset</Trans>
      </Heading>
      <div className="rio-units__row">
        <Setting
          page={settingsPage}
          id="preset"
          label={msg({ id: 'orgUnits.preset.label', message: 'Preset' })}
        >
          <Select
            label={t({ id: 'orgUnits.preset.label', message: 'Preset' })}
            selectedKey={preset}
            onSelectionChange={(key) => {
              setPreset(String(key) as UnitPreset);
              preview.reset();
            }}
          >
            {UNIT_PRESET_NAMES.map((name) => (
              <ListBoxItem key={name} id={name} textValue={i18n._(presetLabels[name])}>
                {i18n._(presetLabels[name])}
              </ListBoxItem>
            ))}
          </Select>
        </Setting>
        <Button onPress={() => preview.mutate(preset)} isPending={preview.isPending}>
          <Trans id="orgUnits.preset.preview">Preview changes</Trans>
        </Button>
      </div>
      <ErrorBanner error={errorInfo(preview.error ?? apply.error)} />
      {preview.data ? (
        <>
          <ul className="rio-units__diff">
            {preview.data.diff.map((change) => {
              const name = i18n._(policyLabels[change.key]);
              const before = show(change.key, change.before);
              const after = show(change.key, change.after);
              return (
                <li key={change.key} data-allowed={change.allowed}>
                  {change.allowed
                    ? same(change.before, change.after)
                      ? t({ id: 'orgUnits.preset.same', message: `${name}: stays ${before}` })
                      : t({ id: 'orgUnits.preset.change', message: `${name}: ${before} to ${after}` })
                    : t({
                        id: 'orgUnits.preset.kept',
                        message: `${name}: stays ${before}, since this unit can’t set ${after}`,
                      })}
                </li>
              );
            })}
          </ul>
          <Button
            variant="primary"
            isDisabled={!permitted.length}
            isPending={apply.isPending}
            onPress={() => apply.mutate(preview.data!.policy)}
          >
            <Trans id="orgUnits.preset.apply">Apply the permitted changes</Trans>
          </Button>
        </>
      ) : null}
    </div>
  );
}

/**
 * The organization's side: its own value for each setting that has no screen of its own, and
 * which settings units may override.  Each setting belongs to one admin role.
 */
export function OrganizationPolicyPanel() {
  return (
    <Setting
      page={settingsPage}
      id="organization-policy"
      label={msg({ id: 'orgUnits.organization.title', message: 'Organization policy' })}
      roles={['admin']}
      requiredRoles={['units-existing']}
    >
      <OrganizationPolicyForm />
    </Setting>
  );
}

export function SharingPolicyPanel() {
  return (
    <Setting
      page={sharingSettingsPage}
      id="sharing-policy"
      label={msg({ id: 'share.policy.title', message: 'Sharing with new people' })}
      roles={['security']}
    >
      <OrganizationPolicyForm sharingOnly />
    </Setting>
  );
}

function OrganizationPolicyForm({ sharingOnly = false }: { sharingOnly?: boolean }) {
  const { t, i18n } = useLingui();
  const session = useSession();
  const cache = useQueryClient();
  const titles = useGroupTitles();
  const key = ['org', 'unit-policy'];
  const view = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<UnitPolicyView>('/api/admin/unit-policy', { signal }),
  });
  const [draft, setDraft] = useState<{ values: UnitPolicy; overridable: UnitPolicyKey[] } | null>(null);
  const save = useMutation({
    mutationFn: (body: { values: UnitPolicy; overridable: UnitPolicyKey[] }) =>
      api<UnitPolicyView>('/api/admin/unit-policy', { method: 'PUT', body }),
    onSuccess: async (saved) => {
      cache.setQueryData(key, saved);
      setDraft(null);
      await cache.invalidateQueries({ queryKey: ['org', 'units'] });
      await cache.invalidateQueries({ queryKey: ['session'] });
      toast.show({
        tone: 'success',
        title: t({ id: 'orgUnits.organization.saved', message: 'Saved the organization’s policy' }),
      });
    },
  });
  const pageDraft = useSettingsSection({
    dirty: Boolean(
      view.data &&
      draft &&
      (!same(draft.values, view.data.own) ||
        !same([...draft.overridable].sort(), [...view.data.overridable].sort())),
    ),
    stored: view.data && { values: view.data.own, overridable: view.data.overridable },
    discard: () => setDraft(null),
    save: async () => {
      if (draft) await save.mutateAsync(draft);
    },
  });
  if (!view.isPending && !view.data?.values) return <ErrorBanner error={errorInfo(view.error)} />;
  const data = view.data;
  const current = draft ?? { values: data?.own ?? {}, overridable: data?.overridable ?? [] };
  const changed = Boolean(
    data &&
    (!same(current.values, data.own) || !same([...current.overridable].sort(), [...data.overridable].sort())),
  );
  return (
    <SettingsLoading isPending={view.isPending}>
      <section className="rio-units__panel" aria-labelledby="organization-policy">
        <Heading level={2} id="organization-policy">
          {sharingOnly ? (
            <Trans id="share.policy.title">Sharing with new people</Trans>
          ) : (
            <Trans id="orgUnits.organization.title">Organization policy</Trans>
          )}
        </Heading>
        <PolicyWarnings view={data} />
        <Text variant="muted">
          <Trans id="orgUnits.organization.intro">
            {
              'Every unit starts from these values.  A unit can change a setting only where it’s allowed here, and a security setting only to make it stricter.'
            }
          </Trans>
        </Text>
        <form
          className="rio-units__policy"
          onSubmit={(event) => {
            event.preventDefault();
            void pageDraft.save?.();
          }}
        >
          {(sharingOnly
            ? [
                {
                  id: 'sharing',
                  keys: [
                    'newPeopleSharing',
                    'newPeopleAdministratorsOnly',
                    'newPeopleRole',
                    'allowedEmailDomains',
                  ] as const,
                },
              ]
            : POLICY_GROUPS
          ).map((group) => (
            <fieldset key={group.id} className="rio-units__group">
              <legend>{titles[group.id]}</legend>
              {group.keys.map((setting) => {
                const rule = UNIT_POLICY_RULES[setting];
                const mine = organizationRole(session, rule.area);
                const here = rule.organization === 'policy';
                const role = i18n._(roleLabels[rule.area]);
                const value = setting in current.values ? current.values[setting] : data?.values[setting];
                return (
                  <div key={setting} className="rio-units__setting">
                    <PolicyField
                      sharingPage={sharingOnly}
                      setting={setting}
                      value={value as never}
                      isDisabled={!data || !here || !mine || save.isPending}
                      description={
                        here
                          ? undefined
                          : t({
                              id: 'orgUnits.organization.elsewhere',
                              message: 'Set on its own settings screen.',
                            })
                      }
                      onChange={(next) =>
                        setDraft({ ...current, values: { ...current.values, [setting]: next } })
                      }
                    />
                    <Checkbox
                      isSelected={current.overridable.includes(setting)}
                      isDisabled={!data || !mine || save.isPending}
                      onChange={(allowed) =>
                        setDraft({
                          ...current,
                          overridable: allowed
                            ? UNIT_POLICY_KEYS.filter(
                                (item) => item === setting || current.overridable.includes(item),
                              )
                            : current.overridable.filter((item) => item !== setting),
                        })
                      }
                    >
                      {rule.direction === 'any'
                        ? t({ id: 'orgUnits.organization.overrideAny', message: 'Units can change this' })
                        : t({
                            id: 'orgUnits.organization.overrideStricter',
                            message: 'Units can make this stricter',
                          })}
                    </Checkbox>
                    {mine ? null : (
                      <Text variant="small" className="rio-units__origin">
                        {t({ id: 'orgUnits.reason.role', message: `Changing this takes the ${role} role.` })}
                      </Text>
                    )}
                  </div>
                );
              })}
            </fieldset>
          ))}
          <ErrorBanner error={errorInfo(save.error)} />
          <div className="rio-units__actions">
            {changed ? (
              <Button variant="quiet" onPress={() => setDraft(null)}>
                <Trans id="orgUnits.policy.discard">Discard changes</Trans>
              </Button>
            ) : null}
          </div>
        </form>
      </section>
    </SettingsLoading>
  );
}
