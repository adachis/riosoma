import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toastQueue } from '@riosoma/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TriggerCard } from './TriggerCard';
import { renderShell } from '../shell/test-support';
import type { AutomationTrigger } from '@riosoma/contracts';
import {
  automationFixture,
  automationMeta,
  bridgeFetch,
  renderScreen,
  savedConfig,
  type AutomationFixture,
  type FixtureOptions,
} from './test-support';

const fixtures: AutomationFixture[] = [];
beforeEach(() => {
  // A fixed zone keeps new schedules the same on every machine.
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
    ...new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).resolvedOptions(),
    timeZone: 'America/Denver',
  });
});
afterEach(() => {
  cleanup();
  fixtures.splice(0).forEach((fixture) => fixture.session.close());
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(
  trigger: (ids: Omit<AutomationFixture, 'server' | 'session'>) => AutomationTrigger,
  options: FixtureOptions & { enabled?: boolean; stoppedBecause?: string } = {},
) {
  const fixture = await automationFixture({
    ...options,
    automations: (ids) => [
      automationMeta(
        ids.databaseId,
        'Welcome new tasks',
        { trigger: trigger(ids) },
        { enabled: options.enabled ?? false, stoppedBecause: options.stoppedBecause ?? null },
      ),
    ],
  });
  fixtures.push(fixture);
  vi.stubGlobal('fetch', bridgeFetch(fixture.server));
  const automationId = fixture.session.getSchema().automations[0]!.id;
  renderScreen(fixture, automationId);
  await screen.findByRole('switch');
  return { ...fixture, automationId, saved: () => savedConfig(fixture, automationId) };
}

async function choose(label: RegExp, option: string, scope: HTMLElement = document.body) {
  await userEvent.click(within(scope).getByRole('button', { name: label }));
  await userEvent.click(
    await screen.findByRole('option', {
      name: (accessibleName) => accessibleName === option || accessibleName.startsWith(`${option} `),
    }),
  );
}

const card = (name: string) => screen.getByRole('region', { name });

describe('the automation screen', () => {
  it('names the automation and saves a new name', async () => {
    const { server, databaseId, automationId } = await mount(({ tasks }) => ({
      kind: 'recordCreated',
      tableId: tasks.id,
    }));
    expect(screen.getByRole('heading', { level: 2, name: 'Welcome new tasks' })).toBeDefined();
    const name = screen.getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Greet tasks{Enter}');
    await waitFor(() =>
      expect(server.database(databaseId).automation(automationId).name).toBe('Greet tasks'),
    );
  });

  it('explains that turning it on acts as you, then says who it runs as', async () => {
    const { server, databaseId, automationId } = await mount(({ tasks }) => ({
      kind: 'recordCreated',
      tableId: tasks.id,
    }));
    const off = screen.getByRole('switch', {
      name: 'Off',
      description: 'When it’s on, it makes changes as you, with your permissions.',
    });
    expect((off as HTMLInputElement).checked).toBe(false);
    await userEvent.click(off);
    const on = screen.getByRole('switch', { name: 'On', description: 'Runs as Person' });
    expect((on as HTMLInputElement).checked).toBe(true);
    await waitFor(() =>
      expect(server.database(databaseId).automation(automationId)).toMatchObject({
        enabled: true,
        runAsId: server.userId,
      }),
    );
  });

  it('says why a stopped automation stopped, and turns it back on', async () => {
    const { server, databaseId, automationId } = await mount(
      ({ tasks }) => ({ kind: 'recordCreated', tableId: tasks.id }),
      { stoppedBecause: 'data.access.denied' },
    );
    const banner = screen.getByRole('alert', {
      name: 'This automation stopped: You don’t have access to do that in this database.',
    });
    expect(banner.textContent).toContain('When it’s on, it makes changes as you, with your permissions.');
    await userEvent.click(within(banner).getByRole('button', { name: 'Turn on' }));
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() =>
      expect(server.database(databaseId).automation(automationId)).toMatchObject({
        enabled: true,
        stoppedBecause: null,
      }),
    );
  });
});

describe('the trigger card', () => {
  it('starts with a record in a table, and follows a new table', async () => {
    const { saved, people } = await mount(({ tasks }) => ({ kind: 'recordCreated', tableId: tasks.id }));
    const trigger = card('When');
    expect(within(trigger).getByRole('button', { name: /When/ }).textContent).toContain(
      'A record is created',
    );
    await choose(/Table/, 'People', trigger);
    await waitFor(() => expect(saved().trigger).toEqual({ kind: 'recordCreated', tableId: people.id }));
  });

  it('watches chosen fields when a record is updated, or any field', async () => {
    const { saved, tasks } = await mount(({ tasks }) => ({ kind: 'recordCreated', tableId: tasks.id }));
    await choose(/When/, 'A record is updated', card('When'));
    const fields = screen.getByRole('group', { name: 'When these fields change', description: 'Any field' });
    await userEvent.click(within(fields).getByRole('checkbox', { name: 'Email' }));
    await waitFor(() =>
      expect(saved().trigger).toEqual({ kind: 'recordUpdated', tableId: tasks.id, fieldIds: [tasks.email] }),
    );
    expect(within(card('When')).queryByText('Any field')).toBeNull();
  });

  it('matches through a view or its own filter', async () => {
    const { saved, tasks } = await mount(({ tasks }) => ({ kind: 'recordCreated', tableId: tasks.id }));
    await choose(/When/, 'A record starts matching', card('When'));
    expect(within(card('When')).getByRole('button', { name: /View/ }).textContent).toContain('No view');
    await choose(/View/, 'Grid', card('When'));
    await userEvent.click(within(card('When')).getByRole('button', { name: 'Add condition' }));
    await waitFor(() =>
      expect(saved().trigger).toMatchObject({
        kind: 'recordMatches',
        tableId: tasks.id,
        viewId: tasks.viewId,
        filter: { conjunction: 'and', conditions: [{ fieldId: tasks.name, operator: 'contains' }] },
      }),
    );
  });

  it('starts from a form', async () => {
    const { saved, tasks } = await mount(({ tasks }) => ({ kind: 'recordCreated', tableId: tasks.id }));
    await choose(/When/, 'A form is submitted', card('When'));
    expect(within(card('When')).getByRole('button', { name: /Form/ }).textContent).toContain('Signup');
    await waitFor(() => expect(saved().trigger).toEqual({ kind: 'formSubmitted', viewId: tasks.formId }));
  });

  it('runs on a schedule with an interval, a time, a weekday, and a time zone', async () => {
    const { saved } = await mount(({ tasks }) => ({ kind: 'recordCreated', tableId: tasks.id }));
    await choose(/When/, 'On a schedule', card('When'));
    const trigger = card('When');
    const every = within(trigger).getByRole('group', { name: 'Every' });
    expect(within(every).getByRole('button', { name: /Every/ }).textContent).toContain('day');
    const count = within(every).getByRole('textbox', { name: 'Every' });
    await userEvent.clear(count);
    await userEvent.type(count, '2');
    await userEvent.tab();
    expect(within(every).getByRole('button', { name: /Every/ }).textContent).toContain('days');
    await choose(/Every/, 'weeks', every);
    await choose(/At$/, '7:30 AM', trigger);
    await choose(/On$/, 'Friday', trigger);
    const zone = within(trigger).getByRole('combobox', { name: 'Time zone' });
    expect((zone as HTMLInputElement).value).toBe('America/Denver');
    await userEvent.clear(zone);
    await userEvent.type(zone, 'Europe/Par');
    await userEvent.click(await screen.findByRole('option', { name: /^Europe\/Paris(?: |$)/ }));
    await waitFor(() =>
      expect(saved().trigger).toEqual({
        kind: 'schedule',
        every: { unit: 'week', n: 2 },
        at: '07:30',
        weekday: 5,
        timeZone: 'Europe/Paris',
      }),
    );
  });

  it('shows a webhook’s address with a Copy button and a note', async () => {
    const { server, databaseId, automationId } = await mount(({ tasks }) => ({
      kind: 'recordCreated',
      tableId: tasks.id,
    }));
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await choose(/When/, 'Another app calls a webhook', card('When'));
    const trigger = card('When');
    expect(trigger.textContent).toContain(
      'Anything that sends JSON to this address starts the automation.  Keep it private.',
    );
    const address = await within(trigger).findByRole('textbox', { name: 'Webhook address' });
    const path = server.database(databaseId).automation(automationId).webhookPath!;
    expect((address as HTMLInputElement).value).toBe(new URL(path, window.location.origin).toString());
    await userEvent.click(within(trigger).getByRole('button', { name: 'Copy address' }));
    expect(writeText).toHaveBeenCalledWith(new URL(path, window.location.origin).toString());
    expect(await screen.findByText('Copied the address')).toBeDefined();
  });
});

describe('conditions', () => {
  it('adds an Only if card with the filter editor', async () => {
    const { saved, tasks } = await mount(({ tasks }) => ({ kind: 'recordCreated', tableId: tasks.id }));
    expect(screen.queryByRole('region', { name: 'Only if' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add conditions' }));
    const conditions = card('Only if');
    await choose(/Field/, 'Number', conditions);
    await choose(/Condition/, '>', conditions);
    await userEvent.type(within(conditions).getByRole('textbox', { name: 'Value' }), '5');
    await waitFor(() =>
      expect(saved().conditions).toMatchObject({
        conjunction: 'and',
        conditions: [{ fieldId: tasks.number, operator: 'gt', value: 5 }],
      }),
    );
  });

  it('isn’t offered when no record starts the automation', async () => {
    await mount(() => ({ kind: 'webhook' }));
    expect(screen.queryByRole('button', { name: 'Add conditions' })).toBeNull();
  });
});

it('describes an empty watched-field selection in a long list', async () => {
  const fixture = await automationFixture();
  fixtures.push(fixture);
  const schema = fixture.session.getSchema();
  const fields = schema.fields.get(fixture.tasks.id)!;
  const many = Array.from({ length: 12 }, (_, index) => ({
    ...fields[0]!,
    id: `fld${String(index).padStart(14, '0')}`,
    name: `Field ${index}`,
  }));
  const automation = automationMeta(fixture.databaseId, 'Updated records', {
    trigger: { kind: 'recordUpdated', tableId: fixture.tasks.id, fieldIds: [] },
  });
  renderShell(
    <TriggerCard
      session={fixture.session}
      schema={{ ...schema, fields: new Map([[fixture.tasks.id, many]]) }}
      automation={automation}
      config={automation.config}
      problems={new Set()}
      readOnly={false}
      fallbackTableId={fixture.tasks.id}
      onChange={vi.fn()}
    />,
  );
  expect(
    screen.getByRole('listbox', { name: 'When these fields change', description: 'Any field' }),
  ).toBeTruthy();
});
