import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toastQueue } from '@riosoma/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandBatch, type AutomationMeta, type AutomationRun, type DatabaseRole } from '@riosoma/contracts';
import { celebrations, type Celebration } from '../../../features/celebrations/engine';
import { runsKey } from './RunHistory';
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
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(role: DatabaseRole = 'owner', extra: Partial<AutomationMeta> = {}) {
  const fixture = await automationFixture({
    role,
    automations: ({ databaseId, tasks }) => [
      automationMeta(
        databaseId,
        'Follow up',
        {
          trigger: { kind: 'recordCreated', tableId: tasks.id },
          steps: [
            { id: 'make_task', kind: 'createRecord', tableId: tasks.id, values: { [tasks.name]: 'Next' } },
            { id: 'mail_team', kind: 'sendEmail', to: ['team@example.test'], subject: 'New task', body: '' },
          ],
        },
        extra,
      ),
    ],
  });
  fixtures.push(fixture);
  vi.stubGlobal('fetch', bridgeFetch(fixture.server));
  const automationId = fixture.session.getSchema().automations[0]!.id;
  const { client } = renderScreen(fixture, automationId);
  await screen.findByRole('switch');
  return { ...fixture, automationId, client };
}

function run(automationId: string, overrides: Partial<AutomationRun> = {}): AutomationRun {
  const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
  return {
    id: `run_${Math.random().toString(36).slice(2)}`,
    automationId,
    state: 'succeeded',
    trigger: { kind: 'recordCreated', recordId: 'rec00000000000001', at },
    test: false,
    steps: [
      {
        stepId: 'make_task',
        state: 'succeeded',
        ms: 400,
        output: { recordId: 'rec00000000000009' },
        error: null,
      },
      {
        stepId: 'mail_team',
        state: 'succeeded',
        ms: 1100,
        output: { to: ['team@example.test'] },
        error: null,
      },
    ],
    startedAt: at,
    finishedAt: new Date(Date.parse(at) + 1500).toISOString(),
    ...overrides,
  };
}

const testRequests = (fixture: AutomationFixture) =>
  fixture.server.requests.filter((request) => request.path.endsWith('/test'));

