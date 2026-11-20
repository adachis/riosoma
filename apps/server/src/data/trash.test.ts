import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  Command,
  DatabaseCreate,
  DatabaseSchema,
  DatabaseTrash,
  TrashedDatabases,
  TrashedRecordsPage,
  TRASH_RETENTION_DAYS,
  newId,
  type DatabaseSummary,
  type CommandBatchResult,
  type UndoResult,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { purgeTrash } from './purge.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'trash');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});
const clientId = newId('client');
const newTable = (name: string) => ({
  id: newId('table'),
  name,
  fields: [
    { id: newId('field'), name: 'Name', type: 'text' },
    { id: newId('field'), name: 'Notes', type: 'text' },
  ],
  view: { id: newId('view'), name: 'Grid' },
});
async function create() {
  const input = DatabaseCreate.parse({ id: newId('database'), name: 'Database', table: newTable('First') });
  const result = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: input,
  });
  expect(result.statusCode, result.body).toBe(200);
  return DatabaseSchema.parse(result.json());
}
async function send(id: string, input: Record<string, unknown>, who = server.owner) {
  const command = Command.parse({ id: newId('command'), groupId: newId('action'), ...input });
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${id}/commands`,
    headers: who.headers,
    payload: { clientId, commands: [command] },
  });
  expect(response.json<CommandBatchResult>().results[0]?.status, response.body).toBe('applied');
  return command;
}
async function get(path: string, who = server.owner) {
  const response = await server.app.inject({ method: 'GET', url: path, headers: who.headers });
  expect(response.statusCode, response.body).toBe(200);
  return response;
}
async function grant(id: string, who: SignedIn, role = 'reader') {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')} (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${who.info.org.id}, 'database', ${id}, 'user', ${who.userId}, ${role})`,
  );
}
async function expire(kind: string, id: string) {
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, kind)} SET trashed_at = now() - ${TRASH_RETENTION_DAYS + 1} * interval '1 day' WHERE id = ${id}`,
  );
}
async function undo(id: string, command: Command) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${id}/undo`,
    headers: server.owner.headers,
    payload: { clientId, commandId: newId('command'), groupId: command.groupId },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<UndoResult>();
}

it('lists every kind with deletion actors, hides descendants of trashed tables, and restores through commands', async () => {
  const schema = await create();
  const id = schema.database.id;
  const tableId = schema.tables[0]!.id;
  const fieldId = schema.fields[1]!.id;
  const viewId = newId('view');
  const second = newTable('Second');
  await send(id, { kind: 'table.create', table: second });
  await send(id, { kind: 'view.create', view: { id: viewId, tableId, name: 'Extra', type: 'grid' } });
  await send(id, { kind: 'field.trash', fieldId });
  await send(id, { kind: 'view.trash', viewId });
  await send(id, { kind: 'field.trash', fieldId: second.fields[1]!.id });
  await send(id, { kind: 'table.trash', tableId: second.id });
  const trash = DatabaseTrash.parse((await get(`/api/databases/${id}/trash`)).json());
  expect(trash.items.map((item) => item.kind).sort()).toEqual(['field', 'table', 'view']);
  expect(trash.items.every((item) => item.trashedBy === server.owner.userId && !!item.trashedAt)).toBe(true);
  expect(trash.items.find((item) => item.id === fieldId)).toMatchObject({ tableId, tableName: 'First' });
  const outsider = await server.addMember();
  expect(
    (await server.app.inject({ url: `/api/databases/${id}/trash`, headers: outsider.headers })).statusCode,
  ).toBe(404);
  expect(
    (await server.app.inject({ url: `/api/tables/${tableId}/trash/records`, headers: outsider.headers }))
      .statusCode,
  ).toBe(404);
  await grant(id, outsider);
  expect(DatabaseTrash.parse((await get(`/api/databases/${id}/trash`, outsider)).json()).items).toHaveLength(
    3,
  );
  await send(id, { kind: 'field.restore', fieldId });
  await send(id, { kind: 'view.restore', viewId });
  await send(id, { kind: 'table.restore', tableId: second.id });
  const after = DatabaseTrash.parse((await get(`/api/databases/${id}/trash`)).json());
  expect(after.items.map((item) => item.id)).toEqual([second.fields[1]!.id]);
});

