import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { PublicForm, PublicQuestion } from '@riosoma/contracts';
import { DEFAULT_THEME } from '@riosoma/tokens';
import { themes } from '../../preferences';
import { json, renderSharing } from '../database/share/testing';
import { PublicFormPage } from './PublicFormScreen';

const FORM_ID = 'AbCdEfGhIjKlMnOpQrStUv';
const FORM_PATH = `/api/public/forms/${FORM_ID}`;
const SUBMIT_PATH = `${FORM_PATH}/submissions`;
const css = readFileSync('src/screens/public-form/public-form.css', 'utf8');

const choices = [
  { id: 'cho00000000000001', name: 'First', color: 'blue' },
  { id: 'cho00000000000002', name: 'Second', color: 'green' },
];

let fields = 0;
function question(
  type: PublicQuestion['type'],
  extra: Partial<Omit<PublicQuestion, 'type'>> = {},
): PublicQuestion {
  fields += 1;
  return {
    fieldId: `fld${String(fields).padStart(14, '0')}`,
    type,
    label: type,
    help: '',
    required: false,
    options: {},
    ...extra,
  };
}

function publicForm(questions: PublicQuestion[], extra: Partial<PublicForm> = {}): PublicForm {
  return {
    formId: FORM_ID,
    title: 'Contact us',
    description: 'Tell us about yourself.',
    submitLabel: '',
    thankYou: '',
    allowAnother: true,
    questions,
    theme: null,
    ticket: '1790000000000.ticket',
    ...extra,
  };
}

function error(code: string, messageKey: string, status: number, params?: Record<string, string>) {
  return json({ error: { code, messageKey, userFault: true, ...(params ? { params } : {}) } }, status);
}

/** A server with one public form.  `reply` answers submissions, which it thanks for by default. */
function serve(form: PublicForm | 'missing' | 'paused' | 'offline', reply?: (attempt: number) => Response) {
  const posted: Array<Record<string, unknown>> = [];
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === FORM_PATH) {
      if (form === 'missing') return error('not_found', 'forms.public.notFound', 404);
      if (form === 'paused') return error('gone', 'forms.public.notFound', 410);
      if (form === 'offline') throw new TypeError('Failed to fetch');
      return json(form);
    }
    if (url === SUBMIT_PATH && typeof form === 'object') {
      posted.push(JSON.parse(String(options?.body)) as Record<string, unknown>);
      return reply?.(posted.length) ?? json({ thankYou: form.thankYou, allowAnother: form.allowAnother });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, posted };
}

