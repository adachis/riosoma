import { useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RemoteApproval as Approval } from '@riosoma/contracts';
import { Button, Link, Spinner } from '@riosoma/ui';
import { api, ApiError } from '../../api';
import { useServerMessage } from '../../messages/useServerMessage';
import '../ai/RemoteTools.css';

export function RemoteApproval({ id, disabled }: { id: string; disabled: boolean }) {
  const message = useServerMessage();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = ['remote-approval', id];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api<Approval>(`/api/rio/remote-approvals/${id}`),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'pending' || status === 'running' ? 2000 : false;
    },
  });
  async function decide(approve: boolean) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/rio/remote-approvals/${id}`, {
        method: 'POST',
        body: { approve, commandId: crypto.randomUUID() },
      });
      await client.invalidateQueries({ queryKey: key });
    } catch (cause) {
      setError(message(cause instanceof ApiError ? cause.info.messageKey : 'errors.internal'));
    } finally {
      setBusy(false);
    }
  }
  if (query.isPending) return <Spinner />;
  if (query.error)
    return (
      <p role="alert">
        {message(query.error instanceof ApiError ? query.error.info.messageKey : 'errors.internal')}
      </p>
    );
  const approval = query.data;
  let resultMessage: string | undefined;
  if (approval.result) {
    try {
      const outcome = JSON.parse(approval.result) as { messageKey?: string };
      if (typeof outcome.messageKey === 'string') resultMessage = message(outcome.messageKey);
    } catch {
      /* Outside results remain plain text */
    }
  }
  return (
    <section className="rio-remote-approval">
      <Link href={`/#remote-approval=${id}`}>
        <Trans id="remote.approvalLink">Link to this approval</Trans>
      </Link>
      <h3>
        {approval.server} · {approval.tool}
      </h3>
      {approval.status === 'pending' && (
        <p>
          <Trans id="remote.approvalHint">
            {'Review the arguments before this tool runs.  Outside changes cannot be undone here.'}
          </Trans>
        </p>
      )}
      <pre tabIndex={0}>{JSON.stringify(approval.arguments, null, 2)}</pre>
      {approval.status === 'pending' ? (
        <div className="rio-remote-tools__actions">
          <Button isDisabled={disabled || busy} onPress={() => void decide(true)}>
            <Trans id="remote.approve">Approve this call</Trans>
          </Button>
          <Button isDisabled={disabled || busy} onPress={() => void decide(false)}>
            <Trans id="remote.deny">Deny</Trans>
          </Button>
        </div>
      ) : (
        <p role="status">
          {approval.status === 'succeeded' ? (
            <Trans id="remote.succeeded">Finished</Trans>
          ) : approval.status === 'denied' ? (
            <Trans id="remote.denied">Denied</Trans>
          ) : approval.status === 'running' ? (
            <Trans id="remote.running">Running</Trans>
          ) : (
            <Trans id="remote.failed">The tool call failed.</Trans>
          )}
        </p>
      )}
      {resultMessage ? (
        <p role="alert">{resultMessage}</p>
      ) : approval.result ? (
        <pre tabIndex={0}>{approval.result}</pre>
      ) : null}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
