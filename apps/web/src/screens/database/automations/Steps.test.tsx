import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toastQueue } from '@riosoma/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  automationFixture,
  automationMeta,
  bridgeFetch,
  renderScreen,
  savedConfig,
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

async function mount(config: (ids: Ids) => ConfigInput) {
  const fixture = await automationFixture({
    automations: (ids) => [automationMeta(ids.databaseId, 'Follow up', config(ids))],
  });
  fixtures.push(fixture);
  vi.stubGlobal('fetch', bridgeFetch(fixture.server));
  const automationId = fixture.session.getSchema().automations[0]!.id;
  renderScreen(fixture, automationId);
  await screen.findByRole('switch');
  return { ...fixture, automationId, saved: () => savedConfig(fixture, automationId) };
}

const onTasks = ({ tasks }: Ids) => ({ trigger: { kind: 'recordCreated' as const, tableId: tasks.id } });

it.each(['updateRecord', 'generateDocument'] as const)(
  'offers graph ancestors to %s with their stored step numbers',
  async (kind) => {
    await mount(({ tasks }): ConfigInput => ({
      ...onTasks({ tasks } as Ids),
      steps: [
        { id: 'later001', kind: 'createRecord', name: 'Downstream record', tableId: tasks.id, values: {} },
        {
          id: 'early001',
          tableId: tasks.id,
          record: 'trigger',
          ...(kind === 'generateDocument'
            ? {
                kind,
                values: { customer: '' },
                templateFieldId: '',
                attachmentFieldId: '',
                format: 'docx' as const,
              }
            : { kind, values: { [tasks.name]: '' } }),
        },
        { id: 'source01', kind: 'createRecord', name: 'Upstream record', tableId: tasks.id, values: {} },
      ],
      connections: [
        {
          id: 'wire0001',
          source: { stepId: 'trigger', port: 'out' },
          target: { stepId: 'source01', port: 'in' },
        },
        {
          id: 'wire0002',
          source: { stepId: 'source01', port: 'out' },
          target: { stepId: 'early001', port: 'in' },
        },
        {
          id: 'wire0003',
          source: { stepId: 'early001', port: 'out' },
          target: { stepId: 'later001', port: 'in' },
        },
      ],
    }));
    const update = stepCards()[1]!;
    await userEvent.click(within(update).getByRole('button', { name: /Record$/ }));
    expect(
      await screen.findByRole('option', {
        name: kind === 'updateRecord' ? 'The record from step 3' : 'Upstream record',
      }),
    ).toBeDefined();
    expect(
      screen.queryByRole('option', {
        name: kind === 'updateRecord' ? 'The record from step 1' : 'Downstream record',
      }),
    ).toBeNull();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(
      within(update).getByRole('button', {
        name: 'Insert a value',
        description: kind === 'updateRecord' ? 'Name' : 'customer',
      }),
    );
    const menu = await screen.findByRole('menu', { name: 'Insert a value' });
    expect(within(menu).getByRole('group', { name: 'The record from step 3' })).toBeDefined();
    expect(within(menu).getByRole('group', { name: 'Output from step 3' })).toBeDefined();
    expect(within(menu).queryByRole('group', { name: 'The record from step 1' })).toBeNull();
    expect(within(menu).queryByRole('group', { name: 'Output from step 1' })).toBeNull();
  },
);

it('keeps a saved downstream document record named and disabled', async () => {
  const state = await mount(({ tasks }) => ({
    ...onTasks({ tasks } as Ids),
    steps: [
      {
        id: 'early001',
        kind: 'generateDocument',
        tableId: tasks.id,
        record: 'later001',
        values: {},
        templateFieldId: '',
        attachmentFieldId: '',
        format: 'docx',
      },
      { id: 'later001', kind: 'createRecord', name: 'Saved record source', tableId: tasks.id, values: {} },
    ],
    connections: [
      {
        id: 'wire0001',
        source: { stepId: 'trigger', port: 'out' },
        target: { stepId: 'early001', port: 'in' },
      },
      {
        id: 'wire0002',
        source: { stepId: 'early001', port: 'out' },
        target: { stepId: 'later001', port: 'in' },
      },
    ],
  }));
  const picker = within(stepCards()[0]!).getByRole('button', { name: /Record$/ });
  expect(picker.textContent).toContain('Saved record source');
  await userEvent.click(picker);
  expect(
    (await screen.findByRole('option', { name: 'Saved record source' })).getAttribute('aria-disabled'),
  ).toBe('true');
  expect(state.saved().steps[0]).toMatchObject({ record: 'later001' });
});

