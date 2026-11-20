import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  dayIn,
  newId,
  PublicFormId,
  type Choice,
  type CommandBatchResult,
  type PublicForm,
  type PublicFormLink,
  type RowsPage,
  type ServerMessage,
  type PublicSubmitted,
  type HistoryPage,
  type SignatureValue,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { buildApp } from '../app.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { issueTicket, nobodyIn } from './public-forms.js';
import {
  EDIT_DAY_MS,
  EDIT_SESSION_MS,
  issueFormEditToken,
  readFormEditToken,
} from './public-form-edit-tokens.js';
import { readFixture } from './snapshots.test-helpers.js';
import { AccessScope } from './access.js';

const LIMIT = 3;
let kit: TestPostgres;
let server: ServerFixture;
let address: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'pubforms', { publicFormHourlyLimit: LIMIT });
  server.config.baseUrl = undefined;
  address = await server.app.listen({ host: '127.0.0.1', port: 0 });
}, 60_000);
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

const choices: Choice[] = [
  { id: newId('choice'), name: 'Small', color: 'blue' },
  { id: newId('choice'), name: 'Large', color: 'green' },
];

const EDIT_ADDRESS = '198.51.100.11';
const openEdit = (formId: string, token: string, remoteAddress = EDIT_ADDRESS) =>
  server.app.inject({
    method: 'POST',
    url: `/api/public/forms/${formId}/edit-session`,
    payload: { token },
    remoteAddress,
  });
const saveEdit = (
  formId: string,
  session: string,
  values: Record<string, unknown>,
  remoteAddress = EDIT_ADDRESS,
) =>
  server.app.inject({
    method: 'POST',
    url: `/api/public/forms/${formId}/edits`,
    payload: { session, values },
    remoteAddress,
  });

async function editFixture(settings: Record<string, unknown> = {}) {
  const limit = server.config.publicFormHourlyLimit;
  server.config.publicFormHourlyLimit = 100;
  cleanups.push(() => {
    server.config.publicFormHourlyLimit = limit;
  });
  const f = await formFixture(
    [{ type: 'text' }, { type: 'checkbox' }, { type: 'text' }, { type: 'text' }],
    ([name, trigger, child]) => [
      { fieldId: name, required: true },
      { fieldId: trigger },
      { fieldId: child, required: true, showIf: { fieldId: trigger, equals: true } },
    ],
    { allowEdits: true, ...settings },
  );
  const [name, trigger, child, privateField] = f.fields as [string, string, string, string];
  const formId = await shared(f.viewId);
  const response = await submit(formId, {
    ticket: ticket(formId),
    values: { [name]: 'First answer', [trigger]: false },
  });
  expect(response.statusCode, response.body).toBe(200);
  const link = response.json<PublicSubmitted>().editLink!;
  expect(Date.parse(link.expiresAt) - Date.now()).toBeGreaterThan(
    (Number(settings.editLinkDays ?? 30) - 1) * EDIT_DAY_MS,
  );
  const token = link.path.split('#')[1]!;
  const recordId = (await storedRecords(f.tableId))[0]!.id;
  return { ...f, formId, token, recordId, name, trigger, child, privateField };
}

