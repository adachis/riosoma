import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { AutomationConfig, newId, type AutomationMeta } from '@riosoma/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import type { ActionHandle, DatabaseSession } from '../../../data/types';
import { useAutomationDraft } from './draft';

afterEach(cleanup);

function config(value: string) {
  return AutomationConfig.parse({
    trigger: { kind: 'webhook' },
    steps: [{ id: 'script01', kind: 'script', input: {}, script: value }],
  });
}

function mount(run: DatabaseSession['run']) {
  const session = { run } as DatabaseSession;
  const automation = { id: newId('automation'), config: config('return 1'), draft: null } as AutomationMeta;
  return renderHook(() => useAutomationDraft(session, automation));
}

it('waits for an already pending save and propagates its rejection', async () => {
  let settle!: (outcome: Awaited<ActionHandle['done']>) => void;
  const done: ActionHandle['done'] = new Promise((resolve) => {
    settle = resolve;
  });
  const run = vi.fn(() => ({ groupId: newId('action'), done }));
  const { result } = mount(run);
  const edit = config('return 2');
  act(() => result.current.change(edit));
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(result.current.config).toBe(edit);
  let saved = false;
  const saving = result.current.save().then(() => {
    saved = true;
  });
  const rejected = expect(saving).rejects.toMatchObject({ info: { messageKey: 'errors.validationFailed' } });
  expect(saved).toBe(false);
  await act(async () => {
    settle({ applied: 0, rejected: 1 });
    await rejected;
  });
  expect(run).toHaveBeenCalledTimes(1);
  expect(result.current.config).toBe(edit);
});

it('keeps newer edits when an earlier save is accepted and drains them before continuing', async () => {
  const answers: Array<(outcome: Awaited<ActionHandle['done']>) => void> = [];
  const run = vi.fn<DatabaseSession['run']>(() => ({
    groupId: newId('action'),
    done: new Promise<Awaited<ActionHandle['done']>>((resolve) => answers.push(resolve)),
  }));
  const { result } = mount(run);
  const first = config('return 2');
  const latest = config('return 3');
  act(() => result.current.change(first, { immediate: true }));
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  act(() => result.current.change(latest));
  let saved = false;
  const saving = result.current.save().then(() => {
    saved = true;
  });
  await act(async () => {
    answers[0]!({ applied: 1, rejected: 0 });
  });
  expect(result.current.config).toBe(latest);
  expect(saved).toBe(false);
  await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect(run.mock.calls[1]?.[0]).toMatchObject([{ config: latest }]);
  await act(async () => {
    answers[1]!({ applied: 1, rejected: 0 });
    await saving;
  });
  expect(saved).toBe(true);
});

it('saves each immediate wire edit as its own action while an earlier save is pending', async () => {
  const answers: Array<(outcome: Awaited<ActionHandle['done']>) => void> = [];
  const run = vi.fn<DatabaseSession['run']>(() => ({
    groupId: newId('action'),
    done: new Promise<Awaited<ActionHandle['done']>>((resolve) => answers.push(resolve)),
  }));
  const { result } = mount(run);
  const edits = ['return 2', 'return 3', 'return 4'].map(config);
  act(() => result.current.change(edits[0]!, { immediate: true }));
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  act(() => {
    result.current.change(edits[1]!, { immediate: true });
    result.current.change(edits[2]!, { immediate: true });
  });
  const saving = result.current.save();
  for (let index = 0; index < edits.length; index++) {
    await waitFor(() => expect(run).toHaveBeenCalledTimes(index + 1));
    expect(run.mock.calls[index]?.[0]).toMatchObject([{ config: edits[index] }]);
    await act(async () => {
      answers[index]!({ applied: 1, rejected: 0 });
    });
  }
  await act(async () => {
    await saving;
  });
  expect(run).toHaveBeenCalledTimes(3);
});
