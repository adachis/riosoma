import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Command,
  newId,
  sourceChoiceId,
  type LinkChoicesPage,
  type RowData,
  type TokenCreated,
} from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import {
  apply,
  automate,
  createBase,
  createRecords,
  send,
  testRun,
} from '../automations/automations.test-helpers.js';
import { actorFor } from '../automations/run.js';
import { applyCommands, validate } from '../ai/plans.js';
import * as physicalRecords from './physical/records.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'linkchoices', { automationsPollMs: 0 });
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function setup(mode: 'view' | 'filter') {
  const base = await createBase(server);
  const [allowed, denied] = await createRecords(server, base.databaseId, base.tasks, [
    {
      [base.f.name]: 'Allowed',
      [base.f.status]: base.done,
      [base.f.count]: 3,
      [base.f.note]: 'Searchable details',
    },
    { [base.f.name]: 'Denied', [base.f.status]: base.todo, [base.f.count]: 4 },
  ]);
  const [recordId] = await createRecords(server, base.databaseId, base.log, [{ [base.f.logCount]: 3 }]);
  const options = {
    linkedTableId: base.tasks,
    displayFieldIds: [base.f.count, base.f.status, base.f.note],
    ...(mode === 'view'
      ? { limitToViewId: base.doneView }
      : {
          filter: {
            conjunction: 'and',
            conditions: [
              { id: 'same', fieldId: base.f.count, operator: 'eq', currentFieldId: base.f.logCount },
            ],
          },
        }),
  };
  await apply(server, base.databaseId, [{ kind: 'field.update', fieldId: base.f.logTask, options }]);
  const read = async () => {
    const result = await server.app.inject({
      url: `/api/tables/${base.log}/records/${recordId}`,
      headers: server.owner.headers,
    });
    expect(result.statusCode, result.body).toBe(200);
    return result.json<RowData>();
  };
  const choices = async (input: Record<string, unknown> = {}) => {
    const result = await server.app.inject({
      method: 'POST',
      url: `/api/fields/${base.f.logTask}/link-options`,
      headers: server.owner.headers,
      payload: { recordId, ...input },
    });
    expect(result.statusCode, result.body).toBe(200);
    return result.json<LinkChoicesPage>();
  };
  return { ...base, allowed: allowed!, denied: denied!, recordId: recordId!, options, read, choices };
}