describe('response edit links', () => {
  it('opens and saves one response without granting access to other records or private fields', async () => {
    const f = await editFixture();
    const otherId = newId('record');
    await run(f.databaseId, {
      kind: 'record.create',
      tableId: f.tableId,
      records: [
        { id: otherId, values: { [f.name]: 'Other response', [f.privateField]: 'Other private value' } },
      ],
    });
    await run(f.databaseId, {
      kind: 'record.create',
      tableId: f.spareTableId,
      records: [{ id: newId('record'), values: {} }],
    });
    const opened = await openEdit(f.formId, f.token);
    expect(opened.statusCode, opened.body).toBe(200);
    const form = opened.json<PublicForm>();
    expect(form.edit).toMatchObject({
      session: expect.any(String),
      expiresAt: expect.any(String),
      values: { [f.name]: 'First answer', [f.trigger]: false },
    });
    expect(opened.body).not.toContain('Other response');
    expect(opened.body).not.toContain('Other private value');
    const saved = await saveEdit(f.formId, form.edit!.session, {
      [f.name]: 'Edited response',
      [f.trigger]: false,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const rows = (
      await server.app.inject({ url: `/api/views/${f.gridViewId}/rows`, headers: server.owner.headers })
    ).json<RowsPage>().rows;
    expect(rows.find((row) => row?.id === otherId)!.values).toMatchObject({
      [f.name]: 'Other response',
      [f.privateField]: 'Other private value',
    });
    expect(rows.find((row) => row?.id === f.recordId)!.values[f.name]).toBe('Edited response');
    const scope = new AccessScope(server.pool, server.schemas, nobodyIn(server.owner.info.org.id));
    await scope.prepare(f.databaseId);
    const publicRows = await query(
      server.pool,
      sql`SELECT __id FROM ${ident(server.schemas.data, f.tableId)} WHERE ${scope.recordPredicate(f.tableId)}`,
    );
    expect(publicRows.rowCount).toBe(0);
    expect(scope.visibleFields(f.tableId, f.read.fields)).toEqual([]);
    const editing = new AccessScope(server.pool, server.schemas, nobodyIn(server.owner.info.org.id), {
      publicQuestions: {
        tableId: f.tableId,
        fieldIds: new Set([f.name, f.trigger, f.child]),
        recordId: f.recordId,
      },
    });
    await editing.prepare(f.databaseId);
    const editableRows = await query<{ __id: string }>(
      server.pool,
      sql`SELECT __id FROM ${ident(server.schemas.data, f.tableId)} AS response WHERE ${editing.recordPredicate(f.tableId, 'response')}`,
    );
    expect(editableRows.rows).toEqual([{ __id: f.recordId }]);
    expect(editing.visibleFields(f.tableId, f.read.fields).map((field) => field.id)).toEqual([
      f.name,
      f.trigger,
      f.child,
    ]);
    const otherTableRows = await query(
      server.pool,
      sql`SELECT __id FROM ${ident(server.schemas.data, f.spareTableId)} WHERE ${editing.recordPredicate(f.spareTableId)}`,
    );
    expect(otherTableRows.rowCount).toBe(0);
  });

  it.each([
    { name: 'Avery Quinn' },
    { name: null, drawing: { path: 'M 1 1 L 10 10', width: 100, height: 40 } },
  ])(
    'preserves an unchanged signature and stamps a new signature when editing another answer: %j',
    async (signature) => {
      const f = await formFixture(
        [{ type: 'text' }, { type: 'signature' }],
        (fields) => fields.map((fieldId) => ({ fieldId, required: true })),
        { allowEdits: true },
      );
      const [name, signed] = f.fields as [string, string];
      const formId = await shared(f.viewId);
      const submitted = await submit(formId, {
        ticket: ticket(formId),
        values: { [name]: 'Original answer', [signed]: signature },
      });
      expect(submitted.statusCode, submitted.body).toBe(200);
      const token = submitted.json<PublicSubmitted>().editLink!.path.split('#')[1]!;
      const opened = (await openEdit(formId, token)).json<PublicForm>();
      const original = opened.edit!.values[signed] as SignatureValue;
      await delay(5);
      const saved = await saveEdit(formId, opened.edit!.session, {
        ...opened.edit!.values,
        [name]: 'Updated answer',
      });
      expect(saved.statusCode, saved.body).toBe(200);
      const rows = () =>
        server.app.inject({ url: `/api/views/${f.gridViewId}/rows`, headers: server.owner.headers });
      expect((await rows()).json<RowsPage>().rows[0]!.values[signed]).toEqual(original);
      await delay(5);
      const replaced = await saveEdit(formId, opened.edit!.session, {
        [name]: 'Updated answer',
        [signed]: {
          ...original,
          name: 'New signer',
          signedBy: server.owner.userId,
          signedAt: '2000-01-01T00:00:00.000Z',
        },
      });
      expect(replaced.statusCode, replaced.body).toBe(200);
      const next = (await rows()).json<RowsPage>().rows[0]!.values[signed] as SignatureValue;
      expect(next.name).toBe('New signer');
      expect(next.signedBy).toBeNull();
      expect(Date.parse(next.signedAt)).toBeGreaterThan(Date.parse(original.signedAt));
    },
  );

  it('emails the signed link only with owner and submitter opt-in, and honors the chosen expiry', async () => {
    const mailer = server.ctx.mailer;
    const baseUrl = server.config.baseUrl;
    const sent: Array<{ to: string | string[]; text?: string; html?: string }> = [];
    server.ctx.mailer = {
      async send(message) {
        sent.push(message);
      },
    };
    server.config.baseUrl = 'https://forms.example.test';
    cleanups.push(() => {
      server.ctx.mailer = mailer;
      server.config.baseUrl = baseUrl;
    });
    const f = await editFixture({ editConfirmationEmail: true, editLinkDays: 1 });
    expect(sent).toHaveLength(0);
    expect((await definition(f.formId)).json<PublicForm>().editEmailAvailable).toBe(true);
    const response = await submit(f.formId, {
      ticket: ticket(f.formId),
      values: { [f.name]: 'Another answer' },
      confirmationEmail: 'submitter@example.test',
    });
    expect(response.statusCode, response.body).toBe(200);
    const link = response.json<PublicSubmitted>().editLink!;
    expect(Date.parse(link.expiresAt) - Date.now()).toBeLessThanOrEqual(EDIT_DAY_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('submitter@example.test');
    expect(sent[0]!.text).toContain(link.path);
    expect(sent[0]!.html).toContain(`https://forms.example.test${link.path}`);
    const disabled = await editFixture();
    await submit(disabled.formId, {
      ticket: ticket(disabled.formId),
      values: { [disabled.name]: 'Another answer' },
      confirmationEmail: 'submitter@example.test',
    });
    expect(sent).toHaveLength(1);
  });

  it('is off by default and accepts only bounded whole-day lifetimes', async () => {
    const f = await formFixture([{ type: 'text' }], ([name]) => [{ fieldId: name }]);
    const formId = await shared(f.viewId);
    expect((await submit(formId, { ticket: ticket(formId), values: {} })).json()).not.toHaveProperty(
      'editLink',
    );
    for (const editLinkDays of [0, 366, 1.5]) {
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/databases/${f.databaseId}/commands`,
        headers: server.owner.headers,
        payload: {
          clientId: newId('client'),
          commands: [
            {
              id: newId('command'),
              groupId: newId('action'),
              kind: 'view.update',
              viewId: f.viewId,
              config: { form: { editLinkDays } },
            },
          ],
        },
      });
      expect(response.json<CommandBatchResult>().results[0]!.status).toBe('rejected');
    }
  });

  it('prefills only current visible answers and protects hidden values during edits and undo', async () => {
    const f = await editFixture();
    await run(f.databaseId, {
      kind: 'record.update',
      tableId: f.tableId,
      records: [
        {
          id: f.recordId,
          values: {
            [f.name]: 'Current answer',
            [f.child]: 'Hidden change by owner',
            [f.privateField]: 'Private value',
          },
        },
      ],
    });
    const opened = await openEdit(f.formId, f.token);
    expect(opened.statusCode, opened.body).toBe(200);
    const form = opened.json<PublicForm>();
    expect(form.edit!.values).toEqual({ [f.name]: 'Current answer', [f.trigger]: false });
    expect(opened.body).not.toContain('Hidden change by owner');
    expect(opened.body).not.toContain('Private value');
    expect(opened.body).not.toContain(f.privateField);
    const session = form.edit!.session;
    const forged = await saveEdit(f.formId, session, {
      [f.name]: 'Changed',
      [f.trigger]: false,
      [f.child]: 'Forged',
    });
    expect(forged.json().error.messageKey).toBe('data.form.unknownField');
    expect(
      (await saveEdit(f.formId, session, { [f.name]: 'Changed', [f.privateField]: 'Forged' })).statusCode,
    ).toBe(422);
    expect(
      (await saveEdit(f.formId, session, { [f.name]: 'Changed', [f.trigger]: true })).json().error.messageKey,
    ).toBe('data.form.required');
    const saved = await saveEdit(f.formId, session, { [f.name]: 'Changed', [f.trigger]: false });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(await storedRecords(f.tableId)).toEqual([{ id: f.recordId, created_by: null, updated_by: null }]);
    const history = (
      await server.app.inject({
        url: `/api/tables/${f.tableId}/records/${f.recordId}/history`,
        headers: server.owner.headers,
      })
    ).json<HistoryPage>();
    expect(history.entries[0]).toMatchObject({ formViewId: f.viewId, actorId: null });
    expect(await formEvents(f.viewId)).toContainEqual(
      expect.objectContaining({
        action: 'data.form.edited',
        actor_id: null,
        metadata: expect.objectContaining({ actor: 'submitterLink', recordId: f.recordId }),
      }),
    );
    await run(f.databaseId, {
      kind: 'record.update',
      tableId: f.tableId,
      records: [{ id: f.recordId, values: { [f.privateField]: 'Later private change' } }],
    });
    const undoPath = `/api/views/${f.viewId}/public-form/edits/${history.entries[0]!.seq}/undo`;
    const undone = await server.app.inject({
      method: 'POST',
      url: undoPath,
      headers: server.owner.headers,
      payload: {},
    });
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json().restored).toBeGreaterThan(0);
    const rows = (
      await server.app.inject({ url: `/api/views/${f.gridViewId}/rows`, headers: server.owner.headers })
    ).json<RowsPage>().rows;
    expect(rows[0]!.values).toMatchObject({
      [f.name]: 'Current answer',
      [f.child]: 'Hidden change by owner',
      [f.privateField]: 'Later private change',
    });
    expect(
      (
        await server.app.inject({ method: 'POST', url: undoPath, headers: server.owner.headers, payload: {} })
      ).json(),
    ).toEqual({ restored: 0 });
  });

  it('binds links to their form and record, and sessions to their purpose and address', async () => {
    const f = await editFixture();
    const other = await formFixture([{ type: 'text' }], ([name]) => [{ fieldId: name }], {
      allowEdits: true,
    });
    const otherForm = await shared(other.viewId);
    expect((await openEdit(otherForm, f.token)).json().error.messageKey).toBe('forms.edit.invalid');
    const claims = readFormEditToken(server.config.secretKey, f.token, { formId: f.formId, purpose: 'link' });
    const foreign = issueFormEditToken(server.config.secretKey, { ...claims, recordId: newId('record') });
    expect((await openEdit(f.formId, foreign)).statusCode).toBe(404);
    const opened = (await openEdit(f.formId, f.token)).json<PublicForm>();
    const session = opened.edit!.session;
    expect((await openEdit(f.formId, session)).json().error.messageKey).toBe('forms.edit.invalid');
    expect((await saveEdit(f.formId, f.token, { [f.name]: 'Changed' })).json().error.messageKey).toBe(
      'forms.edit.invalid',
    );
    expect(
      (await saveEdit(f.formId, session, { [f.name]: 'Changed' }, '198.51.100.12')).json().error.messageKey,
    ).toBe('forms.edit.invalid');
    const forged = await server.app.inject({
      method: 'POST',
      url: `/api/public/forms/${f.formId}/edits`,
      remoteAddress: EDIT_ADDRESS,
      payload: { session, recordId: newId('record'), values: { [f.name]: 'Changed' } },
    });
    expect(forged.statusCode).toBe(422);
  });

  it('revokes existing links and sessions together while new submissions receive valid links', async () => {
    const f = await editFixture();
    const session = (await openEdit(f.formId, f.token)).json<PublicForm>().edit!.session;
    const revoked = await server.app.inject({
      method: 'POST',
      url: `/api/views/${f.viewId}/public-form/revoke-edits`,
      headers: server.owner.headers,
      payload: {},
    });
    expect(revoked.statusCode, revoked.body).toBe(204);
    expect((await openEdit(f.formId, f.token)).json().error.messageKey).toBe('forms.edit.revoked');
    expect((await saveEdit(f.formId, session, { [f.name]: 'Changed' })).json().error.messageKey).toBe(
      'forms.edit.revoked',
    );
    const fresh = (
      await submit(f.formId, { ticket: ticket(f.formId), values: { [f.name]: 'New answer' } })
    ).json<PublicSubmitted>();
    expect((await openEdit(f.formId, fresh.editLink!.path.split('#')[1]!)).statusCode).toBe(200);
  });

  it('expires links and sessions and refuses saves after disabling edits or stopping sharing', async () => {
    const f = await editFixture();
    const claims = readFormEditToken(server.config.secretKey, f.token, { formId: f.formId, purpose: 'link' });
    const expired = issueFormEditToken(server.config.secretKey, {
      ...claims,
      issuedAt: Date.now() - EDIT_DAY_MS,
      expires: Date.now() - 1,
    });
    expect((await openEdit(f.formId, expired)).json().error.messageKey).toBe('forms.edit.expired');
    const session = (await openEdit(f.formId, f.token)).json<PublicForm>().edit!.session;
    const sessionClaims = readFormEditToken(server.config.secretKey, session, {
      formId: f.formId,
      purpose: 'session',
    });
    const ended = issueFormEditToken(server.config.secretKey, {
      ...sessionClaims,
      issuedAt: Date.now() - EDIT_SESSION_MS,
      expires: Date.now() - 1,
    });
    expect((await saveEdit(f.formId, ended, { [f.name]: 'Changed' })).json().error.messageKey).toBe(
      'forms.edit.expired',
    );
    const config = (
      await query<{ config: Record<string, unknown> }>(
        server.pool,
        sql`SELECT config FROM ${ident(server.schemas.app, 'views')} WHERE id = ${f.viewId}`,
      )
    ).rows[0]!.config;
    await run(f.databaseId, {
      kind: 'view.update',
      viewId: f.viewId,
      config: { form: { ...(config.form as object), allowEdits: false } },
    });
    expect((await saveEdit(f.formId, session, { [f.name]: 'Changed' })).json().error.messageKey).toBe(
      'forms.edit.revoked',
    );
    await stop(f.viewId);
    expect((await saveEdit(f.formId, session, { [f.name]: 'Changed' })).statusCode).toBe(404);
  });

  it('honors record locks, field rules, and record rules added after the edit session opened', async () => {
    const f = await editFixture();
    const session = (await openEdit(f.formId, f.token)).json<PublicForm>().edit!.session;
    await run(f.databaseId, {
      kind: 'record.setLock',
      tableId: f.tableId,
      recordIds: [f.recordId],
      locked: true,
      reason: 'Under review',
    });
    const locked = await saveEdit(f.formId, session, { [f.name]: 'Changed' });
    expect(locked.statusCode, locked.body).toBe(422);
    expect(locked.json().error.messageKey).toBe('data.locks.recordLocked');
    expect(locked.json().error.params.reason).toBe('Under review');
    await run(f.databaseId, {
      kind: 'record.setLock',
      tableId: f.tableId,
      recordIds: [f.recordId],
      locked: false,
    });
    await server.app.inject({
      method: 'PUT',
      url: `/api/fields/${f.name}/permissions`,
      headers: server.owner.headers,
      payload: { restricted: null, locked: { roles: [], users: [] } },
    });
    expect((await saveEdit(f.formId, session, { [f.name]: 'Changed' })).statusCode).toBe(422);
    expect((await openEdit(f.formId, f.token)).body).not.toContain('First answer');
    await server.app.inject({
      method: 'PUT',
      url: `/api/fields/${f.name}/permissions`,
      headers: server.owner.headers,
      payload: { restricted: null, locked: null },
    });
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'record_rules')} (id, org_id, database_id, table_id, position, roles, users, condition)
      VALUES (${newId('recordRule')}, ${server.owner.info.org.id}, ${f.databaseId}, ${f.tableId}, 0, ARRAY['editor'], ARRAY[]::text[], ${JSON.stringify({ conjunction: 'and', conditions: [] })}::jsonb)`,
    );
    expect((await openEdit(f.formId, f.token)).json().error.messageKey).toBe('data.access.recordHidden');
    expect((await saveEdit(f.formId, session, { [f.name]: 'Changed' })).json().error.messageKey).toBe(
      'data.access.recordHidden',
    );
  });

  it('counts edit opens and saves against the public rate limit', async () => {
    const f = await editFixture();
    server.config.publicFormHourlyLimit = 2;
    const session = (await openEdit(f.formId, f.token)).json<PublicForm>().edit!.session;
    expect((await saveEdit(f.formId, session, { [f.name]: 'Changed', [f.trigger]: false })).statusCode).toBe(
      200,
    );
    const limited = await saveEdit(f.formId, session, { [f.name]: 'Changed again' });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});

it('rejects hidden public answers and omits questions whose trigger becomes locked', async () => {
  const f = await formFixture([{ type: 'checkbox' }, { type: 'text' }], ([parent, child]) => [
    { fieldId: parent },
    { fieldId: child, required: true, showIf: { fieldId: parent, equals: true } },
  ]);
  const [parent, child] = f.fields as [string, string];
  const formId = await shared(f.viewId);
  expect((await definition(formId)).json<PublicForm>().questions[1]!.showIf).toEqual({
    fieldId: parent,
    equals: true,
  });
  const forged = await submit(formId, {
    ticket: ticket(formId),
    values: { [parent]: false, [child]: 'Hidden' },
  });
  expect(forged.statusCode).toBe(422);
  expect(forged.json().error.messageKey).toBe('data.form.unknownField');
  expect((await submit(formId, { ticket: ticket(formId), values: { [parent]: false } })).statusCode).toBe(
    200,
  );
  expect(
    (await submit(formId, { ticket: ticket(formId), values: { [parent]: true } })).json().error.messageKey,
  ).toBe('data.form.required');
  const locked = await server.app.inject({
    method: 'PUT',
    url: `/api/fields/${parent}/permissions`,
    headers: server.owner.headers,
    payload: { restricted: null, locked: { roles: [], users: [] } },
  });
  expect(locked.statusCode, locked.body).toBe(200);
  expect((await definition(formId)).json<PublicForm>().questions).toEqual([]);
  expect((await submit(formId, { ticket: ticket(formId), values: { [child]: 'Hidden' } })).statusCode).toBe(
    422,
  );
  expect(await formEvents(f.viewId)).toContainEqual(
    expect.objectContaining({ action: 'data.form.submitted' }),
  );
});

let addresses = 0;
/** A different address each time, so tests that aren't about the limit never reach it. */
const nextAddress = () => `203.0.113.${(addresses += 1) % 250}`;

async function run(databaseId: string, input: Record<string, unknown>, who: SignedIn = server.owner) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: who.headers,
    payload: {
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<CommandBatchResult>().results[0]!;
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
  return result;
}

type Specs = Parameters<typeof readFixture>[1];
type Questions = (fields: string[]) => Array<Record<string, unknown>>;

/** A database with a form view on its first table, and a spare table so that one can be trashed. */
async function formFixture(specs: Specs, questions: Questions, form: Record<string, unknown> = {}) {
  const read = await readFixture(server, specs);
  const databaseId = read.table.databaseId;
  const spareTableId = newId('table');
  await run(databaseId, {
    kind: 'table.create',
    table: {
      id: spareTableId,
      name: 'Spare',
      fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
      records: [],
    },
  });
  const fields = read.fields.map((field) => field.id);
  const viewId = newId('view');
  await run(databaseId, {
    kind: 'view.create',
    view: {
      id: viewId,
      name: 'Signups',
      tableId: read.table.id,
      type: 'form',
      config: {
        form: {
          title: 'Sign up',
          description: 'Tell us who you are.',
          questions: questions(fields),
          submitLabel: 'Send',
          thankYou: 'Thanks, friend.',
          allowAnother: true,
          ...form,
        },
      },
    },
  });
  return { read, databaseId, tableId: read.table.id, gridViewId: read.view.id, viewId, spareTableId, fields };
}

const share = (viewId: string, who: SignedIn = server.owner) =>
  server.app.inject({ method: 'PUT', url: `/api/views/${viewId}/public-form`, headers: who.headers });
const stop = (viewId: string, who: SignedIn = server.owner) =>
  server.app.inject({ method: 'DELETE', url: `/api/views/${viewId}/public-form`, headers: who.headers });
const linkFor = (viewId: string, who: SignedIn = server.owner) =>
  server.app.inject({ url: `/api/views/${viewId}/public-form`, headers: who.headers });
const definition = (formId: string) => server.app.inject({ url: `/api/public/forms/${formId}` });

async function shared(viewId: string): Promise<string> {
  const response = await share(viewId);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<PublicFormLink>().formId;
}

/** A ticket this server would have issued `age` milliseconds ago. */
const ticket = (formId: string, age = 3_000, key = server.config.secretKey) =>
  issueTicket(key, formId, Date.now() - age);

function submit(
  formId: string,
  body: Record<string, unknown>,
  options: { remoteAddress?: string; headers?: Record<string, string>; app?: FastifyInstance } = {},
) {
  return (options.app ?? server.app).inject({
    method: 'POST',
    url: `/api/public/forms/${formId}/submissions`,
    payload: body,
    remoteAddress: options.remoteAddress ?? nextAddress(),
    ...(options.headers ? { headers: options.headers } : {}),
  });
}

async function grant(databaseId: string, who: SignedIn, role: string) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${who.userId}, ${role})`,
  );
}

async function storedRecords(tableId: string) {
  const result = await query<{ id: string; created_by: string | null; updated_by: string | null }>(
    server.pool,
    sql`SELECT __id AS id, __created_by AS created_by, __updated_by AS updated_by
      FROM ${ident(server.schemas.data, tableId)} WHERE __deleted_at IS NULL ORDER BY __rid`,
  );
  return result.rows;
}

async function formEvents(viewId: string) {
  const result = await query<{
    org_id: string | null;
    actor_id: string | null;
    action: string;
    metadata: unknown;
  }>(
    server.pool,
    sql`SELECT org_id, actor_id, action, metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE action LIKE 'data.form.%' AND metadata ->> 'viewId' = ${viewId} ORDER BY id`,
  );
  return result.rows;
}

async function until(check: () => boolean, timeout = 5_000): Promise<void> {
  const started = performance.now();
  while (!check()) {
    if (performance.now() - started > timeout) throw new Error('condition timed out');
    await delay(10);
  }
}

/** A signed-in browser tab subscribed to a database's changes. */
async function watch(databaseId: string) {
  const socket = new WebSocket(`${address.replace(/^http/, 'ws')}/api/realtime`, {
    headers: { cookie: server.owner.headers.cookie, origin: address },
  });
  const inbox: ServerMessage[] = [];
  socket.addEventListener('message', (event) => inbox.push(JSON.parse(String(event.data)) as ServerMessage));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('upgrade refused')), { once: true });
  });
  cleanups.push(() => socket.close());
  socket.send(
    JSON.stringify({ type: 'hello', csrf: server.owner.info.csrfToken, clientId: newId('client') }),
  );
  await until(() => inbox.some((message) => message.type === 'ready'));
  socket.send(JSON.stringify({ type: 'subscribe', databaseId, sinceSeq: 0 }));
  await until(() => inbox.some((message) => message.type === 'caughtUp'));
  return inbox;
}

describe('sharing a form', () => {
  it('publishes, shows, and stops a link only for people who can change views', async () => {
    const f = await formFixture([{ type: 'text' }], (fields) => [{ fieldId: fields[0] }]);
    const reader = await server.addMember();
    const editor = await server.addMember();
    const creator = await server.addMember();
    const outsider = await server.addMember();
    await grant(f.databaseId, reader, 'reader');
    await grant(f.databaseId, editor, 'editor');
    await grant(f.databaseId, creator, 'creator');

    expect((await server.app.inject({ url: `/api/views/${f.viewId}/public-form` })).statusCode).toBe(401);
    let response = await linkFor(f.viewId);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toBeNull();
    for (const who of [reader, editor]) {
      response = await share(f.viewId, who);
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toMatchObject({ code: 'forbidden', messageKey: 'data.access.denied' });
    }
    expect((await share(f.viewId, outsider)).statusCode).toBe(404);
    expect((await linkFor(f.viewId)).json()).toBeNull();

    response = await share(f.viewId);
    expect(response.statusCode, response.body).toBe(200);
    const link = response.json<PublicFormLink>();
    expect(PublicFormId.safeParse(link.formId).success).toBe(true);
    expect(link).toEqual({
      formId: link.formId,
      viewId: f.viewId,
      path: `/f/${link.formId}`,
      createdAt: expect.any(String),
      createdBy: server.owner.userId,
      submissions: 0,
      omittedFieldIds: [],
      suspendedSharer: null,
    });
    // Sharing a shared form keeps its link.
    expect((await share(f.viewId, creator)).json<PublicFormLink>()).toEqual(link);
    expect((await linkFor(f.viewId, reader)).json()).toEqual(link);
    expect((await linkFor(f.viewId, outsider)).statusCode).toBe(404);
    expect((await definition(link.formId)).statusCode).toBe(200);

    for (const who of [reader, editor]) expect((await stop(f.viewId, who)).statusCode).toBe(403);
    expect((await definition(link.formId)).statusCode).toBe(200);
    response = await stop(f.viewId);
    expect(response.statusCode).toBe(204);
    expect((await linkFor(f.viewId)).json()).toBeNull();
    response = await definition(link.formId);
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({ code: 'not_found', messageKey: 'forms.public.notFound' });
    response = await submit(link.formId, { ticket: ticket(link.formId), values: { [f.fields[0]!]: 'Ada' } });
    expect(response.statusCode).toBe(404);
    expect(await storedRecords(f.tableId)).toEqual([]);
    expect((await stop(f.viewId)).statusCode).toBe(204);

    const again = (await share(f.viewId, creator)).json<PublicFormLink>();
    expect(again.formId).not.toBe(link.formId);
    expect(again.createdBy).toBe(creator.userId);
    expect((await definition(link.formId)).statusCode).toBe(404);
    expect((await definition(again.formId)).statusCode).toBe(200);
    expect((await formEvents(f.viewId)).map((event) => [event.action, event.actor_id])).toEqual([
      ['data.form.shared', server.owner.userId],
      ['data.form.unshared', server.owner.userId],
      ['data.form.shared', creator.userId],
    ]);
  });

  it('refuses to share a view that is not a form, and names the questions it leaves out', async () => {
    const f = await formFixture([{ type: 'text' }, { type: 'user' }, { type: 'attachment' }], (fields) =>
      fields.map((fieldId) => ({ fieldId })),
    );
    let response = await share(f.gridViewId);
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({
      code: 'validation_failed',
      messageKey: 'data.view.badSetting',
      params: { setting: 'type' },
    });
    expect((await linkFor(f.gridViewId)).json()).toBeNull();
    response = await share(f.viewId);
    expect(response.json<PublicFormLink>().omittedFieldIds).toEqual([f.fields[1], f.fields[2]]);
  });

  it('refuses a form on a joined table, whose rows its inputs decide', async () => {
    const f = await formFixture([{ type: 'text' }], (fields) => [{ fieldId: fields[0] }]);
    const side = newId('table');
    const sideKey = newId('field');
    await run(f.databaseId, {
      kind: 'table.create',
      table: {
        id: side,
        name: 'Side',
        fields: [{ id: sideKey, name: 'Key', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    });
    const joined = newId('table');
    const key = newId('field');
    await run(f.databaseId, {
      kind: 'table.create',
      table: {
        id: joined,
        name: 'Joined',
        fields: [{ id: key, name: 'Key', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
        joined: {
          baseTableId: f.tableId,
          steps: [
            {
              tableId: side,
              leftTableId: f.tableId,
              leftFieldId: f.fields[0],
              rightFieldId: sideKey,
              kind: 'left',
            },
          ],
          fields: [{ tableId: f.tableId, fieldId: f.fields[0], outputFieldId: key }],
        },
      },
    });
    const questions = newId('view');
    await run(f.databaseId, {
      kind: 'view.create',
      view: {
        id: questions,
        name: 'Signups',
        tableId: joined,
        type: 'form',
        config: {
          form: {
            title: 'Sign up',
            questions: [{ fieldId: key }],
            submitLabel: 'Send',
            thankYou: 'Thanks, friend.',
          },
        },
      },
    });
    const refused = await share(questions);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatchObject({ messageKey: 'sources.syncedReadOnly' });
  });
});

describe('the public form', () => {
  it('preserves negative-value restrictions in public numeric questions', async () => {
    const f = await formFixture(
      (['number', 'currency', 'percent'] as const).map((type) => ({
        type,
        options: { allowNegative: false },
      })),
      (fields) => fields.map((fieldId) => ({ fieldId })),
    );
    const formId = await shared(f.viewId);
    const questions = (await definition(formId)).json<PublicForm>().questions;
    expect(questions.map((question) => question.options.allowNegative)).toEqual([false, false, false]);
    for (const fieldId of f.fields) {
      const response = await submit(formId, { ticket: ticket(formId), values: { [fieldId]: -1 } });
      expect(response.statusCode).toBe(422);
    }
    expect(
      (
        await submit(formId, {
          ticket: ticket(formId),
          values: Object.fromEntries(f.fields.map((fieldId) => [fieldId, 1])),
        })
      ).statusCode,
    ).toBe(200);
  });

  it('gives the public only what answering needs', async () => {
    const f = await formFixture(
      [
        { type: 'text' },
        { type: 'singleSelect', options: { choices } },
        { type: 'multipleSelect', options: { choices } },
        { type: 'number', options: { precision: 2, allowNegative: false, thousands: false } },
        { type: 'currency', options: { code: 'EUR', precision: 0 } },
        { type: 'percent', options: { precision: 1 } },
        { type: 'rating', options: { max: 7, icon: 'heart', color: 'red' } },
        { type: 'date', options: { includeTime: true, timeZone: 'America/Chicago', dateFormat: 'iso' } },
        { type: 'checkbox', options: { color: 'purple' } },
        { type: 'longText' },
        { type: 'email' },
        { type: 'url' },
        { type: 'phone' },
        { type: 'duration', options: { format: 'h:mm:ss' } },
        { type: 'user' },
        { type: 'attachment' },
        { type: 'text' },
        { type: 'text' },
      ],
      (fields) => [
        { fieldId: fields[0], label: 'Your name', help: 'First and last.', required: true },
        ...fields.slice(1, 16).map((fieldId) => ({ fieldId })),
        { fieldId: fields[17] },
      ],
    );
    const [user, attachment, unasked, trashed] = [14, 15, 16, 17].map((index) => f.fields[index]!) as [
      string,
      string,
      string,
      string,
    ];
    const linkField = newId('field');
    await run(f.databaseId, {
      kind: 'field.create',
      tableId: f.tableId,
      field: { id: linkField, name: 'Related', type: 'link', options: { linkedTableId: f.spareTableId } },
    });
    const config = (
      await server.app.inject({ url: `/api/databases/${f.databaseId}/schema`, headers: server.owner.headers })
    )
      .json<{ views: Array<{ id: string; config: { form: { questions: unknown[] } } }> }>()
      .views.find((view) => view.id === f.viewId)!.config.form;
    await run(f.databaseId, {
      kind: 'view.update',
      viewId: f.viewId,
      config: { form: { ...config, questions: [...config.questions, { fieldId: linkField }] } },
    });
    await run(f.databaseId, { kind: 'field.trash', fieldId: trashed });
    await run(f.databaseId, {
      kind: 'record.create',
      tableId: f.tableId,
      records: [{ id: newId('record'), values: { [unasked]: 'Top secret', [f.fields[0]!]: 'Hidden name' } }],
    });
    const formId = await shared(f.viewId);

    const response = await definition(formId);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    const question = (index: number, type: string, options: Record<string, unknown> = {}) => ({
      fieldId: f.fields[index],
      type,
      label: `Field ${index}`,
      help: '',
      required: false,
      options,
    });
    expect(response.json<PublicForm>()).toEqual({
      formId,
      title: 'Sign up',
      description: 'Tell us who you are.',
      submitLabel: 'Send',
      thankYou: 'Thanks, friend.',
      allowAnother: true,
      theme: { id: 'nature', scheme: 'grove' },
      ticket: expect.stringMatching(/^\d+\.[A-Za-z0-9_-]{43}$/),
      questions: [
        {
          fieldId: f.fields[0],
          type: 'text',
          label: 'Your name',
          help: 'First and last.',
          required: true,
          options: {},
        },
        question(1, 'singleSelect', { choices }),
        question(2, 'multipleSelect', { choices }),
        question(3, 'number', { precision: 2, allowNegative: false }),
        question(4, 'currency', { code: 'EUR', precision: 0, allowNegative: true }),
        question(5, 'percent', { precision: 1, allowNegative: true }),
        question(6, 'rating', { max: 7 }),
        question(7, 'date', { includeTime: true }),
        question(8, 'checkbox'),
        question(9, 'longText', { richText: false }),
        question(10, 'email'),
        question(11, 'url'),
        question(12, 'phone'),
        question(13, 'duration'),
      ],
    });
    for (const secret of [
      f.databaseId,
      f.tableId,
      f.viewId,
      f.gridViewId,
      f.spareTableId,
      user,
      attachment,
      unasked,
      trashed,
      linkField,
      server.owner.userId,
      server.owner.info.org.id,
      'Top secret',
      'Hidden name',
      'Field 14',
      'Field 15',
      'Field 16',
      'Field 17',
      'Related',
      'Signups',
      'Records',
      'America/Chicago',
      'heart',
    ])
      expect(response.body).not.toContain(secret);
    const link = (await linkFor(f.viewId)).json<PublicFormLink>();
    expect(link.omittedFieldIds).toEqual([user, attachment, linkField]);

    // A database that forces its theme shows it on its forms.
    for (const [settings, theme] of [
      [{ theme: { id: 'terminal', scheme: 'amber' } }, { id: 'terminal', scheme: 'amber' }],
      [{ theme: { id: 'Not a theme', scheme: 'amber' } }, { id: 'nature', scheme: 'grove' }],
      [{ theme: 'terminal' }, { id: 'nature', scheme: 'grove' }],
    ] as const) {
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'databases')} SET settings = ${JSON.stringify(settings)}::jsonb
        WHERE id = ${f.databaseId}`,
      );
      expect((await definition(formId)).json<PublicForm>().theme).toEqual(theme);
    }
  });

  it('uses the view name when the form has no title', async () => {
    const f = await formFixture([{ type: 'text' }], (fields) => [{ fieldId: fields[0] }], { title: '' });
    const form = (await definition(await shared(f.viewId))).json<PublicForm>();
    expect(form.title).toBe('Signups');
  });

  it('treats malformed and unknown links as unavailable', async () => {
    for (const formId of ['short', 'has-punctuation-in-it!', 'A'.repeat(23), 'B'.repeat(22)]) {
      for (const response of [
        await definition(encodeURIComponent(formId)),
        await submit(encodeURIComponent(formId), { ticket: 'x', values: {} }),
      ]) {
        expect(response.statusCode).toBe(404);
        expect(response.json().error).toMatchObject({
          code: 'not_found',
          messageKey: 'forms.public.notFound',
        });
      }
    }
  });
});

