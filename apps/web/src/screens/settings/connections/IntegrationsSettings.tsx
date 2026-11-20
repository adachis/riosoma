import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { useSettingsDraft } from '../SettingsDraft';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../Setting';

import { canManageIntegrations } from '../access';
import { StripeSettings } from '../../../features/payments/StripeSettings';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IntegrationTestResult, IntegrationUpdate, IntegrationView } from '@riosoma/contracts';
import { Banner, Button, Heading, PasswordField, Spinner, Switch, TextField, toast } from '@riosoma/ui';
import { api } from '../../../api';
import { connectionStore } from '../../../files/pickers/api';
import { useProviderNames } from '../../../files/pickers/ConnectPrompt';
import { useServerMessage } from '../../../messages/useServerMessage';
import { useSession } from '../../../session';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import './connections.css';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'connections',
  page: 'integrations',
  label: msg({ id: 'settings.nav.integrations', message: 'Integrations' }),
  roles: ['integrations'],
  keywords: msg({
    id: 'settings.search.keywords.integrations',
    message: 'integrations cloud drives attachments payments',
  }),
});

const KEY = ['admin', 'integrations'];

const draftFromView = (view: IntegrationView) => ({
  clientId: view.clientId,
  secret: '',
  tenantId: view.tenantId ?? '',
  apiKey: view.apiKey ?? '',
  enabled: view.enabled,
});

/** Owners, and the admins given the Integrations role, set up the cloud drives. */
export { canManageIntegrations } from '../access';

/**
 * Admin settings for the cloud drives people add attachments from: each provider's app, the exact
 * redirect address to register with it, a test, and a switch to turn it off.  An app set in the
 * server's settings shows as such, and only its switch works here.
 */
export function IntegrationsSettings() {
  const session = useSession();
  const integrations = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => api<IntegrationView[]>('/api/admin/integrations', { signal }),
    enabled: canManageIntegrations(session),
  });
  if (!canManageIntegrations(session)) return <ErrorBanner error={{ key: 'errors.adminOnly' }} />;
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'settings.nav.integrations', message: 'Integrations' })}
    >
      {
        <div className="rio-integrations">
          <StripeSettings />
          <p>
            <Trans id="integrations.intro">
              Set up providers for attachments, calendar events, and app sources. Each person connects their
              own account. App sources share that account’s read access with everyone allowed to sync from
              them.
            </Trans>
          </p>
          <ErrorBanner error={errorInfo(integrations.error)} />
          {integrations.isPending && <Spinner />}
          {integrations.data?.map((integration) => (
            <IntegrationPanel
              key={`${integration.provider}:${integration.fromEnvironment}`}
              integration={integration}
            />
          ))}
        </div>
      }
    </Setting>
  );
}

