import { useLingui } from '@lingui/react/macro';
import { Button, Spinner } from '@riosoma/ui';
import { SERVER_MESSAGES } from '../../../messages/server';
import { serverMessage } from '../../../messages/useServerMessage';

/** Keys the server words itself.  One this version doesn't know yet reads as a plain failure. */
export function blockMessageKey(key: string): string {
  if (SERVER_MESSAGES[key]) return key;
  return key.startsWith('interfaces.') || key.startsWith('dashboards.') ? 'interfaces.block.failed' : key;
}

/** A block waiting for its data, or saying why it has none, with a way to try again. */
export function BlockStatus({
  error,
  onRetry,
}: {
  error?: { messageKey: string; params?: Record<string, string | number | boolean> };
  onRetry?: () => void;
}) {
  const { t, i18n } = useLingui();
  if (!error)
    return (
      <div className="rio-interface-status">
        <Spinner size="sm" />
      </div>
    );
  return (
    <div className="rio-interface-status">
      <p>{serverMessage(i18n, blockMessageKey(error.messageKey), error.params)}</p>
      {onRetry ? (
        <Button size="sm" onPress={onRetry}>
          {t({ id: 'interfaces.block.retry', message: 'Try again' })}
        </Button>
      ) : null}
    </div>
  );
}

/** A block over a table, view, or field that's gone or hidden from this person. */
export function BlockUnavailable() {
  const { i18n } = useLingui();
  return (
    <div className="rio-interface-status">
      <p>{serverMessage(i18n, 'interfaces.block.unavailable')}</p>
    </div>
  );
}
