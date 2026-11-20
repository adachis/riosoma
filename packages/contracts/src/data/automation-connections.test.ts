import { describe, expect, it } from 'vitest';
import { AutomationConfig, type AutomationConnection } from './automations.js';
import {
  automationConnections,
  automationConnectionProblems,
  connectionRefusal,
  connectionOrder,
  connectionLoopBody,
} from './automation-connections.js';

const step = (id: string) => ({ id, kind: 'script', script: 'await output(1)' });
const wire = (
  id: string,
  source: string,
  target: string,
  port = 'out',
  input = 'in',
): AutomationConnection => ({
  id,
  source: { stepId: source, port },
  target: { stepId: target, port: input },
});
const config = (connections: AutomationConnection[]) =>
  AutomationConfig.parse({
    trigger: { kind: 'webhook' },
    steps: [step('first001'), step('second01'), step('third001')],
    connections,
  });

describe('explicit automation connections', () => {
  it('refuses merges between a loop item and the surrounding run', () => {
    const value = AutomationConfig.parse({
      trigger: { kind: 'webhook' },
      steps: [{ id: 'repeat01', kind: 'repeat', list: '[1]', steps: [] }, step('first001'), step('second01')],
      connections: [
        wire('wire0001', 'trigger', 'repeat01'),
        wire('wire0002', 'repeat01', 'first001', 'each', 'merge'),
        wire('wire0003', 'repeat01', 'second01', 'done', 'merge'),
      ],
    });
    expect(
      connectionRefusal(value, { stepId: 'trigger', port: 'out' }, { stepId: 'first001', port: 'merge' }),
    ).toBe('automations.wire.loopBoundary');
    expect(
      connectionRefusal(value, { stepId: 'first001', port: 'out' }, { stepId: 'second01', port: 'merge' }),
    ).toBe('automations.wire.loopBoundary');
  });
  it('refuses cycles, wrong port kinds, occupied inputs, and duplicate wires', () => {
    const value = config([wire('wire0001', 'trigger', 'first001'), wire('wire0002', 'first001', 'second01')]);
    expect(
      connectionRefusal(value, { stepId: 'second01', port: 'out' }, { stepId: 'first001', port: 'merge' }),
    ).toBe('automations.wire.occupied');
    const merge = config([
      wire('wire0001', 'trigger', 'first001', 'out', 'merge'),
      wire('wire0002', 'first001', 'second01'),
    ]);
    expect(
      connectionRefusal(merge, { stepId: 'second01', port: 'out' }, { stepId: 'first001', port: 'merge' }),
    ).toBe('automations.wire.cycle');
    expect(
      connectionRefusal(value, { stepId: 'first001', port: 'in' }, { stepId: 'third001', port: 'in' }),
    ).toBe('automations.wire.kind');
    expect(
      connectionRefusal(value, { stepId: 'first001', port: 'out' }, { stepId: 'third001', port: 'out' }),
    ).toBe('automations.wire.kind');
    expect(
      connectionRefusal(value, { stepId: 'first001', port: 'out' }, { stepId: 'second01', port: 'in' }),
    ).toBe('automations.wire.duplicate');
    expect(
      AutomationConfig.safeParse({
        ...value,
        connections: [...value.connections!, wire('wire0003', 'second01', 'first001', 'out', 'merge')],
      }).success,
    ).toBe(false);
  });

  it('allows disconnected drafts and identifies missing inputs and unreachable steps before publishing', () => {
    const value = config([wire('wire0001', 'second01', 'third001')]);
    expect(automationConnectionProblems(value, false)).toEqual([]);
    expect(automationConnectionProblems(value)).toEqual([
      { stepId: 'first001', messageKey: 'automations.wire.missingInput' },
      { stepId: 'second01', messageKey: 'automations.wire.missingInput' },
      { stepId: 'third001', messageKey: 'automations.wire.unreachable' },
    ]);
  });

  it('orders merges after both upstream paths regardless of storage order', () => {
    const value = config([
      wire('wire0001', 'trigger', 'third001'),
      wire('wire0002', 'third001', 'second01', 'out', 'merge'),
      wire('wire0003', 'third001', 'first001'),
      wire('wire0004', 'first001', 'second01', 'out', 'merge'),
    ]);
    expect(connectionOrder(value).map((entry) => entry.id)).toEqual(['third001', 'first001', 'second01']);
    expect(automationConnectionProblems(value)).toEqual([]);
  });

  it('loads older nested saves without changing their configuration and derives branch and loop wires', () => {
    const value = AutomationConfig.parse({
      trigger: { kind: 'webhook' },
      steps: [
        { id: 'branch01', kind: 'if', conditions: null, then: [step('first001')], otherwise: [] },
        { id: 'repeat01', kind: 'repeat', list: '[1,2]', steps: [step('second01')] },
        step('third001'),
      ],
    });
    expect(value.connections).toBeUndefined();
    const wires = automationConnections(value);
    expect(wires).toContainEqual(wire('wire_000001', 'branch01', 'first001', 'then'));
    expect(
      wires.find((entry) => entry.source.stepId === 'repeat01' && entry.source.port === 'each')?.target
        .stepId,
    ).toBe('second01');
    expect(
      wires.find((entry) => entry.source.stepId === 'repeat01' && entry.source.port === 'done')?.target
        .stepId,
    ).toBe('third001');
    expect(connectionLoopBody({ ...value, connections: wires }, 'repeat01')).toEqual(new Set(['second01']));
    expect(AutomationConfig.safeParse({ ...value, connections: wires }).success).toBe(true);
  });
});
