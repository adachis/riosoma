import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  newId,
  type TokenCreated,
  type TokenMeta,
  type TokenScope,
  type KeyedRecords,
  type ListRecords,
  type AirtableRecords,
  type FieldSpec,
  type CommandBatchResult,
  type UndoResult,
  type DatabaseSchema,
  type ViewMeta,
} from '@riosoma/contracts';
import { ident, query, renderSql, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { z } from 'zod';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { readFixture, saveView } from '../data/snapshots.test-helpers.js';
import { AccessScope } from '../data/access.js';
import { m0034 } from '../migrations/0034_link_inverses.js';

let kit: TestPostgres;
let server: ServerFixture;
let token: TokenCreated;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'rest');
  token = await makeToken();
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function makeToken(
  scopes: TokenScope[] = ['data.records:read', 'data.records:write', 'schema.bases:read'],
  databases: 'all' | string[] = 'all',
  who = server.owner,
) {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: who.headers,
    payload: { name: 'Integration', scopes, databases },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<TokenCreated>();
}
const headers = (pat = token) => ({ authorization: `Bearer ${pat.token}` });
const urlFor = (tableId: string) => `/api/v1/tables/${tableId}/records`;
async function get(url: string, pat = token) {
  const result = await server.app.inject({ url, headers: headers(pat) });
  expect(result.statusCode, result.body).toBe(200);
  return result;
}
async function write(
  tableId: string,
  method: 'POST' | 'PATCH' | 'PUT',
  records: Array<{ id?: string; fields: Record<string, unknown> }>,
  options: { typecast?: boolean; fieldKey?: 'id' | 'name' } = {},
  suffix = '',
) {
  return server.app.inject({
    method,
    url: urlFor(tableId) + suffix,
    headers: headers(),
    payload: { records, ...options },
  });
}
async function command(databaseId: string, input: Record<string, unknown>) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
    },
  });
  expect(response.json<CommandBatchResult>().results[0]?.status, response.body).toBe('applied');
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

it('stores only a hash, lists metadata once, scopes tokens to their owner, and revokes them', async () => {
  const mine = await makeToken();
  expect(mine.token).toMatch(/^rio_pat_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/);
  const listed = await server.app.inject({ url: '/api/tokens', headers: server.owner.headers });
  expect(listed.json<TokenMeta[]>().find((t) => t.id === mine.id)).toMatchObject({
    name: 'Integration',
    databases: 'all',
  });
  expect(listed.body).not.toContain(mine.token);
  expect(listed.body).not.toContain('secret');
  const stored = await query<{ secret_hash: string }>(
    server.pool,
    sql`SELECT * FROM ${ident(server.schemas.app, 'api_tokens')} WHERE id = ${mine.id}`,
  );
  expect(JSON.stringify(stored.rows)).not.toContain(mine.token.slice(-43));
  expect(stored.rows[0]!.secret_hash).toMatch(/^[a-f0-9]{64}$/);
  const member = await server.addMember();
  expect(
    (await server.app.inject({ method: 'DELETE', url: `/api/tokens/${mine.id}`, headers: member.headers }))
      .statusCode,
  ).toBe(404);
  expect((await server.app.inject({ url: '/api/tokens', headers: member.headers })).json()).toEqual([]);
  expect(
    (
      await server.app.inject({
        method: 'DELETE',
        url: `/api/tokens/${mine.id}`,
        headers: server.owner.headers,
      })
    ).statusCode,
  ).toBe(204);
  const revoked = await server.app.inject({ url: '/api/v1/databases', headers: headers(mine) });
  expect(revoked.statusCode).toBe(401);
  expect(revoked.json()).toMatchObject({
    error: { code: 'unauthenticated', messageKey: 'errors.tokenInvalid', message: expect.any(String) },
  });
});

