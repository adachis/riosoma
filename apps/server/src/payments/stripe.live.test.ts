import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PAYMENT_CURRENCIES } from '@riosoma/contracts';
import { CHECKOUT_SECONDS, type ConnectionRow, type PaymentRow } from './store.js';
import { checkedSession, checkoutBody, expireSession } from './service.js';
import { stripeRequest } from './stripe.js';

/**
 * Runs against Stripe's real test mode only when a test-mode key is given, and sends exactly what
 * production sends: the body `checkoutBody` builds, through `stripeRequest`, read back and checked
 * by `checkedSession` as the webhook would.
 */
const key = process.env.RIOSOMA_TEST_STRIPE_SECRET_KEY;
const live = Boolean(key);

function payment(currency: string, amount: number): { payment: PaymentRow; connection: ConnectionRow } {
  const connection: ConnectionRow = {
    id: randomBytes(24).toString('hex'),
    org_id: 'org',
    secret_key: '',
    webhook_secret: '',
    live: false,
    enabled: true,
  };
  return {
    connection,
    payment: {
      record_id: `rec${randomBytes(7).toString('hex')}`,
      org_id: 'org',
      database_id: null,
      table_id: null,
      owner_id: null,
      connection_id: connection.id,
      target_id: 'target',
      kind: 'form',
      description: 'Riosoma test payment',
      amount,
      currency,
      state: 'pending',
      session_id: null,
      intent_id: null,
      checkout_url: null,
      expires_at: new Date((Math.ceil(Date.now() / 1000) + CHECKOUT_SECONDS) * 1000),
      address_key: null,
      booking_mail: null,
      mail_claimed: false,
    },
  };
}

async function roundTrip(currency: string, amount: number) {
  const { payment: row, connection } = payment(currency, amount);
  const created = await stripeRequest(
    key!,
    'checkout/sessions',
    checkoutBody(row, 'https://example.test'),
    `checkout:${row.record_id}`,
  );
  const session = checkedSession(created, row, connection);
  expect(session).toMatchObject({ status: 'open', payment_status: 'unpaid', amount_total: amount, currency });
  const paid = { ...row, session_id: session.id };
  try {
    expect(
      checkedSession(await stripeRequest(key!, `checkout/sessions/${session.id}`), paid, connection).id,
    ).toBe(session.id);
  } finally {
    const expired = checkedSession(await expireSession(key!, session.id), paid, connection);
    expect(expired).toMatchObject({ status: 'expired', payment_status: 'unpaid' });
    // Expiring it again is refused, and reading it back shows it expired, as a release relies on.
    await expect(expireSession(key!, session.id)).rejects.toThrow();
    expect(
      checkedSession(await stripeRequest(key!, `checkout/sessions/${session.id}`), paid, connection),
    ).toMatchObject({ status: 'expired' });
  }
}

describe.skipIf(!live)('Stripe test mode', () => {
  it('refuses to run with anything but a test-mode key', () => {
    // Only whether it matches is compared, so a failure never prints the key.
    expect(/^(?:sk|rk)_test_/.test(key ?? '')).toBe(true);
  });

  it('creates, reads, and expires a Checkout Session built as production builds it', async () => {
    if (!/^(?:sk|rk)_test_/.test(key!)) throw new Error('payments.testModeRequired');
    await roundTrip('usd', 1250);
  });

  it('accepts every currency at its minimum', async () => {
    if (!/^(?:sk|rk)_test_/.test(key!)) throw new Error('payments.testModeRequired');
    const refused: string[] = [];
    for (const [currency, minimum] of Object.entries(PAYMENT_CURRENCIES)) {
      try {
        await roundTrip(currency, minimum);
      } catch {
        refused.push(currency);
      }
    }
    expect(refused).toEqual([]);
  }, 180_000);
});
