import {
  faCircleCheck,
  faCircleXmark,
  faPause,
  faTriangleExclamation,
} from '@fortawesome/free-solid-svg-icons';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import type { OutboundSync, SyncOutRun, SyncOutRunOutcome } from '@riosoma/contracts';
import { Banner, Button, DialogBody, DialogFooter, Spinner } from '@riosoma/ui';
import { Icon, type IconDefinition } from '@riosoma/icons';
import { useServerMessage } from '../../messages/useServerMessage';
import { errorInfo } from '../../messages/errorInfo';
import { listSyncOutRuns, syncOutRunsKey } from './api';
import { useSyncOutWords } from './words';

const OUTCOME_ICONS: Record<Exclude<SyncOutRunOutcome, 'running'>, IconDefinition> = {
  succeeded: faCircleCheck,
  partial: faTriangleExclamation,
  failed: faCircleXmark,
  stopped: faPause,
  canceled: faPause,
};

function Run({ run }: { run: SyncOutRun }) {
  const { i18n } = useLingui();
  const words = useSyncOutWords();
  const message = useServerMessage();
  const started = i18n.date(run.startedAt, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <li className="rio-sync-out__run" data-outcome={run.outcome}>
      <div className="rio-sync-out__head">
        <span className="rio-sync-out__outcome">
          {run.outcome === 'running' ? (
            <Spinner size="sm" />
          ) : (
            <Icon
              icon={OUTCOME_ICONS[run.outcome]}
              className="rio-sync-out__outcome-icon"
              aria-hidden="true"
            />
          )}
          <strong>{words.outcomes[run.outcome]}</strong>
        </span>
        <span className="rio-sync-out__run-when">{started}</span>
      </div>
      <p className="rio-sync-out__run-trigger">{words.trigger(run.trigger, run.actor?.name ?? null)}</p>
      {run.stats ? <p className="rio-sync-out__run-counts">{words.counts(run.stats)}</p> : null}
      {run.error ? (
        <p className="rio-sync-out__error">{message(run.error.messageKey, run.error.params)}</p>
      ) : null}
      {run.notes.map((note, index) => (
        <p key={index} className="rio-sync-out__note">
          {message(note.messageKey, note.params)}
        </p>
      ))}
    </li>
  );
}

/** A sync's last runs, newest first: when it went, why, what it did by count, and what went wrong. */
export function SyncOutRuns({ sync, onBack }: { sync: OutboundSync; onBack(): void }) {
  const { t } = useLingui();
  const runs = useQuery({
    queryKey: syncOutRunsKey(sync.id),
    queryFn: ({ signal }) => listSyncOutRuns(sync.id, signal),
    refetchInterval: (query) => (query.state.data?.runs[0]?.outcome === 'running' ? 1500 : false),
  });
  const listed = runs.data?.runs ?? [];
  return (
    <>
      <DialogBody className="rio-sync-out">
        {runs.isError ? <RetryBanner error={runs.error} onRetry={() => void runs.refetch()} /> : null}
        {runs.isPending ? (
          <Spinner label={t({ id: 'syncOut.runs.loading', message: 'Loading history…' })} />
        ) : listed.length === 0 ? (
          <p className="rio-sync-out__empty">
            <Trans id="syncOut.runs.empty">No syncs have run yet.</Trans>
          </p>
        ) : (
          <>
            <ul className="rio-sync-out__list">
              {listed.map((run) => (
                <Run key={run.id} run={run} />
              ))}
            </ul>
            <p className="rio-sync-out__note">
              <Trans id="syncOut.runs.kept">The last 50 syncs are kept.</Trans>
            </p>
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <Button onPress={onBack}>
          <Trans id="syncOut.runs.back">Back to syncs</Trans>
        </Button>
      </DialogFooter>
    </>
  );
}

function RetryBanner({ error, onRetry }: { error: unknown; onRetry(): void }) {
  const { t } = useLingui();
  const info = errorInfo(error);
  const message = useServerMessage();
  return (
    <Banner tone="danger">
      {info ? message(info.key, info.params) : null}
      <Button size="sm" onPress={onRetry}>
        {t({ id: 'syncOut.retry', message: 'Try again' })}
      </Button>
    </Banner>
  );
}
