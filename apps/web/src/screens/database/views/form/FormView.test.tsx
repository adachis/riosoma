import { dragItem } from '../../../../test/sortable';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { I18nProvider as LocaleProvider } from 'react-aria-components';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CommandBatch,
  FieldMeta,
  FormSettings as FormConfig,
  newId,
  type Command,
  type FieldType,
  type GridConfigPatch,
} from '@riosoma/contracts';
import { useSchema } from '../../../../data/hooks';
import { openDatabase } from '../../../../data/session';
import { FakeServer } from '../../../../data/testing';
import type { DatabaseSession } from '../../../../data/types';
import { FormView } from './index';

const sessions: DatabaseSession[] = [];

it.each([{ role: 'reader' }, { role: 'commenter' }, { readOnly: true }] as const)(
  'disables custom people answers without record-writing access (%j)',
  async (access) => {
    const { user, creates } = await mount(
      [{ type: 'user', name: 'Person', options: { allowMultiple: true } }],
      {},
      false,
      access,
      12,
    );
    const option = screen.getByRole('option', { name: /^Member 1(?: |$)/ });
    await user.click(option);
    expect(option.getAttribute('aria-selected')).toBe('false');
    expect(option.getAttribute('aria-disabled')).toBe('true');
    expect((screen.getByRole('searchbox', { name: 'Filter items' }) as HTMLInputElement).disabled).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(document.querySelector('.rio-form-view'));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('listbox'));
    fireEvent.submit(screen.getByRole('form', { name: 'Contact us' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(creates()).toHaveLength(0);
  },
);

it.each([{ role: 'reader' }, { role: 'commenter' }, { readOnly: true }] as const)(
  'keeps a form without record-writing access from accepting answers or submitting (%j)',
  async (access) => {
    const { creates, user } = await mount(undefined, {}, 'readOnly' in access, access);
    const editor = screen.getByRole('textbox', { name: 'Name' });
    await user.type(editor, 'Blocked answer');
    expect((editor as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: 'Submit' }).hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Edit form' })).toBeNull();
    const scroller = document.querySelector<HTMLElement>('.rio-form-view')!;
    await user.tab();
    expect(document.activeElement).toBe(scroller);
    fireEvent.submit(screen.getByRole('form', { name: 'Contact us' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(creates()).toHaveLength(0);
  },
);

it('keeps an edited answer focused until the submit press completes', async () => {
  const { user, config, patch, creates, fields } = await mount();
  await patch({ questions: config().questions.map((question) => ({ ...question, required: true })) });
  const button = screen.getByRole('button', { name: 'Submit' });
  await user.click(button);
  await screen.findByText('Answer this question.');
  const editor = screen.getByRole('textbox', { name: 'Name' });
  await user.type(editor, 'Corrected answer');
  await user.pointer({ target: button, keys: '[MouseLeft>]' });
  expect(document.activeElement).toBe(editor);
  expect(screen.getByText('Answer this question.')).toBeTruthy();
  expect(creates()).toHaveLength(0);
  await user.pointer({ keys: '[/MouseLeft]' });
  await waitFor(() => expect(creates()).toHaveLength(1));
  expect(creates()[0]!.records[0]!.values).toEqual({ [fields[0]!.id]: 'Corrected answer' });
  await waitFor(() => expect(document.activeElement?.textContent).toContain('Thanks!'));
});

it('blocks an invalid line-item draft without replacing the saved amount', async () => {
  const amount = newId('field');
  const { user, creates, fields } = await mount([
    {
      type: 'lineItems',
      name: 'Items',
      options: { columns: [{ id: amount, name: 'Amount', type: 'number' }] },
    },
  ]);
  await user.click(screen.getByRole('button', { name: 'Add line' }));
  const input = screen.getByRole('textbox', { name: 'Amount, line 1' });
  await user.type(input, '12');
  await user.tab();
  await user.clear(input);
  await user.type(input, 'invalid');
  await user.click(screen.getByRole('button', { name: 'Submit' }));
  expect(creates()).toHaveLength(0);
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(document.activeElement).toBe(input);
  await user.clear(input);
  await user.type(input, '24');
  await user.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(creates()).toHaveLength(1));
  expect(creates()[0]!.records[0]!.values).toEqual({
    [fields[0]!.id]: [{ id: expect.any(String), values: { [amount]: 24 } }],
  });
});

it('restores a revealed checkbox default and submits the displayed answer', async () => {
  const { user, fields, config, patch, creates } = await mount([
    { type: 'text', name: 'Name' },
    { type: 'checkbox', name: 'More details' },
    { type: 'checkbox', name: 'Approved', options: { defaultValue: { kind: 'value', value: true } } },
  ]);
  const [name, trigger, child] = fields.map((field) => field.id) as [string, string, string];
  await patch({
    questions: config().questions.map((question) =>
      question.fieldId === child ? { ...question, showIf: { fieldId: trigger, equals: true } } : question,
    ),
  });
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Avery');
  await user.click(screen.getByRole('checkbox', { name: 'More details' }));
  const box = () => screen.getByRole('checkbox', { name: 'Approved' }) as HTMLInputElement;
  expect(box().checked).toBe(true);
  await user.click(box());
  await user.type(screen.getByRole('textbox', { name: 'Name' }), ' Quinn');
  expect(box().checked).toBe(false);
  await user.click(screen.getByRole('checkbox', { name: 'More details' }));
  await user.click(screen.getByRole('checkbox', { name: 'More details' }));
  expect(box().checked).toBe(true);
  await submit();
  expect(creates().at(-1)!.records[0]!.values).toEqual({
    [name]: 'Avery Quinn',
    [trigger]: true,
    [child]: true,
  });
});

it.each(['singleSelect', 'multipleSelect'] as const)(
  'configures conditions from all %s choices despite cascade restrictions',
  async (type) => {
    const upstream = newId('field');
    const upstreamChoice = newId('choice');
    const west = newId('choice');
    const { user, config } = await mount([
      {
        type,
        name: 'Region',
        options: {
          choices: [{ id: west, name: 'West', color: 'blue' }],
          cascade: { fieldId: upstream, mapping: { [upstreamChoice]: [west] } },
        },
      },
      { type: 'text', name: 'Details' },
    ]);
    await user.click(screen.getByRole('button', { name: 'Edit form' }));
    const child = within(screen.getByRole('group', { name: 'Details' }));
    await user.selectOptions(
      child.getByRole('combobox', { name: 'Show if' }),
      config().questions[0]!.fieldId,
    );
    await user.click(child.getByRole('button', { name: /Matches this answer/ }));
    await user.click(await screen.findByRole('option', { name: /^West(?: |$)/ }));
    await user.tab();
    await waitFor(() => expect(config().questions[1]!.showIf?.equals).toBe(west));
  },
);

it('designs a conditional question, refuses invalid order, and omits hidden answers', async () => {
  const { user, config, creates } = await mount([
    { type: 'checkbox', name: 'More details' },
    { type: 'text', name: 'Details' },
  ]);
  await user.click(screen.getByRole('button', { name: 'Edit form' }));
  const child = within(screen.getByRole('group', { name: 'Details' }));
  await user.selectOptions(child.getByRole('combobox', { name: 'Show if' }), config().questions[0]!.fieldId);
  await waitFor(() => expect(config().questions[1]!.showIf?.equals).toBe(true));
  await user.click(child.getByRole('button', { name: 'Move Details up' }));
  expect(screen.getByRole('alert').textContent).toContain(
    'Keep each question after the answer it depends on.',
  );
  await user.click(screen.getByRole('button', { name: 'Done editing' }));
  expect(screen.queryByRole('textbox', { name: 'Details' })).toBeNull();
  await user.click(screen.getByRole('checkbox', { name: 'More details' }));
  await user.type(screen.getByRole('textbox', { name: 'Details' }), 'Discard me');
  await user.click(screen.getByRole('checkbox', { name: 'More details' }));
  await submit();
  expect(creates().at(-1)!.records[0]!.values).toEqual({ [config().questions[0]!.fieldId]: false });
});
afterEach(() => {
  cleanup();
  sessions.splice(0).forEach((session) => session.close());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Spec {
  type: FieldType;
  name?: string;
  options?: Record<string, unknown>;
}
async function mount(
  specs: Spec[] = [{ type: 'text', name: 'Name' }],
  settings: Partial<FormConfig> = {},
  canEdit = true,
  access: { role?: 'reader' | 'commenter' | 'editor'; readOnly?: boolean } = {},
  collaboratorCount = 1,
) {
  const server = new FakeServer();
  const fixture = server.createDatabase(0);
  const database = server.database(fixture.databaseId);
  if (collaboratorCount > 1)
    database.schema.collaborators = Array.from({ length: collaboratorCount }, (_, index) => ({
      id: index === 0 ? server.userId : newId('user'),
      name: `Member ${index + 1}`,
      email: `member${index + 1}@example.test`,
    }));
  const fields = specs.map((spec, position) =>
    FieldMeta.parse({
      ...spec,
      options: spec.options ?? {},
      id: position === 0 ? fixture.textFieldId : newId('field'),
      tableId: fixture.tableId,
      name: spec.name ?? spec.type,
      description: '',
      position,
      createdAt: '',
      updatedAt: '',
    }),
  );
  database.schema.fields = fields;
  const view = database.schema.views[0]!;
  view.type = 'form';
  view.config.form = FormConfig.parse({
    title: 'Contact us',
    description: 'Tell us about yourself.',
    questions: fields.map((field) => ({ fieldId: field.id })),
    ...settings,
  });
  const session = await openDatabase(fixture.databaseId, server.deps());
  if (access.role) vi.spyOn(session, 'role').mockReturnValue(access.role);
  sessions.push(session);
  const onConfig = vi.fn((patch: GridConfigPatch) => {
    session.run([{ kind: 'view.update', viewId: view.id, config: patch }]);
  });
  function Host() {
    const schema = useSchema(session)!;
    return (
      <FormView
        session={session}
        table={schema.tableById.get(fixture.tableId)!}
        view={schema.viewById.get(view.id)!}
        fields={schema.fields.get(fixture.tableId)!}
        format={{ locale: 'en-US', timeZone: 'UTC', collaborators: schema.collaborators }}
        canEdit={canEdit}
        readOnly={access.readOnly}
        onConfig={onConfig}
        onExpand={vi.fn()}
      />
    );
  }
  const rendered = render(
    <I18nProvider i18n={setupI18n({ locale: 'en-US', messages: { 'en-US': {} } })}>
      <LocaleProvider locale="en-US">
        <Host />
      </LocaleProvider>
    </I18nProvider>,
  );
  const commands = (): Command[] =>
    server.requests
      .filter((request) => request.path.endsWith('/commands'))
      .flatMap((request) => CommandBatch.parse(request.options.body).commands);
  const creates = () => commands().filter((command) => command.kind === 'record.create');
  const config = () => session.getSchema().viewById.get(view.id)!.config.form;
  async function patch(patch: Partial<FormConfig>) {
    await act(async () => {
      await session.run([
        { kind: 'view.update', viewId: view.id, config: { form: { ...config(), ...patch } } },
      ]).done;
    });
  }
  return {
    ...rendered,
    server,
    session,
    fixture,
    fields,
    onConfig,
    creates,
    config,
    patch,
    user: userEvent.setup(),
  };
}

async function submit() {
  await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await screen.findByRole('status');
}

const choices = [
  { id: newId('choice'), name: 'First', color: 'blue' },
  { id: newId('choice'), name: 'Second', color: 'green' },
];

describe('form answers', () => {
  it('submits blank required questions with usable defaults', async () => {
    const { patch, config, creates } = await mount([
      { type: 'text', options: { defaultValue: { kind: 'value', value: 'Open' } } },
      { type: 'number', options: { defaultValue: { kind: 'value', value: 0 } } },
      { type: 'date', options: { defaultValue: { kind: 'today' } } },
      { type: 'user', options: { defaultValue: { kind: 'creator' } } },
    ]);
    await patch({ questions: config().questions.map((question) => ({ ...question, required: true })) });
    await submit();
    expect(creates()).toHaveLength(1);
    expect(creates()[0]!.records[0]!.values).toEqual({});
  });

  it.each([
    ['text', 'Ada', 'Ada'],
    ['longText', 'First line\nSecond line', 'First line\nSecond line'],
    ['email', 'ada@example.test', 'ada@example.test'],
    ['url', 'https://example.test', 'https://example.test'],
    ['phone', '+15551234567', '+15551234567'],
    ['number', '12.5', 12.5],
    ['currency', '12.5', 12.5],
    ['percent', '25', 0.25],
    ['duration', '90', 90],
    ['rating', '4', 4],
  ] as const)('submits %s through the session with a form ID', async (type, input, expected) => {
    const { user, creates, fixture, fields, server, session } = await mount([{ type }], {}, false);
    await user.type(screen.getByRole('textbox', { name: type }), input);
    await submit();
    expect(creates()).toHaveLength(1);
    const command = creates()[0]!;
    expect(command.formViewId).toBe(fixture.viewId);
    expect(command.records[0]!.values).toEqual({ [fields[0]!.id]: expected });
    expect(
      server.database(fixture.databaseId).rows(fixture.tableId).get(command.records[0]!.id)?.values[
        fields[0]!.id
      ],
    ).toBe(expected);
    expect(screen.queryByRole('button', { name: 'Edit form' })).toBeNull();
    await act(async () => {
      await session.undo();
    });
    expect(
      server.database(fixture.databaseId).rows(fixture.tableId).get(command.records[0]!.id),
    ).toBeUndefined();
  });

  it('submits dates and checkboxes, including an explicitly unchecked required answer', async () => {
    const { user, fields, patch, config, creates } = await mount([{ type: 'date' }, { type: 'checkbox' }]);
    await patch({ questions: config().questions.map((question) => ({ ...question, required: true })) });
    await user.click(screen.getByRole('spinbutton', { name: /month/i }));
    await user.paste('2026-09-27');
    await user.click(screen.getByRole('checkbox', { name: 'checkbox' }));
    await user.click(screen.getByRole('checkbox', { name: 'checkbox' }));
    await submit();
    expect(creates()[0]!.records[0]!.values).toEqual({
      [fields[0]!.id]: '2026-09-27',
      [fields[1]!.id]: false,
    });
  });

  it.each(['singleSelect', 'multipleSelect'] as const)('submits %s choice IDs', async (type) => {
    const { user, fields, creates } = await mount([{ type, options: { choices } }]);
    await user.click(screen.getByRole('combobox', { name: type }));
    await user.type(screen.getByRole('combobox', { name: type }), 'First');
    await user.click(await screen.findByRole('option', { name: /^First(?: |$)/ }));
    await user.tab();
    await submit();
    expect(creates()[0]!.records[0]!.values[fields[0]!.id]).toEqual(
      type === 'singleSelect' ? choices[0]!.id : [choices[0]!.id],
    );
  });

  it.each([false, true])('submits people with multiple=%s', async (allowMultiple) => {
    const { user, fields, creates, server } = await mount([{ type: 'user', options: { allowMultiple } }]);
    await user.selectOptions(
      screen.getByRole(allowMultiple ? 'listbox' : 'combobox', { name: 'user' }),
      server.userId,
    );
    await submit();
    expect(creates()[0]!.records[0]!.values[fields[0]!.id]).toEqual([server.userId]);
  });

  it('searches and submits linked records with the keyboard', async () => {
    const { user, session, fixture, creates } = await mount();
    const fieldId = newId('field');
    const recordId = newId('record');
    await act(async () => {
      await session.run([
        {
          kind: 'record.create',
          tableId: fixture.tableId,
          records: [{ id: recordId, values: { [fixture.textFieldId]: 'Linked item' } }],
        },
        {
          kind: 'field.create',
          tableId: fixture.tableId,
          field: { id: fieldId, name: 'Related', type: 'link', options: { linkedTableId: fixture.tableId } },
        },
      ]).done;
      const config = session.getSchema().viewById.get(fixture.viewId)!.config.form;
      await session.run([
        {
          kind: 'view.update',
          viewId: fixture.viewId,
          config: { form: { ...config, questions: [{ fieldId, required: false, label: '', help: '' }] } },
        },
      ]).done;
    });
    await user.click(screen.getByRole('button', { name: 'Link a record' }));
    await user.type(screen.getByRole('searchbox', { name: 'Find a record' }), 'Linked');
    await screen.findByRole('option', { name: /^Linked item(?: |$)/ });
    await user.keyboard('{ArrowDown}{Enter}');
    await submit();
    expect(creates().at(-1)!.records[0]!.values).toEqual({ [fieldId]: [recordId] });
  });

  it('uploads attachments, waits for uploads, and submits only the files still selected', async () => {
    const { user, fields, creates } = await mount([{ type: 'attachment' }]);
    const attachmentId = newId('attachment');
    let release: (() => void) | undefined;
    const upload = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response(
        JSON.stringify({
          id: attachmentId,
          name: 'notes.txt',
          size: 5,
          type: 'text/plain',
          width: null,
          height: null,
          createdAt: '',
          url: '/api/files/notes.txt',
          thumbnails: { small: null, large: null },
        }),
      );
    });
    vi.stubGlobal('fetch', upload);
    await user.upload(
      screen.getByLabelText('attachment', { selector: 'input' }),
      new File(['hello'], 'notes.txt', { type: 'text/plain' }),
    );
    expect(screen.getByRole('button', { name: 'Submit' }).hasAttribute('disabled')).toBe(true);
    await act(async () => {
      release!();
    });
    await screen.findByRole('button', { name: 'Remove notes.txt' });
    expect(upload).toHaveBeenCalledWith(
      `/api/tables/${fields[0]!.tableId}/fields/${fields[0]!.id}/files`,
      expect.objectContaining({ method: 'POST', body: expect.any(File) }),
    );
    await submit();
    expect(creates()[0]!.records[0]!.values).toEqual({ [fields[0]!.id]: [attachmentId] });
    await user.click(screen.getByRole('button', { name: 'Submit another' }));
    await user.upload(
      screen.getByLabelText('attachment', { selector: 'input' }),
      new File(['hello'], 'notes.txt'),
    );
    await act(async () => {
      release!();
    });
    await user.click(await screen.findByRole('button', { name: 'Remove notes.txt' }));
    await submit();
    expect(creates()[1]!.records[0]!.values).toEqual({});
  });

  it('shows upload failures at the attachment question and permits retry', async () => {
    const { user } = await mount([{ type: 'attachment' }]);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: 'forbidden', messageKey: 'data.access.denied', userFault: true },
            }),
            { status: 403 },
          ),
      ),
    );
    await user.upload(
      screen.getByLabelText('attachment', { selector: 'input' }),
      new File(['hello'], 'notes.txt'),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole('group', { name: 'attachment' })).getByRole('alert').textContent,
      ).toContain('You don’t have access'),
    );
    expect(screen.getByRole('button', { name: 'Submit' }).hasAttribute('disabled')).toBe(false);
  });

  it('blocks required answers before sending, treats whitespace as empty, and accepts zero', async () => {
    const { user, fields, patch, config, creates } = await mount([
      { type: 'text', name: 'Name' },
      { type: 'number', name: 'Count' },
    ]);
    await patch({ questions: config().questions.map((question) => ({ ...question, required: true })) });
    await user.type(screen.getByRole('textbox', { name: 'Name' }), '   ');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(creates()).toHaveLength(0);
    expect(screen.getAllByText('Answer this question.')).toHaveLength(2);
    expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Name' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Ada');
    await user.type(screen.getByRole('textbox', { name: 'Count' }), '0');
    await submit();
    expect(creates()[0]!.records[0]!.values[fields[1]!.id]).toBe(0);
  });

  it('omits empty, unasked, removed, and computed fields even after they were answered', async () => {
    const { user, fields, patch, config, creates, session } = await mount([
      { type: 'text', name: 'Name' },
      { type: 'text', name: 'Optional' },
      { type: 'number', name: 'Removed' },
      { type: 'createdTime', name: 'Created' },
    ]);
    await user.type(screen.getByRole('textbox', { name: 'Removed' }), '10');
    await user.tab();
    await act(async () => {
      await session.run([{ kind: 'field.trash', fieldId: fields[2]!.id }]).done;
    });
    await patch({ questions: config().questions.filter((question) => question.fieldId !== fields[0]!.id) });
    expect(screen.queryByRole('textbox', { name: 'Removed' })).toBeNull();
    expect(screen.queryByText('Created')).toBeNull();
    await submit();
    expect(creates()[0]!.records[0]!.values).toEqual({});
  });

  it('does not submit a previous value while its editor has invalid draft text', async () => {
    const { user, creates } = await mount([{ type: 'email' }]);
    await user.type(screen.getByRole('textbox', { name: 'email' }), 'ada@example.test');
    await user.tab();
    await user.clear(screen.getByRole('textbox', { name: 'email' }));
    await user.type(screen.getByRole('textbox', { name: 'email' }), 'invalid');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(creates()).toHaveLength(0);
    expect(screen.getByRole('textbox', { name: 'email' }).getAttribute('aria-invalid')).toBe('true');
  });

  it('commits the active editor when a form submit is dispatched without blur', async () => {
    const { user, creates, fields } = await mount();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Current draft');
    fireEvent.submit(screen.getByRole('form', { name: 'Contact us' }));
    await screen.findByRole('status');
    expect(creates()[0]!.records[0]!.values[fields[0]!.id]).toBe('Current draft');
  });

  it('puts required server refusals on the named question and retains answers for retry', async () => {
    const { user, server, fields, creates } = await mount();
    server.rejectNext('data.form.required');
    server.afterRequest = async (request, answer) => {
      if (!request.path.endsWith('/commands')) return;
      const result = answer as { results: Array<{ error?: { params?: Record<string, string> } }> };
      if (result.results[0]?.error) result.results[0].error.params = { fieldId: fields[0]!.id };
    };
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Ada');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findByText('Answer this question.');
    expect(
      within(screen.getByRole('group', { name: 'Name' })).getByText('Answer this question.'),
    ).toBeDefined();
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Ada');
    await submit();
    expect(creates()).toHaveLength(2);
  });

  it('shows other rejections above submit and waits for confirmation without duplicate records', async () => {
    const { user, server, creates } = await mount();
    let release: (() => void) | undefined;
    server.beforeRequest = (request) =>
      request.path.endsWith('/commands')
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : Promise.resolve();
    server.rejectNext('data.access.denied');
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Ada');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(release).toBeDefined());
    fireEvent.submit(screen.getByRole('form', { name: 'Contact us' }));
    expect(screen.queryAllByRole('status').every((status) => !status.textContent)).toBe(true);
    expect(creates()).toHaveLength(1);
    await act(async () => {
      release!();
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('You don’t have access'));
    expect(screen.queryAllByRole('status').every((status) => !status.textContent)).toBe(true);
  });

  it('shows default and custom thanks, resets answers, and honors allowAnother', async () => {
    const { user, patch } = await mount();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Ada');
    await submit();
    expect(screen.getByRole('status').textContent).toContain('Thanks!  Your answer was recorded.');
    expect(document.activeElement).toBe(screen.getByRole('status'));
    await user.click(screen.getByRole('button', { name: 'Submit another' }));
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('');
    await patch({ thankYou: 'Received your response.', allowAnother: false });
    await submit();
    expect(screen.getByRole('status').textContent).toBe('Received your response.');
    expect(screen.queryByRole('button', { name: 'Submit another' })).toBeNull();
  });
});

