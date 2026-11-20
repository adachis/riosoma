import { useContext, useSyncExternalStore, type CSSProperties } from 'react';
import { QueryClientContext, useQuery } from '@tanstack/react-query';
import { themes } from '../preferences';
import { useOverriddenTheme } from '../features/themes/override';
import type { SessionInfo, SignInMethods } from '@riosoma/contracts';
import type { OrganizationLogo as Logo } from '@riosoma/contracts';
import { appliedSettings, useSession } from '../session';
import { RiosomaLogo } from './RiosomaLogo';
import { useMediaQuery } from '../shell/useMediaQuery';

export function OrganizationLogo({
  logo,
  name,
  publicRead = false,
  preview,
}: {
  logo: Logo;
  name: string;
  publicRead?: boolean;
  preview?: { main: string; compact?: string };
}) {
  const session = useSession();
  const override = useOverriddenTheme();
  const compactSurface = useMediaQuery('(max-width: 640px)');
  const theme =
    override?.theme ??
    session?.preferences.theme ??
    appliedSettings(session)?.defaultTheme?.theme ??
    document.documentElement.dataset.theme ??
    'nature';
  const manifest = useQuery({
    queryKey: ['themes', 'manifest', theme],
    queryFn: () => themes.manifest(theme),
    staleTime: Infinity,
    enabled: logo.mode === 'original',
  });
  const surface = (compactSurface ? logo.compact?.surface : undefined) ?? logo.main.surface ?? 'light';
  const scheme = manifest.data?.schemes.find((scheme) => scheme.appearance === surface)?.id;
  const background = scheme ? 'var(--rio-surface)' : 'var(--rio-text)';
  const url = (key: string) => `/api/${publicRead ? 'auth' : 'org'}/logo/${encodeURIComponent(key)}`;
  const main = preview?.main ?? url(logo.main.key);
  const compact = preview?.compact ?? (logo.compact ? url(logo.compact.key) : main);
  return (
    <span
      className="rio-org-logo"
      data-logo-colors={logo.mode}
      data-scheme={logo.mode === 'original' ? scheme : undefined}
      role="img"
      aria-label={name}
      style={
        {
          '--rio-logo-background': background,
          '--rio-logo-main': `url("${main}")`,
          '--rio-logo-compact': `url("${compact}")`,
        } as CSSProperties
      }
    >
      {logo.mode === 'original' ? (
        <picture>
          <source media="(max-width: 640px)" srcSet={compact} />
          <img src={main} alt="" />
        </picture>
      ) : (
        <span className="rio-org-logo__mask" />
      )}
    </span>
  );
}

export function AppLogo({ animate = false }: { animate?: boolean }) {
  const cache = useContext(QueryClientContext);
  // Loading screens observe identity already being read, without starting another request.
  const subscribe = (notify: () => void) => cache?.getQueryCache().subscribe(notify) ?? (() => {});
  const session = useSyncExternalStore(
    subscribe,
    () => cache?.getQueryData<SessionInfo | null>(['session']),
    () => null,
  );
  const methods = useSyncExternalStore(
    subscribe,
    () => cache?.getQueryData<SignInMethods>(['auth', 'methods']),
    () => undefined,
  );
  const publicBrand = methods?.branding;
  if (!session && publicBrand?.logo)
    return <OrganizationLogo logo={publicBrand.logo} name={publicBrand.name} publicRead />;
  return session?.org?.settings?.logo ? (
    <OrganizationLogo logo={session.org.settings.logo} name={session.org.name} />
  ) : (
    <RiosomaLogo animate={animate} size={animate ? 'large' : 'default'} />
  );
}