it('refuses tokens to guests, including ones made before they became guests', async () => {
  const guest = await server.addMember({ kind: 'guest' });
  const refused = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: guest.headers,
    payload: { name: 'Guest', scopes: ['data.records:read'], databases: 'all' },
  });
  expect(refused.statusCode).toBe(403);
  expect(refused.json()).toMatchObject({ error: { messageKey: 'errors.tokenGuest' } });
  const member = await server.addMember();
  const made = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: member.headers,
    payload: { name: 'Later a guest', scopes: ['data.records:read'], databases: 'all' },
  });
  const token = made.json<{ token: string }>().token;
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET kind = 'guest' WHERE user_id = ${member.userId}`,
  );
  const used = await server.app.inject({
    url: '/api/v1/databases',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(used.statusCode).toBe(401);
});

it('refuses expired, unknown, malformed, wrong-secret, and deactivated tokens and separates sessions', async () => {
  const expiring = await makeToken();
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'api_tokens')} SET expires_at = now() - interval '1 second' WHERE id = ${expiring.id}`,
  );
  for (const value of [
    expiring.token,
    `rio_pat_${'0'.repeat(32)}_${'A'.repeat(43)}`,
    `rio_pat_${token.id}_${'A'.repeat(43)}`,
    'malformed',
  ]) {
    const response = await server.app.inject({
      url: '/api/v1/databases',
      headers: { authorization: `Bearer ${value}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(value);
    expect(response.json()).toMatchObject({ error: { messageKey: 'errors.tokenInvalid' } });
  }
  expect(
    (await server.app.inject({ url: '/api/v1/databases', headers: server.owner.headers })).statusCode,
  ).toBe(401);
  expect((await server.app.inject({ url: '/api/databases', headers: headers() })).statusCode).toBe(401);
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: '/api/tokens',
        headers: { cookie: server.owner.headers.cookie },
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  const member = await server.addMember();
  const memberToken = await makeToken(undefined, 'all', member);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'users')} SET deactivated_at = now() WHERE id = ${member.userId}`,
  );
  expect(
    (await server.app.inject({ url: '/api/v1/databases', headers: headers(memberToken) })).statusCode,
  ).toBe(401);
});

it('checks scopes, database limits, and token database validation, and throttles use timestamps', async () => {
  const first = await readFixture(server);
  const second = await readFixture(server);
  const limited = await makeToken(
    ['schema.bases:read', 'data.records:read', 'data.records:write'],
    [first.table.databaseId],
  );
  const list = (await get('/api/v1/databases', limited)).json<{ databases: Array<{ id: string }> }>();
  expect(list.databases.map((d) => d.id)).toEqual([first.table.databaseId]);
  for (const url of [`/api/v1/databases/${second.table.databaseId}/tables`, urlFor(second.table.id)])
    expect((await server.app.inject({ url, headers: headers(limited) })).statusCode).toBe(404);
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: urlFor(second.table.id),
        headers: headers(limited),
        payload: { records: [{ fields: {} }] },
      })
    ).statusCode,
  ).toBe(404);
  const readOnly = await makeToken(['data.records:read']);
  expect((await server.app.inject({ url: '/api/v1/databases', headers: headers(readOnly) })).statusCode).toBe(
    403,
  );
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: urlFor(first.table.id),
        headers: headers(readOnly),
        payload: { records: [{ fields: {} }] },
      })
    ).json(),
  ).toMatchObject({ error: { messageKey: 'errors.tokenScope' } });
  const invalid = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: server.owner.headers,
    payload: { name: 'Invalid', scopes: ['data.records:read'], databases: [newId('database')] },
  });
  expect(invalid.statusCode).toBe(422);
  const timestamps = async () =>
    (
      await query<{ last_used_at: Date }>(
        server.pool,
        sql`SELECT last_used_at FROM ${ident(server.schemas.app, 'api_tokens')} WHERE id = ${limited.id}`,
      )
    ).rows[0]!.last_used_at.toISOString();
  const before = await timestamps();
  await get('/api/v1/databases', limited);
  expect(await timestamps()).toBe(before);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'api_tokens')} SET last_used_at = now() - interval '2 minutes' WHERE id = ${limited.id}`,
  );
  await get('/api/v1/databases', limited);
  expect(Date.parse(await timestamps())).toBeGreaterThanOrEqual(Date.parse(before));
  const outsider = await server.addMember();
  const otherToken = await makeToken(undefined, 'all', outsider);
  expect(
    (await server.app.inject({ url: urlFor(first.table.id), headers: headers(otherToken) })).statusCode,
  ).toBe(404);
});

it('reads all shapes and field keys, narrows views with extra filters, lets the caller sort first, and pages to the end', async () => {
  const read = await readFixture(server, [{ type: 'number' }, { type: 'text' }, { type: 'number' }]);
  const [number, text, rank] = read.fields;
  const created = await write(
    read.table.id,
    'POST',
    Array.from({ length: 205 }, (_, n) => ({
      fields: { 'Field 0': n, 'Field 1': `Record ${n}`, 'Field 2': n % 2 },
    })),
  );
  expect(created.statusCode, created.body).toBe(200);
  const keyed = created.json<KeyedRecords>();
  expect(keyed.order).toHaveLength(205);
  expect(keyed.records[keyed.order[0]!]!['Field 0']).toBe(0);
  const list = (await get(urlFor(read.table.id) + '?shape=list&fieldKey=id&pageSize=2')).json<ListRecords>();
  expect(list.records[0]).toMatchObject({ id: keyed.order[0], [number!.id]: 0, [text!.id]: 'Record 0' });
  const airtable = (await get(urlFor(read.table.id) + '?shape=airtable&pageSize=2')).json<AirtableRecords>();
  expect(airtable.records[0]).toMatchObject({
    id: keyed.order[0],
    createdTime: expect.any(String),
    fields: { 'Field 0': 0 },
  });
  expect(airtable.offset).toBeTruthy();
  // Clients written for Airtable send the next page back as `offset`.
  const second = (
    await get(
      `${urlFor(read.table.id)}?shape=airtable&pageSize=2&offset=${encodeURIComponent(airtable.offset!)}`,
    )
  ).json<AirtableRecords>();
  expect(second.records[0]!.id).toBe(keyed.order[2]);
  const single = (
    await get(`${urlFor(read.table.id)}/${keyed.order[0]}?fields=Field%201`)
  ).json<KeyedRecords>();
  expect(single.records[keyed.order[0]!]).toEqual({ 'Field 1': 'Record 0' });
  read.view.config.hiddenFieldIds = [text!.id];
  read.view.config.filter = {
    conjunction: 'and',
    conditions: [{ id: 'v', fieldId: number!.id, operator: 'gte', value: 5 }],
  };
  read.view.config.sorts = [{ fieldId: rank!.id, direction: 'asc' }];
  await saveView(server, read);
  const filter = JSON.stringify({
    conjunction: 'and',
    conditions: [{ id: 'f', fieldId: number!.id, operator: 'lt', value: 10 }],
  });
  const sort = JSON.stringify([{ fieldId: number!.id, direction: 'desc' }]);
  const params = new URLSearchParams({ view: read.view.id, filter, sort });
  const narrowed = (await get(`${urlFor(read.table.id)}?${params}`)).json<KeyedRecords>();
  expect(narrowed.order.map((id) => narrowed.records[id]!['Field 0'])).toEqual([9, 8, 7, 6, 5]);
  expect(Object.values(narrowed.records).every((row) => !('Field 1' in row))).toBe(true);
  let next: string | null = null;
  const seen: string[] = [];
  do {
    const page: KeyedRecords = (
      await get(`${urlFor(read.table.id)}?pageSize=73${next ? `&cursor=${next}` : ''}`)
    ).json();
    expect(page.order.length).toBeLessThanOrEqual(73);
    seen.push(...page.order);
    next = page.next;
  } while (next);
  expect(seen).toEqual(keyed.order);
  const bad = await server.app.inject({ url: urlFor(read.table.id) + '?cursor=invalid', headers: headers() });
  expect(bad.statusCode).toBe(422);
  expect(
    (await server.app.inject({ url: urlFor(read.table.id) + '?pageSize=101', headers: headers() }))
      .statusCode,
  ).toBe(422);
  expect(
    (await server.app.inject({ url: urlFor(read.table.id) + '?locale=invalid_locale', headers: headers() }))
      .statusCode,
  ).toBe(422);
});

it('honors field masks and record predicates for reads, writes, and schema', async () => {
  const read = await readFixture(server, [{ type: 'text' }, { type: 'number' }]);
  const created = await write(read.table.id, 'POST', [
    { fields: { 'Field 0': 'Visible', 'Field 1': 1 } },
    { fields: { 'Field 0': 'Hidden', 'Field 1': 2 } },
  ]);
  const ids = created.json<KeyedRecords>().order;
  const fields = vi
    .spyOn(AccessScope.prototype, 'visibleFields')
    .mockImplementation((_id, items) => items.filter((f) => f.id !== read.fields[1]!.id));
  const records = vi
    .spyOn(AccessScope.prototype, 'recordPredicate')
    .mockImplementation(() => sql`__id <> ${ids[1]!}`);
  try {
    const rows = (await get(urlFor(read.table.id))).json<KeyedRecords>();
    expect(rows.order).toEqual([ids[0]]);
    expect(rows.records[ids[0]!]).toEqual({ 'Field 0': 'Visible' });
    expect(
      (await server.app.inject({ url: `${urlFor(read.table.id)}/${ids[1]}`, headers: headers() })).statusCode,
    ).toBe(404);
    expect(
      (await write(read.table.id, 'PATCH', [{ id: ids[1]!, fields: { 'Field 0': 'Changed' } }])).statusCode,
    ).toBe(404);
    expect(
      (await write(read.table.id, 'PATCH', [{ id: ids[0]!, fields: { 'Field 1': 10 } }])).statusCode,
    ).toBe(422);
    const schema = (await get(`/api/v1/databases/${read.table.databaseId}/tables`)).json<{
      tables: Array<{ fields: Array<{ id: string }> }>;
    }>();
    expect(schema.tables[0]!.fields.map((f) => f.id)).toEqual([read.fields[0]!.id]);
    expect(
      (await write(read.table.id, 'PUT', [{ id: ids[0]!, fields: { 'Field 0': 'Replaced' } }])).statusCode,
    ).toBe(200);
  } finally {
    fields.mockRestore();
    records.mockRestore();
  }
  expect(
    (await get(`${urlFor(read.table.id)}/${ids[0]}`)).json<KeyedRecords>().records[ids[0]!]!['Field 1'],
  ).toBe(1);
});

it('creates, patches, replaces and trashes through history, with groups the app can undo', async () => {
  const read = await readFixture(server, [{ type: 'text' }, { type: 'number' }, { type: 'recordId' }]);
  const create = await write(read.table.id, 'POST', [{ fields: { 'Field 0': 'Original', 'Field 1': 2 } }]);
  expect(create.statusCode, create.body).toBe(200);
  const id = create.json<KeyedRecords>().order[0]!;
  const fetch = async () => (await get(`${urlFor(read.table.id)}/${id}`)).json<KeyedRecords>().records[id]!;
  const patch = await write(read.table.id, 'PATCH', [{ id, fields: { 'Field 1': 3 } }]);
  expect(patch.json<KeyedRecords>().records[id]).toMatchObject({ 'Field 0': 'Original', 'Field 1': 3 });
  await undo(read.table.databaseId, String(patch.headers['x-undo-group-id']));
  expect((await fetch())['Field 1']).toBe(2);
  const replace = await write(read.table.id, 'PUT', [{ id, fields: { 'Field 0': 'Replacement' } }]);
  expect(replace.json<KeyedRecords>().records[id]).toEqual({
    'Field 0': 'Replacement',
    'Field 1': null,
    'Field 2': id,
  });
  await undo(read.table.databaseId, String(replace.headers['x-undo-group-id']));
  expect(await fetch()).toMatchObject({ 'Field 0': 'Original', 'Field 1': 2 });
  // Labeled as JSON with no body, as many clients send a DELETE.
  const deleted = await server.app.inject({
    method: 'DELETE',
    url: `${urlFor(read.table.id)}?records=${id}&shape=list`,
    headers: { ...headers(), 'content-type': 'application/json' },
  });
  expect(deleted.statusCode, deleted.body).toBe(200);
  expect(deleted.json<ListRecords>().records[0]).toMatchObject({ id, 'Field 0': 'Original' });
  expect(
    (await server.app.inject({ url: `${urlFor(read.table.id)}/${id}`, headers: headers() })).statusCode,
  ).toBe(404);
  await undo(read.table.databaseId, String(deleted.headers['x-undo-group-id']));
  expect((await fetch())['Field 1']).toBe(2);
  const changes = await query<{ group_id: string; kind: string }>(
    server.pool,
    sql`SELECT group_id, body ->> 'kind' AS kind
    FROM ${ident(server.schemas.app, 'changes')} WHERE database_id = ${read.table.databaseId}`,
  );
  for (const [response, kind] of [
    [create, 'record.created'],
    [patch, 'record.updated'],
    [replace, 'record.updated'],
    [deleted, 'record.trashed'],
  ] as const) {
    expect(changes.rows).toContainEqual({ group_id: response.headers['x-undo-group-id'], kind });
  }
  await undo(read.table.databaseId, String(create.headers['x-undo-group-id']));
  expect((await get(urlFor(read.table.id))).json<KeyedRecords>().order).toEqual([]);
});

it('gives records it creates their fields’ defaults, keeps empty values it was sent, and lists defaults in metadata', async () => {
  const read = await readFixture(server, [
    { type: 'text' },
    { type: 'number', options: { defaultValue: { kind: 'value', value: 5 } } },
    { type: 'checkbox', options: { defaultValue: { kind: 'value', value: true } } },
    { type: 'user', options: { defaultValue: { kind: 'creator' } } },
  ]);
  const created = await write(read.table.id, 'POST', [
    { fields: { 'Field 0': 'Left out' } },
    { fields: { 'Field 0': 'Sent empty', 'Field 1': null, 'Field 2': false } },
  ]);
  expect(created.statusCode, created.body).toBe(200);
  const body = created.json<KeyedRecords>();
  const [left, sent] = body.order.map((id) => body.records[id]!);
  expect(left).toMatchObject({
    'Field 1': 5,
    'Field 2': true,
    'Field 3': [expect.objectContaining({ id: server.owner.userId })],
  });
  expect(sent).toMatchObject({ 'Field 1': null, 'Field 2': false });
  // Updates never fill a default.
  const id = body.order[1]!;
  const patched = await write(read.table.id, 'PATCH', [{ id, fields: { 'Field 0': 'Changed' } }]);
  expect(patched.json<KeyedRecords>().records[id]).toMatchObject({ 'Field 1': null, 'Field 2': false });
  const schema = (await get(`/api/v1/databases/${read.table.databaseId}/tables`)).json<{
    tables: Array<{ fields: Array<{ id: string; options: Record<string, unknown> }> }>;
  }>();
  expect(schema.tables[0]!.fields.find((field) => field.id === read.fields[1]!.id)!.options).toMatchObject({
    defaultValue: { kind: 'value', value: 5 },
  });
});

it('replaces records past a locked field the replace leaves as it is, and refuses one that would change it', async () => {
  const read = await readFixture(server, [{ type: 'text' }, { type: 'text' }]);
  const approved = read.fields[1]!;
  const created = await write(read.table.id, 'POST', [
    { fields: { 'Field 0': 'Open' } },
    { fields: { 'Field 0': 'Signed off', 'Field 1': 'yes' } },
  ]);
  const [open, done] = created.json<KeyedRecords>().order;
  const lock = await server.app.inject({
    method: 'PUT',
    url: `/api/fields/${approved.id}/permissions`,
    headers: server.owner.headers,
    payload: { restricted: null, locked: { roles: [], users: [] } },
  });
  expect(lock.statusCode, lock.body).toBe(200);
  const editor = await server.addMember();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${read.table.databaseId}, 'user', ${editor.userId}, 'editor')`,
  );
  const theirs = await makeToken(undefined, 'all', editor);
  const send = (method: 'PUT' | 'PATCH', records: Array<{ id: string; fields: Record<string, unknown> }>) =>
    server.app.inject({ method, url: urlFor(read.table.id), headers: headers(theirs), payload: { records } });
  // A replace names every field, and the locked one is already empty here, so it changes nothing there.
  const replaced = await send('PUT', [{ id: open!, fields: { 'Field 0': 'Still open' } }]);
  expect(replaced.statusCode, replaced.body).toBe(200);
  expect(replaced.json<KeyedRecords>().records[open!]).toEqual({ 'Field 0': 'Still open', 'Field 1': null });
  // A record read and sent back whole changes nothing in the locked field either.
  const resent = await send('PUT', [{ id: done!, fields: { 'Field 0': 'Signed off', 'Field 1': 'yes' } }]);
  expect(resent.statusCode, resent.body).toBe(200);
  // Clearing or changing the locked value is a change, which the lock refuses.
  for (const [method, fields] of [
    ['PUT', { 'Field 0': 'Signed off' }],
    ['PATCH', { 'Field 1': 'no' }],
  ] as const) {
    const refused = await send(method, [{ id: done!, fields }]);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json<{ error: { messageKey: string } }>().error.messageKey).toBe(
      'data.access.fieldLocked',
    );
  }
  expect((await get(`${urlFor(read.table.id)}/${done}`)).json<KeyedRecords>().records[done!]).toEqual({
    'Field 0': 'Signed off',
    'Field 1': 'yes',
  });
});