it('pages 100 records using deletion time and ID without losing microseconds, and restores records', async () => {
  const schema = await create();
  const tableId = schema.tables[0]!.id;
  const id = schema.database.id;
  const records = Array.from({ length: 205 }, (_, n) => ({
    id: newId('record'),
    values: { [schema.fields[0]!.id]: `Record ${n}` },
  }));
  await send(id, { kind: 'record.create', tableId, records });
  await send(id, { kind: 'record.trash', tableId, recordIds: records.map((row) => row.id) });
  const trash = DatabaseTrash.parse((await get(`/api/databases/${id}/trash`)).json());
  expect(trash.records).toEqual([{ tableId, tableName: 'First', count: 205 }]);
  const seen: string[] = [];
  let next: string | null = null;
  do {
    const page: TrashedRecordsPage = TrashedRecordsPage.parse(
      (await get(`/api/tables/${tableId}/trash/records${next ? `?cursor=${next}` : ''}`)).json(),
    );
    expect(page.records.length).toBeLessThanOrEqual(100);
    expect(
      page.records.every((row) => row.name.startsWith('Record ') && row.trashedBy === server.owner.userId),
    ).toBe(true);
    seen.push(...page.records.map((row) => row.id));
    next = page.next;
  } while (next);
  expect(new Set(seen).size).toBe(205);
  expect(seen).toHaveLength(205);
  await send(id, { kind: 'record.restore', tableId, recordIds: [seen[0]] });
  expect(DatabaseTrash.parse((await get(`/api/databases/${id}/trash`)).json()).records[0]!.count).toBe(204);
  expect(
    (
      await server.app.inject({
        url: `/api/tables/${tableId}/trash/records?cursor=invalid`,
        headers: server.owner.headers,
      })
    ).statusCode,
  ).toBe(422);
});

it('lists deleted databases only for their owners and restores them', async () => {
  const schema = await create();
  const member = await server.addMember();
  await grant(schema.database.id, member, 'creator');
  await send(schema.database.id, { kind: 'database.trash' });
  const mine = TrashedDatabases.parse((await get('/api/trash')).json());
  expect(mine.databases.some((db) => db.id === schema.database.id)).toBe(true);
  expect(TrashedDatabases.parse((await get('/api/trash', member)).json()).databases).toEqual([]);
  await send(schema.database.id, { kind: 'database.restore' });
  expect(
    TrashedDatabases.parse((await get('/api/trash')).json()).databases.some(
      (db) => db.id === schema.database.id,
    ),
  ).toBe(false);
});

it('stores favorites per person and throttles opened_at without overwriting favorites', async () => {
  const schema = await create();
  const id = schema.database.id;
  const member = await server.addMember();
  const favorite = () =>
    server.app.inject({
      method: 'PUT',
      url: `/api/databases/${id}/favorite`,
      headers: member.headers,
      payload: { favorite: true },
    });
  expect((await favorite()).statusCode).toBe(404);
  await grant(id, member);
  expect((await favorite()).statusCode).toBe(200);
  await get(`/api/databases/${id}/schema`, member);
  const list = async (who = member) =>
    (await get('/api/databases', who)).json<DatabaseSummary[]>().find((db) => db.id === id)!;
  const opened = await list();
  expect(opened.favorite).toBe(true);
  expect(opened.openedAt).toBeTruthy();
  await get(`/api/databases/${id}/schema`, member);
  expect((await list()).openedAt).toBe(opened.openedAt);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'user_database_state')} SET opened_at = now() - interval '2 minutes' WHERE database_id = ${id} AND user_id = ${member.userId}`,
  );
  await get(`/api/databases/${id}/schema`, member);
  expect(Date.parse((await list()).openedAt!)).toBeGreaterThanOrEqual(Date.parse(opened.openedAt!));
  expect(await list(server.owner)).toMatchObject({ favorite: false, openedAt: null });
});

it('purges every expired kind, link junctions and inverses, preserves fresh trash and history, and skips purged undo', async () => {
  const schema = await create();
  const id = schema.database.id;
  const tableId = schema.tables[0]!.id;
  const second = newTable('Second');
  const viewId = newId('view');
  const linkId = newId('field');
  await send(id, { kind: 'table.create', table: second });
  await send(id, { kind: 'view.create', view: { id: viewId, tableId, name: 'Extra', type: 'grid' } });
  await send(id, {
    kind: 'field.create',
    tableId,
    field: { id: linkId, name: 'Link', type: 'link', options: { linkedTableId: second.id } },
  });
  const links = await query<{ id: string; right_field_id: string }>(
    server.pool,
    sql`SELECT id, right_field_id FROM ${ident(server.schemas.app, 'links')} WHERE left_field_id = ${linkId}`,
  );
  const recordId = newId('record');
  await send(id, { kind: 'record.create', tableId, records: [{ id: recordId, values: {} }] });
  const recordTrash = await send(id, { kind: 'record.trash', tableId, recordIds: [recordId] });
  const fieldTrash = await send(id, { kind: 'field.trash', fieldId: schema.fields[1]!.id });
  const viewTrash = await send(id, { kind: 'view.trash', viewId });
  await send(id, { kind: 'field.trash', fieldId: linkId });
  await purgeTrash(server.ctx);
  expect(DatabaseTrash.parse((await get(`/api/databases/${id}/trash`)).json()).records[0]!.count).toBe(1);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.data, tableId)} SET __deleted_at = now() - interval '31 days' WHERE __id = ${recordId}`,
  );
  await expire('fields', schema.fields[1]!.id);
  await expire('fields', linkId);
  await expire('views', viewId);
  await purgeTrash(server.ctx);
  for (const command of [recordTrash, fieldTrash, viewTrash])
    expect(await undo(id, command)).toMatchObject({ status: 'nothing', skipped: 1 });
  const columns = await query<{ column_name: string }>(
    server.pool,
    sql`SELECT column_name FROM information_schema.columns WHERE table_schema = ${server.schemas.data} AND table_name = ${tableId}`,
  );
  expect(columns.rows.map((row) => row.column_name)).not.toContain(schema.fields[1]!.id);
  expect(
    (
      await query(
        server.pool,
        sql`SELECT id FROM ${ident(server.schemas.app, 'fields')} WHERE id = ${links.rows[0]!.right_field_id}`,
      )
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await query(
        server.pool,
        sql`SELECT tablename FROM pg_tables WHERE schemaname = ${server.schemas.data} AND tablename = ${`lnk_${links.rows[0]!.id}`}`,
      )
    ).rowCount,
  ).toBe(0);
  const tableTrash = await send(id, { kind: 'table.trash', tableId: second.id });
  await expire('tables', second.id);
  await purgeTrash(server.ctx);
  expect(await undo(id, tableTrash)).toMatchObject({ status: 'nothing', skipped: 1 });
  const databaseTrash = await send(id, { kind: 'database.trash' });
  await expire('databases', id);
  await purgeTrash(server.ctx);
  expect(
    (await query(server.pool, sql`SELECT id FROM ${ident(server.schemas.app, 'databases')} WHERE id = ${id}`))
      .rowCount,
  ).toBe(0);
  expect(
    (
      await query(
        server.pool,
        sql`SELECT tablename FROM pg_tables WHERE schemaname = ${server.schemas.data} AND tablename = ${tableId}`,
      )
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await query(
        server.pool,
        sql`SELECT seq FROM ${ident(server.schemas.app, 'changes')} WHERE database_id = ${id}`,
      )
    ).rowCount,
  ).toBeGreaterThan(0);
  expect(await undo(id, databaseTrash)).toMatchObject({ status: 'nothing', skipped: 1 });
});

