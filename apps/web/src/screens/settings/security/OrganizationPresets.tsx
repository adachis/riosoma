import { useState } from 'react';
import { useSettingsSection } from '../SettingsDraft';
import { Setting, defineSettingsPage } from '../Setting';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  UNIT_PRESET_NAMES,
  UnitPreset,
  type OrganizationCommandResult,
  type OrganizationPresetPreview,
} from '@riosoma/contracts';
import { Button, Heading, ListBoxItem, Select, Spinner } from '@riosoma/ui';
import { api } from '../../../api';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { useAdminSearch } from '../admin-search';
import { organizationRole } from '../units/access';
import { policyLabels, presetLabels } from '../units/labels';
import { useShowValue } from '../units/PolicyFields';
import '../administration.css';
const embeddedPage = defineSettingsPage({
  area: 'personal',
  section: 'account',
  page: 'security',
  label: msg({ id: 'mfa.nav.security', message: 'Sign-in and security' }),
  roles: ['security'],
});

export function OrganizationPresets() {
  const session = useSession();
  return organizationRole(session, 'security') ? <PresetPicker /> : null;
}

function PresetPicker() {
  const { t, i18n } = useLingui();
  const showValue = useShowValue();
  const cache = useQueryClient();
  const selected = UnitPreset.safeParse(useAdminSearch().get('preset'));
  const [choice, setChoice] = useState<UnitPreset | null>(null);
  const [staged, setStaged] = useState(false);
  const preset = choice ?? (selected.success ? selected.data : null);
  const preview = useQuery({
    queryKey: ['org', 'presets', preset],
    enabled: Boolean(preset),
    queryFn: () => api<OrganizationPresetPreview>(`/api/org/presets/${preset}`),
  });
  const apply = useMutation({
    mutationFn: () =>
      api<OrganizationCommandResult>('/api/org/admin-commands', {
        body: { kind: 'organization.preset', preset, revision: preview.data?.revision },
      }),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ['org'] });
      await cache.invalidateQueries({ queryKey: ['session'] });
      setStaged(false);
      setChoice(null);
    },
  });
  const undo = useMutation({
    mutationFn: () =>
      api<OrganizationCommandResult>('/api/org/admin-commands', {
        body: { kind: 'organization.undo', eventId: apply.data?.eventId },
      }),
    onSuccess: async () => {
      apply.reset();
      await cache.invalidateQueries({ queryKey: ['org'] });
      await cache.invalidateQueries({ queryKey: ['session'] });
    },
  });
  useSettingsSection({
    dirty: Boolean(preset && (staged || choice)),
    discard: () => {
      setChoice(null);
      setStaged(false);
    },
    validate: () =>
      preview.data && !preview.isFetching
        ? null
        : t({
            id: 'settings.draft.waitPreview',
            message: 'Wait for the settings preview to finish loading.',
          }),
    save: () => apply.mutateAsync(),
  });
  return (
    <section className="rio-admin-panel" aria-labelledby="organization-presets-title">
      <Heading level={2} id="organization-presets-title">
        <Trans id="organizationPresets.title">Organization presets</Trans>
      </Heading>
      <p>
        <Trans id="organizationPresets.description">
          {'Review the changes before applying a preset.  Settings the preset leaves out stay as they are.'}
        </Trans>
      </p>
      <Setting
        page={embeddedPage}
        id="preset-choose"
        label={msg({ id: 'organizationPresets.choose', message: 'Policy preset' })}
      >
        <Select
          label={t({ id: 'organizationPresets.choose', message: 'Policy preset' })}
          selectedKey={preset}
          isDisabled={apply.isPending || undo.isPending}
          onSelectionChange={(value) => {
            apply.reset();
            undo.reset();
            setChoice(value as UnitPreset);
            setStaged(false);
          }}
        >
          {UNIT_PRESET_NAMES.map((name) => (
            <ListBoxItem key={name} id={name}>
              {i18n._(presetLabels[name])}
            </ListBoxItem>
          ))}
        </Select>
      </Setting>
      {preset && preview.isPending ? <Spinner /> : null}
      <ErrorBanner error={errorInfo(preview.error ?? apply.error ?? undo.error)} />
      {preview.data ? (
        <>
          <dl className="rio-admin-diff">
            {preview.data.diff.map((change) => (
              <div key={change.key}>
                <dt>{i18n._(policyLabels[change.key])}</dt>
                <dd>
                  <Trans id="organizationPresets.before">Current:</Trans>{' '}
                  {change.before === 'admins'
                    ? t({ id: 'organizationPresets.admins', message: 'Admins only' })
                    : showValue(change.key, change.before)}{' '}
                  <Trans id="organizationPresets.after">New:</Trans> {showValue(change.key, change.after)}
                </dd>
              </div>
            ))}
          </dl>
          {preview.data.diff.length === 0 ? (
            <p>
              <Trans id="organizationPresets.unchanged">This preset would not change any settings.</Trans>
            </p>
          ) : (
            <Button
              variant="primary"
              onPress={() => setStaged(true)}
              isPending={apply.isPending}
              isDisabled={preview.isFetching}
            >
              <Trans id="organizationPresets.apply">Apply preset</Trans>
            </Button>
          )}
        </>
      ) : null}
      {apply.data ? (
        <div role="status">
          <Trans id="organizationPresets.applied">Preset applied.</Trans>{' '}
          <Button onPress={() => undo.mutate()} isPending={undo.isPending}>
            <Trans id="adminRoles.undo">Undo change</Trans>
          </Button>
        </div>
      ) : null}
    </section>
  );
}
