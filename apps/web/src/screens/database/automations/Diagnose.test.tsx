import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomationDiagnosis, AutomationRun, DatabaseRole, RioStatus } from '@riosoma/contracts';
import {
  automationFixture,
  automationMeta,
  bridgeFetch,
  renderScreen,
  type AutomationFixture,
} from './test-support';

const fixtures: AutomationFixture[] = [];
afterEach(() => {
  cleanup();
  fixtures.splice(0).forEach((fixture) => fixture.session.close());
  vi.unstubAllGlobals();
});

/** A stand-in for the sealed fix the server hands back */
const sealedFix = ['sealed', 'fix'].join('-');
const ready: RioStatus = {
  enabled: true,
  tiers: ['everyday'],
  autonomy: 'previewBig',
  paused: false,
  diagnose: true,
  routines: false,
  routineRunLimitUsd: 1,
};

interface Call {
  path: string;
  body: Record<string, unknown> | undefined;
}

async function mount(
  options: {
    role?: DatabaseRole;
    status?: RioStatus;
    state?: AutomationRun['state'];
    withheld?: boolean;
  } = {},
) {
  const fixture = await automationFixture({
    role: options.role ?? 'owner',
    automations: ({ databaseId, tasks }) => [
      automationMeta(databaseId, 'Count tasks', {
        trigger: { kind: 'recordCreated', tableId: tasks.id },
        steps: [
          {
            id: 'counted1',
            kind: 'createRecord',
            tableId: tasks.id,
            values: { [tasks.number]: `{{trigger.record.${tasks.name}}}` },
          },
        ],
      }),
    ],
  });
  fixtures.push(fixture);
  const automation = fixture.session.getSchema().automations[0]!;
  const at = new Date(Date.now() - 60_000).toISOString();
  fixture.server.automationRuns.set(automation.id, [
    {
      id: 'run-failed',
      automationId: automation.id,
      state: options.state ?? 'failed',
      trigger: { kind: 'recordCreated', recordId: fixture.tasks.recordId(0), at },
      test: false,
      steps: [
        {
          stepId: 'counted1',
          state: options.state === 'succeeded' ? 'succeeded' : 'failed',
          ms: 3,
          output: null,
          error:
            options.state === 'succeeded'
              ? null
              : { messageKey: 'automations.step.failed', detail: 'data.value.notNumber' },
        },
      ],
      startedAt: at,
      finishedAt: at,
    },
  ]);
  const diagnosis: AutomationDiagnosis = {
    runId: 'run-failed',
    cause: 'typeMismatch',
    explanation: 'The **Number** field needs a number, but it was given the task’s name.',
    fix: {
      summary: 'Fill Number from the task’s Number',
      target: { part: 'step', stepId: 'counted1' },
      diff: [
        {
          path: ['steps', 0, 'values', fixture.tasks.number],
          before: `{{trigger.record.${fixture.tasks.name}}}`,
          after: `{{trigger.record.${fixture.tasks.number}}}`,
        },
      ],
      token: sealedFix,
    },
    redacted: true,
    ...(options.withheld ? { withheld: true } : {}),
    usage: {
      providerId: 'remote',
      model: 'small-model',
      inputTokens: 1000,
      outputTokens: 250,
      costUsd: 0.003,
      ms: 900,
    },
  };
  const calls: Call[] = [];
  const bridge = bridgeFetch(fixture.server);
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    if (path === '/api/rio/status') return json(options.status ?? ready);
    if (path.endsWith('/diagnose') || path.endsWith('/diagnoses/apply') || path.endsWith('/undo')) {
      calls.push({ path, body });
      if (path.endsWith('/diagnose')) return json(diagnosis);
      if (path.endsWith('/apply'))
        return json({ databaseId: fixture.databaseId, groupId: 'act00000000000001' });
      return json({ status: 'applied', skipped: 0 });
    }
    return bridge(path, init);
  });
  renderScreen(fixture, automation.id);
  await screen.findByRole('switch');
  await userEvent.click(screen.getByRole('tab', { name: 'Runs' }));
  await userEvent.click(await screen.findByRole('button', { name: /Failed|Done/ }));
  return { fixture, automation, calls };
}

