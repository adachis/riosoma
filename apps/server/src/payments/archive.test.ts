import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { CATALOGS, LEFT_OUT } from '../data/organization-archives/catalog.js';
import { issueTicket } from '../data/public-forms.js';
import {
  call,
  exportArchive,
  importArchive,
  rebuild,
  reviewList,
  target,
  type Row,
} from '../data/organization-archives/organization-archives.test-support.js';
import { loadFields } from '../data/metadata.js';
import {
  completed,
  connect,
  latest,
  paidBookingPage,
  paidForm,
  resultFieldsOf,
  stubStripe,
  submit,
  webhook,
  type StripeDouble,
} from './payments.test-helpers.js';

/**
 * An organization export carries what forms and booking pages charge and their managed result
 * fields, and leaves the Stripe account, its payments, and their result values behind.  A form that
 * charges comes in refusing answers until Stripe is connected again, never taking them free.
 */

let kit: TestPostgres;
let origin: ServerFixture;
let stripe: StripeDouble;
const servers: ServerFixture[] = [];
let archive: Buffer;
let form: Awaited<ReturnType<typeof paidForm>>;
let page: Awaited<ReturnType<typeof paidBookingPage>>;
beforeAll(async () => {
  kit = await startTestPostgres();
  origin = await startServer(kit, 'payarchive_origin', {
    baseUrl: 'https://example.test',
    mailFrom: 'Bookings <bookings@example.test>',
  });
  stripe = stubStripe();
  const connectionId = await connect(origin, stripe);
  form = await paidForm(origin);
  expect((await submit(origin, form.formId, form.values)).statusCode).toBe(200);
  const payment = (await latest(origin, form.fixture.table.id))!;
  await webhook(origin, stripe, connectionId, 'checkout.session.completed', completed(stripe, payment));
  page = await paidBookingPage(origin);
  expect(await page.status(page.at('12'))).toBe('booked');
  archive = (await exportArchive(origin, {})).bytes;
}, 120_000);
afterAll(async () => {
  stripe?.restore();
  for (const server of servers) await server.close();
  await origin?.close();
  await kit?.stop();
});

/** Imports an archive, and answers the table behind its form and its booking page's ID */
async function imported(prefix: string, bytes = archive) {
  const { server } = await target(kit, prefix);
  servers.push(server);
  await importArchive(server, bytes);
  const pages = (
    await query<{ kind: string; table_id: string; target_id: string }>(
      server.pool,
      sql`SELECT kind, table_id, target_id FROM ${ident(server.schemas.app, 'payment_pages')}`,
    )
  ).rows;
  const form = pages.find((row) => row.kind === 'form')!;
  const booking = pages.find((row) => row.kind === 'booking')!;
  return {
    server,
    tableId: form.table_id,
    bookingTableId: booking.table_id,
    bookingPageId: booking.target_id,
  };
}
const count = async (server: ServerFixture, name: string) =>
  Number(
    (
      await query<{ n: string }>(
        server.pool,
        sql`SELECT count(*) AS n FROM ${ident(server.schemas.app, name)}`,
      )
    ).rows[0]!.n,
  );