async function addStep(kind: string) {
  const buttons = screen.getAllByRole('button', { name: 'Add a step' });
  await userEvent.click(buttons.at(-1)!);
  await userEvent.click(await screen.findByRole('menuitem', { name: kind }));
}

async function choose(label: RegExp, option: string, scope: HTMLElement) {
  await userEvent.click(within(scope).getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

const stepCards = () =>
  screen.getAllByRole('region').filter((region) => region.closest('.rio-automation-flow__steps'));

/** The emulator can't press End in an editable element, so the caret is put there directly. */
function caretAtEnd(box: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(box);
  range.collapse(false);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
}

/**
 * Holds animation frames back, as a busy browser does, until the returned function draws them in
 * the order they were asked for.
 */
function holdFrames(): () => void {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  const request = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++next, callback);
    return next;
  });
  const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  return () => {
    request.mockRestore();
    cancel.mockRestore();
    for (const callback of frames.values()) callback(performance.now());
  };
}

/** The text a template field shows, with each chip as its label in brackets. */
function shown(box: HTMLElement): string {
  return [...box.childNodes]
    .map((node) =>
      node instanceof HTMLElement && node.dataset.token
        ? `[${node.textContent}]`
        : node instanceof HTMLBRElement
          ? '\n'
          : (node.textContent ?? ''),
    )
    .join('')
    .replaceAll('\u200b', '');
}

