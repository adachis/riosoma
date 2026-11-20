import { randomBytes } from 'node:crypto';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { json, renderSharing } from '../database/share/testing';
import { DatabaseStep } from './DatabaseStep';
import { useSetupFlow } from './useSetup';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function DatabaseForm() {
  return <DatabaseStep flow={useSetupFlow()} />;
}

it('shows a fresh connection check after a failed attempt to connect', async () => {
  const fetcher = vi.fn(async (url: string, _options?: RequestInit) => {
    if (url === '/api/setup/status') return json({ stage: 'database', databaseManaged: false });
    if (url === '/api/setup/database')
      return json({
        stage: 'database',
        databaseManaged: false,
        report: {
          ok: false,
          steps: [{ step: 'tcp', status: 'fail', messageKey: 'setup.diagnose.tcp.refused', elapsedMs: 1 }],
        },
      });
    return json({
      report: {
        ok: true,
        steps: [{ step: 'auth', status: 'ok', messageKey: 'setup.diagnose.auth.ok', elapsedMs: 1 }],
      },
    });
  });
  vi.stubGlobal('fetch', fetcher);
  renderSharing(<DatabaseForm />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Server address'), 'database');
  await user.type(screen.getByLabelText('User name'), 'owner');
  await user.type(screen.getByLabelText(/^Password/), randomBytes(24).toString('base64url'));
  await user.click(screen.getByRole('button', { name: 'Connect and continue' }));
  await screen.findByText('Nothing is accepting connections on that port.');
  const port = screen.getByRole('textbox', { name: 'Port' });
  await user.clear(port);
  await user.type(port, '5544');
  await user.tab();
  expect(screen.queryByText('Nothing is accepting connections on that port.')).not.toBeNull();
  await user.click(screen.getByRole('button', { name: 'Check connection' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/setup/database/test', expect.anything()));
  const checked = fetcher.mock.calls.find(([url]) => url === '/api/setup/database/test');
  expect(JSON.parse(String(checked?.[1]?.body)).port).toBe(5544);
  await screen.findByText('Signed in to the database.');
  expect(screen.queryByText('Nothing is accepting connections on that port.')).toBeNull();
});

it('clears a rejected connection field when the value is corrected', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/setup/status'
        ? json({ stage: 'database', databaseManaged: false })
        : json(
            {
              error: {
                code: 'validation_failed',
                messageKey: 'errors.validationFailed',
                userFault: true,
                fields: { host: 'validation.too_small' },
              },
            },
            422,
          ),
    ),
  );
  renderSharing(<DatabaseForm />);
  const user = userEvent.setup();
  const host = screen.getByLabelText('Server address');
  await user.type(host, ' ');
  await user.click(screen.getByRole('button', { name: 'Check connection' }));
  await screen.findByText('This is too short.');
  await user.clear(host);
  await user.type(host, 'database');
  expect(host.getAttribute('aria-invalid')).not.toBe('true');
});

it('explains a migration changed after it was applied and how to fix it', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/setup/status'
        ? json({ stage: 'database', databaseManaged: false })
        : json(
            {
              error: {
                code: 'unavailable',
                messageKey: 'server.startup.migrationChanged',
                userFault: false,
              },
            },
            503,
          ),
    ),
  );
  renderSharing(<DatabaseForm />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Server address'), 'database');
  await user.type(screen.getByLabelText('User name'), 'owner');
  await user.type(screen.getByLabelText(/^Password/), randomBytes(24).toString('base64url'));
  await user.click(screen.getByRole('button', { name: 'Connect and continue' }));
  await screen.findByText(
    /A migration changed after it was applied\.\s+Restore the shipped migration and add a new migration instead\./,
  );
});
