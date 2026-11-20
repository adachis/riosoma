import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toastQueue } from '@riosoma/ui';
import {
  AutomationConfig,
  type AutomationMeta,
  type AutomationRun,
  type DatabaseRole,
} from '@riosoma/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SERVER_MESSAGES } from '../../../messages/server';
import {
  automationFixture,
  automationMeta,
  bridgeFetch,
  renderScreen,
  type AutomationFixture,
  type ConfigInput,
} from './test-support';

const fixtures: AutomationFixture[] = [];
afterEach(() => {
  cleanup();
  fixtures.splice(0).forEach((fixture) => fixture.session.close());
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Ids = Omit<AutomationFixture, 'server' | 'session'>;

const emailing =
  (subject: string) =>
  (ids: Ids): ConfigInput => ({
    trigger: { kind: 'recordCreated', tableId: ids.tasks.id },
    steps: [
      { id: 'make_task', kind: 'createRecord', tableId: ids.tasks.id, values: { [ids.tasks.name]: 'Next' } },
      { id: 'mail_team', kind: 'sendEmail', to: ['team@example.test'], subject, body: '' },
    ],
  });

async function mount(
  options: {
    role?: DatabaseRole;
    extra?: (ids: Ids) => Partial<AutomationMeta>;
  } = {},
) {
  const fixture = await automationFixture({
    role: options.role ?? 'owner',
    automations: (ids) => [
      automationMeta(ids.databaseId, 'Follow up', emailing('New task')(ids), {
        version: 1,
        draft: null,
        ...options.extra?.(ids),
      }),
    ],
  });
  fixtures.push(fixture);
  vi.stubGlobal('fetch', bridgeFetch(fixture.server));
  const automationId = fixture.session.getSchema().automations[0]!.id;
  const { client } = renderScreen(fixture, automationId);
  await screen.findByRole('switch');
  const stored = () => fixture.server.database(fixture.databaseId).automation(automationId);
  return { ...fixture, automationId, client, stored };
}

const subjectBox = () => {
  const [, email] = screen
    .getAllByRole('region')
    .filter((region) => region.closest('.rio-automation-flow__steps'));
  return within(email!).getByRole('textbox', { name: 'Subject' });
};

/** A moment to the second, as the history names the run another came from. */
const exactly = (at: string) =>
  new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(at));

function run(automationId: string, overrides: Partial<AutomationRun> = {}): AutomationRun {
  const at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  return {
    id: `run_${Math.random().toString(36).slice(2)}`,
    automationId,
    state: 'failed',
    trigger: { kind: 'recordCreated', recordId: 'rec00000000000001', at },
    test: false,
    version: 1,
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
        state: 'failed',
        ms: 20,
        output: null,
        error: { messageKey: 'errors.internal' },
      },
    ],
    startedAt: at,
    finishedAt: new Date(Date.parse(at) + 500).toISOString(),
    ...overrides,
  };
}

