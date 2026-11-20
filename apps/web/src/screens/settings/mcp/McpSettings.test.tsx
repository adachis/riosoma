import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { McpAppActivity, McpRateSettings } from '@riosoma/contracts';
import { json, session } from '../../database/share/testing';
import { renderSettings } from '../testing';
import { McpSettings } from './McpSettings';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const clientId = 'a'.repeat(32);
function routes() {
  let stored: McpRateSettings = { callsPerMinute: 120, appOverrides: {} };
  const writes: McpRateSettings[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/admin/mcp/activity')
        return json([
          { clientId, appName: 'Calendar connector', callsLastMinute: 42, limitedLastDay: 7 },
        ] satisfies McpAppActivity[]);
      if (url === '/api/admin/mcp/settings') {
        if (init?.method === 'PUT') {
          stored = JSON.parse(String(init.body)) as McpRateSettings;
          writes.push(stored);
        }
        return json(stored);
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  return writes;
}

it('shows activity and saves the organization limit and app override together through the save bar', async () => {
  const writes = routes();
  const user = userEvent.setup();
  renderSettings(<McpSettings />);
  const app = await screen.findByRole('region', { name: 'Calendar connector' });
  expect(app.textContent).toMatch(/42 calls in the last minute.*7 limit hits/);
  const number = screen.getByRole('textbox', { name: 'Calls per minute' });
  await user.clear(number);
  await user.type(number, '60');
  await user.tab();
  await user.click(within(app).getByRole('radio', { name: 'Limit calls' }));
  const override = within(app).getByRole('textbox', { name: 'Calls per minute' });
  await user.clear(override);
  await user.type(override, '30');
  await user.tab();
  expect(writes).toEqual([]);
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(writes).toEqual([{ callsPerMinute: 60, appOverrides: { [clientId]: 30 } }]));
  expect(screen.getByText('No unsaved changes')).toBeTruthy();
  cleanup();
  renderSettings(<McpSettings />);
  await screen.findByRole('region', { name: 'Calendar connector' });
  expect((screen.getAllByRole('textbox', { name: 'Calls per minute' })[0] as HTMLInputElement).value).toBe(
    '60',
  );
  expect((screen.getAllByRole('textbox', { name: 'Calls per minute' })[1] as HTMLInputElement).value).toBe(
    '30',
  );
});

it('saves explicit No limit choices and removes an override when inheritance is selected', async () => {
  const writes = routes();
  const user = userEvent.setup();
  renderSettings(<McpSettings />);
  const app = await screen.findByRole('region', { name: 'Calendar connector' });
  await user.click(screen.getAllByRole('radio', { name: 'No limit' })[0]!);
  await user.click(within(app).getByRole('radio', { name: 'No limit' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(writes[0]).toEqual({ callsPerMinute: null, appOverrides: { [clientId]: null } }),
  );
  await user.click(within(app).getByRole('radio', { name: 'Use organization limit' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(writes[1]).toEqual({ callsPerMinute: null, appOverrides: {} }));
});

it('discards pending changes without a write and prevents invalid values from saving', async () => {
  const writes = routes();
  renderSettings(<McpSettings />);
  await screen.findByRole('region', { name: 'Calendar connector' });
  const number = screen.getByRole('textbox', { name: 'Calls per minute' });
  fireEvent.change(number, { target: { value: '55' } });
  fireEvent.blur(number);
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  expect((number as HTMLInputElement).value).toBe('120');
  expect(writes).toEqual([]);
  fireEvent.change(number, { target: { value: '' } });
  fireEvent.blur(number);
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('Enter a whole number from 1 to 1,000,000 calls per minute.')).toBeTruthy();
  expect(writes).toEqual([]);
});

it('does not load settings or activity for an ordinary member', async () => {
  routes();
  renderSettings(<McpSettings />, { ...session, membership: { kind: 'member', adminRoles: [] } });
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});
