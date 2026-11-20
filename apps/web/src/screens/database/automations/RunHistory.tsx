import { useLingui } from '@lingui/react/macro';
import { Icon } from '@riosoma/icons';
import {
  flattenAutomationSteps,
  type AutomationMeta,
  type AutomationRun,
  type AutomationRunsPage,
} from '@riosoma/contracts';
import { Banner, Button, Disclosure, DisclosurePanel, DisclosureTrigger, Spinner } from '@riosoma/ui';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../../api';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import { useServerMessage } from '../../../messages/useServerMessage';
import { useRelativeTime } from '../../../relative-time';
import { DiagnosePanel } from './Diagnose';
import { RUN_STATE_ICONS, RUN_STATE_LABELS, STEP_LABELS, TRIGGER_LABELS } from './labels';
import { useCelebrations } from '../../../features/celebrations/useCelebrations';

export function runsKey(automationId: string) {
  return ['automations', automationId, 'runs'] as const;
}

function duration(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
}

function Took({ value }: { value: number | null }) {
  const { t, i18n } = useLingui();
  if (value === null) return null;
  // Quick steps keep two digits, so they don't all read as none at all.
  const seconds = i18n.number(
    value,
    value < 10 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 0 },
  );
  return (
    <span className="rio-automation-run__took">
      {t({ id: 'automations.run.took', message: `Took ${seconds} s` })}
    </span>
  );
}

/** A moment to the second, as a run's summary names it on hover and its reruns name it. */
function exactTime(locale: string, at: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(at));
}

/** A run's state, what started it, when, and how long it took, on one line. */
export function RunSummary({ run }: { run: AutomationRun }) {
  const { t, i18n } = useLingui();
  const version = run.version ?? 0;
  const at = run.startedAt ?? run.trigger.at;
  const when = useRelativeTime(at);
  const exact = exactTime(i18n.locale, at);
  return (
    <span className="rio-automation-run__summary" data-state={run.state}>
      <Icon icon={RUN_STATE_ICONS[run.state]} className="rio-automation-run__icon" />
      <span className="rio-automation-run__state">{i18n._(RUN_STATE_LABELS[run.state])}</span>
      {run.test ? (
        <span className="rio-automation-run__tag">
          {run.testStepId
            ? t({ id: 'automations.run.stepTest', message: 'Single-step test' })
            : t({ id: 'automations.run.test', message: 'Test' })}
        </span>
      ) : null}
      {run.from ? (
        <span className="rio-automation-run__tag">
          {run.from.kind === 'resume'
            ? t({ id: 'automations.run.resumed', message: 'Resumed' })
            : t({ id: 'automations.run.rerun', message: 'Rerun' })}
        </span>
      ) : null}
      {run.draft ? (
        <span className="rio-automation-run__version">
          {t({ id: 'automations.run.draft', message: 'Draft' })}
        </span>
      ) : typeof run.version === 'number' ? (
        <span className="rio-automation-run__version">
          {t({ id: 'automations.run.version', message: `Version ${version}` })}
        </span>
      ) : null}
      <span className="rio-automation-run__trigger">{i18n._(TRIGGER_LABELS[run.trigger.kind])}</span>
      <time className="rio-automation-run__when" dateTime={at} title={exact}>
        {when}
      </time>
      <Took value={duration(run.startedAt, run.finishedAt)} />
    </span>
  );
}

/**
 * Each step of a run: its state, what it did, and what went wrong.  With `onResume`, a step that
 * failed offers to go on from there.
 */
