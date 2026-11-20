import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  SchemaFieldCreate,
  SchemaTableCreate,
  newId,
  sourceChoiceId,
  type FieldMeta,
  type RowsPage,
  type TableMeta,
  type TokenCreated,
} from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { applied, inject } from '../data/permissions/permissions.test-helpers.js';
import { grant } from '../automations/automations.test-helpers.js';
import * as messages from './messages.js';
import { openapi } from './openapi.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'schemaregressions');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

type Table = TableMeta & { fields: FieldMeta[] };
async function fixture() {
  const databaseId = newId('database');
  const tableId = newId('table');
  const nameId = newId('field');
  const viewId = newId('view');
  const response = await inject(server, server.owner, 'POST', '/api/databases', {
    id: databaseId,
    name: 'Schema checks',
    table: {
      id: tableId,
      name: 'Entries',
      fields: [{ id: nameId, name: 'Name', type: 'text' }],
      view: { id: viewId, name: 'Grid' },
      records: [],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const tokenFor = async (who = server.owner) => {
    const response = await inject(server, who, 'POST', '/api/tokens', {
      name: 'Schema checks',
      scopes: ['schema.bases:read', 'schema.bases:write', 'data.records:read', 'data.records:write'],
      databases: [databaseId],
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<TokenCreated>();
  };
  const token = await tokenFor();
  const send = (method: string, url: string, payload?: unknown, as = token) =>
    server.app.inject({
      method: method as 'POST',
      url,
      headers: { authorization: `Bearer ${as.token}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const ok = async (method: string, url: string, payload?: unknown) => {
    const response = await send(method, url, payload);
    expect(response.statusCode, response.body).toBe(200);
    return response;
  };
  const tables = async () =>
    (await ok('GET', `/api/v1/databases/${databaseId}/tables`)).json<{ tables: Table[] }>().tables;
  const createTable = async (name: string) =>
    (
      await ok('POST', `/api/v1/databases/${databaseId}/tables`, {
        name,
        fields: [{ name: 'Name', type: 'text' }],
      })
    ).json<{ table: Table }>().table;
  const createField = async (spec: object) =>
    (await ok('POST', `/api/v1/tables/${tableId}/fields`, spec)).json<{ field: FieldMeta }>().field;
  const add = async (target: string, fields: object) =>
    (
      await ok('POST', `/api/v1/tables/${target}/records?shape=airtable`, {
        records: [{ fields }],
      })
    ).json<{ records: Array<{ id: string; fields: Record<string, unknown> }> }>().records[0]!;
  const records = async () =>
    (await ok('GET', `/api/v1/tables/${tableId}/records?shape=airtable`)).json<{
      records: Array<{ id: string; fields: Record<string, unknown> }>;
    }>().records;
  return {
    databaseId,
    tableId,
    nameId,
    viewId,
    tokenFor,
    send,
    ok,
    tables,
    createTable,
    createField,
    add,
    records,
  };
}

it.each(['lookup', 'rollup', 'count'] as const)(
  'rejects an initial %s that reuses a hidden source record association',
  async (type) => {
    const f = await fixture();
    const target = await f.createTable('Targets');
    const link = await f.createField({ name: 'Target', type: 'link', options: { linkedTableId: target.id } });
    const association = await f.add(target.id, { Name: 'Private association' });
    await f.add(f.tableId, { Name: 'Hidden', Target: [association.id] });
    const creator = await server.addMember();
    await grant(server, f.databaseId, creator, 'creator');
    const rules = await inject(server, server.owner, 'PUT', `/api/tables/${f.tableId}/record-rules`, {
      rules: [
        {
          id: newId('recordRule'),
          roles: ['creator'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'visible', fieldId: f.nameId, operator: 'is', value: 'Visible' }],
          },
        },
      ],
    });
    expect(rules.statusCode, rules.body).toBe(200);
    const token = await f.tokenFor(creator);
    const hidden = await f.send('GET', `/api/v1/tables/${f.tableId}/records?shape=list`, undefined, token);
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect(hidden.json()).toMatchObject({ records: [] });
    const before = await f.tables();
    const response = await f.send(
      'POST',
      `/api/v1/databases/${f.databaseId}/tables`,
      {
        name: 'Synthetic',
        fields: [
          { name: 'Name', type: 'text' },
          {
            name: 'Association',
            type,
            options: {
              linkFieldId: link.id,
              ...(type === 'count' ? {} : { targetFieldId: target.primaryFieldId }),
              ...(type === 'rollup' ? { fn: 'count' } : {}),
            },
          },
        ],
      },
      token,
    );
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({ error: { messageKey: 'data.field.unknown' } });
    expect(response.headers['x-undo-group-id']).toBeUndefined();
    expect(await f.tables()).toEqual(before);
  },
);

it('rolls back conversion, cell changes, and history when a later rename is rejected', async () => {
  const f = await fixture();
  const field = await f.createField({ name: 'Value', type: 'text' });
  await f.createField({ name: 'Taken', type: 'text' });
  await f.add(f.tableId, { Name: 'Entry', Value: 'unparseable' });
  const before = await f.tables();
  const rows = await f.records();
  const history = async () =>
    (await inject(server, server.owner, 'GET', `/api/databases/${f.databaseId}/schema`)).json<{
      seq: number;
    }>().seq;
  const seq = await history();
  const response = await f.send('PATCH', `/api/v1/fields/${field.id}`, { type: 'number', name: 'Taken' });
  expect(response.statusCode, response.body).toBe(422);
  expect(response.json()).toMatchObject({ error: { messageKey: 'data.field.nameTaken' } });
  expect(response.headers['x-undo-group-id']).toBeUndefined();
  expect(await f.tables()).toEqual(before);
  expect(await f.records()).toEqual(rows);
  expect(await history()).toBe(seq);
});

it('rejects link target changes with or without an explicit type and preserves associations', async () => {
  const f = await fixture();
  const first = await f.createTable('First');
  const second = await f.createTable('Second');
  const link = await f.createField({ name: 'Target', type: 'link', options: { linkedTableId: first.id } });
  const target = await f.add(first.id, { Name: 'Kept' });
  await f.add(f.tableId, { Name: 'Entry', Target: [target.id] });
  const before = await f.tables();
  const rows = await f.records();
  for (const type of [undefined, 'link']) {
    const response = await f.send('PATCH', `/api/v1/fields/${link.id}`, {
      ...(type ? { type } : {}),
      name: 'Renamed',
      options: { linkedTableId: second.id },
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({ error: { messageKey: 'data.link.targetChange' } });
    expect(await f.tables()).toEqual(before);
    expect(await f.records()).toEqual(rows);
  }
});

it.each(['singleSelect', 'multipleSelect'] as const)(
  'converts an options-only %s source change and makes it undoable',
  async (type) => {
    const f = await fixture();
    const source = await f.createTable('Source');
    const sourceRecord = await f.add(source.id, { Name: 'Open' });
    const field = await f.createField({ name: 'Status', type, options: { choices: [{ name: 'Open' }] } });
    await f.add(f.tableId, { Name: 'Entry', Status: type === 'singleSelect' ? 'Open' : ['Open'] });
    const rows = await f.records();
    const response = await f.ok('PATCH', `/api/v1/fields/${field.id}`, {
      options: { source: { tableId: source.id } },
    });
    const converted = response.json<{ field: FieldMeta; undoGroupId: string }>();
    expect(converted.field.options).toMatchObject({ source: { tableId: source.id } });
    const choiceId = await sourceChoiceId(sourceRecord.id);
    const updated = await inject(server, server.owner, 'GET', `/api/databases/${f.databaseId}/schema`);
    expect(
      updated.json<{ fields: FieldMeta[] }>().fields.find((item) => item.id === field.id)?.options,
    ).toMatchObject({ source: { tableId: source.id } });
    const current = await f.records();
    expect(current[0]!.fields.Status).toEqual(rows[0]!.fields.Status);
    const stored = await inject(server, server.owner, 'GET', `/api/views/${f.viewId}/rows`);
    expect(stored.statusCode, stored.body).toBe(200);
    expect(stored.json<RowsPage>().rows[0]?.values[field.id]).toEqual(
      type === 'singleSelect' ? choiceId : [choiceId],
    );
    const undone = await inject(server, server.owner, 'POST', `/api/databases/${f.databaseId}/undo`, {
      clientId: newId('client'),
      commandId: newId('command'),
      groupId: converted.undoGroupId,
    });
    expect(undone.json()).toMatchObject({ status: 'applied' });
    expect((await f.tables())[0]!.fields.find((item) => item.id === field.id)).toMatchObject({
      type,
      options: field.options,
    });
    expect(await f.records()).toEqual(rows);
  },
);

it.each(['singleSelect', 'multipleSelect'] as const)(
  'accepts name-only %s choices in public contracts and OpenAPI',
  (type) => {
    const input = { name: 'Status', options: { choices: [{ name: 'Open' }] } };
    const field: SchemaFieldCreate =
      type === 'singleSelect' ? { ...input, type: 'singleSelect' } : { ...input, type: 'multipleSelect' };
    expect(SchemaFieldCreate.safeParse(field).success).toBe(true);
    expect(SchemaTableCreate.safeParse({ name: 'Entries', fields: [field] }).success).toBe(true);
    const schema = openapi().components.schemas.FieldCreate;
    const visit = (value: unknown): string[][] => {
      if (!value || typeof value !== 'object') return [];
      const item = value as { properties?: object; required?: string[] };
      const own =
        item.properties && 'color' in item.properties && 'id' in item.properties ? [item.required ?? []] : [];
      return [...own, ...Object.values(value).flatMap(visit)];
    };
    const choices = visit(schema);
    expect(choices).toHaveLength(2);
    for (const required of choices) expect(required).toEqual(['name']);
  },
);

it('validates and normalizes initial computed fields after their own link exists', async () => {
  const f = await fixture();
  const amount = await f.createField({ name: 'Amount', type: 'number' });
  const tableId = newId('table');
  const linkId = newId('field');
  const lookupId = newId('field');
  const formulaId = newId('field');
  await applied(server, server.owner, f.databaseId, {
    kind: 'table.create',
    table: {
      id: tableId,
      name: 'Computed',
      view: { id: newId('view'), name: 'Grid' },
      fields: [
        { id: newId('field'), name: 'Name', type: 'text' },
        { id: linkId, name: 'Entries', type: 'link', options: { linkedTableId: f.tableId } },
        {
          id: lookupId,
          name: 'Amounts',
          type: 'lookup',
          options: { linkFieldId: linkId, targetFieldId: amount.id },
        },
        {
          id: newId('field'),
          name: 'Total',
          type: 'rollup',
          options: { linkFieldId: linkId, targetFieldId: amount.id },
        },
        { id: newId('field'), name: 'Count', type: 'count', options: { linkFieldId: linkId } },
        { id: formulaId, name: 'Formula', type: 'formula', options: { expression: '1 + 2' } },
      ],
      records: [],
    },
  });
  const table = (await f.tables()).find((item) => item.id === tableId)!;
  expect(table.fields.find((field) => field.id === lookupId)?.options).toMatchObject({
    resultType: 'number',
  });
  expect(table.fields.find((field) => field.id === formulaId)?.options).toMatchObject({
    resultType: 'number',
  });
  const entry = await f.add(f.tableId, { Name: 'Entry', Amount: 7 });
  const row = await f.add(tableId, { Name: 'Linked', Entries: [entry.id] });
  expect(row.fields).toMatchObject({ Amounts: [7], Total: 7, Count: 1, Formula: 3 });
});

it('interpolates schema error parameters through the catalog without interpreting parameter text', () => {
  expect(messages.message('api.schema.unsupportedFieldType', { type: 'formula' })).toBe(
    'Creating formula fields is not supported.',
  );
  expect(messages.message('api.schema.unknownFieldType', { type: '{detail}' })).toBe(
    'Unknown field type: "{detail}".',
  );
  expect(messages.message('api.schema.invalidRequest', { detail: 'Choose a field.' })).toBe(
    'Invalid request: Choose a field.',
  );
  expect(messages.message('missing.key', { key: 'value' })).toBe('missing.key');
});

it('resolves schema write refusals through the message catalog while retaining Airtable error types', async () => {
  const f = await fixture();
  const fields = `/v0/meta/bases/${f.databaseId}/tables/${f.tableId}/fields`;
  const original = messages.message;
  const catalog = vi
    .spyOn(messages, 'message')
    .mockImplementation((key) => (key.startsWith('api.schema.') ? `translated:${key}` : original(key)));
  try {
    for (const [type, key, error] of [
      ['formula', 'api.schema.unsupportedFieldType', 'UNSUPPORTED_FIELD_TYPE_FOR_CREATE'],
      ['hologram', 'api.schema.unknownFieldType', 'INVALID_FIELD_TYPE'],
    ]) {
      const response = await f.send('POST', fields, { name: 'Refused', type });
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json()).toMatchObject({ error: { type: error, message: `translated:${key}` } });
      expect(catalog).toHaveBeenCalledWith(key, { type });
    }
    const response = await f.send('PATCH', `${fields}/${f.nameId}`, { type: 'number' });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({
      error: { type: 'INVALID_REQUEST_UNKNOWN', message: 'translated:api.schema.fieldPatchMetadataOnly' },
    });
  } finally {
    catalog.mockRestore();
  }
});
