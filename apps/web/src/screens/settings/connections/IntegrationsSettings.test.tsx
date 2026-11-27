import type { IntegrationUpdate, IntegrationView } from '@riosoma/contracts';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { toastQueue } from '@riosoma/ui';
import { connectionStore } from '../../../files/pickers/api';
import { json } from '../../database/share/testing';
import { renderSettings } from '../testing';
import { IntegrationsSettings } from './IntegrationsSettings';

vi.mock('../../../features/payments/StripeSettings', () => ({ StripeSettings: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const item of toastQueue.visibleToasts) toastQueue.close(item.key);
});

function integration(provider: IntegrationView['provider']): IntegrationView {
  return {
    provider,
    clientId: 'initial-client',
    tenantId: '',
    apiKey: null,
    hasSecret: true,
    enabled: false,
    configured: true,
    fromEnvironment: false,
    redirectUri: '',
  };
}

function heldSave(views: IntegrationView[]) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const updates: IntegrationUpdate[] = [];
  vi.spyOn(connectionStore, 'load').mockResolvedValue(undefined);
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method !== 'PUT') return json(views);
    const update = JSON.parse(String(init.body)) as IntegrationUpdate;
    updates.push(update);
    if (updates.length === 1) await held;
    const view = views.find((entry) => url.endsWith(`/${entry.provider}`))!;
    Object.assign(view, { clientId: update.clientId?.trim() ?? view.clientId });
    return json(view);
  });
  return { release, updates };
}

const save = () =>
  within(screen.getByRole('region', { name: 'Save changes' })).getByRole('button', { name: 'Save' });

it('keeps a reverted client ID while its provider waits behind another save', async () => {
  const pending = heldSave([integration('dropbox'), integration('box')]);
  renderSettings(<IntegrationsSettings />);
  const first = await screen.findByRole('region', { name: 'Dropbox' });
  const second = screen.getByRole('region', { name: 'Box' });
  const firstId = within(first).getByRole('textbox', { name: 'Client ID or app key' });
  const secondId = within(second).getByRole('textbox', { name: 'Client ID or app key' });
  fireEvent.change(firstId, { target: { value: 'first-change' } });
  fireEvent.change(secondId, { target: { value: 'second-change' } });
  await userEvent.setup().click(save());
  expect(pending.updates).toHaveLength(1);
  fireEvent.change(secondId, { target: { value: 'initial-client' } });
  await act(async () => pending.release());
  await waitFor(() => expect(pending.updates).toHaveLength(2));
  expect(secondId).toHaveProperty('value', 'initial-client');
  expect(screen.getByText('Unsaved changes')).toBeTruthy();
  await userEvent.setup().click(save());
  await waitFor(() => expect(pending.updates).toHaveLength(3));
  expect(pending.updates[2]?.clientId).toBe('initial-client');
  expect(screen.getByText('No unsaved changes')).toBeTruthy();
});

it.each([false, true])(
  'reconciles a saved secret and preserves newer edits with another secret: %s',
  async (newerSecret) => {
    const pending = heldSave([integration('dropbox')]);
    renderSettings(<IntegrationsSettings />);
    const panel = await screen.findByRole('region', { name: 'Dropbox' });
    const clientId = within(panel).getByRole('textbox', { name: 'Client ID or app key' });
    const secret = within(panel).getByLabelText('Client secret or app secret', { exact: true });
    const submitted = crypto.randomUUID();
    const newer = crypto.randomUUID();
    fireEvent.change(secret, { target: { value: submitted } });
    await userEvent.setup().click(save());
    fireEvent.change(clientId, { target: { value: 'new-client' } });
    if (newerSecret) fireEvent.change(secret, { target: { value: newer } });
    await act(async () => pending.release());
    await waitFor(() => expect(save()).toHaveProperty('disabled', false));
    expect(clientId).toHaveProperty('value', 'new-client');
    expect(secret).toHaveProperty('value', newerSecret ? newer : '');
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reload stored values' })).toBeNull();
    await userEvent.setup().click(save());
    await waitFor(() => expect(pending.updates).toHaveLength(2));
    expect(pending.updates[1]).toMatchObject({ clientId: 'new-client' });
    expect(pending.updates[1]?.clientSecret).toBe(newerSecret ? newer : undefined);
    expect(secret).toHaveProperty('value', '');
    expect(screen.getByText('No unsaved changes')).toBeTruthy();
  },
);

it('saves the calendar tenant while the untouched Teams panel still asks for its tenant', async () => {
  const calendar = integration('microsoft-calendar');
  // A provider nobody has set up is on by default, so Teams shows its missing tenant from the start.
  const teams = {
    ...integration('microsoft-teams'),
    clientId: '',
    hasSecret: false,
    enabled: true,
    configured: false,
  };
  const updates: { url: string; update: IntegrationUpdate }[] = [];
  vi.spyOn(connectionStore, 'load').mockResolvedValue(undefined);
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method !== 'PUT') return json([calendar, teams]);
    const update = JSON.parse(String(init.body)) as IntegrationUpdate;
    updates.push({ url, update });
    Object.assign(calendar, { tenantId: update.tenantId ?? calendar.tenantId });
    return json(calendar);
  });
  renderSettings(<IntegrationsSettings />);
  const calendarPanel = await screen.findByRole('region', { name: 'Microsoft 365 Calendar' });
  const teamsPanel = screen.getByRole('region', { name: 'Microsoft Teams notifications' });
  const teamsTenant = within(teamsPanel).getByRole('textbox', { name: 'Tenant ID' });
  expect(teamsTenant.getAttribute('aria-invalid')).toBe('true');
  fireEvent.change(within(calendarPanel).getByRole('textbox', { name: 'Tenant ID' }), {
    target: { value: 'organizations' },
  });
  await userEvent.setup().click(save());
  await waitFor(() => expect(screen.getByText('No unsaved changes')).toBeTruthy());
  expect(updates).toHaveLength(1);
  expect(updates[0]?.url).toMatch(/\/api\/admin\/integrations\/microsoft-calendar$/);
  expect(updates[0]?.update).toMatchObject({ tenantId: 'organizations' });
  expect(document.activeElement).not.toBe(teamsTenant);
});
