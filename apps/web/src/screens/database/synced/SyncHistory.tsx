import { useLingui } from '@lingui/react/macro';
import { msg } from '@lingui/core/macro';
import { useQuery } from '@tanstack/react-query';
import type { SyncHistoryPage, SyncRun } from '@riosoma/contracts';
import { Banner, Button, Spinner } from '@riosoma/ui';
import { api, ApiError } from '../../../api';
import { useServerMessage } from '../../../messages/useServerMessage';

const outcomes = {
  running: msg({ id: 'syncHistory.running', message: 'Running' }),
  succeeded: msg({ id: 'syncHistory.succeeded', message: 'Completed' }),
  held: msg({ id: 'syncHistory.held', message: 'Waiting for confirmation' }),
  failed: msg({ id: 'syncHistory.failed', message: 'Failed' }),
  canceled: msg({ id: 'syncHistory.canceled', message: 'Canceled' }),
} satisfies Record<SyncRun['outcome'], unknown>;

export function SyncHistory({
  tableId,
  cursor,
  onPage,
}: {
  tableId: string;
  cursor?: string;
  onPage(cursor?: string): void;
}) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const result = useQuery({
    queryKey: ['sync-history', tableId, cursor],
    queryFn: ({ signal }) =>
      api<SyncHistoryPage>(
        `/api/tables/${tableId}/sync-history${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        { signal },
      ),
    refetchInterval: 10_000,
  });
  if (result.isPending) return <Spinner />;
  if (result.isError)
    return (
      <Banner tone="danger">
        {message(result.error instanceof ApiError ? result.error.info.messageKey : 'errors.offline')}
      </Banner>
    );
  return (
    <div className="rio-joined-form">
      {!result.data.runs.length && (
        <p>{t({ id: 'syncHistory.empty', message: 'No sync runs in the retention period.' })}</p>
      )}
      <ol className="rio-joins-list">
        {result.data.runs.map((run) => {
          const start = i18n.date(run.startedAt, { dateStyle: 'medium', timeStyle: 'short' });
          const end = run.endedAt ? i18n.date(run.endedAt, { dateStyle: 'medium', timeStyle: 'short' }) : '';
          const stats = run.stats;
          return (
            <li className="rio-joins-suggestion" key={run.id}>
              <strong>{i18n._(outcomes[run.outcome])}</strong>
              <time dateTime={run.startedAt}>
                {t({ id: 'syncHistory.started', message: `Started ${start}` })}
              </time>
              {run.endedAt && (
                <time dateTime={run.endedAt}>{t({ id: 'syncHistory.ended', message: `Ended ${end}` })}</time>
              )}
              {stats && (
                <p>
                  {t({
                    id: 'syncHistory.counts',
                    message: `${stats.added} added, ${stats.changed} changed, ${stats.removed} removed, ${stats.unchanged} unchanged, and ${stats.overridesCleared} overrides cleared`,
                  })}
                </p>
              )}
              {run.errorKey && <p>{message(run.errorKey)}</p>}
            </li>
          );
        })}
      </ol>
      {cursor && (
        <Button onPress={() => onPage()}>{t({ id: 'syncHistory.newest', message: 'Newest runs' })}</Button>
      )}
      {result.data.next && (
        <Button onPress={() => onPage(result.data.next!)}>
          {t({ id: 'syncHistory.more', message: 'Older runs' })}
        </Button>
      )}
    </div>
  );
}
