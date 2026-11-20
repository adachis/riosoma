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
});

it('saves notification recipients, templates, and optional links with labeled controls', async () => {
  const fixture = await automationFixture({
    automations: ({ databaseId, tasks }) => [
      automationMeta(databaseId, 'Notifications', { trigger: { kind: 'recordCreated', tableId: tasks.id } }),
    ],
  });
  fixtures.push(fixture);
  const id = fixture.session.getSchema().automations[0]!.id;
  vi.stubGlobal('fetch', bridgeFetch(fixture.server));
  renderScreen(fixture, id);
  await screen.findByRole('switch');
  await userEvent.click(screen.getAllByRole('button', { name: 'Add a step' }).at(-1)!);
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Send a notification' }));
  const card = screen.getByRole('region', { name: 'Send a notification' });
  await userEvent.type(within(card).getByRole('textbox', { name: 'Notification title' }), 'Review needed');
  await userEvent.type(within(card).getByRole('textbox', { name: 'Message' }), 'Please review');
  await userEvent.click(within(card).getByRole('button', { name: /Who receives it/ }));
  await userEvent.click(screen.getByRole('option', { name: 'The record’s creator' }));
  await userEvent.click(within(card).getByRole('button', { name: /Notification link/ }));
  await userEvent.click(screen.getByRole('option', { name: 'No link' }));
  await waitFor(() =>
    expect(savedConfig(fixture, id).steps[0]).toMatchObject({
      kind: 'sendNotification',
      recipients: { kind: 'recordCreator' },
      title: 'Review needed',
      body: 'Please review',
      link: { kind: 'none' },
    }),
  );
  await userEvent.click(within(card).getByRole('button', { name: /Notification link/ }));
  await userEvent.click(screen.getByRole('option', { name: 'A custom link' }));
  await userEvent.type(within(card).getByRole('textbox', { name: 'Address' }), '/settings/notifications');
  await userEvent.tab();
  await waitFor(() =>
    expect(savedConfig(fixture, id).steps[0]).toMatchObject({
      link: { kind: 'custom', url: '/settings/notifications' },
    }),
  );
  expect(within(card).getByText(/Each person’s notification preferences apply/)).toBeDefined();
}, 30_000);
