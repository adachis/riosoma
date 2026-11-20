import { Trans } from '@lingui/react/macro';
import { gatewaySettingsPath } from '@riosoma/contracts';
import { Link } from '@riosoma/ui';
import { useServerMessage } from '../../messages/useServerMessage';

export function GatewayErrorMessage({
  messageKey,
  params,
  providerId,
  canManage,
}: {
  messageKey: string;
  params?: Record<string, string | number | boolean>;
  providerId?: string;
  canManage: boolean;
}) {
  const message = useServerMessage();
  const gatewayError =
    messageKey.startsWith('ai.gateway.') || /^gateway(?:-[a-z0-9-]+)?$/.test(providerId ?? '');
  return (
    <>
      {message(
        gatewayError && !canManage ? 'rio.serviceUnavailable' : messageKey,
        canManage ? params : undefined,
      )}
      {gatewayError && canManage && providerId && (
        <>
          {' '}
          <Link href={gatewaySettingsPath(providerId)}>
            <Trans id="ai.gateway.openSettings">Open gateway settings</Trans>
          </Link>
        </>
      )}
    </>
  );
}
