import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId } from 'react';
import type { Routine, RoutineActivity, RoutineRun } from '@riosoma/contracts';
import { Button, Heading, Spinner } from '@riosoma/ui';
import { useServerMessage } from '../../messages/useServerMessage';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { Usage } from '../rio/Blocks';
import { getRoutine, routineKey, routineRuns, runsKey } from './api';
import { ApprovalCard } from './ApprovalCard';
import { RoutineMenu, RoutineStatus, useRoutineActions } from './RoutineList';
import { UndoChanges } from './UndoChanges';
import { useRoutineWords } from './words';
import './routines.css';

/**
 * A routine's own page: what it does and when, what waits for its owner, and every run with its
 * report, its changes and one-step undo, its cost, and its tokens.
 */
export function RoutineScreen({ routineId, databaseName }: { routineId: string; databaseName: string }) {
  const { t } = useLingui();
  const routine = useQuery({
    queryKey: routineKey(routineId),
    queryFn: ({ signal }) => getRoutine(routineId, signal),
  });
  const runs = useQuery({
    queryKey: runsKey(routineId),
    queryFn: ({ signal }) => routineRuns(routineId, signal),
    // A run under way is checked on until it ends.
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.state === 'queued' || run.state === 'running') ? 3_000 : false,
  });
  const name = routine.data?.name;
  useEffect(() => {
    if (name === undefined) return;
    const previous = document.title;
    const database = databaseName;
    document.title = t({ id: 'routines.pageTitle', message: `${name} – ${database}` });
    return () => {
      document.title = previous;
    };
  }, [name, databaseName, t]);
  if (routine.isPending)
    return (
      <div className="rio-routines__screen">
        <Spinner label={t({ id: 'routines.loadingOne', message: 'Loading routine' })} />
      </div>
    );
  if (!routine.data)
    return (
      <div className="rio-routines__screen">
        <ErrorBanner error={errorInfo(routine.error)} />
      </div>
    );
  return (
    <Details routine={routine.data} runs={runs.data ?? []} runsError={runs.error} loading={runs.isPending} />
  );
}

