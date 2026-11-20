import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOOKING_LIMITS } from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { removeAccount } from '../auth/scim/store.js';
import { purgeTrash } from '../data/purge.js';
import { flushRefusals } from './service.js';
import { addressKey, cancelToken } from '../bookings/public.js';
import type { MailMessage } from '../mail/types.js';
import {
  cells,
  command,
  completed,
  connect,
  latest,
  nextAddress,
  paidBookingPage,
  paidForm,
  resultFieldsOf,
  stubStripe,
  submit,
  webhook,
  type StripeDouble,
} from './payments.test-helpers.js';

/**
 * Pending holds end on their own, paid bookings follow their records, refused webhooks can't flood
 * the audit log, and payments never stand in the way of purging the trash or removing a person.
 */

let kit: TestPostgres;
let server: ServerFixture;
let stripe: StripeDouble;
let connectionId: string;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'paymentholds', {
    baseUrl: 'https://example.test',
    mailFrom: 'Bookings <bookings@example.test>',
  });
  stripe = stubStripe();
  connectionId = await connect(server, stripe);
  server.ctx.mailer = {
    send: async (message) => {
      mails.push(message);
    },
  };
}, 60_000);
afterAll(async () => {
  stripe?.restore();
  await server?.close();
  await kit?.stop();
});