export function RunSteps({
  run,
  automation,
  onResume,
  resuming = false,
}: {
  run: AutomationRun;
  automation: AutomationMeta;
  onResume?: (stepId: string) => void;
  resuming?: boolean;
}) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  // Steps are named from the configuration the run most likely ran: the draft for a test of it.
  const steps = flattenAutomationSteps(
    run.draft && automation.draft ? automation.draft.config.steps : automation.config.steps,
  );
  return (
    <ol className="rio-automation-run__steps">
      {run.steps.map((step, position) => {
        const index = steps.findIndex((item) => item.id === step.stepId);
        const configured = steps[index];
        const output = Object.entries(step.output ?? {});
        return (
          <li key={`${step.stepId}-${position}`} className="rio-automation-run__step" data-state={step.state}>
            <div className="rio-automation-run__line">
              <Icon icon={RUN_STATE_ICONS[step.state]} className="rio-automation-run__icon" />
              {configured ? (
                <span className="rio-automation-run__number" aria-hidden="true">
                  {index + 1}
                </span>
              ) : null}
              <span className="rio-automation-run__name">
                {configured
                  ? i18n._(STEP_LABELS[configured.kind])
                  : t({ id: 'automations.run.deletedStep', message: 'A step that was deleted' })}
              </span>
              <span className="rio-automation-run__state">{i18n._(RUN_STATE_LABELS[step.state])}</span>
              {step.reused ? (
                <span className="rio-automation-run__tag">
                  {t({ id: 'automations.run.reused', message: 'Kept from the earlier run' })}
                </span>
              ) : null}
              <Took value={step.ms === null ? null : step.ms / 1000} />
              {onResume && step.state === 'failed' && !step.handled ? (
                <Button
                  size="sm"
                  className="rio-automation-run__resume"
                  isPending={resuming}
                  onPress={() => onResume(step.stepId)}
                >
                  {t({ id: 'automations.run.resume', message: 'Resume from here' })}
                </Button>
              ) : null}
            </div>
            {step.path?.length ? (
              <p>
                {t({ id: 'automations.run.path', message: 'Path' })}: <code>{step.path.join(' / ')}</code>
              </p>
            ) : null}
            {step.input ? (
              <details>
                <summary>{t({ id: 'automations.run.input', message: 'Input' })}</summary>
                <pre>{JSON.stringify(step.input, null, 2)}</pre>
              </details>
            ) : null}
            {step.error ? (
              <p className="rio-automation-run__error">
                {message(step.error.messageKey)}
                {step.error.detail ? <code>{step.error.detail}</code> : null}
              </p>
            ) : null}
            {step.error?.line ? (
              <p>
                {t({
                  id: 'automations.script.errorPosition',
                  message: `Error at line ${step.error.line}, column ${step.error.column ?? 1}`,
                })}
              </p>
            ) : null}
            {step.logs?.length ? (
              <section>
                <h4>{t({ id: 'automations.script.logs', message: 'Logs' })}</h4>
                <pre>{step.logs.map((log) => `[${log.level}] ${log.text}`).join('\n')}</pre>
              </section>
            ) : null}
            {step.input ? (
              <section>
                <h4>{t({ id: 'automations.script.inputs', message: 'Inputs' })}</h4>
                <pre>{JSON.stringify(step.input, null, 2)}</pre>
              </section>
            ) : null}
            {output.length ? (
              <dl className="rio-automation-run__output">
                {output.map(([key, value]) => (
                  <div key={key}>
                    <dt>
                      {configured?.kind === 'script'
                        ? t({ id: 'automations.script.output', message: 'Output' })
                        : key === 'recipients'
                          ? t({
                              id: 'automations.notification.deliveredTo',
                              message: 'Recipients and messages',
                            })
                          : key === 'status'
                            ? t({ id: 'automations.messaging.status', message: 'Provider status' })
                            : key === 'errorCode'
                              ? t({ id: 'automations.messaging.errorCode', message: 'Provider error code' })
                              : key}
                    </dt>
                    <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * How a run came from another, with a control that opens that run, named with when it started to
 * the second, so it's clear which one it was even among runs from around the same time.
 */
function RunOrigin({
  run,
  automation,
  onOpen,
}: {
  run: AutomationRun;
  automation: AutomationMeta;
  onOpen: (runId: string) => void;
}) {
  const { t, i18n } = useLingui();
  const from = run.from;
  if (!from) return null;
  if (!from.at)
    return (
      <p className="rio-automation-run__origin">
        {from.kind === 'resume'
          ? t({
              id: 'automations.run.resumedFromGone',
              message: 'Went on from a run that’s no longer kept.',
            })
          : t({ id: 'automations.run.rerunOfGone', message: 'A rerun of a run that’s no longer kept.' })}
      </p>
    );
  const index = flattenAutomationSteps(automation.config.steps).findIndex((step) => step.id === from.stepId);
  const number = index + 1;
  const exact = exactTime(i18n.locale, from.at);
  return (
    <p className="rio-automation-run__origin">
      {from.kind === 'resume'
        ? index >= 0
          ? t({
              id: 'automations.run.resumedFrom',
              message: `Went on from step ${number} of an earlier run.`,
            })
          : t({ id: 'automations.run.resumedFromRun', message: 'Went on from an earlier run.' })
        : t({ id: 'automations.run.rerunOf', message: 'A rerun of an earlier run.' })}{' '}
      <Button
        size="sm"
        variant="quiet"
        className="rio-automation-run__source"
        onPress={() => onOpen(from.runId)}
      >
        {t({ id: 'automations.run.openSource', message: `Open the run from ${exact}` })}
      </Button>
    </p>
  );
}

/**
 * A run's steps, opened from the history.  Someone who can change the automation can run it again
 * with the same trigger, or go on from the step that failed, and hears why when it can't.
 */
function RunDetails({
  session,
  run,
  automation,
  canEdit,
  onOpen,
}: {
  session?: DatabaseSession;
  run: AutomationRun;
  automation: AutomationMeta;
  canEdit: boolean;
  onOpen: (runId: string) => void;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const client = useQueryClient();
  const again = useMutation({
    mutationFn: (input: { how: 'rerun' } | { how: 'resume'; stepId: string }) =>
      api<AutomationRun>(`/api/automations/${automation.id}/runs/${run.id}/${input.how}`, {
        method: 'POST',
        body: input.how === 'resume' ? { stepId: input.stepId } : {},
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: runsKey(automation.id) }),
  });
  const cancel = useMutation({
    mutationFn: async () => {
      await session?.run([
        { kind: 'automation.cancelRun', automationId: automation.id, runId: run.id, canceled: true },
      ]).done;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: runsKey(automation.id) }),
  });
  const actions =
    canEdit && !run.test && run.state !== 'queued' && run.state !== 'running' && run.state !== 'waiting';
  const failure = again.error instanceof ApiError ? again.error.info : again.error ? null : undefined;
  return (
    <div className="rio-automation-run__details">
      {canEdit && session && run.state === 'waiting' ? (
        <Button isPending={cancel.isPending} onPress={() => cancel.mutate()}>
          {t({ id: 'automations.run.cancel', message: 'Cancel run' })}
        </Button>
      ) : null}
      {cancel.error ? (
        <Banner tone="danger">
          {message(cancel.error instanceof ApiError ? cancel.error.info.messageKey : 'errors.internal')}
        </Banner>
      ) : null}
      <RunOrigin run={run} automation={automation} onOpen={onOpen} />
      {actions ? (
        <div className="rio-automation-run__actions">
          <Button
            size="sm"
            isPending={again.isPending && again.variables?.how === 'rerun'}
            onPress={() => again.mutate({ how: 'rerun' })}
          >
            {t({ id: 'automations.run.rerunAction', message: 'Rerun' })}
          </Button>
        </div>
      ) : null}
      <div aria-live="polite">
        {again.isSuccess ? (
          <p className="rio-automation-run__queued">
            {t({
              id: 'automations.run.queuedAgain',
              message: 'Queued a new run.  It’s at the top of the list.',
            })}
          </p>
        ) : null}
        {failure !== undefined ? (
          <Banner tone="danger">
            {failure ? message(failure.messageKey, failure.params) : message('errors.internal')}
          </Banner>
        ) : null}
      </div>
      <RunSteps
        run={run}
        automation={automation}
        {...(actions && run.state === 'failed'
          ? {
              onResume: (stepId: string) => again.mutate({ how: 'resume', stepId }),
              resuming: again.isPending && again.variables?.how === 'resume',
            }
          : {})}
      />
    </div>
  );
}

/**
 * The automation's runs, newest first, a page at a time, each opening to its steps.  Opening the
 * run another came from loads more pages until it's there, then opens it and moves to it.  People
 * who can change the automation can ask Rio to diagnose a run that failed or was skipped.
 */
export function RunHistory({
  session,
  automation,
  canEdit = false,
  canDiagnose = false,
  schema,
  save,
}: {
  session?: DatabaseSession;
  automation: AutomationMeta;
  canEdit?: boolean;
  canDiagnose?: boolean;
  schema?: SchemaState;
  /** Saves edits still waiting, before a diagnosis's fix is applied */
  save?: () => Promise<unknown>;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const runs = useInfiniteQuery({
    queryKey: runsKey(automation.id),
    queryFn: ({ pageParam, signal }) =>
      api<AutomationRunsPage>(
        `/api/automations/${automation.id}/runs${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    initialPageParam: '',
    getNextPageParam: (page) => page.next ?? undefined,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.runs.some((run) => ['queued', 'running', 'waiting'].includes(run.state)),
      )
        ? 2000
        : false,
  });
  // The screen marks an automation that never ran, so the first run here that worked is its first.
  // A run found here was set off by a record, a schedule, or someone else, so it plays no sound.  A
  // test the person runs celebrates from the screen first.
  const { observe } = useCelebrations();
  const list = useRef<HTMLOListElement>(null);
  const worked = runs.data?.pages.some((page) => page.runs.some((run) => run.state === 'succeeded'));
  useEffect(() => {
    if (worked) observe('automationFirstRun', automation.id, true, { anchor: list.current, cause: 'others' });
  }, [worked, automation.id, observe]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const run = hash.get('automation') === automation.id ? hash.get('run') : null;
    return new Set(run ? [run] : []);
  });
  const toggle = useCallback(
    (runId: string, open: boolean) => {
      const hash = new URLSearchParams(window.location.hash.slice(1));
      hash.set('automation', automation.id);
      hash.set('tab', 'runs');
      if (open) hash.set('run', runId);
      else if (hash.get('run') === runId) hash.delete('run');
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${hash}`);
      setExpanded((current) => {
        const next = new Set(current);
        if (open) next.add(runId);
        else next.delete(runId);
        return next;
      });
    },
    [automation.id],
  );
  // The run to move to once it's on the screen.
  const arriving = useRef<string | null>(null);
  useEffect(() => {
    const runId = arriving.current;
    if (!runId) return;
    const item = [...(list.current?.querySelectorAll<HTMLElement>('[data-run-id]') ?? [])].find(
      (element) => element.dataset.runId === runId,
    );
    if (!item) return;
    arriving.current = null;
    item.scrollIntoView?.({ block: 'nearest' });
    item.querySelector<HTMLElement>('.rio-disclosure__trigger')?.focus();
  });
  const { data, hasNextPage, fetchNextPage } = runs;
  const loadRun = useCallback(
    (runId: string) => {
      arriving.current = runId;
      const listed = (pages: AutomationRunsPage[] | undefined) =>
        Boolean(pages?.some((page) => page.runs.some((run) => run.id === runId)));
      void (async () => {
        let pages = data?.pages;
        let more = hasNextPage;
        while (!listed(pages) && more) {
          const next = await fetchNextPage({ cancelRefetch: false });
          if (next.isFetchNextPageError) break;
          pages = next.data?.pages;
          more = next.hasNextPage;
        }
        if (!listed(pages) && arriving.current === runId) arriving.current = null;
      })();
    },
    [data, hasNextPage, fetchNextPage],
  );
  const openRun = useCallback(
    (runId: string) => {
      toggle(runId, true);
      loadRun(runId);
    },
    [toggle, loadRun],
  );
  const linked = useRef(false);
  useEffect(() => {
    if (linked.current || !data) return;
    linked.current = true;
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const runId = hash.get('automation') === automation.id ? hash.get('run') : null;
    if (runId) loadRun(runId);
  }, [automation.id, data, loadRun]);
  if (runs.isPending) return <Spinner label={t({ id: 'automations.runs', message: 'Runs' })} />;
  if (runs.isError)
    return (
      <Banner tone="danger">
        {message(runs.error instanceof ApiError ? runs.error.info.messageKey : 'errors.internal')}
      </Banner>
    );
  const shown = runs.data.pages.flatMap((page) => page.runs);
  return (
    <div className="rio-automation-runs">
      {shown.length ? (
        <ol className="rio-automation-runs__list" ref={list}>
          {shown.map((run) => (
            <li key={run.id} data-run-id={run.id}>
              <Disclosure
                className="rio-automation-run"
                isExpanded={expanded.has(run.id)}
                onExpandedChange={(open) => toggle(run.id, open)}
              >
                <DisclosureTrigger level={3}>
                  <RunSummary run={run} />
                </DisclosureTrigger>
                <DisclosurePanel>
                  <RunDetails
                    session={session}
                    run={run}
                    automation={automation}
                    canEdit={canEdit}
                    onOpen={openRun}
                  />
                  {canDiagnose && (run.state === 'failed' || run.state === 'skipped') ? (
                    <DiagnosePanel automation={automation} run={run} schema={schema} save={save} />
                  ) : null}
                </DisclosurePanel>
              </Disclosure>
            </li>
          ))}
        </ol>
      ) : (
        <p className="rio-automation-runs__empty">
          {t({ id: 'automations.runs.empty', message: 'No runs yet.' })}
        </p>
      )}
      {runs.hasNextPage ? (
        <Button isPending={runs.isFetchingNextPage} onPress={() => void runs.fetchNextPage()}>
          {t({ id: 'automations.runs.more', message: 'Show more' })}
        </Button>
      ) : null}
    </div>
  );
}
