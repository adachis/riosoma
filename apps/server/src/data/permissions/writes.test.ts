import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newId,
  type DatabaseSchema,
  type PublicForm,
  type RowData,
  type RowsPage,
  type SharedViewLink,
  type TablePermissions,
  type UndoResult,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { actorFor } from '../../automations/run.js';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { submitAnswers } from '../public-forms.js';
import { publishShare, updateShare } from '../shared-views.js';
import {
  applied,
  command,
  inject,
  leaks,
  permissionFixture,
  schemaOf,
  SALARY_SENTINELS,
  type PermissionFixture,
  type Person,
} from './permissions.test-helpers.js';

/**
 * Every write path refuses what the rules don't allow, with its own message key: a locked field,
 * a record the person can't see, a record that would fall outside their rules, and anything that
 * names a field they can't see.  Rules themselves change only through people they don't limit.
 */

let kit: TestPostgres;
let server: ServerFixture;
let f: PermissionFixture;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'permwrites');
  f = await permissionFixture(server);
}, 180_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function refused(person: Person, input: Record<string, unknown>): Promise<string> {
  const result = await command(server, person.signed, f.databaseId, input);
  expect(result.status, JSON.stringify(result)).toBe('rejected');
  return result.error?.messageKey ?? '';
}

const update = (recordId: string, values: Record<string, unknown>, tableId = f.people.tableId) => ({
  kind: 'record.update',
  tableId,
  records: [{ id: recordId, values }],
});