it('round-trips outside values, typecasts clean text, adds options through history, and rejects unknown choices', async () => {
  const read = await readFixture(server, [
    { type: 'text' },
    { type: 'singleSelect', options: { choices: [{ id: newId('choice'), name: 'Known', color: 'blue' }] } },
    { type: 'multipleSelect' },
    { type: 'user' },
    { type: 'date' },
    { type: 'date', options: { includeTime: true } },
    { type: 'percent' },
    { type: 'duration' },
    { type: 'number' },
    { type: 'checkbox' },
  ]);
  const unknown = await write(read.table.id, 'POST', [{ fields: { 'Field 1': 'Unknown' } }]);
  expect(unknown.statusCode).toBe(422);
  expect(unknown.json()).toMatchObject({
    error: { messageKey: 'data.value.unknownChoice', params: { field: 'Field 1', value: 'Unknown' } },
  });
  expect((await write(read.table.id, 'POST', [{ fields: { 'Field 8': '12.5' } }])).statusCode).toBe(422);
  const create = await write(
    read.table.id,
    'POST',
    [
      {
        fields: {
          'Field 0': 'Forms',
          'Field 1': 'Unknown',
          'Field 2': ['One', 'Two'],
          'Field 3': { email: server.owner.email },
          'Field 4': '2026-09-27',
          'Field 5': '2026-09-27',
          'Field 6': '0.25',
          'Field 7': '3723',
          'Field 8': '12.5',
          'Field 9': 'true',
        },
      },
    ],
    { typecast: true },
  );
  expect(create.statusCode, create.body).toBe(200);
  const record = create.json<KeyedRecords>();
  expect(record.records[record.order[0]!]).toMatchObject({
    'Field 1': 'Unknown',
    'Field 2': ['One', 'Two'],
    'Field 3': [{ id: server.owner.userId, name: 'Owner', email: server.owner.email }],
    'Field 4': '2026-09-27',
    'Field 5': '2026-09-27T00:00:00.000Z',
    'Field 6': 0.25,
    'Field 7': 3723,
    'Field 8': 12.5,
    'Field 9': true,
  });
  const schema = (await get(`/api/v1/databases/${read.table.databaseId}/tables`)).json<{
    tables: Array<{ fields: Array<{ options: { choices?: Array<{ name: string }> } }> }>;
  }>();
  expect(schema.tables[0]!.fields[1]!.options.choices?.map((c) => c.name)).toEqual(['Known', 'Unknown']);
  await undo(read.table.databaseId, String(create.headers['x-undo-group-id']));
  expect((await get(urlFor(read.table.id))).json<KeyedRecords>().order).toEqual([]);
  expect((await write(read.table.id, 'POST', [{ fields: { 'Field 1': 'Unknown' } }])).statusCode).toBe(422);
  const byId = await write(
    read.table.id,
    'POST',
    [{ fields: { [read.fields[1]!.id]: 'Known', [read.fields[3]!.id]: server.owner.userId } }],
    { fieldKey: 'id' },
    '?shape=airtable',
  );
  expect(byId.statusCode, byId.body).toBe(200);
  expect(byId.json<AirtableRecords>().records[0]!.fields[read.fields[1]!.id]).toBe('Known');
});

