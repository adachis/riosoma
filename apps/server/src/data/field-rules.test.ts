import { writeArchive } from './archives/write.js';
import { Restore } from './archives/restore.js';
import { AccessScope } from './access.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Command, newId, type ErrorBody, type PublicFormLink, type TokenCreated } from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { applied, command, inject, schemaOf, tokenFor } from './permissions/permissions.test-helpers.js';
import { issueTicket } from './public-forms.js';
import { grant } from '../automations/automations.test-helpers.js';
import { actorFor } from '../automations/run.js';
import { applyCommands, finishPlan, propose, validate } from '../ai/plans.js';

let kit: TestPostgres;
let server: ServerFixture;
let editor: SignedIn;
let token: TokenCreated;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'fieldrules', { automationsPollMs: 0 });
  editor = await server.addMember({ name: 'Editor' });
  token = await tokenFor(server, editor);
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function fixture(options: Record<string, unknown> = {}) {
  const databaseId = newId('database');
  const tableId = newId('table');
  const fieldId = newId('field');
  const viewId = newId('view');
  const response = await inject(server, server.owner, 'POST', '/api/databases', {
    id: databaseId,
    name: 'Rules',
    table: {
      id: tableId,
      name: 'Entries',
      fields: [{ id: fieldId, name: 'Name', type: 'text', options }],
      view: { id: viewId, name: 'Grid' },
      records: [],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  await grant(server, databaseId, editor, 'editor');
  const run = (input: Record<string, unknown>, who = server.owner) => command(server, who, databaseId, input);
  const add = (value: unknown, who = server.owner) => {
    const id = newId('record');
    return {
      id,
      result: run({ kind: 'record.create', tableId, records: [{ id, values: { [fieldId]: value } }] }, who),
    };
  };
  return { databaseId, tableId, fieldId, viewId, run, add };
}

describe('field rules across writes', () => {
  it('refuses missing required values and invalid edits with record and field details', async () => {
    const f = await fixture({
      validation: { required: {}, minLength: { value: 3, message: 'Use at least three characters' } },
    });
    const missing = await f.run({
      kind: 'record.create',
      tableId: f.tableId,
      records: [{ id: newId('record'), values: {} }],
    });
    expect(missing).toMatchObject({
      status: 'rejected',
      error: { fields: { [f.fieldId]: 'data.validation.required' } },
    });
    const added = f.add('Valid');
    expect(await added.result).toMatchObject({ status: 'applied' });
    const edit = await f.run({
      kind: 'record.update',
      tableId: f.tableId,
      records: [{ id: added.id, values: { [f.fieldId]: 'No' } }],
    });
    expect(edit).toMatchObject({
      status: 'rejected',
      error: {
        issues: [{ recordId: added.id, fieldId: f.fieldId, message: 'Use at least three characters' }],
      },
    });
  });

  it('returns 422 and field errors through both record APIs', async () => {
    const f = await fixture({ validation: { minLength: { value: 4 } } });
    for (const url of [`/api/v1/tables/${f.tableId}/records`, `/v0/${f.databaseId}/${f.tableId}`]) {
      const response = await server.app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${token.token}` },
        payload: { records: [{ fields: { Name: 'No' } }] },
      });
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json<ErrorBody>().error.fields).toEqual({ [f.fieldId]: 'data.validation.minLength' });
    }
  });

  it('checks signed-in and public form submissions', async () => {
    const f = await fixture({ validation: { pattern: { kind: 'preset', preset: 'digits' } } });
    const formId = newId('view');
    await applied(server, server.owner, f.databaseId, {
      kind: 'view.create',
      view: {
        id: formId,
        tableId: f.tableId,
        name: 'Form',
        type: 'form',
        config: { form: { questions: [{ fieldId: f.fieldId }] } },
      },
    });
    expect(
      await f.run({
        kind: 'record.create',
        tableId: f.tableId,
        formViewId: formId,
        records: [{ id: newId('record'), values: { [f.fieldId]: 'letters' } }],
      }),
    ).toMatchObject({ status: 'rejected', error: { fields: { [f.fieldId]: 'data.validation.pattern' } } });
    const shared = await inject(server, server.owner, 'PUT', `/api/views/${formId}/public-form`);
    expect(shared.statusCode, shared.body).toBe(200);
    const link = shared.json<PublicFormLink>();
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/public/forms/${link.formId}/submissions`,
      payload: {
        ticket: issueTicket(server.config.secretKey, link.formId, Date.now() - 3000),
        values: { [f.fieldId]: 'letters' },
      },
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json<ErrorBody>().error.fields).toEqual({ [f.fieldId]: 'data.validation.pattern' });
  });

  it.each(['omitted', 'locked', 'restricted', 'unsupported'] as const)(
    'keeps validation details out of public form refusals when the field is %s',
    async (kind) => {
      const f = await fixture({ validation: { minLength: { value: 3 } } });
      const privateFieldId = newId('field');
      const privateMessage = 'Internal review reference 739251';
      await applied(server, server.owner, f.databaseId, {
        kind: 'field.create',
        tableId: f.tableId,
        field: {
          id: privateFieldId,
          name: 'Internal review',
          type: kind === 'unsupported' ? 'user' : 'text',
          options: { validation: { required: { message: privateMessage } } },
        },
      });
      if (kind === 'locked' || kind === 'restricted') {
        const response = await inject(
          server,
          server.owner,
          'PUT',
          `/api/fields/${privateFieldId}/permissions`,
          {
            locked: kind === 'locked' ? { roles: ['creator'], users: [] } : null,
            restricted: kind === 'restricted' ? { roles: ['creator'], users: [] } : null,
          },
        );
        expect(response.statusCode, response.body).toBe(200);
      }
      const formId = newId('view');
      await applied(server, server.owner, f.databaseId, {
        kind: 'view.create',
        view: {
          id: formId,
          tableId: f.tableId,
          name: 'Public questions',
          type: 'form',
          config: {
            form: {
              questions: [
                { fieldId: f.fieldId },
                ...(kind === 'omitted' ? [] : [{ fieldId: privateFieldId }]),
              ],
            },
          },
        },
      });
      const shared = await inject(server, server.owner, 'PUT', `/api/views/${formId}/public-form`);
      expect(shared.statusCode, shared.body).toBe(200);
      const link = shared.json<PublicFormLink>();
      const definition = await server.app.inject({ method: 'GET', url: `/api/public/forms/${link.formId}` });
      expect(definition.statusCode, definition.body).toBe(200);
      expect(definition.body).not.toContain(privateFieldId);
      expect(definition.body).not.toContain(privateMessage);
      for (const value of ['Valid answer', 'No']) {
        const response = await server.app.inject({
          method: 'POST',
          url: `/api/public/forms/${link.formId}/submissions`,
          payload: {
            ticket: issueTicket(server.config.secretKey, link.formId, Date.now() - 3000),
            values: { [f.fieldId]: value },
          },
        });
        expect(response.statusCode, response.body).toBe(422);
        expect(response.json<ErrorBody>().error).toMatchObject({ messageKey: 'data.validation.failed' });
        expect(response.body).not.toContain(privateFieldId);
        expect(response.body).not.toContain(privateMessage);
        expect(response.json<ErrorBody>().error.fields).toBeUndefined();
        expect(response.json<ErrorBody>().error.issues).toBeUndefined();
      }
      const rows = await query(server.pool, sql`SELECT __id FROM ${ident(server.schemas.data, f.tableId)}`);
      expect(rows.rowCount).toBe(0);
    },
  );

  it('checks proposed changes and their application', async () => {
    const f = await fixture({ validation: { maxLength: { value: 3 } } });
    const actor = await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id);
    const changes = [
      Command.parse({
        id: newId('command'),
        groupId: newId('action'),
        kind: 'record.create',
        tableId: f.tableId,
        records: [{ id: newId('record'), values: { [f.fieldId]: 'Too long' } }],
      }),
    ];
    await expect(
      withTransaction(server.pool, (db) =>
        validate({ db, schemas: server.schemas, actor: actor!, databaseId: f.databaseId }, changes),
      ),
    ).rejects.toMatchObject({ messageKey: 'data.validation.failed' });
    await expect(
      withTransaction(server.pool, (db) => applyCommands(server.app, actor!, db, f.databaseId, changes)),
    ).rejects.toMatchObject({ messageKey: 'data.validation.failed' });
  });
});

describe('unique columns', () => {
  it('previews unique rules without retaining an index and prepares approved plans before applying', async () => {
    const f = await fixture();
    await f.add('First').result;
    const actor = await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id);
    const conversation = await inject(server, server.owner, 'POST', '/api/rio/conversations');
    expect(conversation.statusCode, conversation.body).toBe(200);
    const block = await propose(
      server.app,
      actor!,
      conversation.json<{ id: string }>().id,
      {
        databaseId: f.databaseId,
        summary: 'Require unique names',
        steps: ['Require a distinct name for each record'],
        commands: [{ kind: 'field.update', fieldId: f.fieldId, options: { unique: true } }],
      },
      'ask',
      'ask',
    );
    expect(block.kind).toBe('plan');
    if (block.kind !== 'plan') throw new Error('Expected a pending plan');
    const duplicates = f.add('First');
    expect(await duplicates.result).toMatchObject({ status: 'applied' });
    await f.run({ kind: 'record.trash', tableId: f.tableId, recordIds: [duplicates.id] });
    expect(await finishPlan(server.app, actor!, block.planId, false)).toMatchObject({ kind: 'receipt' });
    expect(await f.add('First').result).toMatchObject({ status: 'rejected' });
  });

  it('allows repeated empty values and rejects concurrent inserts', async () => {
    const f = await fixture({ unique: true, uniqueCaseInsensitive: true });
    expect(await f.add('').result).toMatchObject({ status: 'applied' });
    expect(await f.add(null).result).toMatchObject({ status: 'applied' });
    const results = await Promise.all(['Same', 'same'].map((value) => f.add(value).result));
    expect(results.map((result) => result.status).sort()).toEqual(['applied', 'rejected']);
    expect(results.find((result) => result.status === 'rejected')?.error).toMatchObject({
      code: 'validation_failed',
      fields: { [f.fieldId]: 'data.validation.unique' },
    });
    const indexes = await query<{ indisunique: boolean }>(
      server.pool,
      sql`SELECT i.indisunique FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = ${server.schemas.data} AND t.relname = ${f.tableId}`,
    );
    expect(indexes.rows.filter((row) => row.indisunique).length).toBeGreaterThanOrEqual(3);
  });

  it('lists duplicates, leaves the rule off, and builds an existing column concurrently after deduplication', async () => {
    const f = await fixture();
    const first = f.add('Same');
    const second = f.add('same');
    await Promise.all([first.result, second.result]);
    const refused = await f.run({
      kind: 'field.update',
      fieldId: f.fieldId,
      options: { unique: true, uniqueCaseInsensitive: true },
    });
    expect(refused).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.validation.duplicates' },
    });
    expect(String(refused.error?.params?.duplicates)).toContain(first.id);
    expect(String(refused.error?.params?.dedupe)).toContain(f.tableId);
    await f.run({ kind: 'record.trash', tableId: f.tableId, recordIds: [second.id] });
    expect(
      await f.run({
        kind: 'field.update',
        fieldId: f.fieldId,
        options: { unique: true, uniqueCaseInsensitive: true },
      }),
    ).toMatchObject({ status: 'applied' });
    expect(await f.add('SAME').result).toMatchObject({ status: 'rejected' });
    expect(await f.run({ kind: 'record.restore', tableId: f.tableId, recordIds: [second.id] })).toMatchObject(
      { status: 'rejected', error: { messageKey: 'data.validation.unique' } },
    );
  });
});

