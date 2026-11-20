import { useLingui } from '@lingui/react/macro';
import type { AutomationMessagingPolicy } from '@riosoma/contracts';
import { Switch } from '@riosoma/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../api';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { canManageSso } from '../../settings/sso/SsoSettings';

const key = ['automations', 'messagingPolicy'];
const path = '/api/admin/automations/messaging';

export function SmsPolicy() {
  const { t } = useLingui();
  const session = useSession();
  return (
    <>
      <p>
        {t({
          id: 'automations.messaging.cost',
          message:
            'SMS costs money, including test messages.  Text messaging is off by default.  An owner or security admin can enable it for the organization.',
        })}
      </p>
      {canManageSso(session) ? <PolicySwitch /> : null}
    </>
  );
}

function PolicySwitch() {
  const { t } = useLingui();
  const client = useQueryClient();
  const policy = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<AutomationMessagingPolicy>(path, { signal }),
  });
  const save = useMutation({
    mutationFn: (smsEnabled: boolean) =>
      api<AutomationMessagingPolicy>(path, { method: 'PUT', body: { smsEnabled } }),
    onSuccess: (value) => client.setQueryData(key, value),
  });
  return (
    <>
      <ErrorBanner error={errorInfo(policy.error ?? save.error)} />
      {policy.data ? (
        <Switch
          isSelected={policy.data.smsEnabled}
          isDisabled={save.isPending}
          onChange={(value) => save.mutate(value)}
        >
          {t({ id: 'automations.messaging.enable', message: 'Allow SMS for this organization' })}
        </Switch>
      ) : null}
    </>
  );
}
