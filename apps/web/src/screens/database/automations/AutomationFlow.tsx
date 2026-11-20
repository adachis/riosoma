import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import {
  automationPaths,
  automationConnections,
  automationOutputPorts,
  connectionLoopBody,
  type AutomationEndpoint,
  flattenAutomationSteps,
  type AutomationStep,
  type AutomationConfig,
  type AutomationMeta,
  type AutomationRun,
  type FilterGroup,
} from '@riosoma/contracts';
import {
  Button,
  Menu,
  MenuItem,
  MenuTrigger,
  TextField,
  SortableItem,
  SortableList,
  moveList,
  Modal,
  Dialog,
  DialogTitle,
  DialogBody,
} from '@riosoma/ui';
import type { ReactNode } from 'react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import { FilterEditor } from '../view/FilterEditor';
import { newCondition } from '../view/filterValues';
import { Card } from './Card';
import { STEP_ICONS, STEP_LABELS } from './labels';
import {
  followRecords,
  duplicateStep,
  insertStep,
  MAX_STEPS,
  moveStep,
  newStep,
  newStepId,
  removeStep,
  STEP_KINDS,
  triggerTableId,
  type StepKind,
} from './model';
import { findProblems } from './problems';
import {
  ConditionsPort,
  nodeState,
  simulationNodes,
  StepPort,
  TriggerPort,
  type SimulatedState,
  type SimulationView,
} from './Simulator';
import { StepCard } from './StepCard';
import { FlowFields } from './FlowFields';
import { AutomationCanvas } from './AutomationCanvas';
import { ConnectionPorts, ConnectionProblems } from './Connections';
import { tokenCatalog } from './catalog';
import { TriggerCard } from './TriggerCard';
import { useLevel } from '../../../levels/context';
import { useFeatureCommands } from '../../../levels/palette';
import { featureAt, type Holdings } from '../../../levels/features';

export interface AutomationFlowProps {
  session: DatabaseSession;
  schema: SchemaState;
  automation: AutomationMeta;
  config: AutomationConfig;
  readOnly: boolean;
  testRun?: AutomationRun;
  onTest?(stepId: string): void;
  stepTest?: { stepId: string; panel: ReactNode };
  testing?: boolean;
  /** A simulation being walked, which lights the cards it has reached and shows their values */
  simulation?: SimulationView;
  onChange(config: AutomationConfig, options?: { immediate?: boolean }): void;
}

/** Where focus goes once the flow has redrawn: a step's card, or one of its buttons. */
interface FocusTarget {
  stepId: string;
  /** Buttons to try in order, by name */
  buttons?: readonly string[];
  /** Waits a frame, so a closing menu hands focus back first */
  later?: boolean;
}

/**
 * The automation from top to bottom: what starts it, the conditions it checks, and its steps,
 * with a way to add a step between any two and after the last.
 */
