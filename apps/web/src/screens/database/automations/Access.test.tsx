import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toastQueue } from '@riosoma/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseRole } from '@riosoma/contracts';
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

async function mount(role: DatabaseRole = 'owner') {
  const fixture = await automationFixture({
    role,
    automations: ({ databaseId, tasks }) => [
      automationMeta(
        databaseId,
        'Follow up',
        {
          trigger: { kind: 'recordUpdated', tableId: tasks.id, fieldIds: [] },
          conditions: {
            conjunction: 'and',
            conditions: [{ id: 'first', fieldId: tasks.number, operator: 'gt', value: 1 }],
          },
          steps: [
            { id: 'make_task', kind: 'createRecord', tableId: tasks.id, values: { [tasks.name]: 'Next' } },
            {
              id: 'mail_team',
              kind: 'sendEmail',
              to: ['team@example.test'],
              subject: 'New task',
              body: 'Hi',
            },
            {
              id: 'call_home',
              kind: 'callWebhook',
              url: 'https://example.test',
              headers: { 'X-Test': '1' },
              body: '{}',
            },
          ],
        },
        { enabled: true, runAsId: 'usr00000000000009' },
      ),
    ],
  });
  fixtures.push(fixture);
  vi.stubGlobal('fetch', bridgeFetch(fixture.server));
  renderScreen(fixture, fixture.session.getSchema().automations[0]!.id);
  await screen.findByRole('switch');
  return fixture;
}

const ROLES = ['button', 'textbox', 'combobox', 'switch', 'tab', 'checkbox', 'region', 'menuitem'] as const;
/** The automation's own name field, as opposed to a step's value for a field called Name */
const nameField = () =>
  screen.queryAllByRole('textbox', { name: 'Name' }).find((element) => element.tagName === 'INPUT') ?? null;

describe('access', () => {
  it('names every control', async () => {
    await mount();
    for (const role of ROLES)
      expect(screen.queryAllByRole(role, { name: /\S/ }), role).toHaveLength(
        screen.queryAllByRole(role).length,
      );
  });

  it('reaches every part of the flow from the keyboard, in reading order', async () => {
    await mount();
    const flow = screen
      .getAllByRole('region')
      .filter((region) => region.closest('.rio-automation-flow__steps'));
    const expected = [
      nameField()!,
      screen.getByRole('switch', { name: 'On' }),
      screen.getByRole('combobox', { name: 'Test with' }),
      screen.getByRole('button', { name: 'Test the whole automation' }),
      screen.getByRole('tab', { name: 'Edit' }),
      within(screen.getByRole('region', { name: 'When' })).getByRole('button', { name: /When/ }),
      within(screen.getByRole('region', { name: 'When' })).getByRole('checkbox', { name: 'Email' }),
      within(screen.getByRole('region', { name: 'Only if' })).getByRole('textbox', { name: 'Value' }),
      within(flow[0]!).getByRole('button', { name: 'Move down' }),
      within(flow[0]!).getByRole('textbox', { name: 'Name' }),
      within(flow[0]!).getByRole('button', { name: 'Insert a value' }),
      within(flow[1]!).getByRole('textbox', { name: 'Message' }),
      within(flow[2]!).getByRole('textbox', { name: 'JSON body' }),
      screen.getAllByRole('button', { name: 'Add a step' }).at(-1)!,
    ];
    const reached: Element[] = [];
    document.body.focus();
    for (let press = 0; press < 120 && reached.length < expected.length; press++) {
      await userEvent.tab();
      if (document.activeElement === expected[reached.length]) reached.push(document.activeElement);
    }
    expect(reached).toHaveLength(expected.length);
  });

  it('fits a phone: every control is still there, named, and reachable', async () => {
    const emulator = window as unknown as {
      happyDOM?: { setViewport(size: { width: number; height: number }): void };
    };
    emulator.happyDOM?.setViewport({ width: 375, height: 812 });
    await mount();
    expect(window.innerWidth).toBe(375);
    for (const role of ROLES)
      expect(screen.queryAllByRole(role, { name: /\S/ }), role).toHaveLength(
        screen.queryAllByRole(role).length,
      );
    const unreachable = [
      ...screen.getAllByRole('button'),
      ...screen.getAllByRole('textbox'),
      ...screen.getAllByRole('switch'),
    ].filter((element) => element.getAttribute('tabindex') === '-1' && !element.closest('[role="group"]'));
    // Only the steppers inside number fields and the like step out of the tab order.
    expect(unreachable.filter((element) => !element.closest('.rio-field, .rio-combobox'))).toEqual([]);
  });

  it('shows people who can’t change the schema the whole automation without the controls', async () => {
    await mount('reader');
    expect(screen.getByRole('heading', { level: 2, name: 'Follow up' }).hasAttribute('data-hidden')).toBe(
      false,
    );
    expect(nameField()).toBeNull();
    expect((screen.getByRole('switch', { name: 'On' }) as HTMLInputElement).disabled).toBe(true);
    for (const name of [
      'Add a step',
      'Add conditions',
      'Insert a value',
      'Move up',
      'Delete step',
      'Test the whole automation',
      'Test step',
    ])
      expect(screen.queryByRole('button', { name }), name).toBeNull();
    const subject = screen.getByRole('textbox', { name: 'Subject' });
    expect(subject.getAttribute('aria-readonly')).toBe('true');
    expect(subject.getAttribute('contenteditable')).toBe('false');
    expect(
      within(screen.getByRole('region', { name: 'When' }))
        .getByRole('button', { name: /When/ })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByRole('tab', { name: 'Runs' })).toBeDefined();
  });
});