describe('steps', () => {
  it('updates the record that started it, field by field', async () => {
    const { saved, tasks } = await mount(onTasks);
    await addStep('Update a record');
    const [step] = stepCards();
    expect(within(step!).getByRole('heading', { name: 'Update a record' })).toBeDefined();
    expect(within(step!).getByRole('button', { name: /Record$/ }).textContent).toContain(
      'The record that started it',
    );
    await userEvent.click(within(step!).getByRole('button', { name: 'Set a field' }));
    const menu = await screen.findByRole('menu', { name: 'Set a field' });
    // Fields Riosoma fills in itself can't be set.
    expect(within(menu).queryByRole('menuitem', { name: /Created/ })).toBeNull();
    await userEvent.click(within(menu).getByRole('menuitem', { name: /Email/ }));
    const email = await within(step!).findByRole('textbox', { name: 'Email' });
    await waitFor(() => expect(document.activeElement).toBe(email));
    await userEvent.type(email, 'ops@example.test');
    await waitFor(() =>
      expect(saved().steps[0]).toMatchObject({
        kind: 'updateRecord',
        record: 'trigger',
        tableId: tasks.id,
        values: { [tasks.email]: 'ops@example.test' },
      }),
    );
    await userEvent.click(within(step!).getByRole('button', { name: 'Remove Email' }));
    await waitFor(() => expect(saved().steps[0]).toMatchObject({ values: {} }));
  });

  it('creates a record in any table, and a later step can update it', async () => {
    const { saved, people } = await mount(onTasks);
    await addStep('Create a record');
    const [create] = stepCards();
    await choose(/Table$/, 'People', create!);
    await userEvent.click(within(create!).getByRole('button', { name: 'Set a field' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Full name/ }));
    await userEvent.type(await within(create!).findByRole('textbox', { name: 'Full name' }), 'Guest');
    await addStep('Update a record');
    const update = stepCards()[1]!;
    await choose(/Record$/, 'The record from step 1', update);
    await waitFor(() =>
      expect(saved().steps).toMatchObject([
        { kind: 'createRecord', tableId: people.id, values: { [people.name]: 'Guest' } },
        { kind: 'updateRecord', record: saved().steps[0]!.id, tableId: people.id },
      ]),
    );
  });

  it('sends an email to a list of addresses, with a subject and a message', async () => {
    const { saved } = await mount(onTasks);
    await addStep('Send an email');
    const [email] = stepCards();
    await userEvent.type(
      within(email!).getByRole('textbox', { name: 'To' }),
      'a@example.test, b@example.test',
    );
    await userEvent.type(within(email!).getByRole('textbox', { name: 'Subject' }), 'Hello');
    const message = within(email!).getByRole('textbox', { name: 'Message' });
    expect(message.getAttribute('aria-multiline')).toBe('true');
    await userEvent.type(message, 'Line one{Enter}Line two');
    await waitFor(() =>
      expect(saved().steps[0]).toMatchObject({
        kind: 'sendEmail',
        to: ['a@example.test', 'b@example.test'],
        subject: 'Hello',
        body: 'Line one\nLine two',
      }),
    );
    // The field keeps the person's own text, comma and all, while they type.
    expect(shown(within(email!).getByRole('textbox', { name: 'To' }))).toBe('a@example.test, b@example.test');
  });

  it('calls a webhook with an address, a method, headers, and a JSON body', async () => {
    const { saved } = await mount(onTasks);
    await addStep('Call a webhook');
    const [hook] = stepCards();
    await userEvent.type(within(hook!).getByRole('textbox', { name: 'Address' }), 'https://example.test/in');
    await choose(/Method$/, 'PUT', hook!);
    await userEvent.type(
      within(hook!).getByRole('textbox', { name: 'Headers' }),
      'Authorization: Bearer one{Enter}X-Test: 2',
    );
    await userEvent.click(within(hook!).getByRole('textbox', { name: 'JSON body' }));
    await userEvent.paste('{"ok": true}');
    await waitFor(() =>
      expect(saved().steps[0]).toMatchObject({
        kind: 'callWebhook',
        url: 'https://example.test/in',
        method: 'PUT',
        headers: { Authorization: 'Bearer one', 'X-Test': '2' },
        body: '{"ok": true}',
      }),
    );
  });

  it('moves, duplicates, and deletes steps, keeping focus on the step that moved', async () => {
    const { saved } = await mount(({ tasks }) => ({
      ...onTasks({ tasks } as Ids),
      steps: [
        { id: 'email_one', kind: 'sendEmail', to: ['a@example.test'], subject: 'First', body: '' },
        { id: 'hook_two', kind: 'callWebhook', url: 'https://example.test', body: '' },
      ],
    }));
    const names = () => stepCards().map((step) => within(step).getByRole('heading').textContent);
    expect(names()).toEqual(['Send an email', 'Call a webhook']);
    expect(within(stepCards()[0]!).getByRole('button', { name: 'Move up' }).hasAttribute('disabled')).toBe(
      true,
    );
    await userEvent.click(within(stepCards()[0]!).getByRole('button', { name: 'Move down' }));
    expect(names()).toEqual(['Call a webhook', 'Send an email']);
    await waitFor(() =>
      expect(document.activeElement).toBe(within(stepCards()[1]!).getByRole('button', { name: 'Move up' })),
    );
    await waitFor(() => expect(saved().steps.map((step) => step.id)).toEqual(['hook_two', 'email_one']));
    await userEvent.click(within(stepCards()[1]!).getByRole('button', { name: 'Duplicate' }));
    expect(names()).toEqual(['Call a webhook', 'Send an email', 'Send an email']);
    await waitFor(() => expect(saved().steps).toHaveLength(3));
    expect(saved().steps[2]).toMatchObject({ kind: 'sendEmail', subject: 'First' });
    expect(saved().steps[2]!.id).not.toBe('email_one');
    await userEvent.click(within(stepCards()[0]!).getByRole('button', { name: 'Delete step' }));
    expect(names()).toEqual(['Send an email', 'Send an email']);
    await waitFor(() => expect(saved().steps.map((step) => step.kind)).toEqual(['sendEmail', 'sendEmail']));
  });

  it('adds a step between two others', async () => {
    const { saved } = await mount(({ tasks }) => ({
      ...onTasks({ tasks } as Ids),
      steps: [
        { id: 'email_one', kind: 'sendEmail', to: ['a@example.test'], subject: 'First', body: '' },
        { id: 'email_two', kind: 'sendEmail', to: ['b@example.test'], subject: 'Second', body: '' },
      ],
    }));
    const between = screen.getAllByRole('button', { name: 'Add a step' });
    // One before each step, and one after the last.
    expect(between).toHaveLength(3);
    await userEvent.click(between[1]!);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Call a webhook' }));
    await waitFor(() =>
      expect(saved().steps.map((step) => step.kind)).toEqual(['sendEmail', 'callWebhook', 'sendEmail']),
    );
    await waitFor(() => expect(document.activeElement).toBe(stepCards()[1]));
  });
});

