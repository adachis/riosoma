import type {
  AutomationConfig,
  AutomationConnection,
  AutomationEndpoint,
  AutomationStep,
} from './automations.js';

export type ConnectionProblemKey =
  | 'automations.wire.kind'
  | 'automations.wire.occupied'
  | 'automations.wire.cycle'
  | 'automations.wire.loopBoundary'
  | 'automations.wire.duplicate'
  | 'automations.wire.unreachable'
  | 'automations.wire.missingInput';
export interface ConnectionProblem {
  messageKey: ConnectionProblemKey;
  stepId: string;
}

function paths(step: AutomationStep): Array<{ id: string; steps: AutomationStep[] }> {
  if (step.kind === 'if')
    return [
      { id: 'then', steps: step.then },
      { id: 'otherwise', steps: step.otherwise },
    ];
  if (step.kind === 'switch') return [...step.cases, { id: 'otherwise', steps: step.otherwise }];
  if (step.kind === 'repeat') return [{ id: 'each', steps: step.steps }];
  return [];
}

export function connectionSteps(config: Pick<AutomationConfig, 'steps'>): AutomationStep[] {
  const flatten = (steps: AutomationStep[]): AutomationStep[] =>
    steps.flatMap((step) => [step, ...paths(step).flatMap((path) => flatten(path.steps))]);
  return flatten(config.steps);
}

export function automationOutputPorts(step?: AutomationStep): string[] {
  if (!step) return ['out'];
  if (step.kind === 'repeat') return ['each', 'done', 'error'];
  if (step.kind === 'if' || step.kind === 'switch') return [...paths(step).map((path) => path.id), 'error'];
  return ['out', 'error'];
}

/** Older ordered paths become wires only when someone edits a connection. */
export function automationConnections(
  config: Pick<AutomationConfig, 'steps' | 'connections'>,
): AutomationConnection[] {
  if (config.connections) return config.connections;
  const wires: AutomationConnection[] = [];
  const connect = (stepId: string, port: string, target: string | undefined) => {
    if (target)
      wires.push({
        id: `wire_${wires.length.toString().padStart(6, '0')}`,
        source: { stepId, port },
        target: { stepId: target, port: 'in' },
      });
  };
  const visit = (steps: AutomationStep[], after?: string) => {
    steps.forEach((step, index) => {
      const next = steps[index + 1]?.id ?? after;
      if (step.kind === 'repeat') {
        connect(step.id, 'each', step.steps[0]?.id);
        connect(step.id, 'done', next);
        visit(step.steps);
      } else if (step.kind === 'if' || step.kind === 'switch') {
        for (const path of paths(step)) {
          connect(step.id, path.id, path.steps[0]?.id ?? next);
          visit(path.steps, next);
        }
      } else connect(step.id, 'out', next);
    });
  };
  connect('trigger', 'out', config.steps[0]?.id);
  visit(config.steps);
  for (const wire of wires)
    if (wires.filter((other) => other.target.stepId === wire.target.stepId).length > 1)
      wire.target.port = 'merge';
  return wires;
}

export function connectionReachable(
  wires: readonly AutomationConnection[],
  starts: readonly string[],
): Set<string> {
  const reached = new Set(starts);
  const queue = [...starts];
  for (let index = 0; index < queue.length; index++)
    for (const wire of wires)
      if (wire.source.stepId === queue[index] && !reached.has(wire.target.stepId)) {
        reached.add(wire.target.stepId);
        queue.push(wire.target.stepId);
      }
  return reached;
}

