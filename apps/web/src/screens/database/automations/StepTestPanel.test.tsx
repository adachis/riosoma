import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomationRun, AutomationStep } from '@riosoma/contracts';
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

type Target = (tasks: { id: string; name: string }) => Record<string, unknown>;

async function mount(missing = false, target?: Target) {
  const fixture = await automationFixture({
    automations: ({ databaseId, tasks }) => [
      automationMeta(databaseId, 'Tasks', {
        trigger: { kind: 'recordCreated', tableId: tasks.id },
        steps: [
          { id: 'source01', kind: 'script', script: 'await output(2)' },
          (target?.(tasks) ?? {
            id: 'target01',
            kind: 'createRecord',
            tableId: tasks.id,
            values: { [tasks.name]: '{{steps.source01.output}}' },
          }) as AutomationStep,
        ],
      }),
    ],
  });
  fixtures.push(fixture);
  const automation = fixture.session.getSchema().automations[0]!;
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const bridge = bridgeFetch(fixture.server);
  const at = new Date().toISOString();
  const run: AutomationRun = {
    id: 'run-step',
    automationId: automation.id,
    test: true,
    testStepId: 'target01',
    state: 'succeeded',
    trigger: { kind: 'recordCreated', recordId: null, at },
    startedAt: at,
    finishedAt: at,
    steps: [
      {
        stepId: 'target01',
        state: 'succeeded',
        ms: 5,
        input: { count: 2 },
        output: { recordId: 'rec00000000000001' },
        error: null,
      },
    ],
  };
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    if (!path.includes('/steps/')) return bridge(path, init);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ path, body });
    const value = body.preview
      ? {
          source: missing ? 'sample' : 'history',
          inputs: missing ? {} : { count: 2 },
          missing: missing ? ['steps.source01.output'] : [],
          error: missing ? { messageKey: 'automations.test.missingValue' } : null,
        }
      : run;
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  renderScreen(fixture, automation.id);
  await screen.findByRole('switch');
  return { fixture, requests, automation };
}

describe('step test panel', () => {
  it('previews only the selected step and requires an in-app confirmation before writing', async () => {
    const { requests, fixture, automation } = await mount();
    expect(screen.getByRole('button', { name: 'Test the whole automation' })).toBeDefined();
    await userEvent.click(screen.getAllByRole('button', { name: 'Test step' })[1]!);
    const panel = await screen.findByRole('region', { name: 'Test step' });
    await within(panel).findByText('Using values recorded in the latest run.');
    expect(within(panel).getByText('This creates a record in Tasks.')).toBeDefined();
    expect(requests).toEqual([
      { path: `/api/automations/${automation.id}/steps/target01/test`, body: { preview: true } },
    ]);
    await userEvent.click(within(panel).getByRole('button', { name: 'Run this step' }));
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('This creates a record in Tasks.')).toBeDefined();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(requests).toHaveLength(1);
    await userEvent.click(within(panel).getByRole('button', { name: 'Run this step' }));
    dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run this step' }));
    await within(panel).findByText('Single-step test');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).toEqual({ samples: {} });
    expect(within(panel).getByText('rec00000000000001')).toBeDefined();
    expect(
      fixture.server.requests.some((request) => request.path === `/api/automations/${automation.id}/test`),
    ).toBe(false);
  });

  it.each<[string, Target, string]>([
    [
      'findRecords',
      (tasks) => ({ id: 'target01', kind: 'findRecords', tableId: tasks.id, filter: null, limit: 20 }),
      'This searches records and changes nothing.',
    ],
    [
      'createCalendarEvent',
      () => ({
        id: 'target01',
        kind: 'createCalendarEvent',
        provider: 'google-calendar',
        calendarId: '',
        title: 'Review',
        description: '',
        start: '2026-10-01',
        end: '2026-10-02',
        timeZone: 'UTC',
      }),
      'This creates a real event in your connected calendar.',
    ],
    [
      'generateDocument',
      (tasks) => ({
        id: 'target01',
        kind: 'generateDocument',
        tableId: tasks.id,
        record: 'trigger',
        templateFieldId: '',
        attachmentFieldId: '',
        format: 'docx',
        filename: '',
        values: {},
      }),
      'This attaches a generated document to a record in Tasks.',
    ],
    [
      'askAi',
      () => ({
        id: 'target01',
        kind: 'askAi',
        prompt: 'Summarize {{steps.source01.output}}',
        format: 'text',
        tier: 'everyday',
        classification: 'internal',
      }),
      'This sends the prompt and its values to the AI provider and counts toward the AI budget.',
    ],
    ...(
      [
        { kind: 'sendEmail', to: ['{{trigger.record.id}}'], subject: 'Review', body: 'Ready' },
        { kind: 'slack', webhookUrl: '', body: 'Ready' },
        { kind: 'teams', webhookUrl: '', body: 'Ready' },
        { kind: 'discord', webhookUrl: '', body: 'Ready' },
        { kind: 'studioFlow', webhookUrl: '', body: 'Ready', title: '', recipient: '', recordUrl: '' },
      ] as const
    ).map((step): [string, Target, string] => [
      step.kind,
      () => ({ id: 'target01', ...step }),
      'This sends a real message to the configured recipients or channel.',
    ]),
    ...(
      [
        { kind: 'if', conditions: null, then: [], otherwise: [] },
        { kind: 'switch', value: 'a', cases: [], otherwise: [] },
        { kind: 'repeat', list: '[1, 2]', steps: [] },
        { kind: 'wait', mode: 'duration', seconds: 60, date: '', conditions: null, timeoutSeconds: 3600 },
      ] as const
    ).map((step): [string, Target, string] => [
      step.kind,
      () => ({ id: 'target01', ...step }),
      'This checks the step with sample values and changes nothing.',
    ]),
  ])('says what testing a %s step does before it runs', async (_kind, target, effect) => {
    const { requests } = await mount(false, target);
    await userEvent.click(screen.getAllByRole('button', { name: 'Test step' })[1]!);
    const panel = await screen.findByRole('region', { name: 'Test step' });
    await within(panel).findByText('Using values recorded in the latest run.');
    expect(within(panel).getByText(effect)).toBeDefined();
    if (!effect.includes('sends a real message'))
      expect(within(panel).queryByText(/sends a real message/)).toBeNull();
    await userEvent.click(within(panel).getByRole('button', { name: 'Run this step' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(effect)).toBeDefined();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(requests).toHaveLength(1);
  });

  it('requires missing sample values and sends their JSON types', async () => {
    const { requests } = await mount(true);
    await userEvent.click(screen.getAllByRole('button', { name: 'Test step' })[1]!);
    const field = await screen.findByRole('textbox', { name: 'Sample value for steps.source01.output' });
    const run = screen.getByRole('button', { name: 'Run this step' }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(screen.getByText('Enter a sample value for this input before testing the step.')).toBeDefined();
    await userEvent.type(field, '0');
    await waitFor(() => expect(run.disabled).toBe(false));
    await userEvent.click(run);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Run this step' }));
    await screen.findByText('Single-step test');
    expect(requests[1]?.body).toEqual({ samples: { 'steps.source01.output': 0 } });
  });
});