describe('values in text', () => {
  it('inserts the trigger record’s fields, the current time, and the record’s link as chips named for them', async () => {
    const { saved, tasks } = await mount(onTasks);
    await addStep('Send an email');
    const [email] = stepCards();
    const subject = within(email!).getByRole('textbox', { name: 'Subject' });
    await userEvent.type(subject, 'New: ');
    await userEvent.click(
      within(email!).getByRole('button', { name: 'Insert a value', description: 'Subject' }),
    );
    const menu = await screen.findByRole('menu', { name: 'Insert a value' });
    expect(within(menu).getByRole('group', { name: 'The record that started it' })).toBeDefined();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Name' }));
    await waitFor(() => expect(document.activeElement).toBe(subject));
    await userEvent.type(subject, ' at ', { skipClick: true });
    await userEvent.click(
      within(email!).getByRole('button', { name: 'Insert a value', description: 'Subject' }),
    );
    await userEvent.click(await screen.findByRole('menuitem', { name: 'The current time' }));
    expect(shown(subject)).toBe('New: [Name] at [The current time]');
    await waitFor(() =>
      expect(saved().steps[0]).toMatchObject({ subject: `New: {{trigger.record.${tasks.name}}} at {{now}}` }),
    );
    const message = within(email!).getByRole('textbox', { name: 'Message' });
    await userEvent.click(
      within(email!).getByRole('button', { name: 'Insert a value', description: 'Message' }),
    );
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Link to the record' }));
    expect(shown(message)).toBe('[Link to the record]');
    await waitFor(() => expect(saved().steps[0]).toMatchObject({ body: '{{trigger.record.url}}' }));
  });

  it('keeps the caret where the person put it when they type before the next frame', async () => {
    await mount(onTasks);
    await addStep('Send an email');
    const [email] = stepCards();
    const subject = within(email!).getByRole('textbox', { name: 'Subject' });
    await userEvent.type(subject, 'New: ');
    await userEvent.click(
      within(email!).getByRole('button', { name: 'Insert a value', description: 'Subject' }),
    );
    const menu = await screen.findByRole('menu', { name: 'Insert a value' });
    const release = holdFrames();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Name' }));
    subject.focus();
    caretAtEnd(subject);
    await userEvent.type(subject, ' f', { skipClick: true });
    release();
    await userEvent.type(subject, 'rom ', { skipClick: true });
    expect(shown(subject)).toBe('New: [Name] from ');
  });

  it('offers only earlier steps’ records, and shows saved tokens by field name', async () => {
    await mount(({ tasks, people }) => ({
      ...onTasks({ tasks } as Ids),
      steps: [
        { id: 'make_person', kind: 'createRecord', tableId: people.id, values: {} },
        {
          id: 'tell_them',
          kind: 'sendEmail',
          to: [`{{steps.make_person.record.${people.email}}}`],
          subject: `Welcome {{steps.make_person.record.${people.name}}}`,
          body: '',
        },
      ],
    }));
    const [create, email] = stepCards();
    expect(shown(within(email!).getByRole('textbox', { name: 'Subject' }))).toBe('Welcome [Full name]');
    expect(shown(within(email!).getByRole('textbox', { name: 'To' }))).toBe('[Work email]');
    expect(
      within(email!)
        .getByRole('textbox', { name: 'Subject' })
        .querySelector('[data-token]')
        ?.getAttribute('title'),
    ).toBe('The record from step 1');
    await userEvent.click(
      within(email!).getByRole('button', { name: 'Insert a value', description: 'Subject' }),
    );
    const menu = await screen.findByRole('menu', { name: 'Insert a value' });
    expect(within(menu).getByRole('group', { name: 'The record from step 1' })).toBeDefined();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(create!).getByRole('button', { name: 'Set a field' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Full name/ }));
    const name = await within(create!).findByRole('textbox', { name: 'Full name' });
    await userEvent.click(
      within(create!).getByRole('button', { name: 'Insert a value', description: 'Full name' }),
    );
    const first = await screen.findByRole('menu', { name: 'Insert a value' });
    expect(within(first).queryByRole('group', { name: 'The record from step 1' })).toBeNull();
    expect(within(first).getByRole('group', { name: 'The record that started it' })).toBeDefined();
    await userEvent.keyboard('{Escape}');
    expect(name.getAttribute('aria-multiline')).toBeNull();
  });

  it('removes a chip with Backspace, and turns a typed webhook path into a chip', async () => {
    const { saved } = await mount(() => ({
      trigger: { kind: 'webhook' },
      steps: [{ id: 'mail_out', kind: 'sendEmail', to: ['a@example.test'], subject: 'Hi {{now}}', body: '' }],
    }));
    const [email] = stepCards();
    const subject = within(email!).getByRole('textbox', { name: 'Subject' });
    expect(shown(subject)).toBe('Hi [The current time]');
    await userEvent.click(subject);
    caretAtEnd(subject);
    await userEvent.keyboard('{Backspace}');
    expect(shown(subject)).toBe('Hi ');
    await waitFor(() => expect(saved().steps[0]).toMatchObject({ subject: 'Hi ' }));
    await userEvent.click(
      within(email!).getByRole('button', { name: 'Insert a value', description: 'Subject' }),
    );
    await userEvent.click(await screen.findByRole('menuitem', { name: 'A value from the webhook’s JSON' }));
    await waitFor(() => expect(document.activeElement).toBe(subject));
    await userEvent.type(subject, 'customer.name', { skipClick: true });
    await waitFor(() =>
      expect(saved().steps[0]).toMatchObject({ subject: 'Hi {{trigger.body.customer.name}}' }),
    );
    await userEvent.tab();
    expect(shown(subject)).toBe('Hi [customer.name]');
  });
});