it('formats every scalar field family with locale, time zone, choices and people', async () => {
  const choice = { id: newId('choice'), name: 'Selected', color: 'blue' as const };
  const specs: Array<z.input<typeof FieldSpec>> = [
    { type: 'text' },
    { type: 'longText' },
    { type: 'email' },
    { type: 'url' },
    { type: 'phone' },
    { type: 'number', options: { precision: 2 } },
    { type: 'currency' },
    { type: 'percent', options: { precision: 1 } },
    { type: 'duration', options: { format: 'h:mm:ss.ss' } },
    { type: 'rating' },
    { type: 'checkbox' },
    { type: 'singleSelect', options: { choices: [choice] } },
    { type: 'multipleSelect', options: { choices: [choice] } },
    { type: 'date', options: { dateFormat: 'iso' } },
    { type: 'date', options: { includeTime: true, dateFormat: 'iso', timeFormat: '24h' } },
    { type: 'user' },
    { type: 'createdBy' },
    { type: 'lastModifiedBy' },
    { type: 'createdTime', options: { dateFormat: 'iso' } },
    { type: 'lastModifiedTime', options: { dateFormat: 'iso' } },
    { type: 'recordId' },
    { type: 'autoNumber' },
    { type: 'formula', options: { expression: '2 + 3', precision: 2 } },
  ];
  const read = await readFixture(server, specs);
  const values: unknown[] = [
    'Text',
    'Long\nText',
    'a@example.test',
    'https://example.test',
    '+1 555 0100',
    1234.5,
    12.5,
    0.25,
    3723.45,
    4,
    true,
    'Selected',
    ['Selected'],
    '2026-09-27',
    '2026-09-27T12:00:00Z',
    server.owner.userId,
  ];
  const created = await write(read.table.id, 'POST', [
    { fields: Object.fromEntries(values.map((v, i) => [`Field ${i}`, v])) },
  ]);
  expect(created.statusCode, created.body).toBe(200);
  const id = created.json<KeyedRecords>().order[0]!;
  const response = (
    await get(`${urlFor(read.table.id)}?cellFormat=string&locale=en-US&timeZone=America%2FLos_Angeles`)
  ).json<KeyedRecords>().records[id]!;
  expect(response).toMatchObject({
    'Field 0': 'Text',
    'Field 1': 'Long\nText',
    'Field 2': 'a@example.test',
    'Field 3': 'https://example.test',
    'Field 4': '+1 555 0100',
    'Field 5': '1,234.50',
    'Field 6': '$12.50',
    'Field 7': '25.0%',
    'Field 8': '1:02:03.45',
    'Field 9': '4',
    'Field 10': 'checked',
    'Field 11': 'Selected',
    'Field 12': 'Selected',
    'Field 13': '2026-09-27',
    'Field 14': '2026-09-27 05:00',
    'Field 15': 'Owner',
    'Field 16': 'Owner',
    'Field 17': 'Owner',
    'Field 20': id,
    'Field 21': '1',
    'Field 22': '5.00',
  });
  expect(Object.values(response).every((v) => typeof v === 'string')).toBe(true);
  const localized = (
    await get(`${urlFor(read.table.id)}?cellFormat=string&locale=de-DE`)
  ).json<KeyedRecords>().records[id]!;
  expect(localized['Field 5']).toBe('1.234,50');
});