describe('record and view locks', () => {
  it('refuses locked edits and trash through the API, while allowing the configured roles', async () => {
    const f = await fixture();
    const row = f.add('Approved');
    await row.result;
    expect(
      await f.run(
        { kind: 'record.setLock', tableId: f.tableId, recordIds: [row.id], locked: true, reason: 'Reviewed' },
        editor,
      ),
    ).toMatchObject({ status: 'applied' });
    const response = await server.app.inject({
      method: 'PATCH',
      url: `/api/v1/tables/${f.tableId}/records`,
      headers: { authorization: `Bearer ${token.token}` },
      payload: { records: [{ id: row.id, fields: { Name: 'Changed' } }] },
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json<ErrorBody>().error.messageKey).toBe('data.locks.recordLocked');
    expect(
      await f.run({ kind: 'record.trash', tableId: f.tableId, recordIds: [row.id] }, editor),
    ).toMatchObject({ status: 'rejected' });
    const read = await inject(server, editor, 'GET', `/api/tables/${f.tableId}/records/${row.id}`);
    expect(read.json()).toMatchObject({ lock: { manual: true, reason: 'Reviewed', canEdit: false } });
    expect(
      await f.run({
        kind: 'record.update',
        tableId: f.tableId,
        records: [{ id: row.id, values: { [f.fieldId]: 'Owner edit' } }],
      }),
    ).toMatchObject({ status: 'applied' });
    expect(
      await f.run({ kind: 'record.setLock', tableId: f.tableId, recordIds: [row.id], locked: false }),
    ).toMatchObject({ status: 'applied' });
  });

  it('evaluates conditions against the old record and supports nobody as the exception policy', async () => {
    const f = await fixture();
    const row = f.add('Draft');
    await row.result;
    expect(
      await f.run({
        kind: 'table.update',
        tableId: f.tableId,
        recordLock: {
          bypass: 'nobody',
          reason: 'Final',
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'approved', fieldId: f.fieldId, operator: 'is', value: 'Approved' }],
          },
        },
      }),
    ).toMatchObject({ status: 'applied' });
    const update = (value: string) =>
      f.run({
        kind: 'record.update',
        tableId: f.tableId,
        records: [{ id: row.id, values: { [f.fieldId]: value } }],
      });
    expect(await update('Approved')).toMatchObject({ status: 'applied' });
    expect(await update('Draft')).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.locks.recordLocked' },
    });
  });

  it('refuses an entire restore when an inverse record is locked, including undo of trash', async () => {
    const f = await fixture();
    const linkId = newId('field');
    await applied(server, server.owner, f.databaseId, {
      kind: 'field.create',
      tableId: f.tableId,
      field: { id: linkId, name: 'Related', type: 'link', options: { linkedTableId: f.tableId } },
    });
    const schema = await schemaOf(server, server.owner, f.databaseId);
    const link = schema.fields.find((field) => field.id === linkId)!;
    if (link.type !== 'link') throw new Error('Expected a link field');
    const inverseId = link.options.inverseFieldId!;
    const target = f.add('Target');
    expect(await target.result).toMatchObject({ status: 'applied' });
    const sourceId = newId('record');
    const unlinked = f.add('Unlinked');
    expect(await unlinked.result).toMatchObject({ status: 'applied' });
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.create',
      tableId: f.tableId,
      records: [{ id: sourceId, values: { [f.fieldId]: 'Source', [linkId]: [target.id] } }],
    });
    const groupId = newId('action');
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.trash',
      tableId: f.tableId,
      recordIds: [sourceId, unlinked.id],
      groupId,
    });
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.setLock',
      tableId: f.tableId,
      recordIds: [target.id],
      locked: true,
      reason: 'Reviewed',
    });
    await applied(server, server.owner, f.databaseId, {
      kind: 'table.update',
      tableId: f.tableId,
      recordLock: { bypass: 'nobody', condition: null, reason: '' },
    });
    const readTarget = () =>
      inject(server, server.owner, 'GET', `/api/tables/${f.tableId}/records/${target.id}`);
    expect((await readTarget()).json()).toMatchObject({ values: { [inverseId]: [] } });
    const restore = await f.run({
      kind: 'record.restore',
      tableId: f.tableId,
      recordIds: [unlinked.id, sourceId],
    });
    expect(restore).toMatchObject({ status: 'rejected', error: { messageKey: 'data.locks.recordLocked' } });
    const undo = await inject(server, server.owner, 'POST', `/api/databases/${f.databaseId}/undo`, {
      groupId,
      commandId: newId('command'),
      clientId: newId('client'),
    });
    expect(undo.json()).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.locks.recordLocked' },
    });
    for (const recordId of [sourceId, unlinked.id]) {
      const read = await inject(server, server.owner, 'GET', `/api/tables/${f.tableId}/records/${recordId}`);
      expect(read.statusCode, read.body).toBe(404);
    }
    expect((await readTarget()).json()).toMatchObject({ values: { [inverseId]: [] } });
    await applied(server, server.owner, f.databaseId, {
      kind: 'table.update',
      tableId: f.tableId,
      recordLock: { bypass: 'owners', condition: null, reason: '' },
    });
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.restore',
      tableId: f.tableId,
      recordIds: [sourceId, unlinked.id],
    });
    expect((await readTarget()).json()).toMatchObject({ values: { [inverseId]: [sourceId] } });
  });

  it('restores all view settings through repeated undo and redo of a combined lock change', async () => {
    const f = await fixture();
    await applied(server, server.owner, f.databaseId, { kind: 'view.move', viewId: f.viewId, position: 7 });
    const readView = async () =>
      (await schemaOf(server, server.owner, f.databaseId)).views.find((view) => view.id === f.viewId)!;
    const before = await readView();
    const groupId = newId('action');
    await applied(server, server.owner, f.databaseId, {
      kind: 'view.update',
      viewId: f.viewId,
      groupId,
      name: 'Reviewed grid',
      config: { rowHeight: 'tall', locked: true },
    });
    const after = await readView();
    for (let cycle = 0; cycle < 2; cycle += 1) {
      for (const [direction, expected] of [
        ['undo', before],
        ['redo', after],
      ] as const) {
        const response = await inject(
          server,
          server.owner,
          'POST',
          `/api/databases/${f.databaseId}/${direction}`,
          {
            groupId,
            commandId: newId('command'),
            clientId: newId('client'),
          },
        );
        expect(response.json()).toMatchObject({ status: 'applied', skipped: 0 });
        expect(await readView()).toEqual({ ...expected, updatedAt: expect.any(String) });
      }
    }
  });

  it('rolls back the view unlock when restoring its other settings fails', async () => {
    const f = await fixture();
    const groupId = newId('action');
    await applied(server, server.owner, f.databaseId, {
      kind: 'view.update',
      viewId: f.viewId,
      groupId,
      name: 'Reviewed grid',
      config: { rowHeight: 'tall', locked: true },
    });
    await applied(server, server.owner, f.databaseId, {
      kind: 'view.create',
      view: { id: newId('view'), tableId: f.tableId, name: 'Grid', type: 'grid' },
    });
    const before = await schemaOf(server, server.owner, f.databaseId);
    const response = await inject(server, server.owner, 'POST', `/api/databases/${f.databaseId}/undo`, {
      groupId,
      commandId: newId('command'),
      clientId: newId('client'),
    });
    expect(response.json()).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'data.view.nameTaken' },
    });
    expect((await schemaOf(server, server.owner, f.databaseId)).views).toEqual(before.views);
  });

  it('requires a separate unlock before any view configuration change and audits locks', async () => {
    const f = await fixture();
    expect(
      await f.run({ kind: 'view.update', viewId: f.viewId, config: { locked: true } }, editor),
    ).toMatchObject({ status: 'rejected' });
    expect(await f.run({ kind: 'view.update', viewId: f.viewId, config: { locked: true } })).toMatchObject({
      status: 'applied',
    });
    for (const config of [{ rowHeight: 'tall' }, { locked: false, rowHeight: 'tall' }])
      expect(await f.run({ kind: 'view.update', viewId: f.viewId, config })).toMatchObject({
        status: 'rejected',
        error: { messageKey: 'data.locks.viewLocked' },
      });
    expect(await f.run({ kind: 'view.update', viewId: f.viewId, config: { locked: false } })).toMatchObject({
      status: 'applied',
    });
    const events = await query(
      server.pool,
      sql`SELECT action FROM ${ident(server.schemas.audit, 'events')} WHERE metadata ->> 'viewId' = ${f.viewId} AND action = 'data.view.updated'`,
    );
    expect(events.rowCount).toBe(2);
  });
});

