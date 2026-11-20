import { Trans } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { needsSecondStep, type SignInResult } from '@riosoma/contracts';
import { Heading, Text } from '@riosoma/ui';
import { api, setCsrfToken } from '../api';
import { RiosomaLogo } from '../brand/RiosomaLogo';
import { sessionQuery } from '../session';
import { safeNext } from '../router';
import { ErrorBanner } from '../shell/ErrorBanner';
import { secondStepQuery } from './mfa/secondStep';
import { errorInfo } from './setup/useSetup';
import './setup/SetupScreen.css';

function readToken(): string | null {
  return /(?:^|[#&])token=([A-Za-z0-9_-]{20,200})/.exec(window.location.hash)?.[1] ?? null;
}

/** Where an emailed sign-in link lands: trade the one-time token for a session. */
export function SignInLinkScreen() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/sign-in/link' });
  const queryClient = useQueryClient();
  // The token arrives in the fragment.  A second link opened in the same tab only changes the
  // fragment, so listen for that too.
  const [token, setToken] = useState(readToken);
  const missing = token === null;

  const redeem = useMutation({
    mutationFn: (token: string) => api<SignInResult>('/api/auth/link/redeem', { body: { token } }),
    onSuccess: (result) => {
      // Someone with a second step finishes on the sign-in page, which picks up where this left off.
      if (needsSecondStep(result)) {
        queryClient.setQueryData(secondStepQuery.queryKey, { secondStep: result.secondStep });
        void navigate({ to: '/sign-in', search: { next: safeNext(search.next) } });
        return;
      }
      setCsrfToken(result.csrfToken);
      queryClient.setQueryData(sessionQuery.queryKey, result);
      void navigate({ to: safeNext(search.next) });
    },
  });

  useEffect(() => {
    const onHashChange = () => {
      const next = readToken();
      if (next) setToken(next);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const redeemed = useRef<string | null>(null);
  useEffect(() => {
    // The token leaves the address bar at once so it can't be bookmarked or shared.
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    if (token && redeemed.current !== token) {
      redeemed.current = token;
      redeem.mutate(token);
    }
  }, [redeem, token]);

  return (
    <div className="rio-page-center">
      <div className="rio-card rio-setup" role="status">
        <div className="rio-setup__brand">
          <RiosomaLogo animate={!redeem.isError && !missing} size="large" />
        </div>
        {redeem.isError || missing ? (
          <>
            <Heading level={1}>
              <Trans id="auth.link.failedTitle">That link didn’t work</Trans>
            </Heading>
            <ErrorBanner error={errorInfo(redeem.error) ?? { key: 'auth.link.invalid' }} />
            <Text>
              <Link to="/sign-in" search={{ next: safeNext(search.next) }}>
                <Trans id="auth.link.backToSignIn">Go to sign-in</Trans>
              </Link>
            </Text>
          </>
        ) : (
          <Text>
            <Trans id="auth.link.signingIn">Signing you in…</Trans>
          </Text>
        )}
      </div>
    </div>
  );
}
