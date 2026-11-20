import { useState } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DemoScript, DemoStep, SessionInfo } from '@riosoma/contracts';
import {
  Button,
  Dialog,
  ListBoxItem,
  Menu,
  MenuItem,
  MenuTrigger,
  Modal,
  Select,
  TextField,
} from '@riosoma/ui';
import type * as Director from '../audio/director';
import type { Narration, Playback } from '../audio/director';
import { inSandbox } from '../data/sandbox';
import { DocsPanel } from '../docs/DocsPanel';
import { sessionQuery } from '../session';
import { anchor } from './anchors';
import { Journal, restoreDemoFocus } from './actions';
import { DemoHost } from './DemoHost';
import { DemoLayer } from './DemoLayer';
import { DemoRunner, type RunnerDeps } from './runner';

// Tests never reach the system voice: the app's director gets no speech and no clips here.
vi.mock('../audio/director', async (importOriginal) => {
  const actual = await importOriginal<typeof Director>();
  return { ...actual, director: new actual.AudioDirector({ speech: null, clips: null }) };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'getAnimations');
});

const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });

it('returns demo focus after its start button becomes enabled on a later render', async () => {
  const trigger = document.createElement('button');
  trigger.disabled = true;
  document.body.append(trigger);
  const cancel = restoreDemoFocus(trigger);
  try {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    expect(document.activeElement).not.toBe(trigger);
    trigger.disabled = false;
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  } finally {
    cancel();
    trigger.remove();
  }
});

it('cancels pending demo focus when another interaction takes over', async () => {
  const trigger = document.createElement('button');
  const next = document.createElement('button');
  trigger.disabled = true;
  document.body.append(trigger, next);
  const cancel = restoreDemoFocus(trigger);
  try {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    cancel();
    next.focus();
    trigger.disabled = false;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(document.activeElement).toBe(next);
  } finally {
    cancel();
    trigger.remove();
    next.remove();
  }
});

it('waits for a lazy surface and its entry animation before journaling and dismissing it', async () => {
  const { container } = render(<button aria-controls="deferred-panel" />);
  const trigger = screen.getByRole('button');
  const pending = document.createElement('aside');
  pending.id = 'deferred-panel';
  const loading = document.createElement('div');
  loading.className = 'rio-feature-loading';
  pending.append(loading);
  const panel = document.createElement('aside');
  panel.id = 'deferred-panel';
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const animation = {
    playState: 'running',
    effect: { getComputedTiming: () => ({ endTime: 150 }) },
    finished,
  } as unknown as Animation;
  Object.defineProperty(panel, 'getAnimations', { value: () => [animation] });
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') panel.remove();
  });
  trigger.addEventListener('click', () => container.append(pending));
  const wait = vi.fn(async () => {
    if (pending.isConnected) pending.replaceWith(panel);
  });
  const pacing = { instant: true, keepPace: () => true, wait };
  const journal = new Journal(document);
  let ready = false;
  const opening = journal.open(trigger, pacing).then(() => {
    ready = true;
  });
  await waitFor(() => expect(wait).toHaveBeenCalled());
  expect(ready).toBe(false);
  finish();
  await opening;
  expect(ready).toBe(true);
  expect(panel.isConnected).toBe(true);
  await journal.restore(pacing);
  expect(panel.isConnected).toBe(false);
});

it('finishes restoring an exiting dialog before handing focus back', async () => {
  const trigger = document.createElement('button');
  const panel = document.createElement('aside');
  panel.append(document.createElement('button'));
  document.body.append(trigger);
  trigger.addEventListener('click', () => document.body.append(panel));
  let closing = false;
  let closingPaints = 0;
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closing = true;
      panel.setAttribute('data-exiting', '');
    }
  });
  const pacing = {
    instant: true,
    keepPace: () => true,
    wait: async () => {
      // The first closing paint leaves the modal's focus scope mounted.
      if (closing && ++closingPaints === 2) {
        panel.remove();
        trigger.focus();
      }
    },
  };
  try {
    const journal = new Journal(document);
    await journal.open(trigger, pacing);
    await journal.restore(pacing);
    expect(panel.isConnected).toBe(false);
    expect(document.activeElement).toBe(trigger);
  } finally {
    panel.remove();
    trigger.remove();
  }
});

