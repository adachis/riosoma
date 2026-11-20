import { automate, runRows } from '../automations/automations.test-helpers.js';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PAYMENT_CURRENCIES,
  newId,
  type PaymentSettings,
  type PublicForm,
  type PublicSubmitted,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { issueTicket } from '../data/public-forms.js';
import { readFixture } from '../data/snapshots.test-helpers.js';
import { amountFor, verifyEvent } from './stripe.js';
import { createCheckout } from './service.js';
import { minimumText } from './store.js';
import {
  command,
  cells,
  completed,
  connect,
  eventId,
  fixed,
  latest,
  paidBookingPage,
  paidForm,
  resultFieldsOf,
  signed,
  stubStripe,
  submit,
  type StripeDouble,
} from './payments.test-helpers.js';

const secret = ['whsec', randomBytes(24).toString('hex')].join('_');

describe('payment amounts and authentication', () => {
  it('calculates fixed prices, option prices, quantities, and zero-decimal currencies', () => {
    const fieldId = newId('field');
    const quantityFieldId = newId('field');
    const option = newId('choice');
    expect(amountFor(fixed, {})).toBe(1250);
    expect(amountFor({ ...fixed, quantityFieldId }, { [quantityFieldId]: 3 })).toBe(3750);
    expect(
      amountFor(
        { ...fixed, price: { kind: 'option', fieldId, amounts: { [option]: '3.25' } }, quantityFieldId },
        { [fieldId]: option, [quantityFieldId]: 4 },
      ),
    ).toBe(1300);
    expect(amountFor({ ...fixed, currency: 'jpy', price: { kind: 'fixed', amount: '500' } }, {})).toBe(500);
    expect(() => amountFor({ ...fixed, currency: 'jpy' }, {})).toThrow();
    expect(() => amountFor({ ...fixed, quantityFieldId }, { [quantityFieldId]: 1.5 })).toThrow();
    expect(() => amountFor({ ...fixed, price: { kind: 'fixed', amount: '0.49' } }, {})).toThrow();
    expect(() =>
      amountFor(
        { ...fixed, price: { kind: 'option', fieldId, amounts: { [option]: '3.25' } } },
        { [fieldId]: 'unknown' },
      ),
    ).toThrow();
  });
  it('keeps every minimum at or above the one Stripe publishes for its currency', () => {
    // Stripe's published minimum charges, in minor units, from its currency documentation
    const published: Record<string, number> = {
      usd: 50, aed: 200, ars: 50, aud: 50, brl: 50, cad: 50, chf: 50, cop: 50, czk: 1500, dkk: 250,
      eur: 50, gbp: 30, hkd: 400, huf: 17500, idr: 50, ils: 50, inr: 50, jpy: 50, krw: 50, mxn: 1000,
      myr: 200, nok: 300, nzd: 50, php: 50, pln: 200, ron: 200, rub: 50, sek: 300, sgd: 50, thb: 1000,
      zar: 50,
    }; // prettier-ignore
    expect(Object.keys(PAYMENT_CURRENCIES).sort()).toEqual(Object.keys(published).sort());
    for (const [currency, minimum] of Object.entries(PAYMENT_CURRENCIES))
      expect(minimum, currency).toBeGreaterThanOrEqual(published[currency]!);
    expect(minimumText('usd')).toBe('0.50');
    expect(minimumText('jpy')).toBe('100');
    expect(minimumText('huf')).toBe('250.00');
  });
  it('accepts authentic raw bytes and refuses wrong secrets, changed bytes, and stale timestamps', () => {
    const body = JSON.stringify({ id: eventId(), type: 'unknown', livemode: false, data: { object: {} } });
    expect(verifyEvent(Buffer.from(body), signed(body, secret), secret).type).toBe('unknown');
    expect(() =>
      verifyEvent(Buffer.from(body), signed(body, randomBytes(20).toString('hex')), secret),
    ).toThrow();
    expect(() => verifyEvent(Buffer.from(`${body} `), signed(body, secret), secret)).toThrow();
    expect(() =>
      verifyEvent(Buffer.from(body), signed(body, secret, Math.floor(Date.now() / 1000) - 301), secret),
    ).toThrow();
    expect(() =>
      verifyEvent(Buffer.from(body), signed(body, secret, Math.floor(Date.now() / 1000) + 301), secret),
    ).toThrow();
    expect(() => verifyEvent(Buffer.from(body), undefined, secret)).toThrow();
  });
});