describe('an organization export', () => {
  it('carries payment settings and leaves the Stripe account behind', () => {
    expect(CATALOGS).toEqual(expect.arrayContaining(['payment_fields', 'payment_pages']));
    for (const name of ['stripe_connections', 'payments', 'payment_events', 'payment_refusals']) {
      expect(CATALOGS, name).not.toContain(name);
      expect(LEFT_OUT[name], name).toBeTruthy();
    }
  });

  it('brings payment settings and managed result fields, but no account, payments, or results', async () => {
    const { server, tableId } = await imported('payarchive_plain');
    for (const name of ['stripe_connections', 'payments', 'payment_events'])
      expect(await count(server, name), name).toBe(0);
    const pages = await query<{ kind: string; settings: unknown }>(
      server.pool,
      sql`SELECT kind, settings FROM ${ident(server.schemas.app, 'payment_pages')} ORDER BY kind`,
    );
    expect(pages.rows).toEqual([
      { kind: 'booking', settings: expect.objectContaining({ currency: 'usd' }) },
      { kind: 'form', settings: expect.objectContaining({ currency: 'usd' }) },
    ]);
    const usd = await resultFieldsOf(server, tableId);
    const fields = await loadFields(server.pool, server.schemas, [tableId]);
    expect(
      fields
        .filter((field) => field.managed)
        .map((field) => field.id)
        .sort(),
    ).toEqual([usd.status_field, usd.amount_field, usd.reference_field].sort());
    // The booking page's table has its own three.
    const everywhere = await query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.app, 'fields')} WHERE managed = 'payment'`,
    );
    expect(everywhere.rowCount).toBe(6);
    const records = await query<Row>(server.pool, sql`SELECT * FROM ${ident(server.schemas.data, tableId)}`);
    expect(records.rows).toHaveLength(1);
    expect(records.rows[0]![usd.status_field]).toBeNull();
    expect(records.rows[0]![usd.reference_field]).toBeNull();
  });

  it('turns a form that charges on refusing answers until Stripe is connected again', async () => {
    const { server, tableId } = await imported('payarchive_review');
    const item = (await reviewList(server)).find((entry) => entry.kind === 'publicForm')!;
    await call(server, 'POST', `/api/organization-archives/review/${item.id}/enable`);
    const shared = (
      await query<{ id: string }>(
        server.pool,
        sql`SELECT id FROM ${ident(server.schemas.app, 'public_forms')} WHERE stopped_at IS NULL`,
      )
    ).rows[0]!;
    const fields = await loadFields(server.pool, server.schemas, [tableId]);
    const [text, number] = fields.filter((field) => !field.managed);
    const response = await submit(server, shared.id, { [text!.id]: 'Visitor', [number!.id]: 2 });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { messageKey: 'payments.notConnected' } });
    const records = await query(server.pool, sql`SELECT 1 FROM ${ident(server.schemas.data, tableId)}`);
    expect(records.rowCount).toBe(1);
  });

  it('turns a booking page that charges on refusing bookings until Stripe is connected again', async () => {
    const { server, bookingTableId, bookingPageId } = await imported('payarchive_booking');
    expect(bookingPageId).not.toBe(page.pageId);
    const pageRow = await query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.app, 'booking_pages')} WHERE id = ${bookingPageId}`,
    );
    expect(pageRow.rowCount).toBe(1);
    const item = (await reviewList(server)).find((entry) => entry.kind === 'bookingPage')!;
    await call(server, 'POST', `/api/organization-archives/review/${item.id}/enable`);
    const fields = await loadFields(server.pool, server.schemas, [bookingTableId]);
    const [name, email] = fields.filter((field) => !field.managed);
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/public/bookings/${bookingPageId}/bookings`,
      payload: {
        ticket: issueTicket(server.config.secretKey, bookingPageId, Date.now() - 3000, 'bookingPage'),
        start: page.at('15'),
        values: { [name!.id]: 'Visitor', [email!.id]: 'visitor@example.test' },
        timeZone: 'UTC',
        locale: 'en-US',
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { messageKey: 'payments.notConnected' } });
    const records = await query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.data, bookingTableId)}`,
    );
    expect(records.rowCount).toBe(1);
  });

  it('keeps result fields managed and empty whatever a changed archive says', async () => {
    const usd = await resultFieldsOf(origin, form.fixture.table.id);
    const hostile = await rebuild(archive, {
      entry: (_name, items) =>
        items.map((item) => {
          const line = item as { kind: string; catalog?: string; table?: string; row: Row };
          if (line.kind === 'catalog' && line.catalog === 'fields')
            return { ...line, row: { ...line.row, managed: null } };
          if (line.kind === 'records' && line.table === form.fixture.table.id)
            return {
              ...line,
              row: { ...line.row, [usd.status_field]: usd.choices.paid, [usd.reference_field]: 'pi_forged' },
            };
          return item;
        }),
    });
    const { server, tableId } = await imported('payarchive_hostile', hostile);
    const fields = await loadFields(server.pool, server.schemas, [tableId]);
    expect(fields.filter((field) => field.managed)).toHaveLength(3);
    const moved = await resultFieldsOf(server, tableId);
    const records = await query<Row>(server.pool, sql`SELECT * FROM ${ident(server.schemas.data, tableId)}`);
    expect(
      records.rows.every((row) => row[moved.status_field] === null && row[moved.reference_field] === null),
    ).toBe(true);
  });
});
