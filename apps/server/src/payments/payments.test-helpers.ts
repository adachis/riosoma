import { createHmac, randomBytes } from 'node:crypto';
import { expect, vi } from 'vitest';
import { GridConfig, newId, type PaymentSettings, type PaymentState } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type { ServerFixture, SignedIn } from '../test/fixture.js';
import { readFixture } from '../data/snapshots.test-helpers.js';
import { issueTicket } from '../data/public-forms.js';
import type { PaymentRow } from './store.js';

/**
 * A stand-in for Stripe's API and webhooks.  Keys and secrets are made at runtime, sessions are
 * kept so webhooks can quote them, and `refuseSessions` makes Stripe refuse to open one.
 */
export interface StripeDouble {
  key: string;
  secret: string;
  sessions: Map<string, Record<string, unknown>>;
  calls: Array<{ path: string; body: URLSearchParams; idempotency: string | null }>;
  refuseSessions: boolean;
  /** Makes Stripe refuse refunds, as when it can't be reached */
  refuseRefunds: boolean;
  restore(): void;
}

export const fixed: PaymentSettings = {
  currency: 'usd',
  price: { kind: 'fixed', amount: '12.50' },
  quantityFieldId: null,
};

export function stubStripe(): StripeDouble {
  const original = globalThis.fetch;
  const double: StripeDouble = {
    key: ['sk', 'test', randomBytes(24).toString('hex')].join('_'),
    secret: ['whsec', randomBytes(24).toString('hex')].join('_'),
    sessions: new Map(),
    calls: [],
    refuseSessions: false,
    refuseRefunds: false,
    restore: () => vi.unstubAllGlobals(),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.hostname !== 'api.stripe.com') return original(input, init);
      const path = url.pathname;
      const headers = new Headers(init?.headers);
      const body = new URLSearchParams(String(init?.body ?? ''));
      double.calls.push({ path, body, idempotency: headers.get('Idempotency-Key') });
      if (headers.get('authorization') !== `Bearer ${double.key}`) return Response.json({}, { status: 401 });
      if (path === '/v1/balance') return Response.json({ object: 'balance', livemode: false });
      if (path === '/v1/checkout/sessions') {
        if (double.refuseSessions)
          return Response.json(
            { error: { message: 'The Checkout Session total amount must convert to at least 50 cents.' } },
            { status: 400 },
          );
        const id = `cs_${randomBytes(12).toString('hex')}`;
        const session = {
          id,
          object: 'checkout.session',
          mode: 'payment',
          livemode: false,
          client_reference_id: body.get('client_reference_id'),
          metadata: {
            record_id: body.get('metadata[record_id]'),
            connection_id: body.get('metadata[connection_id]'),
          },
          amount_total: Number(body.get('line_items[0][price_data][unit_amount]')),
          currency: body.get('line_items[0][price_data][currency]'),
          expires_at: Number(body.get('expires_at')),
          payment_intent: null,
          payment_status: 'unpaid',
          status: 'open',
          url: `https://checkout.stripe.com/c/pay/${id}`,
        };
        double.sessions.set(id, session);
        return Response.json(session);
      }
      const expire = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(path);
      if (expire) {
        // Stripe expires only an open session.
        const session = double.sessions.get(expire[1]!);
        if (!session || session.status !== 'open')
          return Response.json({ error: { message: 'Only open sessions can be expired.' } }, { status: 400 });
        const expired = { ...session, status: 'expired' };
        double.sessions.set(expire[1]!, expired);
        return Response.json(expired);
      }
      if (path.startsWith('/v1/checkout/sessions/'))
        return Response.json(double.sessions.get(path.split('/').at(-1)!) ?? {});
      if (path === '/v1/refunds' && double.refuseRefunds)
        return Response.json({ error: { message: 'Stripe is unavailable.' } }, { status: 503 });
      if (path === '/v1/refunds')
        return Response.json({ id: `re_${randomBytes(10).toString('hex')}`, status: 'succeeded' });
      return Response.json({}, { status: 400 });
    }),
  );
  return double;
}

export const eventId = () => `evt_${randomBytes(12).toString('hex')}`;

export function signed(body: string, secret: string, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Connects the stand-in account and answers the connection's ID, from its webhook address. */
export async function connect(server: ServerFixture, stripe: StripeDouble): Promise<string> {
  const response = await server.app.inject({
    method: 'PUT',
    url: '/api/admin/payments/stripe',
    headers: server.owner.headers,
    payload: { secretKey: stripe.key, webhookSecret: stripe.secret },
  });
  expect(response.statusCode, response.body).toBe(200);
  return new URL(response.json<{ webhookUrl: string }>().webhookUrl).pathname.split('/').at(-1)!;
}

export async function webhook(
  server: ServerFixture,
  stripe: StripeDouble,
  connectionId: string,
  type: string,
  object: Record<string, unknown>,
) {
  const body = JSON.stringify({ id: eventId(), type, livemode: false, data: { object } });
  return server.app.inject({
    method: 'POST',
    url: `/api/payments/webhooks/${connectionId}`,
    headers: { 'content-type': 'application/json', 'stripe-signature': signed(body, stripe.secret) },
    payload: body,
  });
}

/** The completion event Stripe sends once a payment's session is paid */
export function completed(stripe: StripeDouble, payment: PaymentRow) {
  return {
    ...stripe.sessions.get(payment.session_id!)!,
    status: 'complete',
    payment_status: 'paid',
    payment_intent: `pi_${randomBytes(12).toString('hex')}`,
  };
}

export async function latest(server: ServerFixture, tableId: string): Promise<PaymentRow | undefined> {
  return (
    await query<PaymentRow>(
      server.pool,
      sql`SELECT * FROM ${ident(server.schemas.app, 'payments')} WHERE table_id = ${tableId} ORDER BY created_at DESC LIMIT 1`,
    )
  ).rows[0];
}

export async function resultFieldsOf(server: ServerFixture, tableId: string, currency = 'usd') {
  return (
    await query<{
      status_field: string;
      amount_field: string;
      reference_field: string;
      choices: Record<PaymentState, string>;
    }>(
      server.pool,
      sql`SELECT * FROM ${ident(server.schemas.app, 'payment_fields')} WHERE table_id = ${tableId} AND currency = ${currency}`,
    )
  ).rows[0]!;
}

/** A record's stored cells, by column, which here is each field's ID */
export async function cells(server: ServerFixture, tableId: string, recordId: string) {
  return (
    await query<Record<string, unknown>>(
      server.pool,
      sql`SELECT * FROM ${ident(server.schemas.data, tableId)} WHERE __id = ${recordId}`,
    )
  ).rows[0]!;
}

/** The client every test command comes from, so undo can name its groups */
export const clientId = newId('client');

export async function command(
  server: ServerFixture,
  databaseId: string,
  input: Record<string, unknown>,
  who: SignedIn = server.owner,
  groupId = newId('action'),
) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: who.headers,
    payload: { clientId, commands: [{ id: newId('command'), groupId, ...input }] },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ results: Array<{ status: string; error?: { messageKey: string } }> }>().results[0]!;
}