async function rowOf(person: Person, tableId: string, recordId: string): Promise<RowData> {
  const response = await inject(server, person.signed, 'GET', `/api/tables/${tableId}/records/${recordId}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<RowData>();
}

describe('locked fields', () => {
  it('take changes only from the people the lock names, the owner, and roles it names', async () => {
    const { editor, lead, creator, owner } = f.persons;
    expect(await refused(editor, update(f.people.records.ana, { [f.people.fields.notes]: 'x' }))).toBe(
      'data.access.fieldLocked',
    );
    for (const person of [lead, creator, owner])
      await applied(
        server,
        person.signed,
        f.databaseId,
        update(f.people.records.ana, { [f.people.fields.notes]: person.label }),
      );
    // Everyone who can see it is told it's locked, and whether it's theirs to change.
    const access = (await schemaOf(server, editor.signed, f.databaseId)).access!;
    expect(access.fields.find((field) => field.fieldId === f.people.fields.notes)).toMatchObject({
      locked: true,
      editable: false,
    });
    const leads = (await schemaOf(server, lead.signed, f.databaseId)).access!;
    expect(leads.fields.find((field) => field.fieldId === f.people.fields.notes)).toMatchObject({
      editable: true,
    });
  });

  it('refuses a merge that would change one', async () => {
    const [first, second] = [newId('record'), newId('record')];
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.create',
      tableId: f.people.tableId,
      records: [first, second].map((id) => ({
        id,
        values: {
          [f.people.fields.name]: 'Twin',
          [f.people.fields.region]: f.people.choices.west,
          [f.people.fields.notes]: id,
        },
      })),
    });
    expect(
      await refused(f.persons.editor, {
        kind: 'record.merge',
        tableId: f.people.tableId,
        recordId: first,
        mergeIds: [second],
        choices: { [f.people.fields.notes]: second },
      }),
    ).toBe('data.access.fieldLocked');
  });

  it('refuses a new file in one', async () => {
    const attachment = newId('field');
    await applied(server, server.owner, f.databaseId, {
      kind: 'field.create',
      tableId: f.people.tableId,
      field: { id: attachment, name: 'Contract', type: 'attachment', description: '', options: {} },
    });
    const lock = await inject(server, server.owner, 'PUT', `/api/fields/${attachment}/permissions`, {
      restricted: null,
      locked: { roles: [], users: [] },
    });
    expect(lock.statusCode, lock.body).toBe(200);
    const upload = await server.app.inject({
      method: 'POST',
      url: `/api/tables/${f.people.tableId}/fields/${attachment}/files`,
      headers: { ...f.persons.editor.signed.headers, 'content-type': 'text/plain', 'x-file-name': 'a.txt' },
      payload: 'hello',
    });
    expect(upload.json<{ error: { messageKey: string } }>().error.messageKey).toBe('data.access.fieldLocked');
  });
});

describe('record rules', () => {
  it('refuse changes to records the person can’t see', async () => {
    const { editor } = f.persons;
    const hidden = f.people.records.zanzibar;
    expect(await refused(editor, update(hidden, { [f.people.fields.name]: 'Mine now' }))).toBe(
      'data.access.recordHidden',
    );
    expect(
      await refused(editor, { kind: 'record.trash', tableId: f.people.tableId, recordIds: [hidden] }),
    ).toBe('data.access.recordHidden');
    expect(
      await refused(editor, {
        kind: 'record.restore',
        tableId: f.people.tableId,
        recordIds: [f.people.records.trashed],
      }),
    ).toBe('data.access.recordHidden');
    const comment = await command(server, editor.signed, f.databaseId, {
      kind: 'comment.create',
      tableId: f.people.tableId,
      recordId: hidden,
      comment: { id: newId('comment'), body: 'Hello' },
    });
    expect(comment).toMatchObject({ status: 'rejected', error: { code: 'not_found' } });
  });

  it('refuse a record, new or changed, that would fall outside the person’s rules', async () => {
    const { editor } = f.persons;
    expect(
      await refused(editor, {
        kind: 'record.create',
        tableId: f.people.tableId,
        records: [{ id: newId('record'), values: { [f.people.fields.region]: f.people.choices.east } }],
      }),
    ).toBe('data.access.recordOutsideRules');
    expect(
      await refused(
        editor,
        update(f.people.records.ana, { [f.people.fields.region]: f.people.choices.east }),
      ),
    ).toBe('data.access.recordOutsideRules');
    await applied(server, editor.signed, f.databaseId, {
      kind: 'record.create',
      tableId: f.people.tableId,
      records: [{ id: newId('record'), values: { [f.people.fields.region]: f.people.choices.west } }],
    });
  });

  it('keep links to hidden records when a person changes a link, and refuse new ones', async () => {
    const { editor, owner } = f.persons;
    const { alpha } = f.teams.records;
    const teams = f.teams.fields;
    const before = await rowOf(editor, f.teams.tableId, alpha);
    expect(before.values[teams.people]).toEqual([f.people.records.ana]);
    expect(before.hiddenLinks).toEqual({ [teams.people]: 2 });
    expect(before.values[teams.headcount]).toBe(1);
    expect(before.values[teams.names]).toEqual(['Ana West']);
    expect(before.values[teams.salaries]).toBeUndefined();
    await applied(
      server,
      editor.signed,
      f.databaseId,
      update(alpha, { [teams.people]: [] }, f.teams.tableId),
    );
    const kept = await rowOf(owner, f.teams.tableId, alpha);
    expect([...(kept.values[teams.people] as string[])].sort()).toEqual(
      [f.people.records.zanzibar, f.people.records.zulu].sort(),
    );
    // Linking a hidden record that wasn't linked already is refused.
    const beta = newId('record');
    await applied(server, owner.signed, f.databaseId, {
      kind: 'record.create',
      tableId: f.teams.tableId,
      records: [{ id: beta, values: { [teams.name]: 'Beta' } }],
    });
    expect(
      await refused(editor, update(beta, { [teams.people]: [f.people.records.zanzibar] }, f.teams.tableId)),
    ).toBe('data.access.recordHidden');
    await applied(
      server,
      owner.signed,
      f.databaseId,
      update(
        alpha,
        { [teams.people]: [f.people.records.ana, f.people.records.zanzibar, f.people.records.zulu] },
        f.teams.tableId,
      ),
    );
  });

  it('skip, in undo, what the person can no longer change', async () => {
    const { editor } = f.persons;
    const groupId = newId('action');
    const response = await inject(server, editor.signed, 'POST', `/api/databases/${f.databaseId}/commands`, {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId,
          ...update(f.people.records.ana, { [f.people.fields.name]: 'Ana Two' }),
        },
      ],
    });
    expect(response.statusCode, response.body).toBe(200);
    const lock = await inject(
      server,
      server.owner,
      'PUT',
      `/api/fields/${f.people.fields.name}/permissions`,
      {
        restricted: null,
        locked: { roles: [], users: [] },
      },
    );
    expect(lock.statusCode, lock.body).toBe(200);
    const undone = await inject(server, editor.signed, 'POST', `/api/databases/${f.databaseId}/undo`, {
      commandId: newId('command'),
      groupId,
      clientId: newId('client'),
    });
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json<UndoResult>()).toMatchObject({ skipped: 1 });
    const unlock = await inject(
      server,
      server.owner,
      'PUT',
      `/api/fields/${f.people.fields.name}/permissions`,
      {
        restricted: null,
        locked: null,
      },
    );
    expect(unlock.statusCode, unlock.body).toBe(200);
  });
});

describe('restricted fields', () => {
  it('read as missing to anyone they’re hidden from, in every schema change', async () => {
    const { creator, editor } = f.persons;
    expect(await refused(editor, update(f.people.records.ana, { [f.people.fields.salary]: 1 }))).toBe(
      'data.field.unknown',
    );
    const rename = await command(server, creator.signed, f.databaseId, {
      kind: 'field.update',
      fieldId: f.people.fields.salary,
      name: 'Pay',
    });
    expect(rename).toMatchObject({ status: 'rejected', error: { code: 'not_found' } });
    const formula = await command(server, creator.signed, f.databaseId, {
      kind: 'field.create',
      tableId: f.people.tableId,
      field: {
        id: newId('field'),
        name: 'Guess',
        type: 'formula',
        description: '',
        options: { expression: '{Salary} + 1' },
      },
    });
    expect(formula.status).toBe('rejected');
    const lookup = await command(server, creator.signed, f.databaseId, {
      kind: 'field.create',
      tableId: f.teams.tableId,
      field: {
        id: newId('field'),
        name: 'Peek',
        type: 'lookup',
        description: '',
        options: { linkFieldId: f.teams.fields.people, targetFieldId: f.people.fields.salary },
      },
    });
    expect(lookup).toMatchObject({ status: 'rejected', error: { code: 'not_found' } });
    const trash = await command(server, creator.signed, f.databaseId, {
      kind: 'field.trash',
      fieldId: f.people.fields.bonus,
    });
    expect(trash).toMatchObject({ status: 'rejected', error: { code: 'not_found' } });
  });

  it('can’t be used in a view, dashboard, or automation by someone who can’t see them', async () => {
    const { creator } = f.persons;
    expect(
      await refused(creator, {
        kind: 'view.update',
        viewId: f.people.viewId,
        config: {
          filter: {
            conjunction: 'and',
            conditions: [{ id: 'x', fieldId: f.people.fields.salary, operator: 'gt', value: 1 }],
          },
        },
      }),
    ).toBe('data.access.fieldHidden');
    // Arranging the columns they see keeps the place of the ones they don't.
    await applied(server, server.owner, f.databaseId, {
      kind: 'view.update',
      viewId: f.people.viewId,
      config: { fieldOrder: [f.people.fields.name, f.people.fields.salary, f.people.fields.notes] },
    });
    const schema = await schemaOf(server, creator.signed, f.databaseId);
    const view = schema.views.find((item) => item.id === f.people.viewId)!;
    const order = schema.fields
      .filter((field) => field.tableId === f.people.tableId)
      .map((field) => field.id);
    await applied(server, creator.signed, f.databaseId, {
      kind: 'view.update',
      viewId: view.id,
      config: { fieldOrder: [...order].reverse(), summaries: { [f.people.fields.name]: 'count' } },
    });
    const owners = await schemaOf(server, server.owner, f.databaseId);
    const saved = owners.views.find((item) => item.id === f.people.viewId)!.config;
    expect(saved.fieldOrder.indexOf(f.people.fields.salary)).toBe(1);
    expect(saved.summaries[f.people.fields.salary]).toBe('sum');
    const dashboardId = newId('dashboard');
    const tile = {
      id: 'salary-tile',
      kind: 'number',
      place: { x: 0, y: 0, w: 2, h: 2 },
      source: { tableId: f.people.tableId },
      value: { fn: 'sum', fieldId: f.people.fields.salary },
    };
    expect(
      await refused(creator, {
        kind: 'dashboard.create',
        dashboard: { id: dashboardId, name: 'Pay', config: { tiles: [tile] } },
      }),
    ).toBe('data.access.fieldHidden');
    await applied(server, server.owner, f.databaseId, {
      kind: 'dashboard.create',
      dashboard: { id: dashboardId, name: 'Pay', config: { tiles: [tile] } },
    });
    // Sending back what they were shown keeps the stored settings, and changing them is refused.
    const shown = (await schemaOf(server, creator.signed, f.databaseId)).dashboards!.find(
      (item) => item.id === dashboardId,
    )!;
    await applied(server, creator.signed, f.databaseId, {
      kind: 'dashboard.update',
      dashboardId,
      name: 'Pay, renamed',
      config: shown.config,
    });
    expect(
      await refused(creator, {
        kind: 'dashboard.update',
        dashboardId,
        config: { tiles: [] },
      }),
    ).toBe('data.access.fieldHidden');
  });

  it('never go out through a public link or a public form', async () => {
    const { owner } = f.persons;
    const shared = await inject(server, owner.signed, 'PUT', `/api/views/${f.people.viewId}/shared-view`);
    expect(shared.statusCode, shared.body).toBe(200);
    const link = shared.json<SharedViewLink>();
    const refusedShare = await inject(
      server,
      owner.signed,
      'PATCH',
      `/api/views/${f.people.viewId}/shared-view`,
      {
        fieldIds: [f.people.fields.name, f.people.fields.salary],
      },
    );
    expect(refusedShare.json<{ error: { messageKey: string } }>().error.messageKey).toBe(
      'data.access.restrictedShare',
    );
    // The view sums Salary in its summary row, so the link stops working until it doesn't.
    const blocked = await server.app.inject({ method: 'GET', url: `/api/public/views/${link.linkId}` });
    expect(blocked.statusCode).toBe(404);
    await applied(server, owner.signed, f.databaseId, {
      kind: 'view.update',
      viewId: f.people.viewId,
      config: { summaries: {} },
    });
    const open = await server.app.inject({ method: 'GET', url: `/api/public/views/${link.linkId}` });
    expect(open.statusCode, open.body).toBe(200);
    const rows = await server.app.inject({
      method: 'GET',
      url: `/api/public/views/${link.linkId}/rows?offset=0&limit=50&tz=UTC`,
    });
    expect(rows.statusCode, rows.body).toBe(200);
    expect(leaks(open.body + rows.body, SALARY_SENTINELS)).toEqual([]);
    // The link reads as the owner who shared it, so every record shows.
    expect(rows.body).toContain('Zanzibar');

    const form = await inject(server, owner.signed, 'PUT', `/api/views/${f.people.formViewId}/public-form`);
    expect(form.statusCode, form.body).toBe(200);
    const formId = form.json<{ formId: string }>().formId;
    const definition = await server.app.inject({ method: 'GET', url: `/api/public/forms/${formId}` });
    const questions = definition.json<PublicForm>().questions.map((question) => question.fieldId);
    expect(questions).toEqual([f.people.fields.name]);
    for (const values of [
      { [f.people.fields.name]: 'Walk-in', [f.people.fields.salary]: 5 },
      { [f.people.fields.name]: 'Walk-in', [f.people.fields.notes]: 'hi' },
    ])
      await expect(submitAnswers(server.ctx, formId, values)).rejects.toMatchObject({
        messageKey: 'data.form.unknownField',
      });
  });
});

describe('managing the rules', () => {
  it('is for people who can change the schema and whom the rules don’t limit', async () => {
    const { editor, limitedCreator, creator } = f.persons;
    const editors = await inject(
      server,
      editor.signed,
      'PUT',
      `/api/fields/${f.people.fields.name}/permissions`,
      {
        restricted: null,
        locked: null,
      },
    );
    expect(editors.statusCode).toBe(403);
    const limited = await inject(
      server,
      limitedCreator.signed,
      'PUT',
      `/api/tables/${f.people.tableId}/record-rules`,
      {
        rules: [],
      },
    );
    expect(limited.json<{ error: { messageKey: string } }>().error.messageKey).toBe(
      'data.access.rulesLimited',
    );
    // A field that only shows what every record carries can't be restricted.
    const createdBy = newId('field');
    await applied(server, server.owner, f.databaseId, {
      kind: 'field.create',
      tableId: f.people.tableId,
      field: { id: createdBy, name: 'Added by', type: 'createdBy', description: '', options: {} },
    });
    const detail = await inject(server, server.owner, 'PUT', `/api/fields/${createdBy}/permissions`, {
      restricted: { roles: [], users: [] },
      locked: null,
    });
    expect(detail.json<{ error: { messageKey: string } }>().error.messageKey).toBe(
      'data.access.recordDetail',
    );
    const hidden = await inject(
      server,
      creator.signed,
      'PUT',
      `/api/fields/${f.people.fields.salary}/permissions`,
      {
        restricted: null,
        locked: null,
      },
    );
    expect(hidden.statusCode).toBe(404);
    const onHidden = await inject(
      server,
      creator.signed,
      'PUT',
      `/api/tables/${f.people.tableId}/record-rules`,
      {
        rules: [
          {
            id: newId('recordRule'),
            roles: ['reader'],
            users: [],
            condition: {
              conjunction: 'and',
              conditions: [{ id: 'pay', fieldId: f.people.fields.salary, operator: 'gt', value: 1 }],
            },
          },
        ],
      },
    );
    expect(onHidden.json<{ error: { messageKey: string } }>().error.messageKey).toBe('data.field.unknown');
    // What they may read of the rules leaves out the fields they can't see.
    const read = await inject(server, creator.signed, 'GET', `/api/tables/${f.people.tableId}/permissions`);
    expect(read.statusCode, read.body).toBe(200);
    const permissions = read.json<TablePermissions>();
    expect(permissions.fields.map((field) => field.fieldId)).toContain(f.people.fields.notes);
    expect(permissions.fields.map((field) => field.fieldId)).not.toContain(f.people.fields.salary);
    expect(permissions.records).toHaveLength(2);
    expect(leaks(read.body, SALARY_SENTINELS)).toEqual([]);
  });

  it('audits every change with IDs only', async () => {
    const events = await query<{ action: string; metadata: Record<string, unknown> }>(
      server.pool,
      sql`SELECT action, metadata FROM ${ident(server.schemas.audit, 'events')}
        WHERE action LIKE 'data.permissions.%' ORDER BY id`,
    );
    expect(events.rows.map((row) => row.action)).toContain('data.permissions.fieldChanged');
    expect(events.rows.map((row) => row.action)).toContain('data.permissions.recordRulesChanged');
    const text = JSON.stringify(events.rows);
    expect(text).not.toContain('West');
    expect(text).not.toContain('Salary');
    expect(text).toContain(f.people.fields.salary);
  });

  it('keeps copies and templates from people who can’t read everything, and templates from rules', async () => {
    for (const person of [f.persons.creator, f.persons.limitedCreator]) {
      const response = await inject(
        server,
        person.signed,
        'POST',
        `/api/databases/${f.databaseId}/snapshots`,
        {
          name: 'Copy',
        },
      );
      expect(response.json<{ error: { messageKey: string } }>().error.messageKey).toBe('archives.restricted');
    }
    const template = await inject(
      server,
      server.owner,
      'POST',
      `/api/databases/${f.databaseId}/save-as-template`,
      {
        name: 'Company',
      },
    );
    expect(template.json<{ error: { messageKey: string } }>().error.messageKey).toBe(
      'data.access.templateRestricted',
    );
  });

  it('carries into a copy, so sharing the copy shares no more than the original', async () => {
    const snapshot = await inject(server, server.owner, 'POST', `/api/databases/${f.databaseId}/snapshots`, {
      name: 'Before',
    });
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    const started = await inject(
      server,
      server.owner,
      'POST',
      `/api/snapshots/${snapshot.json<{ id: string }>().id}/restore`,
      { name: 'Company copy' },
    );
    expect(started.statusCode, started.body).toBe(200);
    const copyId = started.json<{ id: string }>().id;
    await server.ctx.databaseCopies!.settled(copyId);
    const copy = await inject(server, server.owner, 'GET', `/api/database-copies/${copyId}`);
    const copied = copy.json<{ state: string; databaseId: string }>();
    expect(copied.state).toBe('finished');
    const schema = await schemaOf(server, server.owner, copied.databaseId);
    const people = schema.tables.find((table) => table.name === 'People')!;
    const salary = schema.fields.find((field) => field.tableId === people.id && field.name === 'Salary')!;
    const read = await inject(server, server.owner, 'GET', `/api/tables/${people.id}/permissions`);
    const permissions = read.json<TablePermissions>();
    expect(permissions.fields.find((field) => field.fieldId === salary.id)).toMatchObject({
      restricted: { roles: [], users: [f.persons.hr.signed.userId] },
    });
    expect(permissions.records).toHaveLength(2);
    expect(JSON.stringify(permissions.records)).not.toContain(f.people.fields.region);
  });

  it('shows placeholders, not names, for fields someone can’t see', async () => {
    const schema: DatabaseSchema = await schemaOf(server, f.persons.editor.signed, f.databaseId);
    const hidden = schema.access!.hiddenFields.map((field) => field.id);
    expect(hidden).toEqual(
      expect.arrayContaining([f.people.fields.salary, f.people.fields.bonus, f.teams.fields.payroll]),
    );
    expect(schema.fields.map((field) => field.id)).not.toContain(f.people.fields.salary);
    expect(schema.access!.limitedTables).toEqual([f.people.tableId]);
    const page = await inject(
      server,
      f.persons.editor.signed,
      'GET',
      `/api/views/${f.people.viewId}/rows?limit=50`,
    );
    const rows = page.json<RowsPage>().rows.filter((row): row is RowData => row !== null);
    expect(rows.every((row) => row.values[f.people.fields.region] === f.people.choices.west)).toBe(true);
  });
});

describe('webhooks', () => {
  it('tell each webhook only what the person who made it could see', async () => {
    const hooks: Record<string, string> = {};
    for (const person of [f.persons.creator, f.persons.limitedCreator]) {
      const response = await inject(
        server,
        person.signed,
        'POST',
        `/api/databases/${f.databaseId}/webhooks`,
        {
          url: 'https://hooks.example.test/in',
          events: ['record.updated', 'record.created', 'field.changed'],
        },
      );
      expect(response.statusCode, response.body).toBe(200);
      hooks[person.label] = response.json<{ id: string }>().id;
    }
    await applied(server, server.owner, f.databaseId, {
      kind: 'record.update',
      tableId: f.people.tableId,
      records: [
        {
          id: f.people.records.ana,
          values: { [f.people.fields.salary]: 7, [f.people.fields.name]: 'Ana West' },
        },
        { id: f.people.records.zanzibar, values: { [f.people.fields.name]: 'Zanzibar East!' } },
      ],
    });
    const events = await query<{ webhook_id: string; event: string }>(
      server.pool,
      sql`SELECT webhook_id, event FROM ${ident(server.schemas.app, 'webhook_events')}`,
    );
    const heard = (label: string) =>
      events.rows.filter((row) => row.webhook_id === hooks[label]).map((row) => row.event);
    const creators = heard(f.persons.creator.label).join(' ');
    expect(creators).toContain(f.people.records.zanzibar);
    expect(creators).not.toContain(f.people.fields.salary);
    const limited = heard(f.persons.limitedCreator.label).join(' ');
    expect(limited).not.toContain(f.people.records.zanzibar);
  });
});

describe('a view someone else made public', () => {
  const route = () => `/api/views/${f.people.viewId}/shared-view`;
  const west = () => ({
    conjunction: 'and',
    conditions: [
      { id: 'west', fieldId: f.people.fields.region, operator: 'is', value: f.people.choices.west },
    ],
  });
  const publicRows = (linkId: string) =>
    server.app.inject({ method: 'GET', url: `/api/public/views/${linkId}/rows?offset=0&limit=50&tz=UTC` });

  it('keeps its link and what it shows from changes by people a rule limits', async () => {
    const { owner, hr, limitedCreator } = f.persons;
    await applied(server, owner.signed, f.databaseId, {
      kind: 'view.update',
      viewId: f.people.viewId,
      config: { summaries: {}, filter: west() },
    });
    const shared = await inject(server, owner.signed, 'PUT', route());
    expect(shared.statusCode, shared.body).toBe(200);
    const link = shared.json<SharedViewLink>();
    const password = ['garden', 'gate', '42'].join(' ');
    const settings = await inject(server, owner.signed, 'PATCH', route(), {
      fieldIds: [f.people.fields.name],
      password,
    });
    expect(settings.statusCode, settings.body).toBe(200);

    // The link reads as its sharer, so its address and settings would show a person the rules
    // limit what the rules keep from them.
    const attempts: Array<['GET' | 'PUT' | 'PATCH', Record<string, unknown>?]> = [
      ['GET'],
      ['PUT'],
      ['PATCH', { password: null }],
      ['PATCH', { password: ['their', 'own', 'words'].join(' ') }],
      ['PATCH', { fieldIds: null, allowCopy: true }],
    ];
    for (const [method, payload] of attempts) {
      const response = await inject(server, limitedCreator.signed, method, route(), payload);
      expect(response.statusCode, `${method} ${response.body}`).toBe(403);
      expect(response.json<{ error: { messageKey: string } }>().error.messageKey).toBe(
        'data.access.linkLimited',
      );
      expect(response.body).not.toContain(link.linkId);
    }
    // Where the link may be framed is one of its settings too, wherever it's asked for or changed.
    const framing = [
      await inject(server, limitedCreator.signed, 'GET', `/api/public-sharing/view/${link.linkId}`),
      await inject(server, limitedCreator.signed, 'POST', '/api/public-sharing/commands', {
        id: newId('command'),
        action: {
          kind: 'embed',
          target: { kind: 'view', linkId: link.linkId },
          embed: { enabled: true, sites: ['https://embed.example.test'] },
        },
      }),
    ];
    for (const response of framing) {
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json<{ error: { messageKey: string } }>().error.messageKey).toBe(
        'data.access.linkLimited',
      );
    }
    for (const config of [
      { filter: null },
      { hiddenFieldIds: [f.people.fields.notes] },
      { sorts: [{ fieldId: f.people.fields.name, direction: 'asc' }] },
    ])
      expect(await refused(limitedCreator, { kind: 'view.update', viewId: f.people.viewId, config })).toBe(
        'data.access.publicLimited',
      );
    // A new name shows nothing more, so it stays theirs to give.
    await applied(server, limitedCreator.signed, f.databaseId, {
      kind: 'view.update',
      viewId: f.people.viewId,
      name: 'Everyone in the West',
    });

    const kept = await inject(server, owner.signed, 'GET', route());
    expect(kept.json<SharedViewLink>()).toMatchObject({
      linkId: link.linkId,
      hasPassword: true,
      settings: { fieldIds: [f.people.fields.name], allowCopy: false, embed: { enabled: false, sites: [] } },
    });
    expect((await publicRows(link.linkId)).statusCode).toBe(403);
    await inject(server, owner.signed, 'PATCH', route(), { password: null });
    let rows = await publicRows(link.linkId);
    expect(rows.statusCode, rows.body).toBe(200);
    expect(rows.body).toContain('Ana West');
    expect(rows.body).not.toContain('Zanzibar');

    // Someone no rule limits still changes another person's link and its view.
    const changed = await inject(server, hr.signed, 'PATCH', route(), { allowCopy: true });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json<SharedViewLink>().linkId).toBe(link.linkId);
    await applied(server, hr.signed, f.databaseId, {
      kind: 'view.update',
      viewId: f.people.viewId,
      config: { filter: null },
    });
    rows = await publicRows(link.linkId);
    expect(rows.body).toContain('Zanzibar');

    // Stopping a link only narrows, and a link they share themselves reads as they do.
    const stopped = await inject(server, limitedCreator.signed, 'DELETE', route());
    expect(stopped.statusCode, stopped.body).toBe(204);
    expect((await publicRows(link.linkId)).statusCode).toBe(404);
    const own = await inject(server, limitedCreator.signed, 'PUT', route());
    expect(own.statusCode, own.body).toBe(200);
    const theirs = own.json<SharedViewLink>();
    expect(theirs.linkId).not.toBe(link.linkId);
    expect(theirs.createdBy).toBe(limitedCreator.signed.userId);
    await applied(server, limitedCreator.signed, f.databaseId, {
      kind: 'view.update',
      viewId: f.people.viewId,
      config: { sorts: [{ fieldId: f.people.fields.name, direction: 'asc' }] },
    });
    rows = await publicRows(theirs.linkId);
    expect(rows.statusCode, rows.body).toBe(200);
    expect(rows.body).toContain('Ana West');
    expect(rows.body).not.toContain('Zanzibar');
    expect((await inject(server, owner.signed, 'DELETE', route())).statusCode).toBe(204);
  });

  it('keeps a view a published site reads from changes by people a rule limits', async () => {
    const { owner, hr, limitedCreator } = f.persons;
    const viewId = newId('view');
    const interfaceId = newId('interface');
    const slug = ['directory', newId('view').slice(-8).toLowerCase()].join('-');
    const badge = newId('field');
    const relabel = (expression: string) => ({
      kind: 'field.update',
      fieldId: badge,
      options: { expression },
    });
    await applied(server, owner.signed, f.databaseId, {
      kind: 'view.create',
      view: { id: viewId, tableId: f.people.tableId, name: 'West', type: 'grid', config: { filter: west() } },
    });
    await applied(server, owner.signed, f.databaseId, {
      kind: 'field.create',
      tableId: f.people.tableId,
      field: {
        id: badge,
        name: 'Badge',
        type: 'formula',
        description: '',
        options: { expression: '{Name}' },
      },
    });
    await applied(server, owner.signed, f.databaseId, {
      kind: 'interface.create',
      interface: {
        id: interfaceId,
        name: 'Directory',
        pages: [
          {
            id: 'page01',
            name: 'People',
            blocks: [
              {
                id: 'records01',
                kind: 'records',
                title: 'People',
                place: { x: 0, y: 0, w: 6, h: 4 },
                source: { tableId: f.people.tableId, viewId },
                fieldIds: [f.people.fields.name, badge],
              },
            ],
          },
        ],
      },
    });
    const sorts = [{ fieldId: f.people.fields.name, direction: 'asc' }];
    // Until a site reads the view and the field, they're a view and a field like any other.
    await applied(server, limitedCreator.signed, f.databaseId, {
      kind: 'view.update',
      viewId,
      config: { sorts },
    });
    await applied(server, limitedCreator.signed, f.databaseId, relabel('UPPER({Name})'));
    const published = await inject(server, owner.signed, 'PUT', `/api/interfaces/${interfaceId}/site`, {
      slug,
      title: 'Directory',
      pages: [
        {
          pageId: 'page01',
          slug: 'people',
          title: 'People',
          description: '',
          slugFieldId: f.people.fields.name,
        },
      ],
    });
    expect(published.statusCode, published.body).toBe(200);
    expect(await refused(limitedCreator, { kind: 'view.update', viewId, config: { filter: null } })).toBe(
      'data.access.publicLimited',
    );
    // A block shows what its fields hold now, so those stay as they are too.
    expect(await refused(limitedCreator, relabel('{Notes}'))).toBe('data.access.publicFieldLimited');
    let page = await server.app.inject({ method: 'GET', url: `/api/public/sites/${slug}/people` });
    expect(page.statusCode, page.body).toBe(200);
    expect(page.body).toContain('ANA WEST');
    expect(page.body).not.toContain('Ana notes');
    expect(page.body).not.toContain('Zanzibar');
    await applied(server, hr.signed, f.databaseId, { kind: 'view.update', viewId, config: { filter: null } });
    await applied(server, hr.signed, f.databaseId, relabel('{Name}'));
    page = await server.app.inject({ method: 'GET', url: `/api/public/sites/${slug}/people` });
    expect(page.body).toContain('Zanzibar');
    expect(page.body).not.toContain('ANA WEST');
  });

  it('keeps what its fields hold from changes by people a rule limits', async () => {
    const { owner, hr, limitedCreator } = f.persons;
    const { tableId, fields } = f.people;
    const viewId = newId('view');
    const [label, source, echo, copy] = [newId('field'), newId('field'), newId('field'), newId('field')];
    const create = (table: string, id: string, name: string, type: string, options: unknown = {}) => ({
      kind: 'field.create',
      tableId: table,
      field: { id, name, type, description: '', options },
    });
    const formula = (fieldId: string, expression: string) => ({
      kind: 'field.update',
      fieldId,
      options: { expression },
    });
    const optionsOf = async (fieldId: string) =>
      (await schemaOf(server, owner.signed, f.databaseId)).fields.find((item) => item.id === fieldId)
        ?.options;
    const functionId = newId('namedFunction');
    const shown = { name: 'SHOWN', parameters: ['value'], body: 'value' };
    await applied(server, owner.signed, f.databaseId, {
      kind: 'namedFunction.create',
      functionId,
      definition: shown,
    });
    // The view leaves Notes out, shows Label and Echo, and Echo repeats Source, which it also hides.
    await applied(server, owner.signed, f.databaseId, {
      kind: 'view.create',
      view: { id: viewId, tableId, name: 'Names', type: 'grid', config: { hiddenFieldIds: [fields.notes] } },
    });
    await applied(
      server,
      owner.signed,
      f.databaseId,
      create(tableId, label, 'Label', 'formula', { expression: '{Name}' }),
    );
    await applied(
      server,
      owner.signed,
      f.databaseId,
      create(tableId, source, 'Source', 'formula', { expression: 'shown({Name})' }),
    );
    await applied(
      server,
      owner.signed,
      f.databaseId,
      create(tableId, echo, 'Echo', 'formula', { expression: '{Source}' }),
    );
    await applied(server, owner.signed, f.databaseId, {
      kind: 'view.update',
      viewId,
      config: { hiddenFieldIds: [fields.notes, source] },
    });
    // Until the view is public, its fields are fields like any other.
    await applied(server, limitedCreator.signed, f.databaseId, formula(label, '{Notes}'));
    const groupId = newId('action');
    const back = await inject(
      server,
      limitedCreator.signed,
      'POST',
      `/api/databases/${f.databaseId}/commands`,
      {
        clientId: newId('client'),
        commands: [{ id: newId('command'), groupId, ...formula(label, '{Name}') }],
      },
    );
    expect(back.statusCode, back.body).toBe(200);
    const settled = await optionsOf(label);

    const shared = await inject(server, owner.signed, 'PUT', `/api/views/${viewId}/shared-view`);
    expect(shared.statusCode, shared.body).toBe(200);
    const link = shared.json<SharedViewLink>();
    const unchanged = async () => {
      const rows = await publicRows(link.linkId);
      expect(rows.statusCode, rows.body).toBe(200);
      expect(rows.body).toContain('Zanzibar');
      expect(rows.body).not.toContain('East secret');
    };
    await unchanged();

    // The link shares every field its view shows and reads them as its sharer, so a field that is
    // new, back, or worked out another way would show Notes for records the rule hides.
    for (const attempt of [
      create(tableId, copy, 'Notes copy', 'formula', { expression: '{Notes}' }),
      create(tableId, newId('field'), 'Plain', 'text'),
      { kind: 'field.duplicate', fieldId: fields.notes, newFieldId: newId('field'), name: 'Notes again' },
      formula(label, '{Notes}'),
      // Echo repeats whatever Source holds, and the view shows Echo.
      formula(source, '{Notes}'),
      // Source calls the function, so a new body changes what Echo shows as well.
      {
        kind: 'namedFunction.update',
        functionId,
        revision: 1,
        definition: { ...shown, body: 'UPPER(value)' },
      },
      { kind: 'field.convert', fieldId: fields.region, to: { type: 'text', options: {} } },
      // The primary field is shared whatever the view hides, and names the records in every link.
      { kind: 'field.setPrimary', tableId, fieldId: fields.notes },
      // A link from another table puts its other side in this one.
      create(f.teams.tableId, newId('field'), 'Members again', 'link', { linkedTableId: tableId }),
    ])
      expect(await refused(limitedCreator, attempt), JSON.stringify(attempt)).toBe(
        'data.access.publicFieldLimited',
      );
    // Undoing their own earlier change would put Notes back in Label, so it's skipped.
    const undone = await inject(
      server,
      limitedCreator.signed,
      'POST',
      `/api/databases/${f.databaseId}/undo`,
      {
        commandId: newId('command'),
        groupId,
        clientId: newId('client'),
      },
    );
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json<UndoResult>()).toMatchObject({ skipped: 1 });
    expect(await optionsOf(label)).toEqual(settled);
    // A new name tells nothing and trashing only takes away, but what comes back is shown again.
    await applied(server, limitedCreator.signed, f.databaseId, {
      kind: 'field.update',
      fieldId: label,
      name: 'Tag',
    });
    await applied(server, limitedCreator.signed, f.databaseId, { kind: 'field.trash', fieldId: label });
    expect(await refused(limitedCreator, { kind: 'field.restore', fieldId: label })).toBe(
      'data.access.publicFieldLimited',
    );
    await unchanged();

    // Someone no rule limits still adds and changes fields, and so does everyone once nobody
    // else's page reads the table.
    await applied(server, hr.signed, f.databaseId, { kind: 'field.restore', fieldId: label });
    await applied(server, hr.signed, f.databaseId, formula(source, 'UPPER({Name})'));
    expect((await publicRows(link.linkId)).body).toContain('ZANZIBAR EAST');
    expect(
      (await inject(server, owner.signed, 'DELETE', `/api/views/${viewId}/shared-view`)).statusCode,
    ).toBe(204);
    await applied(
      server,
      limitedCreator.signed,
      f.databaseId,
      create(tableId, copy, 'Notes copy', 'formula', { expression: '{Notes}' }),
    );
    await applied(server, limitedCreator.signed, f.databaseId, { kind: 'field.trash', fieldId: copy });
  });

  it('asks who shared a link of the row it holds locked, so one shared a moment ago is no opening', async () => {
    const { owner, limitedCreator } = f.persons;
    const viewId = newId('view');
    await applied(server, owner.signed, f.databaseId, {
      kind: 'view.create',
      view: { id: viewId, tableId: f.people.tableId, name: 'Just shared', type: 'grid', config: {} },
    });
    const route = `/api/views/${viewId}/shared-view`;
    const shared = await inject(server, owner.signed, 'PUT', route);
    expect(shared.statusCode, shared.body).toBe(200);
    const password = ['harbor', 'light', '17'].join(' ');
    expect((await inject(server, owner.signed, 'PATCH', route, { password })).statusCode).toBe(200);
    // What the routes go on to do when their own look, taken before the lock, found no link yet.
    const actor = (await actorFor(
      server.pool,
      server.schemas,
      limitedCreator.signed.userId,
      server.owner.info.org.id,
    ))!;
    const target = { databaseId: f.databaseId, tableId: f.people.tableId, viewId };
    const late: Array<(db: Queryable) => Promise<unknown>> = [
      (db) => publishShare(db, server.schemas, actor, target, true),
      (db) => updateShare(db, server.schemas, actor, target, { passwordHash: null }, [], true),
    ];
    for (const attempt of late)
      await expect(withTransaction(server.pool, attempt)).rejects.toMatchObject({
        messageKey: 'data.access.linkLimited',
      });
    const kept = await inject(server, owner.signed, 'GET', route);
    expect(kept.json<SharedViewLink>()).toMatchObject({
      linkId: shared.json<SharedViewLink>().linkId,
      hasPassword: true,
      createdBy: owner.signed.userId,
    });
    expect((await inject(server, owner.signed, 'DELETE', route)).statusCode).toBe(204);
  });
});