export function AutomationFlow({
  session,
  schema,
  automation,
  config,
  readOnly,
  testRun,
  stepTest,
  onTest,
  testing,
  simulation,
  onChange,
}: AutomationFlowProps) {
  const { t, i18n } = useLingui();
  const flow = useRef<HTMLDivElement>(null);
  const focus = useRef<FocusTarget | null>(null);
  const [conditionsOpen, setConditionsOpen] = useState(false);
  const [connectionSource, setConnectionSource] = useState<AutomationEndpoint | null>(null);
  const { offers } = useLevel();
  const problems = useMemo(() => findProblems(config, schema), [config, schema]);
  const fallbackTableId = schema.tables[0]?.id ?? '';
  const triggerTable = triggerTableId(config.trigger, schema);
  const triggerFields = triggerTable ? (schema.fields.get(triggerTable) ?? []) : [];
  const stepCount = flattenAutomationSteps(config.steps).length;
  const full = stepCount >= 100;
  const change = (next: AutomationConfig, options?: { immediate?: boolean }) => {
    if (next.connections) {
      const steps = flattenAutomationSteps(next.steps);
      const ids = new Set(steps.map((step) => step.id));
      next = {
        ...next,
        connections: next.connections.filter(
          (wire) =>
            ids.has(wire.target.stepId) &&
            (wire.source.stepId === 'trigger' ||
              steps.some(
                (step) =>
                  step.id === wire.source.stepId && automationOutputPorts(step).includes(wire.source.port),
              )),
        ),
      };
    }
    onChange(followRecords(next, schema), options);
  };
  const moveUp = t({ id: 'automations.step.moveUp', message: 'Move up' });
  const moveDown = t({ id: 'automations.step.moveDown', message: 'Move down' });

  useLayoutEffect(() => {
    const target = focus.current;
    if (!target) return;
    focus.current = null;
    const apply = () => {
      const card = flow.current?.querySelector<HTMLElement>(`[data-step="${target.stepId}"]`);
      if (!card) return;
      const buttons = [...card.querySelectorAll<HTMLButtonElement>('button')];
      const button = target.buttons
        ?.map((name) => buttons.find((item) => item.getAttribute('aria-label') === name && !item.disabled))
        .find(Boolean);
      (button ?? card).focus();
    };
    if (target.later) requestAnimationFrame(apply);
    else apply();
  });

  function addStep(kind: StepKind, index: number) {
    if (full || config.steps.length >= MAX_STEPS) return;
    const step = newStep(kind, config, index, schema, fallbackTableId);
    focus.current = { stepId: step.id, later: true };
    change(insertStep(config, index, step));
  }

  // Every registered step, code and webhooks among them, is in the palette whatever the level.
  useFeatureCommands(
    `automation.${automation.id}.steps`,
    readOnly || full || config.steps.length >= MAX_STEPS
      ? []
      : STEP_KINDS.filter((kind) => featureAt('stepPicker', kind)).map((kind) => ({
          place: `stepPicker:${kind}` as const,
          run: () => addStep(kind, config.steps.length),
        })),
  );
  // What this automation already uses keeps those kinds of step in its Add a step menus at every
  // level, as it does across the database.
  const held = {
    stepKinds: new Set(flattenAutomationSteps(config.steps).map((step) => step.kind)),
    triggerKinds: new Set([config.trigger.kind]),
  };

  const showConditions = config.conditions !== null || (conditionsOpen && !readOnly);
  // Where a simulation has got to: each card's state, and whether the line into it has lit.
  const walk = simulation ? simulationNodes(config, simulation.result) : null;
  const state = (node: string): SimulatedState | undefined =>
    simulation ? nodeState(simulation, config, node) : undefined;
  const lit = (node: string) =>
    simulation && walk
      ? walk.nodes.some((id, index) => (id === node || id.endsWith(`/${node}`)) && index < simulation.shown)
      : false;
  const current = simulation && walk ? walk.nodes[simulation.shown - 1] : undefined;
  const node = (id: string) => ({
    className: 'rio-automation-flow__node',
    'data-sim': state(id),
    'data-current': current === id || current?.endsWith(`/${id}`) || undefined,
  });
  const renderSteps = (
    steps: AutomationStep[],
    onList: (steps: AutomationStep[], options?: { immediate: boolean }) => void,
    depth = 0,
    preceding: AutomationStep[] = [],
    inLoop = false,
  ): ReactNode => {
    const local = { ...config, steps };
    const replace = (index: number, next: AutomationStep, options?: { immediate: boolean }) =>
      onList(
        steps.map((step, at) => (at === index ? next : step)),
        options,
      );
    const add = (kind: StepKind, index: number) => {
      const next = newStep(
        kind,
        { ...config, steps: [...preceding, ...steps] },
        preceding.length + index,
        schema,
        fallbackTableId,
      );
      focus.current = { stepId: next.id, later: true };
      const copy = [...steps];
      copy.splice(index, 0, next);
      onList(copy);
    };
    return (
      <>
        <SortableList
          items={steps.map((step) => ({ id: step.id, name: i18n._(STEP_LABELS[step.kind]) }))}
          disabledReason={
            readOnly
              ? t({
                  id: 'automations.steps.readOnly',
                  message: 'You need permission to arrange these steps.',
                })
              : undefined
          }
          onMove={(from, to) => onList([...moveList(steps, from, to)], { immediate: true })}
        >
          <ol className="rio-automation-flow__steps">
            {steps.map((step, index) => (
              <SortableItem id={step.id} key={step.id} as="li" className="rio-automation-flow__step">
                <>
                  {!readOnly ? (
                    <AddStep
                      compact
                      depth={depth}
                      isDisabled={full || steps.length >= MAX_STEPS}
                      held={held}
                      lit={lit(step.id)}
                      onAdd={(kind) => add(kind, index)}
                    />
                  ) : null}
                  <div {...node(step.id)}>
                    <ConnectionPorts step={step} />
                    <ConnectionProblems config={config} stepId={step.id} />
                    <StepCard
                      step={step}
                      index={index}
                      config={config.connections ? config : local}
                      schema={schema}
                      availableSteps={preceding}
                      inLoop={
                        config.connections
                          ? flattenAutomationSteps(config.steps).some(
                              (entry) =>
                                entry.kind === 'repeat' && connectionLoopBody(config, entry.id).has(step.id),
                            )
                          : inLoop
                      }
                      result={testRun?.steps.find((result) => result.stepId === step.id)}
                      onTest={onTest ? () => onTest(step.id) : undefined}
                      testing={testing}
                      problems={problems.steps.get(step.id)}
                      readOnly={readOnly}
                      canDuplicate={
                        stepCount + flattenAutomationSteps([step]).length <= 100 && steps.length < MAX_STEPS
                      }
                      onChange={(next) => replace(index, next)}
                      onMove={(offset) => {
                        focus.current = {
                          stepId: step.id,
                          buttons: offset < 0 ? [moveUp, moveDown] : [moveDown, moveUp],
                        };
                        onList(moveStep(local, index, offset).steps);
                      }}
                      onDuplicate={() => {
                        const copy = duplicateStep(step);
                        focus.current = { stepId: copy.id };
                        onList(insertStep(local, index + 1, copy).steps);
                      }}
                      onDelete={() => {
                        const next = steps[index + 1] ?? steps[index - 1];
                        if (next) focus.current = { stepId: next.id };
                        onList(removeStep(local, index).steps);
                      }}
                    >
                      <FlowFields
                        step={step}
                        config={
                          config.connections
                            ? config
                            : { ...config, steps: [...preceding, ...steps.slice(0, index)] }
                        }
                        schema={schema}
                        session={session}
                        readOnly={readOnly}
                        catalog={tokenCatalog(
                          config.connections ? config : { ...config, steps: [...preceding, ...steps] },
                          config.connections
                            ? flattenAutomationSteps(config.steps).findIndex((entry) => entry.id === step.id)
                            : preceding.length + index,
                          schema,
                          i18n,
                          config.connections
                            ? flattenAutomationSteps(config.steps).some(
                                (entry) =>
                                  entry.kind === 'repeat' &&
                                  connectionLoopBody(config, entry.id).has(step.id),
                              )
                            : inLoop,
                        )}
                        onChange={(next, options) => replace(index, next, options)}
                      />
                    </StepCard>
                    {simulation && lit(step.id) ? (
                      <SimulatedStepPort
                        simulation={simulation}
                        stepId={step.id}
                        schema={schema}
                        state={state(step.id)!}
                      />
                    ) : null}
                  </div>
                  {stepTest?.stepId === step.id ? stepTest.panel : null}
                  {automationPaths(step).length ? (
                    <div className="rio-automation-flow__branches">
                      {automationPaths(step).map((path, pathIndex) => (
                        <section
                          key={path.id}
                          className="rio-automation-flow__branch"
                          data-port={pathIndex % 3}
                        >
                          <h3 className="rio-automation-flow__port">
                            {path.id === 'otherwise'
                              ? t({ id: 'automations.path.otherwise', message: 'Otherwise' })
                              : step.kind === 'repeat'
                                ? t({ id: 'automations.path.item', message: 'Each item' })
                                : step.kind === 'if'
                                  ? t({ id: 'automations.path.then', message: 'Conditions met' })
                                  : step.kind === 'switch'
                                    ? step.cases.find((item) => item.id === path.id)?.value
                                    : null}
                          </h3>
                          {renderSteps(
                            path.steps,
                            (children, options) => {
                              if (step.kind === 'if')
                                replace(index, { ...step, [path.id]: children }, options);
                              if (step.kind === 'repeat')
                                replace(index, { ...step, steps: children }, options);
                              if (step.kind === 'switch')
                                replace(
                                  index,
                                  path.id === 'otherwise'
                                    ? { ...step, otherwise: children }
                                    : {
                                        ...step,
                                        cases: step.cases.map((item) =>
                                          item.id === path.id ? { ...item, steps: children } : item,
                                        ),
                                      },
                                  options,
                                );
                            },
                            depth + 1,
                            [...preceding, ...steps.slice(0, index)],
                            inLoop || step.kind === 'repeat',
                          )}
                        </section>
                      ))}
                    </div>
                  ) : null}
                </>
              </SortableItem>
            ))}
          </ol>
        </SortableList>
        {!readOnly ? (
          <AddStep
            depth={depth}
            isDisabled={full || steps.length >= MAX_STEPS}
            held={held}
            onAdd={(kind) => add(kind, steps.length)}
          />
        ) : null}
      </>
    );
  };
  const firstStep = config.steps[0]?.id;
  return (
    <AutomationCanvas config={config} readOnly={readOnly} onChange={change} onCreate={setConnectionSource}>
      <Modal
        isOpen={connectionSource !== null}
        onOpenChange={(open) => {
          if (!open) setConnectionSource(null);
        }}
        isDismissable
      >
        <Dialog>
          <DialogTitle>
            {t({ id: 'automations.wire.picker', message: 'Choose a step to connect' })}
          </DialogTitle>
          <DialogBody>
            {STEP_KINDS.filter((kind) => offers('stepPicker', kind, held)).map((kind) => (
              <Button
                key={kind}
                isDisabled={full || config.steps.length >= MAX_STEPS}
                onPress={() => {
                  if (!connectionSource) return;
                  const step = newStep(kind, config, config.steps.length, schema, fallbackTableId);
                  const source = connectionSource;
                  const next = {
                    ...config,
                    steps: [...config.steps, step],
                    connections: [
                      ...automationConnections(config),
                      { id: newStepId(), source, target: { stepId: step.id, port: 'in' } },
                    ],
                  };
                  focus.current = { stepId: step.id, later: true };
                  setConnectionSource(null);
                  change(next, { immediate: true });
                }}
              >
                {i18n._(STEP_LABELS[kind])}
              </Button>
            ))}
          </DialogBody>
        </Dialog>
      </Modal>
      <TextField
        type="number"
        label={t({ id: 'automations.loop.cap', message: 'Maximum loop items per run' })}
        value={String(config.loopItemCap ?? 1000)}
        isReadOnly={readOnly}
        onChange={(value) => change({ ...config, loopItemCap: Number(value) })}
      />
      <div className="rio-automation-flow" ref={flow} data-simulating={simulation ? '' : undefined}>
        <div {...node('trigger')}>
          <ConnectionPorts />
          <TriggerCard
            session={session}
            schema={schema}
            automation={automation}
            config={config}
            problems={problems.trigger}
            readOnly={readOnly}
            fallbackTableId={fallbackTableId}
            onChange={change}
          />
          {simulation && lit('trigger') ? (
            <TriggerPort view={simulation} schema={schema} config={config} />
          ) : null}
        </div>
        {showConditions ? (
          <div
            className="rio-automation-flow__joint"
            aria-hidden="true"
            data-lit={lit('conditions') || undefined}
          />
        ) : null}
        {showConditions ? (
          <div {...node('conditions')}>
            <Card
              title={t({ id: 'automations.conditions', message: 'Only if' })}
              problems={problems.conditions}
            >
              <FilterEditor
                fields={triggerFields}
                session={session}
                primaryFieldId={triggerTable ? schema.tableById.get(triggerTable)?.primaryFieldId : undefined}
                collaborators={schema.collaborators}
                value={config.conditions}
                readOnly={readOnly}
                onChange={(conditions: FilterGroup | null) => change({ ...config, conditions })}
              />
            </Card>
            {simulation && lit('conditions') ? <ConditionsPort view={simulation} /> : null}
          </div>
        ) : !readOnly && triggerTable ? (
          <div className="rio-automation-flow__link" data-lit={(firstStep && lit(firstStep)) || undefined}>
            <Button
              variant="quiet"
              icon={faPlus}
              onPress={() => {
                const table = schema.tableById.get(triggerTable);
                const field =
                  triggerFields.find((item) => item.id === table?.primaryFieldId) ?? triggerFields[0];
                setConditionsOpen(true);
                if (field)
                  change({
                    ...config,
                    conditions: { conjunction: 'and', conditions: [newCondition(field)] },
                  });
              }}
              aria-label={t({ id: 'automations.conditions.add', message: 'Add conditions' })}
            />
          </div>
        ) : null}
        {renderSteps(config.steps, (steps, options) => change({ ...config, steps }, options))}
      </div>
    </AutomationCanvas>
  );
}