for (const mode of ['view', 'filter'] as const)
  describe(`${mode} link limits`, () => {
    for (const side of ['source', 'target'] as const)
      it(`refuses restoring prohibited links from the ${side} and preserves the trashed record`, async () => {
        const f = await setup(mode);
        await apply(server, f.databaseId, [
          {
            kind: 'field.update',
            fieldId: f.f.logTask,
            options: { ...f.options, filter: undefined, limitToViewId: undefined },
          },
          {
            kind: 'record.update',
            tableId: f.log,
            records: [{ id: f.recordId, values: { [f.f.logTask]: [f.denied] } }],
          },
          {
            kind: 'record.trash',
            tableId: side === 'source' ? f.log : f.tasks,
            recordIds: [side === 'source' ? f.recordId : f.denied],
          },
          { kind: 'field.update', fieldId: f.f.logTask, options: f.options },
        ]);
        const tableId = side === 'source' ? f.log : f.tasks;
        const recordId = side === 'source' ? f.recordId : f.denied;
        const restored = await send(server, f.databaseId, [
          { kind: 'record.restore', tableId, recordIds: [recordId] },
        ]);
        expect(restored[0]?.error?.messageKey).toBe('data.link.outsideLimit');
        const missing = await server.app.inject({
          url: `/api/tables/${tableId}/records/${recordId}`,
          headers: server.owner.headers,
        });
        expect(missing.statusCode).toBe(404);
        await apply(server, f.databaseId, [
          {
            kind: 'field.update',
            fieldId: f.f.logTask,
            options: { ...f.options, filter: undefined, limitToViewId: undefined },
          },
          { kind: 'record.restore', tableId, recordIds: [recordId] },
        ]);
        expect((await f.read()).values[f.f.logTask]).toEqual([f.denied]);
      });

    it('refuses grid creates and updates, including edits through the paired field', async () => {
      const f = await setup(mode);
      for (const kind of ['record.create', 'record.update']) {
        const id = kind === 'record.create' ? newId('record') : f.recordId;
        const result = await send(server, f.databaseId, [
          {
            kind,
            tableId: f.log,
            records: [{ id, values: { [f.f.logCount]: 3, [f.f.logTask]: [f.denied] } }],
          },
        ]);
        expect(result[0]?.error?.messageKey).toBe('data.link.outsideLimit');
        expect((await f.read()).values[f.f.logTask]).toEqual([]);
      }
      const schema = await server.app.inject({
        url: `/api/databases/${f.databaseId}/schema`,
        headers: server.owner.headers,
      });
      const link = schema
        .json<{ fields: Array<{ id: string; options: { inverseFieldId: string } }> }>()
        .fields.find((field) => field.id === f.f.logTask)!;
      const inverse = await send(server, f.databaseId, [
        {
          kind: 'record.update',
          tableId: f.tasks,
          records: [{ id: f.denied, values: { [link.options.inverseFieldId]: [f.recordId] } }],
        },
      ]);
      expect(inverse[0]?.error?.messageKey).toBe('data.link.outsideLimit');
      await apply(server, f.databaseId, [
        {
          kind: 'record.update',
          tableId: f.log,
          records: [{ id: f.recordId, values: { [f.f.logTask]: [f.allowed] } }],
        },
      ]);
      expect((await f.read()).values[f.f.logTask]).toEqual([f.allowed]);
    });

    it('refuses REST writes with a plain message and returns the options in the schema', async () => {
      const f = await setup(mode);
      const tokenResponse = await server.app.inject({
        method: 'POST',
        url: '/api/tokens',
        headers: server.owner.headers,
        payload: {
          name: 'Links',
          scopes: ['data.records:read', 'data.records:write', 'schema.bases:read'],
          databases: [f.databaseId],
        },
      });
      expect(tokenResponse.statusCode, tokenResponse.body).toBe(200);
      const headers = { authorization: `Bearer ${tokenResponse.json<TokenCreated>().token}` };
      const schema = await server.app.inject({ url: `/api/v1/databases/${f.databaseId}/tables`, headers });
      expect(schema.statusCode, schema.body).toBe(200);
      expect(schema.body).toContain(JSON.stringify(f.options.displayFieldIds));
      expect(schema.body).toContain(mode === 'view' ? f.doneView : f.f.logCount);
      for (const method of ['POST', 'PATCH'] as const) {
        const result = await server.app.inject({
          method,
          url: `/api/v1/tables/${f.log}/records`,
          headers,
          payload: {
            fieldKey: 'id',
            records: [
              {
                ...(method === 'PATCH' ? { id: f.recordId } : {}),
                fields: {
                  [f.f.logCount]: 3,
                  [f.f.logTask]: [f.denied],
                },
              },
            ],
          },
        });
        expect(result.statusCode, result.body).toBe(422);
        expect(result.body).toContain('This record is outside the choices allowed by this link field.');
      }
      expect((await f.read()).values[f.f.logTask]).toEqual([]);
    });

    it('refuses the same link when Rio applies a stored plan', async () => {
      const f = await setup(mode);
      const actor = await actorFor(
        server.pool,
        server.schemas,
        server.owner.userId,
        server.owner.info.org.id,
      );
      const commands = [
        Command.parse({
          id: newId('command'),
          groupId: newId('action'),
          kind: 'record.update',
          tableId: f.log,
          records: [{ id: f.recordId, values: { [f.f.logTask]: [f.denied] } }],
        }),
      ];
      await expect(
        withTransaction(server.pool, (db) =>
          applyCommands(server.app, actor!, db, f.databaseId, { commands }),
        ),
      ).rejects.toMatchObject({ messageKey: 'data.link.outsideLimit' });
      expect((await f.read()).values[f.f.logTask]).toEqual([]);
    });

    it('refuses signed form submissions and automation updates', async () => {
      const f = await setup(mode);
      const viewId = newId('view');
      await apply(server, f.databaseId, [
        {
          kind: 'view.create',
          view: {
            id: viewId,
            tableId: f.log,
            name: 'Link form',
            type: 'form',
            config: { form: { questions: [{ fieldId: f.f.logCount }, { fieldId: f.f.logTask }] } },
          },
        },
      ]);
      const form = await send(server, f.databaseId, [
        {
          kind: 'record.create',
          tableId: f.log,
          formViewId: viewId,
          records: [{ id: newId('record'), values: { [f.f.logCount]: 3, [f.f.logTask]: [f.denied] } }],
        },
      ]);
      expect(form[0]?.error?.messageKey).toBe('data.link.outsideLimit');
      const automation = await automate(
        server,
        f.databaseId,
        {
          trigger: { kind: 'recordCreated', tableId: f.log },
          steps: [
            {
              id: 'update01',
              kind: 'updateRecord',
              tableId: f.log,
              record: 'trigger',
              values: { [f.f.logTask]: f.denied },
            },
          ],
        },
        { enabled: false },
      );
      const result = await testRun(server, automation, { recordId: f.recordId });
      expect(result.status, result.body).toBe(200);
      expect(result.run.state, result.body).toBe('failed');
      expect(result.body).toContain('data.link.outsideLimit');
      expect((await f.read()).values[f.f.logTask]).toEqual([]);
    });

    it('rejects the same links during Rio plan validation without retaining simulated writes', async () => {
      const f = await setup(mode);
      const actor = await actorFor(
        server.pool,
        server.schemas,
        server.owner.userId,
        server.owner.info.org.id,
      );
      expect(actor).not.toBeNull();
      await expect(
        withTransaction(server.pool, (db) =>
          validate(
            { db, schemas: server.schemas, actor: actor!, databaseId: f.databaseId, appContext: server.ctx },
            [
              Command.parse({
                id: newId('command'),
                groupId: newId('action'),
                kind: 'record.update',
                tableId: f.log,
                records: [{ id: f.recordId, values: { [f.f.logTask]: [f.denied] } }],
              }),
            ],
          ),
        ),
      ).rejects.toMatchObject({ messageKey: 'data.link.outsideLimit' });
      expect((await f.read()).values[f.f.logTask]).toEqual([]);
    });

    it('searches extra fields, pages eligible choices, and exposes only readable preview fields', async () => {
      const f = await setup(mode);
      const page = await f.choices({ query: 'Searchable' });
      expect(page.records.map((record) => record.id)).toEqual([f.allowed]);
      expect(page.records[0]?.values[f.f.note]).toBe('Searchable details');
      expect((await f.choices({ query: 'Done' })).records.map((record) => record.id)).toEqual([f.allowed]);
      expect(page.fields.find((field) => field.id === f.f.status)).toMatchObject({
        options: {
          choices: expect.arrayContaining([
            expect.objectContaining({ name: 'Done', color: expect.any(String) }),
          ]),
        },
      });
      await createRecords(
        server,
        f.databaseId,
        f.tasks,
        Array.from({ length: 105 }, (_, index) => ({
          [f.f.name]: `Eligible ${index}`,
          [f.f.count]: 3,
          [f.f.status]: f.done,
        })),
      );
      const first = await f.choices();
      const second = await f.choices({ offset: 100 });
      expect(first.records).toHaveLength(100);
      expect(first.hasMore).toBe(true);
      expect(second.records).toHaveLength(6);
      expect(second.hasMore).toBe(false);
      expect(new Set([...first.records, ...second.records].map((record) => record.id)).size).toBe(106);
      const member = await server.addMember();
      const { grant } = await import('../automations/automations.test-helpers.js');
      await grant(server, f.databaseId, member, 'reader');
      await server.app.inject({
        method: 'PUT',
        url: `/api/fields/${f.f.note}/permissions`,
        headers: server.owner.headers,
        payload: { restricted: { roles: ['owner'], users: [] }, locked: null },
      });
      const hidden = await server.app.inject({
        method: 'POST',
        url: `/api/fields/${f.f.logTask}/link-options`,
        headers: member.headers,
        payload: { recordId: f.recordId, query: 'Searchable' },
      });
      expect(hidden.statusCode, hidden.body).toBe(200);
      expect(hidden.json<LinkChoicesPage>().records).toEqual([]);
      const readable = await server.app.inject({
        method: 'POST',
        url: `/api/fields/${f.f.logTask}/link-options`,
        headers: member.headers,
        payload: {},
      });
      expect(readable.statusCode, readable.body).toBe(200);
      const preview = readable.json<LinkChoicesPage>();
      expect(preview.fields.some((field) => field.id === f.f.note)).toBe(false);
      expect(preview.records.some((record) => Object.hasOwn(record.values, f.f.note))).toBe(false);
      expect(preview.canCreate).toBe(false);
    });
  });