function IntegrationPanel({ integration }: { integration: IntegrationView }) {
  const { t } = useLingui();
  const message = useServerMessage();
  const queryClient = useQueryClient();
  const name = useProviderNames()[integration.provider];
  const locked = integration.fromEnvironment;
  const saved = async (update: IntegrationUpdate) => {
    const view = await api<IntegrationView>(`/api/admin/integrations/${integration.provider}`, {
      method: 'PUT',
      body: update,
    });
    queryClient.setQueryData<IntegrationView[]>(KEY, (current) =>
      current?.map((entry) => (entry.provider === view.provider ? view : entry)),
    );
    void connectionStore.load(true);
    return view;
  };
  const draft = useSettingsDraft(
    draftFromView(integration),
    async (value) => {
      return saved({
        enabled: value.enabled,
        ...(locked
          ? {}
          : {
              clientId: value.clientId,
              tenantId: value.tenantId,
              ...(value.secret ? { clientSecret: value.secret } : {}),
              ...(integration.apiKey !== null ? { apiKey: value.apiKey } : {}),
            }),
      });
    },
    {
      reconcile: (current, submitted, result) => {
        const stored = draftFromView(result as IntegrationView);
        return {
          clientId: current.clientId === submitted.clientId ? stored.clientId : current.clientId,
          secret: current.secret === submitted.secret ? stored.secret : current.secret,
          tenantId: current.tenantId === submitted.tenantId ? stored.tenantId : current.tenantId,
          apiKey: current.apiKey === submitted.apiKey ? stored.apiKey : current.apiKey,
          enabled: current.enabled === submitted.enabled ? stored.enabled : current.enabled,
        };
      },
      validate: (value) =>
        value.enabled &&
        !locked &&
        (!value.clientId.trim() ||
          (!value.secret.trim() && !integration.hasSecret) ||
          (integration.apiKey !== null && !value.apiKey.trim()))
          ? t({
              id: 'drives.incompleteApp',
              message:
                'Complete the client ID, secret, and required API key before enabling this connection.',
            })
          : null,
    },
  );
  const { clientId, secret, tenantId, apiKey, enabled } = draft.value;
  const setClientId = (clientId: string) => draft.setValue((current) => ({ ...current, clientId }));
  const setSecret = (secret: string) => draft.setValue((current) => ({ ...current, secret }));
  const setTenantId = (tenantId: string) => draft.setValue((current) => ({ ...current, tenantId }));
  const setApiKey = (apiKey: string) => draft.setValue((current) => ({ ...current, apiKey }));
  const typed = (): IntegrationUpdate => ({
    ...(tenantId !== (integration.tenantId ?? '') ? { tenantId } : {}),
    ...(clientId !== integration.clientId ? { clientId } : {}),
    ...(secret ? { clientSecret: secret } : {}),
    ...(integration.apiKey !== null && apiKey !== integration.apiKey ? { apiKey } : {}),
  });
  const test = useMutation({
    mutationFn: () =>
      api<IntegrationTestResult>(`/api/admin/integrations/${integration.provider}/test`, {
        method: 'POST',
        body: locked ? {} : typed(),
      }),
  });

  async function copy() {
    try {
      await navigator.clipboard.writeText(integration.redirectUri);
    } catch {
      // Without clipboard access the address stays in its field, where it can be copied by hand.
      return;
    }
    toast.show({ tone: 'success', title: t({ id: 'integrations.copied', message: 'Copied' }) });
  }

  return (
    <section className="rio-integrations__provider" aria-labelledby={`integration-${integration.provider}`}>
      <Heading level={2} id={`integration-${integration.provider}`}>
        {name}
      </Heading>
      <p className="rio-integrations__status">
        {integration.configured
          ? integration.enabled
            ? t({ id: 'integrations.status.on', message: 'Offered to people' })
            : t({ id: 'integrations.status.off', message: 'Set up, but turned off' })
          : t({ id: 'integrations.status.missing', message: 'Not set up' })}
      </p>
      {locked && (
        <Banner tone="info">
          {t({
            id: 'integrations.fromEnvironment',
            message: 'This app is set in the server’s settings.  Change it there, or turn it off here.',
          })}
        </Banner>
      )}
      <div className="rio-integrations__callback">
        <TextField
          label={t({
            id: 'integrations.redirect',
            message: 'Redirect address to register with the provider',
          })}
          value={integration.redirectUri}
          isReadOnly
        />
        <Button
          onPress={() => void copy()}
          aria-label={t({ id: 'integrations.copy', message: 'Copy' })}
          icon={faCopy}
        />
      </div>
      <Setting
        page={settingsPage}
        id="client-id"
        label={msg({ id: 'integrations.clientId', message: 'Client ID or app key' })}
      >
        <TextField
          label={t({ id: 'integrations.clientId', message: 'Client ID or app key' })}
          value={clientId}
          onChange={setClientId}
          isInvalid={enabled && !clientId.trim()}
          errorMessage={t({
            id: 'integrations.clientIdRequired',
            message: 'Enter the client ID or app key.',
          })}
          isReadOnly={locked}
        />
      </Setting>
      {integration.provider === 'microsoft-calendar' && (
        <Setting
          page={settingsPage}
          id="tenant"
          label={msg({ id: 'integrations.tenant', message: 'Tenant ID' })}
          help={msg({
            id: 'integrations.tenant.help',
            message:
              'Use your directory tenant ID for a single-tenant app.  Leave blank for a multitenant app.',
          })}
        >
          <TextField
            label={t({ id: 'integrations.tenant', message: 'Tenant ID' })}
            description={t({
              id: 'integrations.tenant.help',
              message:
                'Use your directory tenant ID for a single-tenant app.  Leave blank for a multitenant app.',
            })}
            value={tenantId}
            onChange={setTenantId}
            isDisabled={locked || draft.saving}
          />
        </Setting>
      )}
      {!locked && (
        <Setting
          page={settingsPage}
          id="client-secret"
          label={msg({ id: 'integrations.clientSecret', message: 'Client secret or app secret' })}
        >
          <PasswordField
            label={t({ id: 'integrations.clientSecret', message: 'Client secret or app secret' })}
            description={
              integration.hasSecret
                ? t({
                    id: 'integrations.secretStored',
                    message: 'A secret is stored.  Enter a new one to replace it.',
                  })
                : undefined
            }
            value={secret}
            onChange={setSecret}
            isInvalid={enabled && !integration.hasSecret && !secret.trim()}
            errorMessage={t({
              id: 'integrations.secretRequired',
              message: 'Enter the client secret or app secret.',
            })}
          />
        </Setting>
      )}
      {integration.apiKey !== null && (
        <Setting
          page={settingsPage}
          id="api-key"
          label={msg({ id: 'integrations.apiKey', message: 'Picker API key' })}
        >
          <TextField
            label={t({ id: 'integrations.apiKey', message: 'Picker API key' })}
            description={t({
              id: 'integrations.apiKeyHelp',
              message:
                'Every browser that opens Google’s Picker gets this key, so restrict it to this address.',
            })}
            value={apiKey}
            onChange={setApiKey}
            isInvalid={enabled && !apiKey.trim()}
            errorMessage={t({ id: 'integrations.apiKeyRequired', message: 'Enter the Picker API key.' })}
            isReadOnly={locked}
          />
        </Setting>
      )}
      <Setting
        page={settingsPage}
        id="integration-enabled"
        label={msg({
          id: 'settings.search.integrationEnabled',
          message: 'Offer this integration in attachment fields',
        })}
      >
        <Switch
          isSelected={enabled}
          isDisabled={draft.saving}
          onChange={(enabled) => draft.setValue((current) => ({ ...current, enabled }))}
        >
          {t({ id: 'integrations.enabled', message: `Offer ${name} in attachment fields` })}
        </Switch>
      </Setting>
      <ErrorBanner error={errorInfo(test.error)} />
      {test.data && (
        <Banner tone={test.data.ok ? 'success' : 'danger'}>{message(test.data.messageKey)}</Banner>
      )}
      <div className="rio-integrations__actions">
        <Button isPending={test.isPending} onPress={() => test.mutate()}>
          {t({ id: 'integrations.test', message: 'Test' })}
        </Button>
      </div>
    </section>
  );
}
