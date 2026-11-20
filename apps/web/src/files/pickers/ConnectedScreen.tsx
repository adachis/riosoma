import { Trans, useLingui } from '@lingui/react/macro';
import { CONNECTED_PROVIDERS, type ConnectedProvider } from '@riosoma/contracts';
import { Banner, Heading, Link, Text } from '@riosoma/ui';
import { useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { RiosomaLogo } from '../../brand/RiosomaLogo';
import { useServerMessage } from '../../messages/useServerMessage';
import { announceConnected } from './api';
import { useProviderNames } from './ConnectPrompt';
import '../../screens/setup/SetupScreen.css';

/** A server message key about connecting, and nothing else. */
const FAILURE = /^drives\.[A-Za-z.]{1,60}$/;

function readOutcome(provider: string): { ok: boolean; error?: string } {
  const search = new URLSearchParams(window.location.search);
  const error = search.get('connectError');
  if (error && FAILURE.test(error)) return { ok: false, error };
  return { ok: search.get('connected') === provider };
}

/**
 * Where the small window that connects an account lands.  It tells the page that opened it how it
 * went and closes itself.  Opened on its own, it says how it went and links to settings.
 */
export function ConnectedScreen({ provider }: { provider: string }) {
  const { t } = useLingui();
  const message = useServerMessage();
  const names = useProviderNames();
  const [outcome] = useState(() => readOutcome(provider));
  const known = (CONNECTED_PROVIDERS as readonly string[]).includes(provider);
  const name = known ? names[provider as ConnectedProvider] : provider;
  useEffect(() => {
    announceConnected({ provider, ...outcome });
    // The window's opener is often gone by now, since the provider's pages cut it off, so the
    // message goes out on a channel and the window closes itself when the browser allows it.
    if (outcome.ok) window.close();
  }, [provider, outcome]);
  return (
    <div className="rio-page-center">
      <div className="rio-card rio-setup">
        <div className="rio-setup__brand">
          <RiosomaLogo />
        </div>
        {outcome.ok ? (
          <div role="status">
            <Heading level={1}>
              {t({ id: 'drives.connected.title', message: `${name} is connected` })}
            </Heading>
            <Text>
              <Trans id="drives.connected.body">You can close this window and pick your files.</Trans>
            </Text>
          </div>
        ) : (
          <>
            <Heading level={1}>
              {t({ id: 'drives.connected.failedTitle', message: `${name} isn’t connected` })}
            </Heading>
            <Banner tone="danger">{message(outcome.error ?? 'drives.connect.failed')}</Banner>
          </>
        )}
        <Link href="/settings/connected-accounts">
          {t({ id: 'drives.connected.settings', message: 'Go to connected accounts' })}
        </Link>
      </div>
    </div>
  );
}

/** The route's page, with the provider from the address. */
export function ConnectedRoute() {
  const { provider } = useParams({ from: '/connected/$provider' });
  return <ConnectedScreen provider={provider} />;
}
