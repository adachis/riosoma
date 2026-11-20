import { Setting, defineSettingsPage } from '../../screens/settings/Setting';
import { msg } from '@lingui/core/macro';
import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { StripeConnection } from '@riosoma/contracts';
import { Banner, Button, Heading, PasswordField, TextField } from '@riosoma/ui';
import { api } from '../../api';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import './payments.css';
const embeddedPage = defineSettingsPage({
  area: 'admin',
  section: 'connections',
  page: 'integrations',
  label: msg({ id: 'settings.nav.integrations', message: 'Integrations' }),
  roles: ['integrations'],
});

export function StripeSettings() {
  const { t } = useLingui();
  const [secretKey, setSecretKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const connection = useQuery({
    queryKey: ['stripe-connection'],
    queryFn: () => api<StripeConnection>('/api/admin/payments/stripe'),
  });
  const save = useMutation({
    mutationFn: () =>
      api<StripeConnection>('/api/admin/payments/stripe', {
        method: 'PUT',
        body: { secretKey, webhookSecret },
      }),
    onSuccess: async () => {
      setSecretKey('');
      setWebhookSecret('');
      await connection.refetch();
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api('/api/admin/payments/stripe', { method: 'DELETE' }),
    onSuccess: () => connection.refetch(),
  });
  return (
    <section className="rio-payments">
      <Heading level={2}>{t({ id: 'payments.title', message: 'Payments through Stripe' })}</Heading>
      <p>
        {t({
          id: 'payments.connect.help',
          message:
            'Connect your organization’s Stripe account.  Keys are stored securely and are never shown again.  Restricted keys need balance read access, Checkout Session write access, PaymentIntent read access, and refund write access.',
        })}
      </p>
      <Banner tone={connection.data?.mode === 'live' ? 'warning' : 'info'}>
        {connection.data?.mode === 'live'
          ? t({ id: 'payments.mode.live', message: 'Live mode—visitors pay real money' })
          : connection.data?.mode === 'test'
            ? t({ id: 'payments.mode.test', message: 'Test mode—no real money changes hands' })
            : t({ id: 'payments.mode.none', message: 'Stripe is not connected' })}
      </Banner>
      {connection.data?.webhookUrl && (
        <TextField
          isReadOnly
          label={t({ id: 'payments.webhook.address', message: 'Webhook address' })}
          value={connection.data.webhookUrl}
        />
      )}
      <p>
        {t({
          id: 'payments.webhook.help',
          message:
            'In Stripe, create a webhook destination for this account, select these events, and copy its signing secret.  After connecting, paste the webhook address shown here into that destination.',
        })}
      </p>
      <ul>
        {connection.data?.events.map((event) => (
          <li key={event}>
            <code>{event}</code>
          </li>
        ))}
      </ul>
      <Setting
        page={embeddedPage}
        id="payments-secret-key"
        label={msg({ id: 'payments.secretKey', message: 'Stripe secret key' })}
      >
        <PasswordField
          label={t({ id: 'payments.secretKey', message: 'Stripe secret key' })}
          value={secretKey}
          onChange={setSecretKey}
        />
      </Setting>
      <Setting
        page={embeddedPage}
        id="payments-webhook-secret"
        label={msg({ id: 'payments.webhookSecret', message: 'Webhook signing secret' })}
      >
        <PasswordField
          label={t({ id: 'payments.webhookSecret', message: 'Webhook signing secret' })}
          value={webhookSecret}
          onChange={setWebhookSecret}
        />
      </Setting>
      <ErrorBanner error={errorInfo(save.error ?? disconnect.error ?? connection.error)} />
      <Button
        isPending={save.isPending}
        isDisabled={!secretKey || !webhookSecret}
        onPress={() => save.mutate()}
      >
        {t({ id: 'payments.connect', message: 'Verify and connect Stripe' })}
      </Button>
      {connection.data?.connected && (
        <Button isPending={disconnect.isPending} onPress={() => disconnect.mutate()}>
          {t({ id: 'payments.disconnect', message: 'Disconnect Stripe' })}
        </Button>
      )}
    </section>
  );
}
