import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { renderSharing, json, failure } from '../../screens/database/share/testing';
import { StripeSettings } from './StripeSettings';
import { PaymentConfirmScreen } from './PaymentConfirmScreen';
import { PaymentPageSettings } from './PaymentPageSettings';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('shows a rejected key and keeps the connection disconnected', async () => {
  const read = { connected: false, mode: null, webhookUrl: '', events: ['checkout.session.completed'] };
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'PUT' ? failure('payments.badKey', 422) : json(read),
  );
  vi.stubGlobal('fetch', fetcher);
  renderSharing(<StripeSettings />);
  const user = userEvent.setup();
  const key = ['sk', 'test', crypto.randomUUID().replaceAll('-', '')].join('_');
  const secret = ['whsec', crypto.randomUUID().replaceAll('-', '')].join('_');
  await user.type(screen.getByLabelText('Stripe secret key'), key);
  await user.type(screen.getByLabelText('Webhook signing secret'), secret);
  await user.click(screen.getByRole('button', { name: 'Verify and connect Stripe' }));
  await screen.findByText(/Stripe could not verify this key/);
  expect(screen.getByText('Stripe is not connected')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Disconnect Stripe' })).toBeNull();
});

it('clears entered secrets after connecting and identifies test mode', async () => {
  let connected = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') connected = true;
      return json({
        connected,
        mode: connected ? 'test' : null,
        webhookUrl: connected ? 'https://example.test/webhook' : '',
        events: [],
      });
    }),
  );
  renderSharing(<StripeSettings />);
  const user = userEvent.setup();
  await user.type(
    screen.getByLabelText('Stripe secret key'),
    ['rk', 'test', crypto.randomUUID().replaceAll('-', '')].join('_'),
  );
  await user.type(
    screen.getByLabelText('Webhook signing secret'),
    ['whsec', crypto.randomUUID().replaceAll('-', '')].join('_'),
  );
  await user.click(screen.getByRole('button', { name: 'Verify and connect Stripe' }));
  await screen.findByText('Test mode—no real money changes hands');
  await waitFor(() =>
    expect((screen.getByLabelText('Stripe secret key') as HTMLInputElement).value).toBe(''),
  );
  expect((screen.getByLabelText('Webhook signing secret') as HTMLInputElement).value).toBe('');
});

it('shows confirmation pending without calling a payment API', () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  renderSharing(<PaymentConfirmScreen />);
  expect(screen.getByRole('status').textContent).toBe('Thanks, we’re confirming your payment.');
  expect(fetcher).not.toHaveBeenCalled();
});

it('shows the currency’s minimum and explains a price below it', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? json(
            {
              error: {
                code: 'validation_failed',
                messageKey: 'payments.belowMinimum',
                params: { currency: 'USD', minimum: '0.50' },
                userFault: true,
              },
            },
            422,
          )
        : json({ settings: null }),
    ),
  );
  renderSharing(<PaymentPageSettings kind="form" targetId="viwAAAAAAAAAAAAAA" fields={[]} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Payment settings' }));
  await user.click(await screen.findByRole('checkbox', { name: 'Require payment' }));
  expect(screen.getByText(/at least 0\.50 USD/)).toBeTruthy();
  await user.type(screen.getByLabelText('Price amount'), '0.10');
  await user.click(screen.getByRole('button', { name: 'Save payment settings' }));
  await screen.findByText('Prices in USD have to be at least 0.50, the smallest amount Stripe charges.');
});