it('keeps converted live fields when their old inverse expires and purges conversion backups with a field', async () => {
  const schema = await create();
  const id = schema.database.id;
  const tableId = schema.tables[0]!.id;
  const target = newTable('Linked');
  await send(id, { kind: 'table.create', table: target });
  const fieldId = newId('field');
  await send(id, {
    kind: 'field.create',
    tableId,
    field: { id: fieldId, name: 'Link', type: 'link', options: { linkedTableId: target.id } },
  });
  const pair = await query<{ right_field_id: string }>(
    server.pool,
    sql`SELECT right_field_id FROM ${ident(server.schemas.app, 'links')} WHERE left_field_id = ${fieldId}`,
  );
  const conversion = await send(id, { kind: 'field.convert', fieldId, to: { type: 'text' } });
  await expire('fields', pair.rows[0]!.right_field_id);
  await purgeTrash(server.ctx);
  const current = DatabaseSchema.parse((await get(`/api/databases/${id}/schema`)).json());
  expect(current.fields.find((field) => field.id === fieldId)?.type).toBe('text');
  expect(await undo(id, conversion)).toMatchObject({ status: 'nothing', skipped: 1 });
  await send(id, { kind: 'field.convert', fieldId, to: { type: 'number' } });
  expect(
    (
      await query(
        server.pool,
        sql`SELECT column_name FROM ${ident(server.schemas.app, 'column_backups')} WHERE field_id = ${fieldId}`,
      )
    ).rowCount,
  ).toBeGreaterThan(0);
  await send(id, { kind: 'field.trash', fieldId });
  await expire('fields', fieldId);
  await purgeTrash(server.ctx);
  expect(
    (
      await query(
        server.pool,
        sql`SELECT column_name FROM ${ident(server.schemas.app, 'column_backups')} WHERE field_id = ${fieldId}`,
      )
    ).rowCount,
  ).toBe(0);
});

it('records simultaneous schema opens successfully while preserving the throttle', async () => {
  const schema = await create();
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => get(`/api/databases/${schema.database.id}/schema`)),
  );
  expect(responses).toHaveLength(5);
  const before = (await get('/api/databases'))
    .json<DatabaseSummary[]>()
    .find((db) => db.id === schema.database.id)!.openedAt;
  await get(`/api/databases/${schema.database.id}/schema`);
  const after = (await get('/api/databases'))
    .json<DatabaseSummary[]>()
    .find((db) => db.id === schema.database.id)!.openedAt;
  expect(after).toBe(before);
});
