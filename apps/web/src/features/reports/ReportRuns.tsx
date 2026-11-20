import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { ReportDelivery, ReportRun, ReportSchedule } from '@riosoma/contracts';
import { Button, DialogBody, DialogFooter, Spinner } from '@riosoma/ui';
import { useServerMessage } from '../../messages/useServerMessage';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { listReportRuns, reportRunsKey } from './api';
import { useReportWords } from './words';

function Delivery({ delivery }: { delivery: ReportDelivery }) {
  const { t } = useLingui();
  const words = useReportWords();
  const message = useServerMessage();
  const who = delivery.recipient.kind === 'member' ? delivery.recipient.name : delivery.recipient.address;
  const count = delivery.records ?? 0;
  const attachment =
    delivery.attachment === 'attached'
      ? t({ id: 'reports.runs.attached', message: 'with the file' })
      : delivery.attachment === 'linked'
        ? t({ id: 'reports.runs.linked', message: 'with a link, as the file was too large' })
        : null;
  return (
    <li className="rio-report-schedules__delivery" data-state={delivery.state}>
      <span className="rio-report-schedules__who-name">{who}</span>
      <span>{words.deliveryStates[delivery.state]}</span>
      {delivery.state === 'sent' ? (
        <span>
          {t({ id: 'reports.runs.records', message: plural(count, { one: '# record', other: '# records' }) })}
          {attachment ? `, ${attachment}` : null}
        </span>
      ) : null}
      {delivery.error ? (
        <span className="rio-report-schedules__error">
          {message(delivery.error.messageKey)}
          {delivery.error.code ? ` (${delivery.error.code})` : null}
        </span>
      ) : null}
      {delivery.notes?.map((key) => (
        <span key={key}>{message(key)}</span>
      ))}
    </li>
  );
}

function Run({ run, timeZone }: { run: ReportRun; timeZone: string }) {
  const { t } = useLingui();
  const words = useReportWords();
  const message = useServerMessage();
  const when = words.moment(run.finishedAt ?? run.startedAt ?? run.dueAt, timeZone);
  const retry = run.retryAt ? words.moment(run.retryAt, timeZone) : null;
  const tries = run.attempts;
  return (
    <li className="rio-report-schedules__run" data-state={run.state}>
      <div className="rio-report-schedules__head">
        <strong>{when}</strong>
        <span>
          {run.trigger === 'manual'
            ? t({ id: 'reports.runs.manual', message: 'Sent now' })
            : t({ id: 'reports.runs.scheduled', message: 'On schedule' })}
        </span>
      </div>
      <p className="rio-report-schedules__status" data-tone={run.state === 'failed' ? 'danger' : undefined}>
        {words.runStates[run.state]}
        {tries > 1 ? ` · ${t({ id: 'reports.runs.tries', message: `${tries} tries` })}` : null}
        {retry ? ` · ${t({ id: 'reports.runs.retry', message: `Next try ${retry}` })}` : null}
      </p>
      {run.error ? <p className="rio-report-schedules__error">{message(run.error.messageKey)}</p> : null}
      {run.deliveries.length ? (
        <ul className="rio-report-schedules__deliveries">
          {run.deliveries.map((delivery, index) => (
            <Delivery key={index} delivery={delivery} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** A report's runs, newest first: when, to whom, how many records, and what went wrong. */
export function ReportRuns({ report, onBack }: { report: ReportSchedule; onBack(): void }) {
  const { t } = useLingui();
  const runs = useInfiniteQuery({
    queryKey: reportRunsKey(report.id),
    queryFn: ({ pageParam, signal }) => listReportRuns(report.id, pageParam ?? undefined, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next,
  });
  const listed = runs.data?.pages.flatMap((page) => page.runs) ?? [];
  const name = report.name;
  return (
    <>
      <DialogBody className="rio-report-schedules">
        <p className="rio-report-schedules__intro">
          {t({ id: 'reports.runs.intro', message: `Every time ${name} went, or tried to.` })}
        </p>
        <ErrorBanner error={errorInfo(runs.error)} />
        {runs.isPending ? (
          <Spinner label={t({ id: 'reports.runs.loading', message: 'Loading the history' })} />
        ) : listed.length === 0 ? (
          <p>
            <Trans id="reports.runs.empty">It hasn’t gone out yet.</Trans>
          </p>
        ) : (
          <ul className="rio-report-schedules__list">
            {listed.map((run) => (
              <Run key={run.id} run={run} timeZone={report.timeZone} />
            ))}
          </ul>
        )}
        {runs.hasNextPage ? (
          <div>
            <Button size="sm" isPending={runs.isFetchingNextPage} onPress={() => void runs.fetchNextPage()}>
              <Trans id="reports.runs.more">Show older</Trans>
            </Button>
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        <Button onPress={onBack}>
          <Trans id="reports.back">Back to reports</Trans>
        </Button>
      </DialogFooter>
    </>
  );
}
