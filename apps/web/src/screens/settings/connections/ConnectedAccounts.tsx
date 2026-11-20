import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../Setting';

import { useLingui } from '@lingui/react/macro';
import type { ConnectedProvider, ProviderConnection } from '@riosoma/contracts';
import { Banner, Button, ConfirmDialog, Spinner } from '@riosoma/ui';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useServerMessage } from '../../../messages/useServerMessage';
import { ErrorBanner } from '../../../shell/ErrorBanner';
import { errorInfo } from '../../setup/useSetup';
import { connectionStore, connectUrl, disconnect } from '../../../files/pickers/api';
import { useProviderNames } from '../../../files/pickers/ConnectPrompt';
import './connections.css';

const settingsPage = defineSettingsPage({
  area: 'personal',
  section: 'account',
  page: 'connected-accounts',
  label: msg({ id: 'settings.nav.connectedAccounts', message: 'Connected accounts' }),
  roles: ['personal'],
  keywords: msg({
    id: 'settings.search.keywords.connected-accounts',
    message: 'accounts cloud drives attachments',
  }),
});

const HERE = '/settings/connected-accounts';
/** A server message key about connecting, and nothing else. */
const FAILURE = /^drives\.[A-Za-z.]{1,60}$/;

/** What connecting came back with, from the address, once. */
function readOutcome(): { connected?: string; error?: string } {
  const search = new URLSearchParams(window.location.search);
  const error = search.get('connectError');
  const connected = search.get('connected');
  return {
    ...(connected ? { connected } : {}),
    ...(error && FAILURE.test(error) ? { error } : {}),
  };
}

/**
 * The cloud drive accounts a person connected to add attachments from.  Each shows whose account
 * it is and when it was connected, with Disconnect, which also asks the provider to forget
 * Riosoma's access.  Drives an admin set up but the person hasn't connected offer Connect.
 */
export function ConnectedAccounts() {
  const { t } = useLingui();
  const message = useServerMessage();
  const names = useProviderNames();
  const view = useSyncExternalStore(connectionStore.subscribe, connectionStore.snapshot);
  const [outcome] = useState(readOutcome);
  const [removing, setRemoving] = useState<ConnectedProvider | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  useEffect(() => {
    void connectionStore.load(true);
  }, []);

  const shown = (view?.providers ?? []).filter((entry) => entry.available || entry.account);
  const connectedName =
    outcome.connected && outcome.connected in names ? names[outcome.connected as ConnectedProvider] : null;
  const usedSources = view?.providers.find((entry) => entry.provider === removing)?.account?.sources ?? [];
  const sources = usedSources.map((source) => source.name).join(', ');
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'settings.nav.connectedAccounts', message: 'Connected accounts' })}
    >
      {
        <div className="rio-connections">
          <p>
            {t({
              id: 'drives.accounts.intro',
              message:
                'Connect accounts to add attachments, create calendar events, or sync app sources.  Your password never reaches Riosoma.',
            })}
          </p>
          {connectedName && (
            <Banner tone="success">
              {t({ id: 'drives.accounts.connected', message: `${connectedName} is connected.` })}
            </Banner>
          )}
          {outcome.error && <Banner tone="danger">{message(outcome.error)}</Banner>}
          <ErrorBanner error={errorInfo(failure)} />
          {view === null ? (
            <Spinner aria-label={t({ id: 'drives.accounts.loading', message: 'Loading' })} />
          ) : !shown.length ? (
            <p>
              {t({
                id: 'drives.accounts.none',
                message: 'No services are set up yet.  An admin can set them up under Integrations.',
              })}
            </p>
          ) : (
            <ul className="rio-connections__list">
              {shown.map((entry) => (
                <Account
                  key={entry.provider}
                  entry={entry}
                  name={names[entry.provider]}
                  onDisconnect={() => setRemoving(entry.provider)}
                />
              ))}
            </ul>
          )}
          {removing && (
            <ConfirmDialog
              isOpen
              tone="danger"
              title={t({ id: 'drives.accounts.disconnectTitle', message: `Disconnect ${names[removing]}?` })}
              message={
                usedSources.length
                  ? t({
                      id: 'sources.app.disconnectWarning',
                      message: `These sources will stop syncing: ${sources}.  Connect again and update each source to resume syncing.`,
                    })
                  : t({
                      id: 'drives.accounts.disconnectBody',
                      message: 'Files you already added stay where they are.  To add more, connect again.',
                    })
              }
              confirmLabel={t({ id: 'drives.accounts.disconnect', message: 'Disconnect' })}
              onOpenChange={(open) => {
                if (!open) setRemoving(null);
              }}
              onConfirm={async () => {
                setFailure(null);
                try {
                  await disconnect(removing, usedSources.length > 0);
                  setRemoving(null);
                } catch (error) {
                  setFailure(error);
                }
              }}
            />
          )}
        </div>
      }
    </Setting>
  );
}

function Account({
  entry,
  name,
  onDisconnect,
}: {
  entry: ProviderConnection;
  name: string;
  onDisconnect(): void;
}) {
  const { t, i18n } = useLingui();
  const account = entry.account;
  const connect = () => window.location.assign(connectUrl(entry.provider, HERE));
  const since = account
    ? new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' }).format(new Date(account.connectedAt))
    : '';
  return (
    <li className="rio-connections__item">
      <div className="rio-connections__text">
        <strong>{name}</strong>
        {account ? (
          <span className="rio-connections__detail">
            {account.email
              ? t({
                  id: 'drives.accounts.as',
                  message: `${account.name} (${account.email}), connected ${since}`,
                })
              : t({ id: 'drives.accounts.asName', message: `${account.name}, connected ${since}` })}
          </span>
        ) : (
          <span className="rio-connections__detail">
            {t({ id: 'drives.accounts.notConnected', message: 'Not connected' })}
          </span>
        )}
        {account?.needsReconnect && (
          <span className="rio-connections__warning">
            {t({ id: 'drives.accounts.needsReconnect', message: 'Connect again to keep using it' })}
          </span>
        )}
        {account && !entry.available && (
          <span className="rio-connections__detail">
            {t({ id: 'drives.accounts.off', message: 'An admin turned this connection off.' })}
          </span>
        )}
      </div>
      <div className="rio-connections__actions">
        {entry.available && (!account || account.needsReconnect) && (
          <Button variant={account ? 'primary' : 'secondary'} onPress={connect}>
            {account
              ? t({ id: 'drives.accounts.reconnect', message: 'Connect again' })
              : t({ id: 'drives.accounts.connect', message: `Connect ${name}` })}
          </Button>
        )}
        {account && (
          <Button
            aria-label={t({ id: 'drives.accounts.disconnectLabel', message: `Disconnect ${name}` })}
            onPress={onDisconnect}
          >
            {t({ id: 'drives.accounts.disconnect', message: 'Disconnect' })}
          </Button>
        )}
      </div>
    </li>
  );
}