function SimulatedStepPort({
  simulation,
  stepId,
  schema,
  state,
}: {
  simulation: SimulationView;
  stepId: string;
  schema: SchemaState;
  state: SimulatedState;
}) {
  const step =
    simulation.result.steps
      .slice(0, Math.max(0, simulation.shown - (simulation.result.conditions ? 2 : 1)))
      .findLast((item) => item.stepId === stepId) ??
    simulation.result.steps.find((item) => item.stepId === stepId);
  return step ? <StepPort step={step} schema={schema} state={state} /> : null;
}

function AddStep({
  compact = false,
  depth = 0,
  isDisabled,
  lit = false,
  held,
  onAdd,
}: {
  compact?: boolean;
  depth?: number;
  isDisabled: boolean;
  /** Whether a simulation has passed along the line this button sits on */
  lit?: boolean;
  /** What the automation already has, which keeps those kinds of step on offer */
  held: Holdings;
  onAdd(kind: StepKind): void;
}) {
  const { t, i18n } = useLingui();
  const { offers } = useLevel();
  const label = t({ id: 'automations.step.add', message: 'Add a step' });
  // Code steps and webhook steps are Advanced.  A kind of step the automation, or any automation
  // in the database, already takes stays on offer at every level.
  const kinds = STEP_KINDS.filter(
    (kind) => offers('stepPicker', kind, held) && (depth < 5 || !['if', 'switch', 'repeat'].includes(kind)),
  );
  return (
    <div
      className={compact ? 'rio-automation-flow__insert' : 'rio-automation-flow__link'}
      data-lit={lit || undefined}
    >
      <MenuTrigger>
        <Button
          variant={compact ? 'quiet' : 'secondary'}
          size={compact ? 'sm' : 'md'}
          icon={faPlus}
          isDisabled={isDisabled}
          aria-label={label}
        />
        <Menu
          aria-label={label}
          onAction={(key) => {
            const kind = kinds.find((item) => item === key);
            if (kind) onAdd(kind);
          }}
        >
          {kinds.map((kind) => (
            <MenuItem key={kind} id={kind} icon={STEP_ICONS[kind]}>
              {i18n._(STEP_LABELS[kind])}
            </MenuItem>
          ))}
        </Menu>
      </MenuTrigger>
    </div>
  );
}