it('round-trips files and linked records and formats computed relation families', async () => {
  const source = await readFixture(server, [{ type: 'text' }, { type: 'attachment' }]);
  const tableId = newId('table');
  const primary = newId('field');
  const number = newId('field');
  await command(source.table.databaseId, {
    kind: 'table.create',
    table: {
      id: tableId,
      name: 'Targets',
      fields: [
        { id: primary, name: 'Name', type: 'text' },
        { id: number, name: 'Amount', type: 'number' },
      ],
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  const link = newId('field');
  await command(source.table.databaseId, {
    kind: 'field.create',
    tableId: source.table.id,
    field: { id: link, name: 'Link', type: 'link', options: { linkedTableId: tableId } },
  });
  for (const [type, name] of [
    ['lookup', 'Lookup'],
    ['rollup', 'Rollup'],
    ['count', 'Count'],
  ] as const)
    await command(source.table.databaseId, {
      kind: 'field.create',
      tableId: source.table.id,
      field: { id: newId('field'), name, type, options: { linkFieldId: link, targetFieldId: number } },
    });
  const target = await write(tableId, 'POST', [{ fields: { Name: 'Target', Amount: 1234 } }]);
  const targetId = target.json<KeyedRecords>().order[0]!;
  const upload = await server.app.inject({
    method: 'POST',
    url: `/api/tables/${source.table.id}/fields/${source.fields[1]!.id}/files`,
    headers: {
      ...server.owner.headers,
      'content-type': 'application/octet-stream',
      'x-file-name': 'notes.txt',
    },
    payload: Buffer.from('test file'),
  });
  expect(upload.statusCode, upload.body).toBe(200);
  const file = upload.json<{ id: string; url: string; size: number; type: string; thumbnails: unknown }>();
  const response = await write(source.table.id, 'POST', [
    { fields: { 'Field 0': 'Source', 'Field 1': [file], Link: [targetId] } },
  ]);
  expect(response.statusCode, response.body).toBe(200);
  const id = response.json<KeyedRecords>().order[0]!;
  expect(response.json<KeyedRecords>().records[id]).toMatchObject({
    Link: [targetId],
    'Field 1': [
      {
        id: file.id,
        filename: 'notes.txt',
        url: file.url,
        size: file.size,
        type: file.type,
        thumbnails: file.thumbnails,
      },
    ],
    Lookup: [1234],
    Rollup: 1234,
    Count: 1,
  });
  const formatted = (await get(`${urlFor(source.table.id)}?cellFormat=string`)).json<KeyedRecords>().records[
    id
  ]!;
  expect(formatted).toMatchObject({
    Link: 'Target',
    'Field 1': 'notes.txt',
    Lookup: '1,234',
    Rollup: '1,234',
    Count: '1',
  });
});

it('changes home through scoped, idempotent commands and lists the resulting tags', async () => {
  const writer = await makeToken(['schema.bases:read', 'schema.bases:write']);
  const tagId = newId('tag');
  const payload = {
    id: newId('command'),
    action: { kind: 'tag.create', tagId, name: 'Planning label', color: '#007aff', visibility: 'private' },
  };
  const send = (pat: TokenCreated) =>
    server.app.inject({
      method: 'POST',
      url: '/api/v1/home/commands',
      headers: headers(pat),
      payload,
    });
  expect((await send(token)).statusCode).toBe(403);
  const created = await send(writer);
  expect(created.statusCode, created.body).toBe(200);
  expect(created.json()).toMatchObject({ id: payload.id, status: 'applied' });
  expect((await send(writer)).json()).toMatchObject({ id: payload.id, status: 'duplicate' });
  const listing = await get('/api/v1/home', writer);
  expect(listing.json().tags).toContainEqual(expect.objectContaining({ id: tagId, name: 'Planning label' }));
});

it('accepts one Home action per public command, as the API documents', async () => {
  const writer = await makeToken(['schema.bases:read', 'schema.bases:write']);
  const action = {
    kind: 'tag.create',
    tagId: newId('tag'),
    name: 'Grouped label',
    color: '#007aff',
    visibility: 'private',
  };
  const grouped = await server.app.inject({
    method: 'POST',
    url: '/api/v1/home/commands',
    headers: headers(writer),
    payload: { id: newId('command'), action, actions: [action] },
  });
  expect(grouped.statusCode, grouped.body).toBe(422);
  const listing = await get('/api/v1/home', writer);
  expect(listing.json().tags).not.toContainEqual(expect.objectContaining({ id: action.tagId }));
});

it('serves a public OpenAPI 3.1 document for every route and structured errors for unknown routes', async () => {
  const response = await server.app.inject({ url: '/api/v1/openapi.json' });
  expect(response.statusCode, response.body).toBe(200);
  const document = response.json<{ openapi: string; paths: Record<string, Record<string, unknown>> }>();
  expect(document.openapi).toBe('3.1.0');
  expect(Object.keys(document.paths['/api/v1/tables/{tableId}/records']!).sort()).toEqual([
    'delete',
    'get',
    'patch',
    'post',
    'put',
  ]);
  expect(Object.keys(document.paths)).toHaveLength(50);
  expect(Object.keys(document.paths['/api/me/sessions']!)).toEqual(['get']);
  expect(Object.keys(document.paths['/api/me/sessions/end']!)).toEqual(['post']);
  expect(document.paths['/api/me/sessions']!.get).toMatchObject({ security: [{ session: [] }] });
  expect(document.paths['/api/me/sessions/end']!.post).toMatchObject({ security: [{ session: [] }] });
  expect(Object.keys(document.paths['/api/v1/tables/{tableId}/records/{recordId}/comments']!)).toEqual([
    'get',
    'post',
  ]);
  for (const [url, methods] of [
    ['/api/v1/databases/{databaseId}/tables', ['get', 'post']],
    ['/api/v1/tables/{tableId}', ['patch', 'delete']],
    ['/api/v1/tables/{tableId}/fields', ['post']],
    ['/api/v1/fields/{fieldId}', ['patch', 'delete']],
    ['/api/v1/tables/{tableId}/views', ['get', 'post']],
    ['/api/v1/views/{viewId}', ['patch', 'delete']],
    ['/api/v1/tables/{tableId}/records/duplicate', ['post']],
    ['/api/v1/fields/{fieldId}/duplicate', ['post']],
    ['/api/v1/tables/{tableId}/duplicate', ['post']],
    ['/api/v1/duplicate-jobs/{jobId}', ['get']],
    ['/api/v1/duplicate-jobs/{jobId}/cancel', ['post']],
  ] as const)
    expect(Object.keys(document.paths[url]!), url).toEqual(methods);
  expect(Object.keys(document.paths['/api/v1/tables/{tableId}/fields/{fieldId}/files']!)).toEqual(['post']);
  expect(Object.keys(document.paths['/api/v1/imports/document']!)).toEqual(['post']);
  expect(Object.keys(document.paths['/api/v1/tables/{tableId}/records/move']!)).toEqual(['post']);
  expect(Object.keys(document.paths['/api/v1/remote-tools']!)).toEqual(['get']);
  expect(Object.keys(document.paths['/api/v1/views/{viewId}/grid']!)).toEqual(['patch']);
  expect(document.paths).not.toHaveProperty('/api/v1/views/{viewId}/move-records');
  expect(Object.keys(document.paths['/api/v1/databases/{databaseId}/joined-tables']!)).toEqual(['post']);
  expect(document.paths['/api/v1/databases/{databaseId}/column-suggestions']!.post).toMatchObject({
    operationId: 'suggestJoinedColumns',
    requestBody: {
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ColumnSuggestionsRequest' } } },
    },
    responses: {
      '200': {
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ColumnSuggestions' } } },
      },
    },
  });
  expect(document.paths['/api/v1/tables/{tableId}/joined-columns']!.patch).toMatchObject({
    operationId: 'configureJoinedColumns',
    requestBody: {
      content: { 'application/json': { schema: { $ref: '#/components/schemas/JoinedColumns' } } },
    },
  });
  expect(Object.keys(document.paths['/api/v1/tables/{tableId}/overrides']!)).toEqual(['patch']);
  expect(Object.keys(document.paths['/api/v1/tables/{tableId}/clear-overrides']!)).toEqual(['post']);
  expect(Object.keys(document.paths['/api/v1/tables/{tableId}/sync-history']!)).toEqual(['get']);
  expect(Object.keys(document.paths['/api/v1/tables/{tableId}/records/{recordId}/history']!)).toEqual([
    'get',
  ]);
  expect(Object.keys(document.paths['/api/v1/knowledge/libraries']!)).toEqual(['get']);
  expect(Object.keys(document.paths['/api/v1/knowledge/libraries/{libraryId}/documents']!)).toEqual(['get']);
  expect(Object.keys(document.paths['/api/v1/knowledge/search-documents']!)).toEqual(['post']);
  expect(Object.keys(document.paths['/api/v1/knowledge/library-commands']!)).toEqual(['post']);
  expect(Object.keys(document.paths['/api/v1/knowledge/similar']!)).toEqual(['post']);
  expect(Object.keys(document.paths['/api/v1/knowledge/search']!)).toEqual(['post']);
  expect(Object.keys(document.paths['/api/v1/knowledge/memories']!)).toEqual(['post']);
  expect(Object.keys(document.paths['/api/v1/databases/{databaseId}/memories']!)).toEqual(['get']);
  expect(document.paths['/api/v1/home']).toHaveProperty('get');
  expect(Object.keys(document.paths['/api/v1/home/commands']!)).toEqual(['post']);
  expect(document.paths['/api/v1/tables/{tableId}/views']).toHaveProperty('get');
  expect(Object.keys(document.paths['/api/v1/tables/{tableId}/records/locks']!)).toEqual(['put']);
  const resolveReferences = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if ('$ref' in value && typeof value.$ref === 'string') {
      expect(value.$ref).toMatch(/^#\/components\/schemas\//);
      let target: unknown = document;
      for (const part of value.$ref.slice(2).split('/')) {
        expect(target).toBeTypeOf('object');
        target = (target as Record<string, unknown>)[part.replaceAll('~1', '/').replaceAll('~0', '~')];
      }
      expect(target, value.$ref).toBeDefined();
    }
    for (const child of Object.values(value)) resolveReferences(child);
  };
  resolveReferences(document);
  const missing = await server.app.inject({ url: '/api/v1/missing' });
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toMatchObject({
    error: { messageKey: 'errors.notFound', message: 'The requested resource was not found.' },
  });
});

it('configures computed pins and reads their history through scoped API routes', async () => {
  const fixture = await readFixture(server);
  const formula = newId('field');
  const record = newId('record');
  await command(fixture.table.databaseId, {
    kind: 'field.create',
    tableId: fixture.table.id,
    field: { id: formula, name: 'Computed', type: 'formula', options: { expression: '2 * 3' } },
  });
  await command(fixture.table.databaseId, {
    kind: 'record.create',
    tableId: fixture.table.id,
    records: [{ id: record, values: {} }],
  });
  const settingsUrl = `/api/v1/tables/${fixture.table.id}/overrides`;
  const refused = await server.app.inject({
    method: 'PATCH',
    url: settingsUrl,
    headers: headers(),
    payload: { allowComputedOverrides: true },
  });
  expect(refused.statusCode).toBe(403);
  const manager = await makeToken(
    ['schema.bases:write', 'data.records:read', 'data.records:write'],
    [fixture.table.databaseId],
  );
  const settings = await server.app.inject({
    method: 'PATCH',
    url: settingsUrl,
    headers: headers(manager),
    payload: { allowComputedOverrides: true, historyRetentionDays: 30 },
  });
  expect(settings.statusCode, settings.body).toBe(200);
  expect(settings.json<CommandBatchResult>().results[0]?.status).toBe('applied');
  const edited = await write(fixture.table.id, 'PATCH', [{ id: record, fields: { [formula]: 12 } }], {
    fieldKey: 'id',
  });
  expect(edited.statusCode, edited.body).toBe(200);
  const history = await get(`/api/v1/tables/${fixture.table.id}/records/${record}/history`);
  expect(history.json()).toMatchObject({
    entries: expect.arrayContaining([
      expect.objectContaining({ changes: [{ fieldId: formula, before: 6, after: 12 }] }),
    ]),
  });
  const cleared = await server.app.inject({
    method: 'POST',
    url: `/api/v1/tables/${fixture.table.id}/clear-overrides`,
    headers: headers(manager),
    payload: { records: [{ id: record, fieldIds: [formula] }] },
  });
  expect(cleared.statusCode, cleared.body).toBe(200);
  expect(cleared.json<CommandBatchResult>().results[0]?.status).toBe('applied');
  expect((await get(`/api/v1/tables/${fixture.table.id}/sync-history`)).json()).toEqual({
    runs: [],
    next: null,
  });
});

it('answers a table out of reach the same way as one that isn’t there', async () => {
  const reached = await readFixture(server);
  const beyond = await readFixture(server);
  // The token names one database, so a table of the other is as unseen as one that never existed.
  const limited = await makeToken(
    ['schema.bases:write', 'data.records:read', 'data.records:write'],
    [reached.table.databaseId],
  );
  const asked = async (tableId: string, recordId: string) => {
    const calls = [
      {
        method: 'PATCH',
        url: `/api/v1/tables/${tableId}/overrides`,
        payload: { allowComputedOverrides: true },
      },
      {
        method: 'POST',
        url: `/api/v1/tables/${tableId}/clear-overrides`,
        payload: { records: [{ id: recordId, fieldIds: [newId('field')] }] },
      },
      { method: 'GET', url: `/api/v1/tables/${tableId}/sync-history` },
      { method: 'GET', url: `/api/v1/tables/${tableId}/records/${recordId}/history` },
    ] as const;
    const answers = [];
    for (const call of calls) {
      const response = await server.app.inject({
        method: call.method,
        url: call.url,
        headers: headers(limited),
        ...('payload' in call ? { payload: call.payload } : {}),
      });
      answers.push([
        response.statusCode,
        response.json<{ error?: { messageKey: string } }>().error?.messageKey ?? null,
      ]);
    }
    return answers;
  };
  const missing = await asked(newId('table'), newId('record'));
  const hidden = await asked(beyond.table.id, newId('record'));
  expect(hidden, 'neither answer says whether the ID exists').toEqual(missing);
  expect(missing.map(([status]) => status)).toEqual([404, 404, 404, 404]);
});

it('keeps lookup lists flat and resolves looked-up file metadata and display names', async () => {
  const source = await readFixture(server, [{ type: 'text' }]);
  const target = newId('table');
  const choices = newId('field');
  const files = newId('field');
  await command(source.table.databaseId, {
    kind: 'table.create',
    table: {
      id: target,
      name: 'Lookup targets',
      fields: [
        { id: newId('field'), name: 'Name', type: 'text' },
        {
          id: choices,
          name: 'Choices',
          type: 'multipleSelect',
          options: {
            choices: [
              { id: newId('choice'), name: 'First', color: 'blue' },
              { id: newId('choice'), name: 'Second', color: 'green' },
            ],
          },
        },
        { id: files, name: 'Files', type: 'attachment' },
      ],
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  const link = newId('field');
  await command(source.table.databaseId, {
    kind: 'field.create',
    tableId: source.table.id,
    field: { id: link, name: 'Link', type: 'link', options: { linkedTableId: target } },
  });
  for (const [targetFieldId, name] of [
    [choices, 'Choices'],
    [files, 'Files'],
  ] as const)
    await command(source.table.databaseId, {
      kind: 'field.create',
      tableId: source.table.id,
      field: { id: newId('field'), name, type: 'lookup', options: { linkFieldId: link, targetFieldId } },
    });
  const upload = await server.app.inject({
    method: 'POST',
    url: `/api/tables/${target}/fields/${files}/files`,
    headers: {
      ...server.owner.headers,
      'content-type': 'application/octet-stream',
      'x-file-name': 'lookup.txt',
    },
    payload: Buffer.from('lookup file'),
  });
  expect(upload.statusCode, upload.body).toBe(200);
  const file = upload.json<{ id: string }>();
  const targetRecord = await write(target, 'POST', [
    { fields: { Name: 'Target', Choices: ['First', 'Second'], Files: [file] } },
  ]);
  expect(targetRecord.statusCode, targetRecord.body).toBe(200);
  const response = await write(source.table.id, 'POST', [
    { fields: { Link: targetRecord.json<KeyedRecords>().order } },
  ]);
  expect(response.statusCode, response.body).toBe(200);
  const id = response.json<KeyedRecords>().order[0]!;
  expect(response.json<KeyedRecords>().records[id]).toMatchObject({
    Choices: ['First', 'Second'],
    Files: [{ id: file.id, filename: 'lookup.txt' }],
  });
  const formatted = (await get(`${urlFor(source.table.id)}?cellFormat=string`)).json<KeyedRecords>().records[
    id
  ]!;
  expect(formatted).toMatchObject({ Choices: 'First, Second', Files: 'lookup.txt' });
});

type SchemaTables = {
  tables: Array<{
    id: string;
    name: string;
    fields: Array<{ id: string; name: string; type: string; options: { inverseFieldId?: string | null } }>;
  }>;
};

it('gives links made with their table another side, writes through them, and preserves both sides like manual trash and restoration', async () => {
  const source = await readFixture(server, [{ type: 'text' }]);
  const databaseId = source.table.databaseId;
  const tableId = newId('table');
  const owner = newId('field');
  const parent = newId('field');
  const groupId = newId('action');
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId,
          kind: 'table.create',
          table: {
            id: tableId,
            name: 'Targets',
            fields: [
              { id: newId('field'), name: 'Name', type: 'text' },
              { id: owner, name: 'Owner', type: 'link', options: { linkedTableId: source.table.id } },
              // A link to the table itself gets its other side there too.
              { id: parent, name: 'Parent', type: 'link', options: { linkedTableId: tableId } },
            ],
            view: { id: newId('view'), name: 'Grid' },
          },
        },
      ],
    },
  });
  expect(response.json<CommandBatchResult>().results[0]?.status, response.body).toBe('applied');
  const schema = async () => (await get(`/api/v1/databases/${databaseId}/tables`)).json<SchemaTables>();
  const tables = (await schema()).tables;
  const made = tables.find((t) => t.id === tableId)!;
  const linked = tables.find((t) => t.id === source.table.id)!;
  const ownerField = made.fields.find((f) => f.id === owner)!;
  const parentField = made.fields.find((f) => f.id === parent)!;
  const ownerInverse = linked.fields.find((f) => f.id === ownerField.options.inverseFieldId)!;
  const parentInverse = made.fields.find((f) => f.id === parentField.options.inverseFieldId)!;
  expect(ownerInverse).toMatchObject({ name: 'Targets', type: 'link', options: { inverseFieldId: owner } });
  expect(parentInverse).toMatchObject({ name: 'Targets', type: 'link', options: { inverseFieldId: parent } });
  const changes = await query<{ kind: string }>(
    server.pool,
    sql`SELECT kind FROM ${ident(server.schemas.app, 'changes')} WHERE group_id = ${groupId} ORDER BY seq`,
  );
  expect(changes.rows.map((row) => row.kind)).toEqual(['table.created', 'field.created', 'field.created']);
  const person = (
    await write(source.table.id, 'POST', [{ fields: { 'Field 0': 'Person' } }])
  ).json<KeyedRecords>().order[0]!;
  const target = await write(tableId, 'POST', [{ fields: { Name: 'Target', Owner: [person] } }]);
  expect(target.statusCode, target.body).toBe(200);
  const targetId = target.json<KeyedRecords>().order[0]!;
  const child = await write(tableId, 'POST', [{ fields: { Name: 'Child', Parent: [targetId] } }]);
  expect(child.statusCode, child.body).toBe(200);
  expect(
    (await get(`${urlFor(source.table.id)}/${person}`)).json<KeyedRecords>().records[person],
  ).toMatchObject({
    Targets: [targetId],
  });
  expect((await get(`${urlFor(tableId)}/${targetId}`)).json<KeyedRecords>().records[targetId]).toMatchObject({
    Owner: [person],
    Targets: [child.json<KeyedRecords>().order[0]],
  });
  await command(databaseId, { kind: 'table.trash', tableId });
  const manualTrash = (await schema()).tables;
  const manualPerson = (await get(`${urlFor(source.table.id)}/${person}`)).json<KeyedRecords>().records[
    person
  ];
  expect(manualTrash[0]!.fields).toEqual(linked.fields);
  await command(databaseId, { kind: 'table.restore', tableId });
  for (let cycle = 0; cycle < 2; cycle++) {
    await undo(databaseId, groupId, true);
    const undone = (await schema()).tables;
    expect(undone.map((t) => t.id)).toEqual([source.table.id]);
    expect(undone[0]!.fields).toEqual(manualTrash[0]!.fields);
    expect((await get(`${urlFor(source.table.id)}/${person}`)).json<KeyedRecords>().records[person]).toEqual(
      manualPerson,
    );
    const redo = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/redo`,
      headers: server.owner.headers,
      payload: { clientId: newId('client'), commandId: newId('command'), groupId },
    });
    expect(redo.json<UndoResult>().status, redo.body).toBe('applied');
    const redone = (await schema()).tables;
    expect(redone.map((t) => t.id).sort()).toEqual([source.table.id, tableId].sort());
    expect(redone.find((t) => t.id === source.table.id)!.fields).toEqual(linked.fields);
    expect(redone.find((t) => t.id === tableId)!.fields).toEqual(made.fields);
    expect(
      (await get(`${urlFor(source.table.id)}/${person}`)).json<KeyedRecords>().records[person],
    ).toMatchObject({
      Targets: [targetId],
    });
    expect(
      (await get(`${urlFor(tableId)}/${targetId}`)).json<KeyedRecords>().records[targetId],
    ).toMatchObject({
      Owner: [person],
      Targets: [child.json<KeyedRecords>().order[0]],
    });
  }
});

it('repairs links made with their table before they had another side, and says why a link to a trashed table cannot change', async () => {
  const source = await readFixture(server, [{ type: 'text' }]);
  const databaseId = source.table.databaseId;
  const target = newId('table');
  await command(databaseId, {
    kind: 'table.create',
    table: {
      id: target,
      name: 'Targets',
      fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  // A link as `table.create` stored one before it made the other side: no pair and no junction.
  const link = newId('field');
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'fields')}
    (id, org_id, table_id, name, type, options, column_name, position)
    VALUES (${link}, ${server.owner.info.org.id}, ${source.table.id}, 'Old link', 'link',
      ${JSON.stringify({ linkedTableId: target, inverseFieldId: null, prefersSingle: false })}::jsonb, ${link}, 5)`,
  );
  const targetRecord = (await write(target, 'POST', [{ fields: { Name: 'Target' } }])).json<KeyedRecords>()
    .order[0]!;
  const unpaired = await write(source.table.id, 'POST', [{ fields: { 'Old link': [targetRecord] } }]);
  expect(unpaired.statusCode).toBe(422);
  expect(unpaired.json()).toMatchObject({
    error: { messageKey: 'data.link.unavailable', params: { field: 'Old link' } },
  });
  const repair = renderSql(m0034.sql, server.schemas);
  await server.pool.query(repair);
  // Running it again finds nothing left to repair.
  await server.pool.query(repair);
  const tables = (await get(`/api/v1/databases/${databaseId}/tables`)).json<SchemaTables>().tables;
  const repaired = tables.find((t) => t.id === source.table.id)!.fields.find((f) => f.id === link)!;
  const inverses = tables.find((t) => t.id === target)!.fields.filter((f) => f.type === 'link');
  expect(inverses).toEqual([
    expect.objectContaining({
      id: repaired.options.inverseFieldId,
      name: 'Records',
      options: expect.objectContaining({ inverseFieldId: link }),
    }),
  ]);
  const written = await write(source.table.id, 'POST', [
    { fields: { 'Field 0': 'Linked', 'Old link': [targetRecord] } },
  ]);
  expect(written.statusCode, written.body).toBe(200);
  const sourceRecord = written.json<KeyedRecords>().order[0]!;
  expect(
    (await get(`${urlFor(target)}/${targetRecord}`)).json<KeyedRecords>().records[targetRecord],
  ).toMatchObject({
    Records: [sourceRecord],
  });
  await command(databaseId, { kind: 'table.trash', tableId: target });
  const trashed = await write(source.table.id, 'POST', [{ fields: { 'Old link': [targetRecord] } }]);
  expect(trashed.statusCode).toBe(422);
  expect(trashed.json()).toMatchObject({
    error: {
      messageKey: 'data.link.unavailable',
      message: expect.stringContaining('trash'),
      params: { field: 'Old link' },
    },
  });
});

it('keeps caller sorts primary and view sorts as tie breakers for grouped API reads', async () => {
  const read = await readFixture(server, [{ type: 'text' }, { type: 'number' }, { type: 'number' }]);
  const [name, amount, rank] = read.fields;
  const created = await write(read.table.id, 'POST', [
    { fields: { 'Field 0': 'A', 'Field 1': 10, 'Field 2': 0 } },
    { fields: { 'Field 0': 'B', 'Field 1': 1, 'Field 2': 2 } },
    { fields: { 'Field 0': 'C', 'Field 1': 1, 'Field 2': 1 } },
  ]);
  expect(created.statusCode, created.body).toBe(200);
  await command(read.table.databaseId, {
    kind: 'view.update',
    viewId: read.view.id,
    config: {
      groups: [{ fieldId: name!.id, direction: 'asc' }],
      sorts: [{ fieldId: rank!.id, direction: 'asc' }],
    },
  });
  const params = new URLSearchParams({
    view: read.view.id,
    sort: JSON.stringify([{ fieldId: amount!.id, direction: 'asc' }]),
    pageSize: '1',
  });
  const names: unknown[] = [];
  let next: string | null = null;
  do {
    const result: KeyedRecords = (
      await get(`${urlFor(read.table.id)}?${params}${next ? `&cursor=${next}` : ''}`)
    ).json();
    names.push(...result.order.map((id) => result.records[id]!['Field 0']));
    next = result.next;
  } while (next);
  expect(names).toEqual(['C', 'B', 'A']);
  const grid = await server.app.inject({
    url: `/api/views/${read.view.id}/rows`,
    headers: server.owner.headers,
  });
  expect(grid.statusCode, grid.body).toBe(200);
  expect(grid.json().rows.map((row: { values: Record<string, unknown> }) => row.values[name!.id])).toEqual([
    'A',
    'B',
    'C',
  ]);
  expect(grid.json().groups).toHaveLength(3);
});

it.each(['views', 'tables'])(
  'redacts restricted and derived field values from listed %s',
  async (endpoint) => {
    const fixture = await readFixture(server, [{ type: 'text' }, { type: 'number' }]);
    const databaseId = fixture.table.databaseId;
    const [visible, restricted] = fixture.fields;
    const derivedId = newId('field');
    await command(databaseId, {
      kind: 'field.create',
      tableId: fixture.table.id,
      field: {
        id: derivedId,
        name: 'Derived',
        type: 'formula',
        options: { expression: `{${restricted!.name}} * 2` },
      },
    });
    await command(databaseId, {
      kind: 'view.update',
      viewId: fixture.view.id,
      config: {
        filter: {
          conjunction: 'and',
          conditions: [
            { id: 'visible', fieldId: visible!.id, operator: 'is', value: 'Visible' },
            { id: 'restricted', fieldId: restricted!.id, operator: 'eq', value: 987654.25 },
            {
              conjunction: 'or',
              conditions: [{ id: 'derived', fieldId: derivedId, operator: 'gt', value: 1975308.5 }],
            },
          ],
        },
      },
    });
    const member = await server.addMember();
    const grant = await server.app.inject({
      method: 'PUT',
      url: `/api/databases/${databaseId}/grants`,
      headers: server.owner.headers,
      payload: { principal: { kind: 'user', id: member.userId }, role: 'reader' },
    });
    expect(grant.statusCode, grant.body).toBe(200);
    const permission = await server.app.inject({
      method: 'PUT',
      url: `/api/fields/${restricted!.id}/permissions`,
      headers: server.owner.headers,
      payload: { restricted: { roles: [], users: [] }, locked: null },
    });
    expect(permission.statusCode, permission.body).toBe(200);
    const schema = await server.app.inject({
      url: `/api/databases/${databaseId}/schema`,
      headers: member.headers,
    });
    expect(schema.statusCode, schema.body).toBe(200);
    expect(schema.json<DatabaseSchema>().fields.map((field) => field.id)).toEqual([visible!.id]);
    expect(schema.body).not.toContain('987654.25');
    expect(schema.body).not.toContain('1975308.5');
    const path =
      endpoint === 'views'
        ? `/api/v1/tables/${fixture.table.id}/views`
        : `/api/v1/databases/${databaseId}/tables`;
    const owner = await get(path);
    expect(owner.body).toContain('987654.25');
    expect(owner.body).toContain('1975308.5');
    const reader = await get(path, await makeToken(['schema.bases:read'], 'all', member));
    expect(reader.body).not.toContain('987654.25');
    expect(reader.body).not.toContain('1975308.5');
    expect(reader.body).toContain('Visible');
    const views =
      endpoint === 'views'
        ? reader.json<{ views: ViewMeta[] }>().views
        : reader.json<{ tables: Array<{ views: ViewMeta[] }> }>().tables[0]!.views;
    expect(views).toEqual(schema.json<DatabaseSchema>().views);
  },
);

it('lists views through schema scope and database access, including only live tables', async () => {
  const fixture = await readFixture(server, [{ type: 'text' }]);
  const path = `/api/v1/tables/${fixture.table.id}/views`;
  const schemaToken = await makeToken(['schema.bases:read']);
  const response = await get(path, schemaToken);
  expect(response.json().views[0]).toMatchObject({ tableId: fixture.table.id, name: 'Grid' });
  expect(
    (await server.app.inject({ url: path, headers: headers(await makeToken(['data.records:read'])) }))
      .statusCode,
  ).toBe(403);
  const member = await server.addMember();
  expect(
    (
      await server.app.inject({
        url: path,
        headers: headers(await makeToken(['schema.bases:read'], 'all', member)),
      })
    ).statusCode,
  ).toBe(404);
  await command(fixture.table.databaseId, {
    kind: 'table.create',
    table: {
      id: newId('table'),
      name: 'Remaining table',
      fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  await command(fixture.table.databaseId, { kind: 'table.trash', tableId: fixture.table.id });
  expect((await server.app.inject({ url: path, headers: headers(schemaToken) })).statusCode).toBe(404);
});