let kit: TestPostgres;
let server: ServerFixture;
let stripe: StripeDouble;
let connectionId = '';
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'payments', {
    baseUrl: 'https://example.test',
    mailFrom: 'Bookings <bookings@example.test>',
  });
  stripe = stubStripe();
}, 60_000);
afterEach(() => {
  stripe.calls.length = 0;
});
afterAll(async () => {
  stripe?.restore();
  await server?.close();
  await kit?.stop();
});

async function form(settings = fixed) {
  connectionId = await connect(server, stripe);
  return paidForm(server, settings);
}
async function webhook(type: string, object: Record<string, unknown>, id = eventId(), header?: string) {
  const body = JSON.stringify({ id, type, livemode: false, data: { object } });
  return server.app.inject({
    method: 'POST',
    url: `/api/payments/webhooks/${connectionId}`,
    headers: {
      'content-type': 'application/json',
      'stripe-signature': header ?? signed(body, stripe.secret),
    },
    payload: body,
  });
}

describe('payments through public routes', () => {
  it('prices the checked defaulted quantity and option that the form stores', async () => {
    const f = await form();
    const databaseId = f.fixture.table.databaseId;
    const quantity = f.fixture.fields[1]!.id;
    const option = newId('field');
    const choice = newId('choice');
    for (const input of [
      { kind: 'field.update', fieldId: quantity, options: { defaultValue: { kind: 'value', value: 2 } } },
      {
        kind: 'field.create',
        tableId: f.fixture.table.id,
        field: {
          id: option,
          name: 'Price',
          type: 'singleSelect',
          options: {
            choices: [{ id: choice, name: 'Standard', color: 'blue' }],
            defaultValue: { kind: 'firstChoice' },
          },
        },
      },
      {
        kind: 'view.update',
        viewId: f.fixture.view.id,
        config: {
          form: {
            questions: [
              { fieldId: f.fixture.fields[0]!.id, required: true },
              { fieldId: quantity, required: false },
              { fieldId: option, required: false },
            ],
          },
        },
      },
    ])
      expect(await command(server, databaseId, input)).toMatchObject({ status: 'applied' });
    const configured = await server.app.inject({
      method: 'PUT',
      url: `/api/payment-pages/form/${f.fixture.view.id}`,
      headers: server.owner.headers,
      payload: {
        settings: {
          ...fixed,
          price: { kind: 'option', fieldId: option, amounts: { [choice]: '3.25' } },
          quantityFieldId: quantity,
        },
      },
    });
    expect(configured.statusCode, configured.body).toBe(200);
    for (const values of [
      { [f.fixture.fields[0]!.id]: 'Visitor' },
      { [f.fixture.fields[0]!.id]: 'Visitor', [quantity]: null, [option]: null },
      { [f.fixture.fields[0]!.id]: 'Visitor', [quantity]: 3, [option]: choice },
    ]) {
      const response = await submit(server, f.formId, values);
      expect(response.statusCode, response.body).toBe(200);
      const payment = (await latest(server, f.fixture.table.id))!;
      const row = await cells(server, f.fixture.table.id, payment.record_id);
      expect(row[option]).toBe(choice);
      expect(Number(row[quantity])).toBe(values[quantity] ?? 2);
      expect(payment.amount).toBe(325 * Number(row[quantity]));
      expect(
        stripe.calls
          .filter((entry) => entry.path === '/v1/checkout/sessions')
          .at(-1)!
          .body.get('line_items[0][price_data][unit_amount]'),
      ).toBe(String(payment.amount));
    }
    const before = (await latest(server, f.fixture.table.id))!.record_id;
    const invalid = await submit(server, f.formId, { ...f.values, [quantity]: 'invalid' });
    expect(invalid.statusCode).toBe(422);
    expect((await latest(server, f.fixture.table.id))!.record_id).toBe(before);
    const forged = await submit(server, f.formId, {
      ...f.values,
      [(await resultFieldsOf(server, f.fixture.table.id)).amount_field]: 1,
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json()).toMatchObject({ error: { messageKey: 'payments.protected' } });
    expect((await latest(server, f.fixture.table.id))!.record_id).toBe(before);
  });

  it('keeps the answers that set a price as they were charged through an edit link', async () => {
    const f = await form();
    const databaseId = f.fixture.table.databaseId;
    const [name, quantity] = f.fixture.fields.map((field) => field.id) as [string, string];
    const option = newId('field');
    const standing = newId('choice');
    const box = newId('choice');
    for (const input of [
      {
        kind: 'field.create',
        tableId: f.fixture.table.id,
        field: {
          id: option,
          name: 'Ticket',
          type: 'singleSelect',
          options: {
            choices: [
              { id: standing, name: 'Standing', color: 'blue' },
              { id: box, name: 'Box', color: 'red' },
            ],
          },
        },
      },
      {
        kind: 'view.update',
        viewId: f.fixture.view.id,
        config: {
          form: {
            allowEdits: true,
            questions: [name, quantity, option].map((fieldId) => ({ fieldId, required: true })),
          },
        },
      },
    ])
      expect(await command(server, databaseId, input)).toMatchObject({ status: 'applied' });
    const configure = (settings: PaymentSettings) =>
      server.app.inject({
        method: 'PUT',
        url: `/api/payment-pages/form/${f.fixture.view.id}`,
        headers: server.owner.headers,
        payload: { settings },
      });
    const byOption: PaymentSettings = {
      ...fixed,
      price: { kind: 'option', fieldId: option, amounts: { [standing]: '1.00', [box]: '90.00' } },
      quantityFieldId: quantity,
    };
    expect((await configure(byOption)).statusCode).toBe(200);
    const answers = { [name]: 'Visitor', [quantity]: 1, [option]: standing };
    const submitted = await submit(server, f.formId, answers);
    expect(submitted.statusCode, submitted.body).toBe(200);
    const { editLink, checkoutUrl } = submitted.json<PublicSubmitted>();
    expect(checkoutUrl).toMatch(/^https:\/\/checkout.stripe.com\//);
    const token = editLink!.path.split('#')[1]!;
    const payment = async () => (await latest(server, f.fixture.table.id))!;
    const recordId = (await payment()).record_id;
    expect((await payment()).amount).toBe(100);
    const remoteAddress = '198.51.100.21';
    const open = () =>
      server.app.inject({
        method: 'POST',
        url: `/api/public/forms/${f.formId}/edit-session`,
        payload: { token },
        remoteAddress,
      });
    const save = (session: string, values: Record<string, unknown>) =>
      server.app.inject({
        method: 'POST',
        url: `/api/public/forms/${f.formId}/edits`,
        payload: { session, values },
        remoteAddress,
      });
    const stored = async () => {
      const row = await cells(server, f.fixture.table.id, recordId);
      return [row[name], Number(row[quantity]), row[option]];
    };
    // The lock holds while the payment waits and after it is paid.
    for (const state of ['pending', 'paid'] as const) {
      if (state === 'paid')
        expect(
          (await webhook('checkout.session.completed', completed(stripe, await payment()))).statusCode,
        ).toBe(200);
      expect((await payment()).state).toBe(state);
      const opened = await open();
      expect(opened.statusCode, opened.body).toBe(200);
      const edit = opened.json<PublicForm>().edit!;
      expect([...(edit.locked ?? [])].sort()).toEqual([quantity, option].sort());
      for (const change of [{ [option]: box }, { [quantity]: 10_000 }, { [option]: box, [quantity]: 500 }]) {
        const refused = await save(edit.session, { ...answers, ...change });
        expect(refused.statusCode, refused.body).toBe(403);
        expect(refused.json()).toMatchObject({ error: { messageKey: 'payments.answersLocked' } });
      }
      expect(await stored()).toEqual(['Visitor', 1, standing]);
    }
    // Every other answer still changes, with the priced ones sent back as they are.
    const session = (await open()).json<PublicForm>().edit!.session;
    const renamed = await save(session, { ...answers, [name]: 'Renamed' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(await stored()).toEqual(['Renamed', 1, standing]);
    expect(await payment()).toMatchObject({ state: 'paid', amount: 100 });
    // A new price or amount leaves the same questions locked, and the links working.
    expect(
      (
        await configure({
          ...byOption,
          price: { kind: 'option', fieldId: option, amounts: { [standing]: '2.00', [box]: '95.00' } },
        })
      ).statusCode,
    ).toBe(200);
    expect((await open()).statusCode).toBe(200);
    // Once the page stops naming a question that priced earlier responses, their links end.
    expect((await configure(fixed)).statusCode).toBe(200);
    expect((await open()).json()).toMatchObject({ error: { messageKey: 'forms.edit.revoked' } });
    expect((await save(session, { ...answers, [option]: box, [quantity]: 500 })).json()).toMatchObject({
      error: { messageKey: 'forms.edit.revoked' },
    });
    expect(await stored()).toEqual(['Renamed', 1, standing]);
    const revoked = await query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.audit, 'events')}
        WHERE action = 'data.form.editsRevoked' AND metadata ->> 'viewId' = ${f.fixture.view.id}`,
    );
    expect(revoked.rowCount).toBe(1);
  });

  it('refuses a payment page on a joined table, whose rows its inputs decide', async () => {
    connectionId = await connect(server, stripe);
    const fixture = await readFixture(server, [{ type: 'text' }]);
    const databaseId = fixture.table.databaseId;
    const side = newId('table');
    const sideKey = newId('field');
    expect(
      (
        await command(server, databaseId, {
          kind: 'table.create',
          table: {
            id: side,
            name: 'Side',
            fields: [{ id: sideKey, name: 'Key', type: 'text' }],
            view: { id: newId('view'), name: 'Grid' },
            records: [],
          },
        })
      ).status,
    ).toBe('applied');
    const joined = newId('table');
    const key = newId('field');
    const viewId = newId('view');
    expect(
      (
        await command(server, databaseId, {
          kind: 'table.create',
          table: {
            id: joined,
            name: 'Joined',
            fields: [{ id: key, name: 'Key', type: 'text' }],
            view: { id: newId('view'), name: 'Grid' },
            joined: {
              baseTableId: fixture.table.id,
              steps: [
                {
                  tableId: side,
                  leftTableId: fixture.table.id,
                  leftFieldId: fixture.fields[0]!.id,
                  rightFieldId: sideKey,
                  kind: 'left',
                },
              ],
              fields: [{ tableId: fixture.table.id, fieldId: fixture.fields[0]!.id, outputFieldId: key }],
            },
          },
        })
      ).status,
    ).toBe('applied');
    expect(
      (
        await command(server, databaseId, {
          kind: 'view.create',
          view: {
            id: viewId,
            name: 'Signups',
            tableId: joined,
            type: 'form',
            config: { form: { questions: [{ fieldId: key, required: true }] } },
          },
        })
      ).status,
    ).toBe('applied');
    const response = await server.app.inject({
      method: 'PUT',
      url: `/api/payment-pages/form/${viewId}`,
      headers: server.owner.headers,
      payload: { settings: fixed },
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json().error).toMatchObject({ messageKey: 'payments.invalid' });
  });

  it('refuses bad keys without saving them and never returns saved secrets', async () => {
    const response = await server.app.inject({
      method: 'PUT',
      url: '/api/admin/payments/stripe',
      headers: server.owner.headers,
      payload: {
        secretKey: ['rk', 'test', randomBytes(12).toString('hex')].join('_'),
        webhookSecret: stripe.secret,
      },
    });
    expect(response.statusCode).toBe(422);
    connectionId = await connect(server, stripe);
    const read = await server.app.inject({
      url: '/api/admin/payments/stripe',
      headers: server.owner.headers,
    });
    expect(read.json()).toMatchObject({ connected: true, mode: 'test' });
    expect(read.body).not.toContain(stripe.key);
    expect(read.body).not.toContain(stripe.secret);
    const sealed = (
      await query<{ secret_key: string; webhook_secret: string }>(
        server.pool,
        sql`SELECT secret_key, webhook_secret FROM ${ident(server.schemas.app, 'stripe_connections')} WHERE id = ${connectionId}`,
      )
    ).rows[0]!;
    expect(sealed.secret_key).not.toContain(stripe.key);
    expect(sealed.webhook_secret).not.toContain(stripe.secret);
  });
  it('refuses browser amounts and records Pending before creating an idempotent session', async () => {
    const f = await form();
    const tampered = await server.app.inject({
      method: 'POST',
      url: `/api/public/forms/${f.formId}/submissions`,
      payload: {
        ticket: issueTicket(server.config.secretKey, f.formId, Date.now() - 3000),
        values: f.values,
        amount: 1,
      },
    });
    expect(tampered.statusCode).toBe(422);
    const response = await submit(server, f.formId, f.values);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<PublicSubmitted>().checkoutUrl).toMatch(/^https:\/\/checkout.stripe.com\//);
    const payment = (await latest(server, f.fixture.table.id))!;
    expect(payment.state).toBe('pending');
    expect(payment.amount).toBe(1250);
    const call = stripe.calls.find((entry) => entry.path === '/v1/checkout/sessions')!;
    expect(call.idempotency).toBe(`checkout:${payment.record_id}`);
    expect(call.body.get('line_items[0][price_data][unit_amount]')).toBe('1250');
    expect(await createCheckout(server.ctx, payment.record_id)).toBe(payment.checkout_url);
    expect(stripe.calls.filter((entry) => entry.path === '/v1/checkout/sessions')).toHaveLength(1);
    await server.app.inject({ url: '/payments/confirm' });
    expect((await latest(server, f.fixture.table.id))!.state).toBe('pending');
  });
  it('refuses mismatched amounts and records, then applies a paid event only once', async () => {
    const f = await form();
    const created = await automate(server, f.fixture.table.databaseId, {
      trigger: { kind: 'recordCreated', tableId: f.fixture.table.id },
    });
    const updated = await automate(server, f.fixture.table.databaseId, {
      trigger: { kind: 'recordUpdated', tableId: f.fixture.table.id, fieldIds: [] },
    });
    expect((await submit(server, f.formId, f.values)).statusCode).toBe(200);
    const payment = (await latest(server, f.fixture.table.id))!;
    const object = completed(stripe, payment);
    expect((await webhook('checkout.session.completed', { ...object, amount_total: 1 })).statusCode).toBe(
      422,
    );
    expect(
      (await webhook('checkout.session.completed', { ...object, client_reference_id: newId('record') }))
        .statusCode,
    ).toBe(422);
    expect((await webhook('checkout.session.completed', object, eventId(), 'invalid')).statusCode).toBe(422);
    expect((await latest(server, f.fixture.table.id))!.state).toBe('pending');
    const id = eventId();
    expect((await webhook('checkout.session.completed', object, id)).statusCode).toBe(200);
    expect((await webhook('checkout.session.completed', object, id)).statusCode).toBe(200);
    expect((await latest(server, f.fixture.table.id))!.state).toBe('paid');
    const confirmed = await query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'payments.confirmed' AND metadata ->> 'recordId' = ${payment.record_id}`,
    );
    expect(confirmed.rowCount).toBe(1);
    expect(await runRows(server, created)).toHaveLength(1);
    expect(await runRows(server, updated)).toHaveLength(1);
    // A form's response belongs to no one, paid or not.
    expect((await latest(server, f.fixture.table.id))!.owner_id).toBeNull();
    expect((await webhook('unrelated.event', {})).statusCode).toBe(200);
  });
  it.each(['expired', 'failed'] as const)('changes Pending to %s from a verified event', async (state) => {
    const f = await form();
    await submit(server, f.formId, f.values);
    const payment = (await latest(server, f.fixture.table.id))!;
    const object = {
      ...stripe.sessions.get(payment.session_id!)!,
      status: state === 'expired' ? 'expired' : 'complete',
    };
    const response = await webhook(
      state === 'expired' ? 'checkout.session.expired' : 'checkout.session.async_payment_failed',
      object,
    );
    expect(response.statusCode, response.body).toBe(200);
    expect((await latest(server, f.fixture.table.id))!.state).toBe(state);
  });
  it('requests a full refund without changing status until its webhook arrives', async () => {
    const f = await form();
    await submit(server, f.formId, f.values);
    const payment = (await latest(server, f.fixture.table.id))!;
    const object = completed(stripe, payment);
    expect((await webhook('checkout.session.async_payment_succeeded', object)).statusCode).toBe(200);
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/tables/${payment.table_id}/records/${payment.record_id}/payment`,
      headers: server.owner.headers,
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(200);
    expect((await latest(server, f.fixture.table.id))!.state).toBe('paid');
    const call = stripe.calls.find((entry) => entry.path === '/v1/refunds')!;
    expect(call.body.get('payment_intent')).toBe(object.payment_intent);
    expect(call.idempotency).toBe(`refund:${payment.record_id}`);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.data, payment.table_id!)} SET __deleted_at = clock_timestamp() WHERE __id = ${payment.record_id}`,
    );
    expect(
      (
        await webhook('charge.refunded', {
          object: 'charge',
          livemode: false,
          paid: true,
          refunded: true,
          amount: 1250,
          amount_refunded: 1250,
          currency: 'usd',
          payment_intent: object.payment_intent,
        })
      ).statusCode,
    ).toBe(200);
    expect((await latest(server, f.fixture.table.id))!.state).toBe('refunded');
    await webhook('checkout.session.completed', object);
    expect((await latest(server, f.fixture.table.id))!.state).toBe('refunded');
  });
  it('refuses a price below the currency minimum when the page is saved', async () => {
    const f = await form();
    const quantityFieldId = f.fixture.fields[1]!.id;
    const save = (settings: Record<string, unknown>) =>
      server.app.inject({
        method: 'PUT',
        url: `/api/payment-pages/form/${f.fixture.view.id}`,
        headers: server.owner.headers,
        payload: { settings: { ...fixed, ...settings } },
      });
    // A quantity of one is always possible, so the price alone has to reach the minimum.
    const low = await save({ price: { kind: 'fixed', amount: '0.10' }, quantityFieldId });
    expect(low.statusCode).toBe(422);
    expect(low.json()).toMatchObject({
      error: { messageKey: 'payments.belowMinimum', params: { currency: 'USD', minimum: '0.50' } },
    });
    expect((await save({ currency: 'gbp', price: { kind: 'fixed', amount: '0.30' } })).statusCode).toBe(422);
    expect((await save({ currency: 'jpy', price: { kind: 'fixed', amount: '99' } })).statusCode).toBe(422);
    expect((await save({ currency: 'jpy', price: { kind: 'fixed', amount: '100' } })).statusCode).toBe(200);
    expect((await save({ price: { kind: 'fixed', amount: '0.50' }, quantityFieldId })).statusCode).toBe(200);
    expect((await submit(server, f.formId, { ...f.values, [quantityFieldId]: 3 })).statusCode).toBe(200);
    expect((await latest(server, f.fixture.table.id))!.amount).toBe(150);
  });

  it('requires both the Integrations role and table edit access for refunds', async () => {
    const f = await form();
    await submit(server, f.formId, f.values);
    const payment = (await latest(server, f.fixture.table.id))!;
    await webhook('checkout.session.completed', completed(stripe, payment));
    const member = await server.addMember();
    const path = `/api/tables/${payment.table_id}/records/${payment.record_id}/payment`;
    expect(
      (await server.app.inject({ method: 'POST', url: path, headers: member.headers, payload: {} }))
        .statusCode,
    ).toBe(403);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET admin_roles = ARRAY['integrations'] WHERE user_id = ${member.userId}`,
    );
    expect(
      (await server.app.inject({ method: 'POST', url: path, headers: member.headers, payload: {} }))
        .statusCode,
    ).toBe(404);
    expect(stripe.calls.filter((entry) => entry.path === '/v1/refunds')).toHaveLength(0);
  });

  it('protects payment values and field definitions from owners', async () => {
    const f = await form();
    await submit(server, f.formId, f.values);
    const payment = (await latest(server, f.fixture.table.id))!;
    const field = (await resultFieldsOf(server, payment.table_id!)).status_field;
    for (const input of [
      {
        kind: 'record.update',
        tableId: payment.table_id,
        records: [{ id: payment.record_id, values: { [field]: null } }],
      },
      { kind: 'field.update', fieldId: field, name: 'Changed' },
      { kind: 'field.trash', fieldId: field },
      { kind: 'field.convert', fieldId: field, type: 'text' },
    ]) {
      const result = await command(server, payment.database_id!, input);
      expect(result.status, JSON.stringify(input)).toBe('rejected');
    }
  });

  it('holds the last booking slot, releases it on expiry, and confirms a paid booking once', async () => {
    connectionId = await connect(server, stripe);
    const page = await paidBookingPage(server);
    const start = page.at('12');
    const send = vi.fn();
    server.ctx.mailer = { send };
    const race = await Promise.all([page.book(start), page.book(start)]);
    race.forEach((response) => expect(response.statusCode, response.body).toBe(200));
    expect(race.map((response) => response.json<{ status: string }>().status).sort()).toEqual([
      'booked',
      'taken',
    ]);
    expect(send).not.toHaveBeenCalled();
    const payment = (await latest(server, page.fixture.table.id))!;
    expect(await page.status(start)).toBe('taken');
    const remove = await server.app.inject({
      method: 'DELETE',
      url: `/api/booking-pages/${page.pageId}`,
      headers: server.owner.headers,
    });
    expect(remove.statusCode, remove.body).toBe(409);
    expect(
      (
        await webhook('checkout.session.expired', {
          ...stripe.sessions.get(payment.session_id!)!,
          status: 'expired',
        })
      ).statusCode,
    ).toBe(200);
    expect(await page.status(start)).toBe('booked');
    const paid = (await latest(server, page.fixture.table.id))!;
    const object = completed(stripe, paid);
    expect((await webhook('checkout.session.completed', object)).statusCode).toBe(200);
    expect((await webhook('checkout.session.async_payment_succeeded', object)).statusCode).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(Buffer.isBuffer(send.mock.calls[0]![0].attachments[0].content)).toBe(true);
    server.ctx.mailer = null;
  });
});
