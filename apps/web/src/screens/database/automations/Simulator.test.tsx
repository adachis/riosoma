import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomationSimulation, DatabaseRole } from '@riosoma/contracts';
import { AutomationConfig } from '@riosoma/contracts';
import { nodeState, simulationNodes } from './Simulator';
import {
  automationFixture,
  automationMeta,
  bridgeFetch,
  renderScreen,
  type AutomationFixture,
} from './test-support';

const fixtures: AutomationFixture[] = [];

it('plays through a handled failure and recovery to the terminal failure', () => {
  const config = AutomationConfig.parse({ trigger: { kind: 'webhook' }, steps: [] });
  const result: AutomationSimulation = {
    state: 'failed',
    trigger: { kind: 'webhook', recordId: null, body: {}, values: {} },
    conditions: null,
    steps: ['failure1', 'recover1', 'failure2', 'skipped1'].map((stepId, index) => ({
      stepId,
      state: index === 1 ? 'succeeded' : index === 3 ? 'skipped' : 'failed',
      ms: 1,
      input: {},
      output: null,
      writes: [],
      sends: [],
      error: index % 2 === 0 ? { messageKey: 'automations.script.failed' } : null,
    })),
    access: { userId: 'viewer', ownerId: null, differs: false },
  };
  expect(simulationNodes(config, result).reached).toBe(4);
  expect(nodeState({ result, shown: 4 }, config, 'recover1')).toBe('done');
  expect(nodeState({ result, shown: 4 }, config, 'failure2')).toBe('failed');
  expect(nodeState({ result, shown: 4 }, config, 'skipped1')).toBe('skipped');
});
afterEach(() => {
  cleanup();
  fixtures.splice(0).forEach((fixture) => fixture.session.close());
  vi.unstubAllGlobals();
});

type Answer = (fixture: AutomationFixture) => AutomationSimulation | Promise<AutomationSimulation>;

