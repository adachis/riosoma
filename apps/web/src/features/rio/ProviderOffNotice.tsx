import { Trans } from '@lingui/react/macro';
import { Link } from '@riosoma/ui';

/** Shared by places where Rio is off because the organization hasn't allowed a provider. */
export function ProviderOffNotice() {
  return (
    <>
      <Trans id="rio.off.noProvider">Rio is off because no provider is turned on.</Trans>{' '}
      <Link href="/settings/ai#providers">
        <Trans id="rio.off.providers">Review providers in AI settings</Trans>
      </Link>
    </>
  );
}