it('previews refused paste cells without keeping values or audit entries', async () => {
  const f = await fixture({ unique: true });
  const groupId = newId('action');
  const records = ['Same', 'Same'].map((value) => ({ id: newId('record'), values: { [f.fieldId]: value } }));
  const result = await inject(
    server,
    server.owner,
    'POST',
    `/api/databases/${f.databaseId}/commands/preview`,
    {
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId, kind: 'record.create', tableId: f.tableId, records }],
    },
  );
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json()).toMatchObject({
    issues: [{ recordId: records[1]!.id, fieldId: f.fieldId, messageKey: 'data.validation.unique' }],
  });
  const rows = await query(server.pool, sql`SELECT __id FROM ${ident(server.schemas.data, f.tableId)}`);
  expect(rows.rowCount).toBe(0);
  const changes = await query(
    server.pool,
    sql`SELECT seq FROM ${ident(server.schemas.app, 'changes')} WHERE group_id = ${groupId}`,
  );
  expect(changes.rowCount).toBe(0);
});

it('rebuilds a unique index on undo and undoes a manual lock', async () => {
  const f = await fixture({ unique: true });
  const row = f.add('Same');
  await row.result;
  const groupId = newId('action');
  expect(
    await f.run({ kind: 'field.update', fieldId: f.fieldId, options: { unique: false }, groupId }),
  ).toMatchObject({ status: 'applied' });
  const undo = await inject(server, server.owner, 'POST', `/api/databases/${f.databaseId}/undo`, {
    groupId,
    commandId: newId('command'),
    clientId: newId('client'),
  });
  expect(undo.json()).toMatchObject({ status: 'applied' });
  expect(await f.add('Same').result).toMatchObject({
    status: 'rejected',
    error: { messageKey: 'data.validation.unique' },
  });
  const lockGroup = newId('action');
  expect(
    await f.run({
      kind: 'record.setLock',
      tableId: f.tableId,
      recordIds: [row.id],
      locked: true,
      reason: 'Reviewed',
      groupId: lockGroup,
    }),
  ).toMatchObject({ status: 'applied' });
  const unlock = await inject(server, server.owner, 'POST', `/api/databases/${f.databaseId}/undo`, {
    groupId: lockGroup,
    commandId: newId('command'),
    clientId: newId('client'),
  });
  expect(unlock.json()).toMatchObject({ status: 'applied' });
  expect(
    await f.run(
      {
        kind: 'record.update',
        tableId: f.tableId,
        records: [{ id: row.id, values: { [f.fieldId]: 'Changed' } }],
      },
      editor,
    ),
  ).toMatchObject({ status: 'applied' });
});