async function mount(
  answer: Answer,
  options: { role?: DatabaseRole; conditions?: boolean; webhook?: boolean } = {},
) {
  const fixture = await automationFixture({
    role: options.role ?? 'owner',
    automations: ({ databaseId, tasks }) => [
      automationMeta(databaseId, 'Follow up', {
        trigger: options.webhook ? { kind: 'webhook' } : { kind: 'recordCreated', tableId: tasks.id },
        conditions: options.conditions
          ? {
              conjunction: 'and',
              conditions: [{ id: 'c1', fieldId: tasks.name, operator: 'isNotEmpty' }],
            }
          : null,
        steps: [
          { id: 'make_task', kind: 'createRecord', tableId: tasks.id, values: { [tasks.name]: 'Next' } },
          { id: 'mail_team', kind: 'sendEmail', to: ['team@example.test'], subject: 'New task', body: '' },
        ],
      }),
    ],
  });
  fixtures.push(fixture);
  const requests: Array<Record<string, unknown>> = [];
  const bridge = bridgeFetch(fixture.server);
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (!path.endsWith('/simulate')) return bridge(path, init);
    requests.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(JSON.stringify(await answer(fixture)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const automation = fixture.session.getSchema().automations[0]!;
  renderScreen(fixture, automation.id);
  await screen.findByRole('switch');
  return { fixture, requests, automation };
}

function result(fixture: AutomationFixture, extra: Partial<AutomationSimulation> = {}): AutomationSimulation {
  return {
    state: 'succeeded',
    trigger: {
      kind: 'recordCreated',
      recordId: fixture.tasks.recordId(0),
      body: null,
      values: { [fixture.tasks.name]: 'Record 1', [fixture.tasks.email]: null },
    },
    conditions: null,
    steps: [
      {
        stepId: 'make_task',
        state: 'succeeded',
        ms: 4,
        input: { tableId: fixture.tasks.id, values: { [fixture.tasks.name]: 'Next' } },
        output: { recordId: 'rec00000000000042', tableId: fixture.tasks.id },
        writes: [
          {
            tableId: fixture.tasks.id,
            recordId: 'rec00000000000042',
            created: true,
            changes: [{ fieldId: fixture.tasks.name, before: null, after: 'Next' }],
          },
        ],
        sends: [],
        error: null,
      },
      {
        stepId: 'mail_team',
        state: 'succeeded',
        ms: 2,
        input: { to: ['team@example.test'], subject: 'New task', body: '' },
        output: { to: ['team@example.test'] },
        writes: [],
        sends: [{ kind: 'email', to: ['team@example.test'], subject: 'New task', text: 'See the new task.' }],
        error: null,
      },
    ],
    access: { userId: 'usr00000000000001', ownerId: null, differs: false },
    ...extra,
  };
}

const node = (name: string) =>
  screen
    .getAllByRole('region', { name })
    .map((region) => region.closest('.rio-automation-flow__node'))
    .find(Boolean) as HTMLElement;
const stepNode = (index: number) =>
  document.querySelectorAll<HTMLElement>('.rio-automation-flow__steps .rio-automation-flow__node')[index]!;
const litWires = () => document.querySelectorAll('.rio-automation-flow [data-lit]').length;

describe('the simulator', () => {
  it('starts a fresh simulation when the webhook sample changes after finishing', async () => {
    const { requests } = await mount((fixture) => result(fixture), { webhook: true });
    await userEvent.click(screen.getByRole('button', { name: 'Simulate' }));
    const panel = screen.getByRole('region', { name: 'Simulate' });
    const body = within(panel).getByRole('textbox', { name: 'Sample body (JSON)' });
    await userEvent.click(body);
    await userEvent.paste('{"name":"first"}');
    await userEvent.click(within(panel).getByRole('button', { name: 'Run to the end' }));
    await within(panel).findByText(/^Every step ran\./, {}, { timeout: 3_000 });
    await userEvent.clear(body);
    await userEvent.paste('{"name":"第二 🧭 مرحبا"}');
    expect(within(panel).queryByText(/^Every step ran\./)).toBeNull();
    expect(within(panel).getByRole('button', { name: 'Run to the end' }).hasAttribute('disabled')).toBe(
      false,
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Step' }));
    await within(panel).findByText('The trigger starts the automation.');
    expect(requests).toEqual([{ body: { name: 'first' } }, { body: { name: '第二 🧭 مرحبا' } }]);
  });

  it('ignores a response for a webhook sample changed while the request was pending', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const { requests } = await mount(
      async (fixture) => {
        await pending;
        return result(fixture);
      },
      { webhook: true },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Simulate' }));
    const panel = screen.getByRole('region', { name: 'Simulate' });
    const body = within(panel).getByRole('textbox', { name: 'Sample body (JSON)' });
    await userEvent.click(body);
    await userEvent.paste('{"name":"first"}');
    await userEvent.click(within(panel).getByRole('button', { name: 'Step' }));
    await waitFor(() => expect(requests).toHaveLength(1));
    await userEvent.clear(body);
    await userEvent.paste('{"name":"second"}');
    finish();
    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: 'Step' }).hasAttribute('disabled')).toBe(false),
    );
    expect(within(panel).queryByText('The trigger starts the automation.')).toBeNull();
    expect(screen.queryByRole('region', { name: 'What the trigger passes on' })).toBeNull();
    await userEvent.click(within(panel).getByRole('button', { name: 'Step' }));
    await within(panel).findByText('The trigger starts the automation.');
    expect(requests).toEqual([{ body: { name: 'first' } }, { body: { name: 'second' } }]);
  });

  it('steps one card at a time, lighting the wires in order and showing each card’s values', async () => {
    const { requests } = await mount((fixture) => result(fixture));
    await userEvent.click(screen.getByRole('button', { name: 'Simulate' }));
    const panel = await screen.findByRole('region', { name: 'Simulate' });
    expect(within(panel).getByText(/without sending or saving anything/)).toBeDefined();
    expect(within(panel).getByRole('combobox', { name: 'Simulate with' })).toBeDefined();

    await userEvent.click(within(panel).getByRole('button', { name: 'Step' }));
    await within(panel).findByText('The trigger starts the automation.');
    expect(requests).toEqual([{}]);
    const trigger = screen.getByRole('region', { name: 'What the trigger passes on' });
    expect(within(trigger).getByText('Record 1')).toBeDefined();
    expect(within(trigger).getByText('Empty')).toBeDefined();
    expect(node('When').dataset.sim).toBe('done');
    expect(stepNode(0).dataset.sim).toBe('waiting');
    expect(litWires()).toBe(0);

    await userEvent.click(within(panel).getByRole('button', { name: 'Step' }));
    await within(panel).findByText('Step 1, Create a record, would work.');
    expect(stepNode(0).dataset.sim).toBe('done');
    expect(stepNode(0).dataset.current).toBe('true');
    const created = within(stepNode(0)).getByRole('region', { name: 'Simulated values' });
    expect(within(created).getByText('Would add a record to Tasks')).toBeDefined();
    const row = within(created).getByRole('rowheader', { name: 'Name' }).closest('tr')!;
    expect(within(row).getByText('Next')).toBeDefined();
    expect(litWires()).toBeGreaterThan(0);
    const afterOne = litWires();

    await userEvent.click(within(panel).getByRole('button', { name: 'Step' }));
    await within(panel).findByText(/^Every step ran\.\s+Nothing was sent or saved\.$/);
    const mailed = within(stepNode(1)).getByRole('region', { name: 'Simulated values' });
    expect(within(mailed).getByText('Would send this email')).toBeDefined();
    expect(within(mailed).getByText('See the new task.')).toBeDefined();
    expect(
      within(mailed).getByText('Later steps see a stand-in answer, since nothing was sent.'),
    ).toBeDefined();
    expect(litWires()).toBeGreaterThan(afterOne);
    expect((within(panel).getByRole('button', { name: 'Step' }) as HTMLButtonElement).disabled).toBe(true);
    // The whole walk was one request, and none of it was a run.
    expect(requests).toHaveLength(1);
  });

  it('runs to the end, and stops at the first error with the reason', async () => {
    await mount((fixture) => {
      const base = result(fixture);
      return {
        ...base,
        state: 'failed',
        steps: [
          {
            ...base.steps[0]!,
            state: 'failed',
            writes: [],
            output: null,
            error: { messageKey: 'automations.simulate.hiddenField' },
          },
          { ...base.steps[1]!, state: 'skipped', input: null, output: null, sends: [] },
        ],
      };
    });
    await userEvent.click(screen.getByRole('button', { name: 'Simulate' }));
    const panel = await screen.findByRole('region', { name: 'Simulate' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Run to the end' }));
    await within(panel).findByText(
      'Stopped at step 1, Create a record: This step uses a field you can’t see, so the simulation can’t fill it in.',
      {},
      { timeout: 3_000 },
    );
    expect(stepNode(0).dataset.sim).toBe('failed');
    await waitFor(() => expect(stepNode(1).dataset.sim).toBe('skipped'));
    expect(within(stepNode(1)).queryByRole('region', { name: 'Simulated values' })).toBeNull();
  });

  it('shows the branch the conditions take', async () => {
    await mount(
      (fixture) => ({
        ...result(fixture),
        state: 'skipped',
        skippedBecause: 'conditions',
        conditions: { matched: false, parts: [false] },
        steps: result(fixture).steps.map((step) => ({
          ...step,
          state: 'skipped',
          input: null,
          writes: [],
          sends: [],
        })),
      }),
      { conditions: true },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Simulate' }));
    const panel = await screen.findByRole('region', { name: 'Simulate' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Run to the end' }));
    await within(panel).findByText(
      'The record doesn’t meet the conditions, so no steps run.',
      {},
      { timeout: 3_000 },
    );
    const branch = screen.getByRole('region', { name: 'Branch taken' });
    expect(within(branch).getByText('Stops here')).toBeDefined();
    expect(within(branch).getByText('Condition 1 isn’t met')).toBeDefined();
    expect(node('Only if').dataset.sim).toBe('stopped');
    await waitFor(() => expect(stepNode(0).dataset.sim).toBe('skipped'));
  });

  it('shows a condition on a field hidden from the person as hidden', async () => {
    await mount((fixture) => ({ ...result(fixture), conditions: { matched: true, parts: [true, null] } }), {
      conditions: true,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Simulate' }));
    const panel = await screen.findByRole('region', { name: 'Simulate' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Run to the end' }));
    const branch = await screen.findByRole('region', { name: 'Branch taken' }, { timeout: 3_000 });
    expect(within(branch).getByText('Condition 1 is met')).toBeDefined();
    expect(within(branch).getByText('Condition 2 is hidden from you')).toBeDefined();
  });

  it('says when a real run reads with someone else’s access', async () => {
    await mount((fixture) => ({
      ...result(fixture),
      access: { userId: 'usr00000000000001', ownerId: fixture.server.remoteUserId, differs: true },
    }));
    await userEvent.click(screen.getByRole('button', { name: 'Simulate' }));
    const panel = await screen.findByRole('region', { name: 'Simulate' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Step' }));
    expect(
      await within(panel).findByText(/This simulation reads and changes records with your access/),
    ).toBeDefined();
  });

  it('goes stale when the automation changes, and closes without a trace', async () => {
    await mount((fixture) => result(fixture));
    await userEvent.click(screen.getByRole('button', { name: 'Simulate' }));
    const panel = await screen.findByRole('region', { name: 'Simulate' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Step' }));
    await within(panel).findByText('The trigger starts the automation.');
    const email = stepNode(1);
    await userEvent.type(within(email).getByRole('textbox', { name: 'Subject' }), '!');
    expect(await within(panel).findByText(/The automation changed since this simulation/)).toBeDefined();
    expect(document.querySelector('.rio-automation-flow [data-sim]')).toBeNull();
    await userEvent.click(within(panel).getByRole('button', { name: 'Close the simulation' }));
    expect(screen.queryByRole('region', { name: 'Simulate' })).toBeNull();
  });

  it('isn’t offered to people who can’t change the automation', async () => {
    await mount((fixture) => result(fixture), { role: 'editor' });
    expect(screen.queryByRole('button', { name: 'Simulate' })).toBeNull();
  });
});
