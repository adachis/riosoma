import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toastQueue } from '@riosoma/ui';
import { newId, type Command } from '@riosoma/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setCsrfToken } from '../../../api';
import { describeAction } from '../undo/describe';
import { reduceRun, IDLE } from './runner';
import { fakeSockets, renderScripts, scriptFixture, scriptMeta, type ScriptFixture } from './test-support';

const fixtures: ScriptFixture[] = [];
beforeEach(() => setCsrfToken('panel-csrf'));
afterEach(() => {
  cleanup();
  fixtures.splice(0).forEach((fixture) => fixture.session.close());
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  setCsrfToken(null);
});

async function mount(options: Parameters<typeof scriptFixture>[0] = {}, open = true) {
  const fixture = await scriptFixture({
    scripts: (databaseId) => [
      scriptMeta(databaseId, 'Tidy names', 'await output.text("tidy")', 0),
      scriptMeta(databaseId, 'Weekly report', 'await output.markdown("# Report")', 1),
    ],
    ...options,
  });
  fixtures.push(fixture);
  const { sockets, connect } = fakeSockets();
  renderScripts(fixture, connect, open ? fixture.scripts[0]!.id : null);
  // The router renders once it has loaded.
  await screen.findByRole('navigation', { name: 'Sidebar' });
  return { fixture, sockets };
}

/** Commands the fake server received, in order */
function commands(fixture: ScriptFixture): Command[] {
  return fixture.server.requests
    .filter((request) => request.path.endsWith('/commands'))
    .flatMap((request) => (request.options.body as { commands: Command[] }).commands);
}

const sidebar = () => screen.getByRole('region', { name: 'Scripts' });
const panel = () => screen.getByRole('complementary', { name: 'Tidy names' });
/** The line under the Run button that says how the run is going */
const status = () => panel().querySelector('.rio-script-panel__status')?.textContent;

async function runScript(sockets: ReturnType<typeof fakeSockets>['sockets']) {
  await userEvent.click(within(panel()).getByRole('button', { name: 'Run' }));
  await waitFor(() => expect(sockets.at(-1)?.sent).toContainEqual({ type: 'start', csrf: 'panel-csrf' }));
  const socket = sockets.at(-1)!;
  act(() =>
    socket.push({
      type: 'started',
      runId: 'job00000000000001',
      groupId: 'act00000000000001',
      timeoutMs: 60_000,
      runMs: 1_800_000,
    }),
  );
  return socket;
}

