import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Banner, Button } from '@riosoma/ui';
import { api, ApiError } from '../../api';
import { useServerMessage } from '../../messages/useServerMessage';
import { signatureEvents, signatureStates } from './messages';
import { signatureRequestsQuery } from './requests';
import './signatures.css';

export function SignatureHistoryPanel({ tableId, recordId }: { tableId: string; recordId: string }) {
  const { t, i18n } = useLingui();
  const messageFor = useServerMessage();
  const [canceling, setCanceling] = useState<string | null>(null);
  const requests = useQuery({
    ...signatureRequestsQuery(tableId, recordId),
    refetchInterval: 15_000,
  });
  const action = useMutation({
    mutationFn: ({ id, kind, signerId }: { id: string; kind: 'remind' | 'cancel'; signerId?: string }) =>
      api(`/api/signature-requests/${id}/${kind}`, { method: 'POST', body: { signerId } }),
    onSuccess: async () => {
      setCanceling(null);
      await requests.refetch();
    },
  });
  const failure = requests.error ?? action.error;
  return (
    <div className="rio-signatures">
      {failure && (
        <Banner tone="danger">
          {failure instanceof ApiError
            ? messageFor(failure.info.messageKey, failure.info.params)
            : messageFor('errors.internal')}
        </Banner>
      )}
      {requests.data?.requests.length === 0 && (
        <p>{t({ id: 'signatures.history.empty', message: 'No signature requests for this record.' })}</p>
      )}
      {requests.data?.requests.map((request) => (
        <article className="rio-signatures__history" key={request.id}>
          <h3>{request.name}</h3>
          <p>{i18n._(signatureStates[request.status])}</p>
          <p>
            {t({
              id: 'signatures.history.expires',
              message: `Expires ${new Date(request.expiresAt).toLocaleString(i18n.locale)}`,
            })}
          </p>
          <ul>
            {request.signers.map((signer) => (
              <li key={signer.id}>
                <p>
                  {signer.name} ({signer.email})
                </p>
                <p>{i18n._(signatureStates[signer.status])}</p>
                {signer.reason && <p>{signer.reason}</p>}
                {request.canManage &&
                  request.status === 'open' &&
                  signer.status === 'pending' &&
                  signer.invitedAt && (
                    <Button
                      isDisabled={
                        action.isPending ||
                        Boolean(
                          signer.lastReminder && Date.now() - Date.parse(signer.lastReminder) < 86_400_000,
                        )
                      }
                      onPress={() => action.mutate({ id: request.id, kind: 'remind', signerId: signer.id })}
                    >
                      {t({ id: 'signatures.history.remind', message: 'Send reminder' })}
                    </Button>
                  )}
              </li>
            ))}
          </ul>
          {request.canManage && request.status === 'open' && (
            <>
              <Button onPress={() => setCanceling(request.id)}>
                {t({ id: 'signatures.history.cancel', message: 'Cancel request' })}
              </Button>
              {canceling === request.id && (
                <div>
                  <p>
                    {t({
                      id: 'signatures.history.cancelWarning',
                      message: 'Cancel this request and void every signing link?',
                    })}
                  </p>
                  <Button
                    isPending={action.isPending}
                    onPress={() => action.mutate({ id: request.id, kind: 'cancel' })}
                  >
                    {t({ id: 'signatures.history.confirmCancel', message: 'Confirm cancellation' })}
                  </Button>
                  <Button variant="quiet" onPress={() => setCanceling(null)}>
                    {t({ id: 'signatures.history.keep', message: 'Keep request open' })}
                  </Button>
                </div>
              )}
            </>
          )}
          <details>
            <summary>
              {t({ id: 'signatures.history.events', message: 'Request history and document hashes' })}
            </summary>
            <p className="rio-signatures__hash">
              {t({
                id: 'signatures.history.originalHash',
                message: `Original SHA-256: ${request.originalHash}`,
              })}
            </p>
            {request.finalHash && (
              <p className="rio-signatures__hash">
                {t({
                  id: 'signatures.history.finalHash',
                  message: `Complete signed PDF SHA-256: ${request.finalHash}`,
                })}
              </p>
            )}
            <ol>
              {request.history.map((event, index) => (
                <li key={index}>
                  {i18n._(signatureEvents[event.action])}{' '}
                  {request.signers.find((signer) => signer.id === event.signerId)?.name}
                  <time dateTime={event.at}> {new Date(event.at).toLocaleString(i18n.locale)}</time>
                  {event.reason && <p>{event.reason}</p>}
                </li>
              ))}
            </ol>
          </details>
        </article>
      ))}
    </div>
  );
}
