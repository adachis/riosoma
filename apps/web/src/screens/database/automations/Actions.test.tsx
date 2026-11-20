import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
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
  window.history.replaceState(null, '', window.location.pathname);
});

it('saves all four new step editors as drafts with labeled controls', async () => {
  const fixture = await automationFixture({
    automations: ({ databaseId, tasks }) => [
      automationMeta(databaseId, 'Actions', { trigger: { kind: 'recordCreated', tableId: tasks.id } }),
    ],
  });
  fixtures.push(fixture);
  vi.stubGlobal('fetch', bridgeFetch(fixture.server));
  const id = fixture.session.getSchema().automations[0]!.id;
  renderScreen(fixture, id);
  await screen.findByRole('switch');
  const add = async (name: string) => {
    await userEvent.click(screen.getAllByRole('button', { name: 'Add a step' }).at(-1)!);
    await userEvent.click(await screen.findByRole('menuitem', { name }));
  };
  await add('Find records');
  expect(screen.getByRole('spinbutton', { name: 'Maximum records' })).toBeDefined();
  await add('Create a calendar event');
  await userEvent.type(screen.getByRole('textbox', { name: 'Event title' }), 'Review');
  await userEvent.click(screen.getByRole('button', { name: /Calendar account$/ }));
  await userEvent.click(screen.getByRole('option', { name: 'Microsoft 365 Calendar' }));
  await add('Generate a document');
  await userEvent.type(screen.getByRole('textbox', { name: 'Placeholder name' }), 'customer');
  await userEvent.keyboard('{Enter}');
  await userEvent.click(screen.getByRole('button', { name: 'Add placeholder' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'customer' }), 'Record value');
  await add('Ask AI');
  expect(screen.getByText(/classification is self-declared/i)).toBeDefined();
  expect(screen.getByText(/Review generated answers before using them in sending steps/)).toBeDefined();
  await userEvent.type(screen.getByRole('textbox', { name: 'Prompt' }), 'Summarize');
  await userEvent.click(screen.getByRole('button', { name: /Data classification$/ }));
  await userEvent.click(screen.getByRole('option', { name: 'Confidential' }));
  await waitFor(() =>
    expect(savedConfig(fixture, id).steps).toMatchObject([
      { kind: 'findRecords', limit: 20 },
      { kind: 'createCalendarEvent', provider: 'microsoft-calendar', title: 'Review' },
      { kind: 'generateDocument', values: { customer: 'Record value' } },
      { kind: 'askAi', prompt: 'Summarize', classification: 'confidential' },
    ]),
  );
  const card = screen.getByRole('region', { name: 'Generate a document' });
  await userEvent.click(within(card).getByRole('button', { name: 'Remove placeholder' }));
  await waitFor(() => expect(savedConfig(fixture, id).steps[2]).toMatchObject({ values: {} }));
  // Four editors take several seconds alone, and much longer on a busy machine.
}, 40_000);

it('offers a record created earlier inside the same branch to the document editor', async () => {
  const fixture = await automationFixture({
    automations: ({ databaseId, tasks }) => [
      automationMeta(databaseId, 'Nested actions', {
        trigger: { kind: 'recordCreated', tableId: tasks.id },
        steps: [
          {
            id: 'branch01',
            kind: 'if',
            conditions: null,
            then: [
              { id: 'create01', kind: 'createRecord', name: 'Nested record', tableId: tasks.id, values: {} },
              {
                id: 'document1',
                kind: 'generateDocument',
                tableId: tasks.id,
                record: 'trigger',
                templateFieldId: '',
                attachmentFieldId: '',
                format: 'docx',
              },
            ],
            otherwise: [],
          },
        ],
      }),
    ],
  });
  fixtures.push(fixture);
  vi.stubGlobal('fetch', bridgeFetch(fixture.server));
  const id = fixture.session.getSchema().automations[0]!.id;
  renderScreen(fixture, id);
  const document = await screen.findByRole('region', { name: 'Generate a document' });
  await userEvent.click(within(document).getByRole('button', { name: /Record$/ }));
  await userEvent.click(await screen.findByRole('option', { name: 'Nested record' }));
  await waitFor(() =>
    expect(savedConfig(fixture, id).steps[0]).toMatchObject({
      then: [{ kind: 'createRecord' }, { kind: 'generateDocument', record: 'create01' }],
    }),
  );
});