describe('problems', () => {
  it('show on the cards that have them', async () => {
    await mount(({ tasks }) => ({
      ...onTasks({ tasks } as Ids),
      steps: [
        { id: 'update_later', kind: 'updateRecord', record: 'make_later', tableId: tasks.id, values: {} },
        {
          id: 'mail_gone',
          kind: 'sendEmail',
          to: ['a@example.test'],
          subject: 'Hi {{trigger.record.fldGone0000000000}}',
          body: '',
        },
        { id: 'make_later', kind: 'createRecord', tableId: tasks.id, values: { [tasks.name]: 'Fine' } },
        { id: 'make_nowhere', kind: 'createRecord', tableId: 'tblGone0000000000', values: {} },
      ],
    }));
    const [update, email, fine, nowhere] = stepCards();
    expect(
      screen.getByRole('region', {
        name: 'Update a record',
        description: 'This step uses a record from a later step.',
      }),
    ).toBe(update);
    expect(within(email!).getByText('Something this step uses was deleted.')).toBeDefined();
    const chip = within(email!).getByRole('textbox', { name: 'Subject' }).querySelector('[data-token]')!;
    expect(chip.textContent).toBe('A deleted field');
    expect(chip.hasAttribute('data-missing')).toBe(true);
    expect(within(fine!).queryByText(/deleted|later step/)).toBeNull();
    expect(within(nowhere!).getByText('Something this step uses was deleted.')).toBeDefined();
    expect(within(screen.getByRole('region', { name: 'When' })).queryByText(/deleted/)).toBeNull();
  });

  it('show on the trigger when its table is gone', async () => {
    await mount(() => ({ trigger: { kind: 'recordCreated', tableId: 'tblGone0000000000' } }));
    expect(
      screen.getByRole('region', { name: 'When', description: 'Something this step uses was deleted.' }),
    ).toBeDefined();
  });

  it('follow a field that was deleted after the automation used it', async () => {
    const { server, databaseId, tasks } = await mount(({ tasks }) => ({
      ...onTasks({ tasks } as Ids),
      steps: [
        {
          id: 'mail_note',
          kind: 'sendEmail',
          to: ['a@example.test'],
          subject: `{{trigger.record.${tasks.notes}}}`,
          body: '',
        },
      ],
    }));
    const [email] = stepCards();
    expect(within(email!).queryByText('Something this step uses was deleted.')).toBeNull();
    server.remote(databaseId, [{ kind: 'field.trash', fieldId: tasks.notes }]);
    expect(await within(email!).findByText('Something this step uses was deleted.')).toBeDefined();
  });
});