it('hides a link limited to a view from anyone who can’t see a field the view filters by', async () => {
  const f = await setup('view');
  const { grant } = await import('../automations/automations.test-helpers.js');
  const editor = await server.addMember();
  const creator = await server.addMember();
  await grant(server, f.databaseId, editor, 'editor');
  await grant(server, f.databaseId, creator, 'creator');
  const pick = (who: typeof editor) =>
    server.app.inject({
      method: 'POST',
      url: `/api/fields/${f.f.logTask}/link-options`,
      headers: who.headers,
      payload: { recordId: f.recordId },
    });
  const fieldIds = async (who: typeof editor) => {
    const response = await server.app.inject({
      url: `/api/databases/${f.databaseId}/schema`,
      headers: who.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ fields: Array<{ id: string }> }>().fields.map((field) => field.id);
  };
  // While everyone sees Status, which the view filters by, the limit is everyone's to read.
  const before = await pick(editor);
  expect(before.statusCode, before.body).toBe(200);
  expect(before.json<LinkChoicesPage>().records.map((record) => record.id)).toEqual([f.allowed]);
  const restricted = await server.app.inject({
    method: 'PUT',
    url: `/api/fields/${f.f.status}/permissions`,
    headers: server.owner.headers,
    payload: { restricted: { roles: ['owner'], users: [] }, locked: null },
  });
  expect(restricted.statusCode, restricted.body).toBe(200);
  // The choices would now say which tasks are done, so the link goes with the field.
  for (const who of [editor, creator]) {
    expect((await pick(who)).statusCode).toBe(404);
    expect(await fieldIds(who)).not.toContain(f.f.logTask);
  }
  // Nor does writing through it say which records the limit keeps out.
  for (const taskId of [f.allowed, f.denied]) {
    const [written] = await send(
      server,
      f.databaseId,
      [
        {
          kind: 'record.update',
          tableId: f.log,
          records: [{ id: f.recordId, values: { [f.f.logTask]: [taskId] } }],
        },
      ],
      editor,
    );
    expect(written?.status).toBe('rejected');
    expect(written?.error?.messageKey).not.toBe('data.link.outsideLimit');
  }
  expect((await f.read()).values[f.f.logTask]).toEqual([]);
  // A new link can't be pointed at the view by someone who can't see what it filters by.
  const [made] = await send(
    server,
    f.databaseId,
    [
      {
        kind: 'field.create',
        tableId: f.log,
        field: {
          id: newId('field'),
          name: 'Done tasks',
          type: 'link',
          options: { linkedTableId: f.tasks, limitToViewId: f.doneView },
        },
      },
    ],
    creator,
  );
  expect(made?.status, JSON.stringify(made)).toBe('rejected');
  // The owner, who sees Status, reads the limit as before.
  expect((await f.choices()).records.map((record) => record.id)).toEqual([f.allowed]);
  expect(await fieldIds(server.owner)).toContain(f.f.logTask);
  // Restoring a record checks only the links the person restoring it can see, so it says nothing
  // of this one either, whichever side comes back.  A link already outside the limit stays put.
  await apply(server, f.databaseId, [
    {
      kind: 'field.update',
      fieldId: f.f.logTask,
      options: { ...f.options, filter: undefined, limitToViewId: undefined },
    },
    {
      kind: 'record.update',
      tableId: f.log,
      records: [{ id: f.recordId, values: { [f.f.logTask]: [f.denied] } }],
    },
    { kind: 'field.update', fieldId: f.f.logTask, options: f.options },
  ]);
  for (const [tableId, recordId] of [
    [f.log, f.recordId],
    [f.tasks, f.denied],
  ] as const) {
    for (const kind of ['record.trash', 'record.restore']) {
      const [result] = await send(server, f.databaseId, [{ kind, tableId, recordIds: [recordId] }], editor);
      expect(result?.status, JSON.stringify(result)).toBe('applied');
    }
    expect((await f.read()).values[f.f.logTask]).toEqual([f.denied]);
  }
  // Someone who sees the link is still told it sits outside its limit.
  await apply(server, f.databaseId, [{ kind: 'record.trash', tableId: f.log, recordIds: [f.recordId] }]);
  const [refused] = await send(server, f.databaseId, [
    { kind: 'record.restore', tableId: f.log, recordIds: [f.recordId] },
  ]);
  expect(refused?.error?.messageKey).toBe('data.link.outsideLimit');
});

it('says nothing of a hidden link’s limit when someone changes the value it compares with', async () => {
  const f = await setup('filter');
  const { grant } = await import('../automations/automations.test-helpers.js');
  const editor = await server.addMember();
  await grant(server, f.databaseId, editor, 'editor');
  await apply(server, f.databaseId, [
    {
      kind: 'record.update',
      tableId: f.log,
      records: [{ id: f.recordId, values: { [f.f.logTask]: [f.allowed] } }],
    },
  ]);
  const change = (count: number, who = editor, groupId = newId('action')) =>
    send(
      server,
      f.databaseId,
      [
        {
          kind: 'record.update',
          tableId: f.log,
          records: [{ id: f.recordId, values: { [f.f.logCount]: count } }],
        },
      ],
      who,
      groupId,
    );
  // While the editor sees the link and the count it compares, a value that breaks the link is refused.
  expect((await change(4))[0]?.error?.messageKey).toBe('data.link.outsideLimit');
  const restricted = await server.app.inject({
    method: 'PUT',
    url: `/api/fields/${f.f.count}/permissions`,
    headers: server.owner.headers,
    payload: { restricted: { roles: ['owner'], users: [] }, locked: null },
  });
  expect(restricted.statusCode, restricted.body).toBe(200);
  // The link now hides with the count.  A refusal would name it, and would say whether the linked
  // task's count equals whatever the editor typed, so the change stands and the link stays.
  for (const count of [4, 3, 5]) {
    const [result] = await change(count);
    expect(result?.status, JSON.stringify(result)).toBe('applied');
  }
  // Undoing a change goes back to a value that breaks the link just as quietly.
  const groupId = newId('action');
  expect((await change(3, editor, groupId))[0]?.status).toBe('applied');
  const undone = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${f.databaseId}/undo`,
    headers: editor.headers,
    payload: { commandId: newId('command'), groupId, clientId: newId('client') },
  });
  expect(undone.statusCode, undone.body).toBe(200);
  expect(undone.json()).toMatchObject({ status: 'applied', skipped: 0 });
  const after = await f.read();
  expect(after.values[f.f.logCount]).toBe(5);
  expect(after.values[f.f.logTask]).toEqual([f.allowed]);
  // Someone who sees the link is still held to its limit.
  expect((await change(6, server.owner))[0]?.error?.messageKey).toBe('data.link.outsideLimit');
});

it('keeps eligibility and preview values in the same snapshot when access changes during the read', async () => {
  const f = await setup('view');
  const member = await server.addMember();
  const { grant } = await import('../automations/automations.test-helpers.js');
  await grant(server, f.databaseId, member, 'reader');
  const rules = await server.app.inject({
    method: 'PUT',
    url: `/api/tables/${f.tasks}/record-rules`,
    headers: server.owner.headers,
    payload: {
      rules: [
        {
          id: newId('recordRule'),
          roles: ['reader'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'allowed', fieldId: f.f.status, operator: 'is', value: f.done }],
          },
        },
      ],
    },
  });
  expect(rules.statusCode, rules.body).toBe(200);
  const fetch = physicalRecords.fetchRowsById;
  const preview = vi.spyOn(physicalRecords, 'fetchRowsById').mockImplementationOnce(async (...args) => {
    preview.mockRestore();
    await apply(server, f.databaseId, [
      {
        kind: 'record.update',
        tableId: f.tasks,
        records: [
          { id: f.allowed, values: { [f.f.status]: f.todo, [f.f.note]: 'Private after access changed' } },
        ],
      },
    ]);
    return fetch(...args);
  });
  try {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/fields/${f.f.logTask}/link-options`,
      headers: member.headers,
      payload: { recordId: f.recordId },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<LinkChoicesPage>().records[0]?.values[f.f.note]).toBe('Searchable details');
    const inaccessible = await server.app.inject({
      url: `/api/tables/${f.tasks}/records/${f.allowed}`,
      headers: member.headers,
    });
    expect(inaccessible.statusCode).toBe(404);
  } finally {
    preview.mockRestore();
  }
});