async function grant(databaseId: string, who: SignedIn, role: string) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')} (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${who.userId}, ${role})
    ON CONFLICT (resource_kind, resource_id, principal_kind, principal_id) DO UPDATE SET role = EXCLUDED.role`,
  );
}
const mails: MailMessage[] = [];
const paymentOf = async (recordId: string) =>
  (
    await query<{ state: string }>(
      server.pool,
      sql`SELECT state FROM ${ident(server.schemas.app, 'payments')} WHERE record_id = ${recordId}`,
    )
  ).rows[0]!;
const audits = async (action: string, recordId: string) =>
  Number(
    (
      await query<{ count: string }>(
        server.pool,
        sql`SELECT count(*) AS count FROM ${ident(server.schemas.audit, 'events')}
          WHERE action = ${action} AND metadata ->> 'recordId' = ${recordId}`,
      )
    ).rows[0]!.count,
  );
async function trash(databaseId: string, tableId: string, recordId: string) {
  const result = await command(server, databaseId, { kind: 'record.trash', tableId, recordIds: [recordId] });
  expect(result.status).toBe('applied');
}
/** Moves a pending payment's session expiry, here and at the stand-in Stripe, and answers the new one */
async function moveExpiry(recordId: string, seconds: number): Promise<number> {
  const payment = (await latest(server, await tableOf(recordId)))!;
  const at = Math.floor(Date.now() / 1000) + seconds;
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'payments')} SET expires_at = to_timestamp(${at}) WHERE record_id = ${recordId}`,
  );
  const session = stripe.sessions.get(payment.session_id!)!;
  stripe.sessions.set(payment.session_id!, { ...session, expires_at: at });
  return at;
}
async function tableOf(recordId: string): Promise<string> {
  return (
    await query<{ table_id: string }>(
      server.pool,
      sql`SELECT table_id FROM ${ident(server.schemas.app, 'payments')} WHERE record_id = ${recordId}`,
    )
  ).rows[0]!.table_id;
}
/** Live records at a time on a page, which has one place */
async function liveAt(page: Awaited<ReturnType<typeof paidBookingPage>>, hour = '12') {
  const rows = await query<{ n: string }>(
    server.pool,
    sql`SELECT count(*) AS n FROM ${ident(server.schemas.data, page.fixture.table.id)}
      WHERE __deleted_at IS NULL AND ${ident(page.time.id)} = ${page.at(hour)}::timestamptz`,
  );
  return Number(rows.rows[0]!.n);
}
async function expectRefunded(
  page: Awaited<ReturnType<typeof paidBookingPage>>,
  recordId: string,
  intent: string,
  reason: 'trashed' | 'full',
) {
  expect((await paymentOf(recordId)).state).toBe('refunded');
  const refunds = stripe.calls.filter(
    (call) => call.path === '/v1/refunds' && call.body.get('payment_intent') === intent,
  );
  expect(refunds.length).toBeGreaterThan(0);
  expect(refunds.every((call) => call.idempotency === `refund:${recordId}`)).toBe(true);
  const usd = await resultFieldsOf(server, page.fixture.table.id);
  expect((await cells(server, page.fixture.table.id, recordId))[usd.status_field]).toBe(usd.choices.refunded);
  const audit = await query<{ metadata: { reason: string } }>(
    server.pool,
    sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE action = 'payments.refundedAfterRelease' AND metadata ->> 'recordId' = ${recordId}`,
  );
  expect(audit.rows.map((row) => row.metadata.reason)).toEqual([reason]);
  expect(await audits('payments.confirmed', recordId)).toBe(0);
}

const pendingHolds = async (pageId: string) =>
  Number(
    (
      await query<{ count: string }>(
        server.pool,
        sql`SELECT count(*) AS count FROM ${ident(server.schemas.app, 'payments')} WHERE target_id = ${pageId} AND state = 'pending'`,
      )
    ).rows[0]!.count,
  );

describe('pending holds', () => {
  it('fail at once when Stripe won’t open Checkout, freeing the time for the same visitor', async () => {
    const page = await paidBookingPage(server);
    const address = nextAddress();
    stripe.refuseSessions = true;
    const refused = await page.book(page.at('12'), address);
    stripe.refuseSessions = false;
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ error: { messageKey: 'payments.checkoutFailed.booking' } });
    const failed = (await latest(server, page.fixture.table.id))!;
    expect(failed.state).toBe('failed');
    const usd = await resultFieldsOf(server, page.fixture.table.id);
    expect((await cells(server, page.fixture.table.id, failed.record_id))[usd.status_field]).toBe(
      usd.choices.failed,
    );
    const retried = await page.book(page.at('12'), address);
    expect(retried.json()).toMatchObject({ status: 'booked' });
    expect(await pendingHolds(page.pageId)).toBe(1);
  });

  it('fail a form’s payment the same way, and say nothing was charged', async () => {
    const f = await paidForm(server);
    stripe.refuseSessions = true;
    const refused = await submit(server, f.formId, f.values);
    stripe.refuseSessions = false;
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ error: { messageKey: 'payments.checkoutFailed' } });
    const failed = (await latest(server, f.fixture.table.id))!;
    expect(failed.state).toBe('failed');
    const usd = await resultFieldsOf(server, f.fixture.table.id);
    expect((await cells(server, f.fixture.table.id, failed.record_id))[usd.status_field]).toBe(
      usd.choices.failed,
    );
  });

  it('stand past the session’s close until Stripe says it expired, or an hour after that', async () => {
    const page = await paidBookingPage(server);
    const address = nextAddress();
    expect(await page.status(page.at('12'), address)).toBe('booked');
    const first = (await latest(server, page.fixture.table.id))!;
    // A payment made just before the session closed can still be confirmed, so the time stays held.
    await moveExpiry(first.record_id, -200);
    expect(await page.status(page.at('12'))).toBe('taken');
    const expired = await webhook(server, stripe, connectionId, 'checkout.session.expired', {
      ...stripe.sessions.get(first.session_id!)!,
      status: 'expired',
    });
    expect(expired.statusCode, expired.body).toBe(200);
    expect(await page.status(page.at('12'), address)).toBe('booked');
    // Stripe's word never comes for this one, so the hold ends an hour after the session closed.
    const second = (await latest(server, page.fixture.table.id))!;
    await moveExpiry(second.record_id, -3500);
    expect(await page.status(page.at('12'))).toBe('taken');
    await moveExpiry(second.record_id, -3700);
    expect(await page.status(page.at('12'))).toBe('booked');
    const last = (await latest(server, page.fixture.table.id))!;
    await moveExpiry(last.record_id, -3700);
    const remove = await server.app.inject({
      method: 'DELETE',
      url: `/api/booking-pages/${page.pageId}`,
      headers: server.owner.headers,
    });
    expect(remove.statusCode, remove.body).toBe(204);
  });

  it('end when the record goes to the trash, expiring its Checkout Session at Stripe at once', async () => {
    const page = await paidBookingPage(server);
    expect(await page.status(page.at('12'))).toBe('booked');
    const pending = (await latest(server, page.fixture.table.id))!;
    await trash(page.fixture.table.databaseId, page.fixture.table.id, pending.record_id);
    expect(stripe.sessions.get(pending.session_id!)!.status).toBe('expired');
    expect(
      stripe.calls.some((call) => call.path === `/v1/checkout/sessions/${pending.session_id}/expire`),
    ).toBe(true);
    expect((await paymentOf(pending.record_id)).state).toBe('expired');
    const usd = await resultFieldsOf(server, page.fixture.table.id);
    expect((await cells(server, page.fixture.table.id, pending.record_id))[usd.status_field]).toBe(
      usd.choices.expired,
    );
    expect(await audits('payments.released', pending.record_id)).toBe(1);
    expect(await page.status(page.at('12'))).toBe('booked');
  });

  it('end when the booker cancels, expiring the session at Stripe', async () => {
    const page = await paidBookingPage(server);
    expect(await page.status(page.at('12'))).toBe('booked');
    const pending = (await latest(server, page.fixture.table.id))!;
    const booking = (
      await query<{ id: string }>(
        server.pool,
        sql`SELECT id FROM ${ident(server.schemas.app, 'bookings')} WHERE record_id = ${pending.record_id}`,
      )
    ).rows[0]!;
    const canceled = await server.app.inject({
      method: 'POST',
      url: '/api/public/bookings/cancel',
      payload: { token: cancelToken(server.config.secretKey, booking.id) },
    });
    expect(canceled.statusCode, canceled.body).toBe(200);
    expect(stripe.sessions.get(pending.session_id!)!.status).toBe('expired');
    expect((await paymentOf(pending.record_id)).state).toBe('expired');
  });

  it('allow one per visitor address on a page, and say when to try again', async () => {
    const page = await paidBookingPage(server);
    const address = nextAddress();
    expect(await page.status(page.at('12'), address)).toBe('booked');
    const again = await page.book(page.at('14'), address);
    expect(again.statusCode).toBe(429);
    expect(again.json()).toMatchObject({ error: { messageKey: 'payments.holdWaiting' } });
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(1700);
    expect(await pendingHolds(page.pageId)).toBe(1);
    expect(await page.status(page.at('14'))).toBe('booked');
  });

  it('take at most a third of a day’s places, while paid bookings don’t count', async () => {
    // Three hours a day, one place each, so one booking at a time may wait for payment.
    const page = await paidBookingPage(server, { hours: [{ start: '09:00', end: '12:00' }] });
    expect(await page.status(page.at('09'))).toBe('booked');
    const full = await page.book(page.at('10'));
    expect(full.statusCode).toBe(429);
    expect(full.json()).toMatchObject({ error: { messageKey: 'payments.holdsFull' } });
    const first = (await latest(server, page.fixture.table.id))!;
    expect(
      (await webhook(server, stripe, connectionId, 'checkout.session.completed', completed(stripe, first)))
        .statusCode,
    ).toBe(200);
    expect(await page.status(page.at('10'))).toBe('booked');
  });
});

describe('a payment that arrives after its place was given up', () => {
  it('is refunded in full, never confirmed, when staff put the booking in the trash', async () => {
    const page = await paidBookingPage(server);
    expect(await page.status(page.at('12'))).toBe('booked');
    const pending = (await latest(server, page.fixture.table.id))!;
    await trash(page.fixture.table.databaseId, page.fixture.table.id, pending.record_id);
    expect(await page.status(page.at('12'))).toBe('booked');
    const before = mails.length;
    // Paid at Stripe in the moment before its session was expired
    const object = completed(stripe, pending);
    const paid = await webhook(server, stripe, connectionId, 'checkout.session.completed', object);
    expect(paid.statusCode, paid.body).toBe(200);
    await expectRefunded(page, pending.record_id, object.payment_intent, 'trashed');
    expect(mails.slice(before).map((mail) => [mail.to, mail.subject])).toEqual([
      [expect.stringMatching(/^visitor\d+@example\.test$/), expect.stringMatching(/^Refunded: Class, /)],
    ]);
    expect(mails.slice(before)[0]!.text).toContain('refunded your payment of $12.50 in full');
    expect(await liveAt(page)).toBe(1);
  });

  it('is refunded when the session was paid just before the trash, so Stripe wouldn’t expire it', async () => {
    const page = await paidBookingPage(server);
    expect(await page.status(page.at('13'))).toBe('booked');
    const pending = (await latest(server, page.fixture.table.id))!;
    const object = completed(stripe, pending);
    stripe.sessions.set(pending.session_id!, object);
    await trash(page.fixture.table.databaseId, page.fixture.table.id, pending.record_id);
    expect((await paymentOf(pending.record_id)).state).toBe('pending');
    const paid = await webhook(server, stripe, connectionId, 'checkout.session.completed', object);
    expect(paid.statusCode, paid.body).toBe(200);
    await expectRefunded(page, pending.record_id, object.payment_intent, 'trashed');
  });

  it('is confirmed as usual when it arrives late while the hold still stands', async () => {
    const page = await paidBookingPage(server);
    expect(await page.status(page.at('17'))).toBe('booked');
    const pending = (await latest(server, page.fixture.table.id))!;
    const object = { ...completed(stripe, pending), expires_at: await moveExpiry(pending.record_id, -200) };
    expect(await page.status(page.at('17'))).toBe('taken');
    const before = mails.length;
    const paid = await webhook(server, stripe, connectionId, 'checkout.session.completed', object);
    expect(paid.statusCode, paid.body).toBe(200);
    expect((await paymentOf(pending.record_id)).state).toBe('paid');
    expect(mails.slice(before).map((mail) => mail.subject)).toEqual([
      expect.stringMatching(/^Booked: Class, /),
    ]);
    expect(await liveAt(page, '17')).toBe(1);
  });

  it('is refunded when its hold ended on its own and the time went to someone else', async () => {
    const page = await paidBookingPage(server);
    expect(await page.status(page.at('18'))).toBe('booked');
    const pending = (await latest(server, page.fixture.table.id))!;
    const object = { ...completed(stripe, pending), expires_at: await moveExpiry(pending.record_id, -3700) };
    expect(await page.status(page.at('18'))).toBe('booked');
    const before = mails.length;
    const paid = await webhook(server, stripe, connectionId, 'checkout.session.completed', object);
    expect(paid.statusCode, paid.body).toBe(200);
    await expectRefunded(page, pending.record_id, object.payment_intent, 'full');
    expect(mails.slice(before).map((mail) => mail.subject)).toEqual([expect.stringMatching(/^Refunded: /)]);
  });

  it('is confirmed when its hold ended on its own but its time is still free', async () => {
    const page = await paidBookingPage(server);
    expect(await page.status(page.at('19'))).toBe('booked');
    const pending = (await latest(server, page.fixture.table.id))!;
    const object = { ...completed(stripe, pending), expires_at: await moveExpiry(pending.record_id, -3700) };
    const paid = await webhook(server, stripe, connectionId, 'checkout.session.completed', object);
    expect(paid.statusCode, paid.body).toBe(200);
    expect((await paymentOf(pending.record_id)).state).toBe('paid');
  });

  it('is left for Stripe to deliver again when Stripe won’t take the refund', async () => {
    const page = await paidBookingPage(server);
    expect(await page.status(page.at('20'))).toBe('booked');
    const pending = (await latest(server, page.fixture.table.id))!;
    await trash(page.fixture.table.databaseId, page.fixture.table.id, pending.record_id);
    const object = completed(stripe, pending);
    stripe.refuseRefunds = true;
    const refused = await webhook(server, stripe, connectionId, 'checkout.session.completed', object);
    stripe.refuseRefunds = false;
    expect(refused.statusCode).toBe(503);
    expect((await paymentOf(pending.record_id)).state).toBe('expired');
    const again = await webhook(server, stripe, connectionId, 'checkout.session.completed', object);
    expect(again.statusCode, again.body).toBe(200);
    await expectRefunded(page, pending.record_id, object.payment_intent, 'trashed');
  });
});

describe('visitor addresses', () => {
  it('count an IPv6 address as its /64, and an IPv4 address written as IPv6 as itself', async () => {
    const key = server.config.secretKey;
    expect(addressKey(key, '2001:db8:1:2::1')).toBe(addressKey(key, '2001:0db8:0001:0002:ffff::9'));
    expect(addressKey(key, '2001:db8:1:2::1')).not.toBe(addressKey(key, '2001:db8:1:3::1'));
    expect(addressKey(key, '::ffff:10.77.0.1')).toBe(addressKey(key, '10.77.0.1'));
    expect(addressKey(key, '10.77.0.1')).not.toBe(addressKey(key, '10.77.0.2'));
    const page = await paidBookingPage(server);
    expect(await page.status(page.at('09'), '2001:db8:1:2::1')).toBe('booked');
    const same = await page.book(page.at('10'), '2001:db8:1:2::2');
    expect(same.statusCode).toBe(429);
    expect(same.json()).toMatchObject({ error: { messageKey: 'payments.holdWaiting' } });
    expect(await page.status(page.at('11'), '2001:db8:1:3::1')).toBe('booked');
    expect(await page.status(page.at('13'), '10.77.0.1')).toBe('booked');
    expect((await page.book(page.at('14'), '::ffff:10.77.0.1')).statusCode).toBe(429);
  });

  it('share the hourly limit across a /64', async () => {
    const page = await paidBookingPage(server);
    const keys: string[] = [];
    for (let i = 1; i <= BOOKING_LIMITS.hourly + 1; i += 1) {
      const response = await page.book(page.at('02'), `2001:db8:9:9::${i}`);
      keys.push(
        response.statusCode === 200
          ? 'booked'
          : response.json<{ error: { messageKey: string } }>().error.messageKey,
      );
    }
    // Each address in the /64 counts toward the one limit, whatever else refused it.
    expect(keys.slice(0, BOOKING_LIMITS.hourly)).not.toContain('bookings.public.rateLimited');
    expect(keys.at(-1)).toBe('bookings.public.rateLimited');
    expect((await page.book(page.at('03'), '2001:db8:9:a::1')).statusCode).toBe(200);
  });
});

describe('paid bookings', () => {
  it('count by their record’s current time, so moving one frees the old time and takes the new', async () => {
    const page = await paidBookingPage(server);
    expect(await page.status(page.at('12'))).toBe('booked');
    const payment = (await latest(server, page.fixture.table.id))!;
    expect(
      (await webhook(server, stripe, connectionId, 'checkout.session.completed', completed(stripe, payment)))
        .statusCode,
    ).toBe(200);
    const moved = await command(server, page.fixture.table.databaseId, {
      kind: 'record.update',
      tableId: page.fixture.table.id,
      records: [{ id: payment.record_id, values: { [page.time.id]: page.at('15') } }],
    });
    expect(moved.status).toBe('applied');
    expect(await page.status(page.at('15'))).toBe('taken');
    expect(await page.status(page.at('12'))).toBe('booked');
  });
});

describe('refused webhooks', () => {
  it('leave no trace for unknown connections and one entry an hour, with a count, for ours', async () => {
    const refusals = async () =>
      (
        await query<{ metadata: { connectionId: string; count: number; reasons: Record<string, number> } }>(
          server.pool,
          sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'payments.webhookRefused'`,
        )
      ).rows;
    const before = (await refusals()).length;
    // Other tests here may have left refusals in this hour already.
    const counted = (
      await query<{ count: number; reasons: Record<string, number> }>(
        server.pool,
        sql`SELECT count, reasons FROM ${ident(server.schemas.app, 'payment_refusals')} WHERE connection_id = ${connectionId}`,
      )
    ).rows[0] ?? { count: 0, reasons: {} };
    for (let i = 0; i < 40; i += 1) {
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/payments/webhooks/${randomBytes(24).toString('hex')}`,
        headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' },
        payload: '{}',
      });
      expect(response.statusCode).toBe(422);
    }
    for (let i = 0; i < 5; i += 1) {
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/payments/webhooks/${connectionId}`,
        headers: {
          'content-type': 'application/json',
          'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
        },
        payload: '{}',
      });
      expect(response.statusCode).toBe(422);
    }
    expect(await refusals()).toHaveLength(before);
    // The hour ends.
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'payment_refusals')} SET hour = hour - interval '1 hour' WHERE connection_id = ${connectionId}`,
    );
    await withTransaction(server.pool, (db) => flushRefusals(db, server.schemas));
    await withTransaction(server.pool, (db) => flushRefusals(db, server.schemas));
    const after = await refusals();
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)!.metadata).toMatchObject({
      connectionId,
      count: counted.count + 5,
      reasons: { 'payments.invalid': (counted.reasons['payments.invalid'] ?? 0) + 5 },
    });
  });
});

describe('payments and removal', () => {
  it('let the trash purge a database that took a payment, keeping the payment’s history', async () => {
    const f = await paidForm(server);
    expect((await submit(server, f.formId, f.values)).statusCode).toBe(200);
    const payment = (await latest(server, f.fixture.table.id))!;
    const object = completed(stripe, payment);
    await webhook(server, stripe, connectionId, 'checkout.session.completed', object);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'databases')} SET trashed_at = now() - interval '400 days' WHERE id = ${f.fixture.table.databaseId}`,
    );
    await purgeTrash(server.ctx);
    const kept = (
      await query<{ table_id: string | null; database_id: string | null; state: string; amount: number }>(
        server.pool,
        sql`SELECT * FROM ${ident(server.schemas.app, 'payments')} WHERE record_id = ${payment.record_id}`,
      )
    ).rows[0]!;
    expect(kept).toMatchObject({ table_id: null, database_id: null, state: 'paid', amount: 1250 });
    const gone = await query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.app, 'databases')} WHERE id = ${f.fixture.table.databaseId}`,
    );
    expect(gone.rowCount).toBe(0);
    // A refund made in Stripe afterward still lands on the payment.
    const refund = await webhook(server, stripe, connectionId, 'charge.refunded', {
      object: 'charge',
      livemode: false,
      paid: true,
      refunded: true,
      amount: 1250,
      amount_refunded: 1250,
      currency: 'usd',
      payment_intent: object.payment_intent,
    });
    expect(refund.statusCode, refund.body).toBe(200);
  });

  it('let People settings remove someone who shared a paid form and saved a paid booking page', async () => {
    const member = await server.addMember();
    const f = await paidForm(server, undefined, member, (databaseId) => grant(databaseId, member, 'creator'));
    expect((await submit(server, f.formId, f.values)).statusCode).toBe(200);
    const page = await paidBookingPage(server, {
      who: member,
      before: (databaseId) => grant(databaseId, member, 'creator'),
    });
    expect(await page.status(page.at('12'))).toBe('booked');
    const booked = (await latest(server, page.fixture.table.id))!;
    expect(booked.owner_id).toBe(member.userId);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'users')} SET deactivated_at = now() WHERE id = ${member.userId}`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'scim_users')} (org_id, user_id, document)
      VALUES (${server.owner.info.org.id}, ${member.userId}, ${JSON.stringify({ userName: member.email })}::jsonb)`,
    );
    const removed = await server.app.inject({
      method: 'DELETE',
      url: `/api/org/members/${member.userId}`,
      headers: server.owner.headers,
    });
    expect(removed.statusCode, removed.body).toBeLessThan(300);
    const kept = (
      await query<{ owner_id: string | null; state: string }>(
        server.pool,
        sql`SELECT owner_id, state FROM ${ident(server.schemas.app, 'payments')} WHERE record_id = ${booked.record_id}`,
      )
    ).rows[0]!;
    expect(kept).toEqual({ owner_id: null, state: 'pending' });
  });

  it('let provisioning remove someone whose page took a payment', async () => {
    const member = await server.addMember();
    const page = await paidBookingPage(server, {
      who: member,
      before: (databaseId) => grant(databaseId, member, 'creator'),
    });
    expect(await page.status(page.at('13'))).toBe('booked');
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'users')} SET deactivated_at = now() WHERE id = ${member.userId}`,
    );
    await withTransaction(server.pool, (db) =>
      removeAccount(
        db,
        server.schemas.app,
        {
          orgId: server.owner.info.org.id,
          audit: `"${server.schemas.audit}"`,
          actorId: server.owner.userId,
          metadata: {},
        },
        member.userId,
      ),
    );
    expect((await latest(server, page.fixture.table.id))!.owner_id).toBeNull();
  });
});

describe('public forms without payment', () => {
  it('still take answers as no one, even after their sharer becomes a reader', async () => {
    const member = await server.addMember();
    const f = await paidForm(server, null, member, (databaseId) => grant(databaseId, member, 'creator'));
    expect((await submit(server, f.formId, f.values)).statusCode).toBe(200);
    await grant(f.fixture.table.databaseId, member, 'reader');
    const response = await submit(server, f.formId, f.values);
    expect(response.statusCode, response.body).toBe(200);
    const rows = await query<{ created_by: string | null }>(
      server.pool,
      sql`SELECT __created_by AS created_by FROM ${ident(server.schemas.data, f.fixture.table.id)}`,
    );
    expect(rows.rows).toEqual([{ created_by: null }, { created_by: null }]);
    expect(await latest(server, f.fixture.table.id)).toBeUndefined();
  });
});