describe('test runs', () => {
  it('run now and show the result inline, step by step', async () => {
    const fixture = await mount();
    fixture.server.testRun = (automationId) =>
      run(automationId, {
        test: true,
        state: 'failed',
        steps: [
          {
            stepId: 'make_task',
            state: 'succeeded',
            ms: 250,
            output: { recordId: 'rec00000000000009' },
            error: null,
          },
          {
            stepId: 'mail_team',
            state: 'failed',
            ms: 30,
            output: null,
            error: { messageKey: 'errors.offline', detail: 'SMTP 421' },
          },
        ],
      });
    await userEvent.click(screen.getByRole('button', { name: 'Test the whole automation' }));
    const result = await screen.findByRole('region', { name: 'Test run' });
    expect(testRequests(fixture)).toHaveLength(1);
    expect(testRequests(fixture)[0]!.options.body).toEqual({});
    const [created, emailed] = within(result).getAllByRole('listitem');
    expect(created!.textContent).toContain('Create a record');
    expect(created!.textContent).toContain('Done');
    expect(created!.textContent).toContain('Took 0.25 s');
    expect(within(created!).getByText('rec00000000000009')).toBeDefined();
    expect(emailed!.textContent).toContain('Send an email');
    expect(emailed!.textContent).toContain('Failed');
    expect(emailed!.textContent).toContain(
      'Riosoma can’t reach the server.  Check your connection and try again.',
    );
    expect(within(emailed!).getByText('SMTP 421')).toBeDefined();
    // The outcome is announced as well as shown.
    expect(document.querySelector('[aria-live="polite"]')!.textContent).toContain('Failed');
  });

  it('run with a record chosen from a search of the trigger’s table', async () => {
    const fixture = await mount();
    const choose = screen.getByRole('combobox', { name: 'Test with' });
    expect((choose as HTMLInputElement).value).toBe('The newest matching record');
    await userEvent.clear(choose);
    await userEvent.type(choose, 'Record 2');
    await userEvent.click(await screen.findByRole('option', { name: 'Record 2' }));
    // The choice has to land before the run starts, however busy the machine is.
    await waitFor(() => expect((choose as HTMLInputElement).value).toBe('Record 2'));
    await userEvent.click(screen.getByRole('button', { name: 'Test the whole automation' }));
    await screen.findByRole('region', { name: 'Test run' });
    expect(testRequests(fixture)[0]!.options.body).toEqual({ recordId: fixture.tasks.recordId(1) });
    expect(
      fixture.server.requests.some((request) =>
        request.path.includes(`/api/tables/${fixture.tasks.id}/records/search`),
      ),
    ).toBe(true);
  });

  it('save waiting edits before running', async () => {
    const fixture = await mount();
    const [, email] = screen
      .getAllByRole('region')
      .filter((region) => region.closest('.rio-automation-flow__steps'));
    await userEvent.type(within(email!).getByRole('textbox', { name: 'Subject' }), '!');
    await userEvent.click(screen.getByRole('button', { name: 'Test the whole automation' }));
    await screen.findByRole('region', { name: 'Test run' });
    const order = fixture.server.requests
      .filter((request) => request.path.endsWith('/commands') || request.path.endsWith('/test'))
      .map((request) =>
        request.path.endsWith('/test') ? 'test' : CommandBatch.parse(request.options.body).commands[0]!.kind,
      );
    expect(order).toEqual(['automation.update', 'test']);
    // The edit went to the draft, which is what a test runs.
    expect(
      fixture.server.database(fixture.databaseId).automation(fixture.automationId).draft?.config.steps[1],
    ).toMatchObject({
      subject: 'New task!',
    });
  });

  it('aren’t offered to people who can’t change the schema', async () => {
    await mount('reader');
    expect(screen.queryByRole('button', { name: 'Test the whole automation' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Test with' })).toBeNull();
  });
});

describe('run history', () => {
  it('says when there are no runs yet', async () => {
    await mount();
    await userEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    expect(await screen.findByText('No runs yet.')).toBeDefined();
  });

  it('lists runs newest first, opens each to its steps, and pages', async () => {
    const fixture = await mount('reader');
    fixture.server.runsPageSize = 2;
    fixture.server.automationRuns.set(fixture.automationId, [
      run(fixture.automationId, {
        state: 'failed',
        steps: [
          {
            stepId: 'make_task',
            state: 'succeeded',
            ms: 200,
            output: { recordId: 'rec00000000000007' },
            error: null,
          },
          {
            stepId: 'mail_team',
            state: 'failed',
            ms: 10,
            output: null,
            error: { messageKey: 'errors.internal' },
          },
        ],
      }),
      run(fixture.automationId, { test: true }),
      run(fixture.automationId, {
        state: 'skipped',
        steps: [],
        trigger: {
          kind: 'recordCreated',
          recordId: null,
          at: new Date(Date.now() - 86_400_000).toISOString(),
        },
        startedAt: null,
        finishedAt: null,
      }),
    ]);
    await userEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    const panel = screen.getByRole('tabpanel', { name: 'Runs' });
    const summaries = await within(panel).findAllByRole('button', { name: /A record is created/ });
    expect(summaries.map((summary) => summary.textContent)).toEqual([
      'FailedA record is created3 hours agoTook 1.5 s',
      'DoneTestA record is created3 hours agoTook 1.5 s',
    ]);
    await userEvent.click(summaries[0]!);
    expect(summaries[0]!.getAttribute('aria-expanded')).toBe('true');
    const steps = within(panel)
      .getAllByRole('listitem')
      .filter((item) => item.closest('.rio-automation-run__steps'));
    expect(steps[0]!.textContent).toContain('Create a record');
    expect(within(steps[0]!).getByText('recordId')).toBeDefined();
    expect(within(steps[0]!).getByText('rec00000000000007')).toBeDefined();
    expect(steps[1]!.textContent).toContain('Something went wrong on the server.');
    await userEvent.click(within(panel).getByRole('button', { name: 'Show more' }));
    await waitFor(() =>
      expect(within(panel).getAllByRole('button', { name: /A record is created/ })).toHaveLength(3),
    );
    expect(within(panel).getAllByRole('button', { name: /A record is created/ })[2]!.textContent).toBe(
      'SkippedA record is createdyesterday',
    );
    expect(within(panel).queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(
      fixture.server.requests
        .filter((request) => request.path.includes('/runs'))
        .map((request) => request.path),
    ).toEqual([
      `/api/automations/${fixture.automationId}/runs`,
      `/api/automations/${fixture.automationId}/runs?cursor=2`,
    ]);
  });

  it('includes a test run once it finishes', async () => {
    const fixture = await mount();
    await userEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    expect(await screen.findByText('No runs yet.')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Test the whole automation' }));
    const panel = screen.getByRole('tabpanel', { name: 'Runs' });
    expect(await within(panel).findByRole('button', { name: /Test/ })).toBeDefined();
    expect(fixture.server.automationRuns.get(fixture.automationId)).toHaveLength(1);
  });
});

describe('celebrations', () => {
  let shown: Celebration[] = [];
  let stop: () => void = () => undefined;
  beforeEach(() => {
    // Test runs earlier in the file celebrated too, and the ten-minute quiet would hold these back.
    localStorage.clear();
    shown = [];
    stop = celebrations.subscribe((celebration) => shown.push(celebration));
  });
  afterEach(() => {
    stop();
    localStorage.clear();
  });
  const names = () => shown.map((celebration) => [celebration.name, celebration.cause]);

  /** A run that happened on its own, which the history finds when it reads again. */
  async function ranOnItsOwn(
    fixture: Awaited<ReturnType<typeof mount>>,
    overrides: Partial<AutomationRun> = {},
  ) {
    fixture.server.automationRuns.set(fixture.automationId, [
      run(fixture.automationId, overrides),
      ...(fixture.server.automationRuns.get(fixture.automationId) ?? []),
    ]);
    await act(() => fixture.client.invalidateQueries({ queryKey: runsKey(fixture.automationId) }));
  }

  it('celebrate the first run that works, set off by a record, as someone else’s, once', async () => {
    const fixture = await mount();
    await userEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    expect(await screen.findByText('No runs yet.')).toBeDefined();
    await ranOnItsOwn(fixture, { state: 'failed' });
    expect(shown).toEqual([]);
    await ranOnItsOwn(fixture);
    await waitFor(() => expect(names()).toEqual([['automationFirstRun', 'others']]));
    await ranOnItsOwn(fixture);
    await waitFor(() =>
      expect(
        screen.getByRole('tabpanel', { name: 'Runs' }).querySelectorAll('.rio-automation-run'),
      ).toHaveLength(3),
    );
    expect(shown).toHaveLength(1);
  });

  it('celebrate a first test run that works as the person’s own, once', async () => {
    const fixture = await mount();
    await userEvent.click(screen.getByRole('button', { name: 'Test the whole automation' }));
    await waitFor(() => expect(names()).toEqual([['automationFirstRun', 'you']]));
    await userEvent.click(screen.getByRole('button', { name: 'Test the whole automation' }));
    await waitFor(() => expect(fixture.server.automationRuns.get(fixture.automationId)).toHaveLength(2));
    expect(shown).toHaveLength(1);
  });

  it('don’t celebrate an automation that had run before it was opened', async () => {
    const fixture = await mount('owner', { lastRunAt: new Date(Date.now() - 3_600_000).toISOString() });
    await userEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    expect(await screen.findByText('No runs yet.')).toBeDefined();
    await ranOnItsOwn(fixture);
    await waitFor(() =>
      expect(
        screen.getByRole('tabpanel', { name: 'Runs' }).querySelectorAll('.rio-automation-run'),
      ).toHaveLength(1),
    );
    expect(shown).toEqual([]);
  });
});
