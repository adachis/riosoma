import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DatabaseCreate,
  newId,
  type NamedFunctionResult,
  type Change,
  type FieldMeta,
  type ServerMessage,
  type TableMeta,
  type TokenCreated,
  type TokenScope,
  type UndoResult,
  type ViewMeta,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'schemaapi');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

type Table = TableMeta & { fields: FieldMeta[]; views: ViewMeta[] };
const SCOPES: TokenScope[] = ['schema.bases:read', 'schema.bases:write'];

async function database(who: SignedIn = server.owner) {
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Planning',
    table: {
      id: newId('table'),
      name: 'Projects',
      fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: who.headers,
    payload: input,
  });
  expect(response.statusCode, response.body).toBe(200);
  return { id: input.id, tableId: input.table.id, viewId: input.table.view.id };
}

async function makeToken(scopes = SCOPES, databases: 'all' | string[] = 'all', who = server.owner) {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: who.headers,
    payload: { name: 'Schema', scopes, databases },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<TokenCreated>();
}

async function send(token: TokenCreated, method: string, url: string, payload?: unknown) {
  return server.app.inject({
    method: method as 'POST',
    url,
    headers: { authorization: `Bearer ${token.token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

/** A write that has to work, with its undo group in the body and the header alike. */
async function change<T>(token: TokenCreated, method: string, url: string, payload?: unknown) {
  const response = await send(token, method, url, payload);
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json<T & { undoGroupId: string }>();
  expect(body.undoGroupId).toMatch(/^act/);
  expect(response.headers['x-undo-group-id']).toBe(body.undoGroupId);
  return body;
}

async function tables(token: TokenCreated, databaseId: string) {
  const response = await send(token, 'GET', `/api/v1/databases/${databaseId}/tables`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ tables: Table[] }>().tables;
}

async function undo(databaseId: string, groupId: string, confirmedMajorCreation = false) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/undo`,
    headers: server.owner.headers,
    payload: { clientId: newId('client'), commandId: newId('command'), groupId, confirmedMajorCreation },
  });
  expect(response.json<UndoResult>().status, response.body).toBe('applied');
}

async function grant(databaseId: string, who: SignedIn, role: string) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${who.info.org.id}, 'database', ${databaseId}, 'user', ${who.userId}, ${role})`,
  );
}

/** A meta API write that has to work, with its undo group in the header. */
async function airtable<T>(token: TokenCreated, method: string, url: string, payload: unknown) {
  const response = await send(token, method, url, payload);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['x-undo-group-id']).toMatch(/^act/);
  return { body: response.json<T>(), undoGroupId: String(response.headers['x-undo-group-id']) };
}
const meta = (databaseId: string) => `/v0/meta/bases/app${databaseId.slice(2)}/tables`;

it('creates, renames, reorders, and trashes tables, fields, and views, and the app undoes each change', async () => {
  const db = await database();
  const token = await makeToken();
  const created = await change<{ table: Table }>(token, 'POST', `/api/v1/databases/${db.id}/tables`, {
    name: 'Tasks',
    fields: [
      { name: 'Title', type: 'text' },
      { name: 'Status', type: 'singleSelect', options: { choices: [{ name: 'Open' }, { name: 'Done' }] } },
    ],
  });
  const tableId = created.table.id;
  expect(created.table).toMatchObject({ name: 'Tasks', views: [{ name: 'Grid view', type: 'grid' }] });
  const [title, status] = created.table.fields as [FieldMeta, FieldMeta];
  expect(created.table.primaryFieldId).toBe(title.id);
  const choices = (status.options as { choices: Array<{ id: string; name: string }> }).choices;
  expect(choices.map((choice) => choice.name)).toEqual(['Open', 'Done']);

  const renamed = await change<{ table: Table }>(token, 'PATCH', `/api/v1/tables/${tableId}`, {
    name: 'Work',
    index: 0,
  });
  expect(renamed.table.name).toBe('Work');
  expect((await tables(token, db.id)).map((table) => table.id)).toEqual([tableId, db.tableId]);

  const amount = await change<{ field: FieldMeta }>(token, 'POST', `/api/v1/tables/${tableId}/fields`, {
    name: 'Amount',
    type: 'number',
    options: { precision: 2 },
  });
  expect(amount.field).toMatchObject({ name: 'Amount', type: 'number', options: { precision: 2 } });
  const converted = await change<{ field: FieldMeta }>(token, 'PATCH', `/api/v1/fields/${amount.field.id}`, {
    name: 'Budget',
    type: 'currency',
    options: { code: 'EUR' },
  });
  expect(converted.field).toMatchObject({ name: 'Budget', type: 'currency', options: { code: 'EUR' } });
  // Choices sent by name keep their IDs, so no cell holding one is emptied.
  const added = await change<{ field: FieldMeta }>(token, 'PATCH', `/api/v1/fields/${status.id}`, {
    options: { choices: [{ name: 'Open' }, { name: 'Done' }, { name: 'Blocked' }] },
  });
  const after = (added.field.options as { choices: Array<{ id: string; name: string }> }).choices;
  expect(after.slice(0, 2)).toEqual(choices);
  expect(after[2]).toMatchObject({ name: 'Blocked', id: expect.stringMatching(/^cho/) });

  const view = await change<{ view: ViewMeta }>(token, 'POST', `/api/v1/tables/${tableId}/views`, {
    name: 'Second',
    type: 'gallery',
  });
  expect(view.view).toMatchObject({ name: 'Second', type: 'gallery', tableId });
  const arranged = await change<{ view: ViewMeta }>(token, 'PATCH', `/api/v1/views/${view.view.id}`, {
    name: 'First',
    index: 0,
    fieldOrder: [amount.field.id],
  });
  expect(arranged.view).toMatchObject({ name: 'First' });
  expect(arranged.view.config.fieldOrder[0]).toBe(amount.field.id);
  const listed = (await tables(token, db.id)).find((table) => table.id === tableId)!;
  expect(listed.views.map((item) => item.name)).toEqual(['First', 'Grid view']);

  const viewTrash = await change(token, 'DELETE', `/api/v1/views/${view.view.id}`);
  const fieldTrash = await change(token, 'DELETE', `/api/v1/fields/${amount.field.id}`);
  const tableTrash = await change(token, 'DELETE', `/api/v1/tables/${tableId}`);
  expect((await tables(token, db.id)).map((table) => table.id)).toEqual([db.tableId]);
  const trashed = await query<{ id: string }>(
    server.pool,
    sql`SELECT id FROM ${ident(server.schemas.app, 'tables')} WHERE id = ${tableId} AND trashed_at IS NOT NULL`,
  );
  expect(trashed.rowCount).toBe(1);

  // Each change undoes in the app, newest first.
  const current = async () => (await tables(token, db.id)).find((table) => table.id === tableId);
  await undo(db.id, tableTrash.undoGroupId);
  expect(await current()).toBeDefined();
  await undo(db.id, fieldTrash.undoGroupId);
  expect((await current())!.fields.map((field) => field.name)).toContain('Budget');
  await undo(db.id, viewTrash.undoGroupId);
  expect((await current())!.views.map((item) => item.name)).toEqual(['First', 'Grid view']);
  await undo(db.id, arranged.undoGroupId);
  expect((await current())!.views.map((item) => item.name)).toEqual(['Grid view', 'Second']);
  await undo(db.id, view.undoGroupId);
  expect((await current())!.views.map((item) => item.name)).toEqual(['Grid view']);
  await undo(db.id, added.undoGroupId);
  const restored = (await current())!.fields.find((field) => field.id === status.id)!;
  expect((restored.options as { choices: unknown[] }).choices).toEqual(choices);
  await undo(db.id, converted.undoGroupId);
  expect((await current())!.fields.find((field) => field.id === amount.field.id)).toMatchObject({
    name: 'Amount',
    type: 'number',
  });
  await undo(db.id, amount.undoGroupId);
  expect((await current())!.fields.map((field) => field.id)).toEqual([title.id, status.id]);
  await undo(db.id, renamed.undoGroupId);
  expect((await tables(token, db.id)).map((table) => [table.id, table.name])).toEqual([
    [db.tableId, 'Projects'],
    [tableId, 'Tasks'],
  ]);
  await undo(db.id, created.undoGroupId, true);
  expect(await current()).toBeUndefined();
});

it('validates field options as the field dialog does and refuses a change the app would refuse', async () => {
  const db = await database();
  const token = await makeToken();
  const url = `/api/v1/tables/${db.tableId}/fields`;
  for (const field of [
    { name: 'Wide', type: 'number', options: { precision: 12 } },
    { name: 'Money', type: 'currency', options: { code: 'XYZ' } },
    { name: 'Odd', type: 'nonsense' },
    { name: 'Name', type: 'text' },
  ]) {
    const refused = await send(token, 'POST', url, field);
    expect(refused.statusCode, refused.body).toBe(422);
  }
  const name = (await tables(token, db.id))[0]!.fields[0]!.id;
  for (const patch of [{ type: 'number', options: { precision: 12 } }, { type: 'nonsense' }]) {
    const refused = await send(token, 'PATCH', `/api/v1/fields/${name}`, patch);
    expect(refused.statusCode, refused.body).toBe(422);
  }
  const other = await database();
  const limited = await makeToken(SCOPES, [db.id]);
  const link = await send(limited, 'POST', url, {
    name: 'Elsewhere',
    type: 'link',
    options: { linkedTableId: other.tableId },
  });
  expect(link.statusCode, link.body).toBe(404);
  expect((await tables(token, other.id))[0]!.fields.map((field) => field.name)).toEqual(['Name']);
  // The last table and view can't go to the trash, as in the app.
  expect((await send(token, 'DELETE', `/api/v1/tables/${db.tableId}`)).statusCode).toBe(422);
  expect((await send(token, 'DELETE', `/api/v1/views/${db.viewId}`)).statusCode).toBe(422);
  expect((await send(token, 'PATCH', `/api/v1/tables/${db.tableId}`, {})).statusCode).toBe(422);
  expect((await tables(token, db.id))[0]!.fields.map((field) => field.name)).toEqual(['Name']);
});

it('refuses schema writes without the scope, outside the token’s databases, or below the creator role', async () => {
  const db = await database();
  const fieldId = (await tables(await makeToken(), db.id))[0]!.fields[0]!.id;
  const writes: Array<[string, string, unknown?]> = [
    ['POST', `/api/v1/databases/${db.id}/tables`, { name: 'New', fields: [{ name: 'Name', type: 'text' }] }],
    ['PATCH', `/api/v1/tables/${db.tableId}`, { name: 'Renamed' }],
    ['DELETE', `/api/v1/tables/${db.tableId}`],
    ['POST', `/api/v1/tables/${db.tableId}/fields`, { name: 'Notes', type: 'longText' }],
    ['PATCH', `/api/v1/fields/${fieldId}`, { name: 'Title' }],
    ['DELETE', `/api/v1/fields/${fieldId}`],
    ['POST', `/api/v1/tables/${db.tableId}/views`, { name: 'Other' }],
    ['PATCH', `/api/v1/views/${db.viewId}`, { name: 'Renamed' }],
    ['DELETE', `/api/v1/views/${db.viewId}`],
  ];
  const elsewhere = await database();
  const unscoped = await makeToken(['schema.bases:read', 'data.records:write']);
  const outside = await makeToken(SCOPES, [elsewhere.id]);
  const member = await server.addMember();
  await grant(db.id, member, 'editor');
  const editor = await makeToken(SCOPES, 'all', member);
  for (const [method, url, payload] of writes) {
    const noScope = await send(unscoped, method, url, payload);
    expect(noScope.statusCode, `${method} ${url}`).toBe(403);
    expect(noScope.json()).toMatchObject({ error: { messageKey: 'errors.tokenScope' } });
    expect((await send(outside, method, url, payload)).statusCode, `${method} ${url}`).toBe(404);
    const denied = await send(editor, method, url, payload);
    expect(denied.statusCode, `${method} ${url}`).toBe(403);
    expect(denied.json()).toMatchObject({ error: { messageKey: 'data.access.denied' } });
  }
  const unchanged = (await tables(await makeToken(), db.id))[0]!;
  expect(unchanged).toMatchObject({
    name: 'Projects',
    fields: [{ name: 'Name' }],
    views: [{ name: 'Grid' }],
  });
});

it('creates and changes tables and fields through Airtable’s meta API in Airtable’s shapes', async () => {
  const db = await database();
  const token = await makeToken();
  type AirtableTable = { id: string; primaryFieldId: string; fields: Array<{ id: string }> };
  const created = await airtable<AirtableTable>(token, 'POST', meta(db.id), {
    name: 'Contacts',
    description: 'People we know',
    fields: [
      { name: 'Name', type: 'singleLineText' },
      { name: 'Email', type: 'email', description: 'Work address' },
      {
        name: 'Stage',
        type: 'singleSelect',
        options: {
          choices: [
            { name: 'Lead', color: 'blueLight2' },
            { name: 'Won', color: 'orangeDark1' },
          ],
        },
      },
      { name: 'Amount', type: 'currency', options: { precision: 2, symbol: '€' } },
      {
        name: 'Signed',
        type: 'dateTime',
        options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'utc' },
      },
      { name: 'Done', type: 'checkbox', options: { icon: 'check', color: 'greenBright' } },
      { name: 'Score', type: 'rating', options: { icon: 'heart', max: 3, color: 'redBright' } },
      { name: 'Time', type: 'duration', options: { durationFormat: 'h:mm:ss' } },
      { name: 'Owners', type: 'multipleCollaborators', options: {} },
      { name: 'Projects', type: 'multipleRecordLinks', options: { linkedTableId: db.tableId } },
    ],
  });
  expect(created.body).toMatchObject({
    id: expect.stringMatching(/^tbl/),
    name: 'Contacts',
    description: 'People we know',
    primaryFieldId: created.body.fields[0]!.id,
    fields: [
      { name: 'Name', type: 'singleLineText' },
      { name: 'Email', type: 'email', description: 'Work address' },
      {
        name: 'Stage',
        type: 'singleSelect',
        options: {
          choices: [
            { name: 'Lead', color: 'blueLight2' },
            { name: 'Won', color: 'orangeDark1' },
          ],
        },
      },
      { name: 'Amount', type: 'currency', options: { precision: 2, symbol: '€' } },
      {
        name: 'Signed',
        type: 'dateTime',
        options: { dateFormat: { name: 'iso' }, timeFormat: { name: '24hour' }, timeZone: 'utc' },
      },
      { name: 'Done', type: 'checkbox', options: { color: 'greenBright' } },
      { name: 'Score', type: 'rating', options: { icon: 'heart', max: 3, color: 'redBright' } },
      { name: 'Time', type: 'duration', options: { durationFormat: 'h:mm:ss' } },
      { name: 'Owners', type: 'multipleCollaborators' },
      { name: 'Projects', type: 'multipleRecordLinks', options: { linkedTableId: db.tableId } },
    ],
    views: [{ name: 'Grid view', type: 'grid' }],
  });
  const tableId = created.body.id;
  const renamed = await airtable(token, 'PATCH', `${meta(db.id)}/Contacts`, {
    name: 'People',
    description: 'Everyone',
  });
  expect(renamed.body).toMatchObject({ id: tableId, name: 'People', description: 'Everyone' });
  const notes = await airtable<{ id: string }>(token, 'POST', `${meta(db.id)}/${tableId}/fields`, {
    name: 'Notes',
    type: 'multilineText',
    description: 'Anything else',
  });
  expect(notes.body).toEqual({
    id: expect.stringMatching(/^fld/),
    name: 'Notes',
    type: 'multilineText',
    description: 'Anything else',
  });
  const changed = await airtable(token, 'PATCH', `${meta(db.id)}/People/fields/${notes.body.id}`, {
    name: 'Comments',
  });
  expect(changed.body).toMatchObject({ id: notes.body.id, name: 'Comments', type: 'multilineText' });
  const listed = await send(token, 'GET', meta(db.id));
  expect(listed.json<{ tables: Array<{ name: string }> }>().tables.map((table) => table.name)).toEqual([
    'Projects',
    'People',
  ]);
  // The app undoes each change.
  const current = async () => (await tables(token, db.id)).find((table) => table.id === tableId);
  await undo(db.id, changed.undoGroupId);
  expect((await current())!.fields.at(-1)!.name).toBe('Notes');
  await undo(db.id, notes.undoGroupId);
  expect((await current())!.fields.map((field) => field.name)).not.toContain('Notes');
  await undo(db.id, renamed.undoGroupId);
  expect(await current()).toMatchObject({ name: 'Contacts', description: 'People we know' });
  await undo(db.id, created.undoGroupId, true);
  expect(await current()).toBeUndefined();
});

it('answers meta API schema writes it refuses with Airtable’s errors', async () => {
  const db = await database();
  const token = await makeToken();
  const fields = `${meta(db.id)}/${db.tableId}/fields`;
  const fieldId = (await tables(token, db.id))[0]!.fields[0]!.id;
  const refusals: Array<[string, string, unknown, number, string]> = [
    [
      'POST',
      fields,
      { name: 'Total', type: 'formula', options: { formula: '1' } },
      422,
      'UNSUPPORTED_FIELD_TYPE_FOR_CREATE',
    ],
    ['POST', fields, { name: 'Number', type: 'autoNumber' }, 422, 'UNSUPPORTED_FIELD_TYPE_FOR_CREATE'],
    ['POST', fields, { name: 'Odd', type: 'hologram' }, 422, 'INVALID_FIELD_TYPE'],
    [
      'POST',
      fields,
      { name: 'Cost', type: 'number', options: { precision: 12 } },
      422,
      'INVALID_REQUEST_UNKNOWN',
    ],
    [
      'POST',
      fields,
      { name: 'Coins', type: 'currency', options: { precision: 2, symbol: '¤¤' } },
      422,
      'INVALID_REQUEST_UNKNOWN',
    ],
    ['PATCH', `${fields}/${fieldId}`, { type: 'number' }, 422, 'INVALID_REQUEST_UNKNOWN'],
    ['POST', meta(db.id), { name: 'Empty', fields: [] }, 422, 'INVALID_REQUEST_UNKNOWN'],
    ['PATCH', `${meta(db.id)}/Missing`, { name: 'Found' }, 403, 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND'],
  ];
  for (const [method, url, payload, status, type] of refusals) {
    const response = await send(token, method, url, payload);
    expect(response.statusCode, `${method} ${url} ${response.body}`).toBe(status);
    expect(response.json()).toMatchObject({ error: { type } });
  }
  const writes: Array<[string, string, unknown]> = [
    ['POST', meta(db.id), { name: 'New', fields: [{ name: 'Name', type: 'singleLineText' }] }],
    ['PATCH', `${meta(db.id)}/${db.tableId}`, { name: 'Renamed' }],
    ['POST', fields, { name: 'Notes', type: 'multilineText' }],
    ['PATCH', `${fields}/${fieldId}`, { name: 'Title' }],
  ];
  const elsewhere = await database();
  const member = await server.addMember();
  await grant(db.id, member, 'editor');
  const tokens: Array<[TokenCreated, string]> = [
    [await makeToken(['schema.bases:read', 'data.records:write']), 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND'],
    [await makeToken(SCOPES, [elsewhere.id]), 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND'],
    [await makeToken(SCOPES, 'all', member), 'INVALID_PERMISSIONS'],
  ];
  for (const [method, url, payload] of writes)
    for (const [refused, type] of tokens) {
      const response = await send(refused, method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(response.json()).toMatchObject({ error: { type } });
    }
  expect(await tables(token, db.id)).toMatchObject([{ name: 'Projects', fields: [{ name: 'Name' }] }]);
});

it('shows a token’s schema changes to a person with the database open, and their undo', async () => {
  const db = await database();
  const token = await makeToken();
  const person = await server.addMember();
  await grant(db.id, person, 'reader');
  const schema = await server.app.inject({ url: `/api/databases/${db.id}/schema`, headers: person.headers });
  const seq = schema.json<{ seq: number }>().seq;
  server.config.baseUrl = undefined;
  const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
  const messages: ServerMessage[] = [];
  const socket = new WebSocket(`${address.replace(/^http/, 'ws')}/api/realtime`, {
    headers: { cookie: person.headers.cookie, origin: new URL(address).origin },
  });
  socket.addEventListener('message', (event) =>
    messages.push(JSON.parse(String(event.data)) as ServerMessage),
  );
  const until = async (check: () => boolean) => {
    const started = performance.now();
    while (!check()) {
      if (performance.now() - started > 5_000) throw new Error('condition timed out');
      await delay(10);
    }
  };
  const changes = () =>
    messages.flatMap((message): Change[] => (message.type === 'change' ? [message.change] : []));
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    socket.send(JSON.stringify({ type: 'hello', csrf: person.info.csrfToken, clientId: newId('client') }));
    await until(() => messages.some((message) => message.type === 'ready'));
    socket.send(JSON.stringify({ type: 'subscribe', databaseId: db.id, sinceSeq: seq }));
    await until(() => messages.some((message) => message.type === 'caughtUp'));
    await change(token, 'PATCH', `/api/v1/views/${db.viewId}`, { name: 'Everything' });
    await airtable(token, 'PATCH', `${meta(db.id)}/${db.tableId}`, { name: 'Plans' });
    const field = await change<{ field: FieldMeta }>(token, 'POST', `/api/v1/tables/${db.tableId}/fields`, {
      name: 'Due',
      type: 'date',
    });
    const notes = await airtable<{ id: string }>(token, 'POST', `${meta(db.id)}/${db.tableId}/fields`, {
      name: 'Notes',
      type: 'multilineText',
    });
    await until(() => changes().length === 4);
    expect(changes()).toMatchObject([
      { kind: 'view.updated', view: { id: db.viewId, name: 'Everything' } },
      { kind: 'table.updated', table: { id: db.tableId, name: 'Plans' } },
      { kind: 'field.created', field: { id: field.field.id, name: 'Due' } },
      { kind: 'field.created', field: { id: notes.body.id, name: 'Notes' } },
    ]);
    await undo(db.id, field.undoGroupId);
    await undo(db.id, notes.undoGroupId);
    await until(() => changes().length === 6);
    expect(changes().slice(4)).toMatchObject([
      { kind: 'field.trashed', fieldId: field.field.id },
      { kind: 'field.trashed', fieldId: notes.body.id },
    ]);
  } finally {
    socket.close();
  }
});

it('manages named functions with scopes, revision conflicts, caller warnings, recomputation, and undo', async () => {
  const base = await database();
  const token = await makeToken([...SCOPES, 'data.records:read', 'data.records:write']);
  const path = `/api/v1/databases/${base.id}/named-functions`;
  const input = {
    name: 'DOUBLE',
    parameters: ['amount'],
    body: 'amount * 2',
    description: 'Double an amount',
  };
  const created = await change<NamedFunctionResult>(token, 'POST', path, input);
  expect(created.definition).toMatchObject({ ...input, revision: 1 });
  const functionId = created.definition!.id;
  const listed = await send(token, 'GET', path);
  expect(listed.json()).toEqual({ namedFunctions: [created.definition] });
  const readOnly = await makeToken(['schema.bases:read']);
  expect((await send(readOnly, 'POST', path, input)).statusCode).toBe(403);
  const elsewhere = await database();
  expect(
    (
      await send(token, 'PATCH', `/api/v1/databases/${elsewhere.id}/named-functions/${functionId}`, {
        definition: input,
        revision: 1,
      })
    ).statusCode,
  ).toBe(404);
  const field = await change<{ field: FieldMeta }>(token, 'POST', `/api/v1/tables/${base.tableId}/fields`, {
    name: 'Doubled',
    type: 'formula',
    options: { expression: 'DOUBLE(3)' },
  });
  const record = await send(token, 'POST', `/api/v1/tables/${base.tableId}/records`, {
    records: [{ fields: { Name: 'Sample' } }],
  });
  expect(record.statusCode, record.body).toBe(200);
  const values = async () =>
    (await send(token, 'GET', `/api/v1/tables/${base.tableId}/records?shape=airtable`)).json<{
      records: { fields: Record<string, unknown> }[];
    }>().records[0]!.fields.Doubled;
  expect(await values()).toBe(6);
  const updated = await change<NamedFunctionResult>(token, 'PATCH', `${path}/${functionId}`, {
    definition: { ...input, body: 'amount * 3' },
    revision: 1,
  });
  expect(updated.definition!.revision).toBe(2);
  expect(await values()).toBe(9);
  expect(
    (await send(token, 'PATCH', `${path}/${functionId}`, { definition: input, revision: 1 })).statusCode,
  ).toBe(409);
  const refused = await send(token, 'DELETE', `${path}/${functionId}`, { revision: 2 });
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error).toMatchObject({
    messageKey: 'formula.named.used',
    params: { callers: 'Projects: Doubled' },
  });
  const removed = await change<NamedFunctionResult>(token, 'DELETE', `${path}/${functionId}`, {
    revision: 2,
    confirmUsed: true,
  });
  expect(removed.definition).toBeNull();
  await undo(base.id, removed.undoGroupId);
  expect(await values()).toBe(9);
  expect(field.field.name).toBe('Doubled');
  const restricted = await makeToken(SCOPES, [elsewhere.id]);
  expect((await send(restricted, 'GET', path)).statusCode).toBe(404);
});