/** A shared form with a text and a number question, taking payment when settings are given. */
export async function paidForm(
  server: ServerFixture,
  settings: PaymentSettings | null = fixed,
  who: SignedIn = server.owner,
  before?: (databaseId: string) => Promise<void>,
) {
  const fixture = await readFixture(server, [{ type: 'text' }, { type: 'number' }]);
  if (before) await before(fixture.table.databaseId);
  const viewId = fixture.view.id;
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'views')} SET type = 'form', config = ${JSON.stringify(GridConfig.parse({ form: { questions: fixture.fields.map((field) => ({ fieldId: field.id, required: true })) } }))}::jsonb WHERE id = ${viewId}`,
  );
  if (settings) {
    const configured = await server.app.inject({
      method: 'PUT',
      url: `/api/payment-pages/form/${viewId}`,
      headers: who.headers,
      payload: { settings },
    });
    expect(configured.statusCode, configured.body).toBe(200);
  }
  const shared = await server.app.inject({
    method: 'PUT',
    url: `/api/views/${viewId}/public-form`,
    headers: who.headers,
  });
  expect(shared.statusCode, shared.body).toBe(200);
  const formId = shared.json<{ formId: string }>().formId;
  const values = { [fixture.fields[0]!.id]: 'Visitor', [fixture.fields[1]!.id]: 2 };
  return { fixture, formId, values };
}

export function submit(server: ServerFixture, formId: string, values: Record<string, unknown>) {
  return server.app.inject({
    method: 'POST',
    url: `/api/public/forms/${formId}/submissions`,
    payload: { ticket: issueTicket(server.config.secretKey, formId, Date.now() - 3000), values },
  });
}

let addresses = 0;
/** A fresh network address each call, so the hourly limit per address never gets in the way */
export const nextAddress = () =>
  `10.${(addresses >> 16) & 255}.${(addresses >> 8) & 255}.${++addresses & 255}`;

/**
 * A booking page taking payment, open all day, one hour a time, with `places` each.  `book`
 * books from a new address unless one is given.
 */
export async function paidBookingPage(
  server: ServerFixture,
  options: {
    places?: number;
    hours?: Array<{ start: string; end: string }>;
    who?: SignedIn;
    before?: (databaseId: string) => Promise<void>;
  } = {},
) {
  const who = options.who ?? server.owner;
  const fixture = await readFixture(server, [
    { type: 'text' },
    { type: 'email' },
    { type: 'date', options: { includeTime: true } },
  ]);
  await options.before?.(fixture.table.databaseId);
  const [name, email, time] = fixture.fields;
  const page = await server.app.inject({
    method: 'POST',
    url: `/api/tables/${fixture.table.id}/booking-pages`,
    headers: who.headers,
    payload: {
      settings: {
        title: 'Class',
        timeFieldId: time!.id,
        nameFieldId: name!.id,
        emailFieldId: email!.id,
        lengthMinutes: 60,
        timeZone: 'UTC',
        dailyPerEmail: 20,
        places: options.places ?? 1,
        hours: Array.from({ length: 7 }, () => options.hours ?? [{ start: '00:00', end: '24:00' }]),
      },
    },
  });
  expect(page.statusCode, page.body).toBe(200);
  const pageId = page.json<{ pageId: string }>().pageId;
  const configured = await server.app.inject({
    method: 'PUT',
    url: `/api/payment-pages/booking/${pageId}`,
    headers: who.headers,
    payload: { settings: fixed },
  });
  expect(configured.statusCode, configured.body).toBe(200);
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  let visitors = 0;
  const book = (start: string, address = nextAddress(), values: Record<string, unknown> = {}) =>
    server.app.inject({
      method: 'POST',
      url: `/api/public/bookings/${pageId}/bookings`,
      remoteAddress: address,
      payload: {
        ticket: issueTicket(server.config.secretKey, pageId, Date.now() - 3000, 'bookingPage'),
        start,
        values: { [name!.id]: 'Visitor', [email!.id]: `visitor${++visitors}@example.test`, ...values },
        timeZone: 'UTC',
        locale: 'en-US',
      },
    });
  const status = async (start: string, address?: string) =>
    (await book(start, address)).json<{ status: string }>().status;
  return {
    fixture,
    pageId,
    book,
    status,
    day,
    at: (hour: string) => `${day}T${hour}:00:00.000Z`,
    time: time!,
  };
}