it('evaluates nested current formulas with saved values, drafts, and defaults for new records', async () => {
  const f = await setup('filter');
  const computed = newId('field');
  const nested = newId('field');
  await apply(server, f.databaseId, [
    {
      kind: 'field.create',
      tableId: f.log,
      field: {
        id: computed,
        name: 'Current count',
        type: 'formula',
        options: { expression: `{${f.f.logCount}} * 1` },
      },
    },
    {
      kind: 'field.create',
      tableId: f.log,
      field: {
        id: nested,
        name: 'Nested count',
        type: 'formula',
        options: { expression: `{${computed}} + 0` },
      },
    },
    { kind: 'field.update', fieldId: f.f.logCount, options: { defaultValue: { kind: 'value', value: 4 } } },
    {
      kind: 'field.update',
      fieldId: f.f.logTask,
      options: {
        ...f.options,
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'computed', fieldId: f.f.count, operator: 'eq', currentFieldId: nested }],
        },
      },
    },
  ]);
  expect((await f.choices()).records.map((row) => row.id)).toEqual([f.allowed]);
  expect(
    (await f.choices({ values: { [f.f.logCount]: 4, [nested]: 3 } })).records.map((row) => row.id),
  ).toEqual([f.denied]);
  expect(
    (await f.choices({ recordId: undefined, values: { [f.f.logCount]: 3 } })).records.map((row) => row.id),
  ).toEqual([f.allowed]);
  expect((await f.choices({ recordId: undefined })).records.map((row) => row.id)).toEqual([f.denied]);
  expect((await f.choices({ recordId: undefined, values: { [f.f.logCount]: null } })).records).toEqual([]);
  expect((await f.read()).values[f.f.logCount]).toBe(3);
});