let apply: MockInstance<typeof themes.apply>;
beforeEach(() => {
  apply = vi.spyOn(themes, 'apply').mockResolvedValue({ theme: 'nature', scheme: 'grove' });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Renders the page and waits for the form.  Later clocks read as if the person took their time. */
async function mount(form: PublicForm, reply?: (attempt: number) => Response) {
  const server = serve(form, reply);
  renderSharing(<PublicFormPage formId={form.formId} />, null);
  await screen.findByRole('heading', { name: form.title });
  const now = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => now() + 5_000);
  return { ...server, user: userEvent.setup() };
}

async function submit(user: ReturnType<typeof userEvent.setup>, label = 'Submit') {
  await user.click(screen.getByRole('button', { name: label }));
  await screen.findByRole('status');
}

describe('answering a public form', () => {
  it('keeps an invalid time draft from submitting the previous answer', async () => {
    const time = question('time', { label: 'Time', options: { timeFormat: '24h' } });
    const { user, posted } = await mount(publicForm([time]));
    const input = screen.getByRole('textbox', { name: 'Time' });
    await user.type(input, '14:30');
    await user.tab();
    await user.clear(input);
    await user.type(input, 'invalid');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(posted).toHaveLength(0);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(input);
    await user.clear(input);
    await user.type(input, '15:45');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.values).toEqual({ [time.fieldId]: '15:45:00' });
  });

  it('blocks an invalid line-item draft until that cell is corrected', async () => {
    const amount = question('number').fieldId;
    const lines = question('lineItems', {
      label: 'Items',
      options: { columns: [{ id: amount, name: 'Amount', type: 'number' }] },
    });
    const { user, posted } = await mount(publicForm([lines]));
    await user.click(screen.getByRole('button', { name: 'Add line' }));
    const input = screen.getByRole('textbox', { name: 'Amount, line 1' });
    await user.type(input, '12');
    await user.tab();
    await user.clear(input);
    await user.type(input, 'invalid');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(posted).toHaveLength(0);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(input);
    await user.clear(input);
    await user.type(input, '24');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.values).toEqual({
      [lines.fieldId]: [{ id: expect.any(String), values: { [amount]: 24 } }],
    });
  });

  it.each(['not_found', 'gone'])('closes a form refused as %s while answering', async (code) => {
    const { user } = await mount(publicForm([question('text', { label: 'Name' })]), () =>
      error(code, 'forms.public.notFound', code === 'gone' ? 410 : 404),
    );
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Avery');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    const heading = await screen.findByRole('heading', { name: 'This form isn’t available.' });
    expect(document.activeElement).toBe(heading);
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  });

  it('keeps a corrected answer focused through a completed submit press', async () => {
    const field = question('text', { label: 'Name', required: true });
    const { user, posted } = await mount(publicForm([field]));
    const button = screen.getByRole('button', { name: 'Submit' });
    await user.click(button);
    await screen.findByText('Answer this question.');
    const editor = screen.getByRole('textbox', { name: 'Name' });
    await user.type(editor, 'Corrected answer');
    await user.pointer({ target: button, keys: '[MouseLeft>]' });
    expect(document.activeElement).toBe(editor);
    expect(posted).toHaveLength(0);
    await user.pointer({ keys: '[/MouseLeft]' });
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.values).toEqual({ [field.fieldId]: 'Corrected answer' });
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Thanks!'));
  });

  it('sends the opened text base and retries a conflict only after an explicit choice', async () => {
    const notes = question('longText', { label: 'Notes' });
    const form = publicForm([notes], {
      edit: {
        session: 'short-session',
        expiresAt: '2027-01-15T12:00:00.000Z',
        values: { [notes.fieldId]: 'red green blue' },
      },
    });
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        if (url === `${FORM_PATH}/edit-session`) return json(form);
        expect(url).toBe(`${FORM_PATH}/edits`);
        posted.push(JSON.parse(String(options?.body)));
        if (posted.length === 1)
          return json(
            {
              error: {
                code: 'conflict',
                messageKey: 'data.textEdit.conflict',
                userFault: true,
                conflicts: [
                  {
                    tableId: 'tbl00000000000001',
                    recordId: 'rec00000000000001',
                    fieldId: notes.fieldId,
                    base: 'red green blue',
                    ours: 'red purple blue',
                    theirs: 'red yellow blue',
                    updatedBy: null,
                    name: null,
                    updatedAt: '2026-10-02T12:00:00Z',
                    proposal: 'red <<<<<<<\npurple\n=======\nyellow\n>>>>>>> blue',
                  },
                ],
              },
            },
            409,
          );
        return json({ thankYou: '', allowAnother: false });
      }),
    );
    renderSharing(<PublicFormPage formId={FORM_ID} editToken="signed-link" />, null);
    await screen.findByRole('heading', { name: form.title });
    const user = userEvent.setup();
    const input = screen.getByRole('textbox', { name: 'Notes' });
    await user.clear(input);
    await user.type(input, 'red purple blue');
    await user.click(screen.getByRole('button', { name: 'Save response' }));
    const dialog = await screen.findByRole('dialog', { name: 'Resolve text conflict' });
    expect(posted).toEqual([
      {
        session: 'short-session',
        values: { [notes.fieldId]: 'red purple blue' },
        baseValues: { [notes.fieldId]: 'red green blue' },
      },
    ]);
    expect((within(dialog).getByRole('textbox', { name: 'Your text' }) as HTMLTextAreaElement).value).toBe(
      'red purple blue',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Keep mine' }));
    await screen.findByText('Your response was updated.');
    expect(posted[1]).toEqual({
      session: 'short-session',
      values: { [notes.fieldId]: 'red purple blue' },
      baseValues: { [notes.fieldId]: 'red yellow blue' },
    });
  });
  it('offers the private edit link and its expiry on the confirmation screen', async () => {
    const name = question('text', { label: 'Name' });
    const { user } = await mount(publicForm([name]), () =>
      json({
        thankYou: 'Received.',
        allowAnother: false,
        editLink: { path: `/f/${FORM_ID}/edit#signed-link`, expiresAt: '2027-01-15T12:00:00.000Z' },
      }),
    );
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Avery');
    await submit(user);
    expect(screen.getByRole('link', { name: 'Edit your response' }).getAttribute('href')).toBe(
      `/f/${FORM_ID}/edit#signed-link`,
    );
    expect(screen.getByText(/Keep this link private/).textContent).toContain('January 15, 2027');
  });

  it('prefills an edit, clears visible answers, and drops answers hidden by a changed condition', async () => {
    const name = question('text', { label: 'Name', required: true });
    const trigger = question('checkbox', { label: 'More details' });
    const child = question('text', { label: 'Details', showIf: { fieldId: trigger.fieldId, equals: true } });
    const optional = question('text', { label: 'Optional answer' });
    const form = publicForm([name, trigger, child, optional], {
      edit: {
        session: 'short-session',
        expiresAt: '2027-01-15T12:00:00.000Z',
        values: {
          [name.fieldId]: 'Current answer',
          [trigger.fieldId]: false,
          [optional.fieldId]: 'Clear me',
        },
      },
    });
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        if (url === `${FORM_PATH}/edit-session`) {
          expect(JSON.parse(String(options?.body))).toEqual({ token: 'signed-link' });
          return json(form);
        }
        expect(url).toBe(`${FORM_PATH}/edits`);
        posted.push(JSON.parse(String(options?.body)));
        return json({ thankYou: '', allowAnother: false });
      }),
    );
    renderSharing(<PublicFormPage formId={FORM_ID} editToken="signed-link" />, null);
    await screen.findByRole('heading', { name: form.title });
    const user = userEvent.setup();
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Current answer');
    expect(screen.queryByRole('textbox', { name: 'Details' })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'More details' }));
    expect((screen.getByRole('textbox', { name: 'Details' }) as HTMLInputElement).value).toBe('');
    await user.type(screen.getByRole('textbox', { name: 'Details' }), 'Temporary answer');
    await user.click(screen.getByRole('checkbox', { name: 'More details' }));
    await user.clear(screen.getByRole('textbox', { name: 'Optional answer' }));
    await user.clear(screen.getByRole('textbox', { name: 'Name' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Changed');
    await submit(user, 'Save response');
    expect(screen.getByText('Your response was updated.')).toBeDefined();
    expect(posted).toEqual([
      {
        session: 'short-session',
        values: { [name.fieldId]: 'Changed', [trigger.fieldId]: false, [optional.fieldId]: null },
      },
    ]);
  });

  it('shows the answers a payment was priced by without letting an edit change them', async () => {
    const name = question('text', { label: 'Name', required: true });
    const seats = question('number', { label: 'Seats', help: 'One per person.', required: true });
    const form = publicForm([name, seats], {
      edit: {
        session: 'short-session',
        expiresAt: '2027-01-15T12:00:00.000Z',
        values: { [name.fieldId]: 'Current answer', [seats.fieldId]: 2 },
        locked: [seats.fieldId],
      },
    });
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        if (url === `${FORM_PATH}/edit-session`) return json(form);
        expect(url).toBe(`${FORM_PATH}/edits`);
        posted.push(JSON.parse(String(options?.body)));
        return json({ thankYou: '', allowAnother: false });
      }),
    );
    renderSharing(<PublicFormPage formId={FORM_ID} editToken="signed-link" />, null);
    await screen.findByRole('heading', { name: form.title });
    const user = userEvent.setup();
    const priced = screen.getByRole('group', { name: 'Seats' });
    expect(priced.querySelector('fieldset')!.disabled).toBe(true);
    expect(within(priced).getByText(/One per person\.\s+This answer set the price/)).toBeDefined();
    const open = screen.getByRole('group', { name: 'Name' });
    expect(open.querySelector('fieldset')!.disabled).toBe(false);
    expect(within(open).queryByText(/This answer set the price/)).toBeNull();
    await user.clear(screen.getByRole('textbox', { name: 'Name' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Changed');
    await submit(user, 'Save response');
    // The priced answer goes back as it was, which is what the server expects of an edit.
    expect(posted).toEqual([
      { session: 'short-session', values: { [name.fieldId]: 'Changed', [seats.fieldId]: 2 } },
    ]);
  });

  it('saves newly revealed required checkboxes as unchecked during an edit without applying defaults', async () => {
    const trigger = question('checkbox', { label: 'More details' });
    const child = question('checkbox', {
      label: 'Approved',
      required: true,
      options: { defaultValue: { kind: 'value', value: true } },
      showIf: { fieldId: trigger.fieldId, equals: true },
    });
    const nested = question('checkbox', {
      label: 'Reviewed',
      required: true,
      showIf: { fieldId: child.fieldId, equals: false },
    });
    const form = publicForm([trigger, child, nested], {
      edit: {
        session: 'short-session',
        expiresAt: '2027-01-15T12:00:00.000Z',
        values: { [trigger.fieldId]: false },
      },
    });
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options?: RequestInit) => {
        if (url === `${FORM_PATH}/edit-session`) return json(form);
        expect(url).toBe(`${FORM_PATH}/edits`);
        posted.push(JSON.parse(String(options?.body)));
        return json({ thankYou: '', allowAnother: false });
      }),
    );
    renderSharing(<PublicFormPage formId={FORM_ID} editToken="signed-link" />, null);
    await screen.findByRole('heading', { name: form.title });
    const user = userEvent.setup();
    expect(screen.queryByRole('checkbox', { name: 'Approved' })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'More details' }));
    expect((screen.getByRole('checkbox', { name: 'Approved' }) as HTMLInputElement).checked).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Save response' }));
    await waitFor(() =>
      expect(posted).toEqual([
        {
          session: 'short-session',
          values: { [trigger.fieldId]: true, [child.fieldId]: false, [nested.fieldId]: false },
        },
      ]),
    );
    expect(screen.getByRole('status').textContent).toContain('Your response was updated.');
  });

  it('restores a revealed checkbox default and submits the displayed answer', async () => {
    const name = question('text', { label: 'Name' });
    const trigger = question('checkbox', { label: 'More details' });
    const child = question('checkbox', {
      label: 'Approved',
      options: { defaultValue: { kind: 'value', value: true } },
      showIf: { fieldId: trigger.fieldId, equals: true },
    });
    const { user, posted } = await mount(publicForm([name, trigger, child]));
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
    await submit(user);
    expect(posted[0]!.values).toEqual({
      [name.fieldId]: 'Avery Quinn',
      [trigger.fieldId]: true,
      [child.fieldId]: true,
    });
  });

  it('reveals required questions from defaults and clears answers when their trigger stops matching', async () => {
    const parent = question('text', {
      label: 'Choice',
      options: { defaultValue: { kind: 'value', value: 'Yes' } },
    });
    const child = question('text', {
      label: 'Details',
      required: true,
      showIf: { fieldId: parent.fieldId, equals: 'Yes' },
    });
    const { user, posted } = await mount(publicForm([parent, child]));
    expect(screen.getByRole('textbox', { name: 'Details' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(posted).toEqual([]);
    await user.type(screen.getByRole('textbox', { name: 'Details' }), 'Discard me');
    await user.type(screen.getByRole('textbox', { name: 'Choice' }), 'No');
    await user.tab();
    expect(screen.queryByRole('textbox', { name: 'Details' })).toBeNull();
    await user.clear(screen.getByRole('textbox', { name: 'Choice' }));
    await user.type(screen.getByRole('textbox', { name: 'Choice' }), 'Yes');
    await user.tab();
    expect((screen.getByRole('textbox', { name: 'Details' }) as HTMLInputElement).value).toBe('');
    await user.clear(screen.getByRole('textbox', { name: 'Choice' }));
    await user.type(screen.getByRole('textbox', { name: 'Choice' }), 'No');
    await submit(user);
    expect(posted[0]!.values).toEqual({ [parent.fieldId]: 'No' });
  });

  it('submits blank required questions with usable defaults and blocks unusable defaults', async () => {
    const text = question('text', {
      required: true,
      options: { defaultValue: { kind: 'value', value: 'Open' } },
    });
    const number = question('number', {
      required: true,
      options: { defaultValue: { kind: 'value', value: 0 } },
    });
    const date = question('date', { required: true, options: { defaultValue: { kind: 'today' } } });
    const choice = question('singleSelect', {
      required: true,
      options: { choices, defaultValue: { kind: 'firstChoice' } },
    });
    const { user, posted } = await mount(publicForm([text, number, date, choice]));
    await submit(user);
    expect(posted[0]!.values).toEqual({});
    cleanup();
    const unusable = question('singleSelect', {
      required: true,
      options: { choices: [], defaultValue: { kind: 'firstChoice' } },
    });
    const held = await mount(publicForm([unusable]));
    await held.user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(held.posted).toEqual([]);
    expect(screen.getByText('Answer this question.')).toBeDefined();
  });

  it.each([
    ['text', 'Ada', 'Ada', {}],
    ['longText', 'First line\nSecond line', 'First line\nSecond line', {}],
    ['email', 'ada@example.test', 'ada@example.test', {}],
    ['url', 'https://example.test', 'https://example.test', {}],
    ['phone', '+15551234567', '+15551234567', {}],
    ['number', '12.5', 12.5, { precision: null }],
    ['currency', '12.5', 12.5, { code: 'USD', precision: 2 }],
    ['percent', '25', 0.25, { precision: 0 }],
    ['duration', '90', 90, {}],
    ['rating', '4', 4, { max: 5 }],
  ] as const)('submits %s answers with the ticket', async (type, input, expected, options) => {
    const asked = question(type, { options });
    const { user, posted } = await mount(publicForm([asked]));
    await user.type(screen.getByRole('textbox', { name: type }), input);
    await submit(user);
    expect(posted).toEqual([
      {
        ticket: '1790000000000.ticket',
        values: { [asked.fieldId]: expected },
        website: '',
        // The visitor's time zone decides the day a date left blank defaults to.
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    ]);
  });

  it('submits dates and checkboxes, including an unchecked required answer', async () => {
    const date = question('date', { required: true, options: { includeTime: false } });
    const box = question('checkbox', { required: true });
    const { user, posted } = await mount(publicForm([date, box]));
    await user.click(screen.getByRole('spinbutton', { name: /month/i }));
    await user.paste('2026-09-27');
    await user.click(screen.getByRole('checkbox', { name: 'checkbox' }));
    await user.click(screen.getByRole('checkbox', { name: 'checkbox' }));
    await submit(user);
    expect(posted[0]!.values).toEqual({ [date.fieldId]: '2026-09-27', [box.fieldId]: false });
  });

  it('starts a box checked by default checked, so clearing it is an answer', async () => {
    const box = question('checkbox', { options: { defaultValue: { kind: 'value', value: true } } });
    const { user, posted } = await mount(publicForm([box]));
    expect((screen.getByRole('checkbox', { name: 'checkbox' }) as HTMLInputElement).checked).toBe(true);
    await submit(user);
    await user.click(screen.getByRole('button', { name: 'Submit another response' }));
    await user.click(screen.getByRole('checkbox', { name: 'checkbox' }));
    await submit(user);
    expect(posted.map((body) => body.values)).toEqual([{ [box.fieldId]: true }, { [box.fieldId]: false }]);
  });

  it.each(['singleSelect', 'multipleSelect'] as const)('submits %s choice IDs', async (type) => {
    const asked = question(type, { options: { choices } });
    const { user, posted } = await mount(publicForm([asked]));
    await user.click(screen.getByRole('combobox', { name: type }));
    await user.type(screen.getByRole('combobox', { name: type }), 'Second');
    await user.click(await screen.findByRole('option', { name: 'Second' }));
    await user.tab();
    await submit(user);
    expect(posted[0]!.values).toEqual({
      [asked.fieldId]: type === 'singleSelect' ? choices[1]!.id : [choices[1]!.id],
    });
  });

  it('shows the title, description, help, and required markers, and blocks missing answers', async () => {
    const name = question('text', { label: 'Name', help: 'First and last.', required: true });
    const count = question('number', { label: 'Count', required: true });
    const notes = question('longText', { label: 'Notes' });
    const { user, posted } = await mount(publicForm([name, count, notes], { submitLabel: 'Send it' }));
    expect(screen.getByText('Tell us about yourself.')).toBeDefined();
    expect(within(screen.getByRole('group', { name: 'Name' })).getByText('First and last.')).toBeDefined();
    expect(within(screen.getByRole('group', { name: 'Name' })).getByText('Required')).toBeDefined();
    expect(within(screen.getByRole('group', { name: 'Notes' })).queryByText('Required')).toBeNull();

    await user.type(screen.getByRole('textbox', { name: 'Name' }), '   ');
    await user.click(screen.getByRole('button', { name: 'Send it' }));
    expect(posted).toEqual([]);
    expect(screen.getAllByText('Answer this question.')).toHaveLength(2);
    expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Name' }));
    expect(screen.getByRole('group', { name: 'Name' }).getAttribute('aria-invalid')).toBe('true');

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Ada');
    await user.type(screen.getByRole('textbox', { name: 'Count' }), '0');
    await submit(user, 'Send it');
    expect(posted[0]!.values).toEqual({ [name.fieldId]: 'Ada', [count.fieldId]: 0 });
  });

  it('keeps an answer the field can’t take from being sent', async () => {
    const email = question('email');
    const { user, posted } = await mount(publicForm([email]));
    await user.type(screen.getByRole('textbox', { name: 'email' }), 'not an address');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(posted).toEqual([]);
    expect(screen.getByRole('textbox', { name: 'email' }).getAttribute('aria-invalid')).toBe('true');
  });

  it('puts the server’s refusals where they belong and keeps the answers for another try', async () => {
    const name = question('text', { label: 'Name' });
    const replies = [
      error('validation_failed', 'data.form.required', 422, { fieldId: name.fieldId }),
      error('rate_limited', 'forms.public.rateLimited', 429),
      error('forbidden', 'forms.public.ticket', 403),
    ];
    const { user, posted } = await mount(publicForm([name]), (attempt) => {
      const reply = replies[attempt - 1];
      return reply ?? json({ thankYou: '', allowAnother: true });
    });
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Ada');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('group', { name: 'Name' })).getByText('Answer this question.'),
      ).toBeDefined(),
    );
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Too many responses from here.  Try again later.'),
    );
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'This form was open too long.  Reload it and try again.',
      ),
    );
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Ada');
    await submit(user);
    expect(posted).toHaveLength(4);
    expect(posted.every((body) => (body.values as Record<string, unknown>)[name.fieldId] === 'Ada')).toBe(
      true,
    );
  });

  it('thanks the person, then offers another response when the form allows it', async () => {
    const name = question('text', { label: 'Name' });
    const { user, posted } = await mount(publicForm([name]));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Ada');
    await submit(user);
    expect(screen.getByRole('status').textContent).toContain('Thanks!  Your answer was recorded.');
    expect(document.activeElement).toBe(screen.getByRole('status'));
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Submit another response' }));
    const field = (await screen.findByRole('textbox', { name: 'Name' })) as HTMLInputElement;
    expect(field.value).toBe('');
    await waitFor(() => expect(document.activeElement).toBe(field));
    await user.type(field, 'Grace');
    await submit(user);
    expect(posted.map((body) => body.values)).toEqual([
      { [name.fieldId]: 'Ada' },
      { [name.fieldId]: 'Grace' },
    ]);
    expect(posted.every((body) => body.ticket === '1790000000000.ticket')).toBe(true);
  });

  it('shows the form’s own thanks and no second response when it allows none', async () => {
    const { user } = await mount(
      publicForm([question('text', { label: 'Name' })], { thankYou: 'We got it.', allowAnother: false }),
    );
    await submit(user);
    expect(screen.getByRole('status').textContent).toBe('We got it.');
    expect(screen.queryByRole('button', { name: 'Submit another response' })).toBeNull();
  });

  it('sends whatever a script put in the hidden field, and people never reach it', async () => {
    const { user, posted } = await mount(publicForm([question('text', { label: 'Name' })]));
    const trap = document.querySelector<HTMLInputElement>('input[name="website"]')!;
    expect(trap.tabIndex).toBe(-1);
    expect(trap.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    fireEvent.change(trap, { target: { value: 'https://spam.example' } });
    await submit(user);
    expect(posted[0]!.website).toBe('https://spam.example');
  });

  it('waits out a new ticket’s first seconds instead of failing a quick person', async () => {
    const name = question('text', { label: 'Name' });
    const { posted } = serve(publicForm([name]));
    renderSharing(<PublicFormPage formId={FORM_ID} />, null);
    const user = userEvent.setup();
    await user.type(await screen.findByRole('textbox', { name: 'Name' }), 'Ada');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_000)));
    expect(posted).toEqual([]);
    await screen.findByRole('status', {}, { timeout: 4_000 });
    expect(posted).toHaveLength(1);
  });
});