describe('Diagnose', () => {
  it('explains a failed run, previews its fix as a diff, applies it with one click, and undoes it', async () => {
    const { fixture, automation, calls } = await mount();
    const panel = await screen.findByRole('region', { name: 'Diagnose' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Diagnose' }));
    expect(await within(panel).findByText('Cause: A value of the wrong kind')).toBeDefined();
    expect(calls[0]).toEqual({
      path: `/api/automations/${automation.id}/runs/run-failed/diagnose`,
      body: { locale: 'en-US' },
    });
    expect(within(panel).getByText('Number', { selector: 'strong' })).toBeDefined();
    expect(within(panel).getByText('Values you can’t see were left out of what Rio read.')).toBeDefined();
    // Its cost and footprint, like Rio's other replies.
    expect(within(panel).getByText('small-model · 1,250 tokens · $0.003')).toBeDefined();
    const diff = within(panel).getByRole('list', { name: 'Changes' });
    expect(within(diff).getByText('Step 1, Create a record: values › Number')).toBeDefined();
    expect(diff.querySelector('del')!.textContent).toBe('− {{trigger.record.Name}}');
    expect(diff.querySelector('ins')!.textContent).toBe('+ {{trigger.record.Number}}');

    await userEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(await within(panel).findByText('Applied')).toBeDefined();
    expect(calls[1]).toEqual({
      path: `/api/automations/${automation.id}/diagnoses/apply`,
      body: { token: sealedFix },
    });
    await userEvent.click(within(panel).getByRole('button', { name: 'Undo' }));
    expect(await within(panel).findByText('Undone')).toBeDefined();
    expect(calls[2]).toMatchObject({
      path: `/api/databases/${fixture.databaseId}/undo`,
      body: { groupId: 'act00000000000001' },
    });
  });

  it('says when rules kept every value of the run from Rio', async () => {
    await mount({ withheld: true });
    const panel = await screen.findByRole('region', { name: 'Diagnose' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Diagnose' }));
    expect(
      await within(panel).findByText(
        'Rules limit what you can see in this database, so Rio read none of this run’s values, only its settings, its errors, and its fields’ names and types.',
      ),
    ).toBeDefined();
    expect(within(panel).queryByText('Values you can’t see were left out of what Rio read.')).toBeNull();
  });

  it('can be dismissed without changing anything', async () => {
    const { calls } = await mount();
    const panel = await screen.findByRole('region', { name: 'Diagnose' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Diagnose' }));
    await userEvent.click(await within(panel).findByRole('button', { name: 'Dismiss' }));
    expect(within(panel).getByText('Dismissed')).toBeDefined();
    expect(calls).toHaveLength(1);
  });

  it('is unavailable, with a note, when no AI provider is set up', async () => {
    await mount({ status: { ...ready, enabled: false, tiers: [], diagnose: false } });
    expect(
      await screen.findByText(
        /^Diagnose uses Rio, which needs an AI provider\.\s+An admin can set one up in AI settings\.$/,
      ),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Diagnose' })).toBeNull();
  });

  it('explains missing provider consent with a deep link to settings', async () => {
    await mount({ status: { ...ready, enabled: false, tiers: [], disabledReason: 'noProvider' } });
    expect(await screen.findByText('Rio is off because no provider is turned on.')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Review providers in AI settings' }).getAttribute('href')).toBe(
      '/settings/ai#providers',
    );
    expect(screen.queryByRole('button', { name: 'Diagnose' })).toBeNull();
  });

  it('says so when an admin turned it off', async () => {
    await mount({ status: { ...ready, diagnose: false } });
    expect(await screen.findByText('An admin turned off Diagnose for automation runs.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Diagnose' })).toBeNull();
  });

  it('isn’t offered on a run that worked, or to people who can’t change the automation', async () => {
    await mount({ state: 'succeeded' });
    await screen.findByText('Create a record');
    expect(screen.queryByRole('region', { name: 'Diagnose' })).toBeNull();
    cleanup();
    await mount({ role: 'editor' });
    await screen.findByText('Create a record');
    expect(screen.queryByRole('region', { name: 'Diagnose' })).toBeNull();
  });
});