it('restores an eligible target without validating unrelated retained links', async () => {
  const f = await setup('view');
  await apply(server, f.databaseId, [
    { kind: 'field.update', fieldId: f.f.logTask, options: { ...f.options, limitToViewId: undefined } },
    {
      kind: 'record.update',
      tableId: f.log,
      records: [{ id: f.recordId, values: { [f.f.logTask]: [f.denied, f.allowed] } }],
    },
    { kind: 'record.trash', tableId: f.tasks, recordIds: [f.allowed] },
    { kind: 'field.update', fieldId: f.f.logTask, options: f.options },
    { kind: 'record.restore', tableId: f.tasks, recordIds: [f.allowed] },
  ]);
  expect((await f.read()).values[f.f.logTask]).toEqual([f.denied, f.allowed]);
});

it('evaluates computed current counts from draft links without changing saved links', async () => {
  const f = await setup('filter');
  const ids = await createRecords(server, f.databaseId, f.tasks, [
    { [f.f.name]: 'Extra one' },
    { [f.f.name]: 'Extra two' },
  ]);
  const otherLink = newId('field');
  const count = newId('field');
  await apply(server, f.databaseId, [
    {
      kind: 'field.create',
      tableId: f.log,
      field: { id: otherLink, name: 'Other tasks', type: 'link', options: { linkedTableId: f.tasks } },
    },
    {
      kind: 'field.create',
      tableId: f.log,
      field: { id: count, name: 'Task count', type: 'count', options: { linkFieldId: otherLink } },
    },
    {
      kind: 'field.update',
      fieldId: f.f.logTask,
      options: {
        ...f.options,
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'count', fieldId: f.f.count, operator: 'eq', currentFieldId: count }],
        },
      },
    },
    {
      kind: 'record.update',
      tableId: f.log,
      records: [{ id: f.recordId, values: { [otherLink]: [f.allowed, f.denied, ids[0]] } }],
    },
  ]);
  expect((await f.choices()).records.map((row) => row.id)).toEqual([f.allowed]);
  expect(
    (await f.choices({ values: { [otherLink]: [f.allowed, f.denied, ...ids] } })).records.map(
      (row) => row.id,
    ),
  ).toEqual([f.denied]);
  expect(
    (
      await f.choices({ recordId: undefined, values: { [otherLink]: [f.allowed, f.denied, ids[0]] } })
    ).records.map((row) => row.id),
  ).toEqual([f.allowed]);
  expect((await f.read()).values[otherLink]).toEqual([f.allowed, f.denied, ids[0]]);
});