describe('public submissions', () => {
  it('exposes usable question defaults so blank required answers can reach the server', async () => {
    const f = await formFixture(
      [
        { type: 'text', options: { defaultValue: { kind: 'value', value: 'Open' } } },
        { type: 'number', options: { defaultValue: { kind: 'value', value: 2 } } },
        { type: 'text', options: { defaultValue: { kind: 'value', value: 'Private' } } },
      ],
      (fields) => fields.slice(0, 2).map((fieldId) => ({ fieldId, required: true })),
    );
    const formId = await shared(f.viewId);
    const form = (await definition(formId)).json<PublicForm>();
    expect(form.questions.map((question) => question.options.defaultValue)).toEqual([
      { kind: 'value', value: 'Open' },
      { kind: 'value', value: 2 },
    ]);
    expect(form.questions.map((question) => question.fieldId)).toEqual(f.fields.slice(0, 2));
    const response = await submit(formId, { ticket: ticket(formId), values: {} });
    expect(response.statusCode, response.body).toBe(200);
    const page = (
      await server.app.inject({ url: `/api/views/${f.gridViewId}/rows`, headers: server.owner.headers })
    ).json<RowsPage>();
    expect(page.rows[0]!.values).toMatchObject({ [f.fields[0]!]: 'Open', [f.fields[1]!]: 2 });
  });

  it('gives questions left blank their defaults, keeps answers, and starts a box checked by default', async () => {
    const f = await formFixture(
      [
        { type: 'text', options: { defaultValue: { kind: 'value', value: 'Website' } } },
        { type: 'checkbox', options: { defaultValue: { kind: 'value', value: true } } },
        { type: 'date', options: { defaultValue: { kind: 'today' } } },
        { type: 'user', options: { defaultValue: { kind: 'creator' } } },
        { type: 'number', options: { defaultValue: { kind: 'value', value: 7 } } },
        { type: 'text', options: { defaultValue: { kind: 'value', value: 'Unread' } } },
      ],
      (fields) => fields.slice(0, 3).map((fieldId) => ({ fieldId })),
    );
    const [source, box, day, owner, number, status] = f.fields as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const formId = await shared(f.viewId);
    const form = (await definition(formId)).json<PublicForm>();
    // The browser checks required questions using the same defaults the server applies.
    expect(form.questions.map((question) => question.options)).toEqual([
      { defaultValue: { kind: 'value', value: 'Website' } },
      { defaultValue: { kind: 'value', value: true } },
      { includeTime: false, defaultValue: { kind: 'today' } },
    ]);
    const before = new Date();
    const response = await submit(formId, {
      ticket: ticket(formId),
      values: { [source]: '', [box]: false },
      timeZone: 'Pacific/Kiritimati',
    });
    expect(response.statusCode, response.body).toBe(200);
    const page = (
      await server.app.inject({ url: `/api/views/${f.gridViewId}/rows`, headers: server.owner.headers })
    ).json<RowsPage>();
    const values = page.rows[0]!.values;
    expect([values[source], values[box], values[owner], values[number], values[status]]).toEqual([
      'Website',
      false,
      null,
      7,
      'Unread',
    ]);
    expect([dayIn('Pacific/Kiritimati', before), dayIn('Pacific/Kiritimati', new Date())]).toContain(
      values[day],
    );
    const refused = await submit(formId, { ticket: ticket(formId), values: {}, timeZone: 'Not/AZone' });
    expect(refused.statusCode, refused.body).toBe(422);
  });

  it('refuses tickets that are too new, too old, or forged', async () => {
    const f = await formFixture([{ type: 'text' }], (fields) => [{ fieldId: fields[0] }]);
    const other = await formFixture([{ type: 'text' }], (fields) => [{ fieldId: fields[0] }]);
    const formId = await shared(f.viewId);
    const otherId = await shared(other.viewId);
    const values = { [f.fields[0]!]: 'Ada' };
    const fresh = (await definition(formId)).json<PublicForm>().ticket;
    const [issued, mac] = fresh.split('.') as [string, string];
    for (const candidate of [
      fresh,
      ticket(formId, 1_000),
      ticket(formId, 24 * 3_600_000 + 60_000),
      ticket(formId, -60_000),
      ticket(formId, 3_000, Buffer.alloc(32, 7)),
      ticket(otherId),
      `${Number(issued) - 3_000}.${mac}`,
      `${Date.now() - 3_000}.${'A'.repeat(43)}`,
      `${Date.now() - 3_000}`,
      'not a ticket',
    ]) {
      const response = await submit(formId, { ticket: candidate, values });
      expect(response.statusCode, candidate).toBe(403);
      expect(response.json().error).toMatchObject({ code: 'forbidden', messageKey: 'forms.public.ticket' });
    }
    expect(await storedRecords(f.tableId)).toEqual([]);
    for (const age of [2_500, 23 * 3_600_000]) {
      const response = await submit(formId, { ticket: ticket(formId, age), values });
      expect(response.statusCode, response.body).toBe(200);
    }
    expect(await storedRecords(f.tableId)).toHaveLength(2);
  });

  it('accepts and drops submissions that fill the hidden field', async () => {
    const f = await formFixture([{ type: 'text' }], (fields) => [{ fieldId: fields[0] }]);
    const formId = await shared(f.viewId);
    for (const ticketValue of [ticket(formId), 'no ticket at all']) {
      const response = await submit(formId, {
        ticket: ticketValue,
        website: 'https://spam.example',
        values: { [f.fields[0]!]: 'Buy now' },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ thankYou: 'Thanks, friend.', allowAnother: true });
    }
    expect(await storedRecords(f.tableId)).toEqual([]);
    expect((await linkFor(f.viewId)).json<PublicFormLink>().submissions).toBe(0);
    const attempts = await query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.app, 'public_form_attempts')} WHERE form_id = ${formId}`,
    );
    expect(attempts.rowCount).toBe(0);
    expect(await submit(formId, { ticket: ticket(formId), website: '', values: {} })).toMatchObject({
      statusCode: 200,
    });
    expect(await storedRecords(f.tableId)).toHaveLength(1);
  });

  it('limits each address to its hourly submissions to each form, by the address the server trusts', async () => {
    const f = await formFixture([{ type: 'text' }], (fields) => [{ fieldId: fields[0] }]);
    const other = await formFixture([{ type: 'text' }], (fields) => [{ fieldId: fields[0] }]);
    const formId = await shared(f.viewId);
    const otherId = await shared(other.viewId);
    const body = (id: string, field: string) => ({ ticket: ticket(id), values: { [field]: 'Ada' } });
    const from = '198.51.100.7';
    // Without a trusted proxy, forwarded addresses don't count: this is all one address.
    for (let i = 0; i < LIMIT; i += 1) {
      const response = await submit(formId, body(formId, f.fields[0]!), {
        remoteAddress: from,
        headers: { 'x-forwarded-for': `192.0.2.${i}` },
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    const limited = await submit(formId, body(formId, f.fields[0]!), {
      remoteAddress: from,
      headers: { 'x-forwarded-for': '192.0.2.99' },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toMatchObject({
      code: 'rate_limited',
      messageKey: 'forms.public.rateLimited',
    });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(3_500);
    expect(
      (await submit(formId, body(formId, f.fields[0]!), { remoteAddress: '198.51.100.8' })).statusCode,
    ).toBe(200);
    expect((await submit(otherId, body(otherId, other.fields[0]!), { remoteAddress: from })).statusCode).toBe(
      200,
    );
    expect(await storedRecords(f.tableId)).toHaveLength(LIMIT + 1);

    // Only keyed hashes of addresses are kept.
    const stored = await query<{ address: string }>(
      server.pool,
      sql`SELECT address FROM ${ident(server.schemas.app, 'public_form_attempts')} WHERE form_id = ${formId}`,
    );
    expect(stored.rows).toHaveLength(LIMIT + 1);
    expect(JSON.stringify(stored.rows)).not.toContain('198.51.100');

    // After an hour the address may answer again.
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'public_form_attempts')} SET at = at - interval '61 minutes'
      WHERE form_id = ${formId}`,
    );
    expect((await submit(formId, body(formId, f.fields[0]!), { remoteAddress: from })).statusCode).toBe(200);

    // Behind a trusted proxy, the forwarded address is the one counted.
    const proxied = await buildApp({
      ...server.ctx,
      config: { ...server.config, trustProxy: '127.0.0.1' },
    });
    cleanups.push(() => proxied.close());
    for (let i = 0; i < LIMIT + 1; i += 1) {
      const response = await submit(formId, body(formId, f.fields[0]!), {
        app: proxied,
        remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': `192.0.2.${i}` },
      });
      expect(response.statusCode, response.body).toBe(200);
    }
  });

  it('refuses bodies over 64 KB', async () => {
    const f = await formFixture([{ type: 'longText' }], (fields) => [{ fieldId: fields[0] }]);
    const formId = await shared(f.viewId);
    const response = await submit(formId, {
      ticket: ticket(formId),
      values: { [f.fields[0]!]: 'x'.repeat(70_000) },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error).toMatchObject({ code: 'payload_too_large', messageKey: 'errors.tooLarge' });
    expect(await storedRecords(f.tableId)).toEqual([]);
    const accepted = await submit(formId, {
      ticket: ticket(formId),
      values: { [f.fields[0]!]: 'x'.repeat(60_000) },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
  });

  it('takes answers only to the questions it asks publicly, and requires the required ones', async () => {
    const f = await formFixture(
      [
        { type: 'text' },
        { type: 'number' },
        { type: 'user' },
        { type: 'attachment' },
        { type: 'text' },
        { type: 'singleSelect', options: { choices } },
      ],
      (fields) => [
        { fieldId: fields[0], required: true },
        { fieldId: fields[1] },
        { fieldId: fields[2], required: true },
        { fieldId: fields[3] },
        { fieldId: fields[5] },
      ],
    );
    const [text, number, user, attachment, unasked, select] = f.fields as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const formId = await shared(f.viewId);
    const unknownField = newId('field');
    for (const [values, error] of [
      [
        { [text]: 'Ada', [user]: [server.owner.userId] },
        { messageKey: 'data.form.unknownField', params: { fieldId: user } },
      ],
      [
        { [text]: 'Ada', [attachment]: [newId('attachment')] },
        { messageKey: 'data.form.unknownField', params: { fieldId: attachment } },
      ],
      [
        { [text]: 'Ada', [unasked]: 'Sneaky' },
        { messageKey: 'data.form.unknownField', params: { fieldId: unasked } },
      ],
      [{ [text]: 'Ada', [unknownField]: 'Sneaky' }, { messageKey: 'data.form.unknownField' }],
      [{ [text]: 'Ada', notAField: 'Sneaky' }, { messageKey: 'errors.validationFailed' }],
      [{ [number]: 3 }, { messageKey: 'data.form.required', params: { fieldId: text } }],
      [{ [text]: '   ' }, { messageKey: 'data.form.required', params: { fieldId: text } }],
      [{ [text]: 'Ada', [number]: 'three' }, { messageKey: 'data.value.notNumber' }],
      [{ [text]: 'Ada', [select]: newId('choice') }, { messageKey: 'data.value.unknownChoice' }],
    ] as const) {
      const response = await submit(formId, { ticket: ticket(formId), values });
      expect(response.statusCode, JSON.stringify(values)).toBe(422);
      expect(response.json().error).toMatchObject({ code: 'validation_failed', ...error });
    }
    expect(await storedRecords(f.tableId)).toEqual([]);
    expect((await linkFor(f.viewId)).json<PublicFormLink>().submissions).toBe(0);
    // The required people question stays private, so it holds nobody up.
    const response = await submit(formId, {
      ticket: ticket(formId),
      values: { [text]: 'Ada', [number]: 3, [select]: choices[1]!.id },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(await storedRecords(f.tableId)).toHaveLength(1);
  });

  it('adds one record that belongs to nobody, and broadcasts, counts, and audits it', async () => {
    const f = await formFixture(
      [
        { type: 'text' },
        { type: 'multipleSelect', options: { choices } },
        { type: 'date' },
        { type: 'checkbox' },
        { type: 'rating' },
      ],
      (fields) => fields.map((fieldId) => ({ fieldId })),
    );
    const [text, multiple, date, checkbox, rating] = f.fields as [string, string, string, string, string];
    const formId = await shared(f.viewId);
    const inbox = await watch(f.databaseId);
    const form = (await definition(formId)).json<PublicForm>();
    // A person takes a moment to answer, and the ticket from the form itself works after that.
    await delay(2_100);
    const values = {
      [text]: 'Ada Lovelace',
      [multiple]: choices.map((choice) => choice.id),
      [date]: '2026-09-27',
      [checkbox]: true,
      [rating]: 4,
    };
    const response = await submit(formId, { ticket: form.ticket, values });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ thankYou: 'Thanks, friend.', allowAnother: true });

    const records = await storedRecords(f.tableId);
    expect(records).toEqual([{ id: expect.any(String), created_by: null, updated_by: null }]);
    const page = (
      await server.app.inject({ url: `/api/views/${f.gridViewId}/rows`, headers: server.owner.headers })
    ).json<RowsPage>();
    expect(page.total).toBe(1);
    expect(page.rows[0]).toMatchObject({ id: records[0]!.id, createdBy: null, values });

    await until(() =>
      inbox.some((message) => message.type === 'change' && message.change.kind === 'record.created'),
    );
    const broadcast = inbox.find(
      (message) => message.type === 'change' && message.change.kind === 'record.created',
    );
    expect(broadcast).toMatchObject({
      type: 'change',
      change: {
        kind: 'record.created',
        tableId: f.tableId,
        actorId: null,
        clientId: null,
        records: [{ id: records[0]!.id, createdBy: null, values }],
      },
    });

    expect((await linkFor(f.viewId)).json<PublicFormLink>().submissions).toBe(1);
    const events = (await formEvents(f.viewId)).filter((event) => event.action === 'data.form.submitted');
    expect(events).toEqual([
      {
        org_id: server.owner.info.org.id,
        actor_id: null,
        action: 'data.form.submitted',
        metadata: { databaseId: f.databaseId, tableId: f.tableId, viewId: f.viewId, count: 1, answered: 5 },
      },
    ]);
    // Nothing about the answers reaches the audit log, and no person's change is recorded.
    const personal = await query(
      server.pool,
      sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE action = 'data.records.created' AND metadata ->> 'tableId' = ${f.tableId}`,
    );
    expect(personal.rowCount).toBe(0);
    const changes = await query<{ actor_id: string | null }>(
      server.pool,
      sql`SELECT actor_id FROM ${ident(server.schemas.app, 'changes')}
      WHERE database_id = ${f.databaseId} AND kind = 'record.created'`,
    );
    expect(changes.rows).toEqual([{ actor_id: null }]);
  });

  it('stops answering while its view, table, or database is in the trash, and resumes on restore', async () => {
    const f = await formFixture([{ type: 'text' }], (fields) => [{ fieldId: fields[0] }]);
    const formId = await shared(f.viewId);
    const values = { [f.fields[0]!]: 'Ada' };
    for (const [trash, restore] of [
      [
        { kind: 'view.trash', viewId: f.viewId },
        { kind: 'view.restore', viewId: f.viewId },
      ],
      [
        { kind: 'table.trash', tableId: f.tableId },
        { kind: 'table.restore', tableId: f.tableId },
      ],
      [{ kind: 'database.trash' }, { kind: 'database.restore' }],
    ]) {
      await run(f.databaseId, trash!);
      for (const response of [
        await definition(formId),
        await submit(formId, { ticket: ticket(formId), values }),
      ]) {
        expect(response.statusCode, trash!.kind).toBe(404);
        expect(response.json().error).toMatchObject({
          code: 'not_found',
          messageKey: 'forms.public.notFound',
        });
      }
      await run(f.databaseId, restore!);
      expect((await definition(formId)).statusCode, restore!.kind).toBe(200);
    }
    expect(await storedRecords(f.tableId)).toEqual([]);
    const response = await submit(formId, { ticket: ticket(formId), values });
    expect(response.statusCode, response.body).toBe(200);
    expect((await linkFor(f.viewId)).json<PublicFormLink>()).toMatchObject({ formId, submissions: 1 });
  });
});