/** A page with a few of the app's controls, anchored the way the app anchors them. */
function Page({ onChoose, onSave }: { onChoose(key: string): void; onSave(): void }) {
  const [name, setName] = useState('');
  return (
    <main>
      <ul {...anchor('database.tables')}>
        <li>Tasks</li>
      </ul>
      <MenuTrigger>
        <Button {...anchor('database.views.add')}>Add view</Button>
        <Menu aria-label="Add view" onAction={(key) => onChoose(String(key))}>
          <MenuItem id="kanban">Kanban</MenuItem>
          <MenuItem id="form">Form</MenuItem>
        </Menu>
      </MenuTrigger>
      <TextField {...anchor('field.name')} label="Name" value={name} onChange={setName} />
      <Button {...anchor('field.create')} onPress={onSave}>
        Create field
      </Button>
    </main>
  );
}

/** A dialog with a list inside it, which floats outside the dialog while it's open. */
function DialogPage() {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState('text');
  return (
    <>
      <Button {...anchor('grid.field.add')} onPress={() => setOpen(true)}>
        Add field
      </Button>
      {open ? (
        <Modal isOpen isDismissable onOpenChange={(next) => (next ? undefined : setOpen(false))}>
          <Dialog aria-label="New field">
            <TextField {...anchor('field.name')} label="Name" autoFocus />
            <Select
              {...anchor('field.type')}
              label="Type"
              selectedKey={type}
              onSelectionChange={(key) => setType(String(key))}
            >
              <ListBoxItem id="text">Text</ListBoxItem>
              <ListBoxItem id="date">Date</ListBoxItem>
            </Select>
            <Button {...anchor('field.create')}>Create field</Button>
          </Dialog>
        </Modal>
      ) : null}
    </>
  );
}

function script(steps: DemoStep[], where: DemoScript['where'] = 'anywhere'): DemoScript {
  return { id: 'fields', where, steps };
}

const TOUR = script([
  { anchor: 'database.tables', say: 'line.tables' },
  { anchor: 'database.views.add', say: 'line.open', do: 'open' },
  { anchor: 'database.views.add', item: 'kanban', say: 'line.kanban' },
  { anchor: 'field.name', say: 'line.name', do: 'type', text: 'demos.fields.sampleName' },
  { anchor: 'field.create', say: 'line.create' },
]);

/** Narration the test finishes line by line, so it sets the demo's pace. */
function lines() {
  const said: Array<{ line: Narration; end(): void; stop: ReturnType<typeof vi.fn> }> = [];
  const narrate = (line: Narration): Playback => {
    let settle!: (result: 'ended' | 'stopped') => void;
    const done = new Promise<'ended' | 'stopped'>((resolve) => {
      settle = resolve;
    });
    const stop = vi.fn(() => settle('stopped'));
    said.push({ line, end: () => settle('ended'), stop });
    return { done, stop };
  };
  return { said, narrate };
}

function setup(
  demo: DemoScript,
  options: { reduced?: boolean; aboveLevel?: boolean; page?: boolean; dialog?: boolean } = {},
) {
  const onChoose = vi.fn();
  const onSave = vi.fn();
  const sandbox = { begin: vi.fn(), reset: vi.fn(), end: vi.fn() };
  const narration = lines();
  const deps: RunnerDeps = {
    document,
    narrate: narration.narrate,
    stopNarration: vi.fn(),
    sandbox,
    say: (id) => (id === 'demos.fields.sampleName' ? 'Due date' : id),
    lang: 'en-US',
    reducedMotion: () => options.reduced ?? false,
    aboveLevel: options.aboveLevel ?? false,
    timing: { find: 300, beat: 0, gap: 0 },
  };
  const runner = new DemoRunner(demo, deps);
  const view = render(
    <I18nProvider i18n={i18n}>
      {options.dialog ? (
        <DialogPage />
      ) : options.page === false ? null : (
        <Page onChoose={onChoose} onSave={onSave} />
      )}
      <DemoLayer runner={runner} muted reducedMotion={options.reduced ?? false} onMute={vi.fn()} />
    </I18nProvider>,
  );
  return { runner, onChoose, onSave, sandbox, said: narration.said, view };
}

