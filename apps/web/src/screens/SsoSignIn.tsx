import { Trans } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import type { SsoButton, SsoKind } from '@riosoma/contracts';
import { Link } from '@riosoma/ui';
import { api } from '../api';
import './SsoSignIn.css';

/**
 * Where a provider's button starts signing in, carrying the page to come back to.  SAML identity
 * providers start from their own route.
 */
export function ssoStartHref(providerId: string, next: string | undefined, kind: SsoKind = 'oidc'): string {
  const path = `/api/auth/${kind === 'saml' ? 'saml' : 'sso'}/${encodeURIComponent(providerId)}/start`;
  return next && next !== '/' ? `${path}?${new URLSearchParams({ next }).toString()}` : path;
}

/**
 * A button for each provider an administrator has turned on.  Each one is a link, because it
 * leaves the app for the provider's own page, and the server brings the person back signed in.
 */
export function SsoSignIn({ next }: { next: string | undefined }) {
  const providers = useQuery({
    queryKey: ['auth', 'sso'],
    queryFn: () => api<SsoButton[]>('/api/auth/sso'),
    staleTime: 5 * 60_000,
  });
  if (!providers.data?.length) return null;
  return (
    <ul className="rio-sso-sign-in">
      {providers.data.map((provider) => (
        <li key={provider.id}>
          <ProviderLink provider={provider} next={next} />
        </li>
      ))}
    </ul>
  );
}

function ProviderLink({ provider, next }: { provider: SsoButton; next: string | undefined }) {
  const { name } = provider;
  return (
    <Link className="rio-sso-sign-in__button" href={ssoStartHref(provider.id, next, provider.kind)}>
      <Trans id="signIn.sso">Continue with {name}</Trans>
    </Link>
  );
}