it('preserves record locks and unique indexes in a database copy', async () => {
  const f = await fixture({ unique: true });
  const row = f.add('Approved');
  await row.result;
  await f.run({
    kind: 'record.setLock',
    tableId: f.tableId,
    recordIds: [row.id],
    locked: true,
    reason: 'Reviewed',
  });
  await f.run({
    kind: 'table.update',
    tableId: f.tableId,
    recordLock: { bypass: 'nobody', condition: null, reason: '' },
  });
  const actor = await actorFor(server.pool, server.schemas, server.owner.userId, server.owner.info.org.id);
  const archive = await withTransaction(server.pool, async (db) => {
    await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
    const scope = new AccessScope(db, server.schemas, actor!);
    await scope.require(f.databaseId, 'read');
    return writeArchive(db, server.schemas, f.databaseId, { records: 'all', comments: true }, scope);
  });
  expect(archive.tables[0]).toMatchObject({
    recordLock: { bypass: 'nobody' },
    records: [{ lockReason: 'Reviewed' }],
  });
  const databaseId = newId('database');
  await new Restore(server.app.ctx, actor!, { archive, databaseId, name: 'Copied rules' }).run();
  const tables = await query<{ id: string }>(
    server.pool,
    sql`SELECT id FROM ${ident(server.schemas.app, 'tables')} WHERE database_id = ${databaseId}`,
  );
  const locks = await query<{ record_id: string }>(
    server.pool,
    sql`SELECT record_id FROM ${ident(server.schemas.app, 'record_locks')} WHERE database_id = ${databaseId}`,
  );
  expect(locks.rowCount).toBe(1);
  expect(
    await command(server, server.owner, databaseId, {
      kind: 'record.trash',
      tableId: tables.rows[0]!.id,
      recordIds: [locks.rows[0]!.record_id],
    }),
  ).toMatchObject({ status: 'rejected', error: { messageKey: 'data.locks.recordLocked' } });
});