it('uses new current values in a combined edit and refuses a dependency change that breaks retained links', async () => {
  const f = await setup('filter');
  await apply(server, f.databaseId, [
    {
      kind: 'record.update',
      tableId: f.log,
      records: [{ id: f.recordId, values: { [f.f.logCount]: 4, [f.f.logTask]: [f.denied] } }],
    },
  ]);
  const result = await send(server, f.databaseId, [
    { kind: 'record.update', tableId: f.log, records: [{ id: f.recordId, values: { [f.f.logCount]: 3 } }] },
  ]);
  expect(result[0]?.error?.messageKey).toBe('data.link.outsideLimit');
  expect((await f.read()).values[f.f.logCount]).toBe(4);
  const draft = await f.choices({ values: { [f.f.logCount]: 3 } });
  expect(draft.records.map((record) => record.id)).toEqual([f.allowed]);
});

it('revalidates a computed current field when one of its inputs changes', async () => {
  const f = await setup('filter');
  const computed = newId('field');
  await apply(server, f.databaseId, [
    {
      kind: 'field.create',
      tableId: f.log,
      field: {
        id: computed,
        name: 'Current count',
        type: 'formula',
        options: { expression: `{${f.f.logCount}} * 1` },
      },
    },
    {
      kind: 'field.update',
      fieldId: f.f.logTask,
      options: {
        ...f.options,
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'computed', fieldId: f.f.count, operator: 'eq', currentFieldId: computed }],
        },
      },
    },
    {
      kind: 'record.update',
      tableId: f.log,
      records: [{ id: f.recordId, values: { [f.f.logTask]: [f.allowed] } }],
    },
  ]);
  const result = await send(server, f.databaseId, [
    { kind: 'record.update', tableId: f.log, records: [{ id: f.recordId, values: { [f.f.logCount]: 4 } }] },
  ]);
  expect(result[0]?.error?.messageKey).toBe('data.link.outsideLimit');
  expect((await f.read()).values[f.f.logCount]).toBe(3);
});