describe('drafts', () => {
  it.each(['Publish', 'Test the whole automation'])('keeps rejected edits and stops %s', async (action) => {
    const fixture = await mount({
      extra: (ids) => ({
        publishedAt: new Date().toISOString(),
        draft: {
          config: AutomationConfig.parse(emailing('Saved draft')(ids)),
          updatedAt: '',
          updatedBy: null,
        },
      }),
    });
    const commands = vi.spyOn(fixture.session, 'run');
    fixture.server.rejectNext('errors.forbidden');
    await userEvent.type(subjectBox(), '!');
    await userEvent.click(screen.getByRole('button', { name: action }));
    await waitFor(() => expect(commands).toHaveBeenCalled());
    await waitFor(() => expect(subjectBox().textContent).toBe('Saved draft!'));
    expect(fixture.stored().version).toBe(1);
    expect(fixture.stored().draft?.config.steps[1]).toMatchObject({ subject: 'Saved draft' });
    expect(
      commands.mock.calls.flatMap(([inputs]) => inputs).some((input) => input.kind === 'automation.publish'),
    ).toBe(false);
    expect(fixture.server.requests.some((request) => request.path.endsWith('/test'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(fixture.stored().version).toBe(2));
    expect(fixture.stored().config.steps[1]).toMatchObject({ subject: 'Saved draft!' });
  });

  it('turns off a published automation with invalid local paths and keeps the edits', async () => {
    const fixture = await mount({
      extra: (ids) => ({
        enabled: true,
        publishedAt: new Date().toISOString(),
        config: AutomationConfig.parse({
          trigger: { kind: 'recordCreated', tableId: ids.tasks.id },
          steps: [
            {
              id: 'switch01',
              kind: 'switch',
              value: '',
              cases: [
                { id: 'path01', value: 'ready', steps: [] },
                { id: 'path02', value: 'later', steps: [] },
              ],
              otherwise: [],
            },
          ],
        }),
      }),
    });
    const paths = screen.getAllByRole('textbox', { name: 'Path value' });
    await userEvent.clear(paths[1]!);
    await userEvent.type(paths[1]!, 'ready');
    await userEvent.click(screen.getByRole('switch', { name: 'On' }));
    await waitFor(() => expect(fixture.stored().enabled).toBe(false));
    expect((paths[1] as HTMLInputElement).value).toBe('ready');
    expect(fixture.stored().config.steps[0]).toMatchObject({
      cases: [{ value: 'ready' }, { value: 'later' }],
    });
  });

  it('saves edits to a draft, marked as not live, until it’s published', async () => {
    const fixture = await mount();
    expect(screen.queryByText('Draft: not live yet')).toBeNull();
    await userEvent.type(subjectBox(), '!');
    expect(await screen.findByText('Draft: not live yet')).toBeDefined();
    await waitFor(() =>
      expect(fixture.stored().draft?.config.steps[1]).toMatchObject({ subject: 'New task!' }),
    );
    // What runs is still the published version.
    expect(fixture.stored().config.steps[1]).toMatchObject({ subject: 'New task' });
    expect(screen.getByText(/Version 1 keeps running until you publish/)).toBeDefined();

    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(fixture.stored()).toMatchObject({ version: 2, draft: null }));
    expect(fixture.stored().config.steps[1]).toMatchObject({ subject: 'New task!' });
    await waitFor(() => expect(screen.queryByText('Draft: not live yet')).toBeNull());
    expect(subjectBox().textContent).toBe('New task!');
  });

  it('discards a draft after asking, back to what’s published', async () => {
    const fixture = await mount();
    await userEvent.type(subjectBox(), ' soon');
    await screen.findByText('Draft: not live yet');
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard the draft?' });
    expect(dialog.textContent).toContain('Version 1 stays as it is.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(fixture.stored().draft).toBeNull());
    await waitFor(() => expect(subjectBox().textContent).toBe('New task'));
    expect(screen.queryByText('Draft: not live yet')).toBeNull();
  });

  it('shows someone else’s draft as it changes', async () => {
    const fixture = await mount();
    const config = AutomationConfig.parse(
      emailing('From a teammate')({
        databaseId: fixture.databaseId,
        tasks: fixture.tasks,
        people: fixture.people,
      }),
    );
    fixture.server.remote(fixture.databaseId, [
      { kind: 'automation.update', automationId: fixture.automationId, config },
    ]);
    expect(await screen.findByText('Draft: not live yet')).toBeDefined();
    await waitFor(() => expect(subjectBox().textContent).toBe('From a teammate'));
  });

  it('shows people who can’t change the schema what’s published, without the badge', async () => {
    await mount({
      role: 'reader',
      extra: (ids) => ({
        draft: {
          config: AutomationConfig.parse(emailing('Unpublished')(ids)),
          updatedAt: '',
          updatedBy: null,
        },
      }),
    });
    expect(screen.queryByText('Draft: not live yet')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });
});

it('shows the complete first publication even when its draft matches the stored configuration', async () => {
  await mount({
    extra: (ids) => {
      const config = AutomationConfig.parse(emailing('First publication')(ids));
      return {
        config,
        publishedAt: null,
        draft: { config, updatedAt: new Date().toISOString(), updatedBy: null },
      };
    },
  });
  await userEvent.click(screen.getByText('Changes from the published version'));
  const sections = document.querySelectorAll('.rio-automation-diff section');
  expect(sections).toHaveLength(3);
  for (const section of sections) expect(section.querySelector('pre')?.textContent).toBe('null');
  expect(document.querySelector('.rio-automation-diff')?.textContent).toContain('First publication');
});

describe('versions', () => {
  it('lists the published version and the kept ones, and restores one as the draft', async () => {
    const fixture = await mount({ extra: () => ({ version: 2, publishedAt: new Date().toISOString() }) });
    const ids = { databaseId: fixture.databaseId, tasks: fixture.tasks, people: fixture.people };
    fixture.server.database(fixture.databaseId).automationVersions.set(fixture.automationId, [
      {
        version: 1,
        config: AutomationConfig.parse(emailing('The first one')(ids)),
        publishedAt: new Date(Date.now() - 86_400_000).toISOString(),
        publishedBy: null,
      },
    ]);
    await userEvent.click(screen.getByRole('tab', { name: 'Versions' }));
    const panel = screen.getByRole('tabpanel', { name: 'Versions' });
    const rows = await within(panel).findAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Version 2PublishedA record is created2 stepsPublished just now',
      'Version 1A record is created2 stepsPublished yesterdayRestore as draft',
    ]);
    await userEvent.click(within(rows[1]!).getByRole('button', { name: 'Restore as draft' }));
    // It comes back as the draft, on the cards.
    expect(await screen.findByRole('tabpanel', { name: 'Edit' })).toBeDefined();
    await waitFor(() =>
      expect(fixture.stored().draft?.config.steps[1]).toMatchObject({ subject: 'The first one' }),
    );
    expect(fixture.stored().version).toBe(2);
    await waitFor(() => expect(subjectBox().textContent).toBe('The first one'));
  });
});

describe('rerun and resume', () => {
  it('reruns a run and goes on from the step that failed', async () => {
    const fixture = await mount({ extra: () => ({ enabled: true }) });
    const failed = run(fixture.automationId);
    fixture.server.automationRuns.set(fixture.automationId, [failed]);
    await userEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    const panel = screen.getByRole('tabpanel', { name: 'Runs' });
    const [summary] = await within(panel).findAllByRole('button', { name: /A record is created/ });
    expect(summary!.textContent).toContain('Version 1');
    await userEvent.click(summary!);
    await userEvent.click(within(panel).getByRole('button', { name: 'Resume from here' }));
    expect(await within(panel).findByText(/Queued a new run/)).toBeDefined();
    const resumed = fixture.server.automationRuns.get(fixture.automationId)![0]!;
    expect(resumed).toMatchObject({
      state: 'queued',
      from: { runId: failed.id, kind: 'resume', stepId: 'mail_team' },
      steps: [{ stepId: 'make_task', reused: true }],
    });
    // The new run shows at the top, marked as resumed, with the step it kept.
    await waitFor(() =>
      expect(within(panel).getAllByRole('button', { name: /A record is created/ })[0]!.textContent).toContain(
        'Resumed',
      ),
    );
    const [top, original] = within(panel).getAllByRole('button', { name: /A record is created/ });
    await userEvent.click(top!);
    expect(await within(panel).findByText('Kept from the earlier run')).toBeDefined();
    expect(within(panel).getByText(/Went on from step 2 of an earlier run/)).toBeDefined();
    // The run it came from is a control, named with when that run started to the second.
    if (original!.getAttribute('aria-expanded') === 'true') await userEvent.click(original!);
    expect(original!.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(
      within(panel).getByRole('button', { name: `Open the run from ${exactly(failed.startedAt!)}` }),
    );
    await waitFor(() => expect(original!.getAttribute('aria-expanded')).toBe('true'));
    expect(document.activeElement).toBe(original);

    const reruns = within(panel).getAllByRole('button', { name: 'Rerun' });
    await userEvent.click(reruns.at(-1)!);
    await waitFor(() =>
      expect(fixture.server.automationRuns.get(fixture.automationId)![0]).toMatchObject({
        from: { runId: failed.id, kind: 'rerun' },
      }),
    );
    expect(
      fixture.server.requests
        .filter((request) => request.options.method === 'POST')
        .map((request) => request.path),
    ).toEqual([
      `/api/automations/${fixture.automationId}/runs/${failed.id}/resume`,
      `/api/automations/${fixture.automationId}/runs/${failed.id}/rerun`,
    ]);
  });

  it('opens the run a rerun came from, loading more of the list until it’s there', async () => {
    const fixture = await mount({ extra: () => ({ enabled: true }) });
    const source = run(fixture.automationId, {
      startedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
    });
    const rerun = run(fixture.automationId, {
      state: 'succeeded',
      from: { runId: source.id, kind: 'rerun', at: source.startedAt },
    });
    fixture.server.runsPageSize = 1;
    fixture.server.automationRuns.set(fixture.automationId, [rerun, source]);
    await userEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    const panel = screen.getByRole('tabpanel', { name: 'Runs' });
    const [summary] = await within(panel).findAllByRole('button', { name: /A record is created/ });
    await userEvent.click(summary!);
    expect(within(panel).getByText(/A rerun of an earlier run/)).toBeDefined();
    expect(within(panel).getAllByRole('button', { name: /A record is created/ })).toHaveLength(1);
    await userEvent.click(
      within(panel).getByRole('button', { name: `Open the run from ${exactly(source.startedAt!)}` }),
    );
    await waitFor(() =>
      expect(within(panel).getAllByRole('button', { name: /A record is created/ })).toHaveLength(2),
    );
    const [, opened] = within(panel).getAllByRole('button', { name: /A record is created/ });
    await waitFor(() => expect(opened!.getAttribute('aria-expanded')).toBe('true'));
    expect(document.activeElement).toBe(opened);
  });

  it('says why a run can’t go on from a step', async () => {
    const fixture = await mount({ extra: () => ({ enabled: true }) });
    fixture.server.automationRuns.set(fixture.automationId, [run(fixture.automationId)]);
    fixture.server.resumeRefusal = { messageKey: 'automations.resume.stepChanged', params: { step: '1' } };
    await userEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    const panel = screen.getByRole('tabpanel', { name: 'Runs' });
    const [summary] = await within(panel).findAllByRole('button', { name: /A record is created/ });
    await userEvent.click(summary!);
    await userEvent.click(within(panel).getByRole('button', { name: 'Resume from here' }));
    await waitFor(() =>
      expect(panel.textContent).toContain(
        'Step 1 changed since this run, so what it did may not hold.  Rerun the whole automation instead.',
      ),
    );
    expect(fixture.server.automationRuns.get(fixture.automationId)).toHaveLength(1);
  });

  it('says the same thing in the help and the refusal about who tests act as', () => {
    const help = readFileSync(
      join(import.meta.dirname, '../../../../../../docs/modules/databases/automations/en-US.md'),
      'utf8',
    );
    const section = (heading: string) => help.split(`## ${heading}\n`)[1]!.split('\n## ')[0]!;
    // A test, whole or single-step, acts as the tester, never as the run owner, and isn't rerun.
    expect(section('Testing')).toContain(
      'A single-step test acts as you, the person testing, as a whole test does',
    );
    expect(section('Testing')).not.toContain('run owner');
    expect(section('Running a run again')).toContain(
      "Tests are never run again this way, since they're tests, and a test acts as the person testing.",
    );
    expect(section('Running a run again')).not.toContain('run owner');
    expect(SERVER_MESSAGES['automations.rerun.test']!.message).toBe(
      'Tests aren’t run again.  A test, whole or single-step, acts as the person who ran it.  Test again instead.',
    );
  });

  it('isn’t offered to people who can’t change the schema, or for tests', async () => {
    const fixture = await mount({ role: 'editor' });
    fixture.server.automationRuns.set(fixture.automationId, [run(fixture.automationId)]);
    await userEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    const panel = screen.getByRole('tabpanel', { name: 'Runs' });
    const [summary] = await within(panel).findAllByRole('button', { name: /A record is created/ });
    await userEvent.click(summary!);
    expect(within(panel).queryByRole('button', { name: 'Rerun' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Resume from here' })).toBeNull();
    cleanup();
    const owner = await mount();
    owner.server.automationRuns.set(owner.automationId, [run(owner.automationId, { test: true })]);
    await userEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    const runs = screen.getByRole('tabpanel', { name: 'Runs' });
    const [test] = await within(runs).findAllByRole('button', { name: /A record is created/ });
    await userEvent.click(test!);
    expect(within(runs).queryByRole('button', { name: 'Rerun' })).toBeNull();
  });
});
