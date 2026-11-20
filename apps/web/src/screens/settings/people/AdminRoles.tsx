import { useSettingsSection } from '../SettingsDraft';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  UNIT_ADMIN_ROLES,
  type Member,
  type OrganizationCommandResult,
  type UnitAdminRole,
} from '@riosoma/contracts';
import { Button, Checkbox, Form, Heading, Spinner } from '@riosoma/ui';
import { api } from '../../../api';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { roleLabels } from '../units/labels';

export function AdminRoles({ member }: { member: Member }) {
  const { i18n } = useLingui();
  const cache = useQueryClient();
  const [draft, setDraft] = useState<UnitAdminRole[] | null>(null);
  const key = ['org', 'members', member.id, 'admin-roles'];
  const roles = useQuery({
    queryKey: key,
    queryFn: () =>
      api<{ roles: UnitAdminRole[] }>(`/api/org/members/${encodeURIComponent(member.id)}/admin-roles`),
  });
  const refresh = async () => {
    setDraft(null);
    await cache.invalidateQueries({ queryKey: ['org'] });
  };
  const save = useMutation({
    mutationFn: () =>
      api<OrganizationCommandResult>('/api/org/admin-commands', {
        body: { kind: 'organization.roles', userId: member.id, roles: draft },
      }),
    onSuccess: refresh,
  });
  const undo = useMutation({
    mutationFn: () =>
      api<OrganizationCommandResult>('/api/org/admin-commands', {
        body: { kind: 'organization.undo', eventId: save.data?.eventId },
      }),
    onSuccess: async () => {
      save.reset();
      await refresh();
    },
  });
  const selected = draft ?? roles.data?.roles ?? [];
  const pageDraft = useSettingsSection({
    dirty: JSON.stringify([...selected].sort()) !== JSON.stringify([...(roles.data?.roles ?? [])].sort()),
    stored: roles.data?.roles,
    discard: () => setDraft(null),
    save: () => save.mutateAsync(),
  });
  return (
    <section className="rio-admin-panel" aria-labelledby="admin-roles-title">
      <a href="/settings/people">
        <Trans id="adminRoles.back">Back to People</Trans>
      </a>
      <Heading level={2}>{member.name || member.email}</Heading>
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          void pageDraft.save?.();
        }}
      >
        <Heading level={3} id="admin-roles-title">
          <Trans id="adminRoles.title">Admin roles</Trans>
        </Heading>
        <p>
          <Trans id="adminRoles.description">
            Choose the areas this member can administer for the whole organization.
          </Trans>
        </p>
        {roles.isPending ? (
          <Spinner />
        ) : (
          <fieldset disabled={save.isPending || undo.isPending || !roles.data}>
            <legend>
              <Trans id="adminRoles.areas">Administration areas</Trans>
            </legend>
            {UNIT_ADMIN_ROLES.map((role) => (
              <Checkbox
                key={role}
                isSelected={selected.includes(role)}
                onChange={(checked) =>
                  setDraft(checked ? [...selected, role] : selected.filter((value) => value !== role))
                }
              >
                {i18n._(roleLabels[role])}
              </Checkbox>
            ))}
          </fieldset>
        )}
        <ErrorBanner error={errorInfo(roles.error ?? save.error ?? undo.error)} />
        {save.data ? (
          <div role="status">
            <Trans id="adminRoles.saved">
              {'Admin roles saved.  The member will receive an email and a notification.'}
            </Trans>{' '}
            <Button onPress={() => undo.mutate()} isPending={undo.isPending}>
              <Trans id="adminRoles.undo">Undo change</Trans>
            </Button>
          </div>
        ) : null}
      </Form>
    </section>
  );
}