it('searches source-backed select labels and includes their selected chip metadata', async () => {
  const f = await setup('view');
  const category = newId('field');
  const choice = await sourceChoiceId(f.recordId);
  await apply(server, f.databaseId, [
    {
      kind: 'record.update',
      tableId: f.log,
      records: [{ id: f.recordId, values: { [f.f.logNote]: 'Selected label' } }],
    },
    {
      kind: 'field.create',
      tableId: f.tasks,
      field: {
        id: category,
        name: 'Category',
        type: 'singleSelect',
        options: { source: { tableId: f.log, fieldId: f.f.logNote } },
      },
    },
    { kind: 'record.update', tableId: f.tasks, records: [{ id: f.allowed, values: { [category]: choice } }] },
    { kind: 'field.update', fieldId: f.f.logTask, options: { ...f.options, displayFieldIds: [category] } },
  ]);
  const page = await f.choices({ query: 'Selected label' });
  expect(page.records.map((record) => record.id)).toEqual([f.allowed]);
  expect(page.records[0]?.selectChoices?.[category]).toContainEqual({
    id: choice,
    name: 'Selected label',
    color: 'gray',
  });
});

it('follows changes to the saved view and fails closed when it is trashed', async () => {
  const f = await setup('view');
  await apply(server, f.databaseId, [
    {
      kind: 'view.update',
      viewId: f.doneView,
      config: {
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'todo', fieldId: f.f.status, operator: 'is', value: f.todo }],
        },
      },
    },
  ]);
  expect((await f.choices()).records.map((record) => record.id)).toEqual([f.denied]);
  await apply(server, f.databaseId, [{ kind: 'view.trash', viewId: f.doneView }]);
  expect((await f.choices()).records).toEqual([]);
  const result = await send(server, f.databaseId, [
    {
      kind: 'record.update',
      tableId: f.log,
      records: [{ id: f.recordId, values: { [f.f.logTask]: [f.denied] } }],
    },
  ]);
  expect(result[0]?.error?.messageKey).toBe('data.link.outsideLimit');
});
