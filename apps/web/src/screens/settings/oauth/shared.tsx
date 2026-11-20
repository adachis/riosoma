import { faCubes, faDatabase, faLink } from '@fortawesome/free-solid-svg-icons';
import { Icon } from '@riosoma/icons';
import type { OAuthApp } from '@riosoma/contracts';
import { Trans } from '@lingui/react/macro';

export function OAuthAppIdentity({ app }: { app: OAuthApp }) {
  return (
    <div className="rio-oauth__identity">
      <Icon icon={{ app: faCubes, link: faLink, database: faDatabase }[app.icon]} />
      <strong>{app.name}</strong>
      <span>
        {app.verified ? (
          <Trans id="oauth.verified">Registered by an administrator</Trans>
        ) : (
          <Trans id="oauth.unverified">Unverified app</Trans>
        )}
      </span>
      {app.homepage && (
        <a href={app.homepage} target="_blank" rel="noopener noreferrer">
          <Trans id="oauth.homepage.open">App homepage</Trans>
        </a>
      )}
    </div>
  );
}
