import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type TokenCreated } from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { engine, runRows } from '../automations/automations.test-helpers.js';
import { managedGrant } from '../data/managed.js';
import { loadFields } from '../data/metadata.js';
import { insertRecords, updateRecords } from '../data/physical/records.js';
import {
  cells,
  clientId,
  command,
  completed,
  connect,
  fixed,
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
 * No one but the payment service writes a payment result field, whatever its currency or page:
 * not a visitor, an owner in the grid, the APIs, an import, an automation, a merge, or undo.
 */

let kit: TestPostgres;
let server: ServerFixture;
let stripe: StripeDouble;
let connectionId: string;
let token: TokenCreated;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'paymentguard', {
    baseUrl: 'https://example.test',
    mailFrom: 'Bookings <bookings@example.test>',
  });
  stripe = stubStripe();
  connectionId = await connect(server, stripe);
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: server.owner.headers,
    payload: {
      name: 'Integration',
      scopes: ['data.records:read', 'data.records:write', 'schema.bases:read'],
      databases: 'all',
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  token = created.json<TokenCreated>();
}, 60_000);
afterAll(async () => {
  stripe?.restore();
  await server?.close();
  await kit?.stop();
});

/** A form on a table whose USD result fields hold a paid record, and whose page now charges EUR */
async function paidRecord() {
  const f = await paidForm(server);
  expect((await submit(server, f.formId, f.values)).statusCode).toBe(200);
  const payment = (await latest(server, f.fixture.table.id))!;
  expect(
    (await webhook(server, stripe, connectionId, 'checkout.session.completed', completed(stripe, payment)))
      .statusCode,
  ).toBe(200);
  const usd = await resultFieldsOf(server, f.fixture.table.id);
  return { ...f, payment, usd, tableId: f.fixture.table.id, databaseId: f.fixture.table.databaseId };
}

const statusOf = async (tableId: string, recordId: string, fieldId: string) =>
  (await cells(server, tableId, recordId))[fieldId];