describe('the scripts section', () => {
  it('lists the database’s scripts and opens one in the panel', async () => {
    const { fixture } = await mount({}, false);
    const items = within(sidebar()).getAllByRole('button', { pressed: false });
    expect(items.map((item) => item.textContent)).toEqual(['Tidy names', 'Weekly report']);
    await userEvent.click(within(sidebar()).getByRole('button', { name: 'Weekly report' }));
    const opened = await screen.findByRole('complementary', { name: 'Weekly report' });
    expect(
      within(sidebar()).getByRole('button', { name: 'Weekly report' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(within(opened).getByRole('textbox', { name: 'JavaScript' })).toBeDefined();
    await userEvent.click(within(opened).getByRole('button', { name: 'Close script' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(fixture.session.getSchema().scripts).toHaveLength(2);
  });

  it('lets people who can change the schema add, rename, and delete scripts, with undo', async () => {
    const { fixture } = await mount({}, false);
    await userEvent.click(within(sidebar()).getByRole('button', { name: 'Add a script' }));
    expect(await screen.findByRole('complementary', { name: 'Untitled script' })).toBeDefined();
    await userEvent.click(within(sidebar()).getByRole('button', { name: 'More for Tidy names' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const name = within(sidebar()).getByRole('textbox', { name: 'Rename' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Tidy every name{Enter}');
    await userEvent.click(within(sidebar()).getByRole('button', { name: 'More for Weekly report' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete script' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Weekly report?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete script' }));
    await waitFor(() =>
      expect(commands(fixture).map((command) => command.kind)).toEqual([
        'script.create',
        'script.update',
        'script.trash',
      ]),
    );
    expect(within(sidebar()).queryByRole('button', { name: 'Weekly report' })).toBeNull();
    expect(within(sidebar()).getByRole('button', { name: 'Tidy every name' })).toBeDefined();
    const history = fixture.session
      .undoHistory()
      .undo.map((entry) => describeAction(entry.summary, (descriptor) => String(descriptor.message)));
    expect(history).toHaveLength(3);
    await fixture.session.undo();
    await waitFor(() =>
      expect(within(sidebar()).getByRole('button', { name: 'Weekly report' })).toBeDefined(),
    );
  });

  it('shows editors the scripts to run without the code or the controls to change them', async () => {
    const { sockets } = await mount({ role: 'editor' });
    expect(within(sidebar()).queryByRole('button', { name: 'Add a script' })).toBeNull();
    expect(within(sidebar()).queryByRole('button', { name: 'More for Tidy names' })).toBeNull();
    expect(within(panel()).queryByRole('textbox', { name: 'JavaScript' })).toBeNull();
    const socket = await runScript(sockets);
    act(() => socket.push({ type: 'finished', state: 'succeeded', writes: 0, ms: 3, error: null }));
    expect(await within(panel()).findByText('Finished in 3 ms')).toBeDefined();
  });

  it('leaves the section out for people who can’t run scripts', async () => {
    await mount({ role: 'commenter' }, false);
    expect(screen.queryByRole('region', { name: 'Scripts' })).toBeNull();
  });
});

describe('the script panel', () => {
  it('saves the code a moment after typing stops, and before a run', async () => {
    const { fixture, sockets } = await mount();
    const code = within(panel()).getByRole('textbox', { name: 'JavaScript' });
    await userEvent.clear(code);
    await userEvent.type(code, 'await output.text("new")');
    await runScript(sockets);
    const updates = commands(fixture).filter((command) => command.kind === 'script.update');
    expect(updates.at(-1)).toMatchObject({ source: 'await output.text("new")' });
    // The run started only after the server had the new code.
    const saved = fixture.server.requests.findIndex(
      (request) =>
        request.path.endsWith('/commands') &&
        JSON.stringify(request.options.body).includes('await output.text(\\"new\\")'),
    );
    expect(saved).toBeGreaterThanOrEqual(0);
  });

  it('shows logs, text, Markdown, and tables as the run streams them, and never reads output as HTML', async () => {
    const { sockets } = await mount();
    const socket = await runScript(sockets);
    expect(status()).toBe('Running…');
    act(() =>
      socket.push(
        { type: 'log', level: 'info', text: 'Starting' },
        { type: 'log', level: 'error', text: 'Something broke' },
        { type: 'output', output: { kind: 'text', text: 'Plain <b>text</b>' } },
        {
          type: 'output',
          output: {
            kind: 'markdown',
            text: '## Done\n\n**3** names, [details](https://example.test) <img src=x onerror=alert(1)>',
          },
        },
        { type: 'output', output: { kind: 'table', columns: ['Name', ''], rows: [['Ada', '36']] } },
      ),
    );
    const log = within(panel()).getByRole('log');
    expect(within(log).getByRole('list').tagName).toBe('OL');
    expect(within(log).getAllByRole('listitem')).toHaveLength(5);
    expect(within(log).getByText('Starting')).toBeDefined();
    expect(log.querySelector('[data-level="error"]')?.textContent).toBe('Error Something broke');
    expect(within(log).getByText('Plain <b>text</b>')).toBeDefined();
    expect(within(log).getByRole('heading', { name: 'Done' })).toBeDefined();
    expect(within(log).getByRole('link', { name: 'details' }).getAttribute('href')).toBe(
      'https://example.test',
    );
    expect(log.querySelector('img')).toBeNull();
    expect(log.textContent).toContain('<img src=x onerror=alert(1)>');
    const table = within(log).getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Name', 'Value']);
    expect(
      within(table)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['Ada', '36']);
  });

  it('answers text, button, table, and record prompts, and the script carries on', async () => {
    const { fixture, sockets } = await mount();
    const socket = await runScript(sockets);
    act(() => socket.push({ type: 'prompt', promptId: 1, prompt: { kind: 'text', label: 'Your name?' } }));
    const text = await within(panel()).findByRole('region', { name: 'Your name?' });
    expect(status()).toBe('Waiting for your answer');
    await userEvent.type(within(text).getByRole('textbox', { name: 'Your answer' }), 'Ada{Enter}');
    expect(socket.sent.at(-1)).toEqual({ type: 'answer', promptId: 1, value: 'Ada' });
    expect(within(panel()).queryByRole('region', { name: 'Your name?' })).toBeNull();

    act(() =>
      socket.push({
        type: 'prompt',
        promptId: 2,
        prompt: { kind: 'buttons', label: 'Pick', options: ['Yes', 'No'] },
      }),
    );
    await userEvent.click(await within(panel()).findByRole('button', { name: 'No' }));
    expect(socket.sent.at(-1)).toEqual({ type: 'answer', promptId: 2, value: 1 });

    act(() => socket.push({ type: 'prompt', promptId: 3, prompt: { kind: 'table', label: 'Which table?' } }));
    const table = await within(panel()).findByRole('region', { name: 'Which table?' });
    await userEvent.click(within(table).getByRole('button', { name: /Table/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Tasks' }));
    await userEvent.click(within(table).getByRole('button', { name: 'Continue' }));
    expect(socket.sent.at(-1)).toEqual({ type: 'answer', promptId: 3, value: fixture.tableId });

    act(() =>
      socket.push({
        type: 'prompt',
        promptId: 4,
        prompt: { kind: 'record', label: 'Which task?', tableId: fixture.tableId },
      }),
    );
    const record = await within(panel()).findByRole('region', { name: 'Which task?' });
    const combo = within(record).getByRole('combobox', { name: 'Record in Tasks' });
    await userEvent.click(combo);
    await userEvent.click(await screen.findByRole('option', { name: 'Record 2' }));
    await userEvent.click(within(record).getByRole('button', { name: 'Continue' }));
    expect(socket.sent.at(-1)).toEqual({ type: 'answer', promptId: 4, value: fixture.recordId(1) });
  });

  it('asks before a script deletes, and stops the run from a prompt', async () => {
    const { fixture, sockets } = await mount();
    const socket = await runScript(sockets);
    act(() =>
      socket.push({
        type: 'prompt',
        promptId: 1,
        prompt: { kind: 'delete', tableId: fixture.tableId, count: 2 },
      }),
    );
    const question = await within(panel()).findByRole('region', { name: 'Delete 2 records from Tasks?' });
    await userEvent.click(within(question).getByRole('button', { name: 'Don’t delete' }));
    expect(socket.sent.at(-1)).toEqual({ type: 'answer', promptId: 1, value: false });
    act(() =>
      socket.push({
        type: 'prompt',
        promptId: 2,
        prompt: { kind: 'delete', tableId: fixture.tableId, count: 1 },
      }),
    );
    const again = await within(panel()).findByRole('region', { name: 'Delete 1 record from Tasks?' });
    await userEvent.click(within(again).getByRole('button', { name: 'Delete' }));
    expect(socket.sent.at(-1)).toEqual({ type: 'answer', promptId: 2, value: true });
    act(() =>
      socket.push({ type: 'prompt', promptId: 3, prompt: { kind: 'text', label: 'Anything else?' } }),
    );
    const last = await within(panel()).findByRole('region', { name: 'Anything else?' });
    await userEvent.click(within(last).getByRole('button', { name: 'Stop script' }));
    expect(socket.sent.at(-1)).toEqual({ type: 'cancel' });
    act(() =>
      socket.push({
        type: 'finished',
        state: 'canceled',
        writes: 0,
        ms: 2,
        error: { messageKey: 'scripts.run.canceled' },
      }),
    );
    expect(await within(panel()).findByText('The script was stopped.')).toBeDefined();
    expect(status()).toBe('Stopped');
  });

  it('puts a run’s writes in the undo history as one step named for the script', async () => {
    const { fixture, sockets } = await mount();
    const socket = await runScript(sockets);
    act(() => socket.push({ type: 'wrote', writes: 1 }, { type: 'wrote', writes: 3 }));
    act(() => socket.push({ type: 'finished', state: 'succeeded', writes: 3, ms: 12, error: null }));
    expect(await within(panel()).findByText('Finished in 12 ms · Changed 3 records')).toBeDefined();
    const [entry] = fixture.session.undoHistory().undo;
    expect(entry).toMatchObject({
      groupId: 'act00000000000001',
      summary: { kind: 'script.run', name: 'Tidy names' },
    });
    expect(describeAction(entry!.summary, (descriptor) => String(descriptor.message))).toContain('script');
    await fixture.session.undo();
    const undo = fixture.server.requests.find((request) => request.path.endsWith('/undo'));
    expect(undo?.options.body).toMatchObject({ groupId: 'act00000000000001' });
  });

  it('keeps writes made before the connection dropped undoable, and says the run stopped', async () => {
    const { fixture, sockets } = await mount();
    const socket = await runScript(sockets);
    act(() => socket.push({ type: 'wrote', writes: 2 }));
    act(() => socket.close());
    expect(
      await within(panel()).findByText('The connection to the server closed, so the script stopped.'),
    ).toBeDefined();
    expect(fixture.session.undoHistory().undo[0]?.groupId).toBe('act00000000000001');
  });

  it('marks the line a failed run stopped on, and says why', async () => {
    const { sockets } = await mount();
    const socket = await runScript(sockets);
    act(() =>
      socket.push({
        type: 'finished',
        state: 'failed',
        writes: 0,
        ms: 1,
        error: {
          messageKey: 'automations.script.thrown',
          detail: 'scripts.delete.declined',
          line: 1,
          column: 7,
        },
      }),
    );
    expect(await within(panel()).findByText('The script threw an error.')).toBeDefined();
    expect(within(panel()).getByText('You chose not to delete, so nothing was deleted.')).toBeDefined();
    expect(within(panel()).getByText('Line 1, column 7')).toBeDefined();
    expect(within(panel()).getByRole('textbox', { name: 'JavaScript' }).getAttribute('aria-invalid')).toBe(
      'true',
    );
  });

  it('stops its run when it closes', async () => {
    const { sockets } = await mount();
    const socket = await runScript(sockets);
    await userEvent.click(within(panel()).getByRole('button', { name: 'Close script' }));
    expect(socket.closed).toBe(true);
  });
});

describe('a run as the panel follows it', () => {
  it('ends a run the socket lost without a word, and leaves a finished one alone', () => {
    const running = reduceRun(reduceRun(IDLE, { type: 'reset' }), {
      type: 'started',
      runId: 'job',
      groupId: newId('action'),
      timeoutMs: 1,
      runMs: 1,
    });
    expect(reduceRun(running, { type: 'lost' })).toMatchObject({
      status: 'failed',
      error: { messageKey: 'scripts.run.lost' },
    });
    const finished = reduceRun(running, {
      type: 'finished',
      state: 'succeeded',
      writes: 0,
      ms: 1,
      error: null,
    });
    expect(reduceRun(finished, { type: 'lost' })).toBe(finished);
  });
});
