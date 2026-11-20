import { flattenAutomationSteps } from '@riosoma/contracts';
import { faBackwardStep, faForwardStep, faPlay, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import type {
  AutomationConfig,
  AutomationMeta,
  AutomationSimulate,
  AutomationSimulation,
  SimulatedSend,
  SimulatedStep,
  SimulatedWrite,
} from '@riosoma/contracts';
import { Banner, Button, TextArea } from '@riosoma/ui';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../../../api';
import type { SchemaState } from '../../../data/types';
import { useServerMessage } from '../../../messages/useServerMessage';
import { STEP_LABELS } from './labels';
import { triggerTableId } from './model';

/**
 * Simulate: the whole automation walked against a record, one card at a time or to the end, with
 * each card's values shown beside it and the line between cards lighting as the walk passes.
 * The server works it all out at once and nothing is sent or saved, so stepping only reveals what
 * it found, in order.
 */

/** How long each card waits for the one before it when running to the end, in milliseconds */
export const REVEAL_MS = 250;

/** JSON with object keys in order, so the same configuration always reads the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Where a card stands in a simulation: reached, stopped there, failed there, or never reached. */
export type SimulatedState = 'waiting' | 'done' | 'stopped' | 'failed' | 'skipped';

export interface SimulationView {
  result: AutomationSimulation;
  /** How many cards have been revealed, the trigger first */
  shown: number;
}

/** The cards in order, the trigger first, and how many of them the walk reached. */
export function simulationNodes(_config: AutomationConfig, result: AutomationSimulation) {
  const nodes = [
    'trigger',
    ...(result.conditions ? ['conditions'] : []),
    ...result.steps.map((step) => step.executionId ?? step.stepId),
  ];
  let reached = nodes.length;
  if (result.skippedBecause === 'record') reached = 1;
  else if (result.skippedBecause === 'conditions') reached = result.conditions ? 2 : 1;
  else if (result.state === 'failed') {
    const failed = result.steps.findLastIndex((step) => step.state === 'failed' && !step.handled);
    if (failed >= 0)
      reached = nodes.indexOf(result.steps[failed]!.executionId ?? result.steps[failed]!.stepId) + 1;
  }
  return { nodes, reached };
}

/** A card's state in the walk so far. */
export function nodeState(view: SimulationView, config: AutomationConfig, node: string): SimulatedState {
  const { nodes, reached } = simulationNodes(config, view.result);
  const matches = (id: string) => id === node || id.endsWith(`/${node}`);
  const visited = nodes.slice(0, view.shown).findLastIndex(matches);
  const index = visited >= 0 ? visited : nodes.findIndex(matches);
  if (index < 0) return 'waiting';
  if (index >= view.shown) return index >= reached && view.shown >= reached ? 'skipped' : 'waiting';
  if (node === 'trigger') return view.result.skippedBecause === 'record' ? 'stopped' : 'done';
  if (node === 'conditions') return view.result.conditions?.matched ? 'done' : 'stopped';
  const step = view.result.steps.find((item) => (item.executionId ?? item.stepId) === nodes[index]);
  return step?.state === 'failed' ? 'failed' : step?.state === 'skipped' ? 'skipped' : 'done';
}

export function useSimulation(
  automation: AutomationMeta,
  config: AutomationConfig,
  save: () => Promise<unknown>,
) {
  const [result, setResult] = useState<{ value: AutomationSimulation; config: string } | null>(null);
  const [shown, setShown] = useState(0);
  const [target, setTarget] = useState(0);
  const generation = useRef(0);
  const current = canonical(config);
  const fresh = result && result.config === current ? result.value : null;
  const reached = fresh ? simulationNodes(config, fresh).reached : 0;
  const simulate = useMutation({
    mutationFn: async (body: AutomationSimulate) => {
      await save();
      return api<AutomationSimulation>(`/api/automations/${automation.id}/simulate`, {
        method: 'POST',
        body,
      });
    },
  });
  // Running to the end lights one card at a time, unless the person would rather nothing moved.
  useEffect(() => {
    if (shown >= target) return;
    const still =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const timer = setTimeout(
      () => setShown((count) => (still ? target : count + 1)),
      shown === 0 || target - shown === 1 ? 0 : REVEAL_MS,
    );
    return () => clearTimeout(timer);
  }, [shown, target]);
  const start = async (body: AutomationSimulate, to: 'next' | 'end') => {
    let value = fresh;
    let nodes = reached;
    if (!value) {
      const started = generation.current;
      try {
        value = await simulate.mutateAsync(body);
      } catch {
        return;
      }
      // A changed sample or a closed panel makes the earlier request obsolete.
      if (started !== generation.current) return;
      setResult({ value, config: current });
      setShown(0);
      nodes = simulationNodes(config, value).reached;
      setTarget(to === 'next' ? 1 : nodes);
      return;
    }
    setTarget((count) => (to === 'next' ? Math.min(Math.max(count, shown) + 1, nodes) : nodes));
  };
  return {
    view: fresh ? { result: fresh, shown } : null,
    /** A simulation of a configuration that has changed since */
    stale: Boolean(result) && !fresh,
    finished: Boolean(fresh) && shown >= reached,
    pending: simulate.isPending,
    error: simulate.error,
    step: (body: AutomationSimulate) => start(body, 'next'),
    runToEnd: (body: AutomationSimulate) => start(body, 'end'),
    reset: () => {
      generation.current += 1;
      setResult(null);
      setShown(0);
      setTarget(0);
      simulate.reset();
    },
  };
}

export type Simulator = ReturnType<typeof useSimulation>;

/** The panel over the canvas: what to simulate with, the buttons, and where the walk has got to. */
export function SimulatorPanel({
  schema,
  config,
  simulator,
  recordPicker,
  onClose,
}: {
  schema: SchemaState;
  config: AutomationConfig;
  simulator: Simulator;
  /** The record picker for record triggers, with the chosen record */
  recordPicker: { element: ReactNode; recordId: string | null } | null;
  onClose(): void;
}) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const titleId = useId();
  const [body, setBody] = useState('');
  const webhook = config.trigger.kind === 'webhook';
  let parsed: { ok: true; value: unknown } | { ok: false } = { ok: true, value: undefined };
  if (webhook && body.trim()) {
    try {
      parsed = { ok: true, value: JSON.parse(body) as unknown };
    } catch {
      parsed = { ok: false };
    }
  }
  const input: AutomationSimulate = {
    ...(recordPicker?.recordId ? { recordId: recordPicker.recordId } : {}),
    ...(parsed.ok && parsed.value !== undefined ? { body: parsed.value } : {}),
  };
  const view = simulator.view;
  const status = view ? statusText(view, config) : null;
  const owner = view?.result.access.ownerId
    ? schema.collaborators.get(view.result.access.ownerId)?.name
    : undefined;
  const ownerName = owner ?? t({ id: 'automations.simulate.owner', message: 'the person it acts as' });
  function statusText(current: SimulationView, flow: AutomationConfig): string {
    const { nodes, reached } = simulationNodes(flow, current.result);
    if (current.shown === 0)
      return t({ id: 'automations.simulate.starting', message: 'Starting the simulation.' });
    const node = nodes[current.shown - 1]!;
    const finished = current.shown >= reached;
    if (node === 'trigger') {
      if (current.result.skippedBecause === 'record')
        return t({
          id: 'automations.simulate.noRecord',
          message: 'You can’t read the trigger’s record, so no steps run.',
        });
      return t({ id: 'automations.simulate.atTrigger', message: 'The trigger starts the automation.' });
    }
    if (node === 'conditions')
      return current.result.conditions?.matched
        ? t({
            id: 'automations.simulate.conditionsMet',
            message: 'The record meets the conditions, so the steps run.',
          })
        : t({
            id: 'automations.simulate.conditionsUnmet',
            message: 'The record doesn’t meet the conditions, so no steps run.',
          });
    const index = flattenAutomationSteps(flow.steps).findIndex(
      (item) => item.id === node || node.endsWith(`/${item.id}`),
    );
    const step = current.result.steps.find(
      (item) => (item.executionId ?? item.stepId) === node || item.stepId === node,
    );
    const number = index + 1;
    const configured = flattenAutomationSteps(flow.steps)[index];
    const name = configured ? i18n._(STEP_LABELS[configured.kind]) : '';
    if (step?.state === 'failed') {
      const reason = message(step.error?.messageKey ?? 'errors.internal');
      if (step.handled)
        return t({
          id: 'automations.simulate.handled',
          message: `Step ${number}, ${name}, would continue through its error connection: ${reason}`,
        });
      return t({
        id: 'automations.simulate.stopped',
        message: `Stopped at step ${number}, ${name}: ${reason}`,
      });
    }
    if (finished)
      return t({
        id: 'automations.simulate.finished',
        message: 'Every step ran.  Nothing was sent or saved.',
      });
    return t({ id: 'automations.simulate.atStep', message: `Step ${number}, ${name}, would work.` });
  }
  const error = simulator.error;
  return (
    <section className="rio-automation-test rio-automation-simulator" aria-labelledby={titleId}>
      <div className="rio-automation-simulator__header">
        <h3 id={titleId} className="rio-automation-test__title">
          {t({ id: 'automations.simulate', message: 'Simulate' })}
        </h3>
        <Button
          variant="quiet"
          size="sm"
          icon={faXmark}
          aria-label={t({ id: 'automations.simulate.close', message: 'Close the simulation' })}
          onPress={onClose}
        />
      </div>
      <p className="rio-automation-simulator__note">
        {t({
          id: 'automations.simulate.help',
          message:
            'Walks every step without sending or saving anything.  Record changes are worked out and shown, and messages, emails, and requests show what they would send.',
        })}
      </p>
      <div className="rio-automation-simulator__input">
        {recordPicker?.element}
        {webhook ? (
          <TextArea
            label={t({ id: 'automations.simulate.body', message: 'Sample body (JSON)' })}
            description={t({
              id: 'automations.simulate.bodyHelp',
              message: 'Leave it empty to use the last call the webhook received.',
            })}
            value={body}
            onChange={(value) => {
              setBody(value);
              simulator.reset();
            }}
            rows={4}
            isInvalid={!parsed.ok}
            errorMessage={t({ id: 'automations.simulate.bodyInvalid', message: 'This isn’t valid JSON.' })}
            validationBehavior="aria"
          />
        ) : null}
        {!recordPicker && !webhook ? (
          <p className="rio-automation-simulator__note">
            {t({
              id: 'automations.simulate.noInput',
              message: 'A schedule starts without a record, so there’s nothing to choose.',
            })}
          </p>
        ) : null}
      </div>
      <div className="rio-automation-simulator__actions">
        <Button
          icon={faForwardStep}
          isPending={simulator.pending}
          isDisabled={!parsed.ok || (simulator.finished && !simulator.stale)}
          onPress={() => void simulator.step(input)}
        >
          {t({ id: 'automations.simulate.step', message: 'Step' })}
        </Button>
        <Button
          icon={faPlay}
          isDisabled={!parsed.ok || simulator.pending || (simulator.finished && !simulator.stale)}
          onPress={() => void simulator.runToEnd(input)}
        >
          {t({ id: 'automations.simulate.run', message: 'Run to the end' })}
        </Button>
        <Button
          variant="quiet"
          icon={faBackwardStep}
          isDisabled={!view && !simulator.stale}
          onPress={simulator.reset}
        >
          {t({ id: 'automations.simulate.reset', message: 'Start over' })}
        </Button>
      </div>
      {error ? (
        <Banner tone="danger">
          {message(error instanceof ApiError ? error.info.messageKey : 'errors.internal')}
        </Banner>
      ) : null}
      {simulator.stale ? (
        <Banner tone="info">
          {t({
            id: 'automations.simulate.stale',
            message: 'The automation changed since this simulation.  Start over to simulate it again.',
          })}
        </Banner>
      ) : null}
      {view?.result.access.differs ? (
        <Banner tone="warning">
          {t({
            id: 'automations.simulate.access',
            message: `This simulation reads and changes records with your access.  A real run uses the access of ${ownerName}, which reads differently, so its values may differ.`,
          })}
        </Banner>
      ) : null}
      <p className="rio-automation-simulator__status" role="status" aria-live="polite">
        {status}
      </p>
    </section>
  );
}