const caption = () => document.querySelector('.rio-demo-card__caption')?.textContent;
const nameField = () => screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement;

describe('the demo runner', () => {
  it('points at each control and moves on at the narration’s pace', async () => {
    const { runner, said, sandbox } = setup(TOUR);
    void runner.start();
    expect(sandbox.begin).toHaveBeenCalled();
    await waitFor(() => expect(said).toHaveLength(1));
    expect(caption()).toBe('line.tables');
    expect(runner.getState().target).toBe(document.querySelector('[data-anchor="database.tables"]'));
    // Nothing moves until the line has been said.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runner.getState().index).toBe(0);
    act(() => said[0]!.end());
    await waitFor(() => expect(screen.getByRole('menu', { name: 'Add view' })).toBeDefined());
    expect(caption()).toBe('line.open');
    act(() => said[1]!.end());
    await waitFor(() => expect(runner.getState().target?.getAttribute('data-key')).toBe('kanban'));
    act(() => said[2]!.end());
    await waitFor(() => expect(nameField().value).toBe('Due date'));
    act(() => said[3]!.end());
    await waitFor(() => expect(caption()).toBe('line.create'));
    act(() => said[4]!.end());
    await waitFor(() => expect(runner.getState().status).toBe('ended'));
    expect(runner.getState().outcome).toBe('finished');
  });

  it('pauses, steps forward and back, and stops, leaving the page exactly as it was', async () => {
    const { runner, said, sandbox, onChoose, onSave } = setup(TOUR);
    void runner.start();
    await waitFor(() => expect(said).toHaveLength(1));
    act(() => said[0]!.end());
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeNull());

    act(() => runner.pause());
    expect(runner.getState().status).toBe('paused');
    expect(said[1]!.stop).toHaveBeenCalled();
    // Stepping while paused moves without speaking.
    await act(() => runner.next());
    expect(runner.getState().index).toBe(2);
    expect(said).toHaveLength(2);
    await act(() => runner.next());
    await waitFor(() => expect(nameField().value).toBe('Due date'));

    // Back puts the page as it was before the step, and does the earlier steps again.
    await act(() => runner.back());
    expect(runner.getState().index).toBe(2);
    expect(sandbox.reset).toHaveBeenCalledTimes(1);
    expect(nameField().value).toBe('');
    expect(screen.getByRole('menu', { name: 'Add view' })).toBeDefined();

    act(() => runner.resume());
    expect(runner.getState().status).toBe('playing');
    await waitFor(() => expect(said).toHaveLength(3));
    expect(said[2]!.line.text).toBe('line.kanban');

    await act(() => runner.stop());
    expect(runner.getState()).toMatchObject({ status: 'ended', outcome: 'stopped' });
    expect(sandbox.end).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(nameField().value).toBe('');
    expect(onChoose).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    // The layer is still mounted here, the way the host keeps it until it hears the end.
    expect(document.querySelector('.rio-demo-highlight')).toBeNull();
  });

  it('keeps a dialog open while a list opened inside it comes and goes, and closes both at the end', async () => {
    const { runner, said } = setup(
      script([
        { anchor: 'grid.field.add', say: 'line.add', do: 'open' },
        { anchor: 'field.type', say: 'line.type', do: 'open' },
        { anchor: 'field.type', item: 'date', say: 'line.date', do: 'choose' },
        { anchor: 'field.create', say: 'line.create' },
      ]),
      { dialog: true },
    );
    void runner.start();
    for (let index = 0; index < 3; index++) {
      await waitFor(() => expect(said).toHaveLength(index + 1));
      act(() => said[index]!.end());
    }
    await waitFor(() => expect(caption()).toBe('line.create'));
    const dialog = screen.getByRole('dialog', { name: 'New field' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(dialog.textContent).toContain('Date');
    await act(() => runner.stop());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New field' })).toBeNull());
  });

  it('keeps the demo controls focused after a dialog autofocuses on a later paint', async () => {
    const open = Journal.prototype.open;
    vi.spyOn(Journal.prototype, 'open').mockImplementation(async function (this: Journal, element, pacing) {
      await open.call(this, element, pacing);
      // Portal focus effects can run after the dialog has become discoverable.
      requestAnimationFrame(() => screen.getByRole('textbox', { name: 'Name' }).focus());
    });
    const { runner } = setup(script([{ anchor: 'grid.field.add', say: 'line.add', do: 'open' }]), {
      dialog: true,
    });
    await act(() => runner.start());
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(screen.getByRole('dialog', { name: 'New field' })).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Pause' }));
    await act(() => runner.stop());
  });

  it('keeps the demo controls focused after dialog autofocus waits for transitions', async () => {
    let finish!: () => void;
    let opened!: () => void;
    const opening = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const animation = {
      playState: 'running' as AnimationPlayState,
      effect: { getComputedTiming: () => ({ endTime: 250 }) },
      finished,
    };
    Object.defineProperty(document, 'getAnimations', {
      configurable: true,
      value: () => [animation],
    });
    const open = Journal.prototype.open;
    vi.spyOn(Journal.prototype, 'open').mockImplementation(async function (this: Journal, element, pacing) {
      await open.call(this, element, pacing);
      // Virtual focus waits for transitions before focusing a newly opened dialog.
      void finished.then(() => {
        animation.playState = 'finished';
        screen.getByRole('textbox', { name: 'Name' }).focus();
      });
      opened();
    });
    const { runner } = setup(script([{ anchor: 'grid.field.add', say: 'line.add', do: 'open' }]), {
      dialog: true,
    });
    const started = runner.start();
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'New field' })).toBeDefined());
    await act(async () => {
      await opening;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
    });
    await act(async () => {
      finish();
      await started;
    });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Pause' }));
    await act(() => runner.stop());
  });

  it('works from the keyboard: its controls take focus, Escape stops it, and the caption is announced', async () => {
    const user = userEvent.setup();
    const { runner, said } = setup(TOUR);
    void runner.start();
    await waitFor(() => expect(said).toHaveLength(1));
    const controls = screen.getByRole('toolbar', { name: 'Demo controls' });
    expect(screen.getByRole('region', { name: 'Demo' })).toBeDefined();
    // Back has nowhere to go on the first step, so Pause takes focus.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Pause' })));
    expect(controls.contains(document.activeElement)).toBe(true);
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe('line.tables');
    expect(live?.getAttribute('aria-atomic')).toBe('true');
    expect(screen.getByText('Step 1 of 5')).toBeDefined();

    await user.keyboard('{Enter}');
    expect(runner.getState().status).toBe('paused');
    expect(screen.getByRole('button', { name: 'Play' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(live?.textContent).toBe('line.open'));
    // Narration is off until the person turns it on.
    expect(screen.getByRole('button', { name: 'Narration' }).getAttribute('aria-pressed')).toBe('false');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(runner.getState().status).toBe('ended'));
    expect(runner.getState().outcome).toBe('stopped');
  });

  it('moves without animating when motion is reduced', async () => {
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined);
    const typed: string[] = [];
    const { runner, said } = setup(
      script([
        { anchor: 'field.name', say: 'line.name', do: 'type', text: 'demos.fields.sampleName' },
        { anchor: 'database.tables', say: 'line.tables', do: 'scroll' },
      ]),
      { reduced: true },
    );
    nameField().addEventListener('input', (event) => typed.push((event.target as HTMLInputElement).value));
    void runner.start();
    await waitFor(() => expect(nameField().value).toBe('Due date'));
    // The whole value arrives at once, not a letter at a time.
    expect(typed).toEqual(['Due date']);
    expect(document.querySelector('.rio-demo-layer')?.getAttribute('data-motion')).toBe('reduced');
    act(() => said[0]!.end());
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    expect(scrolled.mock.calls[0]![0]).toMatchObject({ behavior: 'auto' });
  });

  it('types a letter at a time with motion on', async () => {
    const typed: string[] = [];
    const { runner } = setup(
      script([{ anchor: 'field.name', say: 'line.name', do: 'type', text: 'demos.fields.sampleName' }]),
    );
    nameField().addEventListener('input', (event) => typed.push((event.target as HTMLInputElement).value));
    void runner.start();
    await waitFor(() => expect(nameField().value).toBe('Due date'));
    expect(typed[0]).toBe('D');
    expect(typed).toHaveLength('Due date'.length);
  });

  it('says so and stops when a step’s control isn’t there', async () => {
    const missing = script([
      { anchor: 'database.tables', say: 'line.tables' },
      { anchor: 'view.toolbar', say: 'line.toolbar' },
    ]);
    const first = setup(missing);
    void first.runner.start();
    await waitFor(() => expect(first.said).toHaveLength(1));
    act(() => first.said[0]!.end());
    await waitFor(() => expect(first.runner.getState().status).toBe('ended'));
    expect(first.runner.getState().outcome).toBe('access');
    expect(first.sandbox.end).toHaveBeenCalled();
    cleanup();

    // Above the person's level, it says that instead.
    const above = setup(missing, { aboveLevel: true });
    void above.runner.start();
    await waitFor(() => expect(above.said).toHaveLength(1));
    act(() => above.said[0]!.end());
    await waitFor(() => expect(above.runner.getState().outcome).toBe('level'));
    cleanup();

    // And a demo that starts on a table says where to go when the page has none.
    const elsewhere = setup(script([{ anchor: 'view.toolbar', say: 'line.toolbar' }], 'table'));
    await elsewhere.runner.start();
    await waitFor(() => expect(elsewhere.runner.getState().outcome).toBe('where'));
  });

  it('refuses a step that would press something that saves', async () => {
    const pressSave = setup(script([{ anchor: 'field.create', say: 'line.create', do: 'open' }]));
    void pressSave.runner.start();
    await waitFor(() => expect(pressSave.runner.getState().outcome).toBe('refused'));
    expect(pressSave.onSave).not.toHaveBeenCalled();
    expect(pressSave.sandbox.end).toHaveBeenCalled();
    cleanup();

    // The page's own marks count too: a submit button is refused whatever its anchor says.
    const submitted = vi.fn((event: SubmitEvent) => event.preventDefault());
    const form = setup(script([{ anchor: 'view.sort.add', say: 'line.sort', do: 'choose' }]), {
      page: false,
    });
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = '<form><button type="submit" data-anchor="view.sort.add">Add sort</button></form>';
    dialog.querySelector('form')!.addEventListener('submit', submitted);
    document.body.append(dialog);
    void form.runner.start();
    await waitFor(() => expect(form.runner.getState().outcome).toBe('refused'));
    expect(submitted).not.toHaveBeenCalled();
    dialog.remove();
  });
});

describe('Show me', () => {
  it('plays a help module’s demo from its button, says why it stopped, and hands focus back', async () => {
    const user = userEvent.setup();
    const client = new QueryClient();
    client.setQueryData(sessionQuery.queryKey, { user: { id: 'user-one' }, preferences: {} } as SessionInfo);
    render(
      <QueryClientProvider client={client}>
        <I18nProvider i18n={i18n}>
          <DemoHost>
            <DocsPanel moduleId="views" onOpen={vi.fn()} onClose={vi.fn()} />
          </DemoHost>
        </I18nProvider>
      </QueryClientProvider>,
    );
    const showMe = await screen.findByRole('button', { name: 'Show me' });
    await user.click(showMe);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Demo' })).toBeDefined());
    expect(inSandbox()).toBe(true);
    // This page has no table, which is where the views demo starts.
    const alert = await screen.findByRole('alert', {}, { timeout: 6_000 });
    expect(alert.textContent).toContain('This demo starts on a table.');
    expect(inSandbox()).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show me' })));
    expect(screen.queryByRole('region', { name: 'Demo' })).toBeNull();
  });
});