describe('payment result fields', () => {
  it('are marked managed in their stored definition', async () => {
    const f = await paidRecord();
    const fields = await loadFields(server.pool, server.schemas, [f.tableId]);
    const managed = fields.filter((field) => field.managed).map((field) => field.id);
    expect(managed.sort()).toEqual([f.usd.status_field, f.usd.amount_field, f.usd.reference_field].sort());
    const schema = await server.app.inject({
      url: `/api/databases/${f.databaseId}/schema`,
      headers: server.owner.headers,
    });
    const access = schema.json<{ access?: { fields: Array<{ fieldId: string; editable: boolean }> } }>()
      .access;
    expect(access?.fields.find((field) => field.fieldId === f.usd.status_field)).toMatchObject({
      editable: false,
    });
  });

  it('refuse a visitor who sets another currency’s status to Paid, and add nothing', async () => {
    const f = await paidForm(server);
    const usd = await resultFieldsOf(server, f.fixture.table.id);
    const eur = await server.app.inject({
      method: 'PUT',
      url: `/api/payment-pages/form/${f.fixture.view.id}`,
      headers: server.owner.headers,
      payload: { settings: { ...fixed, currency: 'eur' } },
    });
    expect(eur.statusCode, eur.body).toBe(200);
    const euro = await resultFieldsOf(server, f.fixture.table.id, 'eur');
    const forged = await submit(server, f.formId, {
      ...f.values,
      [usd.status_field]: usd.choices.paid,
      [usd.amount_field]: 12.5,
      [usd.reference_field]: 'pi_forged',
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json()).toMatchObject({ error: { messageKey: 'payments.protected' } });
    const current = await submit(server, f.formId, { ...f.values, [euro.status_field]: euro.choices.paid });
    expect(current.statusCode).toBe(403);
    expect(await latest(server, f.fixture.table.id)).toBeUndefined();
    const rows = await query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.data, f.fixture.table.id)}`,
    );
    expect(rows.rowCount).toBe(0);
  });

  it('refuse a visitor on a free form over a table that has them', async () => {
    const f = await paidRecord();
    const off = await server.app.inject({
      method: 'PUT',
      url: `/api/payment-pages/form/${f.fixture.view.id}`,
      headers: server.owner.headers,
      payload: { settings: null },
    });
    expect(off.statusCode, off.body).toBe(200);
    const forged = await submit(server, f.formId, { ...f.values, [f.usd.status_field]: f.usd.choices.paid });
    expect(forged.statusCode).toBe(422);
    expect(forged.json()).toMatchObject({ error: { messageKey: 'data.form.unknownField' } });
    expect((await submit(server, f.formId, f.values)).statusCode).toBe(200);
  });

  it('refuse a visitor on a booking page', async () => {
    const page = await paidBookingPage(server);
    const usd = await resultFieldsOf(server, page.fixture.table.id);
    const forged = await page.book(page.at('09'), undefined, { [usd.status_field]: usd.choices.paid });
    expect(forged.statusCode).toBe(422);
    expect(await latest(server, page.fixture.table.id)).toBeUndefined();
  });

  it('refuse the grid and a spreadsheet import, owners included', async () => {
    const f = await paidRecord();
    const create = await command(server, f.databaseId, {
      kind: 'record.create',
      tableId: f.tableId,
      records: [
        { id: newId('record'), values: { [f.fixture.fields[0]!.id]: 'Row 1' } },
        { id: newId('record'), values: { [f.usd.status_field]: f.usd.choices.paid } },
      ],
    });
    expect(create.status).toBe('rejected');
    const update = await command(server, f.databaseId, {
      kind: 'record.update',
      tableId: f.tableId,
      records: [{ id: f.payment.record_id, values: { [f.usd.status_field]: f.usd.choices.refunded } }],
    });
    expect(update.status).toBe('rejected');
    expect(await statusOf(f.tableId, f.payment.record_id, f.usd.status_field)).toBe(f.usd.choices.paid);
  });

  it('refuse the API and leave them out of a replace', async () => {
    const f = await paidRecord();
    const headers = { authorization: `Bearer ${token.token}` };
    const patch = await server.app.inject({
      method: 'PATCH',
      url: `/api/v1/tables/${f.tableId}/records`,
      headers,
      payload: {
        fieldKey: 'id',
        records: [{ id: f.payment.record_id, fields: { [f.usd.status_field]: f.usd.choices.refunded } }],
      },
    });
    expect(patch.statusCode).not.toBe(200);
    const replace = await server.app.inject({
      method: 'PUT',
      url: `/api/v1/tables/${f.tableId}/records`,
      headers,
      payload: {
        fieldKey: 'id',
        records: [{ id: f.payment.record_id, fields: { [f.fixture.fields[0]!.id]: 'Replaced' } }],
      },
    });
    expect(replace.statusCode, replace.body).toBe(200);
    const row = await cells(server, f.tableId, f.payment.record_id);
    expect(row[f.fixture.fields[0]!.id]).toBe('Replaced');
    expect(row[f.usd.status_field]).toBe(f.usd.choices.paid);
  });

  it('refuse the Airtable-compatible API', async () => {
    const f = await paidRecord();
    const response = await server.app.inject({
      method: 'PATCH',
      url: `/v0/${f.databaseId}/${f.tableId}`,
      headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        records: [{ id: f.payment.record_id, fields: { [f.usd.status_field]: 'Refunded' } }],
      }),
    });
    expect(response.statusCode).toBe(422);
    expect(await statusOf(f.tableId, f.payment.record_id, f.usd.status_field)).toBe(f.usd.choices.paid);
  });

  it('refuse automations, whether a step names them or a script writes them', async () => {
    const f = await paidRecord();
    const step = await command(server, f.databaseId, {
      kind: 'automation.create',
      automation: {
        id: newId('automation'),
        name: 'Mark paid',
        config: {
          trigger: { kind: 'recordCreated', tableId: f.tableId },
          steps: [
            {
              id: 'mark-paid',
              kind: 'updateRecord',
              tableId: f.tableId,
              record: 'trigger',
              values: { [f.usd.status_field]: 'Paid' },
            },
          ],
        },
      },
    });
    expect(step).toMatchObject({ status: 'rejected', error: { messageKey: 'payments.protected' } });
    const id = newId('automation');
    const update = (fieldId: string, value: string) =>
      `await records.update(${JSON.stringify(f.tableId)}, ${JSON.stringify(f.payment.record_id)}, { ${JSON.stringify(fieldId)}: ${JSON.stringify(value)} })`;
    // The first change is allowed, which shows the script ran as far as the payment status.
    const script = [
      update(f.fixture.fields[0]!.id, 'Scripted'),
      update(f.usd.status_field, f.usd.choices.refunded),
    ].join('\n');
    expect(
      await command(server, f.databaseId, {
        kind: 'automation.create',
        automation: {
          id,
          name: 'Script',
          config: {
            trigger: { kind: 'recordCreated', tableId: f.tableId },
            steps: [{ id: 'write-status', kind: 'script', input: {}, script }],
          },
        },
      }),
    ).toMatchObject({ status: 'applied' });
    expect(
      await command(server, f.databaseId, { kind: 'automation.update', automationId: id, enabled: true }),
    ).toMatchObject({ status: 'applied' });
    expect(
      await command(server, f.databaseId, {
        kind: 'record.create',
        tableId: f.tableId,
        records: [{ id: newId('record'), values: { [f.fixture.fields[0]!.id]: 'Trigger' } }],
      }),
    ).toMatchObject({ status: 'applied' });
    await engine(server).drain();
    const [run] = await runRows(server, id);
    expect(run?.state).toBe('failed');
    const row = await cells(server, f.tableId, f.payment.record_id);
    expect(row[f.fixture.fields[0]!.id]).toBe('Scripted');
    expect(row[f.usd.status_field]).toBe(f.usd.choices.paid);
    await command(server, f.databaseId, { kind: 'automation.update', automationId: id, enabled: false });
  });

  it('keep the kept record’s own values when records merge', async () => {
    const f = await paidRecord();
    expect((await submit(server, f.formId, f.values)).statusCode).toBe(200);
    const pending = (await latest(server, f.tableId))!;
    const chosen = await command(server, f.databaseId, {
      kind: 'record.merge',
      tableId: f.tableId,
      recordId: pending.record_id,
      mergeIds: [f.payment.record_id],
      choices: { [f.usd.status_field]: f.payment.record_id },
    });
    expect(chosen.status).toBe('rejected');
    const merged = await command(server, f.databaseId, {
      kind: 'record.merge',
      tableId: f.tableId,
      recordId: pending.record_id,
      mergeIds: [f.payment.record_id],
    });
    expect(merged.status).toBe('applied');
    expect(await statusOf(f.tableId, pending.record_id, f.usd.status_field)).toBe(f.usd.choices.pending);
  });

  it('stay as the payment service wrote them through undo, and refuse any writer without a grant', async () => {
    const f = await paidForm(server);
    expect((await submit(server, f.formId, f.values)).statusCode).toBe(200);
    const payment = (await latest(server, f.fixture.table.id))!;
    const usd = await resultFieldsOf(server, f.fixture.table.id);
    const groupId = newId('action');
    const edit = await command(
      server,
      f.fixture.table.databaseId,
      {
        kind: 'record.update',
        tableId: f.fixture.table.id,
        records: [{ id: payment.record_id, values: { [f.fixture.fields[0]!.id]: 'Edited' } }],
      },
      server.owner,
      groupId,
    );
    expect(edit.status).toBe('applied');
    await webhook(server, stripe, connectionId, 'checkout.session.completed', completed(stripe, payment));
    const undo = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${f.fixture.table.databaseId}/undo`,
      headers: server.owner.headers,
      payload: { clientId, groupId, commandId: newId('command') },
    });
    expect(undo.statusCode, undo.body).toBe(200);
    const row = await cells(server, f.fixture.table.id, payment.record_id);
    expect(row[f.fixture.fields[0]!.id]).toBe('Visitor');
    expect(row[usd.status_field]).toBe(usd.choices.paid);

    // The one check every value write reaches, as undo and merges call it directly
    const fields = await loadFields(server.pool, server.schemas, [f.fixture.table.id]);
    const write = (grant?: ReturnType<typeof managedGrant>, id = payment.record_id) =>
      withTransaction(server.pool, (db) =>
        updateRecords(
          db,
          server.schemas.data,
          f.fixture.table.id,
          fields,
          [{ id, values: { [usd.status_field]: usd.choices.refunded } }],
          server.owner.userId,
          [],
          grant,
        ),
      );
    await expect(write()).rejects.toMatchObject({ messageKey: 'payments.protected' });
    await expect(write(managedGrant([newId('record')], [usd.status_field]))).rejects.toMatchObject({
      messageKey: 'payments.protected',
    });
    await expect(write(managedGrant([payment.record_id], [usd.amount_field]))).rejects.toMatchObject({
      messageKey: 'payments.protected',
    });
    await expect(
      withTransaction(server.pool, (db) =>
        insertRecords(
          db,
          server.schemas.data,
          f.fixture.table.id,
          fields,
          [{ id: newId('record'), values: { [usd.status_field]: usd.choices.paid } }],
          null,
        ),
      ),
    ).rejects.toMatchObject({ messageKey: 'payments.protected' });
    expect(await statusOf(f.fixture.table.id, payment.record_id, usd.status_field)).toBe(usd.choices.paid);
  });
});
