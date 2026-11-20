import { z } from 'zod';
import { FieldId, ChoiceId } from './data/fields.js';

/**
 * The smallest charge in each currency, in minor units.  Stripe publishes a minimum per currency,
 * and a charge that Stripe converts also has to reach the settlement currency's minimum, which for
 * an account settling in US dollars means at least 50 US cents.  Each amount here is the higher of
 * the two, with about a quarter to spare for exchange rate movement at the rates of September 2026,
 * rounded up to a round price.  Stripe can still refuse a total at checkout, which fails the
 * payment cleanly.
 */
export const PAYMENT_CURRENCIES = {
  usd: 50,
  aed: 250,
  ars: 100000,
  aud: 100,
  brl: 400,
  cad: 100,
  chf: 60,
  cop: 250000,
  czk: 1500,
  dkk: 500,
  eur: 60,
  gbp: 50,
  hkd: 500,
  huf: 25000,
  idr: 1200000,
  ils: 200,
  inr: 8000,
  jpy: 100,
  krw: 1000,
  mxn: 1200,
  myr: 300,
  nok: 600,
  nzd: 120,
  php: 4000,
  pln: 250,
  ron: 300,
  rub: 6000,
  sek: 800,
  sgd: 80,
  thb: 2500,
  zar: 1200,
} as const;
export const PaymentCurrency = z.enum(
  Object.keys(PAYMENT_CURRENCIES) as [
    keyof typeof PAYMENT_CURRENCIES,
    ...Array<keyof typeof PAYMENT_CURRENCIES>,
  ],
);
export function paymentDecimals(currency: string): number {
  return currency === 'jpy' || currency === 'krw' ? 0 : 2;
}
const Price = z.string().regex(/^\d{1,8}(?:\.\d{1,2})?$/);
export const PaymentSettings = z.strictObject({
  currency: PaymentCurrency,
  price: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('fixed'), amount: Price }),
    z.strictObject({ kind: z.literal('option'), fieldId: FieldId, amounts: z.record(ChoiceId, Price) }),
  ]),
  quantityFieldId: FieldId.nullable().default(null),
});
export type PaymentSettings = z.infer<typeof PaymentSettings>;
export const PAYMENT_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.expired',
  'checkout.session.async_payment_failed',
  'charge.refunded',
] as const;
export const PAYMENT_STATES = ['pending', 'paid', 'expired', 'refunded', 'failed'] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];
export interface StripeConnection {
  connected: boolean;
  mode: 'test' | 'live' | null;
  webhookUrl: string;
  events: readonly string[];
}
export interface PaymentPage {
  settings: PaymentSettings | null;
}
export interface RecordPayment {
  state: PaymentState;
  amount: number;
  currency: string;
  refundable: boolean;
}
