import { useLingui } from '@lingui/react/macro';
import { ConnectedProvider, type ProviderConnection } from '@riosoma/contracts';
import { Banner, Button, ListBoxItem, Select, Spinner } from '@riosoma/ui';
import { useEffect, useEffectEvent, useState } from 'react';
import { connectionStore, connectUrl, onConnected, openConnectWindow } from '../../../files/pickers/api';
import { CONNECT_WAIT_MS } from '../../../files/pickers/ConnectPrompt';
import { useServerMessage } from '../../../messages/useServerMessage';

export function AppSourceAccount({
  provider,
  connection,
  loaded,
  value,
  onChange,
  isDisabled,
}: {
  provider: string;
  connection?: ProviderConnection;
  loaded: boolean;
  value: string;
  onChange(id: string): void;
  isDisabled?: boolean;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string>();
  const selectAccount = useEffectEvent((id: string) => onChange(id));
  useEffect(() => {
    let active = true;
    const unsubscribe = onConnected((result) => {
      if (result.provider !== provider) return;
      setWaiting(false);
      setError(result.ok ? undefined : result.error);
      void connectionStore.load(true).then(() => {
        if (!active) return;
        const account = connectionStore
          .snapshot()
          ?.providers.find((entry) => entry.provider === provider)?.account;
        if (result.ok && account?.id) selectAccount(account.id);
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [provider]);
  useEffect(() => {
    const refresh = () => void connectionStore.load(true);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => {
      setWaiting(false);
      setError('drives.connect.state');
    }, CONNECT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);
  if (!loaded)
    return <Spinner aria-label={t({ id: 'sources.app.accountsLoading', message: 'Loading accounts' })} />;
  if (!connection?.available)
    return (
      <Banner tone="warning">
        {t({
          id: 'sources.app.providerUnavailable',
          message:
            'Unavailable.  Ask an admin to set up or enable this provider under Settings, Integrations, using the callback address shown there.',
        })}
      </Banner>
    );
  const account = connection.account;
  return (
    <div className="rio-sources__group">
      <Select
        label={t({ id: 'sources.app.account', message: 'Connected account' })}
        selectedKey={value || null}
        onSelectionChange={(key) => onChange(key === null ? '' : String(key))}
        isDisabled={isDisabled || waiting}
        isRequired
        placeholder={t({ id: 'sources.app.chooseAccount', message: 'Choose an account' })}
      >
        {account?.id ? <ListBoxItem id={account.id}>{account.name}</ListBoxItem> : null}
      </Select>
      {account?.needsReconnect ? (
        <Banner tone="warning">
          {t({
            id: 'sources.app.accountReconnect',
            message: 'Connect this account again before testing or syncing.',
          })}
        </Banner>
      ) : null}
      {account ? (
        <p>
          {t({
            id: 'sources.app.replaceAccount',
            message:
              'Connecting another account replaces your current account for this provider.  Sources using a different account stop syncing until you choose the replacement account and save each source.',
          })}
        </p>
      ) : null}
      {provider === 'github' ? (
        <p>
          {t({
            id: 'sources.app.github.connectHelp',
            message:
              'GitHub requests repo and read:org access.  GitHub OAuth apps have no read-only scope for private repositories.  Riosoma only reads repositories, issues, and pull requests.',
          })}
        </p>
      ) : null}
      {error ? <Banner tone="danger">{message(error)}</Banner> : null}
      <Button
        isDisabled={isDisabled}
        isPending={waiting}
        onPress={() => {
          const parsed = ConnectedProvider.safeParse(provider);
          if (!parsed.success) return;
          setError(undefined);
          if (openConnectWindow(parsed.data)) setWaiting(true);
          else
            window.location.assign(
              connectUrl(parsed.data, window.location.pathname + window.location.search),
            );
        }}
      >
        {account
          ? t({ id: 'sources.app.connectAnother', message: 'Connect another account' })
          : t({ id: 'sources.app.connectAccount', message: 'Connect' })}
      </Button>
    </div>
  );
}
