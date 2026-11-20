import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { toastQueue } from '@riosoma/ui';
import { dragItem } from '../../../test/sortable';
import {
  automationFixture,
  automationMeta,
  bridgeFetch,
  renderScreen,
  savedConfig,
  type AutomationFixture,
} from './test-support';

const fixtures: AutomationFixture[] = [];
afterEach(() => {
  cleanup();
  fixtures.splice(0).forEach((fixture) => fixture.session.close());
  vi.unstubAllGlobals();
  for (const toast of toastQueue.visibleToasts) toastQueue.close(toast.key);
  window.history.replaceState(null, '', window.location.pathname);
});
async function mount() {
  const fixture = await automationFixture({
    automations: ({ databaseId, tasks }) => [
      automationMeta(databaseId, 'Routing', { trigger: { kind: 'recordCreated', tableId: tasks.id } }),
    ],
  });
  fixtures.push(fixture);
  vi.stubGlobal('fetch', bridgeFetch(fixture.server));
  const id = fixture.session.getSchema().automations[0]!.id;
  renderScreen(fixture, id);
  await screen.findByRole('switch');
  return { ...fixture, id, saved: () => savedConfig(fixture, id) };
}

it('adds labeled branches and saves nested loop and wait settings', async () => {
  const { saved } = await mount();
  await userEvent.click(screen.getByRole('button', { name: 'Add a step' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /^If$/ }));
  expect(screen.getByRole('heading', { name: 'Conditions met' })).toBeDefined();
  expect(screen.getByRole('heading', { name: 'Otherwise' })).toBeDefined();
  const path = screen.getByRole('heading', { name: 'Conditions met' }).closest('section')!;
  await userEvent.click(within(path).getByRole('button', { name: 'Add a step' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Repeat for each' }));
  const body = screen.getByRole('heading', { name: 'Each item' }).closest('section')!;
  await userEvent.click(within(body).getByRole('button', { name: 'Add a step' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /^Wait$/ }));
  await waitFor(() =>
    expect(saved().steps[0]).toMatchObject({
      kind: 'if',
      then: [{ kind: 'repeat', steps: [{ kind: 'wait', seconds: 60 }] }],
    }),
  );
  await userEvent.clear(screen.getByRole('spinbutton', { name: 'Maximum loop items per run' }));
  await userEvent.type(screen.getByRole('spinbutton', { name: 'Maximum loop items per run' }), '25');
  await waitFor(() => expect(saved().loopItemCap).toBe(25));
});

it('offers only graph ancestors in branch token fields', async () => {
  const fixture = await automationFixture({
    automations: ({ databaseId }) => [
      automationMeta(databaseId, 'Routing', {
        trigger: { kind: 'webhook' },
        steps: [
          { id: 'later001', kind: 'script', script: 'await output("later")' },
          { id: 'branch01', kind: 'switch', value: '', cases: [], otherwise: [] },
          { id: 'source01', kind: 'script', script: 'await output("source")' },
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
            target: { stepId: 'branch01', port: 'in' },
          },
          {
            id: 'wire0003',
            source: { stepId: 'branch01', port: 'otherwise' },
            target: { stepId: 'later001', port: 'in' },
          },
        ],
      }),
    ],
  });
  fixtures.push(fixture);
  vi.stubGlobal('fetch', bridgeFetch(fixture.server));
  renderScreen(fixture, fixture.session.getSchema().automations[0]!.id);
  await screen.findByRole('switch');
  await userEvent.click(
    screen.getByRole('button', { name: 'Insert a value', description: 'Value to match' }),
  );
  const menu = await screen.findByRole('menu', { name: 'Insert a value' });
  expect(within(menu).getByRole('group', { name: 'Output from step 3' })).toBeDefined();
  expect(within(menu).queryByRole('group', { name: 'Output from step 1' })).toBeNull();
});

it('adds switch paths and edits their values', async () => {
  const { saved } = await mount();
  await userEvent.click(screen.getByRole('button', { name: 'Add a step' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /^Switch$/ }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Path value' }), 'ready');
  await userEvent.click(screen.getByRole('button', { name: 'Add a path' }));
  await waitFor(() =>
    expect(saved().steps[0]).toMatchObject({ kind: 'switch', cases: [{ value: 'ready' }, { value: '2' }] }),
  );
  await dragItem(
    screen.getByRole('button', { name: 'Move ready' }),
    screen.getByRole('button', { name: 'Move 2' }),
  );
  await waitFor(() =>
    expect(saved().steps[0]).toMatchObject({ kind: 'switch', cases: [{ value: '2' }, { value: 'ready' }] }),
  );
});

it('preserves invalid switch paths and refuses to publish or test the earlier saved draft', async () => {
  const { saved, server, id } = await mount();
  await userEvent.click(screen.getByRole('button', { name: 'Add a step' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /^Switch$/ }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Path value' }), 'ready');
  await userEvent.click(screen.getByRole('button', { name: 'Add a path' }));
  await waitFor(() =>
    expect(saved().steps[0]).toMatchObject({ kind: 'switch', cases: [{ value: 'ready' }, { value: '2' }] }),
  );
  const second = screen.getAllByRole('textbox', { name: 'Path value' })[1]!;
  await userEvent.clear(second);
  await userEvent.type(second, 'ready');
  await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
  expect(
    screen.getAllByRole('textbox', { name: 'Path value' }).map((field) => (field as HTMLInputElement).value),
  ).toEqual(['ready', 'ready']);
  expect(screen.getByText('Draft: not live yet')).toBeDefined();
  await userEvent.click(screen.getByRole('button', { name: 'Test the whole automation' }));
  expect(
    await within(screen.getByRole('region', { name: 'Test run' })).findByText(
      'Use unique steps and paths, with no more than five nested levels or 100 steps.',
    ),
  ).toBeDefined();
  expect(server.requests.filter((request) => request.path === `/api/automations/${id}/test`)).toEqual([]);
  await userEvent.clear(second);
  await userEvent.type(second, 'fallback');
  await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
  await waitFor(() => expect(screen.queryByText('Draft: not live yet')).toBeNull());
  expect(saved().steps[0]).toMatchObject({
    kind: 'switch',
    cases: [{ value: 'ready' }, { value: 'fallback' }],
  });
});

it('keeps invalid edits when discarding is canceled and clears them after confirmation', async () => {
  const { saved } = await mount();
  await userEvent.click(screen.getByRole('button', { name: 'Add a step' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /^Switch$/ }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Path value' }), 'ready');
  await userEvent.click(screen.getByRole('button', { name: 'Add a path' }));
  await waitFor(() => expect(saved().steps).toHaveLength(1));
  const second = screen.getAllByRole('textbox', { name: 'Path value' })[1]!;
  await userEvent.clear(second);
  await userEvent.type(second, 'ready');
  await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
  const dialog = screen.getByRole('dialog', { name: 'Discard the draft?' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect((second as HTMLInputElement).value).toBe('ready');
  await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
  await userEvent.click(
    within(screen.getByRole('dialog', { name: 'Discard the draft?' })).getByRole('button', {
      name: 'Discard',
    }),
  );
  await waitFor(() => expect(saved().steps).toEqual([]));
  expect(screen.queryByRole('textbox', { name: 'Path value' })).toBeNull();
});

it('moves notes and zooms with the keyboard and opens a minimap deep link', async () => {
  const { saved } = await mount();
  await userEvent.click(screen.getByRole('button', { name: 'Add a sticky note' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Sticky note' }), 'Check the fallback');
  const handle = screen.getByRole('button', { name: 'Move note with arrow keys' });
  handle.focus();
  await userEvent.keyboard('{ArrowRight}{ArrowDown}');
  await waitFor(() => expect(saved().notes?.[0]).toMatchObject({ text: 'Check the fallback', x: 20, y: 20 }));
  const canvas = screen.getByRole('region', { name: 'Automation canvas' });
  canvas.focus();
  await userEvent.keyboard('+');
  expect(
    within(screen.getByRole('group', { name: 'Canvas controls' })).getByRole('status').textContent,
  ).toContain('110%');
  await userEvent.click(
    within(screen.getByRole('navigation', { name: 'Canvas minimap' })).getByRole('button', {
      name: 'Check the fallback',
    }),
  );
  expect(window.location.hash).toContain('step=');
  expect(document.activeElement?.getAttribute('data-note')).toBe(saved().notes?.[0]?.id);
});

it('shows nested configuration changes before publishing', async () => {
  await mount();
  await userEvent.click(screen.getByRole('button', { name: 'Add a step' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /^Wait$/ }));
  const summary = await screen.findByText('Changes from the published version');
  await userEvent.click(summary);
  expect(await screen.findByRole('heading', { name: 'Before' })).toBeDefined();
  expect(screen.getByRole('heading', { name: 'After' })).toBeDefined();
  expect(summary.closest('details')?.textContent).toContain('timeoutSeconds');
});