function FieldName({ schema, fieldId }: { schema: SchemaState; fieldId: string }) {
  return <>{schema.fieldById.get(fieldId)?.name ?? fieldId}</>;
}

function Empty() {
  const { t } = useLingui();
  return (
    <span className="rio-automation-port__empty">
      {t({ id: 'automations.simulate.empty', message: 'Empty' })}
    </span>
  );
}

/** Values shown in a port, one per line. */
function Values({ entries }: { entries: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="rio-automation-run__output">
      {entries.map(([name, value], index) => (
        <div key={index}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Port({ label, state, children }: { label: string; state: SimulatedState; children: ReactNode }) {
  return (
    <section className="rio-automation-port" aria-label={label} data-sim={state}>
      {children}
    </section>
  );
}

/** What the trigger hands the steps: its record's values, or the webhook's body. */
export function TriggerPort({
  view,
  schema,
  config,
}: {
  view: SimulationView;
  schema: SchemaState;
  config: AutomationConfig;
}) {
  const { t } = useLingui();
  const trigger = view.result.trigger;
  const tableId = triggerTableId(config.trigger, schema);
  const fields = tableId ? (schema.fields.get(tableId) ?? []) : [];
  const entries: Array<[ReactNode, ReactNode]> = fields
    .filter((field) => Object.hasOwn(trigger.values, field.id))
    .map((field) => [field.name, trigger.values[field.id] ?? <Empty />]);
  return (
    <Port
      label={t({ id: 'automations.simulate.triggerPort', message: 'What the trigger passes on' })}
      state="done"
    >
      {entries.length ? <Values entries={entries} /> : null}
      {trigger.kind === 'webhook' ? <pre>{JSON.stringify(trigger.body, null, 2)}</pre> : null}
    </Port>
  );
}

/** Which conditions the record meets, and so which way the automation goes. */
export function ConditionsPort({ view }: { view: SimulationView }) {
  const { t } = useLingui();
  const conditions = view.result.conditions;
  if (!conditions) return null;
  return (
    <Port
      label={t({ id: 'automations.simulate.branch', message: 'Branch taken' })}
      state={conditions.matched ? 'done' : 'stopped'}
    >
      <p className="rio-automation-port__branch">
        {conditions.matched
          ? t({ id: 'automations.simulate.branch.continue', message: 'Continues to the steps' })
          : t({ id: 'automations.simulate.branch.stop', message: 'Stops here' })}
      </p>
      <ol className="rio-automation-port__parts">
        {conditions.parts.map((met, index) => {
          const position = index + 1;
          return (
            <li key={index} data-met={met || undefined} data-hidden={met === null || undefined}>
              {met === null
                ? t({
                    id: 'automations.simulate.condition.hidden',
                    message: `Condition ${position} is hidden from you`,
                  })
                : met
                  ? t({ id: 'automations.simulate.condition.met', message: `Condition ${position} is met` })
                  : t({
                      id: 'automations.simulate.condition.unmet',
                      message: `Condition ${position} isn’t met`,
                    })}
            </li>
          );
        })}
      </ol>
    </Port>
  );
}

function Write({ write, schema }: { write: SimulatedWrite; schema: SchemaState }) {
  const { t } = useLingui();
  const table = schema.tableById.get(write.tableId)?.name ?? write.tableId;
  return (
    <div className="rio-automation-port__write">
      <h5>
        {write.created
          ? t({ id: 'automations.simulate.wouldCreate', message: `Would add a record to ${table}` })
          : t({ id: 'automations.simulate.wouldUpdate', message: `Would change a record in ${table}` })}
      </h5>
      {write.changes.length ? (
        <table className="rio-automation-port__diff">
          <thead>
            <tr>
              <th scope="col">{t({ id: 'automations.simulate.field', message: 'Field' })}</th>
              <th scope="col">{t({ id: 'automations.simulate.before', message: 'Before' })}</th>
              <th scope="col">{t({ id: 'automations.simulate.after', message: 'After' })}</th>
            </tr>
          </thead>
          <tbody>
            {write.changes.map((change) => (
              <tr key={change.fieldId}>
                <th scope="row">
                  <FieldName schema={schema} fieldId={change.fieldId} />
                </th>
                <td data-before>{change.before ?? <Empty />}</td>
                <td data-after>{change.after ?? <Empty />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>{t({ id: 'automations.simulate.noChanges', message: 'Nothing would change.' })}</p>
      )}
    </div>
  );
}

function Send({ send }: { send: SimulatedSend }) {
  const { t } = useLingui();
  const heading =
    send.kind === 'notification'
      ? t({ id: 'automations.simulate.wouldNotify', message: 'Would send these notifications' })
      : send.kind === 'email'
        ? t({ id: 'automations.simulate.wouldEmail', message: 'Would send this email' })
        : send.kind === 'message'
          ? t({ id: 'automations.simulate.wouldMessage', message: 'Would send this message' })
          : t({ id: 'automations.simulate.wouldRequest', message: 'Would send this request' });
  return (
    <div className="rio-automation-port__send">
      <h5>{heading}</h5>
      {send.kind === 'notification' ? (
        <pre>{JSON.stringify(send.recipients, null, 2)}</pre>
      ) : send.kind === 'email' ? (
        <Values
          entries={[
            [t({ id: 'automations.step.to', message: 'To' }), send.to.join(', ')],
            [t({ id: 'automations.step.subject', message: 'Subject' }), send.subject],
            [t({ id: 'automations.step.body', message: 'Message' }), <pre key="text">{send.text}</pre>],
          ]}
        />
      ) : send.kind === 'message' ? (
        <Values
          entries={[
            ...(send.to
              ? ([[t({ id: 'automations.step.to', message: 'To' }), send.to]] as Array<
                  [ReactNode, ReactNode]
                >)
              : []),
            ...(send.title
              ? [
                  [t({ id: 'automations.studioFlow.title', message: 'Title (optional)' }), send.title] as [
                    ReactNode,
                    ReactNode,
                  ],
                ]
              : []),
            ...(send.recordUrl
              ? [
                  [t({ id: 'automations.studioFlow.recordUrl', message: 'Record link' }), send.recordUrl] as [
                    ReactNode,
                    ReactNode,
                  ],
                ]
              : []),
            [t({ id: 'automations.step.body', message: 'Message' }), <pre key="text">{send.text}</pre>],
          ]}
        />
      ) : (
        <>
          <p>
            <code>
              {send.method} {send.url}
            </code>
          </p>
          {Object.keys(send.headers).length ? (
            <pre>
              {Object.entries(send.headers)
                .map(([name, value]) => `${name}: ${value}`)
                .join('\n')}
            </pre>
          ) : null}
          {send.body ? <pre>{send.body}</pre> : null}
        </>
      )}
    </div>
  );
}

/** What a step took in and what came of it: the change it would make, or what it would send. */
export function StepPort({
  step,
  schema,
  state,
}: {
  step: SimulatedStep;
  schema: SchemaState;
  state: SimulatedState;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  return (
    <Port label={t({ id: 'automations.simulate.stepPort', message: 'Simulated values' })} state={state}>
      {step.input ? (
        <section>
          <h4>{t({ id: 'automations.simulate.in', message: 'In' })}</h4>
          <pre>{JSON.stringify(step.input, null, 2)}</pre>
        </section>
      ) : null}
      {step.writes.length || step.sends.length || step.output || step.logs?.length ? (
        <section>
          <h4>{t({ id: 'automations.simulate.out', message: 'Out' })}</h4>
          {step.writes.map((write, index) => (
            <Write key={index} write={write} schema={schema} />
          ))}
          {step.sends.map((send, index) => (
            <Send key={index} send={send} />
          ))}
          {step.logs?.length ? (
            <pre>{step.logs.map((log) => `[${log.level}] ${log.text}`).join('\n')}</pre>
          ) : null}
          {step.output && !step.writes.length ? <pre>{JSON.stringify(step.output, null, 2)}</pre> : null}
          {step.sends.length ? (
            <p className="rio-automation-simulator__note">
              {t({
                id: 'automations.simulate.standIn',
                message: 'Later steps see a stand-in answer, since nothing was sent.',
              })}
            </p>
          ) : null}
        </section>
      ) : null}
      {step.error ? (
        <p className="rio-automation-run__error" role="alert">
          {message(step.error.messageKey)}
          {step.error.detail ? <code>{step.error.detail}</code> : null}
        </p>
      ) : null}
    </Port>
  );
}
