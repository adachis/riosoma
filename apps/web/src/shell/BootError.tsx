import { RiosomaLogo } from '../brand/RiosomaLogo';
import { Trans } from '@lingui/react/macro';
import { Button } from '@riosoma/ui';
import { isAssetLoadError, reloadPage } from '../asset-recovery';
import { useRouter } from '@tanstack/react-router';

/** Shown when the app can't start at all, usually because the server can't be reached. */
export function BootError({ reset, error }: { reset?: () => void; error?: unknown }) {
  const router = useRouter({ warn: false });
  const asset = isAssetLoadError(error);
  return (
    <div className="rio-page-center">
      <div className="rio-card" role="alert">
        <RiosomaLogo size="large" />
        <h1>
          {asset ? (
            <Trans id="app.load.title">This screen couldn't load</Trans>
          ) : (
            <Trans id="boot.error.title">Riosoma can't reach its server</Trans>
          )}
        </h1>
        <p>
          {asset ? (
            <Trans id="app.load.body">
              {'Check your connection, then reload to try again.  Your saved drafts are kept on this device.'}
            </Trans>
          ) : (
            <Trans id="boot.error.body">
              Check your connection. If it keeps happening, the server may be restarting or down.
            </Trans>
          )}
        </p>
        <Button
          variant="primary"
          onPress={() => {
            // Clearing the boundary alone would render the same failed loader again.
            if (asset) reloadPage();
            else if (router) void router.invalidate().then(() => reset?.());
            else if (reset) reset();
            else reloadPage();
          }}
        >
          {asset ? (
            <Trans id="app.load.reload">Reload</Trans>
          ) : (
            <Trans id="boot.error.retry">Try again</Trans>
          )}
        </Button>
      </div>
    </div>
  );
}
