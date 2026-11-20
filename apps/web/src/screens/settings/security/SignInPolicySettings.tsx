import { useSettingsSection } from '../SettingsDraft';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../Setting';

import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { SECOND_STEP_POLICIES, type MfaPolicy, type SecondStepPolicy } from '@riosoma/contracts';
import { Checkbox, Form, FormActions, Radio, RadioGroup, toast, Text } from '@riosoma/ui';
import { api } from '../../../api';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { canManageSso } from '../access';
import '../../mfa/mfa.css';
import { SharingPolicyPanel } from '../units/PolicyPanels';
import { SettingsLoading } from '../SettingsLoading';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'security',
  page: 'sign-in-policy',
  label: msg({ id: 'mfa.nav.policy', message: 'Sign-in policy' }),
  roles: ['security'],
  keywords: msg({
    id: 'settings.search.keywords.sign-in-policy',
    message: 'second step authentication required security',
  }),
});

const POLICY_KEY = ['admin', 'mfa', 'policy'];

/** The sign-in policy belongs to the Security area, with single sign-on. */
export const canManageSignInPolicy = canManageSso;

function isPolicy(value: string): value is SecondStepPolicy {
  return (SECOND_STEP_POLICIES as readonly string[]).includes(value);
}

export function SignInPolicySettings() {
  const session = useSession();
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'mfa.nav.policy', message: 'Sign-in policy' })}
    >
      {canManageSignInPolicy(session) ? (
        <>
          <PolicyForm />
          <Setting
            page={settingsPage}
            id="password-reset"
            label={msg({ id: 'auth.reset.policy', message: 'Password reset' })}
          >
            <PasswordResetPolicy />
          </Setting>
          <SharingPolicyPanel />
        </>
      ) : (
        <ErrorBanner error={{ key: 'errors.adminOnly' }} />
      )}
    </Setting>
  );
}

function PolicyForm() {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const current = useQuery({
    queryKey: POLICY_KEY,
    queryFn: ({ signal }) => api<MfaPolicy>('/api/admin/mfa/policy', { signal }),
  });
  const [choice, setChoice] = useState<SecondStepPolicy | null>(null);
  const save = useMutation({
    mutationFn: (policy: SecondStepPolicy) =>
      api<MfaPolicy>('/api/admin/mfa/policy', { method: 'PUT', body: { policy } }),
    onSuccess: (saved) => {
      queryClient.setQueryData(POLICY_KEY, saved);
      setChoice(null);
      toast.show({
        tone: 'success',
        title: t({ id: 'mfa.policy.saved', message: 'Saved the sign-in policy' }),
      });
    },
  });
  const saved = current.data?.policy;
  const policy = choice ?? saved ?? 'off';

  const pageDraft = useSettingsSection({
    dirty: policy !== saved && saved !== undefined,
    stored: saved,
    discard: () => setChoice(null),
    save: () => save.mutateAsync(policy),
  });
  return (
    <div className="rio-mfa-policy">
      <p className="rio-mfa__intro">
        <Trans id="mfa.policy.intro">
          Choose who must use a second step, a passkey or an authenticator app, after a password or an emailed
          link.
        </Trans>
      </p>
      <ErrorBanner error={errorInfo(current.error)} />
      {current.isPending || saved ? (
        <SettingsLoading isPending={current.isPending}>
          <Form
            onSubmit={(event) => {
              event.preventDefault();
              if (saved) void pageDraft.save?.();
            }}
          >
            <Setting
              page={settingsPage}
              id="sign-in-policy"
              label={msg({ id: 'mfa.policy.label', message: 'Who needs a second step' })}
              help={msg({
                id: 'mfa.policy.note',
                message:
                  'Anyone who needs one and has none adds it the next time they sign in.  Single sign-on leaves the second step to the identity provider.',
              })}
            >
              <RadioGroup
                label={t({ id: 'mfa.policy.label', message: 'Who needs a second step' })}
                value={policy}
                isDisabled={!saved}
                onChange={(value) => {
                  if (isPolicy(value)) setChoice(value);
                }}
              >
                <Radio
                  value="off"
                  description={t({
                    id: 'mfa.policy.offHelp',
                    message: 'Anyone can add one, but no one has to.',
                  })}
                >
                  <Trans id="mfa.policy.off">No one</Trans>
                </Radio>
                <Radio
                  value="admins"
                  description={t({
                    id: 'mfa.policy.adminsHelp',
                    message: 'Owners, and members with an admin role.',
                  })}
                >
                  <Trans id="mfa.policy.admins">Owners and admins</Trans>
                </Radio>
                <Radio
                  value="everyone"
                  description={t({ id: 'mfa.policy.everyoneHelp', message: 'Every member and guest.' })}
                >
                  <Trans id="mfa.policy.everyone">Everyone</Trans>
                </Radio>
              </RadioGroup>
            </Setting>
            <p className="rio-mfa__note">
              <Trans id="mfa.policy.note">
                {
                  'Anyone who needs one and has none adds it the next time they sign in.  Single sign-on leaves the second step to the identity provider.'
                }
              </Trans>
            </p>
            <ErrorBanner error={errorInfo(save.error)} />
            <FormActions></FormActions>
          </Form>
        </SettingsLoading>
      ) : null}
    </div>
  );
}

function PasswordResetPolicy() {
  const queryClient = useQueryClient();
  const key = ['admin', 'password-reset', 'policy'];
  const current = useQuery({
    queryKey: key,
    queryFn: () => api<{ enabled: boolean }>('/api/admin/password-reset/policy'),
  });
  const [choice, setChoice] = useState<boolean | null>(null);
  const enabled = choice ?? current.data?.enabled ?? true;
  const save = useMutation({
    mutationFn: () => api('/api/admin/password-reset/policy', { method: 'PUT', body: { enabled } }),
    onSuccess: () => {
      queryClient.setQueryData(key, { enabled });
      setChoice(null);
      void queryClient.invalidateQueries({ queryKey: ['auth', 'password-reset'] });
    },
  });
  const draft = useSettingsSection({
    dirty: choice !== null && enabled !== current.data?.enabled,
    stored: current.data,
    discard: () => setChoice(null),
    save: () => save.mutateAsync(),
  });
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        void draft.save?.();
      }}
    >
      <Checkbox isSelected={enabled} onChange={setChoice} isDisabled={!current.data}>
        <Trans id="auth.reset.policyEnable">Allow password reset</Trans>
      </Checkbox>
      <Text>
        <Trans id="auth.reset.policyHelp">
          {'When password reset is off, people contact an administrator.  Existing reset links stop working.'}
        </Trans>
      </Text>
      <ErrorBanner error={errorInfo(current.error ?? save.error)} />
    </Form>
  );
}