function Details({
  routine,
  runs,
  runsError,
  loading,
}: {
  routine: Routine;
  runs: RoutineRun[];
  runsError: unknown;
  loading: boolean;
}) {
  const { t } = useLingui();
  const words = useRoutineWords();
  const actions = useRoutineActions();
  const waiting = runs.flatMap((run) => run.approvals.filter((approval) => approval.status === 'pending'));
  const cap = words.money(routine.costCapUsd);
  const zone = routine.timeZone;
  const id = useId();
  return (
    <div className="rio-routines__screen">
      <header className="rio-routines__head">
        <Heading level={1}>{routine.name}</Heading>
        <div className="rio-routines__actions">
          <Button isDisabled={actions.busy || routine.paused} onPress={() => actions.runNow(routine)}>
            {t({ id: 'routines.runNow', message: 'Run now' })}
          </Button>
          <Button
            isDisabled={actions.busy || routine.adminPaused}
            onPress={() => actions.togglePause(routine)}
          >
            {routine.paused
              ? t({ id: 'routines.resume', message: 'Resume' })
              : t({ id: 'routines.pause', message: 'Pause' })}
          </Button>
          <RoutineMenu routine={routine} actions={actions} open={false} />
        </div>
      </header>
      <ErrorBanner error={actions.error} />
      <RoutineStatus routine={routine} />
      <section className="rio-routines__section" aria-labelledby={`${id}-what`}>
        <Heading level={2} id={`${id}-what`}>
          <Trans id="routines.what">What it does</Trans>
        </Heading>
        <blockquote className="rio-routines__instructions">{routine.instructions}</blockquote>
        <p>{routine.plan.summary}</p>
        <ol>
          {routine.plan.steps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
        <dl className="rio-routines__facts">
          <div>
            <dt>
              <Trans id="routines.facts.when">When</Trans>
            </dt>
            <dd>
              {words.schedule(routine.schedule)} <span className="rio-routines__note">({zone})</span>
            </dd>
          </div>
          <div>
            <dt>
              <Trans id="routines.facts.cap">Most a run may spend</Trans>
            </dt>
            <dd>{cap}</dd>
          </div>
          <div>
            <dt>
              <Trans id="routines.plan.writes">Changes, with your approval</Trans>
            </dt>
            <dd>
              {routine.plan.writes.length
                ? words.list(routine.plan.writes.map((id) => routine.tableNames[id] ?? id))
                : t({ id: 'routines.plan.none', message: 'None' })}
            </dd>
          </div>
          {routine.plan.fetches.length ? (
            <div>
              <dt>
                <Trans id="routines.plan.fetches">Reads pages from</Trans>
              </dt>
              <dd>{words.pageSources(routine.plan, routine.tableNames, routine.fieldNames)}</dd>
            </div>
          ) : null}
          {routine.plan.fetches.length ? (
            <div>
              <dt>
                <Trans id="routines.facts.sites">Sites it may read</Trans>
              </dt>
              <dd className="rio-routines__sites">
                {routine.approvedSites.length
                  ? words.list(routine.approvedSites)
                  : t({ id: 'routines.facts.sites.none', message: 'None yet' })}
              </dd>
            </div>
          ) : null}
          {routine.approvedRecipients.length ? (
            <div>
              <dt>
                <Trans id="routines.facts.approved">Emails without asking</Trans>
              </dt>
              <dd>{routine.approvedRecipients.map((list) => words.list(list)).join(' · ')}</dd>
            </div>
          ) : null}
        </dl>
      </section>
      {waiting.length ? (
        <section className="rio-routines__section" aria-labelledby={`${id}-waiting`}>
          <Heading level={2} id={`${id}-waiting`}>
            <Trans id="routines.waiting">Waiting for you</Trans>
          </Heading>
          {waiting.map((approval) => (
            <ApprovalCard key={approval.id} approval={approval} />
          ))}
        </section>
      ) : null}
      <section className="rio-routines__section" aria-labelledby={`${id}-history`}>
        <Heading level={2} id={`${id}-history`}>
          <Trans id="routines.history">Run history</Trans>
        </Heading>
        <ErrorBanner error={errorInfo(runsError)} />
        {loading ? (
          <Spinner label={t({ id: 'routines.history.loading', message: 'Loading runs' })} />
        ) : runs.length === 0 ? (
          <p className="rio-routines__note">
            <Trans id="routines.history.empty">It hasn’t run yet.</Trans>
          </p>
        ) : (
          <ol className="rio-routines__list">
            {runs.map((run) => (
              <RunItem key={run.id} run={run} timeZone={routine.timeZone} />
            ))}
          </ol>
        )}
      </section>
      {actions.dialogs}
    </div>
  );
}

function RunItem({ run, timeZone }: { run: RoutineRun; timeZone: string }) {
  const { t } = useLingui();
  const words = useRoutineWords();
  const message = useServerMessage();
  const when = words.moment(run.finishedAt ?? run.startedAt ?? run.createdAt, timeZone);
  const steps = run.steps;
  return (
    <li className="rio-routines__run" data-state={run.state}>
      <p className="rio-routines__approval-head">
        <strong>{words.runStates[run.state]}</strong>{' '}
        <span className="rio-routines__note">
          {when} · {words.triggers[run.trigger]} ·{' '}
          {t({ id: 'routines.run.steps', message: `${steps} tool calls` })}
        </span>
      </p>
      {run.messageKey ? (
        <p className="rio-routines__status" data-tone={run.state === 'failed' ? 'danger' : 'warning'}>
          {message(run.messageKey)}
        </p>
      ) : null}
      {run.activity.length ? (
        <div className="rio-routines__receipt">
          <p>
            <Trans id="routines.activity">What it did outside the database:</Trans>
          </p>
          <ul>
            {run.activity.map((item, index) => (
              <li key={index}>
                <Activity item={item} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {/* Rio's words about a run are plain text: no links or markup it read can come alive here. */}
      {run.report ? (
        <div className="rio-routines__report">
          <p className="rio-routines__note">
            <Trans id="routines.report">Rio’s report, in its own words:</Trans>
          </p>
          <p className="rio-routines__body">{run.report}</p>
        </div>
      ) : null}
      {run.receipt ? (
        <div className="rio-routines__receipt">
          <p>
            <Trans id="routines.receipt">Changed on its own:</Trans>
          </p>
          <ul>
            {run.receipt.summary
              .split('\n')
              .filter(Boolean)
              .map((line, index) => (
                <li key={index}>{line}</li>
              ))}
          </ul>
          <UndoChanges databaseId={run.receipt.databaseId} groupId={run.receipt.groupId} />
        </div>
      ) : null}
      {run.approvals
        .filter((approval) => approval.status !== 'pending')
        .map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} />
        ))}
      {run.usage ? <Usage usage={run.usage} /> : null}
    </li>
  );
}

/**
 * One email a run sent or page it fetched, as the server recorded it, addresses shown as text.  An
 * email still on its way when the run ended reads as sent or failed once it settles.
 */
function Activity({ item }: { item: RoutineActivity }) {
  const { t } = useLingui();
  const words = useRoutineWords();
  if (item.kind === 'email') {
    const recipients = words.list(item.to);
    const subject = item.subject;
    if (item.status === 'failed')
      return (
        <>{t({ id: 'routines.activity.emailFailed', message: `Couldn’t email ${recipients}: ${subject}` })}</>
      );
    if (item.status === 'sending')
      return (
        <>
          {t({
            id: 'routines.activity.emailSending',
            message: `Was still emailing ${recipients} when the run ended: ${subject}`,
          })}
        </>
      );
    return <>{t({ id: 'routines.activity.email', message: `Emailed ${recipients}: ${subject}` })}</>;
  }
  const url = item.url;
  const status = item.status;
  return (
    <>
      {status === null
        ? t({ id: 'routines.activity.fetchFailed', message: `Tried to fetch ${url}, which didn’t answer` })
        : t({ id: 'routines.activity.fetch', message: `Fetched ${url} (${status})` })}
    </>
  );
}
