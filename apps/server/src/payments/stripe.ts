import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError, PAYMENT_CURRENCIES, paymentDecimals, type PaymentSettings } from '@riosoma/contracts';

export const refused = () => new AppError('validation_failed', 'payments.invalid');
export const unavailable = () => new AppError('unavailable', 'payments.unavailable');

export function minorUnits(amount: string, currency: string): number {
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(amount)) throw refused();
  const decimals = paymentDecimals(currency);
  const [whole = '', fraction = ''] = amount.split('.');
  if (fraction.length > decimals) throw refused();
  const units = Number(whole) * 10 ** decimals + Number(fraction.padEnd(decimals, '0'));
  if (!Number.isSafeInteger(units) || units < 1 || units > 99_999_999) throw refused();
  return units;
}

export function amountFor(settings: PaymentSettings, values: Record<string, unknown>): number {
  let price: string | undefined;
  if (settings.price.kind === 'fixed') price = settings.price.amount;
  else {
    const option = values[settings.price.fieldId];
    if (typeof option !== 'string' || !Object.hasOwn(settings.price.amounts, option)) throw refused();
    price = settings.price.amounts[option];
  }
  if (!price) throw refused();
  const quantity = settings.quantityFieldId ? values[settings.quantityFieldId] : 1;
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10_000)
    throw refused();
  const amount = minorUnits(price, settings.currency) * quantity;
  if (!Number.isSafeInteger(amount) || amount < PAYMENT_CURRENCIES[settings.currency] || amount > 99_999_999)
    throw refused();
  return amount;
}

export const StripeEvent = z.object({
  id: z.string().regex(/^evt_[A-Za-z0-9]+$/),
  type: z.string(),
  livemode: z.boolean(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});

/** Authentication covers the exact bytes before any JSON parsing */
export function verifyEvent(body: Buffer, signature: unknown, secret: string, now = Date.now()) {
  if (typeof signature !== 'string' || signature.length > 4096) throw refused();
  const parts = signature.split(',').map((part) => part.trim().split('='));
  const timestamps = parts.filter(([key]) => key === 't');
  const timestamp = timestamps[0]?.[1];
  if (
    timestamps.length !== 1 ||
    !timestamp ||
    !/^\d{1,12}$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300
  )
    throw refused();
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest();
  const valid = parts.some(
    ([key, value]) =>
      key === 'v1' &&
      value &&
      /^[a-f0-9]{64}$/.test(value) &&
      timingSafeEqual(expected, Buffer.from(value, 'hex')),
  );
  if (!valid) throw refused();
  try {
    return StripeEvent.parse(JSON.parse(body.toString('utf8')));
  } catch {
    throw refused();
  }
}

/** Provider errors can contain sensitive values, so only a local message leaves this boundary */
export async function stripeRequest(
  key: string,
  path: string,
  body?: URLSearchParams,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${key}`,
        'Stripe-Version': '2025-02-24.acacia',
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw unavailable();
    return z.record(z.string(), z.unknown()).parse(await response.json());
  } catch {
    throw unavailable();
  }
}

export function keyMode(key: string): boolean {
  const match = /^(?:sk|rk)_(test|live)_[A-Za-z0-9]+$/.exec(key);
  if (!match) throw new AppError('validation_failed', 'payments.badKey');
  return match[1] === 'live';
}

export async function checkKey(key: string): Promise<boolean> {
  const live = keyMode(key);
  try {
    const balance = await stripeRequest(key, 'balance');
    if (balance.object !== 'balance' || balance.livemode !== live) throw refused();
  } catch {
    throw new AppError('validation_failed', 'payments.badKey');
  }
  return live;
}
