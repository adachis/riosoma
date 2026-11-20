import { Trans } from '@lingui/react/macro';
import { Banner } from '@riosoma/ui';
import { useServerMessage } from '../messages/shellMessage';

/** Shows a failed request as a calm, translated message, with a reference for the log when the fault is the server's. */
export function ErrorBanner({
  error,
}: {
  error: { key: string; params?: Record<string, string | number | boolean>; reference?: string } | null;
}) {
  const message = useServerMessage(error?.key);
  if (!error || error.key === 'demo.readOnly') return null;
  return (
    <Banner tone="danger">
      {message(error.key, error.params)}
      {error.reference ? (
        <>
          {' '}
          <Trans id="errors.reference">Reference: {error.reference}</Trans>
        </>
      ) : null}
    </Banner>
  );
}
