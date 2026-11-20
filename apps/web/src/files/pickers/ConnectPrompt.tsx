import { useLingui } from '@lingui/react/macro';
import type { CloudProvider, ConnectedProvider } from '@riosoma/contracts';
import { Banner, Button } from '@riosoma/ui';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useServerMessage } from '../../messages/useServerMessage';
import { connectionStore, connectUrl, onConnected, openConnectWindow } from './api';

/** The providers' names, which stay as each provider writes them. */
export function useProviderNames(): Record<ConnectedProvider, string> {
  const { t } = useLingui();
  return {
    github: t({ id: 'drives.name.github', message: 'GitHub' }),
    xero: t({ id: 'drives.name.xero', message: 'Xero' }),
    quickbooks: t({ id: 'drives.name.quickbooks', message: 'QuickBooks Online' }),
    dropbox: t({ id: 'drives.name.dropbox', message: 'Dropbox' }),
    box: t({ id: 'drives.name.box', message: 'Box' }),
    'google-calendar': t({ id: 'connections.googleCalendar', message: 'Google Calendar' }),
    'microsoft-calendar': t({ id: 'connections.microsoftCalendar', message: 'Microsoft 365 Calendar' }),
    google: t({ id: 'drives.name.google', message: 'Google Drive' }),
  };
}

/** The person's account at a provider, as the shared store knows it. */
export function useConnection(provider: string | undefined) {
  const view = useSyncExternalStore(connectionStore.subscribe, connectionStore.snapshot);
  useEffect(() => {
    if (provider) void connectionStore.load();
  }, [provider]);
  return { loaded: view !== null, connection: view?.providers.find((entry) => entry.provider === provider) };
}

/** How long connecting may take in its window, the same ten minutes the server keeps its state. */
export const CONNECT_WAIT_MS = 10 * 60 * 1000;

/**
 * Asks the person to connect their account before a picker can show anything.  Connecting opens
 * the provider in a small window, and this page hears when it's done.  Where a window can't open,
 * the whole page goes to the provider and comes back here.
 */
export function ConnectPrompt({
  provider,
  reconnect = false,
}: {
  provider: CloudProvider;
  reconnect?: boolean;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const names = useProviderNames();
  const name = names[provider];
  const [error, setError] = useState<string>();
  const [waiting, setWaiting] = useState(false);
  useEffect(
    () =>
      onConnected((result) => {
        if (result.provider !== provider) return;
        setWaiting(false);
        setError(result.ok ? undefined : result.error);
        void connectionStore.load(true);
      }),
    [provider],
  );
  useEffect(() => {
    // Coming back to this window is a cue to look again too, in case the message never came.
    const refresh = () => void connectionStore.load(true);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  useEffect(() => {
    if (!waiting) return;
    // The window can't be watched, since the opener policy cuts it off from this page once it
    // reaches the provider, so the wait lasts until it says how it went, or until its state expires.
    const timer = window.setTimeout(() => {
      setWaiting(false);
      setError('drives.connect.state');
    }, CONNECT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);
  return (
    <div className="rio-drive-connect">
      <p>
        {reconnect
          ? t({
              id: 'drives.connect.reconnectPrompt',
              message: `${name} stopped accepting Riosoma’s access.  Connect your account again to pick files.`,
            })
          : t({
              id: 'drives.connect.prompt',
              message: `Connect your ${name} account to pick files from it.  Riosoma copies only the files you pick.`,
            })}
      </p>
      {error && <Banner tone="danger">{message(error)}</Banner>}
      <Button
        variant="primary"
        isPending={waiting}
        onPress={() => {
          setError(undefined);
          if (openConnectWindow(provider)) setWaiting(true);
          else
            window.location.assign(connectUrl(provider, window.location.pathname + window.location.search));
        }}
      >
        {t({ id: 'drives.connect.button', message: `Connect ${name}` })}
      </Button>
    </div>
  );
}