describe('form design', () => {
  it('saves every form and question setting and shows the resulting form', async () => {
    const { user, config, onConfig } = await mount();
    await user.click(screen.getByRole('button', { name: 'Edit form' }));
    for (const [label, value] of [
      ['Title', 'Survey'],
      ['Description', 'Tell us more.'],
      ['Button label', 'Send response'],
      ['Message after submitting', 'All done.'],
      ['Question', 'Your name'],
      ['Help text', 'First and last name.'],
    ]) {
      const input = screen.getByRole('textbox', { name: label });
      await user.clear(input);
      await user.type(input, value!);
    }
    await user.click(screen.getByRole('checkbox', { name: 'Required' }));
    await user.click(screen.getByRole('checkbox', { name: 'Offer to submit another' }));
    expect(config()).toMatchObject({
      title: 'Survey',
      description: 'Tell us more.',
      submitLabel: 'Send response',
      thankYou: 'All done.',
      allowAnother: false,
      questions: [{ label: 'Your name', help: 'First and last name.', required: true }],
    });
    expect(onConfig.mock.calls.every(([patch]) => Object.keys(patch).join() === 'form')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Done editing' }));
    expect(screen.getByRole('heading', { name: 'Survey' })).toBeDefined();
    expect(screen.getByText('Tell us more.')).toBeDefined();
    expect(screen.getByRole('textbox', { name: 'Your name' })).toBeDefined();
    expect(screen.getByText('First and last name.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Send response' })).toBeDefined();
  });

  it('adds, removes, and reorders by keyboard, buttons, and mouse drop, with undo', async () => {
    const { user, fields, config, session, onConfig } = await mount([
      { type: 'text', name: 'Name' },
      { type: 'number', name: 'Count' },
    ]);
    await user.click(screen.getByRole('button', { name: 'Edit form' }));
    await user.click(screen.getByRole('button', { name: 'Remove Count' }));
    expect(config().questions.map((question) => question.fieldId)).toEqual([fields[0]!.id]);
    await user.click(screen.getByRole('button', { name: 'Add Count' }));
    const handle = screen.getByRole('button', { name: 'Reorder Count' });
    handle.focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(config().questions[0]!.fieldId).toBe(fields[1]!.id);
    expect(document.activeElement).toBe(handle);
    await user.click(screen.getByRole('button', { name: 'Move Count down' }));
    expect(config().questions[1]!.fieldId).toBe(fields[1]!.id);
    const beforeDrop = onConfig.mock.calls.length;
    await dragItem(handle, screen.getByRole('group', { name: 'Name' }), 0.05, () => {
      expect(onConfig.mock.calls).toHaveLength(beforeDrop);
    });
    expect(config().questions[0]!.fieldId).toBe(fields[1]!.id);
    await waitFor(() => expect(session.saveState().pending).toBe(0));
    await act(async () => {
      await session.undo();
    });
    expect(config().questions[0]!.fieldId).toBe(fields[0]!.id);
  });

  it('flags missing and computed questions and only offers writable table fields', async () => {
    const { user, fields, session } = await mount([
      { type: 'text', name: 'Name' },
      { type: 'text', name: 'Removed' },
      { type: 'autoNumber', name: 'Automatic' },
    ]);
    await act(async () => {
      await session.run([{ kind: 'field.trash', fieldId: fields[1]!.id }]).done;
    });
    expect(screen.queryByRole('textbox', { name: 'Removed' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Edit form' }));
    expect(screen.getAllByText('This field can’t be used in a form any more.')).toHaveLength(2);
    const palette = screen.getByRole('complementary', { name: 'Fields' });
    expect(within(palette).queryByRole('button', { name: 'Add Removed' })).toBeNull();
    expect(within(palette).queryByRole('button', { name: 'Add Automatic' })).toBeNull();
    expect(within(palette).getByRole('button', { name: 'Add Name' }).hasAttribute('disabled')).toBe(true);
  });

  it('labels every design control and makes the palette reachable by keyboard', async () => {
    const { user } = await mount();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit form' }));
    await user.keyboard('{Enter}');
    for (const input of screen.getAllByRole('textbox'))
      expect(
        (input as HTMLInputElement).labels?.length ||
          input.getAttribute('aria-label') ||
          input.getAttribute('aria-labelledby'),
      ).toBeTruthy();
    for (const button of screen.getAllByRole('button'))
      expect(button.textContent || button.getAttribute('aria-label')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove Name' }));
    expect(screen.getByText('Add fields to ask about.')).toBeDefined();
    screen.getByRole('checkbox', { name: 'Offer to submit another' }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add Name' }));
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Remove Name' })).toBeDefined();
  });
});