it('reports an unsupported pattern with a plain message key', async () => {
  const f = await fixture();
  expect(
    await f.run({
      kind: 'field.update',
      fieldId: f.fieldId,
      options: { validation: { pattern: { kind: 'custom', pattern: '(a+)+' } } },
    }),
  ).toMatchObject({ status: 'rejected', error: { messageKey: 'data.validation.patternSyntax' } });
});

it.each(['undo', 'redo'] as const)(
  'skips a cell refused by current validation during %s and reverses the other cells',
  async (direction) => {
    const f = await fixture();
    const otherField = newId('field');
    await applied(server, server.owner, f.databaseId, {
      kind: 'field.create',
      tableId: f.tableId,
      field: { id: otherField, name: 'Notes', type: 'text', options: {} },
    });
    const before = direction === 'undo' ? 'No' : 'Valid';
    const after = direction === 'undo' ? 'Valid' : 'No';
    const row = f.add(before);
    await row.result;
    const groupId = newId('action');
    await applied(server, editor, f.databaseId, {
      kind: 'record.update',
      tableId: f.tableId,
      groupId,
      records: [{ id: row.id, values: { [f.fieldId]: after, [otherField]: 'Changed' } }],
    });
    const reverse = async (way: 'undo' | 'redo') => {
      const response = await inject(server, editor, 'POST', `/api/databases/${f.databaseId}/${way}`, {
        groupId,
        commandId: newId('command'),
        clientId: newId('client'),
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    };
    if (direction === 'redo') expect(await reverse('undo')).toMatchObject({ status: 'applied' });
    await applied(server, server.owner, f.databaseId, {
      kind: 'field.update',
      fieldId: f.fieldId,
      options: { validation: { minLength: { value: 3 } } },
    });
    expect(await reverse(direction)).toMatchObject({ status: 'applied', skipped: 1 });
    const current = await inject(server, editor, 'GET', `/api/tables/${f.tableId}/records/${row.id}`);
    expect(current.json()).toMatchObject({
      values: { [f.fieldId]: 'Valid', [otherField]: direction === 'undo' ? null : 'Changed' },
    });
    expect(await reverse(direction === 'undo' ? 'redo' : 'undo')).toMatchObject({ status: 'applied' });
    const again = await inject(server, editor, 'GET', `/api/tables/${f.tableId}/records/${row.id}`);
    expect(again.json()).toMatchObject({ values: { [f.fieldId]: 'Valid' } });
  },
);

it.each(['undo', 'redo'] as const)(
  'skips locked records during %s while preserving history for editable records',
  async (direction) => {
    const f = await fixture();
    const locked = f.add('Before');
    const editable = f.add('Before');
    await Promise.all([locked.result, editable.result]);
    const groupId = newId('action');
    await applied(server, editor, f.databaseId, {
      kind: 'record.update',
      tableId: f.tableId,
      groupId,
      records: [locked, editable].map(({ id }) => ({ id, values: { [f.fieldId]: 'After' } })),
    });
    const reverse = async (way: 'undo' | 'redo') => {
      const response = await inject(server, editor, 'POST', `/api/databases/${f.databaseId}/${way}`, {
        groupId,
        commandId: newId('command'),
        clientId: newId('client'),
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    };
    if (direction === 'redo') expect(await reverse('undo')).toMatchObject({ status: 'applied' });
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.setLock',
      tableId: f.tableId,
      recordIds: [locked.id],
      locked: true,
      reason: 'Reviewed',
    });
    expect(await reverse(direction)).toMatchObject({ status: 'applied', skipped: 1 });
    for (const item of [locked, editable]) {
      const response = await inject(server, editor, 'GET', `/api/tables/${f.tableId}/records/${item.id}`);
      expect(response.json()).toMatchObject({
        values: {
          [f.fieldId]: (item === locked) === (direction === 'undo') ? 'After' : 'Before',
        },
      });
    }
    expect(await reverse(direction === 'undo' ? 'redo' : 'undo')).toMatchObject({ status: 'applied' });
  },
);

it('keeps a locked first table when undo would remove its database', async () => {
  const f = await fixture();
  const created = await query<{ group_id: string }>(
    server.pool,
    sql`SELECT group_id FROM ${ident(server.schemas.app, 'changes')}
      WHERE database_id = ${f.databaseId} AND kind = 'database.created'`,
  );
  const row = f.add('Reviewed');
  expect(await row.result).toMatchObject({ status: 'applied' });
  await applied(server, server.owner, f.databaseId, {
    kind: 'table.update',
    tableId: f.tableId,
    recordLock: { bypass: 'nobody' },
  });
  await applied(server, server.owner, f.databaseId, {
    kind: 'record.setLock',
    tableId: f.tableId,
    recordIds: [row.id],
    locked: true,
    reason: 'Reviewed',
  });
  const response = await inject(server, server.owner, 'POST', `/api/databases/${f.databaseId}/undo`, {
    groupId: created.rows[0]!.group_id,
    commandId: newId('command'),
    clientId: newId('client'),
    confirmedMajorCreation: true,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({
    status: 'rejected',
    error: { messageKey: 'data.locks.recordLocked' },
  });
  const current = await inject(server, server.owner, 'GET', `/api/tables/${f.tableId}/records/${row.id}`);
  expect(current.statusCode, current.body).toBe(200);
  expect(current.json()).toMatchObject({ values: { [f.fieldId]: 'Reviewed' } });
});