export function connectionRefusal(
  config: Pick<AutomationConfig, 'steps' | 'connections'>,
  source: AutomationEndpoint,
  target: AutomationEndpoint,
  replacing?: string,
): ConnectionProblemKey | null {
  const steps = connectionSteps(config);
  const from = steps.find((step) => step.id === source.stepId);
  if (
    (source.stepId !== 'trigger' && !from) ||
    !automationOutputPorts(from).includes(source.port) ||
    !steps.some((step) => step.id === target.stepId) ||
    !['in', 'merge'].includes(target.port)
  )
    return 'automations.wire.kind';
  const wires = automationConnections(config).filter((wire) => wire.id !== replacing);
  if (
    wires.some(
      (wire) =>
        wire.source.stepId === source.stepId &&
        wire.source.port === source.port &&
        wire.target.stepId === target.stepId,
    )
  )
    return 'automations.wire.duplicate';
  if (
    wires.some(
      (wire) => wire.target.stepId === target.stepId && (target.port === 'in' || wire.target.port === 'in'),
    )
  )
    return 'automations.wire.occupied';
  if (source.stepId === target.stepId || connectionReachable(wires, [target.stepId]).has(source.stepId))
    return 'automations.wire.cycle';
  const projected = { ...config, connections: [...wires, { id: replacing ?? 'candidate', source, target }] };
  const loops = steps
    .filter((step) => step.kind === 'repeat')
    .map((step) => ({
      id: step.id,
      body: connectionLoopBody(projected, step.id),
    }));
  for (const wire of projected.connections) {
    const from = loops.filter((loop) => loop.body.has(wire.source.stepId)).map((loop) => loop.id);
    const to = loops.filter((loop) => loop.body.has(wire.target.stepId)).map((loop) => loop.id);
    if (wire.source.port === 'each') from.push(wire.source.stepId);
    if (new Set(from).size !== new Set(to).size || from.some((id) => !to.includes(id)))
      return 'automations.wire.loopBoundary';
  }
  return null;
}

export function automationConnectionProblems(
  config: Pick<AutomationConfig, 'steps' | 'connections'>,
  publish = true,
): ConnectionProblem[] {
  if (!config.connections) return [];
  const problems: ConnectionProblem[] = [];
  const ids = new Set<string>();
  for (const wire of config.connections) {
    const messageKey = ids.has(wire.id)
      ? 'automations.wire.duplicate'
      : connectionRefusal(config, wire.source, wire.target, wire.id);
    ids.add(wire.id);
    if (messageKey) problems.push({ messageKey, stepId: wire.target.stepId });
  }
  if (publish) {
    const reached = connectionReachable(config.connections, ['trigger']);
    for (const step of connectionSteps(config)) {
      if (!config.connections.some((wire) => wire.target.stepId === step.id))
        problems.push({ messageKey: 'automations.wire.missingInput', stepId: step.id });
      else if (!reached.has(step.id))
        problems.push({ messageKey: 'automations.wire.unreachable', stepId: step.id });
    }
  }
  return problems;
}

/** Merges wait for every upstream decision, then run once if any incoming wire was taken. */
export function connectionOrder(config: Pick<AutomationConfig, 'steps' | 'connections'>): AutomationStep[] {
  const wires = automationConnections(config);
  const remaining = new Map(connectionSteps(config).map((step) => [step.id, step]));
  const result: AutomationStep[] = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter(
      (step) => !wires.some((wire) => wire.target.stepId === step.id && remaining.has(wire.source.stepId)),
    );
    if (!ready.length) break;
    for (const step of ready) {
      result.push(step);
      remaining.delete(step.id);
    }
  }
  return result;
}

export function connectionAncestors(
  config: Pick<AutomationConfig, 'steps' | 'connections'>,
  stepId: string,
): Set<string> {
  const reversed = automationConnections(config).map((wire) => ({
    ...wire,
    source: wire.target,
    target: wire.source,
  }));
  const reached = connectionReachable(reversed, [stepId]);
  reached.delete(stepId);
  return reached;
}

/** The done path is outside the loop even when an each path joins it. */
export function connectionLoopBody(
  config: Pick<AutomationConfig, 'steps' | 'connections'>,
  stepId: string,
): Set<string> {
  const wires = automationConnections(config);
  const roots = (port: string) =>
    wires
      .filter((wire) => wire.source.stepId === stepId && wire.source.port === port)
      .map((wire) => wire.target.stepId);
  const body = connectionReachable(wires, roots('each'));
  for (const id of connectionReachable(wires, roots('done'))) body.delete(id);
  return body;
}