describe('the public form page', () => {
  it('uses the database’s forced theme, and the default theme otherwise', async () => {
    await mount(publicForm([], { theme: { id: 'terminal', scheme: 'amber' } }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith({ theme: 'terminal', scheme: 'amber' }));
    cleanup();
    apply.mockClear();
    await mount(publicForm([]));
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith({ theme: DEFAULT_THEME.theme, scheme: DEFAULT_THEME.scheme }),
    );
  });

  it('shows a calm page for a stopped, missing, or malformed link', async () => {
    const { fetcher } = serve('missing');
    renderSharing(<PublicFormPage formId={FORM_ID} />, null);
    expect(await screen.findByRole('heading', { name: 'This form isn’t available.' })).toBeDefined();
    expect(document.body.textContent).toContain(
      'It may have been unshared or deleted.  Check the link with whoever sent it.',
    );
    expect(screen.getByText('Made with Riosoma')).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith({ theme: DEFAULT_THEME.theme, scheme: DEFAULT_THEME.scheme }),
    );
    cleanup();
    fetcher.mockClear();
    renderSharing(<PublicFormPage formId="not-a-form" />, null);
    expect(screen.getByRole('heading', { name: 'This form isn’t available.' })).toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('shows the same calm page while the person who shared the form is suspended', async () => {
    const { fetcher } = serve('paused');
    renderSharing(<PublicFormPage formId={FORM_ID} />, null);
    expect(await screen.findByRole('heading', { name: 'This form isn’t available.' })).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('says when the server can’t be reached, and tries again', async () => {
    const { fetcher } = serve('offline');
    renderSharing(<PublicFormPage formId={FORM_ID} />, null);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Riosoma can’t reach the server.'),
    );
    fetcher.mockImplementation(async () => json(publicForm([question('text', { label: 'Name' })])));
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Contact us' })).toBeDefined();
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeDefined();
  });

  it('works at phone width, with every control labeled and reachable by keyboard', async () => {
    (
      window as unknown as { happyDOM: { setViewport(size: { width: number; height: number }): void } }
    ).happyDOM.setViewport({ width: 375, height: 812 });
    const { user } = await mount(
      publicForm([
        question('text', { label: 'Name', required: true }),
        question('number', { label: 'Guests' }),
        question('date', { label: 'Arrival', options: { includeTime: false } }),
        question('checkbox', { label: 'Staying over' }),
        question('singleSelect', { label: 'Meal', options: { choices } }),
        question('rating', { label: 'Excitement', options: { max: 5 } }),
      ]),
    );
    expect(window.innerWidth).toBe(375);
    const controls = [
      ...screen.getAllByRole('textbox'),
      ...screen.getAllByRole('checkbox'),
      ...screen.getAllByRole('combobox'),
      ...screen.getAllByRole('spinbutton'),
    ];
    for (const control of controls) {
      const labeledBy = control.getAttribute('aria-labelledby')?.split(' ') ?? [];
      const named =
        control.getAttribute('aria-label') ||
        (control as HTMLInputElement).labels?.length ||
        labeledBy.some((id) => document.getElementById(id)?.textContent?.trim());
      expect(named, control.outerHTML).toBeTruthy();
    }
    for (const label of ['Name', 'Guests', 'Arrival', 'Staying over', 'Meal', 'Excitement'])
      expect(screen.getAllByRole('group', { name: label }).some((group) => group.tagName === 'SECTION')).toBe(
        true,
      );

    const reached = new Set<Element>();
    for (
      let i = 0;
      i < 20 && document.activeElement !== screen.getByRole('button', { name: 'Submit' });
      i += 1
    ) {
      await user.tab();
      reached.add(document.activeElement!);
    }
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Submit' }));
    for (const name of ['Name', 'Guests', 'Excitement'])
      expect(reached.has(screen.getByRole('textbox', { name }))).toBe(true);
    expect(reached.has(screen.getByRole('checkbox', { name: 'Staying over' }))).toBe(true);
    expect(reached.has(screen.getByRole('combobox', { name: 'Meal' }))).toBe(true);
    expect([...reached].some((element) => element.getAttribute('role') === 'spinbutton')).toBe(true);
    expect(reached.has(document.querySelector('input[name="website"]')!)).toBe(false);

    // The layout never asks for more room than a phone has: sizes flex to fit, and a small-screen
    // rule tightens the padding.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, property, value] of rules.matchAll(/(?:^|[\s;{])((?:min-)?inline-size):\s*([^;]+);/g))
      expect(['0', '1px', '100%', 'auto'], `${property}: ${value}`).toContain(value!.trim());
    expect(rules).toMatch(/@media \(max-width: 480px\)/);
    expect(rules).not.toMatch(/(?:^|[\s;{])(?:width|height|left|right|top|bottom|margin-left|margin-right):/);
  });
});
